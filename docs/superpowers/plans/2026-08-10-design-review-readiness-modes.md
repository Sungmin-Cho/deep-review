# Design Review Readiness Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route design documents and ADRs through feasibility-and-soundness review while keeping executable documents practically full-ready, without making prose completeness blocking or weakening any convergence gate.

**Architecture:** Derive a provider-neutral `document_review_mode` from the complete classified artifact set, bind it with phase and risk into every current protocol-3 inline route, validate that context at both whole-plan and leaf-route boundaries, and let the shared payload builder select one of two blocker policies. Readiness synthesis, receipt schema, reviewer floors, mutation/fingerprint controls, and Phase 6 remain unchanged.

**Tech Stack:** Node.js 22 ESM runtime, CommonJS `node:test` suites, Markdown public skills/agent contracts, zero external dependencies.

## Global Constraints

- Node 22 on macOS, Linux, and native Windows 11; supported paths remain shell-free.
- Claude Code and Codex must consume the same provider-neutral route and payload policy.
- `design-validation` is possible only for an all-`design-document`/`architecture-decision-record` document scope.
- `full-readiness` remains the fallback for implementation plans, requirements, test plans, mixed, empty, ambiguous, and document-aware legacy scopes.
- Neither mode blocks style, sentence polish, formatting, harmless typos, naming preference, or prose completeness.
- Preserve `N_actual == 0`, reviewer/provider floors, reviewer independence, fingerprints, mutation ownership, readiness receipt schema 1.0, historical receipts, and Phase 6.
- Do not change document round caps, synthesis verdict rules, or `document-readiness.mjs` behavior.
- Do not add dependencies or create a tracked `package-lock.json`; preserve the user's existing untracked file.
- Initial design/verification used Fable 5; implementation/fixes use Sonnet 5; independent review uses Opus 5 plus `gpt-5.6-sol`; disclose requested versus actual model/effort.

---

## File Map

- `hooks/scripts/lib/assignment-rubrics.mjs`: owns the readiness-mode enum and the two trusted blocker policies.
- `hooks/scripts/lib/adaptive-review-routing.mjs`: derives one mode from the complete artifact set and adds it to assignment-plan metadata.
- `hooks/scripts/lib/model-router.mjs`: binds phase, risk, and mode into every selected and expansion protocol-3 route.
- `hooks/scripts/lib/execution-plan.mjs`: validates whole-plan and inline-route context and returns normalized camelCase fields to consumers.
- `hooks/scripts/build-reviewer-payload.mjs`: exposes validated mode in the trusted assignment and selects policy by phase plus mode.
- `tests/adaptive-review-routing.test.js`, `tests/model-router.test.js`: prove derivation and producer propagation.
- `tests/adapter-boundary.test.js`: prove legacy compatibility, route consistency, and fail-closed parsing.
- `tests/reviewer-payload.test.js`: prove identical Claude/Codex policy injection and non-document exclusion.
- `skills/deep-review-loop/SKILL.md`, `skills/deep-review-workflow/references/review-execution.md`, `skills/deep-review-workflow/references/review-criteria.md`, `skills/deep-review-workflow/references/report-format.md`, `agents/code-reviewer.md`: keep public/runtime reviewer instructions aligned with the Node authority.
- `README.md`, `README.ko.md`, `CHANGELOG.md`, `CHANGELOG.ko.md`: document the user-visible behavior bilingually.
- `.gitignore`, `tests/plugin-contract.test.js`, `tests/skill-runtime-contract.test.js`: lock repository hygiene and shipped-contract wording.

---

### Task 1: Derive the mode and bind it to every current route

**Files:**
- Modify: `hooks/scripts/lib/assignment-rubrics.mjs:1-41`
- Modify: `hooks/scripts/lib/adaptive-review-routing.mjs:1-80,191-392`
- Modify: `hooks/scripts/lib/model-router.mjs:241-330,391-475`
- Test: `tests/adaptive-review-routing.test.js:60-108`
- Test: `tests/model-router.test.js:369-402`

