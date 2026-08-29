'use strict';

// SLICE-005 — D11 exclusive `grok-4.6` authorization, enforced source-independently.
//
// D11 enumerates six paths by which an attempt could launch on something other
// than an explicitly specified `grok-4.6`. Four of them (P1, P2, P3, P6) are
// closed here at one point — the provider-scoped rule in `validateConstraints`,
// which runs before `explicitModel` is computed and before the fallback
// machinery exists, so it keys off no source and no `allow_fallback` flag. P4
// and P5 are the bridge's own responsibility and belong to SLICE-008.
//
// The defect this file exists to prevent is the belief that a tier-complete
// closed catalog is sufficient. It is not: with
// `providers.grok.model_tiers.balanced: grok-4.5` the catalog check fires,
// the throw is gated on `explicitModel`, no replacement differs from the
// request, and the route lands on `resolved.model = null` — the omitted-flag
// outcome the decision exists to eliminate. Every model case below is
// therefore written per SOURCE, not per value.
//
// The effort companion is deliberately asymmetric. E1 rejects every non-`auto`
// source outside `low|medium|high`; the split is genuine `auto` versus every
// other source, not `cli-` versus the rest, because `project-policy` and
// `user-policy` efforts are operator requests too. E2 makes the automatic
// branch a total function so no Grok route can resolve `effort` to `null` and
// omit the flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const routerRelative = 'hooks/scripts/lib/model-router.mjs';
const routerUrl = pathToFileURL(path.join(root, routerRelative)).href;
const bridgeUrl = pathToFileURL(path.join(root, 'hooks/scripts/run-grok-reviewer.mjs')).href;
const registryUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/capability-registry.mjs')).href;
const taxonomyUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/target-taxonomy.mjs')).href;

const AUTHORIZED_MODEL = 'grok-4.6';
const DECLARED_EFFORTS = ['low', 'medium', 'high'];
// Every source that is not genuine `auto`. `cli-reviewer` and `cli-provider`
// satisfy `isExplicit`; `project-policy` and `user-policy` do not, which is
// precisely why keying the rule on `isExplicit` leaves half the surface open.
const NON_AUTO_SOURCES = ['cli-reviewer', 'cli-provider', 'project-policy', 'user-policy'];
const OUT_OF_BAND_EFFORTS = ['xhigh', 'max', 'minimal', 'not-an-effort-level'];

let capabilitiesPromise = null;

function grokCapabilities() {
  capabilitiesPromise ||= import(registryUrl).then(({ buildCapabilities }) => buildCapabilities({
    detected: {
      grok_cli: true,
      grok_cli_path: '/usr/local/bin/grok',
      grok_compatibility_verified: true,
      grok_version: 'grok 1.0.4 (d846eb93d94d) [stable]',
    },
    // This file's subject is Grok model/effort authorization, not containment.
    // `containment` defaults to the live host, so without an explicit pin the
    // capability would be unavailable on any host with no inventoried
    // containment helper and every case here would fail before reaching a
    // model or effort. The D21 uncontainable-host behaviour has its own
    // coverage in tests/grok-containment.test.js.
    containment: { platform: 'linux', arch: 'x64' },
  }));
  return capabilitiesPromise;
}

async function grokRequest(overrides = {}) {
  return {
    unit: { target_kind: 'code-change', path: 'src/app.ts', changed_lines: 40 },
    reviewer: { id: 'grok', provider: 'grok', role: 'standard', adapter_id: 'grok-cli' },
    risk: 'low',
    size: 'tiny',
    policy: { routing: { policy: 'auto' } },
    overrides: {
      protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false,
      providers: {}, reviewers: {},
    },
    capabilities: await grokCapabilities(),
    ...overrides,
  };
}

function applySource(input, source, pair) {
  if (source === 'cli-reviewer') input.overrides.reviewers[input.reviewer.id] = pair;
  else if (source === 'cli-provider') input.overrides.providers[input.reviewer.provider] = pair;
  else if (source === 'project-policy') input.policy.project = { providers: { grok: pair } };
  else if (source === 'user-policy') input.policy.user = { providers: { grok: pair } };
  else throw new Error(`unhandled source: ${source}`);
  return input;
}

