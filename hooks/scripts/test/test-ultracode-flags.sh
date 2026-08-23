#!/usr/bin/env bash
# Structural oracle for current cross-runtime reviewer flags and ultracode.
set -u

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PUBLIC="$ROOT/skills/deep-review/SKILL.md"
REVEXEC="$ROOT/skills/deep-review-workflow/references/review-execution.md"
LOOP="$ROOT/skills/deep-review-loop/SKILL.md"
WF_SKILL="$ROOT/skills/deep-review-workflow/SKILL.md"
ULTRA="$ROOT/skills/deep-review-workflow/references/ultracode-integration.md"
CODEXREF="$ROOT/skills/deep-review-workflow/references/codex-integration.md"
REPORTFMT="$ROOT/skills/deep-review-workflow/references/report-format.md"
P6_PROMPT="$ROOT/skills/receiving-review/references/phase6-prompt-contract.md"
RESP_FMT="$ROOT/skills/receiving-review/references/response-format.md"

PASS=0
FAIL=0
ok() { echo "PASS [$1] $2"; PASS=$((PASS+1)); }
no() { echo "FAIL [$1] $2"; FAIL=$((FAIL+1)); }
assert_grep() {
  if grep -qE -e "$3" "$2" 2>/dev/null; then
    ok "$1" "$4"
  else
    no "$1" "$4 (missing /$3/ in $(basename "$2"))"
  fi
}
assert_grep_flat() {
  if tr '\n' ' ' < "$2" | grep -qE -e "$3" 2>/dev/null; then
    ok "$1" "$4"
  else
    no "$1" "$4 (missing /$3/ in $(basename "$2"))"
  fi
}
assert_absent() {
  if grep -qE -e "$3" "$2" 2>/dev/null; then
    no "$1" "$4 (unexpected /$3/ in $(basename "$2"))"
  else
    ok "$1" "$4"
  fi
}

t_parse_validation() {
  assert_grep P1 "$PUBLIC" 'Expand .*--codex-only.*before validation' "sugar expands before validation"
  assert_grep P2 "$PUBLIC" 'Reject .*--ultracode.*--no-opus' "--ultracode plus --no-opus is rejected"
  assert_grep P3 "$PUBLIC" '\-\-no-codex' "--codex plus --no-codex conflict is represented"
  assert_grep P4 "$PUBLIC" 'SLICE-\[0-9\]\+' "--contract slice token is disambiguated"
  assert_grep P5 "$PUBLIC" 'Reviewer flags combined with .*--respond.*ignored' "--respond reviewer flags are visibly ignored"
  assert_grep P6 "$PUBLIC" 'argument-hint:.*\-\-ultracode.*\-\-codex' "public skill exposes reviewer flags"
}

t_precedence() {
  assert_grep PR1 "$REVEXEC" 'resolve reviewer flags' "reviewer flags resolve before privacy"
  assert_grep PR2 "$REVEXEC" '\-\-no-opus.*claude-opus' "--no-opus disables Claude role"
  assert_grep PR3 "$ULTRA" '\-\-ultracode.*six focused lenses' "--ultracode selects six-lens fan-out"
  assert_grep PR4 "$REVEXEC" 'named Claude agent or the Claude CLI bridge' "Claude capability fallback is explicit"
  assert_grep_flat PR5 "$REVEXEC" 'Decline or[[:space:]]+any error excludes that provider; no reviewer process receives project access\.' "decline or error excludes that provider without exposing project access"
  assert_grep PR6 "$CODEXREF" 'N_actual.*trusted successful roles' "N_actual counts trusted roles only"
  assert_grep PR7 "$REVEXEC" 'N_actual == 0.*no verdict' "single-shot N=0 fails closed"
}

t_security() {
  assert_grep S1 "$REVEXEC" '\-\-no-agy.*skip the scan and preflight' "--no-agy short-circuits privacy work"
  assert_grep S2 "$REVEXEC" 'create no state or config changes' "--no-agy makes no fingerprint/config mutation"
  assert_grep S3a "$CODEXREF" 'mutation invalidates the result and makes it' "generic reviewer mutation invalidates trust"
  assert_grep S3b "$CODEXREF" 'untrusted.*Stop the round before launching the sibling reviewer' "generic reviewer mutation stops sibling dispatch"
  assert_grep S3c "$CODEXREF" 'do not synthesize it' "generic reviewer mutation is excluded from synthesis"
  assert_grep S4 "$REVEXEC" '\-\-no-codex.*disables both' "--no-codex disables both Codex roles"
}

