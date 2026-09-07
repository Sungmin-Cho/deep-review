'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const classifyUrl = pathToFileURL(path.join(root, 'hooks/scripts/classify-artifacts.mjs')).href;
const routeUrl = pathToFileURL(path.join(root, 'hooks/scripts/public-route.mjs')).href;
const claudeUrl = pathToFileURL(path.join(root, 'hooks/scripts/run-claude-reviewer.mjs')).href;
const modelRouterUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/model-router.mjs')).href;
const capabilityRegistryUrl = pathToFileURL(
  path.join(root, 'hooks/scripts/lib/capability-registry.mjs'),
).href;
const CODEX_EXEC_HELP = [
  '--ephemeral', '--sandbox', '--ignore-user-config', '--ignore-rules', '--cd',
  '--skip-git-repo-check', '--output-last-message', '--color', '--model', '-c',
].join(' ');

function claudeCapability() {
  return {
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard', 'classifier'], model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  };
}

test('dry-run and explain render real routing plans without Phase 2 defer text', async () => {
  const { formatDryRun, formatExplainRouting } = await import(classifyUrl);
  const result = {
    scope: 'generic-document', artifacts: [{ path: 'README.md', target_kind: 'generic-document', confidence: 0.6, signal_summary: 'headings', needs_semantic: true, semantic_status: 'deferred' }],
    routing_plan: { protocol_version: '2.0', routing_policy: 'auto', shadow_mode: true, routes: [{ reviewer_id: 'claude-opus', resolved: { model: 'steady', effort: 'medium' }, route_explanation: 'generic route', fallback: { occurred: false } }] },
  };
  for (const output of [formatDryRun(result), formatExplainRouting(result)]) {
    assert.match(output, /Routing (?:plan|policy)/i);
    assert.match(output, /claude-opus/);
    assert.doesNotMatch(output, /not yet implemented|arrives in Phase 2|deferred to Phase 2/i);
  }
});

test('public override → emit-routing-plan → leaf argv applies explicit model and effort', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const { runClaudeReviewer } = await import(claudeUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-routing-public-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const planPath = path.join(repo, '.deep-review', 'tmp', 'routing-plan.json');
  const route = parsePublicRoute({
    entry: 'review', host: 'claude', cwd: repo,
    argv: ['--model', 'claude=vendor=model 품질', '--effort', 'claude=xhigh'],
  });
  assert.equal(route.ok, true);
  await runClassifyArtifactsCli([
    '--repo', repo, '--change-state', 'non-git', '--files-from0', files,
    '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan', '--routing-plan-out', planPath,
  ], {}, {
    capabilities: [claudeCapability()],
    reviewers: [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }],
  });
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.equal(plan.protocol_version, '3.0');
  assert.equal(plan.routes[0].transports.effort, 'flag:--effort');

  const promptFile = path.join(repo, 'prompt.txt');
  const outputFile = path.join(repo, 'output.txt');
  fs.writeFileSync(promptFile, 'payload');
  // JS callers load the same leaf plan helper used by the CLI surface.
  const { loadExecutionPlan } = await import(pathToFileURL(path.join(root, 'hooks/scripts/lib/execution-plan.mjs')).href);
  const executionPlan = loadExecutionPlan(planPath, 'claude-opus');
  let argv;
  await runClaudeReviewer({ projectRoot: repo, pluginRoot: root, promptFile, outputFile, binary: '/fake/claude', executionPlan,
    processRunner: async (_binary, args) => { argv = args; return { code: 0, timedOut: false, stdout: Buffer.from('ok'), stderr: Buffer.alloc(0) }; } });
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 4), ['--model', 'vendor=model 품질', '--effort', 'xhigh']);
});