// Each routing policy pins one MODEL_TIERS entry, so the P1 sweep covers the
// whole tier vocabulary rather than the one tier that happens to be reachable
// from the default matrix.
const TIER_SCENARIOS = {
  fast: { routing_policy: 'fast', risk: 'low' },
  balanced: { routing_policy: 'balanced', risk: 'low' },
  quality: { routing_policy: 'quality', risk: 'low' },
  maximum: { routing_policy: 'quality', risk: 'high' },
};

test('P1: every MODEL_TIERS value resolves to grok-4.6, never null', async () => {
  const { routeReviewer } = await import(routerUrl);
  const { MODEL_TIERS } = await import(taxonomyUrl);
  assert.deepEqual(Object.keys(TIER_SCENARIOS).sort(), [...MODEL_TIERS].sort());

  for (const [tier, scenario] of Object.entries(TIER_SCENARIOS)) {
    const input = await grokRequest({ risk: scenario.risk });
    input.overrides.routing_policy = scenario.routing_policy;
    const route = routeReviewer(input);
    assert.equal(route.requested.model_tier, tier);
    assert.equal(route.resolved.model, AUTHORIZED_MODEL, tier);
    assert.notEqual(route.resolved.model, null, tier);
    assert.notEqual(route.resolved.effort, null, tier);
  }
});

test('P1: a tier that resolves to no model throws ERROR_UNSUPPORTED_MODEL rather than omitting --model', async () => {
  const { routeReviewer } = await import(routerUrl);
  // The single-entry alias array is the exact shape D11 calls necessary but
  // insufficient: three of four tiers index past its end and today return
  // `{ model: null, source: 'provider-default' }`.
  const capabilities = (await grokCapabilities()).map((capability) => (
    capability.provider === 'grok'
      ? { ...capability, model_selection: { ...capability.model_selection, aliases: [AUTHORIZED_MODEL] } }
      : capability
  ));
  for (const tier of ['balanced', 'quality', 'maximum']) {
    const input = await grokRequest({ capabilities, risk: TIER_SCENARIOS[tier].risk });
    input.overrides.routing_policy = TIER_SCENARIOS[tier].routing_policy;
    assert.throws(() => routeReviewer(input), /ERROR_UNSUPPORTED_MODEL/, tier);
  }
});

test('P2: an explicit grok-4.5 throws ERROR_UNSUPPORTED_MODEL with and without --allow-fallback', async () => {
  const { routeReviewer } = await import(routerUrl);
  for (const source of ['cli-reviewer', 'cli-provider']) {
    for (const allowFallback of [false, true]) {
      const input = applySource(await grokRequest(), source, { model: 'grok-4.5' });
      input.overrides.allow_fallback = allowFallback;
      assert.throws(
        () => routeReviewer(input),
        /ERROR_UNSUPPORTED_MODEL/,
        `${source} allow_fallback=${allowFallback}`,
      );
    }
  }
});

test('P3: a project or user tier map naming grok-4.5 throws rather than resolving to null', async () => {
  const { routeReviewer } = await import(routerUrl);
  const layers = [['project', 'project-tier-map'], ['user', 'user-tier-map']];
  for (const [layer] of layers) {
    for (const allowFallback of [false, true]) {
      const input = await grokRequest();
      input.overrides.routing_policy = 'balanced';
      input.policy[layer] = { providers: { grok: { model_tiers: { balanced: 'grok-4.5' } } } };
      input.overrides.allow_fallback = allowFallback;
      assert.throws(
        () => routeReviewer(input),
        /ERROR_UNSUPPORTED_MODEL/,
        `${layer}-tier-map allow_fallback=${allowFallback}`,
      );
    }
  }
});

test('P6: a policy-sourced grok-4.5 throws rather than being substituted', async () => {
  const { routeReviewer } = await import(routerUrl);
  for (const source of ['project-policy', 'user-policy']) {
    for (const allowFallback of [false, true]) {
      const input = applySource(await grokRequest(), source, { model: 'grok-4.5' });
      input.overrides.allow_fallback = allowFallback;
      assert.throws(
        () => routeReviewer(input),
        /ERROR_UNSUPPORTED_MODEL/,
        `${source} allow_fallback=${allowFallback}`,
      );
    }
  }
});

