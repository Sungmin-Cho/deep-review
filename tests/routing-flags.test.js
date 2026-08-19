'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const routeUrl = pathToFileURL(path.join(root, 'hooks/scripts/public-route.mjs')).href;
const classifyUrl = pathToFileURL(path.join(root, 'hooks/scripts/classify-artifacts.mjs')).href;
const planUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/execution-plan.mjs')).href;

test('review routing flags normalize repeated provider and canonical reviewer overrides', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const result = parsePublicRoute({
    entry: 'review', host: 'claude', cwd: root,
    argv: [
      '--routing', 'quality', '--model', 'claude=vendor=model=v2', '--effort', 'claude=high',
      '--model', 'agy=agy-pro', '--reviewer-model', 'claude-opus=best',
      '--reviewer-effort', 'codex-review=xhigh', '--reviewer-effort', 'codex-adversarial=max',
      '--reviewer-model', 'agy=agy-fast', '--allow-fallback', '--allow-classifier',
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.overrides, {
    protocol_version: '2.0',
    routing_policy: 'quality',
    allow_fallback: true,
    allow_classifier: true,
    providers: {
      claude: { model: 'vendor=model=v2', effort: 'high' },
      agy: { model: 'agy-pro' },
    },
    reviewers: {
      'claude-opus': { model: 'best' },
      'codex-review': { effort: 'xhigh' },
      'codex-adversarial': { effort: 'max' },
      agy: { model: 'agy-fast' },
    },
    required_reviewers: ['agy', 'claude-opus', 'codex-adversarial', 'codex-review'],
    enabled_providers: ['agy'],
  });
});

test('explicit --no-fallback overrides permissive policy and conflicts with --allow-fallback', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const parse = (entry, argv) => parsePublicRoute({ entry, host: 'codex', cwd: root, argv });
  const review = parse('review', ['--no-fallback']);
  assert.equal(review.ok, true);
  assert.equal(review.overrides.allow_fallback, false);
  const loop = parse('loop', ['--no-fallback', '--max=2']);
  assert.equal(loop.ok, true);
  assert.equal(loop.overrides.allow_fallback, false);
  assert.equal(parse('review', ['--allow-fallback', '--no-fallback']).ok, false);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-no-fallback-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files,
      '--overrides-json', JSON.stringify(review.overrides), '--emit-routing-plan'],
    {},
    {
      capabilities: routingTestCapabilities(), reviewers: routingTestReviewers,
      projectPolicy: { routing: { allow_fallback: true } },
    },
  );
  assert.ok(result.routing_plan.routes.length > 0);
  assert.equal(result.routing_plan.routes.every((route) => route.fallback?.allowed === false), true);
});

test('explicit --no-fallback stays applicable when automatic routing is disabled or shadow-only', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const { parseExecutionRouteJson } = await import(planUrl);
  const publicRoute = parsePublicRoute({
    entry: 'review', host: 'codex', cwd: root, argv: ['--no-fallback'],
  });
  assert.equal(publicRoute.ok, true);

  for (const [label, features] of [
    ['automatic-disabled', { automatic_model_routing: false }],
    ['shadow-only', { routing_shadow_mode: true }],
  ]) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `deep-review-no-fallback-${label}-`));
    fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
    const files = path.join(repo, 'targets.z');
    fs.writeFileSync(files, 'notes.md\0');
    const result = await runClassifyArtifactsCli(
      ['--repo', repo, '--change-state', 'non-git', '--files-from0', files,
        '--overrides-json', JSON.stringify(publicRoute.overrides), '--emit-routing-plan'],
      {},
      {
        capabilities: routingTestCapabilities(), reviewers: routingTestReviewers,
        projectPolicy: { features, routing: { allow_fallback: true } },
      },
    );
    assert.equal(result.routing_plan.apply_automatic, false, label);
    assert.equal(result.routing_plan.explicit_overrides, true, label);
    const route = result.routing_plan.routes[0];
    assert.equal(route.fallback.allowed, false, label);
    const leaf = parseExecutionRouteJson(JSON.stringify({
      protocol_version: result.routing_plan.protocol_version,
      ...route,
    }), route.reviewer_id);
    assert.equal(leaf.allowFallback, false, label);
    assert.equal(leaf.routingFallback.occurred, false, label);
  }
});

