#!/usr/bin/env bash
set -Eeuo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/test-helpers.sh"
SCRIPT="$HERE/../build-change-files.sh"

# Assert every non-empty stdout line is valid JSON (skip if no python3).
jsonl_valid() { python3 -c $'import sys,json\nfor ln in sys.stdin:\n ln=ln.rstrip("\\n")\n if ln: json.loads(ln)'; }

row_present() { # $1=file $2=path -> prints yes/no for a top-level row
  python3 - "$1" "$2" <<'PY'
import json, sys
hit = False
for line in open(sys.argv[1], encoding='utf-8', errors='surrogateescape'):
    line = line.strip()
    if not line:
        continue
    obj = json.loads(line)
    if 'binary_omitted' in obj or 'truncated' in obj:
        continue
    if obj.get('path') == sys.argv[2]:
        hit = True
print('yes' if hit else 'no')
PY
}

repo=$(setup_test_repo)
( cd "$repo"
  printf 'line\n' > a.txt; git add a.txt; git commit -q -m a
  git mv a.txt b.txt                       # staged rename
  printf 'new\n' > untracked.txt )         # untracked
out=$("$SCRIPT" --repo "$repo" --change-state staged)
assert_success "printf '%s' \"\$out\" | jsonl_valid" "staged output is valid JSONL"
assert_success "printf '%s\\n' \"\$out\" | grep -q '\"old_path\": *\"a.txt\"'" "rename old_path present"
assert_success "printf '%s\\n' \"\$out\" | grep -q '\"score\"'" "rename score field present (split from R085)"
assert_success "printf '%s\\n' \"\$out\" | grep -q 'untracked.txt'" "untracked unioned into staged"

# control-byte (0x01) + embedded-newline paths must still yield valid JSON
weird=$(setup_test_repo)
( cd "$weird"; printf 'x\n' > "$(printf 'a\001b.txt')"; printf 'y\n' > "$(printf 'c\nd.txt')"; git add -A )
outw=$("$SCRIPT" --repo "$weird" --change-state staged)
assert_success "printf '%s' \"\$outw\" | jsonl_valid" "0x01 + newline paths still valid JSON"
assert_success "[ -n \"\$outw\" ]" "control-byte manifest is non-empty (not silently dropped)"
# Parse JSON and compare DECODED path values to the actual control-char paths
# (python comparison avoids all shell/grep backslash-escaping ambiguity).
pathcheck() { python3 -c $'import sys,json\nwant={"a\\x01b.txt","c\\nd.txt"}\ngot=set()\nfor ln in sys.stdin:\n ln=ln.rstrip("\\n")\n if ln: got.add(json.loads(ln).get("path"))\nsys.exit(0 if want<=got else 1)'; }
assert_success "printf '%s' \"\$outw\" | pathcheck" "0x01 and newline paths present and correctly round-trip via JSON"

# clean state without --review-base must fail (no silent HEAD..HEAD)
assert_failure "\"$SCRIPT\" --repo \"$repo\" --change-state clean" "clean without --review-base fails"

# initial state includes untracked files
init=$(mktemp -d "${TMPDIR:-/tmp}/dr-init.XXXXXX"); ( cd "$init"; git init -q; printf 'z\n' > only.txt )
assert_success "\"$SCRIPT\" --repo \"$init\" --change-state initial | grep -q only.txt" "initial includes untracked"

# non-git uses --files-from-z for manual targets
ffz=$(mktemp); printf 'man1.txt\0man2.txt\0' > "$ffz"
assert_success "\"$SCRIPT\" --repo \"$repo\" --change-state non-git --files-from-z \"$ffz\" | grep -q man1.txt" "non-git uses files-from-z"

# --- Finding B (out-of-scope exclusions): change_files must mirror review-execution.md SSOT:diff-exclusion-set.
# Stage a normal src file alongside vendored/build/generated/lock/.DS_Store + a binary;
# only the real source file must survive (rest are out of the review DIFF target set).
excl=$(setup_test_repo)
( cd "$excl"
  mkdir -p vendor node_modules dist build .next target .venv __pycache__ .pytest_cache src
  printf 'a\n' > vendor/x.js;        printf 'b\n' > node_modules/y.js
  printf 'c\n' > a.min.js;           printf 'd\n' > b.generated.ts
  printf 'e\n' > c.lock;             printf 'real\n' > src/real.ts
  printf 'z\n' > dist/z.js;          printf 'z\n' > build/z.js
  printf 'z\n' > .next/z.js;         printf 'z\n' > target/z.js
  printf 'z\n' > .venv/z.py;         printf 'z\n' > __pycache__/z.pyc
  printf 'z\n' > .pytest_cache/z;    printf 'x\n' > src/.DS_Store
  printf '\000\001\002BIN' > src/img.bin                       # binary blob
  git add -A )
