'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const routerUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/model-router.mjs')).href;
const adapterUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/suite-route-adapter.mjs')).href;
const locateUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/locate-deep-model-router.mjs')).href;

function capability(overrides = {}) {
  return {
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard', 'adversarial'], read_only_enforcement: 'process-contract',
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: true, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    ...overrides,
  };
}

function reviewer(id, provider, role = 'standard') {
  return { id, provider, role, adapter_id: `${provider}-cli` };
}

function authorized(overrides = {}) {
  return {
    exit: 0,
    stdout: JSON.stringify({
      route_schema_version: 1,
      router_plugin_version: '1.0.0',
      policy_sha256: 'a'.repeat(64),
      selected_model: 'claude-sonnet-5',
      selected_effort_native: 'high',
      risk_band: 'MEDIUM',
      ...overrides,
    }),
    stderr: '',
  };
}

test('suite overlay remaps model/effort only when family matches', async () => {
  const { routeReviewer } = await import(routerUrl);
  const { applySuiteResolution, translateRouteOutcome } = await import(adapterUrl);
  const local = routeReviewer({
    unit: { target_kind: 'code-change' },
    reviewer: reviewer('claude-opus', 'claude'),
    risk: 'low',
    size: 'tiny',
    capabilities: [capability()],
  });
  const applied = applySuiteResolution(local, translateRouteOutcome(authorized()), { provider: 'claude' });
  assert.equal(applied.assignment_role, local.assignment_role);
  assert.equal(applied.rubric_id, local.rubric_id);
  assert.equal(applied.wave, local.wave);
  assert.equal(applied.provider, 'claude');
  assert.equal(applied.resolved.model, 'claude-sonnet-5');
  assert.equal(applied.resolved.effort, 'high');
  assert.equal(applied.suite_route.applied, true);

  const rejected = applySuiteResolution(local, translateRouteOutcome(authorized({
    selected_model: 'gpt-5.6-sol',
  })), { provider: 'claude' });
  assert.equal(rejected.suite_route.applied, false);
  assert.equal(rejected.suite_route.reason, 'family-mismatch');
  assert.equal(rejected.resolved.model, local.resolved.model);
  assert.equal(rejected.provider, 'claude');
});

test('suite overlay preserves router decision fingerprints when supplied', async () => {
  const { routeReviewer } = await import(routerUrl);
  const { applySuiteResolution, translateRouteOutcome } = await import(adapterUrl);
  const local = routeReviewer({
    unit: { target_kind: 'code-change' },
    reviewer: reviewer('claude-opus', 'claude'),
    risk: 'low',
    size: 'tiny',
    capabilities: [capability()],
  });
  const applied = applySuiteResolution(local, translateRouteOutcome(authorized({
    decision_fingerprint: 'decision-fingerprint-1',
    request_sha256: 'request-sha-1',
  })), { provider: 'claude' });
  assert.equal(applied.suite_route.identity.decision_fingerprint, 'decision-fingerprint-1');
  assert.equal(applied.suite_route.identity.request_sha256, 'request-sha-1');
});

test('suite overlay keeps fingerprint fields optional for legacy router decisions', async () => {
  const { routeReviewer } = await import(routerUrl);
  const { applySuiteResolution, translateRouteOutcome } = await import(adapterUrl);
  const local = routeReviewer({
    unit: { target_kind: 'code-change' },
    reviewer: reviewer('claude-opus', 'claude'),
    risk: 'low',
    size: 'tiny',
    capabilities: [capability()],
  });
  const applied = applySuiteResolution(local, translateRouteOutcome(authorized()), { provider: 'claude' });
  assert.equal(applied.suite_route.identity.decision_fingerprint, null);
  assert.equal(applied.suite_route.identity.request_sha256, null);
});