test('routing flags reject duplicates, unknown keys, and codex-only conflicts', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const parse = (argv) => parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv });
  assert.match(parse(['--model', 'claude=a', '--model', 'claude=b']).error, /duplicate/i);
  assert.match(parse(['--model', 'other=a']).error, /unknown provider/i);
  assert.match(parse(['--reviewer-model', 'claude-unknown=a']).error, /unknown reviewer/i);
  assert.match(parse(['--reviewer-model', 'claude-adversarial=a']).error, /unknown reviewer/i);
  assert.match(parse(['--codex-only', '--model', 'claude=a']).error, /ERROR_CONFLICTING_REVIEWER_SELECTION/);
  assert.equal(parse(['--routing', 'turbo']).ok, false);
});

// F9: a reviewer-level override whose reviewer maps to a provider disabled by
// --no-opus/--no-codex/--no-agy (including --codex-only expansion) must be
// rejected with the same conflict error as the provider-level checks.
test('F9: reviewer-level overrides conflicting with a disabled provider are rejected', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const parse = (argv) => parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv });
  assert.equal(parse(['--codex-only', '--reviewer-model', 'claude-opus=opus']).ok, false);
  assert.match(parse(['--codex-only', '--reviewer-model', 'claude-opus=opus']).error, /ERROR_CONFLICTING_REVIEWER_SELECTION/);
  assert.equal(parse(['--no-codex', '--reviewer-effort', 'codex-adversarial=high']).ok, false);
  assert.match(parse(['--no-codex', '--reviewer-effort', 'codex-adversarial=high']).error, /ERROR_CONFLICTING_REVIEWER_SELECTION/);
  assert.equal(parse(['--no-agy', '--reviewer-model', 'claude-opus=opus']).ok, true);
});

test('loop grammar accepts and transports review routing flags on every round', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const result = parsePublicRoute({
    entry: 'loop',
    host: 'claude',
    cwd: process.cwd(),
    argv: [
      '--max=3',
      '--routing', 'quality',
      '--reviewer-strategy', 'static',
      '--model', 'claude=opus',
      '--effort', 'codex=xhigh',
      '--reviewer-model', 'agy=gemini',
      '--reviewer-effort', 'codex-review=high',
      '--allow-fallback',
      '--allow-classifier',
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.overrides.routing_policy, 'quality');
  assert.equal(result.overrides.reviewer_strategy, 'static');
  assert.equal(result.overrides.providers.claude.model, 'opus');
  assert.equal(result.overrides.providers.codex.effort, 'xhigh');
  assert.equal(result.overrides.reviewers.agy.model, 'gemini');
  assert.equal(result.overrides.reviewers['codex-review'].effort, 'high');
  assert.equal(result.overrides.allow_fallback, true);
  assert.equal(result.overrides.allow_classifier, true);
  assert.equal(result.max, 3);
  assert.equal(result.maxExplicit, true);
});

test('loop grammar preserves literal codex-only provenance after expansion', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const result = parsePublicRoute({
    entry: 'loop',
    host: 'codex',
    cwd: root,
    argv: ['--codex-only', '--reviewer-strategy', 'static', '--max=3'],
  });
  assert.equal(result.ok, true);
  assert.equal(result.overrides.codex_only, true);
  // D5: --codex-only expands to include --no-grok, so grok joins the closed
  // disabled_providers expectation.
  assert.deepEqual(result.overrides.disabled_providers, ['agy', 'claude', 'grok']);
});

test('reviewer strategy and readiness receipt are validated without ambiguous duplicates', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-readiness-route-'));
  const receipt = path.join(repo, 'receipt.json');
  fs.writeFileSync(receipt, '{}');

  const adaptive = parsePublicRoute({
    entry: 'review', host: 'codex', cwd: repo,
    argv: ['--reviewer-strategy', 'adaptive', '--readiness-receipt', receipt],
  });
  assert.equal(adaptive.ok, true);
  assert.equal(adaptive.overrides.reviewer_strategy, 'adaptive');
  assert.equal(adaptive.readinessReceipt, receipt);

  for (const argv of [
    ['--reviewer-strategy', 'adaptive', '--reviewer-strategy', 'static'],
    ['--routing', 'fast', '--routing', 'quality'],
    ['--readiness-receipt', receipt, '--readiness-receipt', receipt],
    ['--reviewer-strategy', 'random'],
    ['--readiness-receipt', path.join(repo, 'missing.json')],
  ]) {
    const result = parsePublicRoute({ entry: 'review', host: 'codex', cwd: repo, argv });
    assert.equal(result.ok, false, argv.join(' '));
  }
});