oute=$("$SCRIPT" --repo "$excl" --change-state staged)
assert_success "printf '%s\\n' \"\$oute\" | grep -q '\"path\": *\"src/real.ts\"'" "exclusion: src/real.ts kept"
for bad in 'vendor/x.js' 'node_modules/y.js' 'a.min.js' 'b.generated.ts' 'c.lock' \
           'dist/z.js' 'build/z.js' '.next/z.js' 'target/z.js' '.venv/z.py' \
           '__pycache__/z.pyc' '.pytest_cache/z' 'src/.DS_Store'; do
  assert_failure "printf '%s\\n' \"\$oute\" | grep -q '\"path\": *\"$bad\"'" "exclusion: $bad dropped"
done
oute_file="$excl/.oute.jsonl"; printf '%s\n' "$oute" > "$oute_file"
assert_success "[ \"\$(row_present '$oute_file' src/img.bin)\" = no ]" "exclusion: src/img.bin dropped"

# --- Finding A (effective post-WIP target): simulate the orchestrator's WIP-accepted path.
# Changes are COMMITTED in BASE..HEAD; calling with --change-state clean --review-base BASE
# (the effective target the block fills after a Stage-1 WIP commit) must yield a NON-EMPTY
# manifest for those committed files — proving the effective-target call is not silent-empty.
wip=$(setup_test_repo)
( cd "$wip"
  base=$(git rev-parse HEAD)
  printf 'wip-change\n' > committed.ts
  git add committed.ts; git commit -q -m "wip: deep-review checkpoint"
  echo "$base" > "$wip/.base" )
base=$(cat "$wip/.base")
outwip=$("$SCRIPT" --repo "$wip" --change-state clean --review-base "$base")
assert_success "[ -n \"\$outwip\" ]" "WIP effective-target: manifest non-empty (not silent-empty)"
assert_success "printf '%s\\n' \"\$outwip\" | grep -q '\"path\": *\"committed.ts\"'" "WIP effective-target: committed file present in review_base..HEAD"

# --- Finding 2 (clean state must NOT union leftover untracked): the WIP-accepted tracked-only
# path calls `--change-state clean --review-base BASE`; its effective target is committed
# base..HEAD ONLY. A leftover untracked file in the worktree is NOT part of that diff, so the
# manifest must list the committed file but MUST NOT list the untracked file (spec §4.1 — clean
# is excluded from the untracked union; unioning it would leak out-of-scope files).
cleanu=$(setup_test_repo)
( cd "$cleanu"
  base=$(git rev-parse HEAD)
  printf 'in-scope\n' > committed.ts
  git add committed.ts; git commit -q -m "wip: deep-review checkpoint"
  printf 'leftover\n' > leftover-untracked.txt   # untracked, NOT in base..HEAD
  echo "$base" > "$cleanu/.base" )
base=$(cat "$cleanu/.base")
outcu=$("$SCRIPT" --repo "$cleanu" --change-state clean --review-base "$base")
assert_success "printf '%s\\n' \"\$outcu\" | grep -q '\"path\": *\"committed.ts\"'" "clean+leftover: committed in-scope file present"
assert_failure "printf '%s\\n' \"\$outcu\" | grep -q 'leftover-untracked.txt'" "clean+leftover: out-of-scope untracked file NOT unioned"

# --- Fix 3 (spec §4.1 byte budget): the manifest is capped by BYTES, not just rows. A repo with
# many long-path untracked files staged must, under a small OCR_CHANGE_FILES_MAX_BYTES, emit the
# {omitted,truncated} trailer once the cumulative serialized size would exceed the budget — and
# the surviving emitted bytes must stay within (≈) the budget.
bytecap=$(setup_test_repo)
( cd "$bytecap"
  mkdir -p src
  i=0
  while [ "$i" -lt 60 ]; do
    printf 'x\n' > "src/this-is-a-deliberately-long-path-segment-to-burn-bytes-file-$i.ts"
    i=$((i+1))
  done
  git add -A )