**Interfaces:**
- Produces: `DOCUMENT_REVIEW_MODES: readonly ['design-validation', 'full-readiness']`
- Produces: `isDocumentReviewMode(value: unknown): boolean`
- Produces: `classifyDocumentReviewMode(artifacts: Artifact[]): 'design-validation' | 'full-readiness'`
- Extends: `planReviewerAssignments(...).document_review_mode`
- Extends: protocol-3 plan and route JSON with `artifact_phase`, `risk`, and `document_review_mode`

- [ ] **Step 1: Add failing mode-classification tests**

Append this test beside the artifact-phase test in `tests/adaptive-review-routing.test.js`:

```js
test('document review mode is relaxed only for an all-design or ADR scope', async () => {
  const { classifyDocumentReviewMode } = await import(adaptiveUrl);
  assert.equal(classifyDocumentReviewMode([
    { target_kind: 'design-document' },
    { target_kind: 'architecture-decision-record' },
  ]), 'design-validation');
  for (const artifacts of [
    [],
    [{ target_kind: 'implementation-plan' }],
    [{ target_kind: 'requirements-specification' }],
    [{ target_kind: 'test-plan' }],
    [{ target_kind: 'design-document' }, { target_kind: 'implementation-plan' }],
    [{ target_kind: 'generic-document' }],
  ]) {
    assert.equal(classifyDocumentReviewMode(artifacts), 'full-readiness');
  }
});
```

- [ ] **Step 2: Run the classification test and confirm RED**

Run:

```bash
node --test --test-name-pattern='document review mode is relaxed' tests/adaptive-review-routing.test.js
```

Expected: FAIL because `classifyDocumentReviewMode` is not exported.

- [ ] **Step 3: Implement the enum and conservative classifier**

Add to `assignment-rubrics.mjs`:

```js
export const DOCUMENT_REVIEW_MODES = Object.freeze([
  'design-validation',
  'full-readiness',
]);

const DOCUMENT_REVIEW_MODE_SET = new Set(DOCUMENT_REVIEW_MODES);

export function isDocumentReviewMode(value) {
  return DOCUMENT_REVIEW_MODE_SET.has(value);
}
```

Extend the existing import in `adaptive-review-routing.mjs`, then add:

```js
const DESIGN_REVIEW_TARGETS = new Set([
  'design-document',
  'architecture-decision-record',
]);

export function classifyDocumentReviewMode(artifacts = []) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return 'full-readiness';
  return artifacts.every((artifact) => DESIGN_REVIEW_TARGETS.has(artifact?.target_kind))
    ? 'design-validation'
    : 'full-readiness';
}
```

Compute it next to `artifactPhase` in `planReviewerAssignments` and return it as
`document_review_mode` without changing role or floor selection.

- [ ] **Step 4: Add failing producer-propagation assertions**

Extend `buildRoutingPlan emits protocol 3.0...` in `tests/model-router.test.js` with an all-design input and assertions:

```js
assert.equal(plan.document_review_mode, 'design-validation');
for (const route of plan.routes) {
  assert.equal(route.artifact_phase, 'document');
  assert.equal(route.risk, plan.risk);
  assert.equal(route.document_review_mode, 'design-validation');
}
for (const candidate of plan.candidate_reviewers) {
  for (const route of candidate.expansion_route_templates || []) {
    assert.equal(route.artifact_phase, 'document');
    assert.equal(route.risk, plan.risk);
    assert.equal(route.document_review_mode, 'design-validation');
  }
}
```

Add a second assertion using an implementation-plan artifact that the plan and
all routes say `full-readiness`.

- [ ] **Step 5: Run the producer tests and confirm RED**

Run:

```bash
node --test tests/adaptive-review-routing.test.js tests/model-router.test.js
```

Expected: classification tests pass after Step 3; propagation assertions FAIL
because route JSON does not yet carry the three context fields.

- [ ] **Step 6: Bind context in the one shared route factory path**

