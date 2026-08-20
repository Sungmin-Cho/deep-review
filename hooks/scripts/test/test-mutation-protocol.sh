#!/usr/bin/env bash
# hooks/scripts/test/test-mutation-protocol.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"
source "$SCRIPT_DIR/../mutation-protocol.sh"

echo "=== is_our_ita_entry tests ==="

# Test 1: intent-to-add file returns true
repo=$(setup_test_repo)
cd "$repo"
echo "gitignored" > .gitignore-test
git add -f -N .gitignore-test
assert_success "is_our_ita_entry .gitignore-test" "intent-to-add file → 0"
teardown_test_repo

# Test 2: genuinely staged file returns false (non-empty content)
repo=$(setup_test_repo)
cd "$repo"
echo "content" > staged.md
git add staged.md
assert_failure "is_our_ita_entry staged.md" "real staged file → 1"
teardown_test_repo

# Test 3: file not in index returns false
repo=$(setup_test_repo)
cd "$repo"
echo "untracked" > untracked.md
assert_failure "is_our_ita_entry untracked.md" "untracked file → 1"
teardown_test_repo

# Test 4: initial repo (no HEAD) with intent-to-add
repo=$(mktemp -d "${TMPDIR:-/tmp}/deep-review-test-initial.XXXXXX")
(cd "$repo" && git init -q)
cd "$repo"
echo "foo" > bar.md
git add -f -N bar.md
assert_success "is_our_ita_entry bar.md" "intent-to-add in initial repo → 0"
rm -rf "$repo"

echo ""
echo "=== mutation lock tests ==="

# Test 5: acquire_mutation_lock on fresh dir succeeds
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
assert_success "acquire_mutation_lock" "first lock acquisition"
assert_success "[ -d .deep-review/.mutation.lock ]" "lock dir exists"
release_mutation_lock
assert_failure "[ -d .deep-review/.mutation.lock ]" "lock released"
teardown_test_repo

# Test 6: second acquire fails while first holds
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
acquire_mutation_lock
assert_failure "acquire_mutation_lock" "second acquire fails"
release_mutation_lock
teardown_test_repo

# Test 7: stale lock (>3600s) auto-cleaned
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review/.mutation.lock
# Simulate stale: set mtime to 2 hours ago
touch -t $(date -u -v-2H +%Y%m%d%H%M 2>/dev/null || date -u -d '2 hours ago' +%Y%m%d%H%M) .deep-review/.mutation.lock
assert_success "acquire_mutation_lock" "stale lock auto-recovered"
assert_success "[ -d .deep-review/.mutation.lock ]" "fresh lock acquired after stale cleanup"
release_mutation_lock
teardown_test_repo

echo ""
echo "=== perform_mutation tests ==="

# Test 8: successful mutation writes state file with committed status + registers i-t-a
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "gitignored" > g1.md
echo "gitignored2" > g2.md
perform_mutation "g1.md" "g2.md"
assert_success "[ -f .deep-review/.pending-mutation.json ]" "state file created"
status=$(python3 -c 'import json; print(json.load(open(".deep-review/.pending-mutation.json"))["status"])')
assert_equal "committed" "$status" "status is committed"
assert_success "is_our_ita_entry g1.md" "g1.md is i-t-a"
assert_success "is_our_ita_entry g2.md" "g2.md is i-t-a"
release_mutation_lock
teardown_test_repo

# Test 9: precondition failure — file already in index → abort
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "preexisting" > existing.md
git add existing.md
assert_failure "perform_mutation existing.md" "precondition rejects staged file"
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "no state file created"
release_mutation_lock
teardown_test_repo

echo ""
echo "=== restore_mutation tests ==="

# Test 10: restore removes only i-t-a entries, preserves user staging (C4 defense)
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "g1" > g1.md
echo "g2" > g2.md
perform_mutation g1.md g2.md
# Simulate user staging g1.md during review
echo "user-edit" > g1.md
git add g1.md  # real stage (mode 100644, real content)
# Now restore — g1.md should be preserved, g2.md should be restored
restore_mutation
g1_stage=$(git ls-files --stage g1.md | awk '{print $1}')
assert_equal "100644" "$g1_stage" "g1 retained user staging"
assert_failure "is_our_ita_entry g2.md" "g2 restored (not in index anymore)"
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "state file removed after restore"
release_mutation_lock
teardown_test_repo