test('the model rule is exact: every near-miss spelling is rejected from every source', async () => {
  const { routeReviewer } = await import(routerUrl);
  const nearMisses = ['grok-4.5', 'Grok-4.6', 'GROK-4.6', 'grok-4.6 ', ' grok-4.6', 'grok', '', 'grok-4.60'];
  for (const source of NON_AUTO_SOURCES) {
    for (const model of nearMisses) {
      for (const allowFallback of [false, true]) {
        const input = applySource(await grokRequest(), source, { model });
        input.overrides.allow_fallback = allowFallback;
        assert.throws(
          () => routeReviewer(input),
          /ERROR_UNSUPPORTED_MODEL/,
          `${source} model=${JSON.stringify(model)} allow_fallback=${allowFallback}`,
        );
      }
    }
  }
});

test('the authorized model is accepted from every source, so the rule is not a blanket refusal', async () => {
  const { routeReviewer } = await import(routerUrl);
  for (const source of NON_AUTO_SOURCES) {
    const input = applySource(await grokRequest(), source, { model: AUTHORIZED_MODEL });
    const route = routeReviewer(input);
    assert.equal(route.resolved.model, AUTHORIZED_MODEL, source);
    assert.notEqual(route.resolved.effort, null, source);
  }
});

// The two D11 gates must name the same model. A private router copy that
// drifted from the bridge would refuse every request: the router would
// accept only its own value and the argv assertion would accept only the
// bridge's. Equality in both directions is the lock that makes adding a
// second spelling fail, the same shape as the document-readiness oracle.
test('the router and the bridge authorize the same Grok model in both directions', async () => {
  const { GROK_AUTHORIZED_MODEL: fromBridge, assertAuthorizedGrokModel } = await import(bridgeUrl);
  const { routeReviewer, __testing } = await import(routerUrl);
  const fromRouter = __testing.GROK_AUTHORIZED_MODEL;

  assert.equal(fromRouter, fromBridge);
  assert.equal(fromBridge, fromRouter);

  const routed = routeReviewer(applySource(await grokRequest(), 'cli-reviewer', { model: fromBridge }));
  assert.equal(routed.resolved.model, fromBridge);
  assert.equal(assertAuthorizedGrokModel(routed.resolved.model), fromRouter);

  const automatic = routeReviewer(await grokRequest());
  assert.equal(assertAuthorizedGrokModel(automatic.resolved.model), fromBridge);
});

test('E1: every non-auto source rejects an out-of-band effort with and without --allow-fallback', async () => {
  const { routeReviewer } = await import(routerUrl);
  const cells = [];
  for (const source of NON_AUTO_SOURCES) {
    for (const effort of OUT_OF_BAND_EFFORTS) {
      for (const allowFallback of [false, true]) {
        const label = `${source}/${effort}/allow_fallback=${allowFallback}`;
        const input = applySource(await grokRequest(), source, { effort });
        input.overrides.allow_fallback = allowFallback;
        assert.throws(() => routeReviewer(input), /ERROR_UNSUPPORTED_EFFORT/, label);
        cells.push(label);
      }
    }
  }
  // One case per source × band × fallback, not one case per band.
  assert.equal(cells.length, NON_AUTO_SOURCES.length * OUT_OF_BAND_EFFORTS.length * 2);
});

test('E1: a declared effort from every non-auto source resolves unchanged', async () => {
  const { routeReviewer } = await import(routerUrl);
  for (const source of NON_AUTO_SOURCES) {
    for (const effort of DECLARED_EFFORTS) {
      const input = applySource(await grokRequest(), source, { effort });
      const route = routeReviewer(input);
      assert.equal(route.resolved.effort, effort, `${source}/${effort}`);
      assert.equal(route.resolved.model, AUTHORIZED_MODEL, `${source}/${effort}`);
    }
  }
});