test('classify CLI override parser round-trips normalized schema and rejects malformed input', async () => {
  const { parseArguments } = await import(classifyUrl);
  const overrides = {
    protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false,
    allow_classifier: false, providers: {}, reviewers: {},
  };
  assert.deepEqual(parseArguments(['--overrides-json', JSON.stringify(overrides)]).overrides, overrides);
  assert.throws(() => parseArguments(['--overrides-json', '{']), /overrides-json.*JSON/i);
  assert.throws(() => parseArguments(['--overrides-json', '{}']), /protocol_version/i);
});

// I4: --host-assertions-json is the only transport for native host tool
// assertions into the classify-artifacts.mjs subprocess. Validation happens
// inside runClassifyArtifactsCli (not parseArguments), so these assertions
// exercise the full async CLI entry point with a runtime.capabilities short
// circuit to avoid any real environment detection.
test('classify CLI --host-assertions-json rejects malformed JSON, non-object values, unknown keys, and non-boolean values', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-host-assertions-invalid-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const runtime = {
    capabilities: [{
      protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
      roles: ['standard'],
      model_selection: { supported: true, aliases: ['steady'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: { supported: true, levels: ['low', 'medium'], transport: 'flag:--effort' },
      structured_output: true, read_only_enforcement: 'process-contract',
    }],
    reviewers: [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }],
  };
  const run = (hostAssertionsJson) => runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--host-assertions-json', hostAssertionsJson],
    {},
    runtime,
  );
  await assert.rejects(run('{'), /--host-assertions-json must contain valid JSON/);
  await assert.rejects(run('null'), /claudeNativeAgent\/codexExecReviewer\/codexNativeGeneric/);
  await assert.rejects(run('[]'), /claudeNativeAgent\/codexExecReviewer\/codexNativeGeneric/);
  await assert.rejects(run('"x"'), /claudeNativeAgent\/codexExecReviewer\/codexNativeGeneric/);
  await assert.rejects(run('{"unknownKey":true}'), /claudeNativeAgent\/codexExecReviewer\/codexNativeGeneric/);
  await assert.rejects(run('{"codexExecReviewer":"yes"}'), /claudeNativeAgent\/codexExecReviewer\/codexNativeGeneric/);
});

test('public skill forwards normalized routing overrides as one compact JSON argv value', () => {
  const skill = fs.readFileSync(path.join(root, 'skills/deep-review/SKILL.md'), 'utf8');
  assert.match(skill, /--overrides-json/);
  assert.match(skill, /JSON\.stringify\(route\.overrides\)/);
  assert.match(skill, /single argv\s+value|single argument/i);
});

// ---------------------------------------------------------------------------
// F5: an explicit non-default --routing policy must become an applicable
// execution override; a policy-file-only routing policy (or --routing auto)
// must not.
// ---------------------------------------------------------------------------

function routingTestCapabilities() {
  return [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard'],
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  }];
}

const routingTestReviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];

test('F5: an explicit CLI --routing quality marks the plan explicit and upgrades the resolved tier', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-f5-cli-routing-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--routing', 'quality'] });
  assert.equal(route.ok, true);
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    { capabilities: routingTestCapabilities(), reviewers: routingTestReviewers },
  );
  assert.equal(result.routing_plan.explicit_overrides, true);
  const [firstRoute] = result.routing_plan.routes;
  assert.ok(
    ['quality', 'maximum'].includes(firstRoute.requested.model_tier) || /quality|maximum/.test(firstRoute.route_explanation),
    'quality routing policy must upgrade the resolved tier',
  );
});

