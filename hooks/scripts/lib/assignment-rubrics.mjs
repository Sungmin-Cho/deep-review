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

const DOCUMENT_REVIEW_POLICY = Object.freeze([
  'Document blockers are limited to concrete repository/artifact-grounded functional contradiction; implementation infeasibility or a missing decision that prevents execution; reachable safety/security/compatibility/rollback harm; or acceptance criteria incapable of objective verification.',
  'Style, readability, naming, preference, and ungrounded speculation are advisory/info or suppressed, not Warning/Critical pre-implementation blockers.',
  'Missing future implementation/tests are implementation_verification evidence with objective acceptance evidence, not document blockers.',
]);

export function documentReviewPolicyText() {
  return [
    '### Practical document policy',
    ...DOCUMENT_REVIEW_POLICY.map((line) => `- ${line}`),
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