# Budget 512 bytes: each row's JSON is ~90+ bytes, so well under 60 rows fit → trailer emitted.
outbc=$(OCR_CHANGE_FILES_MAX_BYTES=512 "$SCRIPT" --repo "$bytecap" --change-state staged)
assert_success "printf '%s\\n' \"\$outbc\" | grep -q '\"truncated\": *true'" "byte budget: truncation trailer emitted when manifest exceeds OCR_CHANGE_FILES_MAX_BYTES"
assert_success "printf '%s\\n' \"\$outbc\" | grep -q '\"omitted\":'" "byte budget: trailer reports omitted count"
# omitted count must be positive and the non-trailer rows must be FEWER than the 60 staged files.
emitted_rows=$(printf '%s\n' "$outbc" | grep -c '"status"' || true)
assert_success "[ \"\$emitted_rows\" -lt 60 ]" "byte budget: fewer rows emitted than total (some omitted by byte cap)"
assert_success "[ \"\$emitted_rows\" -ge 1 ]" "byte budget: at least one row still emitted (not a bare trailer)"
# A generous budget over the same repo must emit ALL 60 rows and NO trailer (cap is not spurious).
outbc2=$(OCR_CHANGE_FILES_MAX_BYTES=1000000 "$SCRIPT" --repo "$bytecap" --change-state staged)
all_rows=$(printf '%s\n' "$outbc2" | grep -c '"status"' || true)
assert_equal "60" "$all_rows" "byte budget: generous budget emits all rows"
assert_failure "printf '%s\\n' \"\$outbc2\" | grep -q '\"truncated\"'" "byte budget: generous budget emits no trailer"

# --- Fix 4 (spec §4.1 untracked-binary exclusion): `git diff --numstat` never sees untracked
# files, so an untracked binary (NUL byte in first chunk) must be dropped by the content-sniff,
# while an untracked text file beside it survives. Covers BOTH the dirty-state union and `initial`.
ubin=$(setup_test_repo)
( cd "$ubin"
  printf 'hello\nworld\n' > untracked-text.txt          # untracked text → kept
  printf 'PK\003\004\000\000bin' > untracked.bin         # untracked binary (has NUL) → dropped
  printf 'no-nul-just-bytes\xff\xfe' > untracked-hi.dat ) # high bytes but NO NUL → kept (git heuristic)
outub=$("$SCRIPT" --repo "$ubin" --change-state unstaged)
# Parsed helpers - substring greps false-fire once paths appear inside
# binary_records[].path, so assertions parse top-level JSON objects from a file.
suspect_row_present() { # $1=file $2=path -> yes/no for a suspect row
  python3 - "$1" "$2" <<'PY'
import json, sys
hit = False
for line in open(sys.argv[1], encoding='utf-8', errors='surrogateescape'):
    line = line.strip()
    if not line:
        continue
    obj = json.loads(line)
    if obj.get('path') == sys.argv[2] and obj.get('binary_suspect_reason') == 'text-extension':
        hit = True
print('yes' if hit else 'no')
PY
}
suspect_provenance() { # $1=file $2=path -> prints binary_classified_by or absent
  python3 - "$1" "$2" <<'PY'
import json, sys
value = 'absent'
for line in open(sys.argv[1], encoding='utf-8', errors='surrogateescape'):
    line = line.strip()
    if not line:
        continue
    obj = json.loads(line)
    if obj.get('path') == sys.argv[2] and obj.get('binary_suspect_reason') == 'text-extension':
        value = obj.get('binary_classified_by', 'absent')
print(value)
PY
}
trailer_count() { # $1=file -> prints binary_omitted or absent
  python3 - "$1" <<'PY'
import json, sys
value = 'absent'
for line in open(sys.argv[1], encoding='utf-8', errors='surrogateescape'):
    line = line.strip()
    if not line:
        continue
    obj = json.loads(line)
    if 'binary_omitted' in obj:
        value = str(obj['binary_omitted'])
print(value)
PY
}

outub_file="$ubin/.outub.jsonl"; printf '%s\n' "$outub" > "$outub_file"
assert_success "[ \"\$(row_present '$outub_file' untracked-text.txt)\" = yes ]" "untracked text row kept"
assert_success "[ \"\$(row_present '$outub_file' untracked.bin)\" = no ]" "untracked NUL binary not a row"
assert_success "[ \"\$(trailer_count '$outub_file')\" = 1 ]" "binary trailer counts the drop"
assert_success "[ \"\$(row_present '$outub_file' untracked-hi.dat)\" = yes ]" "high-byte no-NUL row kept"

