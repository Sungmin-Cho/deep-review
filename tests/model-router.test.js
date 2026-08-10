'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const routerUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/model-router.mjs')).href;

function capability(overrides = {}) {
  return {
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard', 'adversarial', 'classifier'], read_only_enforcement: 'process-contract',
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: true, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    unit: { target_kind: 'implementation-plan', path: 'docs/plan.md', byte_size: 20_000 },
    reviewer: { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' },
    risk: 'medium', size: 'small', policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [capability()],
    ...overrides,
  };
}

test('risk and size classifiers use deterministic high-risk signals and configurable thresholds', async () => {
  const { assessRisk, assessSize } = await import(routerUrl);
  assert.equal(assessRisk([{ path: 'src/auth/permissions.ts', diff: '+ destructive data operation' }]), 'critical');
  assert.equal(assessRisk([{ path: 'docs/readme.md', content: 'typo correction' }]), 'low');
  assert.equal(assessSize({ target_kind: 'code-change', changed_lines: 101 }), 'small');
  assert.equal(assessSize({ target_kind: 'design-document', byte_size: 31 * 1024 }), 'medium');
  assert.equal(assessSize({ target_kind: 'code-change', changed_lines: 42 }, { code: [10, 20, 30] }), 'large');
});

test('K3: malformed size thresholds fail with stable ERROR_POLICY_INVALID diagnostics', async () => {
  const { assessSize } = await import(routerUrl);
  const malformed = [
    100,
    [10, 20],
    [10, '20', 30],
    [-1, 20, 30],
    [10, 10, 30],
    [20, 10, 30],
  ];
  for (const code of malformed) {
    assert.throws(
      () => assessSize({ target_kind: 'code-change', changed_lines: 12 }, { code }),
      (error) => error?.code === 'ERROR_POLICY_INVALID'
        && error.message === 'ERROR_POLICY_INVALID: classification.size_thresholds.code must be three finite non-negative strictly increasing numbers',
    );
  }
});

// F3: preserved content-derived risk/size evidence must feed routing even when
// the reduced artifact carries no raw content or diff text.
test('F3: assessRisk honours a precomputed content_risk flag and assessSize falls back to line_count for code', async () => {
  const { assessRisk, assessSize } = await import(routerUrl);
  assert.equal(assessRisk([{ path: 'src/service.js', content_risk: 'high' }]), 'high');
  assert.equal(assessRisk([{ path: 'src/service.js', content_risk: 'low' }]), 'low');
  assert.equal(assessSize({ target_kind: 'code-change', line_count: 500 }), 'medium');
});

test('auto matrix routes kind × risk × size × role with symbolic tiers', async () => {
  const { routeReviewer } = await import(routerUrl);
  const cases = [
    ['code-change', 'low', 'tiny', 'standard', 'balanced', 'high'],
    ['code-change', 'high', 'small', 'adversarial', 'quality', 'xhigh'],
    ['design-document', 'high', 'medium', 'standard', 'maximum', 'xhigh'],
    ['implementation-plan', 'medium', 'large', 'standard', 'quality', 'high'],
    ['requirements-specification', 'low', 'small', 'standard', 'quality', 'high'],
    ['generic-document', 'low', 'small', 'standard', 'balanced', 'medium'],
    ['configuration-infrastructure', 'high', 'small', 'adversarial', 'quality', 'xhigh'],
  ];
  for (const [target_kind, risk, size, role, tier, effort] of cases) {
    const result = routeReviewer(request({
      unit: { target_kind }, risk, size,
      reviewer: { id: 'claude-opus', provider: 'claude', role, adapter_id: 'claude-cli' },
    }));
    assert.equal(result.protocol_version, '3.0');
    assert.equal(result.requested.model_tier, tier, target_kind);
    assert.equal(result.requested.effort, effort, target_kind);
  }
});

test('K5: size applies monotonic routing floors without weakening strong or classifier profiles', async () => {
  const { routeReviewer } = await import(routerUrl);
  const route = (target_kind, size, risk = 'low', role = 'standard') => routeReviewer(request({
    unit: { target_kind }, size, risk,
    reviewer: { id: 'claude-opus', provider: 'claude', role, adapter_id: 'claude-cli' },
  })).requested;

  assert.deepEqual(
    [route('generic-document', 'tiny').model_tier, route('generic-document', 'tiny').effort],
    ['balanced', 'medium'],
  );
  assert.deepEqual(
    [route('generic-document', 'medium').model_tier, route('generic-document', 'medium').effort],
    ['balanced', 'high'],
  );
  assert.deepEqual(
    [route('generic-document', 'large').model_tier, route('generic-document', 'large').effort],
    ['quality', 'high'],
  );
  assert.deepEqual(
    [route('code-change', 'tiny').model_tier, route('code-change', 'tiny').effort],
    ['balanced', 'high'],
  );
  assert.deepEqual(
    [route('code-change', 'large').model_tier, route('code-change', 'large').effort],
    ['quality', 'high'],
  );
  assert.deepEqual(
    [route('design-document', 'large', 'high').model_tier, route('design-document', 'large', 'high').effort],
    ['maximum', 'xhigh'],
  );
  assert.deepEqual(
    [route('generic-document', 'large', 'low', 'classifier').model_tier, route('generic-document', 'large', 'low', 'classifier').effort],
    ['fast', 'low'],
  );
});

test('override precedence is reviewer CLI > provider CLI > global > project > user > auto', async () => {
  const { routeReviewer } = await import(routerUrl);
  const base = request({
    policy: {
      routing: { policy: 'auto' },
      project: { providers: { claude: { model: 'project-model', effort: 'medium' } } },
      user: { providers: { claude: { model: 'user-model', effort: 'low' } } },
    },
    capabilities: [capability({ model_selection: { supported: true, aliases: [], catalog_complete: false, transport: 'flag:--model' } })],
  });
  assert.equal(routeReviewer(base).requested.model, 'project-model');
  const provider = structuredClone(base);
  provider.overrides.providers.claude = { model: 'provider-model', effort: 'high' };
  assert.equal(routeReviewer(provider).requested.model, 'provider-model');
  const reviewer = structuredClone(provider);
  reviewer.overrides.reviewers['claude-opus'] = { model: 'reviewer-model', effort: 'xhigh' };
  const resolved = routeReviewer(reviewer);
  assert.equal(resolved.requested.model, 'reviewer-model');
  assert.equal(resolved.requested.effort, 'xhigh');
  assert.equal(resolved.requested.source, 'cli-reviewer');
});

// G4: the policy schema recognizes reviewer configuration at routing.reviewers
// (review-policy.mjs KNOWN.routing.reviewers). policyValue must read that
// schema-blessed location, while the existing top-level reviewers usage keeps
// working and routing.reviewers takes precedence when both are present.
test('G4: policyValue reads the schema-blessed routing.reviewers location, with precedence over top-level reviewers', async () => {
  const { routeReviewer } = await import(routerUrl);
  const base = request({
    policy: {
      routing: { policy: 'auto' },
      project: { routing: { reviewers: { 'claude-opus': { model: 'opus', effort: 'high' } } } },
    },
  });
  const result = routeReviewer(base);
  assert.equal(result.requested.model, 'opus');
  assert.equal(result.requested.effort, 'high');
  assert.equal(result.requested.model_source, 'project-policy');
  assert.equal(result.requested.effort_source, 'project-policy');

  const both = request({
    policy: {
      routing: { policy: 'auto' },
      project: {
        routing: { reviewers: { 'claude-opus': { model: 'routing-wins', effort: 'high' } } },
        reviewers: { 'claude-opus': { model: 'top-level-loses', effort: 'medium' } },
      },
    },
  });
  const bothResult = routeReviewer(both);
  assert.equal(bothResult.requested.model, 'routing-wins');
  assert.equal(bothResult.requested.effort, 'high');

  // Existing top-level reviewers usage (no routing.reviewers present) keeps working.
  const legacy = request({
    policy: {
      routing: { policy: 'auto' },
      project: { reviewers: { 'claude-opus': { model: 'legacy-model', effort: 'low' } } },
    },
  });
  assert.equal(routeReviewer(legacy).requested.model, 'legacy-model');
});

test('strict explicit unsupported values fail; fallback alone allows ordered substitution with provenance', async () => {
  const { routeReviewer } = await import(routerUrl);
  const explicit = request();
  explicit.overrides.providers.claude = { model: 'missing', effort: 'max' };
  assert.throws(() => routeReviewer(explicit), /ERROR_UNSUPPORTED_MODEL/);

  explicit.overrides.allow_fallback = true;
  const result = routeReviewer(explicit);
  assert.equal(result.resolved.model, 'deep');
  assert.equal(result.resolved.effort, 'max');
  assert.equal(result.fallback.occurred, true);
  assert.equal(result.fallback.reason, 'requested model unsupported by adapter');

  const effort = request({ capabilities: [capability({ effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh'], transport: 'flag:--effort' } })] });
  effort.overrides.providers.claude = { effort: 'max' };
  assert.throws(() => routeReviewer(effort), /ERROR_UNSUPPORTED_EFFORT/);
  effort.overrides.allow_fallback = true;
  assert.equal(routeReviewer(effort).resolved.effort, 'xhigh');
});

// F7: an explicit unknown effort alias (no lower supported level exists in
// EFFORT_ORDER) must be omitted with fallback provenance under
// allow_fallback, never silently forwarded to the adapter.
test('F7: an explicit unknown effort value is omitted under allow_fallback and throws without it', async () => {
  const { routeReviewer } = await import(routerUrl);
  const unknownEffort = request({
    capabilities: [capability({ effort_selection: { supported: true, levels: ['low', 'medium', 'high'], transport: 'flag:--effort' } })],
  });
  unknownEffort.overrides.providers.claude = { effort: 'turbo' };
  assert.throws(() => routeReviewer(unknownEffort), /ERROR_UNSUPPORTED_EFFORT/);

  unknownEffort.overrides.allow_fallback = true;
  const result = routeReviewer(unknownEffort);
  assert.equal(result.resolved.effort, null);
  assert.equal(result.fallback.occurred, true);
  assert.equal(result.fallback.reason, 'requested effort unsupported by adapter');
});

test('unknown transports and unavailable providers fail closed for explicit requests', async () => {
  const { routeReviewer } = await import(routerUrl);
  const unknown = request({ capabilities: [capability({ model_selection: { supported: 'unknown', aliases: [], catalog_complete: false, transport: 'unknown' } })] });
  unknown.overrides.providers.claude = { model: 'vendor-model' };
  assert.throws(() => routeReviewer(unknown), /ERROR_MODEL_TRANSPORT_UNAVAILABLE/);
  const unavailable = request({ capabilities: [capability({ available: false })] });
  assert.throws(() => routeReviewer(unavailable), /ERROR_PROVIDER_UNAVAILABLE/);
});

test('tier resolution follows project > user > adapter aliases and none aliases to minimal', async () => {
  const { routeReviewer } = await import(routerUrl);
  const project = request({ policy: {
    routing: { policy: 'auto' },
    project: { providers: { claude: { model_tiers: { quality: 'project-quality' } } } },
    user: { providers: { claude: { model_tiers: { quality: 'user-quality' } } } },
  }, capabilities: [capability({
    model_selection: { supported: true, aliases: [], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
  })] });
  assert.equal(routeReviewer(project).resolved.model, 'project-quality');
  project.overrides.providers.claude = { effort: 'none' };
  assert.equal(routeReviewer(project).requested.effort, 'minimal');
});

// F4: codex-native-generic now honestly declares no verified model transport
// (model_selection.supported: false, transport: 'none', aliases: []). An
// explicit override must fail closed — with no adapter-alias or tier-map
// substitute available, it fails closed even when allow_fallback is set,
// which is a stricter (and still correct) reading of "fail closed until a
// verified transport exists". Automatic (non-explicit) routing is unaffected
// and keeps resolving to the provider default.
function codexNativeGenericCapability() {
  return {
    protocol_version: '2.0', adapter_id: 'codex-native-generic', provider: 'codex', available: true,
    roles: ['standard', 'adversarial'], assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
    read_only_enforcement: 'agent-tool-allowlist',
    model_selection: { supported: true, aliases: [], catalog_complete: false, transport: 'agent-parameter:model' },
    effort_selection: { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], transport: 'agent-parameter:reasoning_effort' },
  };
}

test('explicit Codex model and effort reach the leaf unchanged without pre-runtime fallback', async () => {
  const { routeReviewer } = await import(routerUrl);
  const reviewer = { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' };
  const explicit = request({
    unit: { target_kind: 'code-change' }, reviewer,
    overrides: {
      protocol_version: '2.0',
      routing_policy: 'auto',
      allow_fallback: true,
      providers: { codex: { model: 'gpt-explicit', effort: 'xhigh' } },
      reviewers: {},
    },
    capabilities: [codexNativeGenericCapability()],
  });
  const result = routeReviewer(explicit);
  assert.deepEqual(result.resolved, { model: 'gpt-explicit', effort: 'xhigh' });
  assert.equal(result.fallback.allowed, true);
  assert.equal(result.fallback.occurred, false);
  assert.deepEqual(result.transports, {
    model: 'agent-parameter:model',
    effort: 'agent-parameter:reasoning_effort',
  });

  const automatic = request({
    unit: { target_kind: 'code-change' }, reviewer,
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [codexNativeGenericCapability()],
  });
  const automaticResult = routeReviewer(automatic);
  assert.equal(automaticResult.resolved.model, null);
  assert.equal(automaticResult.fallback.occurred, false);
});

// I2: buildRoutingPlan already reads policy.classification?.size_thresholds;
// once review-policy.mjs recognizes the schema field, a policy-supplied
// document threshold must change the computed size class.
test('I2: buildRoutingPlan honors policy.classification.size_thresholds for document size class', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];
  const artifacts = [{ target_kind: 'generic-document', path: 'README.md', byte_size: 2000 }];

  const defaultPlan = buildRoutingPlan({
    artifacts, reviewers,
    policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [capability()],
  });
  assert.match(defaultPlan.routes[0].route_explanation, /\/tiny\//, 'a 2000-byte document is tiny under the default thresholds');

  const customPlan = buildRoutingPlan({
    artifacts, reviewers,
    policy: { routing: { policy: 'auto' }, classification: { size_thresholds: { document: [500, 2500, 5000] } } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [capability()],
  });
  assert.match(customPlan.routes[0].route_explanation, /\/small\//, 'the policy-supplied document thresholds must reclassify the same artifact as small');
});

// H3: buildRoutingPlan must honor an additive riskFloor derived from the
// actual change patch (removed high-risk content, a deleted high-risk file)
// even when every artifact's own assessment reads low, without regressing
// callers that never pass riskFloor.
test('H3: buildRoutingPlan honors an additive riskFloor even when artifacts assess low; omitting riskFloor preserves current behavior', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];
  const lowRiskArtifacts = [{ target_kind: 'code-change', path: 'src/service.js', content: 'a harmless rename', changed_lines: 5 }];
  const baseArgs = {
    artifacts: lowRiskArtifacts,
    reviewers,
    policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [capability()],
  };

  const withoutFloor = buildRoutingPlan(baseArgs);
  assert.match(withoutFloor.routes[0].route_explanation, /\/low\//, 'omitting riskFloor must preserve the existing low-risk assessment');

  const withFloor = buildRoutingPlan({ ...baseArgs, riskFloor: 'high' });
  assert.match(withFloor.routes[0].route_explanation, /\/high\//, 'riskFloor: \'high\' must raise the routed risk even though the artifacts alone assess low');
});

test('an unknown non-schema routing.risk field cannot influence risk assessment', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const plan = buildRoutingPlan({
    artifacts: [{ target_kind: 'generic-document', path: 'README.md', byte_size: 1000 }],
    reviewers: [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }],
    policy: { routing: { policy: 'auto', risk: 'banana' } },
    overrides: {
      protocol_version: '2.0',
      routing_policy: 'auto',
      allow_fallback: false,
      providers: {},
      reviewers: {},
    },
    capabilities: [capability()],
  });
  assert.equal(plan.risk, 'low');
});

test('buildRoutingPlan emits protocol 3.0 with adaptive assignments and full candidate provenance', async () => {
  const { buildRoutingPlan, renderRoutingExplanation } = await import(routerUrl);
  const reviewers = [
    { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' },
    { id: 'agy', provider: 'agy', role: 'standard', adapter_id: 'agy-cli' },
    { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' },
  ];
  const plan = buildRoutingPlan({
    artifacts: [{ target_kind: 'generic-document', path: 'README.md', byte_size: 1000 }],
    reviewers,
    policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [
      capability(),
      capability({ adapter_id: 'agy-cli', provider: 'agy', model_selection: { supported: true, aliases: ['a', 'b', 'c', 'd'], catalog_complete: false, transport: 'config:agy_model' }, effort_selection: { supported: false, levels: [], transport: 'none' } }),
      capability({ adapter_id: 'codex-native-generic', provider: 'codex', model_selection: { supported: false, aliases: [], catalog_complete: false, transport: 'none' } }),
    ],
  });
  assert.equal(plan.protocol_version, '3.0');
  assert.equal(plan.reviewer_strategy, 'adaptive');
  assert.deepEqual(
    plan.candidate_reviewers.map((route) => route.reviewer_id),
    ['claude-opus', 'codex-review', 'agy'],
  );
  assert.ok(plan.routes.length >= 1);
  assert.ok(plan.routes.every((route) => route.assignment_role && route.rubric_id && route.wave === 1));
  const unused = plan.candidate_reviewers.filter((candidate) => (
    !plan.routes.some((route) => route.reviewer_id === candidate.reviewer_id)
  ));
  assert.ok(unused.length >= 1);
  assert.ok(unused.every((candidate) => candidate.expansion_route_templates
    .every((route) => route.wave === 2 && route.resolved)));
  assert.match(renderRoutingExplanation(plan), /claude-opus/);

  const designPlan = buildRoutingPlan({
    artifacts: [
      { target_kind: 'design-document', path: 'docs/design.md' },
      { target_kind: 'architecture-decision-record', path: 'docs/adr.md' },
    ],
    reviewers,
    policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [
      capability(),
      capability({ adapter_id: 'agy-cli', provider: 'agy', model_selection: { supported: true, aliases: ['a', 'b', 'c', 'd'], catalog_complete: false, transport: 'config:agy_model' }, effort_selection: { supported: false, levels: [], transport: 'none' } }),
      capability({ adapter_id: 'codex-native-generic', provider: 'codex', model_selection: { supported: false, aliases: [], catalog_complete: false, transport: 'none' } }),
    ],
  });
  assert.equal(designPlan.document_review_mode, 'design-validation');
  for (const route of designPlan.routes) {
    assert.equal(route.artifact_phase, 'document');
    assert.equal(route.risk, designPlan.risk);
    assert.equal(route.document_review_mode, 'design-validation');
  }
  for (const candidate of designPlan.candidate_reviewers) {
    for (const route of candidate.expansion_route_templates || []) {
      assert.equal(route.artifact_phase, 'document');
      assert.equal(route.risk, designPlan.risk);
      assert.equal(route.document_review_mode, 'design-validation');
    }
  }

  const planPlan = buildRoutingPlan({
    artifacts: [{ target_kind: 'implementation-plan', path: 'docs/plan.md' }],
    reviewers,
    policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [
      capability(),
      capability({ adapter_id: 'agy-cli', provider: 'agy', model_selection: { supported: true, aliases: ['a', 'b', 'c', 'd'], catalog_complete: false, transport: 'config:agy_model' }, effort_selection: { supported: false, levels: [], transport: 'none' } }),
      capability({ adapter_id: 'codex-native-generic', provider: 'codex', model_selection: { supported: false, aliases: [], catalog_complete: false, transport: 'none' } }),
    ],
  });
  assert.equal(planPlan.document_review_mode, 'full-readiness');
  for (const route of planPlan.routes) {
    assert.equal(route.document_review_mode, 'full-readiness');
  }
  for (const candidate of planPlan.candidate_reviewers) {
    for (const route of candidate.expansion_route_templates || []) {
      assert.equal(route.document_review_mode, 'full-readiness');
    }
  }
});

test('legacy codex-companion capability never creates reviewer candidates or routes', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const companion = capability({
    adapter_id: 'codex-companion',
    provider: 'codex',
    assignment_roles: ['standard', 'adversarial'],
    model_selection: { supported: false, aliases: [], catalog_complete: false, transport: 'none' },
    effort_selection: { supported: false, levels: [], transport: 'none' },
  });
  const plan = buildRoutingPlan({
    artifacts: [{ target_kind: 'code-change', path: 'src/auth.js', changed_lines: 120, content_risk: 'critical' }],
    reviewers: [
      {
        id: 'codex-review',
        provider: 'codex',
        role: 'standard',
        adapter_id: 'codex-companion',
        assignment_roles: ['standard'],
      },
      {
        id: 'codex-adversarial',
        provider: 'codex',
        role: 'adversarial',
        adapter_id: 'codex-companion',
        assignment_roles: ['adversarial'],
      },
    ],
    policy: { routing: { policy: 'auto', maximum_reviewers: 4 } },
    overrides: {
      protocol_version: '2.0',
      routing_policy: 'auto',
      allow_fallback: false,
      providers: {},
      reviewers: {},
    },
    capabilities: [companion],
  });

  assert.deepEqual(plan.candidate_reviewers, []);
  assert.deepEqual(plan.routes, []);
});

test('codex_only clamps only the non-critical static provider-family floor and records provenance', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const reviewers = [
    { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' },
    { id: 'codex-adversarial', provider: 'codex', role: 'adversarial', adapter_id: 'codex-native-generic' },
  ];
  const base = {
    artifacts: [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 1 }],
    reviewers,
    policy: { routing: { policy: 'auto', reviewer_strategy: 'static', maximum_reviewers: 4 } },
    capabilities: [codexNativeGenericCapability()],
  };
  const ordinary = buildRoutingPlan({
    ...base,
    overrides: {
      protocol_version: '2.0',
      routing_policy: 'auto',
      reviewer_strategy: 'static',
      allow_fallback: false,
      providers: {},
      reviewers: {},
    },
  });
  assert.equal(ordinary.provider_family_minimum, 2);
  assert.equal(ordinary.confidence_floor, 'CONCERN');

  const codexOnly = buildRoutingPlan({
    ...base,
    overrides: {
      protocol_version: '2.0',
      routing_policy: 'auto',
      reviewer_strategy: 'static',
      codex_only: true,
      allow_fallback: false,
      providers: {},
      reviewers: {},
    },
  });
  assert.equal(codexOnly.codex_only, true);
  assert.equal(codexOnly.provider_family_minimum, 1);
  assert.equal(codexOnly.minimum_reviewers, 2);
  assert.equal(codexOnly.confidence_floor, null);
  assert.deepEqual(codexOnly.routes.map((route) => route.reviewer_id), [
    'codex-review',
    'codex-adversarial',
  ]);

  const critical = buildRoutingPlan({
    ...base,
    artifacts: [{ target_kind: 'code-change', path: 'src/auth.js', content_risk: 'critical', changed_lines: 1 }],
    overrides: {
      protocol_version: '2.0',
      routing_policy: 'auto',
      reviewer_strategy: 'static',
      codex_only: true,
      allow_fallback: false,
      providers: {},
      reviewers: {},
    },
  });
  assert.equal(critical.provider_family_minimum, 2);
  assert.equal(critical.minimum_reviewers, 3);
  assert.equal(critical.operational_failure, true);
});

test('maximum_reviewers below the ideal floor still emits a leaf-valid bounded plan', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const plan = buildRoutingPlan({
    artifacts: [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 1 }],
    reviewers: [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }],
    policy: { routing: { policy: 'auto', maximum_reviewers: 1 } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities: [capability()],
  });
  assert.equal(plan.minimum_reviewers, 1);
  assert.equal(plan.maximum_reviewers, 1);
  assert.equal(plan.planned_reviewers, 1);
  assert.equal(plan.provider_family_minimum, 1);
  assert.equal(plan.confidence_floor, 'CONCERN');
});

test('an unselected expansion candidate cannot fail the initial plan through its provider override', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const reviewers = [
    { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' },
    { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' },
    { id: 'agy', provider: 'agy', role: 'standard', adapter_id: 'agy-cli' },
  ];
  const plan = buildRoutingPlan({
    artifacts: [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 1 }],
    reviewers,
    policy: { routing: { policy: 'auto', maximum_reviewers: 4 } },
    overrides: {
      protocol_version: '2.0',
      routing_policy: 'auto',
      allow_fallback: false,
      providers: { agy: { model: 'unsupported-explicit-model' } },
      reviewers: {},
    },
    capabilities: [
      capability(),
      capability({ adapter_id: 'codex-native-generic', provider: 'codex', model_selection: { supported: false, aliases: [], catalog_complete: false, transport: 'none' } }),
      capability({ adapter_id: 'agy-cli', provider: 'agy', model_selection: { supported: true, aliases: ['allowed'], catalog_complete: true, transport: 'flag:--model' } }),
    ],
  });
  assert.equal(plan.routes.some((route) => route.reviewer_id === 'agy'), false);
  const agy = plan.candidate_reviewers.find((candidate) => candidate.reviewer_id === 'agy');
  assert.equal(agy.expansion_route_templates.length, 0);
  assert.ok(agy.expansion_route_errors.length > 0);
});