test('E2: an automatic max or xhigh resolves to high', async () => {
  const { routeReviewer } = await import(routerUrl);
  // `quality` at high risk is the matrix path that requests `xhigh`
  // automatically; `tier_adjustment: +1` walks it up to `max`.
  const cases = [['xhigh', 0], ['max', 1]];
  for (const [expectedRequest, adjustment] of cases) {
    const input = await grokRequest({ risk: 'high' });
    input.overrides.routing_policy = 'quality';
    input.reviewer.tier_adjustment = adjustment;
    const route = routeReviewer(input);
    assert.equal(route.requested.effort, expectedRequest);
    assert.equal(route.requested.effort_source, 'auto');
    assert.equal(route.resolved.effort, 'high', expectedRequest);
  }
});

test('E2: an automatic effort below low is clamped up to low, never omitted', async () => {
  const { routeReviewer } = await import(routerUrl);
  const input = await grokRequest();
  input.overrides.routing_policy = 'fast';
  input.reviewer.tier_adjustment = -1;
  const route = routeReviewer(input);
  assert.equal(route.requested.effort, 'minimal');
  assert.equal(route.requested.effort_source, 'auto');
  assert.equal(route.resolved.effort, 'low');
  assert.notEqual(route.resolved.effort, null);
});

test('E2: a confirmation progress state at low risk still resolves to low', async () => {
  const { buildRoutingPlan } = await import(routerUrl);
  const plan = buildRoutingPlan({
    artifacts: [{ target_kind: 'generic-document', path: 'notes.md', byte_size: 512 }],
    reviewers: [{ id: 'grok', provider: 'grok', role: 'standard', adapter_id: 'grok-cli' }],
    policy: { routing: { policy: 'auto' } },
    overrides: {
      routing_policy: 'fast', allow_fallback: false, providers: {}, reviewers: {},
      required_providers: ['grok'],
    },
    capabilities: await grokCapabilities(),
    progress: { state: 'confirmation' },
  });
  assert.equal(plan.risk, 'low');
  const grokRoutes = plan.routes.filter((route) => route.provider === 'grok');
  assert.ok(grokRoutes.length > 0, 'the confirmation floor must plan the Grok voice');
  for (const route of grokRoutes) {
    assert.equal(route.requested.effort_source, 'auto');
    assert.equal(route.resolved.effort, 'low');
    assert.equal(route.resolved.model, AUTHORIZED_MODEL);
  }
});

test('E2: the automatic normalization is total for values the matrix cannot produce today', async () => {
  const { __testing } = await import(routerUrl);
  assert.ok(__testing?.normalizeAutomaticGrokEffort, 'the E2 table must be reachable for its unreachable rows');
  const { normalizeAutomaticGrokEffort } = __testing;
  assert.equal(normalizeAutomaticGrokEffort('max'), 'high');
  assert.equal(normalizeAutomaticGrokEffort('xhigh'), 'high');
  assert.equal(normalizeAutomaticGrokEffort('high'), 'high');
  assert.equal(normalizeAutomaticGrokEffort('medium'), 'medium');
  assert.equal(normalizeAutomaticGrokEffort('low'), 'low');
  assert.equal(normalizeAutomaticGrokEffort('minimal'), 'low');
  assert.equal(normalizeAutomaticGrokEffort(null), 'low');
  assert.equal(normalizeAutomaticGrokEffort(undefined), 'low');
  assert.equal(normalizeAutomaticGrokEffort('not-an-effort-level'), 'low');
  assert.equal(normalizeAutomaticGrokEffort('auto'), 'low');
});