test('F5: a policy-file-only routing policy and --routing auto stay non-explicit', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-f5-policy-routing-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const policyOnly = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
    {},
    {
      capabilities: routingTestCapabilities(), reviewers: routingTestReviewers,
      projectPolicy: { routing: { policy: 'quality' } },
    },
  );
  assert.equal(policyOnly.routing_plan.explicit_overrides, false);

  const { parsePublicRoute } = await import(routeUrl);
  const autoRoute = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--routing', 'auto'] });
  assert.equal(autoRoute.ok, true);
  const autoResult = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(autoRoute.overrides), '--emit-routing-plan'],
    {},
    { capabilities: routingTestCapabilities(), reviewers: routingTestReviewers },
  );
  assert.equal(autoResult.routing_plan.explicit_overrides, false);
});

// ---------------------------------------------------------------------------
// G2: --no-opus/--no-codex/--no-agy (and --codex-only's expansion) must
// transport disabled providers to the preflight and exclude their reviewers
// from eligibility checks and the emitted routing plan.
// ---------------------------------------------------------------------------

function g2Capabilities() {
  return [
    {
      protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true, roles: ['standard'],
      model_selection: { supported: true, aliases: ['steady'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: { supported: true, levels: ['low', 'medium'], transport: 'flag:--effort' },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
    {
      protocol_version: '2.0', adapter_id: 'codex-exec', provider: 'codex', available: true, roles: ['standard', 'adversarial'],
      assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
      model_selection: { supported: true, aliases: ['fast'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], transport: 'config:model_reasoning_effort' },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
    {
      protocol_version: '2.0', adapter_id: 'agy-cli', provider: 'agy', available: true, roles: ['standard'],
      model_selection: { supported: true, aliases: ['a'], catalog_complete: false, transport: 'config:agy_model' },
      effort_selection: { supported: false, levels: [], transport: 'none' },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
  ];
}

const g2Reviewers = [
  { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' },
  { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-exec' },
  { id: 'codex-adversarial', provider: 'codex', role: 'adversarial', adapter_id: 'codex-exec' },
  { id: 'agy', provider: 'agy', role: 'standard', adapter_id: 'agy-cli' },
];

test('G2: --no-codex emits disabled_providers and excludes codex routes from the plan', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv: ['--no-codex'] });
  assert.equal(route.ok, true);
  assert.deepEqual(route.overrides.disabled_providers, ['codex']);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-g2-no-codex-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    { capabilities: g2Capabilities(), reviewers: g2Reviewers },
  );
  assert.deepEqual(result.routing_plan.routes.map((r) => r.reviewer_id).sort(), ['agy', 'claude-opus']);
  assert.equal(result.routing_plan.routes.some((r) => r.provider === 'codex'), false, 'no codex route must be emitted when --no-codex disables it');
});

test('G2: literal --codex-only preserves canonical provenance and yields both Codex routes', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const route = parsePublicRoute({
    entry: 'review',
    host: 'claude',
    cwd: root,
    argv: ['--codex-only', '--reviewer-strategy', 'static'],
  });
  assert.equal(route.ok, true);
  assert.equal(route.overrides.codex_only, true);
  // D5: --codex-only expands to include --no-grok, so grok joins the closed
  // disabled_providers expectation.
  assert.deepEqual(route.overrides.disabled_providers, ['agy', 'claude', 'grok']);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-g2-codex-only-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    { capabilities: g2Capabilities(), reviewers: g2Reviewers },
  );
  assert.equal(result.routing_plan.codex_only, true);
  assert.deepEqual(
    result.routing_plan.routes.map((r) => r.reviewer_id),
    ['codex-review', 'codex-adversarial'],
    'both canonical Codex reviewers must remain routable under --codex-only',
  );
  assert.equal(result.routing_plan.provider_family_minimum, 1);
  assert.equal(result.routing_plan.confidence_floor, null);
});

test('G2: no flags use adaptive defaults while explicit static + shadow preserves every eligible reviewer', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv: [] });
  assert.equal(route.ok, true);
  assert.equal(route.overrides, undefined);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-g2-no-flags-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
    {},
    { capabilities: g2Capabilities(), reviewers: g2Reviewers },
  );
  assert.deepEqual(result.routing_plan.routes.map((r) => r.reviewer_id).sort(), ['claude-opus', 'codex-review']);
  assert.deepEqual(
    result.routing_plan.candidate_reviewers.map((r) => r.reviewer_id).sort(),
    ['agy', 'claude-opus', 'codex-adversarial', 'codex-review'],
  );
  assert.equal(result.routing_plan.shadow_mode, false);

  const staticRoute = parsePublicRoute({
    entry: 'review', host: 'claude', cwd: root,
    argv: ['--reviewer-strategy', 'static'],
  });
  const staticResult = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(staticRoute.overrides), '--emit-routing-plan'],
    {},
    {
      capabilities: g2Capabilities(),
      reviewers: g2Reviewers,
      projectPolicy: { features: { routing_shadow_mode: true } },
    },
  );
  assert.deepEqual(staticResult.routing_plan.routes.map((r) => r.reviewer_id).sort(), ['agy', 'claude-opus', 'codex-adversarial', 'codex-review']);
  assert.equal(staticResult.routing_plan.shadow_mode, true);
});