t_ultracode() {
  assert_grep U1 "$ULTRA" 'correctness, architecture, entropy, tests, readability' "six review dimensions are enumerated"
  assert_grep U2 "$ULTRA" 'When named-agent capability exists' "fan-out is capability-selected"
  assert_grep U3 "$REVEXEC" 'Ultracode may launch its eligible lens contexts in fresh background contexts' "ultracode lens contexts retain background concurrency"
  assert_grep U4 "$ULTRA" 'run-claude-reviewer.mjs' "fallback uses native Claude bridge"
  assert_grep U5 "$ULTRA" 'seven-line bucket' "fixed seven-line bucket is documented"
  assert_grep U6 "$ULTRA" 'severity, path, seven-line bucket, and substance' "issue identity inputs are explicit"
  assert_grep U7 "$ULTRA" 'Keep lens-level provenance' "collapsed findings retain provenance"
  assert_grep U8 "$ULTRA" '1 <= K < 4.*partial' "partial-failure band is explicit"
  assert_grep U9 "$WF_SKILL" 'ultracode-integration.md' "workflow points to ultracode SSOT"
  assert_grep U10 "$ULTRA" 'merge materially identical items' "collapse merges only material identity"
  assert_grep U11 "$ULTRA" 'claude-opus.*voice to.*N_actual' "fan-out contributes one voice"
  assert_grep U12 "$ULTRA" 'K >= 4.*success' "success requires quorum four"
}

t_execution_and_report() {
  assert_grep C1 "$REVEXEC" 'Follow .*ultracode-integration.md' "review execution delegates to ultracode SSOT"
  assert_grep C2a "$REVEXEC" 'dispatch is strictly serial and trust-gated' "native Codex dispatch is serial and trust-gated"
  assert_grep C2b "$REVEXEC" 'launch one leaf, capture the post-review fingerprint, make the trust decision' "native Codex dispatch checks post-fingerprint trust after each leaf"
  assert_grep C2c "$REVEXEC" 'only then launch the next leaf' "native Codex dispatch gates the next leaf on trust"
  assert_grep C2d "$REVEXEC" 'Stop the round before launching a sibling reviewer' "native Codex mutation stops sibling dispatch"
  assert_grep C3 "$REVEXEC" 'Six lenses collapse to one Anthropic voice' "review execution preserves one-voice accounting"
  assert_absent C4 "$REVEXEC" 'K >= [0-9].*status is.*success' "quorum mechanics are not duplicated outside SSOT"
  assert_grep C5 "$REVEXEC" '### 4.5 .*--ultracode' "review execution has ultracode branch"
  assert_grep C6 "$ULTRA" 'degrade visibly' "fallback cannot claim verified fan-out"
  assert_absent C7 "$ULTRA" 'K >= 1.*success|success.*K >= 1' "one shard cannot claim success"
  assert_grep C8 "$REVEXEC" '\-\-no-codex.*disables both' "Codex disable precedes exposure flow"

  assert_grep RF1 "$REPORTFMT" 'Claude=ultracode\(6-lens' "report labels ultracode mode"
  assert_grep RF2 "$REPORTFMT" 'agy only|agy-only' "report labels agy-only mode"
  assert_grep RF3 "$REPORTFMT" 'disjoint quorum.*K ≥.*4' "report mirrors quorum four"
  assert_grep RF4 "$REPORTFMT" 'codex-only \+ agy' "report labels codex-only plus agy"

  assert_grep X1 "$CODEXREF" 'runtime-dispatch.md.*owns role selection' "Codex reference defers capability ownership"
  assert_grep X2 "$CODEXREF" 'Ultracode.*one Anthropic voice' "Codex synthesis counts collapsed ultracode once"
  assert_absent X3 "$CODEXREF" 'K >= [0-9].*success' "Codex reference does not duplicate quorum bands"
}