Extend `routeReviewer` parameters with `artifactPhase` and
`documentReviewMode`, and add these fields to its returned protocol-3 route
only when current producer context is supplied:

```js
...(artifactPhase ? {
  artifact_phase: artifactPhase,
  risk,
  document_review_mode: documentReviewMode,
} : {}),
```

In `buildRoutingPlan`, pass the assignment-plan values through
`routedAssignment`:

```js
artifactPhase: assignmentPlan.artifact_phase,
documentReviewMode: assignmentPlan.document_review_mode,
```

Also return `document_review_mode: assignmentPlan.document_review_mode` at the
top plan level. Because selected routes and `expansion_route_templates` both
use `routedAssignment`, expansion receives the exact pre-derived mode without
provider-specific recomputation.

- [ ] **Step 7: Run Task 1 tests and confirm GREEN**

Run:

```bash
node --test tests/adaptive-review-routing.test.js tests/model-router.test.js
```

Expected: PASS with no changed reviewer counts, roles, model tiers, or floors.

- [ ] **Step 8: Commit Task 1**

```bash
git add hooks/scripts/lib/assignment-rubrics.mjs hooks/scripts/lib/adaptive-review-routing.mjs hooks/scripts/lib/model-router.mjs tests/adaptive-review-routing.test.js tests/model-router.test.js
git commit -m "feat(review): bind document mode to reviewer routes"
```

---

### Task 2: Validate whole-plan and inline-route context fail closed

**Files:**
- Modify: `hooks/scripts/lib/execution-plan.mjs:1-95,97-223,236-300`
- Test: `tests/adapter-boundary.test.js:151-220`

**Interfaces:**
- Consumes: `isDocumentReviewMode(value)` from Task 1.
- Produces: parsed fields `artifactPhase`, `risk`, `documentReviewMode`.
- Compatibility: protocol-2 and context-free legacy inline routes remain readable with null document context; a document-aware protocol-3 plan with no mode normalizes to `full-readiness`.

- [ ] **Step 1: Add failing whole-plan compatibility and consistency tests**

Extend the current protocol-3 fixture in `tests/adapter-boundary.test.js` and assert:

```js
const legacyDocumentPlan = structuredClone(current);
delete legacyDocumentPlan.document_review_mode;
const parsedLegacy = parseExecutionPlanDocument(legacyDocumentPlan, 'claude-opus');
assert.equal(parsedLegacy.documentReviewMode, 'full-readiness');

current.document_review_mode = 'design-validation';
for (const route of current.routes) {
  Object.assign(route, {
    artifact_phase: 'document',
    risk: 'high',
    document_review_mode: 'design-validation',
  });
}
const parsedCurrent = parseExecutionPlanDocument(current, 'claude-opus');
assert.equal(parsedCurrent.artifactPhase, 'document');
assert.equal(parsedCurrent.risk, 'high');
assert.equal(parsedCurrent.documentReviewMode, 'design-validation');
```

Add mutations that must throw: unknown mode, `design-validation` with
`artifact_phase: implementation`, partial inline context, and route context
that disagrees with its plan.

- [ ] **Step 2: Add failing leaf-route compatibility tests**

Using the existing `routeFor` fixture, assert:

```js
const legacy = parseExecutionRouteJson(JSON.stringify(routeFor('fallback', false)), 'agy');
assert.equal(legacy.artifactPhase, null);
assert.equal(legacy.risk, null);
assert.equal(legacy.documentReviewMode, null);

const documentRoute = routeFor('fallback', false);
Object.assign(documentRoute, {
  artifact_phase: 'document',
  risk: 'medium',
  document_review_mode: 'design-validation',
});
const parsed = parseExecutionRouteJson(JSON.stringify(documentRoute), 'agy');
assert.equal(parsed.documentReviewMode, 'design-validation');
```

Add `assert.throws` cases for an unknown mode, design mode on implementation,
and each one-field/two-field partial context combination.

- [ ] **Step 3: Run the boundary tests and confirm RED**

Run:

```bash
node --test --test-name-pattern='routing plan leaf|inline execution-route|document review mode' tests/adapter-boundary.test.js
```

Expected: FAIL because parsers return null or ignore malformed context.

- [ ] **Step 4: Implement shared validation with distinct plan and inline defaults**

Import `isDocumentReviewMode` and add these private helpers:

```js
const RISK_VALUES = new Set(['low', 'medium', 'high', 'critical']);

function validateDocumentContext(artifactPhase, risk, documentReviewMode, label) {
  if (!['document', 'implementation'].includes(artifactPhase)) {
    throw new Error(`${label} artifact_phase is invalid`);
  }
  if (!RISK_VALUES.has(risk)) throw new Error(`${label} risk is invalid`);
  if (!isDocumentReviewMode(documentReviewMode)) {
    throw new Error(`${label} document_review_mode is invalid`);
  }
  if (artifactPhase !== 'document' && documentReviewMode === 'design-validation') {
    throw new Error('design-validation requires document artifact phase');
  }
  return { artifactPhase, risk, documentReviewMode };
}

function normalizePlanDocumentContext(document) {
  return validateDocumentContext(
    document.artifact_phase,
    document.risk,
    document.document_review_mode ?? 'full-readiness',
    'routing plan',
  );
}

function normalizeInlineDocumentContext(route) {
  const fields = ['artifact_phase', 'risk', 'document_review_mode'];
  const present = fields.filter((field) => Object.hasOwn(route, field));
  if (present.length === 0) {
    return { artifactPhase: null, risk: null, documentReviewMode: null };
  }
  if (present.length !== fields.length) throw new Error('execution route document context must be complete');
  return validateDocumentContext(
    route.artifact_phase,
    route.risk,
    route.document_review_mode,
    'execution route',
  );
}
```

Call `normalizePlanDocumentContext` only for protocol-3 plan documents after
the existing metadata validation. Call `normalizeInlineDocumentContext` for a
standalone route and for each plan route that contains at least one of the
three context keys. No missing, malformed, or default path may produce
`design-validation`.

- [ ] **Step 5: Enforce plan/route equality and return normalized fields**

In `parseExecutionPlanDocument`, normalize plan metadata, accept legacy routes
without route-local context, and when route-local context is present enforce:

```js
const routeContext = normalizeInlineDocumentContext(candidate);
if (routeContext.artifactPhase !== planContext.artifactPhase
    || routeContext.risk !== planContext.risk
    || routeContext.documentReviewMode !== planContext.documentReviewMode) {
  throw new Error(`routing plan route document context mismatch for ${candidate.reviewer_id}`);
}
```

Use explicit errors rather than Node assertions. In `parseExecutionRoute`,
normalize the standalone route and replace the hard-coded null fields with the
normalized camelCase values.

- [ ] **Step 6: Run boundary and routing integration tests**

Run:

```bash
node --test tests/adapter-boundary.test.js tests/routing-integration.test.js tests/routing-flags.test.js
```

Expected: PASS, including legacy protocol-2 and context-free inline fixtures.

- [ ] **Step 7: Commit Task 2**

```bash
git add hooks/scripts/lib/execution-plan.mjs tests/adapter-boundary.test.js
git commit -m "feat(review): validate inline document context"
```

---

### Task 3: Inject mode-specific practical blocker policy for both providers

**Files:**
- Modify: `hooks/scripts/lib/assignment-rubrics.mjs:30-75`
- Modify: `hooks/scripts/build-reviewer-payload.mjs:35-65`
- Test: `tests/reviewer-payload.test.js:86-130,313-359,740-820`

**Interfaces:**
- Consumes: validated `artifactPhase`, `risk`, and `documentReviewMode` from Task 2.
- Produces: `documentReviewPolicyText(mode)` with separate design and full policies.
- Rule: phase controls whether document policy is injected; mode alone controls which document policy text is injected.

- [ ] **Step 1: Add failing policy-unit assertions**