test('no Grok route resolves effort to null, even when the adapter under-declares its levels', async () => {
  const { routeReviewer } = await import(routerUrl);
  const observed = [];
  const record = (input, label) => {
    const route = routeReviewer(input);
    assert.notEqual(route.resolved.effort, null, label);
    assert.ok(DECLARED_EFFORTS.includes(route.resolved.effort), `${label} -> ${route.resolved.effort}`);
    observed.push(label);
  };

  for (const [tier, scenario] of Object.entries(TIER_SCENARIOS)) {
    for (const adjustment of [-2, -1, 0, 1, 2]) {
      const input = await grokRequest({ risk: scenario.risk });
      input.overrides.routing_policy = scenario.routing_policy;
      input.reviewer.tier_adjustment = adjustment;
      record(input, `${tier}/adjustment=${adjustment}`);
    }
  }
  for (const source of NON_AUTO_SOURCES) {
    for (const effort of DECLARED_EFFORTS) {
      record(applySource(await grokRequest(), source, { effort }), `${source}/${effort}`);
    }
  }
  // A capability that declares no effort levels is a registry defect, not a
  // licence to omit the flag: the provider-scoped rule stays authoritative.
  const underDeclared = (await grokCapabilities()).map((capability) => (
    capability.provider === 'grok'
      ? { ...capability, effort_selection: { supported: true, levels: [], transport: 'flag:--reasoning-effort' } }
      : capability
  ));
  record(await grokRequest({ capabilities: underDeclared }), 'under-declared-levels');
  assert.equal(observed.length, 4 * 5 + NON_AUTO_SOURCES.length * DECLARED_EFFORTS.length + 1);
});

// ---------------------------------------------------------------------------
// The acceptance clause that is easiest to break: every non-Grok reviewer's
// routing must stay bit-identical to the pre-SLICE-005 baseline, including the
// `minimal -> null` behaviour other providers rely on. This is proved by
// replaying a cross-product against the baseline module — loaded from the
// pinned commit rather than from HEAD, so the proof does not go vacuous once
// this slice is committed — and diffing key by key.
// ---------------------------------------------------------------------------

const BASELINE_COMMIT = 'c54f701a1022e2bfd162e2466af68330fe19afd8';