// ---------------------------------------------------------------------------
// J3: an explicit effort override that targets the claude provider (or the
// claude-opus reviewer) cannot be transported by claude-native-agent
// (effort_selection.supported is always false there); when the Claude CLI
// adapter is available AND can transport the requested effort, claude-opus
// must be bound to it instead of the native agent. Absent an explicit effort
// request, native-first precedence stays byte-identical. These tests omit
// `reviewers` from the runtime stub so defaultReviewers() itself is exercised.
// ---------------------------------------------------------------------------

function j3Capabilities({ claudeCliEffortSupported = true } = {}) {
  return [
    {
      protocol_version: '2.0', adapter_id: 'claude-native-agent', provider: 'claude', available: true,
      roles: ['standard'],
      model_selection: { supported: true, aliases: ['haiku', 'sonnet', 'opus', 'best'], catalog_complete: false, transport: 'agent-parameter' },
      effort_selection: { supported: false, levels: [], transport: 'none' },
      structured_output: true, read_only_enforcement: 'agent-tool-allowlist',
    },
    {
      protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
      roles: ['standard'],
      model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: {
        supported: claudeCliEffortSupported,
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        transport: 'flag:--effort',
      },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
  ];
}

test('J3: an explicit claude effort override binds claude-opus to claude-cli when the native agent cannot transport it', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-j3-effort-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--effort', 'claude=high'] });
  assert.equal(route.ok, true);

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    { capabilities: j3Capabilities() },
  );
  const claudeRoute = result.routing_plan.routes.find((r) => r.reviewer_id === 'claude-opus');
  assert.ok(claudeRoute, 'claude-opus route must exist');
  assert.equal(claudeRoute.adapter_id, 'claude-cli', 'an explicit supported effort must bind claude-opus to the transport-capable CLI adapter');
  assert.equal(claudeRoute.resolved.effort, 'high');
});

test('J3: with no explicit effort override, claude-opus stays on the native agent (byte-identical precedence)', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-j3-no-effort-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
    {},
    { capabilities: j3Capabilities() },
  );
  const claudeRoute = result.routing_plan.routes.find((r) => r.reviewer_id === 'claude-opus');
  assert.ok(claudeRoute, 'claude-opus route must exist');
  assert.equal(claudeRoute.adapter_id, 'claude-native-agent', 'absent an explicit effort request, native-first precedence must stay unchanged');
});

test('J3: an explicit claude effort override keeps claude-native-agent (and surfaces the honest transport error) when the CLI adapter cannot transport effort either', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-j3-unsupported-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--effort', 'claude=high'] });
  assert.equal(route.ok, true);

  await assert.rejects(
    runClassifyArtifactsCli(
      ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
      {},
      { capabilities: j3Capabilities({ claudeCliEffortSupported: false }) },
    ),
    /ERROR_UNSUPPORTED_EFFORT|ERROR_EFFORT_TRANSPORT_UNAVAILABLE/,
    'when neither claude adapter can transport the explicit effort, the router must surface the honest error rather than silently succeeding',
  );
});

// agy opt-in: these cases deliberately omit the `reviewers` injection so the
// real defaultReviewers() gate runs instead of a pre-built candidate list.
async function agyPlan(argv) {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv });
  assert.equal(route.ok, true, `route must parse: ${JSON.stringify(route.error)}`);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-agy-optin-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan',
      ...(route.overrides ? ['--overrides-json', JSON.stringify(route.overrides)] : [])],
    {},
    { capabilities: g2Capabilities() },
  );
  return { route, plan: result.routing_plan };
}