Add a test that imports `documentReviewPolicyText` directly:

```js
test('document policies separate design soundness from executable readiness', async () => {
  const { documentReviewPolicyText } = await import(pathToFileURL(
    join(pluginRoot, 'hooks', 'scripts', 'lib', 'assignment-rubrics.mjs'),
  ).href);
  const design = documentReviewPolicyText('design-validation');
  const full = documentReviewPolicyText('full-readiness');
  assert.match(design, /implementation infeasibility/i);
  assert.match(design, /boundary|responsibility|data flow/i);
  assert.match(design, /prose completeness.*not.*block/i);
  assert.doesNotMatch(design, /missing executable decision.*block/i);
  assert.match(full, /missing executable decision.*block/i);
  assert.match(full, /acceptance criteria.*objectively verif/i);
  assert.match(full, /prose completeness.*not.*block/i);
  assert.throws(() => documentReviewPolicyText('unknown'), /document review mode/u);
});
```

- [ ] **Step 2: Add failing inline payload tests for Claude and Codex**

Create protocol-3 inline route fixtures for `claude-opus`, `codex-review`, and
`codex-adversarial`, each with document phase and design mode. Call
`buildReviewerPayload({ executionRouteJson: JSON.stringify(route), ... })` and
assert every prompt includes:

```text
artifact_phase: document
risk: high
document_review_mode: design-validation
```

Extract the `### Practical document policy` section and assert it is
byte-identical across all three providers. Repeat with `full-readiness` and
assert the executable-decision blocker appears. For an implementation-phase
route, assert no practical document policy is injected.

- [ ] **Step 3: Run payload tests and confirm RED**

Run:

```bash
node --test --test-name-pattern='document policies separate|inline payload|document routes inject' tests/reviewer-payload.test.js
```

Expected: FAIL because the current policy has no mode and inline routes lose
document context.

- [ ] **Step 4: Implement the two exact policy texts**

Replace the single `DOCUMENT_REVIEW_POLICY` with two frozen arrays. The design
array must state:

```js
const DESIGN_VALIDATION_POLICY = Object.freeze([
  'Block only a repository/artifact-grounded functional contradiction, implementation infeasibility, an unsound boundary/responsibility/dependency/data flow that would cause incorrect behavior, or reachable safety/security/compatibility/migration/recovery/rollback harm.',
  'Prose completeness, wording polish, formatting, naming preference, traceability-table completeness, unspecified implementation detail, and missing future code/tests do not block design readiness.',
  'Classify non-blocking implementation evidence as advisory/info or implementation_verification; never promote it merely to complete the document.',
]);
```

The full array must state:

```js
const FULL_READINESS_POLICY = Object.freeze([
  'Block only a repository/artifact-grounded functional contradiction, implementation infeasibility, a missing executable decision that prevents implementation or permits materially different valid implementations, reachable safety/security/compatibility/rollback harm, or acceptance criteria that cannot be objectively verified.',
  'Prose completeness, sentence polish, formatting, section length, naming preference, harmless typos, and implementation-irrelevant omissions do not block full readiness.',
  'A wording defect blocks only when it changes an executable command, path, condition, negation, ordering rule, or acceptance result; missing future code/tests remain implementation_verification evidence.',
]);
```

Make `documentReviewPolicyText(mode = 'full-readiness')` reject unknown explicit
values using `isDocumentReviewMode` and render the selected array.

- [ ] **Step 5: Make the trusted assignment expose and consume mode**

In `trustedAssignmentSection`, add:

```js
`document_review_mode: ${executionPlan.documentReviewMode}`,
```

inside the document-context block. Change policy selection to:

```js
...(executionPlan.artifactPhase === 'document'
  ? ['', documentReviewPolicyText(executionPlan.documentReviewMode || 'full-readiness')]
  : []),
```

Do not branch on reviewer ID, provider, host marker, role, or risk.

- [ ] **Step 6: Run Task 3 and unchanged readiness tests**

Run:

```bash
node --test tests/reviewer-payload.test.js tests/document-readiness.test.js tests/review-synthesis.test.js
```

Expected: PASS. `document-readiness.test.js` must pass without production
changes to `hooks/scripts/document-readiness.mjs`.

- [ ] **Step 7: Commit Task 3**

```bash
git add hooks/scripts/lib/assignment-rubrics.mjs hooks/scripts/build-reviewer-payload.mjs tests/reviewer-payload.test.js
git commit -m "feat(review): focus design reviewers on soundness"
```

---

### Task 4: Synchronize public contracts, bilingual docs, and repository hygiene

**Files:**
- Modify: `skills/deep-review-loop/SKILL.md:307-325`
- Modify: `skills/deep-review-workflow/references/review-execution.md:441-478`
- Modify: `skills/deep-review-workflow/references/review-criteria.md:90-107`
- Modify: `skills/deep-review-workflow/references/report-format.md:135-154`
- Modify: `agents/code-reviewer.md:35-54`
- Modify: `README.md:270-292`
- Modify: `README.ko.md:269-291`
- Modify: `CHANGELOG.md:5`
- Modify: `CHANGELOG.ko.md:5`
- Modify: `.gitignore:1-45`
- Test: `tests/skill-runtime-contract.test.js:739-783`
- Test: `tests/plugin-contract.test.js:73-78`

**Interfaces:**
- Consumes: the two runtime policies from Task 3.
- Produces: one consistent public contract for Claude Code and Codex.
- Hygiene: ignores `/package-lock.json` without deleting or modifying the existing file.

- [ ] **Step 1: Replace the broad prose-contract test with mode-specific RED assertions**

Extend `document instructions use practical blockers...` so every English
runtime/public source must contain both `design-validation` and
`full-readiness`, plus these semantic anchors:

```js
assert.match(normalized, /design-validation.*implementation feasibility.*design soundness/is);
assert.match(normalized, /full-readiness.*missing executable decision.*objectively verif/is);
assert.match(normalized, /prose completeness.*(?:not|never).*block/is);
assert.match(normalized, /mixed.*full-readiness/is);
```

Add equivalent Korean assertions to `README.ko.md`, including `문구 완결성` and
`차단하지` in the same normalized policy block.

- [ ] **Step 2: Add a RED repository-hygiene contract**

Add to `tests/plugin-contract.test.js`:

```js
test('dependency-free plugin ignores the local npm lock artifact', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(Object.hasOwn(manifest, 'dependencies'), false);
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false);
  assert.match(read('.gitignore'), /^\/package-lock\.json$/mu);
});
```

- [ ] **Step 3: Run the contract tests and confirm RED**

Run:

```bash
node --test tests/skill-runtime-contract.test.js tests/plugin-contract.test.js
```

Expected: FAIL because shipped instructions do not distinguish the modes and
`.gitignore` does not yet contain `/package-lock.json`.

- [ ] **Step 4: Update every shipped policy surface with the same behavioral rules**

In each English runtime/public file, replace the single practical-policy block
with two concise subsections:

```markdown
### design-validation

For an all-design-document/ADR scope, block only grounded functional
contradictions, implementation infeasibility, behavior-causing unsound design,
or reachable safety/security/compatibility/recovery harm. Prose completeness
and unspecified implementation detail do not block.

### full-readiness

For executable document scopes, additionally block a missing executable
decision or objectively unverifiable acceptance criteria. Prose completeness,
wording polish, formatting, and harmless typos still do not block.
```

State that mixed/ambiguous scopes use full readiness, readiness remains the
final verdict authority, and implementation phase retains normal code review.
Keep the richer per-file surrounding contract intact rather than replacing
unrelated sections.

Mirror the same meaning in `README.ko.md`; preserve the README section order
and bilingual links.

- [ ] **Step 5: Add paired unreleased changelog entries**

Insert this English structure before `2.4.0`:

```markdown
## [Unreleased]

### Changed

- **Design review readiness modes** — design documents and ADRs now review implementation feasibility and design soundness, while executable plans retain practical full readiness. Neither mode treats prose completeness as blocking, and both hosts receive the same validated inline-route policy.
```

Add the structurally matching Korean entry with the same single bullet and
meaning.

- [ ] **Step 6: Ignore only the root npm lock artifact**

Append under the repository-source ignore explanation in `.gitignore`:

```gitignore
# 이 zero-dependency 플러그인에서 로컬 npm 실행이 만드는 비제품 산출물
/package-lock.json
```

Do not delete, rewrite, stage, or inspect the contents of the existing
`package-lock.json` during implementation.

- [ ] **Step 7: Run contract tests and inspect bilingual structure**

Run:

```bash
node --test tests/skill-runtime-contract.test.js tests/plugin-contract.test.js
git diff --check
git status --short --ignored
```

Expected: tests PASS; `package-lock.json` appears ignored rather than deleted or
tracked; English/Korean pairs retain matching headings and bullet counts.

- [ ] **Step 8: Commit Task 4**

```bash
git add .gitignore agents/code-reviewer.md skills/deep-review-loop/SKILL.md skills/deep-review-workflow/references/review-execution.md skills/deep-review-workflow/references/review-criteria.md skills/deep-review-workflow/references/report-format.md README.md README.ko.md CHANGELOG.md CHANGELOG.ko.md tests/skill-runtime-contract.test.js tests/plugin-contract.test.js
git commit -m "docs(review): define practical readiness modes"
```

---

### Task 5: Verify production contracts and release invariants

**Files:**
- Verify only; modify only the Task 1-4 files if a test exposes a direct regression.

**Interfaces:**
- Consumes: all Task 1-4 deliverables.
- Produces: terminal test evidence suitable for independent Opus 5 and `gpt-5.6-sol` review.

- [ ] **Step 1: Run the focused behavioral suite**

```bash
node --test tests/adaptive-review-routing.test.js tests/model-router.test.js tests/adapter-boundary.test.js tests/reviewer-payload.test.js tests/document-readiness.test.js tests/review-synthesis.test.js tests/routing-integration.test.js tests/routing-flags.test.js tests/skill-runtime-contract.test.js tests/plugin-contract.test.js
```

Expected: terminal exit 0 with all selected tests passing.

- [ ] **Step 2: Run the full native suite**

```bash
npm test
```

Expected: terminal exit 0; capture the final pass/fail count.

- [ ] **Step 3: Run Unix parity oracles**

```bash
npm run test:legacy
```

Expected: terminal exit 0. Treat these as parity evidence only, not a supported
runtime path.

- [ ] **Step 4: Run pinned release contracts**

```bash
node --test tests/plugin-contract.test.js tests/skill-runtime-contract.test.js tests/native-release-smoke.test.js
```

Expected: terminal exit 0.

- [ ] **Step 5: Run final repository checks**

```bash
git diff --check
git status --short --ignored
git log --oneline --decorate -8
```

Expected: no whitespace errors; no tracked `package-lock.json`; only intended
files differ from the design-doc base commits.

- [ ] **Step 6: Dispatch independent cross-model review**

Dispatch fresh read-only reviewers against the final diff:

- Opus 5 with effort selected from final diff risk (expected `high` unless the
  implementation crosses an additional trust boundary).
- `gpt-5.6-sol` with the same independent brief and effort selected separately
  from the same risk evidence.

Require exact file:line findings and one `APPROVE` or `REQUEST_CHANGES` verdict
from each. Do not disclose either reviewer's conclusions to the other. If a
review requests changes, route the fix to Sonnet 5, rerun the directly affected
RED/GREEN and full verification steps, then obtain fresh independent verdicts.

- [ ] **Step 7: Report requested versus actual routing and evidence**

The final report must list the requested and actually observed model/effort for
Fable design, Sonnet implementation/fixes, Opus review, and Sol review; all
terminal test commands with exit status/counts; both reviewer verdicts; and any
unverified platform boundary such as native Windows if it was not run locally.