test('explicit max reaches every Codex adapter and canonical role leaf unchanged', async (t) => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const { buildCapabilities } = await import(capabilityRegistryUrl);
  const cases = [
    {
      adapterId: 'codex-exec',
      reviewerId: 'codex-review',
      hostAssertions: { codexExecReviewer: true, codexNativeGeneric: false },
    },
    {
      adapterId: 'codex-exec',
      reviewerId: 'codex-adversarial',
      hostAssertions: { codexExecReviewer: true, codexNativeGeneric: false },
    },
    {
      adapterId: 'codex-native-generic',
      reviewerId: 'codex-review',
      hostAssertions: { codexExecReviewer: false, codexNativeGeneric: true },
    },
    {
      adapterId: 'codex-native-generic',
      reviewerId: 'codex-adversarial',
      hostAssertions: { codexExecReviewer: false, codexNativeGeneric: true },
    },
  ];

  for (const testCase of cases) {
    await t.test(`${testCase.adapterId} ${testCase.reviewerId}`, async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-codex-max-'));
      t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
      fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
      const files = path.join(repo, 'targets.z');
      fs.writeFileSync(files, 'notes.md\0');
      const publicRoute = parsePublicRoute({
        entry: 'review',
        host: 'codex',
        cwd: repo,
        argv: [
          '--reviewer-effort', `${testCase.reviewerId}=max`,
          '--allow-fallback',
        ],
      });
      assert.equal(publicRoute.ok, true);
      const capabilities = buildCapabilities({
        detected: {
          codex_cli: true,
          codex_cli_path: '/tools/codex',
          codex_plugin: false,
        },
        hostAssertions: testCase.hostAssertions,
        probes: { codex: { ok: true, version: 'codex-cli 9.9.9', help: CODEX_EXEC_HELP } },
      });

      const result = await runClassifyArtifactsCli(
        [
          '--repo', repo,
          '--change-state', 'non-git',
          '--files-from0', files,
          '--overrides-json', JSON.stringify(publicRoute.overrides),
          '--emit-routing-plan',
        ],
        {},
        { capabilities },
      );
      const leaf = result.routing_plan.routes.find(
        (item) => item.reviewer_id === testCase.reviewerId,
      );
      assert.ok(leaf, `${testCase.reviewerId} leaf must be selected`);
      assert.equal(leaf.adapter_id, testCase.adapterId);
      assert.equal(leaf.requested.effort, 'max');
      assert.equal(leaf.resolved.effort, 'max');
      assert.equal(leaf.fallback.occurred, false);
    });
  }
});

// I4: --host-assertions-json is the internal preflight argv transport for
// native host tool assertions. These tests deliberately omit
// runtime.capabilities (it takes full precedence and would bypass the flag
// entirely) and instead stub runtime.probes to avoid any real subprocess
// probing of an installed claude/codex/agy binary, restricting PATH so
// environment detection cannot discover one either.
const SAFE_SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);

test('I4: --host-assertions-json threads native Claude agent availability into the routing plan', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-host-assertions-native-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files, '--host-assertions-json', '{"claudeNativeAgent":true}'],
    { PATH: SAFE_SYSTEM_PATH },
    { probes: { claude: { ok: false }, codex: { ok: false } } },
  );
  const claudeRoute = result.routing_plan.routes.find((route) => route.reviewer_id === 'claude-opus');
  assert.ok(claudeRoute, 'claude-opus route must exist once the native agent host assertion is true');
  assert.equal(claudeRoute.adapter_id, 'claude-native-agent');
});

test('I4: codexExecReviewer assertion plus detected and successfully probed CLI selects both Codex reviewers', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake executable'); return; }
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-host-assertions-codex-exec-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-host-assertions-codex-bin-'));
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(codex, 0o755);

  const result = await runClassifyArtifactsCli(
    [
      '--repo', repo,
      '--files-from0', files,
      '--host-assertions-json', '{"codexExecReviewer":true,"codexNativeGeneric":false}',
    ],
    { PATH: `${binDir}${path.delimiter}${SAFE_SYSTEM_PATH}` },
    {
      probes: {
        claude: { ok: false },
        codex: { ok: true, version: 'codex-cli 9.9.9', help: CODEX_EXEC_HELP },
      },
    },
  );
  assert.deepEqual(
    result.routing_plan.candidate_reviewers.map((candidate) => [candidate.reviewer_id, candidate.adapter_id]),
    [['codex-review', 'codex-exec'], ['codex-adversarial', 'codex-exec']],
  );
});