test('agy opt-in: a detected agy-cli is not a candidate without an explicit argv signal', async () => {
  const { plan } = await agyPlan([]);
  assert.equal(
    plan.candidate_reviewers.some((c) => c.reviewer_id === 'agy'), false,
    'capability detection alone must never elect agy',
  );
  assert.equal(plan.routes.some((r) => r.reviewer_id === 'agy'), false);
});

test('agy opt-in: --agy restores candidacy AND wins a wave-1 route as a required provider', async () => {
  const { route, plan } = await agyPlan(['--agy']);
  assert.deepEqual(route.overrides.enabled_providers, ['agy']);
  assert.deepEqual(route.overrides.required_providers, ['agy']);
  const agyRoute = plan.routes.find((r) => r.reviewer_id === 'agy' && r.wave === 1);
  assert.ok(agyRoute, 'candidacy alone never wins a planner slot; --agy must also require selection');
  assert.equal(agyRoute.required, true);
  assert.ok(plan.required_reviewer_ids.includes('agy'));
});

test('agy opt-in: a pre-existing agy override restores candidacy without forcing selection', async () => {
  const { route, plan } = await agyPlan(['--model', 'agy=agy-pro']);
  assert.deepEqual(route.overrides.enabled_providers, ['agy']);
  assert.equal(route.overrides.required_providers, undefined,
    'a provider-level override must not become a hard required constraint');
  assert.equal(
    plan.routes.some((r) => r.reviewer_id === 'agy' && r.required === true), false,
    'declining agy privacy must not be able to void the whole verdict',
  );
});

test('agy opt-in: --agy conflicts with --no-agy and with --codex-only', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  for (const argv of [['--agy', '--no-agy'], ['--codex-only', '--agy']]) {
    const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv });
    assert.equal(route.ok, false, `${argv.join(' ')} must be rejected`);
    assert.match(route.error, /--agy cannot be combined with --no-agy/);
  }
});

test('agy opt-in: enabled_providers is schema-validated like disabled_providers', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-agy-schema-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  for (const bad of ['agy', ['agy', 'agy'], ['nope']]) {
    await assert.rejects(
      () => runClassifyArtifactsCli(
        ['--repo', repo, '--change-state', 'non-git', '--files-from0', files,
          '--overrides-json', JSON.stringify({
            protocol_version: '2.0',
            routing_policy: 'auto',
            allow_fallback: false,
            allow_classifier: false,
            providers: {},
            reviewers: {},
            enabled_providers: bad,
          })],
        {},
        { capabilities: g2Capabilities() },
      ),
      /enabled_providers must be a unique array/,
    );
  }
});

// DOC-2: agy leaving the default candidate set silently degrades two
// pre-existing selector combinations. Pin both so the migration is a contract,
// not a surprise.
test('agy opt-in: --no-opus collapses to a single provider family unless --agy is added', async () => {
  const withoutAgy = await agyPlan(['--no-opus']);
  const families = new Set(withoutAgy.plan.routes.map((r) => r.provider));
  assert.equal(families.has('agy'), false, 'agy must not be elected without an explicit signal');
  assert.deepEqual([...families], ['codex'], '--no-opus now yields codex-only routes');

  const withAgy = await agyPlan(['--no-opus', '--agy']);
  assert.equal(
    withAgy.plan.routes.some((r) => r.reviewer_id === 'agy'), true,
    '--agy restores the second provider family for --no-opus',
  );
});

test('agy opt-in: --no-opus --no-codex has no candidate left unless --agy is added', async () => {
  const withoutAgy = await agyPlan(['--no-opus', '--no-codex']);
  assert.deepEqual(withoutAgy.plan.candidate_reviewers, [],
    'the former "1-way (agy only)" mode has no candidate without --agy');
  assert.deepEqual(withoutAgy.plan.routes, []);

  const withAgy = await agyPlan(['--no-opus', '--no-codex', '--agy']);
  assert.deepEqual(withAgy.plan.routes.map((r) => r.reviewer_id), ['agy'],
    '--agy restores the documented agy-only mode');
});