# Test 11: restore with only our files succeeds clean
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "g1" > g1.md
perform_mutation g1.md
restore_mutation
# NOTE: plan used `git ls-files --cached g1.md` which always returns 0 (it's a list op).
# `--error-unmatch` makes it actually fail when the path isn't in the index.
assert_failure "git ls-files --error-unmatch --cached g1.md" "g1 removed from index"
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "state file removed"
release_mutation_lock
teardown_test_repo

echo ""
echo "=== auto_recover tests ==="

# Test 12: auto_recover with stale state file performs restore
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "g1" > g1.md
perform_mutation g1.md
release_mutation_lock
# Simulate session crash: state file + i-t-a exists, but lock is gone
auto_recover
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "state file cleaned"
assert_failure "git ls-files --error-unmatch --cached g1.md" "g1 not in index"
teardown_test_repo

# Test 13: auto_recover skips when another session holds lock
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "g1" > g1.md
perform_mutation g1.md
# Lock still held. auto_recover should not touch state file.
output=$(auto_recover 2>&1 || true)
assert_success "[ -f .deep-review/.pending-mutation.json ]" "state file preserved when lock held"
echo "$output" | grep -q "lock age" && echo "  ✅ warning about active session" || echo "  ❌ expected lock warning"
release_mutation_lock
restore_mutation
teardown_test_repo

# Test 14: auto_recover escalates after 3 failed attempts
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
# Manually craft a state file with restore_attempts=3
cat > .deep-review/.pending-mutation.json <<'JSON'
{"schema_version":1,"operation":"git-add-f-N","status":"failed","started_at":"2026-01-01T00:00:00Z","commit_hash":null,"shell_ppid":null,"restore_attempts":3,"files":["nonexistent.md"]}
JSON
output=$(auto_recover 2>&1 || true)
echo "$output" | grep -q "수동 처리를 권장" && echo "  ✅ escalation message shown" || echo "  ❌ expected escalation"
assert_success "[ -f .deep-review/.pending-mutation.json ]" "state file preserved for user action"
teardown_test_repo

echo ""
echo "=== scan_sensitive_files tests ==="

