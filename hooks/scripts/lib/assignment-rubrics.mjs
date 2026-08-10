export const ASSIGNMENT_ROLES = Object.freeze([
  'standard',
  'feasibility',
  'traceability',
  'adversarial',
  'security',
  'confirmation',
]);

const ROLE_SET = new Set(ASSIGNMENT_ROLES);

export function isAssignmentRole(value) {
  return ROLE_SET.has(value);
}

export function rubricIdForRole(role) {
  if (!isAssignmentRole(role)) throw new Error(`unsupported assignment role: ${String(role)}`);
  return `${role}-v1`;
}

export function validateRubricAssignment(role, rubricId) {
  if (!isAssignmentRole(role)) throw new Error(`unsupported assignment role: ${String(role)}`);
  const expected = rubricIdForRole(role);
  if (rubricId !== expected) {
    throw new Error(`rubric_id ${String(rubricId)} does not match assignment role ${role}`);
  }
  return { role, rubricId: expected };
}

export const DOCUMENT_REVIEW_MODES = Object.freeze([
  'design-validation',
  'full-readiness',
]);

const DOCUMENT_REVIEW_MODE_SET = new Set(DOCUMENT_REVIEW_MODES);

export function isDocumentReviewMode(value) {
  return DOCUMENT_REVIEW_MODE_SET.has(value);
}

// Both modes share the same grounded-harm blocker floor and the same
// non-blocker floor. full-readiness must stay a strict additive superset of
// design-validation's blockers — it may only add executable-readiness
// blockers on top, never drop a design blocker.
const SHARED_BLOCKER_FLOOR = 'a repository/artifact-grounded functional contradiction, implementation infeasibility, an unsound boundary/responsibility/dependency/data flow that would cause incorrect behavior, or reachable safety/security/compatibility/migration/recovery/rollback harm';
const SHARED_NON_BLOCKER_FLOOR = 'Prose completeness, wording polish, formatting, naming preference, harmless typos, traceability-table completeness, unspecified implementation detail, and missing future code/tests';
// Both modes must state this executable-semantic wording boundary
// byte-for-byte: wording only blocks when it changes observable/executable
// semantics, never merely because a document reads as incomplete.
const SHARED_WORDING_BOUNDARY = 'A wording defect blocks only when it changes an executable command, path, condition, negation, ordering rule, or acceptance result; missing future code/tests remain implementation_verification evidence.';

const DESIGN_VALIDATION_POLICY = Object.freeze([
  `Block only ${SHARED_BLOCKER_FLOOR}.`,
  `${SHARED_NON_BLOCKER_FLOOR} do not block design readiness.`,
  'Classify non-blocking implementation evidence as advisory/info or implementation_verification; never promote it merely to complete the document.',
  SHARED_WORDING_BOUNDARY,
]);

const FULL_READINESS_POLICY = Object.freeze([
  `Block only ${SHARED_BLOCKER_FLOOR}, a missing executable decision that leaves required observable/executable semantics undefined or prevents implementation, or acceptance criteria that cannot be objectively verified.`,
  `${SHARED_NON_BLOCKER_FLOOR} do not block full readiness.`,
  SHARED_WORDING_BOUNDARY,
]);

export function documentReviewPolicyText(mode = 'full-readiness') {
  if (!isDocumentReviewMode(mode)) {
    throw new Error(`unsupported document review mode: ${String(mode)}`);
  }
  const policy = mode === 'design-validation' ? DESIGN_VALIDATION_POLICY : FULL_READINESS_POLICY;
  return [
    '### Practical document policy',
    ...policy.map((line) => `- ${line}`),
  ].join('\n');
}

const RUBRICS = Object.freeze({
  standard: [
    'Evaluate correctness, regression risk, error handling, maintainability, and evidence from tests.',
    'Use only the supplied repository evidence. Report actionable locations and acceptance evidence.',
  ],
  feasibility: [
    'Evaluate implementation feasibility, prerequisites, sequencing, ownership, rollback, and testability.',
    'Trace proposed steps to concrete artifacts and identify any missing decision that blocks implementation.',
    'Do not classify missing implementation tests as Critical merely because the artifact is a document.',
  ],
  traceability: [
    'Trace every requirement and invariant to implementation steps, verification evidence, rollback, and ownership.',
    'Flag contradictions, orphan requirements, and acceptance criteria that cannot be objectively verified.',
    'Do not classify missing implementation tests as Critical merely because the artifact is a document.',
  ],
  adversarial: [
    'Challenge assumptions, boundary conditions, failure recovery, compatibility, and abuse cases.',
    'Prefer counterexamples grounded in the supplied artifact and repository evidence.',
  ],
  security: [
    'Evaluate trust boundaries, authorization, confidentiality, integrity, destructive effects, and safe rollback.',
    'Treat a reachable security-boundary violation as blocking and state the acceptance evidence needed to close it.',
  ],
  confirmation: [
    'Re-verify previously reported findings against the current original evidence.',
    'Confirm that resolved items are actually closed and look specifically for regressions or newly introduced findings.',
  ],
});

export function rubricTextForRole(role) {
  if (!isAssignmentRole(role)) throw new Error(`unsupported assignment role: ${String(role)}`);
  return RUBRICS[role].map((line) => `- ${line}`).join('\n');
}