test('I4: codexNativeGeneric selects both canonical Codex reviewers without CLI detection', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-host-assertions-codex-native-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const result = await runClassifyArtifactsCli(
    [
      '--repo', repo,
      '--files-from0', files,
      '--host-assertions-json', '{"codexExecReviewer":false,"codexNativeGeneric":true}',
    ],
    { PATH: SAFE_SYSTEM_PATH },
    { probes: { claude: { ok: false }, codex: { ok: false } } },
  );
  assert.deepEqual(
    result.routing_plan.candidate_reviewers.map((candidate) => [candidate.reviewer_id, candidate.adapter_id]),
    [['codex-review', 'codex-native-generic'], ['codex-adversarial', 'codex-native-generic']],
  );
});

test('I4: omitting --host-assertions-json leaves adapter selection unchanged (claude-cli chosen when only the CLI capability is available)', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-host-assertions-absent-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-fake-claude-bin-'));
  const claudeScript = path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  fs.writeFileSync(
    claudeScript,
    process.platform === 'win32'
      ? '@echo off\r\necho Claude Code v9.9.9\r\n'
      : '#!/bin/sh\necho "Claude Code v9.9.9"\n',
  );
  if (process.platform !== 'win32') fs.chmodSync(claudeScript, 0o755);

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files],
    { PATH: `${binDir}${path.delimiter}${SAFE_SYSTEM_PATH}` },
    { probes: { claude: { ok: true, version: 'Claude Code v9.9.9', help: '' }, codex: { ok: false } } },
  );
  const claudeRoute = result.routing_plan.routes.find((route) => route.reviewer_id === 'claude-opus');
  assert.ok(claudeRoute, 'claude-opus route must exist when the CLI capability is available');
  assert.equal(claudeRoute.adapter_id, 'claude-cli');
});

test('adaptive routing applies by default while explicit shadow mode alone may observe non-policy failures', async () => {
  const { routingPreflightDecision } = await import(classifyUrl);
  assert.deepEqual(routingPreflightDecision({ explicit: false, error: new Error('probe failed') }), { action: 'stop', error: 'probe failed' });
  assert.deepEqual(routingPreflightDecision({
    explicit: false,
    shadowMode: true,
    error: new Error('probe failed'),
  }), { action: 'continue', warning: 'probe failed' });
  assert.deepEqual(routingPreflightDecision({ explicit: true, error: new Error('unsupported') }), { action: 'stop', error: 'unsupported' });
  assert.deepEqual(routingPreflightDecision({ explicit: true }), { action: 'apply', error: null });
  assert.deepEqual(routingPreflightDecision({ shadowMode: true }), { action: 'shadow', error: null });
});

// ---------------------------------------------------------------------------
// J1: a preflight failure caused by policy enforcement (denied/unavailable
// provider, denied model, read-only unavailable, or an unparseable/type-
// invalid EXISTING policy file) must be terminal even when the plan is not
// explicit — legacy dispatch must never proceed past a policy the
// project/user deliberately configured. A missing policy file stays a no-op.
// ---------------------------------------------------------------------------

test('J1: a non-explicit policy-enforcement preflight error is terminal, not downgraded to a warning', async () => {
  const { routingPreflightDecision } = await import(classifyUrl);
  assert.deepEqual(
    routingPreflightDecision({ explicit: false, error: new Error('ERROR_PROVIDER_DENIED: agy') }),
    { action: 'stop', error: 'ERROR_PROVIDER_DENIED: agy' },
  );
  assert.deepEqual(
    routingPreflightDecision({ explicit: false, error: Object.assign(new Error('bad yaml'), { code: 'ERROR_POLICY_INVALID' }) }),
    { action: 'stop', error: 'bad yaml' },
  );
  // Applied adaptive routing cannot recover a trustworthy selected set.
  assert.deepEqual(
    routingPreflightDecision({ explicit: false, error: new Error('probe failed') }),
    { action: 'stop', error: 'probe failed' },
  );
  // Observation-only shadow mode may visibly continue on a non-policy failure.
  assert.deepEqual(
    routingPreflightDecision({
      explicit: false,
      shadowMode: true,
      error: new Error('probe failed'),
    }),
    { action: 'continue', warning: 'probe failed' },
  );
  // Unchanged: an explicit override still stops on any error.
  assert.deepEqual(
    routingPreflightDecision({ explicit: true, error: new Error('unsupported') }),
    { action: 'stop', error: 'unsupported' },
  );
});