# Test 15: basic .env match
matches=$(scan_sensitive_files "config/.env" "src/main.rs")
[ "$matches" = "config/.env" ] && echo "  ✅ basic .env detected" \
  || { echo "  ❌ expected config/.env, got: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 16: nested .env (monorepo)
matches=$(scan_sensitive_files "apps/web/.env.local" "services/api/.env.production")
echo "$matches" | grep -q "apps/web/.env.local" && echo "$matches" | grep -q "services/api/.env.production" \
  && echo "  ✅ nested .env detected" \
  || { echo "  ❌ nested .env missed: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 17: case-insensitive
matches=$(scan_sensitive_files "SERVICEACCOUNT.JSON" "ID_RSA" ".Env.Local")
line_count=$(printf '%s\n' "$matches" | grep -c .)
[ "$line_count" = "3" ] && echo "  ✅ case-insensitive matching (3 files)" \
  || { echo "  ❌ expected 3 matches, got $line_count: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 18: benign files pass through
matches=$(scan_sensitive_files "README.md" "src/main.rs" "docs/design.md")
[ -z "$matches" ] && echo "  ✅ benign files not matched" \
  || { echo "  ❌ false positive: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 19: GCP service account variants
matches=$(scan_sensitive_files "serviceAccount.json" "firebase-adminsdk-abc.json" "api-key.json")
line_count=$(printf '%s\n' "$matches" | grep -c .)
[ "$line_count" = "3" ] && echo "  ✅ GCP/Firebase credentials detected" \
  || { echo "  ❌ expected 3, got $line_count: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test 20: SSH key variants
matches=$(scan_sensitive_files "id_rsa" "id_ed25519.pub" "my_server_ecdsa" ".pgpass")
line_count=$(printf '%s\n' "$matches" | grep -c .)
[ "$line_count" = "4" ] && echo "  ✅ SSH/auth files detected" \
  || { echo "  ❌ expected 4, got $line_count: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# === Pattern family assertions (v1.7.1 — exercise the canonical set so
# the "remains green = bit-for-bit parity" claim is meaningful when
# scan_sensitive_files reads patterns from lib/sensitive-patterns.list).
# Per round-1 plan-review C1 fix.) ===

# Test F1: credentials* family
matches=$(scan_sensitive_files "config/credentials.json" "src/main.rs")
[ "$matches" = "config/credentials.json" ] && echo "  ✅ F1: credentials* family matched" \
  || { echo "  ❌ F1: expected config/credentials.json, got: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test F2: *secret* family
matches=$(scan_sensitive_files "db-secret.yaml" "cfg/app-secret.json" "README.md")
line_count=$(printf '%s\n' "$matches" | grep -c .)
[ "$line_count" = "2" ] && echo "  ✅ F2: *secret* family matched" \
  || { echo "  ❌ F2: expected 2, got $line_count: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test F3: *password* family
matches=$(scan_sensitive_files "cfg/db_password.txt" "cfg/db_host.txt")
[ "$matches" = "cfg/db_password.txt" ] && echo "  ✅ F3: *password* family matched" \
  || { echo "  ❌ F3: expected cfg/db_password.txt, got: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test F4: bearer_* family
matches=$(scan_sensitive_files "cfg/bearer_token.txt" "cfg/app.yaml")
[ "$matches" = "cfg/bearer_token.txt" ] && echo "  ✅ F4: bearer_* family matched" \
  || { echo "  ❌ F4: expected cfg/bearer_token.txt, got: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# Test F5: .htpasswd
matches=$(scan_sensitive_files "/etc/apache/.htpasswd" "/etc/apache/httpd.conf")
[ "$matches" = "/etc/apache/.htpasswd" ] && echo "  ✅ F5: .htpasswd matched" \
  || { echo "  ❌ F5: expected /etc/apache/.htpasswd, got: $matches"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))

# === 4회차 regression guards (FR1, FR2, FR3, W1) ===
echo ""
echo "=== FR1: precondition failure releases lock ==="

# Test 21 (FR1): lock released when precondition rejects an already-indexed target
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "preexisting" > existing.md
git add existing.md  # force it into index
assert_failure "perform_mutation existing.md" "FR1: precondition fails"
assert_failure "[ -d .deep-review/.mutation.lock ]" "FR1: lock released on precondition failure (no orphan)"
# Sanity: second perform_mutation on a different file should succeed (lock not orphaned)
echo "new" > fresh.md
assert_success "perform_mutation fresh.md" "FR1: subsequent mutation unblocked"
restore_mutation
teardown_test_repo

echo ""
echo "=== FR2: partial mutation failure rolls back i-t-a entries ==="

# Test 22 (FR2): when git add -f -N fails, any partial i-t-a entries are cleaned up
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
# Simulate partial git add failure: create a valid file AND a path that will cause
# git add to fail (e.g., a path containing a newline — but that's tricky).
# Simpler: verify the code path by checking that restore_mutation is called
# when state ends up as "failed".
# Force failure by passing a non-existent path after a valid one:
echo "valid" > g1.md
if ! perform_mutation g1.md /nonexistent/path.md; then
  # Partial failure path — verify cleanup
  assert_failure "[ -f .deep-review/.pending-mutation.json ]" "FR2: state file cleaned up after partial failure"
  # g1.md may or may not be in index depending on git add semantics, but if it was
  # added as i-t-a, restore_mutation should have removed it.
  if git ls-files --error-unmatch --cached g1.md >/dev/null 2>&1; then
    # Still in index — must be NOT our i-t-a (would've been removed)
    stage_mode=$(git ls-files --stage g1.md | awk '{print $1}')
    [ "$stage_mode" != "100644" ] || {
      # If it's 100644 with empty-blob, it IS our leftover i-t-a
      stage_hash=$(git ls-files --stage g1.md | awk '{print $2}')
      [ "$stage_hash" != "$EMPTY_BLOB_SHA" ] && echo "  ✅ FR2: no orphan i-t-a leftover" \
        || { echo "  ❌ FR2: orphan i-t-a for g1.md"; TEST_FAILURES=$((TEST_FAILURES+1)); }
    }
  else
    echo "  ✅ FR2: no orphan i-t-a leftover"
  fi
  TEST_COUNT=$((TEST_COUNT+1))
  assert_failure "[ -d .deep-review/.mutation.lock ]" "FR2: lock released after partial failure"
else
  echo "  ⚠️ FR2: expected partial failure didn't occur — environment-dependent, skipping"
fi
teardown_test_repo

echo ""
echo "=== FR3: crashed session recovery ==="

# Test 23 (FR3): status=committed + stale-but-not-1h lock → still active, skip
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "f1" > f1.md
perform_mutation f1.md
release_mutation_lock  # manually drop lock flag, but keep lock dir
mkdir -p .deep-review/.mutation.lock  # re-create as if session A still holds it
# mtime is now (fresh). status=committed. Should be treated as active.
output=$(auto_recover 2>&1 || true)
echo "$output" | grep -q "Another /deep-review session is active" && echo "  ✅ FR3: fresh committed lock respected" \
  || { echo "  ❌ FR3: should skip fresh committed lock: $output"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))
assert_success "[ -f .deep-review/.pending-mutation.json ]" "FR3: state file preserved for active session"
# Cleanup
rmdir .deep-review/.mutation.lock 2>/dev/null || true
# Reacquire for restore
_MUTATION_LOCK_OWNED=1
mkdir -p .deep-review/.mutation.lock
restore_mutation
teardown_test_repo

# Test 24 (FR3): status=committed + lock older than REVIEW_TIMEOUT_SECONDS (20min, v1.5.0+) → orphan, recover
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "f2" > f2.md
perform_mutation f2.md
release_mutation_lock
mkdir -p .deep-review/.mutation.lock
# Backdate lock past REVIEW_TIMEOUT_SECONDS (v1.5.0+ default 1200s = 20min; use 25min for headroom).
# macOS: touch -t YYYYMMDDhhmm[.ss]. The -u -v-25M form combined with -t produces an mtime that
# is reliably past the threshold across both BSD and GNU date variants.
backdate=$(date -u -v-25M +%Y%m%d%H%M 2>/dev/null || date -u -d '25 minutes ago' +%Y%m%d%H%M)
touch -t "$backdate" .deep-review/.mutation.lock
output=$(auto_recover 2>&1 || true)
echo "$output" | grep -q "orphan lock from crashed session" && echo "  ✅ FR3: orphan committed lock recovered" \
  || { echo "  ❌ FR3: should recover orphan committed lock: $output"; TEST_FAILURES=$((TEST_FAILURES+1)); }
TEST_COUNT=$((TEST_COUNT+1))
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "FR3: orphan state file cleaned up"
teardown_test_repo

echo ""
echo "=== W1: lock ownership tracking ==="

# Test 25 (W1): release_mutation_lock is a no-op when we don't own the lock
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
# Simulate another session holding the lock (we don't own it)
mkdir .deep-review/.mutation.lock
_MUTATION_LOCK_OWNED=0  # explicit: we don't own it
release_mutation_lock   # should be no-op
assert_success "[ -d .deep-review/.mutation.lock ]" "W1: release_mutation_lock no-op when not owned"
# Cleanup
rmdir .deep-review/.mutation.lock
teardown_test_repo

echo ""
echo "=== M5.5 #5: stale-recovery preserves user staging ==="
#
# The Test 12 scenario covers "stale state file, no lock present" — a
# clean post-crash restart. The M5.5 #5 acceptance scenario is stricter:
# all THREE artifacts are present simultaneously (lock dir + state file +
# user-staged changes from a separate flow), and auto_recover must:
#   (1) detect the stale lock as orphaned (status=committed + age > REVIEW_TIMEOUT_SECONDS
#       (20min, v1.5.0+), OR status=in-progress + age > 1h)
#   (2) release the lock
#   (3) remove our i-t-a entries from the index
#   (4) **NOT touch user staging** (C4 defense — `is_our_ita_entry` filter)
#   (5) remove the state file
#
# This pins the integration: a single regression that breaks (4) without
# breaking (1)/(2)/(3)/(5) would slip past the existing tests because
# Test 10 exercises restore_mutation directly and Test 12 doesn't stage
# anything pre-recovery.
#
# Spec: deep-suite/docs/superpowers/plans/2026-05-12-m5.5-remaining-
# tests-handoff.md §2 #5 (deep-review row).

# Test 26 (M5.5 #5-A): leftover lock + state + user staging → recover + preserve
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
# Phase 1: simulate user staging an unrelated file independently of deep-review.
echo "user-edit" > user-file.md
git add user-file.md
# Verify pre-recovery: user staging is real (non-empty, in index, not i-t-a)
assert_success "git ls-files --error-unmatch --cached user-file.md" "pre: user-file.md staged"
assert_failure "is_our_ita_entry user-file.md" "pre: user-file.md is NOT i-t-a (real staging)"

# Phase 2: simulate a crashed deep-review mutation: state file with i-t-a entry
# for OUR file (review-target.md), age the lock to past REVIEW_TIMEOUT_SECONDS
# so auto_recover treats it as orphan.
echo "review-target" > review-target.md
perform_mutation review-target.md  # writes state file + lock + i-t-a
# Force lock age past REVIEW_TIMEOUT_SECONDS (v1.5.0+: 1200s = 20min) so auto_recover
# enters the orphan branch on a status=committed mutation.
touch -t 202504121200.00 .deep-review/.mutation.lock 2>/dev/null \
  || touch -A -2000 .deep-review/.mutation.lock 2>/dev/null \
  || python3 -c "import os; os.utime('.deep-review/.mutation.lock', (1, 1))"
# We do NOT release_mutation_lock here — simulating crashed session.
_MUTATION_LOCK_OWNED=0  # auto_recover sees lock as not-ours, so we don't pre-empt it

# Phase 3: recover.
auto_recover

# Phase 4: assert all 5 contract properties.
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "M5.5 #5-A: state file removed"
assert_failure "[ -d .deep-review/.mutation.lock ]" "M5.5 #5-A: orphan lock released"
assert_failure "git ls-files --error-unmatch --cached review-target.md" "M5.5 #5-A: our i-t-a removed"
assert_success "git ls-files --error-unmatch --cached user-file.md" "M5.5 #5-A: user staging preserved"
# Belt-and-suspenders: confirm user-file.md still has its content staged
staged_content=$(git show :user-file.md 2>/dev/null || echo "MISSING")
[ "$staged_content" = "user-edit" ] \
  && echo "  ✅ user staging content unchanged" \
  || echo "  ❌ user staging content corrupted (got: '$staged_content')"
teardown_test_repo

# Test 27 (M5.5 #5-B): no-op when state file is missing (defensive)
# Regression guard against auto_recover stripping a user's legitimate
# staging when there's NO crashed session to recover from.
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "user-only" > only-user.md
git add only-user.md
auto_recover  # should be no-op
assert_success "git ls-files --error-unmatch --cached only-user.md" "M5.5 #5-B: user staging untouched when no state file"
assert_failure "[ -f .deep-review/.pending-mutation.json ]" "M5.5 #5-B: still no state file"
teardown_test_repo

# Test 28 (M5.5 #5-C): MULTIPLE staged files survive recovery
# Catches a regression where auto_recover iterates files but breaks on
# the second user-staged file (e.g. off-by-one in i-t-a filter).
repo=$(setup_test_repo)
cd "$repo"
mkdir -p .deep-review
echo "u1" > user-a.md
echo "u2" > user-b.md
echo "u3" > user-c.md
git add user-a.md user-b.md user-c.md
echo "ours" > ours.md
perform_mutation ours.md
touch -t 202504121200.00 .deep-review/.mutation.lock 2>/dev/null \
  || touch -A -2000 .deep-review/.mutation.lock 2>/dev/null \
  || python3 -c "import os; os.utime('.deep-review/.mutation.lock', (1, 1))"
_MUTATION_LOCK_OWNED=0
auto_recover
for f in user-a.md user-b.md user-c.md; do
  assert_success "git ls-files --error-unmatch --cached $f" "M5.5 #5-C: $f survives recovery"
done
assert_failure "git ls-files --error-unmatch --cached ours.md" "M5.5 #5-C: our i-t-a still removed"
teardown_test_repo

echo ""
echo "=== #1: genuine restore failure accumulates restore_attempts to 3-strikes ==="
#
# restore_mutation 이 실제 복원 실패(우리 i-t-a 가 git rm 후에도 잔존)를 감지하면
# state 를 보존하고 non-zero 를 반환해야 한다. auto_recover 는 increment 를 restore
# 앞에 두므로(:302-312 → :315), 실패로 state 가 보존되면 다음 호출이 증가된 카운터를
# 읽어 3-strikes 에스컬레이션(:294)에 비로소 도달 가능해진다("escalates after 3
# failures" 주석 :245 / review-execution.md:37 의 의도가 참이 됨).
# genuine 실패는 PATH git-shim(`git rm` 만 no-op, 나머지는 실 git 위임)으로 재현한다
# — 기존 Test 10/11/12/14/22/26 의 정상·부분·stale 복원 경로는 불변.

# Test 29 (#1): genuine restore 실패 → state 보존 + restore_attempts 실 흐름 누적
repo=$(setup_test_repo); cd "$repo"; mkdir -p .deep-review
echo "g1" > g1.md
perform_mutation g1.md        # state(status=committed) + i-t-a + lock 생성
release_mutation_lock         # Test 12 처럼 lock 해제 → auto_recover 가 진행
# PATH git-shim: `git rm ...` 를 no-op 으로(genuine 복원 실패 시뮬레이션)
REAL_GIT="$(command -v git)"
shim="$(mktemp -d "${TMPDIR:-/tmp}/deep-review-gitshim.XXXXXX")"
cat > "$shim/git" <<EOF
#!/usr/bin/env bash
[ "\$1" = "rm" ] && exit 0
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$shim/git"
OLDPATH="$PATH"; export PATH="$shim:$PATH"
# 하니스는 set -euo pipefail — 기대-비영 반환을 직접 호출하면 assert 전에 abort.
# errexit-safe 캡처(if/else) + || true 로 무해화. python 읽기는 || echo MISSING 으로
# state 부재(현행 코드 RED) 시에도 깨끗한 assertion 실패가 되도록 방어.
if auto_recover; then rc1=0; else rc1=$?; fi   # attempt1: attempts 0→1, restore 실패, state 보존
assert_equal "1" "$rc1" "#1: auto_recover non-zero on genuine restore failure"
assert_success "[ -f .deep-review/.pending-mutation.json ]" "#1: state preserved after genuine failure"
a=$(python3 -c 'import json;print(json.load(open(".deep-review/.pending-mutation.json"))["restore_attempts"])' 2>/dev/null || echo MISSING)
assert_equal "1" "$a" "#1: restore_attempts=1 after 1st failure"
auto_recover >/dev/null 2>&1 || true  # attempt2: →2 (기대-비영, errexit 무해화)
auto_recover >/dev/null 2>&1 || true  # attempt3: →3
a=$(python3 -c 'import json;print(json.load(open(".deep-review/.pending-mutation.json"))["restore_attempts"])' 2>/dev/null || echo MISSING)
assert_equal "3" "$a" "#1: restore_attempts accumulated to 3 via real flow"
out="$(auto_recover 2>&1 || true)"    # attempt4: attempts>=3 → escalate
TEST_COUNT=$((TEST_COUNT+1))
if echo "$out" | grep -q "수동 처리를 권장"; then
  echo "  ✅ #1: 3-strikes escalation reachable via real flow"
else
  echo "  ❌ #1: escalation not reached via real flow"; TEST_FAILURES=$((TEST_FAILURES+1))
fi
export PATH="$OLDPATH"; rm -rf "$shim"   # 명시 복원(실 git 로 정리)
restore_mutation >/dev/null 2>&1 || true # 실 git 로 잔여 i-t-a/state 정리
teardown_test_repo

echo "=== #R4-2: git rm genuine failure under errexit — state preserved + lock released + non-zero ==="
#
# restore_mutation 의 `git rm` 파이프라인이 실 git 오류(≠ --ignore-unmatch, 즉 non-zero)
# 로 실패할 때, errexit 호출자 아래서 함수가 잔존검사·lock 해제·return 전에 중단되면
# lock/state 가 half-recovered 로 남는다. errexit 활성 호출을 서브셸(`( set -e; … )`)로
# 재현한다 — 버그 버전은 pipeline 에서 abort → LOCK_DIR 잔존(lock held). fixed 는 실패를
# 명시 캡처해 state 보존 + lock 해제 + non-zero 반환한다. (Test 29 의 exit-0 no-op shim
# 과 달리 여기서는 `git rm` 만 non-zero(128) 로 실패시키고 나머지는 실 git 위임.)

# Test 30 (#R4-2): errexit 하 git rm 실패 → half-recovery 금지
repo=$(setup_test_repo); cd "$repo"; mkdir -p .deep-review
echo "g2" > g2.md
perform_mutation g2.md          # lock 소유(_MUTATION_LOCK_OWNED=1) + state + i-t-a
REAL_GIT="$(command -v git)"
shim="$(mktemp -d "${TMPDIR:-/tmp}/deep-review-gitshim.XXXXXX")"
cat > "$shim/git" <<EOF
#!/usr/bin/env bash
# git rm 만 실 오류(exit 1)로 실패시킨다 — 1-125 범위라 xargs 가 123 으로 전파(파이프라인
# non-zero). 128 등 범위 밖은 xargs 가 삼켜 no-op(→ 기존 residual 경로로 흡수)이 되므로
# pipeline-failure 경로를 검증하려면 반드시 1-125 코드를 써야 한다.
[ "\$1" = "rm" ] && exit 1
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$shim/git"
OLDPATH="$PATH"; export PATH="$shim:$PATH"
# errexit 활성 호출을 bare 서브셸로 재현한다. 주의: 서브셸을 `if`/`&&`/`||` 조건에 넣으면
# bash 가 errexit-suppressed 컨텍스트를 서브셸로 전파해 내부 `set -e` 가 무효화된다 →
# 버그가 재현되지 않는다. 따라서 부모 errexit 를 `set +e` 로 잠시 끄고(비영 서브셸이
# 부모를 죽이지 않도록) bare 로 실행 후 rc 캡처, `set -e` 로 복원한다. 버그 버전은 git rm
# 파이프라인(exit 1 → xargs 123)에서 abort → LOCK_DIR 잔존(lock held). fixed 는 실패를
# 명시 캡처해 state 보존 + lock 해제 + non-zero 반환.
set +e
( set -e; restore_mutation ) >/dev/null 2>&1
rc=$?
set -e
export PATH="$OLDPATH"; rm -rf "$shim"
assert_success "[ $rc -ne 0 ]" "#R4-2: restore_mutation returns non-zero on git rm failure"
assert_success "[ -f .deep-review/.pending-mutation.json ]" "#R4-2: state preserved on git rm failure"
assert_success "[ ! -d .deep-review/.mutation.lock ]" "#R4-2: lock released (not half-recovered) on git rm failure"
release_mutation_lock >/dev/null 2>&1 || true  # 방어적 잔여 정리
restore_mutation >/dev/null 2>&1 || true       # 실 git 로 잔여 i-t-a/state 정리
teardown_test_repo

test_summary