t_phase6_and_loop() {
  assert_grep E1 "$P6_PROMPT" 'Opus \(ultracode\)' "Phase 6 prompt preserves ultracode source"
  assert_grep E3 "$RESP_FMT" 'Opus \(ultracode\)' "response format preserves ultracode source"
  assert_grep E4 "$WF_SKILL" 'review_model.*non-empty installed Claude model alias' "workflow preserves arbitrary model aliases"
  assert_absent E5 "$ROOT/agents/phase6-implementer.md" 'opus-ultracode' "Phase 6 implementer has no reviewer enum"

  assert_grep L1 "$LOOP" 'argument-hint:.*ultracode.*codex-only' "loop exposes reviewer flags"
  assert_grep L2 "$LOOP" 'Never forward .*--max' "loop has a never-forward set"
  assert_grep L3 "$LOOP" 'Rounds 2\+ remove .*--ultracode' "rounds two plus remove ultracode"
  assert_grep L4 "$LOOP" 'ultracode_consumed=true' "loop records ultracode consumption"
  assert_grep L5 "$LOOP" 'N_actual == 0.*stop with operational failure' "loop N=0 is terminal"
  assert_grep L6 "$LOOP" 'withhold.*--no-opus' "Codex-unavailable round retains a reviewer"
  assert_grep L7 "$LOOP" '\-\-no-opus --no-agy' "integrated later rounds disable Opus and agy"
  assert_grep L8 "$LOOP" 'floor\(line/7\)' "loop signature uses fixed bucket"
  assert_absent L8b "$LOOP" 'line ±3' "stale moving bucket is absent"
  assert_absent L9 "$LOOP" '\-\-contract.*only forwarded|only forward.*\-\-contract' "stale contract-only forwarding is absent"
  assert_grep L10 "$LOOP" 'never requested ultracode, preserve the original reviewer' "plain loops retain original reviewer flags"
}

t_docs_and_versions() {
  assert_grep D1 "$ROOT/README.md" '\-\-ultracode' "English README mentions ultracode"
  assert_grep D2 "$ROOT/README.ko.md" '\-\-ultracode' "Korean README mentions ultracode"
  assert_grep D3 "$PUBLIC" 'argument-hint:.*\-\-ultracode' "public skill is the flag discoverability authority"

  version=$(node -p "require('$ROOT/package.json').version")
  version_re=$(printf '%s' "$version" | sed 's/\./\\./g')
  assert_grep V1 "$ROOT/.claude-plugin/plugin.json" "\"version\": *\"$version_re\"" "Claude manifest matches package version"
  assert_grep V2 "$ROOT/.codex-plugin/plugin.json" "\"version\": *\"$version_re\"" "Codex manifest matches package version"
  assert_grep V3 "$ROOT/package.json" "\"version\": *\"$version_re\"" "package version is readable"
  assert_grep V4 "$ROOT/CHANGELOG.md" "^## \[$version_re\]" "English changelog contains current version"
  assert_grep V5 "$ROOT/CHANGELOG.ko.md" "^## \[$version_re\]" "Korean changelog contains current version"
}

t_mutants() {
  mutant=$(mktemp)
  sed 's/Expand /Delay /' "$PUBLIC" > "$mutant"
  assert_absent P1M "$mutant" 'Expand .*--codex-only.*before validation' "late-expansion mutant is rejected"

  sed 's/skip the scan and preflight/run the scan and preflight/' "$REVEXEC" > "$mutant"
  assert_absent S1M "$mutant" '\-\-no-agy.*skip the scan and preflight' "privacy-short-circuit mutant is rejected"

  sed 's/K >= 4/K >= 1/' "$ULTRA" > "$mutant"
  assert_absent U12M "$mutant" 'K >= 4.*success' "quorum-one mutant is rejected"

  sed 's/N_actual == 0/N_actual > 0/' "$LOOP" > "$mutant"
  assert_absent L5M "$mutant" 'N_actual == 0.*stop with operational failure' "N=0 fail-open mutant is rejected"
  rm -f "$mutant"
}

t_parse_validation
t_precedence
t_security
t_ultracode
t_execution_and_report
t_phase6_and_loop
t_docs_and_versions
t_mutants
echo "----"
echo "ultracode-flags: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
