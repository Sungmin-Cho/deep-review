#!/usr/bin/env bash
# Unix oracle: prepared Node authority plus executable legacy/safety contracts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REF="$ROOT/skills/deep-review-workflow/references"
REVEXEC="$REF/review-execution.md"
CODEX="$REF/codex-integration.md"
RPT="$REF/report-format.md"

# Prose points to the executable prepared authority, never a global vote table.
assert_success "grep -qF 'review-synthesis.mjs --prepared-input' '$REVEXEC'" "prepared synthesis has an explicit Node entry"
assert_success "grep -qF 'review-evidence.mjs finalize' '$REVEXEC'" "Node finalization owns the canonical report and decision"
assert_success "grep -qF 'Count only admitted trusted roles toward N_actual' '$REVEXEC'" "only admitted trusted roles count"
assert_success "grep -qF 'NO_TRUSTED_REVIEWER' '$REVEXEC'" "no trusted reviewer has an operational receipt path"
assert_success "grep -qF 'decide-operational-stop' '$REVEXEC'" "missing decision stops without inventing a current verdict"
assert_success "grep -qF 'exactly once in adjudication-v1' '$CODEX'" "prepared implementation covers canonical sources through adjudication"
assert_success "grep -qF 'never override adjudicated disposition' '$CODEX'" "agreement provenance cannot override disposition"
assert_success "grep -qF 'Legacy unprepared verdict mapping' '$RPT'" "old vote mapping is explicitly legacy-only"
assert_success "grep -qF 'synthesizeReviewAttempts' '$RPT'" "legacy report mapping names its Node authority"
assert_success "grep -qF 'Legacy degraded mode marker' '$RPT'" "legacy degraded marker is scoped explicitly"

# Exercise real raw admission and the legacy compatibility reducer. Mutate that
# same reducer's live source for the decisive guards; every mutation must be
# present and the unchanged contract must first pass, preventing vacuous kills.
check_runtime_invariants() {
  node --input-type=module - "$ROOT" <<'NODE'
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { evaluateReviewerAttempt, synthesizeReviewAttempts } = await import(pathToFileURL(join(root, 'hooks/scripts/review-synthesis.mjs')));
const { REVIEWER_IDS } = await import(pathToFileURL(join(root, 'hooks/scripts/lib/reviewer-ids.mjs')));
const report = (critical, warning) => `# Deep Review Report — 2026-09-06
## Summary
- **Verdict**: ${critical ? 'REQUEST_CHANGES' : warning ? 'CONCERN' : 'APPROVE'}
- **Issues**: 🔴 ${critical}건, 🟡 ${warning}건, ℹ️ 0건
## Code Review
### 🔴 Critical
${critical ? '- `a.js:1` Reachable critical defect.' : 'None.'}
### 🟡 Warning
${warning ? '- `a.js:1` Reachable warning defect.' : 'None.'}
### ℹ️ Info
None.
### 🟢 Passed
- Reviewed the selected behavior.
`;
const attempt = (role, critical = 0, warning = 0, excluded = false) => evaluateReviewerAttempt({
  reviewer_id: role, role, output: excluded ? '' : report(critical, warning),
  beforeFingerprint: { mode: 'git', digest: 'before' }, afterFingerprint: { mode: 'git', digest: 'before' },
});
const clean = attempt('claude-opus'), critical = attempt('claude-opus', 1), warning = attempt('claude-opus', 0, 1), failed = attempt('codex-review', 0, 0, true);
function safety(reduce) {
  for (const attempts of [[], [failed]]) {
    const result = reduce(attempts);
    assert.equal(result.status, 'operational_failure'); assert.equal(result.n_actual, 0);
    assert.equal(result.verdict, null); assert.equal(result.phase6_allowed, false);
  }
  assert.equal(reduce([clean]).n_actual, 1);
  assert.equal(reduce([clean]).verdict, 'APPROVE');
  assert.equal(reduce([warning]).verdict, 'CONCERN'); // Explicit legacy-only rule.
  assert.equal(reduce([critical]).verdict, 'REQUEST_CHANGES');
  assert.equal(reduce([critical, failed]).verdict, 'REQUEST_CHANGES');
  assert.equal(reduce([clean, clean], { findings: [] }).status, 'operational_failure');
  assert.equal(reduce([clean, attempt('codex-review')], { findings: [] }).n_actual, 2);
}
safety(synthesizeReviewAttempts);
const source = synthesizeReviewAttempts.toString();
for (const [from, to] of [
  ['verdict: null', "verdict: 'APPROVE'"],
  ["critical > 0 ? 'REQUEST_CHANGES'", "critical > 0 ? 'APPROVE'"],
  ['(attempt) => attempt?.included === true', '() => true'],
  ['new Set(includedRoles).size !== includedRoles.length', 'false'],
]) {
  assert.ok(source.includes(from), `mutation target missing: ${from}`);
  const mutant = Function('REVIEWER_IDS', 'SHA256_PATTERN', 'consensusVerdict', `return (${source.replace(from, to)})`)(REVIEWER_IDS, /^[a-f0-9]{64}$/, () => 'APPROVE');
  assert.throws(() => safety(mutant), `unsafe mutant survived: ${from}`);
}
NODE
}
assert_success check_runtime_invariants "raw N=0, critical, one-voice, degraded guards and four decisive mutants pass"

# Production round floors remain in the Node tests: no vote prose is restored.
assert_success "node --test --test-name-pattern='N_actual=0 remains fail-closed|critical implementation reviewer/family shortfall|expansion candidate exhaustion|protocol-3 synthesis rejects duplicate' '$ROOT/tests/review-synthesis.test.js'" "production N=0, critical-family, confidence and duplicate-role floors pass"

mutant=$(mktemp)
sed 's/review-synthesis.mjs --prepared-input/review-synthesis.mjs --input/g' "$REVEXEC" > "$mutant"
assert_failure "grep -qF 'review-synthesis.mjs --prepared-input' '$mutant'" "prepared-to-legacy selector mutant loses authority"
sed 's/Legacy unprepared verdict mapping/Global vote verdict mapping/' "$RPT" > "$mutant"
assert_failure "grep -qF 'Legacy unprepared verdict mapping' '$mutant'" "unscoped voting-table mutant is rejected"
rm -f "$mutant"

test_summary