test('J1: constraints.denied_providers throws ERROR_PROVIDER_DENIED and the preflight decision is terminal even for a non-explicit plan', async () => {
  const { runClassifyArtifactsCli, routingPreflightDecision } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-j1-denied-provider-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  let caught;
  try {
    await runClassifyArtifactsCli(
      ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
      {},
      {
        capabilities: [claudeCapability()],
        reviewers: [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }],
        projectPolicy: { constraints: { denied_providers: ['claude'] } },
      },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'a project-denied provider must fail the preflight even with no explicit CLI override');
  assert.match(caught.message, /^ERROR_PROVIDER_DENIED/);
  assert.deepEqual(routingPreflightDecision({ explicit: false, error: caught }), { action: 'stop', error: caught.message });
});

test('J1: an existing malformed project review-policy.yaml fails closed as ERROR_POLICY_INVALID', async () => {
  const { runClassifyArtifactsCli, routingPreflightDecision } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-j1-policy-invalid-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  fs.mkdirSync(path.join(repo, '.deep-review'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.deep-review', 'review-policy.yaml'), 'schema_version: 1\n');

  let caught;
  try {
    await runClassifyArtifactsCli(
      ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
      {},
      { capabilities: [claudeCapability()], reviewers: [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }] },
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'an existing malformed policy file must fail closed, not be treated as absent');
  assert.equal(caught.code, 'ERROR_POLICY_INVALID');
  assert.deepEqual(routingPreflightDecision({ explicit: false, error: caught }), { action: 'stop', error: caught.message });
});

test('J1: a missing project review-policy.yaml stays a no-op (not an error)', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-j1-policy-missing-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
    {},
    { capabilities: [claudeCapability()], reviewers: [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }] },
  );
  assert.ok(result.routing_plan, 'a missing policy file must not fail the preflight');
});

test('workflow/report contracts wire adaptive-default routing and assignment/readiness provenance', () => {
  const execution = fs.readFileSync(path.join(root, 'skills/deep-review-workflow/references/review-execution.md'), 'utf8');
  const report = fs.readFileSync(path.join(root, 'skills/deep-review-workflow/references/report-format.md'), 'utf8');
  const legacyClaude = 'run-claude-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PAYLOAD_FILE --output OUTPUT_FILE --model REVIEW_MODEL --agent code-reviewer --timeout-seconds 1200';
  assert.ok(execution.includes(legacyClaude), 'Claude leaf invocation is missing');
  assert.match(execution, /--emit-routing-plan/);
  assert.match(execution, /--execution-route-json EXECUTION_ROUTE_JSON --reviewer-id/);
  assert.match(execution, /v2\.0 default/u);
  assert.match(execution, /protocol `3\.0`/u);
  assert.match(execution, /needs_expansion/u);
  assert.match(execution, /READY_FOR_IMPLEMENTATION/u);
  assert.match(report, /## Routing Plan/);
  assert.match(report, /## Artifact Gate/);
  assert.match(report, /## Provenance/);
  assert.match(report, /requested-but-unverified/);
  assert.match(report, /### ℹ️ Info/u);
  assert.match(report, /Each Critical, Warning, and Info finding is exactly one `- ` bullet/u);
  assert.match(report, /A zero-count severity section contains exactly `None\.`/u);
});

// F3: risk assessment must see artifact content evidence even though the
// reduced provenance artifacts only carry non-sensitive scalar fields.
test('F3: high-risk content under a neutral filename still routes as high risk', async () => {
  const { classifyArtifactsScope } = await import(classifyUrl);
  const { buildRoutingPlan } = await import(modelRouterUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-f3-content-risk-'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'src', 'service.js'),
    '// runs the payment migration workflow\nfunction run() { return true; }\n',
  );

  const result = classifyArtifactsScope({ repo, changeState: 'non-git', filesFromZ: Buffer.from('src/service.js\0') });
  const artifact = result.artifacts.find((item) => item.path === 'src/service.js');
  assert.equal(artifact.content_risk, 'high', 'neutral filename must still carry high content risk');
  assert.doesNotMatch(JSON.stringify(artifact), /payment migration workflow/, 'reduced artifact must not persist raw content');

  const reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];
  const capabilities = [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard'],
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  }];
  const plan = buildRoutingPlan({
    artifacts: result.artifacts, reviewers,
    policy: { routing: { policy: 'auto' } },
    overrides: { protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, providers: {}, reviewers: {} },
    capabilities,
  });
  assert.match(plan.routes[0].route_explanation, /\/high\//);
});

// ---------------------------------------------------------------------------
// G3: normalized overrides must serialize only user-supplied routing
// settings, so an unrelated override flag never silently overlays a
// project/user routing.policy or allow_fallback during the merge.
// ---------------------------------------------------------------------------

function g3Capabilities() {
  return [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard'],
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  }];
}

const g3Reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];

test('G3: --allow-classifier alone does not downgrade a project routing.policy or allow_fallback', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-g3-allow-classifier-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--allow-classifier'] });
  assert.equal(route.ok, true);
  assert.equal(Object.hasOwn(route.overrides, 'routing_policy'), false, '--allow-classifier alone must not serialize routing_policy');
  assert.equal(Object.hasOwn(route.overrides, 'allow_fallback'), false, '--allow-classifier alone must not serialize allow_fallback');

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    {
      capabilities: g3Capabilities(), reviewers: g3Reviewers,
      projectPolicy: { routing: { policy: 'quality', allow_fallback: true } },
    },
  );
  assert.equal(result.routing_plan.routing_policy, 'quality', 'the project routing.policy must survive an unrelated --allow-classifier override');
  assert.equal(result.routing_plan.explicit_overrides, false);
  assert.equal(result.routing_plan.routes[0].fallback.allowed, true, 'the project allow_fallback must survive an unrelated --allow-classifier override');
});