# initial-state negatives (fixture vars are $ibin / $outib, oracle lines ~137-142):
ibin=$(mktemp -d "${TMPDIR:-/tmp}/dr-ibin.XXXXXX")
( cd "$ibin"; git init -q
  printf 'plain text\n' > init-text.txt
  printf '\000\001\002BIN' > init.bin )
outib=$("$SCRIPT" --repo "$ibin" --change-state initial)
outib_file="$ibin/.outib.jsonl"; printf '%s\n' "$outib" > "$outib_file"
assert_success "[ \"\$(row_present '$outib_file' init-text.txt)\" = yes ]" "initial text row kept"
assert_success "[ \"\$(row_present '$outib_file' init.bin)\" = no ]" "initial NUL binary not a row"
assert_success "[ \"\$(trailer_count '$outib_file')\" = 1 ]" "initial-state trailer counts the drop"

# Suspect text-extension binary stays a row:
( cd "$ubin" && printf 'a\000b' > control.mjs )
outsuspect="$("$SCRIPT" --repo "$ubin" --change-state unstaged)"
outsuspect_file="$ubin/.outsuspect.jsonl"; printf '%s\n' "$outsuspect" > "$outsuspect_file"
assert_success "[ \"\$(suspect_row_present '$outsuspect_file' control.mjs)\" = yes ]" "NUL .mjs kept as suspect row"
assert_success "[ \"\$(suspect_provenance '$outsuspect_file' control.mjs)\" = untracked-nul-sniff ]" "untracked provenance"

# First-delivery-wins: duplicate delivery via --files-from-z still counts once
ffz_dup=$(mktemp); printf 'untracked.bin\0' > "$ffz_dup"
outdup="$("$SCRIPT" --repo "$ubin" --change-state unstaged --files-from-z "$ffz_dup")"
outdup_file="$ubin/.outdup.jsonl"; printf '%s\n' "$outdup" > "$outdup_file"
assert_success "[ \"\$(trailer_count '$outdup_file')\" = 1 ]" "duplicate delivery still counts once"

# Taxonomy non-drift: four surfaces compared separately, both sides sorted+deduped.
tax_node="$(node --input-type=module -e '
const m = await import(new URL("../lib/text-extensions.mjs", "file://'"$HERE"'/"));
const norm = (a) => JSON.stringify([...new Set(a)].sort());
console.log([norm(m.codeExtensions), norm(m.markdownExtensions), norm(m.textDataExtensions), norm(m.suspectTextBasenames)].join("|"));
')"
tax_twin="$(python3 - "$SCRIPT" <<'PY'
import json, re, sys
src = open(sys.argv[1], encoding='utf-8').read()
def block(name):
    body = re.search(rf"# TAXONOMY-{name}-BEGIN(.*?)# TAXONOMY-{name}-END", src, re.S).group(1)
    return json.dumps(sorted(set(re.findall(r"'([^']+)'", body))), separators=(',', ':'))
print('|'.join([block('CODE'), block('MARKDOWN'), block('DATA'), block('BASENAME')]))
PY
)"
assert_success "[ \"\$tax_node\" = \"\$tax_twin\" ]" "taxonomy parity Node vs twin"

# Twin diagnostic sort key must accept surrogateescape paths (invalid UTF-8
# filenames) and match JS UTF-16 code-unit order, including mixed BMP/astral.
assert_success "python3 - '$SCRIPT' <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
match = re.search(
    r'def by_path\\(entry\\):\\n(?:.*\\n)*?    return entry\\[\"path\"\\]\\.encode\\(([^)]+)\\)',
    src,
)
assert match, 'twin by_path encode key missing'
ns = {}
exec('def by_path(entry):\\n    return entry[\"path\"].encode(%s)' % match.group(1), ns)
paths = ['x\\ue000.bin', 'bad-\\udcff.bin', 'x\\U0001f600.bin']
ordered = sorted(paths, key=lambda p: ns['by_path']({'path': p}))
assert ordered == ['bad-\\udcff.bin', 'x\\U0001f600.bin', 'x\\ue000.bin'], ordered
PY" "twin by_path sorts lone-surrogate and astral paths in JS order"