test('production routing plans preserve suite identity through JSON serialization', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const reviewers = [reviewer('claude-opus', 'claude')];
  const capabilities = [capability()];
  const artifacts = [{ target_kind: 'code-change', path: 'src/a.ts', changed_lines: 20 }];
  const build = (decision = {}) => buildRoutingPlan({
    artifacts,
    reviewers,
    capabilities,
    suiteResolve: () => ({
      dispatch_authorized: true,
      status: 'ok',
      decision: {
        selected_model: 'claude-sonnet-5',
        selected_effort_native: 'medium',
        route_schema_version: 1,
        router_plugin_version: '1.0.0',
        policy_sha256: 'a'.repeat(64),
        ...decision,
      },
    }),
  });

  const supplied = JSON.parse(JSON.stringify(build({
    decision_fingerprint: 'decision-fingerprint-2',
    request_sha256: 'request-sha-2',
  })));
  const suppliedIdentity = supplied.routes[0].suite_route.identity;
  assert.equal(suppliedIdentity.decision_fingerprint, 'decision-fingerprint-2');
  assert.equal(suppliedIdentity.request_sha256, 'request-sha-2');

  const legacy = JSON.parse(JSON.stringify(build()));
  const legacyIdentity = legacy.routes[0].suite_route.identity;
  assert.equal(legacyIdentity.decision_fingerprint, null);
  assert.equal(legacyIdentity.request_sha256, null);
});

test('suite overlay does not change seats, rubrics, admission, or family count', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const reviewers = [
    reviewer('claude-opus', 'claude', 'standard'),
    reviewer('codex-review', 'codex', 'adversarial'),
    reviewer('codex-adversarial', 'codex', 'adversarial'),
  ];
  const capabilities = [
    capability(),
    capability({ adapter_id: 'codex-cli', provider: 'codex', roles: ['adversarial'] }),
  ];
  const artifacts = [{ target_kind: 'code-change', path: 'src/a.ts', changed_lines: 20 }];
  const before = buildRoutingPlan({ artifacts, reviewers, capabilities });
  const after = buildRoutingPlan({
    artifacts, reviewers, capabilities,
    suiteResolve: () => ({
      dispatch_authorized: true,
      status: 'ok',
      decision: {
        selected_model: 'claude-sonnet-5',
        selected_effort_native: 'medium',
        route_schema_version: 1,
        router_plugin_version: '1.0.0',
        policy_sha256: 'a'.repeat(64),
      },
    }),
  });
  assert.deepEqual(after.routes.map((r) => r.reviewer_id), before.routes.map((r) => r.reviewer_id));
  assert.deepEqual(after.routes.map((r) => r.assignment_role), before.routes.map((r) => r.assignment_role));
  assert.deepEqual(after.routes.map((r) => r.rubric_id), before.routes.map((r) => r.rubric_id));
  assert.deepEqual(after.routes.map((r) => r.provider), before.routes.map((r) => r.provider));
  assert.equal(new Set(after.routes.map((r) => r.provider)).size, new Set(before.routes.map((r) => r.provider)).size);
  assert.equal(after.routes.length, before.routes.length);
});

test('explicit reviewer override is not rewritten by the suite overlay', async () => {
  const { routeReviewer } = await import(routerUrl);
  const result = routeReviewer({
    unit: { target_kind: 'code-change' },
    reviewer: reviewer('claude-opus', 'claude'),
    risk: 'low',
    size: 'tiny',
    capabilities: [capability({ model_selection: { supported: true, aliases: [], catalog_complete: false, transport: 'flag:--model' } })],
    overrides: { reviewers: { 'claude-opus': { model: 'pinned-opus', effort: 'xhigh' } } },
    suiteResolve: () => { throw new Error('suite resolver must not run for an explicit override'); },
  });
  assert.equal(result.requested.model, 'pinned-opus');
  assert.equal(result.suite_route.applied, false);
  assert.equal(result.suite_route.reason, 'explicit-override');
});

test('locator rejects personal skill trees and relative sibling checkouts', async () => {
  const { locateDeepModelRouter } = await import(locateUrl);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-loc-'));
  const personal = path.join(home, '.claude', 'skills', 'model-router', 'scripts', 'route_task.py');
  fs.mkdirSync(path.dirname(personal), { recursive: true });
  fs.writeFileSync(personal, '# personal\n');
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: personal },
    home,
  }), null);
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: '../deep-model-router/skills/model-router/scripts/route_task.py' },
    home,
    cwd: home,
  }), null);
});