test('G3: an explicit --routing fast still applies and marks the plan explicit', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-g3-routing-fast-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--routing', 'fast'] });
  assert.equal(route.ok, true);
  assert.equal(route.overrides.routing_policy, 'fast');

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    {
      capabilities: g3Capabilities(), reviewers: g3Reviewers,
      projectPolicy: { routing: { policy: 'quality', allow_fallback: true } },
    },
  );
  assert.equal(result.routing_plan.routing_policy, 'fast');
  assert.equal(result.routing_plan.explicit_overrides, true);
});

test('G3: an explicit --model override no longer downgrades the project routing_policy', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-g3-model-override-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: ['--model', 'claude=deep'] });
  assert.equal(route.ok, true);
  assert.equal(Object.hasOwn(route.overrides, 'routing_policy'), false);

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--overrides-json', JSON.stringify(route.overrides), '--emit-routing-plan'],
    {},
    {
      capabilities: g3Capabilities(), reviewers: g3Reviewers,
      projectPolicy: { routing: { policy: 'quality' } },
    },
  );
  assert.equal(result.routing_plan.routing_policy, 'quality', 'an explicit --model override must not silently downgrade the project routing_policy');
  assert.equal(result.routing_plan.routes[0].requested.model, 'deep');
});

test('schema-2 adaptive context carries prior risk, progress, and used reviewers into production routing', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-adaptive-context-'));
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const context = {
    schema_version: 2,
    risk: 'high',
    progress: 'regression',
    used_reviewers: ['claude-opus'],
  };
  const result = await runClassifyArtifactsCli([
    '--repo', repo,
    '--change-state', 'non-git',
    '--files-from0', files,
    '--adaptive-context-json', JSON.stringify(context),
  ], {}, {
    capabilities: g3Capabilities(),
    reviewers: g3Reviewers,
  });
  assert.equal(result.routing_plan.risk, 'high');
  assert.equal(result.routing_plan.progress, 'changed');
  await assert.rejects(() => runClassifyArtifactsCli([
    '--repo', repo,
    '--change-state', 'non-git',
    '--files-from0', files,
    '--adaptive-context-json', JSON.stringify({ ...context, schema_version: 1 }),
  ], {}, {
    capabilities: g3Capabilities(),
    reviewers: g3Reviewers,
  }), /schema-2/);
});