# Tracked (staged) suspect coverage:
( cd "$ubin" && git add control.mjs )
outstaged="$("$SCRIPT" --repo "$ubin" --change-state staged)"
outstaged_file="$ubin/.outstaged.jsonl"; printf '%s\n' "$outstaged" > "$outstaged_file"
assert_success "[ \"\$(suspect_row_present '$outstaged_file' control.mjs)\" = yes ]" "staged NUL .mjs kept as suspect row"
assert_success "[ \"\$(suspect_provenance '$outstaged_file' control.mjs)\" = git-numstat ]" "staged provenance"

# Twin trailer respects record and byte bounds:
manybin=$(setup_test_repo)
( cd "$manybin"; i=0; while [ $i -lt 30 ]; do printf '\000x' > "b$(printf '%02d' $i).bin"; i=$((i+1)); done )
outmany="$("$SCRIPT" --repo "$manybin" --change-state unstaged)"
outmany_file="$manybin/.outmany.jsonl"; printf '%s\n' "$outmany" > "$outmany_file"
assert_success "python3 - '$outmany_file' <<'PYCHK'
import json, sys
lines = [l for l in open(sys.argv[1]) if 'binary_omitted' in l]
assert lines, 'trailer missing'
obj = json.loads(lines[-1])
assert obj['binary_omitted'] == 30, obj
assert obj['binary_classified_by']['untracked-nul-sniff'] == 30, obj
assert obj['binary_omitted_at']['builder'] == 30, obj
assert obj['binary_records_listed'] <= 25
assert all(r['classified_by'] == 'untracked-nul-sniff' and r['omitted_at'] == 'builder'
           and r['status'] == 'untracked' for r in obj['binary_records'])
assert len(lines[-1].encode('utf-8')) <= 4096
PYCHK" "twin trailer respects record, map and byte bounds"
rm -rf "$manybin"   # not in the oracle's central cleanup list
# Unreadable/missing path must be fail-open (recorded), not a crash: feed a non-git manual path
# that does not exist on disk — the sniff returns False (non-binary) and the row is kept.
ffz_missing=$(mktemp); printf 'ghost-does-not-exist.txt\0' > "$ffz_missing"
outmiss=$("$SCRIPT" --repo "$ubin" --change-state non-git --files-from-z "$ffz_missing")
assert_success "printf '%s\\n' \"\$outmiss\" | grep -q 'ghost-does-not-exist.txt'" "untracked-binary: missing path fails open (recorded, no crash)"

# --- Fix 5 (codex R5 — special-file hang): looks_binary_untracked must NOT block on a FIFO,
# socket, device, or symlink-to-one passed via --files-from-z / --change-state non-git.
# Before the lstat-before-open guard was added, open(fp,"rb") on a FIFO blocks forever (the
# reader waits for a writer). The guard makes the script return promptly; this test asserts exit 0
# (non-hang). A timeout wrapper is used when portably available (gtimeout/timeout); without one
# the test still asserts exit 0 — the lstat fix ensures it returns immediately.
fifo_repo=$(setup_test_repo)
fifo_path="$fifo_repo/test.fifo"
mkfifo "$fifo_path"
# Feed the FIFO path as a manual file via --files-from-z + --change-state non-git.
# The committed plain file (a.txt from setup_test_repo) is not in scope here; we only care
# that the script completes (does not block) and exits 0.
ffz_fifo=$(mktemp); printf '%s\0' "$fifo_path" > "$ffz_fifo"
# Use a timeout guard if available; without one, the lstat fix guarantees prompt return.
_timeout_wrap() {
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout 10 "$@"
  elif command -v timeout >/dev/null 2>&1; then
    timeout 10 "$@"
  else
    "$@"
  fi
}
assert_success "_timeout_wrap \"$SCRIPT\" --repo \"$fifo_repo\" --change-state non-git --files-from-z \"$ffz_fifo\" >/dev/null" \
  "special-file(FIFO): script completes without hanging (lstat guard)"
# Also confirm a normal text file in the same repo still survives a regular staged run.
( cd "$fifo_repo"; printf 'normal\n' > normal.txt; git add normal.txt )
outfifo=$("$SCRIPT" --repo "$fifo_repo" --change-state staged)
assert_success "printf '%s\\n' \"\$outfifo\" | grep -q '\"path\": *\"normal.txt\"'" "special-file(FIFO): normal staged file unaffected by FIFO in worktree"

teardown_test_repo
rm -rf "$weird" "$init" "$ffz" "$excl" "$wip" "$cleanu" "$bytecap" "$ubin" "$ibin" "$ffz_missing" "$fifo_repo" "$ffz_fifo" "$ffz_dup"
test_summary