function baselineRouterSource() {
  return execFileSync('git', ['show', `${BASELINE_COMMIT}:${routerRelative}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
}

// A data: URL has no base to resolve relative specifiers against, so the
// baseline module's sibling imports are rewritten to absolute file URLs. Those
// siblings are shared with the working tree by design: this diff isolates
// model-router.mjs.
function moduleFromSource(source) {
  const libDir = path.dirname(path.join(root, routerRelative));
  const rewritten = source.replace(
    /from '\.\/([^']+)'/gu,
    (_match, name) => `from '${pathToFileURL(path.join(libDir, name)).href}'`,
  );
  return `data:text/javascript;base64,${Buffer.from(rewritten, 'utf8').toString('base64')}`;
}

const NON_GROK_REVIEWERS = [
  { id: 'claude-agent', provider: 'claude', adapter_id: 'claude-native-agent' },
  { id: 'claude-opus', provider: 'claude', adapter_id: 'claude-cli' },
  { id: 'codex-exec', provider: 'codex', adapter_id: 'codex-exec' },
  { id: 'codex-native', provider: 'codex', adapter_id: 'codex-native-generic' },
  { id: 'codex-companion', provider: 'codex', adapter_id: 'codex-companion' },
  { id: 'agy-reviewer', provider: 'agy', adapter_id: 'agy-cli' },
];
const NON_GROK_SCENARIOS = [
  ['code-change', 'low', 'tiny'],
  ['code-change', 'critical', 'large'],
  ['design-document', 'high', 'medium'],
  ['implementation-plan', 'medium', 'large'],
  ['generic-document', 'low', 'small'],
];
const NON_GROK_ROLES = ['standard', 'adversarial', 'classifier'];
const NON_GROK_SOURCES = [
  'auto', 'cli-reviewer', 'cli-provider', 'project-policy', 'user-policy',
  'project-tier-map', 'user-tier-map',
];
const NON_GROK_EFFORTS = [undefined, 'minimal', 'low', 'high', 'xhigh', 'max', 'none', 'not-an-effort-level'];
const NON_GROK_MODELS = [undefined, 'opus', 'grok-4.6', 'grok-4.5', 'not-a-model'];
const NON_GROK_POLICIES = ['auto', 'fast', 'balanced', 'quality'];

// Fixed capability literals rather than the live registry: this comparison is
// about model-router.mjs and must not move when an adapter's declaration does.
function nonGrokCapabilities() {
  const base = (adapterId, provider, modelSelection, effortSelection, readOnly) => ({
    protocol_version: '2.0', adapter_id: adapterId, provider, available: true,
    roles: ['classifier', 'standard', 'adversarial', 'traceability', 'synthesizer'],
    assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
    read_only_enforcement: readOnly,
    model_selection: modelSelection, effort_selection: effortSelection,
  });
  return [
    base('claude-native-agent', 'claude',
      { supported: true, aliases: ['haiku', 'sonnet', 'opus', 'best'], catalog_complete: false, transport: 'agent-parameter' },
      { supported: false, levels: [], transport: 'none' }, 'agent-tool-allowlist'),
    base('claude-cli', 'claude',
      { supported: true, aliases: ['haiku', 'sonnet', 'opus', 'best'], catalog_complete: false, transport: 'flag:--model' },
      { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' }, 'process-contract'),
    base('codex-exec', 'codex',
      { supported: true, aliases: [], catalog_complete: false, transport: 'flag:--model' },
      { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], transport: 'config:model_reasoning_effort' }, 'process-contract'),
    base('codex-native-generic', 'codex',
      { supported: true, aliases: [], catalog_complete: false, transport: 'agent-parameter:model' },
      { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], transport: 'agent-parameter:reasoning_effort' }, 'agent-tool-allowlist'),
    base('codex-companion', 'codex',
      { supported: false, aliases: [], catalog_complete: false, transport: 'none' },
      { supported: false, levels: [], transport: 'none' }, 'companion-read-only'),
    base('agy-cli', 'agy',
      { supported: true, aliases: [], catalog_complete: false, transport: 'config:agy_model' },
      { supported: false, levels: [], transport: 'none' }, 'privacy-preflight'),
  ];
}

function stableStringify(value) {
  return JSON.stringify(value, (key, entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((name) => [name, entry[name]]))
      : entry
  ));
}

function nonGrokInput(capabilities, reviewer, scenario, role, source, effort, model, allowFallback, routingPolicy) {
  const [targetKind, risk, size] = scenario;
  const policy = { routing: { policy: 'auto' } };
  const overrides = {
    protocol_version: '2.0', routing_policy: routingPolicy, allow_fallback: allowFallback,
    providers: {}, reviewers: {},
  };
  const pair = {};
  if (model !== undefined) pair.model = model;
  if (effort !== undefined) pair.effort = effort;
  const tiers = { model_tiers: { fast: model, balanced: model, quality: model, maximum: model } };
  if (Object.keys(pair).length > 0) {
    if (source === 'cli-reviewer') overrides.reviewers[reviewer.id] = pair;
    else if (source === 'cli-provider') overrides.providers[reviewer.provider] = pair;
    else if (source === 'project-policy') policy.project = { providers: { [reviewer.provider]: pair } };
    else if (source === 'user-policy') policy.user = { providers: { [reviewer.provider]: pair } };
    else if (source === 'project-tier-map') policy.project = { providers: { [reviewer.provider]: tiers } };
    else if (source === 'user-tier-map') policy.user = { providers: { [reviewer.provider]: tiers } };
  }
  return {
    unit: { target_kind: targetKind, path: 'docs/artifact.md', byte_size: 20_000 },
    reviewer: { ...reviewer, role }, risk, size, policy, overrides, capabilities,
  };
}

const NON_GROK_PLAN_ARTIFACTS = [
  [{ target_kind: 'code-change', path: 'src/auth/session.ts', changed_lines: 900, diff: '+ authentication' }],
  [{ target_kind: 'design-document', path: 'docs/design.md', byte_size: 120 * 1024 }],
  [{ target_kind: 'implementation-plan', path: 'docs/plan.md', byte_size: 5 * 1024 }],
  [{ target_kind: 'generic-document', path: 'README.md', byte_size: 900 }],
];
const NON_GROK_PROGRESS = [undefined, { state: 'confirmation' }, { state: 'exploration' }, { state: 'convergence' }];

function captureNonGrokRoutes(routerModule) {
  const capabilities = nonGrokCapabilities();
  const captured = new Map();
  for (const reviewer of NON_GROK_REVIEWERS) {
    for (const scenario of NON_GROK_SCENARIOS) {
      for (const role of NON_GROK_ROLES) {
        for (const source of NON_GROK_SOURCES) {
          for (const effort of NON_GROK_EFFORTS) {
            for (const model of NON_GROK_MODELS) {
              for (const allowFallback of [false, true]) {
                for (const routingPolicy of NON_GROK_POLICIES) {
                  if (source === 'auto' && (effort !== undefined || model !== undefined)) continue;
                  const tierMap = source === 'project-tier-map' || source === 'user-tier-map';
                  if (tierMap && (effort !== undefined || model === undefined)) continue;
                  const key = [
                    reviewer.id, ...scenario, role, source,
                    String(effort), String(model), allowFallback, routingPolicy,
                  ].join('|');
                  let value;
                  try {
                    value = `OK ${stableStringify(routerModule.routeReviewer(nonGrokInput(
                      capabilities, reviewer, scenario, role, source, effort, model, allowFallback, routingPolicy,
                    )))}`;
                  } catch (error) {
                    value = `THROW ${error.message}`;
                  }
                  captured.set(key, value);
                }
              }
            }
          }
        }
      }
    }
  }
  for (const artifacts of NON_GROK_PLAN_ARTIFACTS) {
    for (const progress of NON_GROK_PROGRESS) {
      for (const allowFallback of [false, true]) {
        for (const routingPolicy of NON_GROK_POLICIES) {
          const key = ['PLAN', artifacts[0].target_kind, JSON.stringify(progress ?? null), allowFallback, routingPolicy].join('|');
          let value;
          try {
            value = `OK ${stableStringify(routerModule.buildRoutingPlan({
              artifacts,
              reviewers: NON_GROK_REVIEWERS.map((reviewer) => ({ ...reviewer, role: 'standard' })),
              policy: { routing: { policy: 'auto' } },
              overrides: { allow_fallback: allowFallback, routing_policy: routingPolicy, providers: {}, reviewers: {} },
              capabilities, progress,
            }))}`;
          } catch (error) {
            value = `THROW ${error.message}`;
          }
          captured.set(key, value);
        }
      }
    }
  }
  return captured;
}

function differingKeys(baseline, candidate) {
  const keys = new Set([...baseline.keys(), ...candidate.keys()]);
  return [...keys].filter((key) => baseline.get(key) !== candidate.get(key));
}

test('non-Grok routing is bit-identical to the pre-SLICE-005 baseline', async () => {
  const baselineModule = await import(moduleFromSource(baselineRouterSource()));
  const workingModule = await import(routerUrl);
  const baseline = captureNonGrokRoutes(baselineModule);
  const working = captureNonGrokRoutes(workingModule);
  // Pinned so the cross-product cannot silently shrink into a passing subset.
  assert.equal(baseline.size, 121_808);
  assert.equal(working.size, 121_808);
  assert.deepEqual(differingKeys(baseline, working), []);
});

test('the bit-identity comparison is not vacuous', async () => {
  // Positive control: a mutation of the baseline source must be observed. A
  // comparison that reports zero differences for a changed router is proving
  // nothing, and this is the check that says so.
  const mutated = baselineRouterSource().replace(
    "if (routingPolicy === 'fast')",
    "if (routingPolicy === 'no-such-policy')",
  );
  assert.notEqual(mutated, baselineRouterSource(), 'the control anchor must exist');
  const baseline = captureNonGrokRoutes(await import(moduleFromSource(baselineRouterSource())));
  const control = captureNonGrokRoutes(await import(moduleFromSource(mutated)));
  assert.ok(differingKeys(baseline, control).length > 0, 'the control mutation must be observed');
});

test('the minimal -> null behaviour other providers rely on is preserved', async () => {
  const { routeReviewer } = await import(routerUrl);
  const capabilities = nonGrokCapabilities();
  // claude-cli declares no `minimal` level; an automatic walk below `low` finds
  // nothing beneath it and omits the flag. Grok's E2 clamp must not reach here.
  const input = nonGrokInput(
    capabilities, NON_GROK_REVIEWERS[1], ['code-change', 'low', 'tiny'], 'standard',
    'cli-provider', 'minimal', undefined, true, 'auto',
  );
  const route = routeReviewer(input);
  assert.equal(route.resolved.effort, null);
  assert.equal(route.fallback.occurred, true);
});
