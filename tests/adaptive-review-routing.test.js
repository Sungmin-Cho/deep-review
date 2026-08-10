'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const adaptiveUrl = pathToFileURL(path.join(
  root,
  'hooks/scripts/lib/adaptive-review-routing.mjs',
)).href;
const routerUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/model-router.mjs')).href;

const candidates = [
  {
    id: 'claude-opus',
    provider: 'claude',
    adapter_id: 'claude-cli',
    assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    id: 'codex-review',
    provider: 'codex',
    adapter_id: 'codex-native-generic',
    assignment_roles: ['standard', 'feasibility', 'traceability', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    id: 'codex-adversarial',
    provider: 'codex',
    adapter_id: 'codex-native-generic',
    assignment_roles: ['adversarial', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    id: 'agy',
    provider: 'agy',
    adapter_id: 'agy-cli',
    assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
    last_status: 'unknown',
  },
];

function plan(overrides = {}) {
  return {
    artifacts: [{ path: 'docs/plan.md', target_kind: 'implementation-plan' }],
    risk: 'low',
    candidates,
    reviewerStrategy: 'adaptive',
    maximumReviewers: 4,
    progress: { state: 'initial', used_reviewers: [] },
    requiredReviewers: [],
    requiredProviders: [],
    ...overrides,
  };
}

test('artifact phase is document only for an all-design/spec/plan/ADR/test-plan scope', async () => {
  const { classifyArtifactPhase } = await import(adaptiveUrl);
  assert.equal(classifyArtifactPhase([
    { target_kind: 'design-document' },
    { target_kind: 'implementation-plan' },
    { target_kind: 'requirements-specification' },
    { target_kind: 'architecture-decision-record' },
    { target_kind: 'test-plan' },
  ]), 'document');
  assert.equal(classifyArtifactPhase([
    { target_kind: 'implementation-plan' },
    { target_kind: 'code-change' },
  ]), 'implementation');
  assert.equal(classifyArtifactPhase([{ target_kind: 'generic-document' }]), 'implementation');
});

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

test('adaptive matrix selects role-fit reviewer floors by phase and risk', async () => {
  const { planReviewerAssignments } = await import(adaptiveUrl);

  const lowDocument = planReviewerAssignments(plan());
  assert.equal(lowDocument.artifact_phase, 'document');
  assert.equal(lowDocument.minimum_reviewers, 1);
  assert.deepEqual(lowDocument.assignments.map((item) => item.assignment_role), ['feasibility']);

  const highDocument = planReviewerAssignments(plan({ risk: 'high' }));
  assert.equal(highDocument.minimum_reviewers, 2);
  assert.equal(new Set(highDocument.assignments.map((item) => item.provider)).size, 2);

  const lowImplementation = planReviewerAssignments(plan({
    artifacts: [{ path: 'src/app.js', target_kind: 'code-change' }],
  }));
  assert.equal(lowImplementation.artifact_phase, 'implementation');
  assert.equal(lowImplementation.minimum_reviewers, 2);
  assert.deepEqual(
    lowImplementation.assignments.map((item) => item.assignment_role),
    ['standard', 'adversarial'],
  );
  assert.equal(new Set(lowImplementation.assignments.map((item) => item.provider)).size, 2);

  const highImplementation = planReviewerAssignments(plan({
    artifacts: [{ path: 'src/auth.js', target_kind: 'code-change' }],
    risk: 'high',
  }));
  assert.equal(highImplementation.planned_reviewers, 3);
  assert.deepEqual(
    highImplementation.assignments.map((item) => item.assignment_role),
    ['standard', 'adversarial', 'security'],
  );
});

test('selection is deterministic across candidate input order', async () => {
  const { planReviewerAssignments } = await import(adaptiveUrl);
  const forward = planReviewerAssignments(plan({
    artifacts: [{ path: 'src/app.js', target_kind: 'code-change' }],
    risk: 'high',
  }));
  const reverse = planReviewerAssignments(plan({
    artifacts: [{ path: 'src/app.js', target_kind: 'code-change' }],
    risk: 'high',
    candidates: [...candidates].reverse(),
  }));
  assert.deepEqual(reverse, forward);
});

test('confirmation contracts and regression expands within the configured maximum', async () => {
  const { planReviewerAssignments } = await import(adaptiveUrl);
  const implementation = [{ path: 'src/app.js', target_kind: 'code-change' }];
  const confirmation = planReviewerAssignments(plan({
    artifacts: implementation,
    progress: { state: 'confirmation', used_reviewers: ['claude-opus'] },
  }));
  assert.equal(confirmation.assignments.length, 1);
  assert.equal(confirmation.assignments[0].assignment_role, 'confirmation');
  assert.equal(confirmation.assignments[0].tier_adjustment, -1);
  assert.notEqual(confirmation.assignments[0].reviewer_id, 'claude-opus');

  const initial = planReviewerAssignments(plan({ artifacts: implementation }));
  const regression = planReviewerAssignments(plan({
    artifacts: implementation,
    progress: { state: 'regression', used_reviewers: initial.assignments.map((item) => item.reviewer_id) },
  }));
  assert.equal(regression.assignments.length, initial.assignments.length + 1);
  assert.ok(regression.assignments.every((item) => item.tier_adjustment === 1));
});

test('manual reviewer constraints are required assignments while provider overrides do not add reviewers', async () => {
  const { planReviewerAssignments } = await import(adaptiveUrl);
  const required = planReviewerAssignments(plan({
    requiredReviewers: ['codex-adversarial'],
  }));
  const selected = required.assignments.find((item) => item.reviewer_id === 'codex-adversarial');
  assert.ok(selected);
  assert.equal(selected.required, true);
  assert.ok(required.assignments
    .filter((item) => item.reviewer_id !== 'codex-adversarial')
    .every((item) => item.required === false));

  const threeRequired = planReviewerAssignments(plan({
    requiredReviewers: ['claude-opus', 'codex-adversarial', 'agy'],
  }));
  assert.deepEqual(
    new Set(threeRequired.assignments.map((item) => item.reviewer_id)),
    new Set(['claude-opus', 'codex-adversarial', 'agy']),
  );
  assert.ok(threeRequired.assignments
    .filter((item) => ['claude-opus', 'codex-adversarial', 'agy'].includes(item.reviewer_id))
    .every((item) => item.required));

  const providerOnly = planReviewerAssignments(plan({
    providerOverrides: { agy: { model: 'provider-specific' } },
  }));
  assert.equal(providerOnly.assignments.some((item) => item.provider === 'agy'), false);
  assert.ok(providerOnly.assignments.every((item) => item.required === false));
});

test('static strategy fixes the eligible reviewer set and critical shortages fail closed', async () => {
  const { planReviewerAssignments } = await import(adaptiveUrl);
  const staticPlan = planReviewerAssignments(plan({ reviewerStrategy: 'static' }));
  assert.deepEqual(
    staticPlan.assignments.map((item) => item.reviewer_id),
    ['claude-opus', 'codex-review', 'codex-adversarial', 'agy'],
  );
  assert.equal(staticPlan.planned_reviewers, staticPlan.assignments.length);

  const critical = planReviewerAssignments(plan({
    artifacts: [{ path: 'src/auth.js', target_kind: 'code-change' }],
    risk: 'critical',
    candidates: candidates.slice(0, 2),
  }));
  assert.equal(critical.operational_failure, true);
  assert.ok(critical.shortfalls.includes('minimum_reviewers'));
});

test('critical document codex-only static routing retains the two-family provider floor', async () => {
  const { planReviewerAssignments } = await import(adaptiveUrl);
  const criticalDocument = planReviewerAssignments(plan({
    artifacts: [{ path: 'docs/design.md', target_kind: 'design-document' }],
    risk: 'critical',
    reviewerStrategy: 'static',
    codexOnly: true,
    candidates: candidates.filter((candidate) => candidate.provider === 'codex'),
  }));
  assert.equal(criticalDocument.minimum_reviewers, 2);
  assert.equal(criticalDocument.provider_family_minimum, 2);
  assert.ok(criticalDocument.shortfalls.includes('provider_families'));
  assert.equal(criticalDocument.confidence_floor, 'CONCERN');
});

test('risk assessment is four-level and monotonic across size, mixed, prior, receipt, and critical signals', async () => {
  const { assessRisk } = await import(routerUrl);
  assert.equal(assessRisk([{ path: 'docs/note.md', content: 'typo' }]), 'low');
  assert.equal(assessRisk([
    { path: 'docs/plan.md', target_kind: 'implementation-plan', confidence: 0.4 },
  ]), 'medium');
  assert.equal(assessRisk([{ path: 'src/api.js', content: 'public API rollback path' }]), 'high');
  assert.equal(assessRisk([{
    path: 'src/auth/delete.js',
    content: 'authentication security boundary irreversible user data deletion',
  }]), 'critical');
  assert.equal(assessRisk([{ path: 'docs/note.md', content: 'typo' }], {
    priorRisk: 'high',
  }), 'high');
  assert.equal(assessRisk([{ path: 'docs/note.md', content: 'typo' }], {
    receiptRisk: 'critical',
  }), 'critical');
});

test('adaptive feature opt-out chooses static unless a CLI reviewer strategy explicitly overrides it', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const capabilities = candidates.map((candidate) => ({
    protocol_version: '2.0',
    adapter_id: candidate.adapter_id,
    provider: candidate.provider,
    available: true,
    roles: ['standard'],
    assignment_roles: candidate.assignment_roles,
    model_selection: { supported: false, aliases: [], transport: 'none' },
    effort_selection: { supported: false, levels: [], transport: 'none' },
    structured_output: true,
    read_only_enforcement: 'process-contract',
  }));
  const disabled = buildRoutingPlan({
    artifacts: [{ path: 'src/app.js', target_kind: 'code-change' }],
    reviewers: candidates,
    capabilities,
    policy: {
      features: { adaptive_reviewer_routing: false },
      routing: { reviewer_strategy: 'adaptive', maximum_reviewers: 4 },
    },
  });
  assert.equal(disabled.reviewer_strategy, 'static');
  assert.equal(disabled.routes.length, 4);

  const explicit = buildRoutingPlan({
    artifacts: [{ path: 'src/app.js', target_kind: 'code-change' }],
    reviewers: candidates,
    capabilities,
    policy: {
      features: { adaptive_reviewer_routing: false },
      routing: { reviewer_strategy: 'adaptive', maximum_reviewers: 4 },
    },
    overrides: { reviewer_strategy: 'adaptive' },
  });
  assert.equal(explicit.reviewer_strategy, 'adaptive');
  assert.equal(explicit.routes.length, 2);
});

test('privacy preflight is selection-gated and a declined selected agy route replans at most once', async () => {
  const {
    planReviewerAssignments,
    requiresReviewerPreflight,
    replanAfterSelectedReviewerUnavailable,
  } = await import(adaptiveUrl);
  const ordinary = planReviewerAssignments(plan({
    artifacts: [{ path: 'src/app.js', target_kind: 'code-change' }],
  }));
  assert.equal(requiresReviewerPreflight(ordinary, 'agy'), false);

  const agySelected = planReviewerAssignments(plan({
    requiredReviewers: ['agy'],
  }));
  assert.equal(requiresReviewerPreflight(agySelected, 'agy'), true);
  const requiredFailure = replanAfterSelectedReviewerUnavailable({
    plan: agySelected,
    unavailableReviewerId: 'agy',
    replansUsed: 0,
    planningOptions: plan({ requiredReviewers: [] }),
  });
  assert.equal(requiredFailure.replanned, false);
  assert.equal(requiredFailure.operational_failure, true);
  assert.equal(requiredFailure.replan_rejected, 'required_reviewer_unavailable');

  const optionalAgy = planReviewerAssignments(plan({
    artifacts: [{ path: 'src/app.js', target_kind: 'code-change' }],
    candidates: candidates.filter((candidate) => ['claude-opus', 'agy'].includes(candidate.id)),
  }));
  const replanned = replanAfterSelectedReviewerUnavailable({
    plan: optionalAgy,
    unavailableReviewerId: 'agy',
    replansUsed: 0,
    planningOptions: plan({
      artifacts: [{ path: 'src/app.js', target_kind: 'code-change' }],
      candidates: candidates.filter((candidate) => ['claude-opus', 'agy'].includes(candidate.id)),
      requiredReviewers: [],
    }),
  });
  assert.equal(replanned.replanned, true);
  assert.equal(replanned.replans_used, 1);
  assert.equal(replanned.assignments.some((item) => item.reviewer_id === 'agy'), false);

  const refusedAgain = replanAfterSelectedReviewerUnavailable({
    plan: replanned,
    unavailableReviewerId: replanned.assignments[0].reviewer_id,
    replansUsed: 1,
    planningOptions: plan({ requiredReviewers: [] }),
  });
  assert.equal(refusedAgain.replanned, false);
  assert.equal(refusedAgain.operational_failure, true);
  assert.equal(refusedAgain.replan_rejected, 'maximum_replans_reached');
});
