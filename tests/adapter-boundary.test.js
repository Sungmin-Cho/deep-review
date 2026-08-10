'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const claudeUrl = pathToFileURL(path.join(root, 'hooks/scripts/run-claude-reviewer.mjs')).href;
const agyUrl = pathToFileURL(path.join(root, 'hooks/scripts/run-agy-reviewer.mjs')).href;
const planUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/execution-plan.mjs')).href;

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-adapter-'));
  fs.mkdirSync(path.join(dir, 'project 리뷰 Ω'));
  fs.writeFileSync(path.join(dir, 'prompt 리뷰 Ω.txt'), 'untrusted review payload');
  return {
    dir,
    projectRoot: path.join(dir, 'project 리뷰 Ω'),
    promptFile: path.join(dir, 'prompt 리뷰 Ω.txt'),
    outputFile: path.join(dir, 'output 리뷰 Ω.txt'),
  };
}

function processResult(overrides = {}) {
  return {
    code: 0,
    timedOut: false,
    stdout: Buffer.from('# Deep Review Report — 2026-07-24\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n\n## Code Review\n\n### 🔴 Critical\n\nNone.\n\n### 🟡 Warning\n\nNone.\n\n### ℹ️ Info\n\nNone.\n\n### 🟢 Passed\n\n- Contract valid.\n'),
    stderr: Buffer.alloc(0),
    ...overrides,
  };
}

test('routing plan leaf validates protocol and maps only its canonical reviewer route', async () => {
  const { parseExecutionPlanDocument } = await import(planUrl);
  const document = {
    protocol_version: '2.0', routes: [{
      reviewer_id: 'claude-opus', requested: { model: 'C:\\models\\품질=model', effort: 'high', source: 'cli-reviewer', model_source: 'cli-reviewer', effort_source: 'cli-reviewer' },
      resolved: { model: 'C:\\models\\품질=model', effort: 'high' },
      fallback: { allowed: false, occurred: false },
      transports: { model: 'flag:--model', effort: 'flag:--effort' },
    }],
  };
  const plan = parseExecutionPlanDocument(document, 'claude-opus');
  assert.equal(plan.model, 'C:\\models\\품질=model');
  assert.equal(plan.effort, 'high');
  assert.equal(plan.source, 'cli-reviewer');
  assert.throws(() => parseExecutionPlanDocument({ ...document, protocol_version: '1.0' }, 'claude-opus'), /protocol_version/);
  assert.throws(() => parseExecutionPlanDocument(document, 'agy'), /reviewer.*agy/i);
});

test('routing-plan fallback authority accepts only boolean true across nested and legacy fields', async () => {
  const { loadExecutionPlan, parseExecutionPlanDocument } = await import(planUrl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-fallback-plan-'));
  const planPath = path.join(temp, 'routing-plan.json');
  const validCases = [
    ['true', true, true],
    ['false', false, false],
    ['null', null, false],
    ['missing', undefined, false],
  ];
  const invalidCases = [
    ['string', 'false'],
    ['number', 1],
    ['object', {}],
    ['array', []],
  ];
  const documentFor = (field, value) => {
    const route = { reviewer_id: 'claude-opus', resolved: { model: 'opus', effort: 'high' } };
    if (field === 'fallback') {
      route.fallback = { occurred: false };
      if (value !== undefined) route.fallback.allowed = value;
    } else if (value !== undefined) {
      route.allow_fallback = value;
    }
    return { protocol_version: '2.0', routes: [route] };
  };

  for (const field of ['fallback', 'allow_fallback']) {
    for (const [label, value, expected] of validCases) {
      const document = documentFor(field, value);
      assert.equal(parseExecutionPlanDocument(document, 'claude-opus').allowFallback, expected, `${field}:${label}:direct`);
      fs.writeFileSync(planPath, JSON.stringify(document));
      assert.equal(loadExecutionPlan(planPath, 'claude-opus').allowFallback, expected, `${field}:${label}:load`);
    }
    for (const [label, value] of invalidCases) {
      const document = documentFor(field, value);
      assert.throws(
        () => parseExecutionPlanDocument(document, 'claude-opus'),
        /fallback authority.*boolean/u,
        `${field}:${label}:direct`,
      );
      fs.writeFileSync(planPath, JSON.stringify(document));
      assert.throws(
        () => loadExecutionPlan(planPath, 'claude-opus'),
        /fallback authority.*boolean/u,
        `${field}:${label}:load`,
      );
    }
  }
});

test('inline execution-route fallback authority accepts only boolean true across nested and legacy fields', async () => {
  const { parseExecutionRouteJson } = await import(planUrl);
  const validCases = [
    ['true', true, true],
    ['false', false, false],
    ['null', null, false],
    ['missing', undefined, false],
  ];
  const invalidCases = [
    ['string', 'false'],
    ['number', 1],
    ['object', {}],
    ['array', []],
  ];
  const routeFor = (field, value) => {
    const route = {
      protocol_version: '3.0', reviewer_id: 'agy', provider: 'agy', adapter_id: 'agy-cli',
      assignment_role: 'standard', rubric_id: 'standard-v1', wave: 1, required: true,
      selection_reason: 'test route', requested: { model: 'future-model', effort: null, source: 'cli-reviewer' },
      resolved: { model: 'future-model', effort: null },
    };
    if (field === 'fallback') {
      route.fallback = { occurred: false };
      if (value !== undefined) route.fallback.allowed = value;
    } else if (value !== undefined) {
      route.allow_fallback = value;
    }
    return route;
  };

  for (const field of ['fallback', 'allow_fallback']) {
    for (const [label, value, expected] of validCases) {
      const parsed = parseExecutionRouteJson(JSON.stringify(routeFor(field, value)), 'agy');
      assert.equal(parsed.allowFallback, expected, `${field}:${label}`);
    }
    for (const [label, value] of invalidCases) {
      assert.throws(
        () => parseExecutionRouteJson(JSON.stringify(routeFor(field, value)), 'agy'),
        /fallback authority.*boolean/u,
        `${field}:${label}`,
      );
    }
  }
});

test('routing plan leaf reads both legacy 2.0 and assignment-aware 3.0 documents', async () => {
  const { parseExecutionPlanDocument } = await import(planUrl);
  const legacy = {
    protocol_version: '2.0',
    routes: [{
      reviewer_id: 'claude-opus',
      resolved: { model: 'opus', effort: 'high' },
    }],
  };
  const legacyPlan = parseExecutionPlanDocument(legacy, 'claude-opus');
  assert.equal(legacyPlan.assignmentRole, 'standard');
  assert.equal(legacyPlan.rubricId, 'standard-v1');

  const current = {
    protocol_version: '3.0',
    reviewer_strategy: 'adaptive',
    shadow_mode: false,
    artifact_phase: 'document',
    risk: 'high',
    progress: 'initial',
    minimum_reviewers: 1,
    maximum_reviewers: 4,
    provider_family_minimum: 1,
    planned_reviewers: 1,
    max_expansion_waves: 1,
    initial_reviewer_ids: ['claude-opus'],
    required_reviewer_ids: ['claude-opus'],
    candidate_reviewers: [{
      reviewer_id: 'claude-opus',
      provider: 'claude',
      adapter_id: 'claude-cli',
      assignment_roles: ['feasibility'],
      last_status: 'unknown',
    }],
    routes: [{
      reviewer_id: 'claude-opus',
      provider: 'claude',
      adapter_id: 'claude-cli',
      assignment_role: 'feasibility',
      rubric_id: 'feasibility-v1',
      wave: 1,
      required: true,
      selection_reason: 'role fit and provider diversity',
      resolved: { model: 'opus', effort: 'xhigh' },
    }],
  };
  const currentPlan = parseExecutionPlanDocument(current, 'claude-opus');
  assert.equal(currentPlan.assignmentRole, 'feasibility');
  assert.equal(currentPlan.rubricId, 'feasibility-v1');
  assert.equal(currentPlan.wave, 1);
  assert.equal(currentPlan.required, true);

  assert.throws(() => parseExecutionPlanDocument({
    ...current,
    routes: [...current.routes, { ...current.routes[0] }],
  }, 'claude-opus'), /duplicate reviewer route/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current,
    routes: [{ ...current.routes[0], assignment_role: 'invented' }],
  }, 'claude-opus'), /assignment role/);
});

test('routing plan protocol 3.0 rejects malformed global, candidate, and route metadata', async () => {
  const { parseExecutionPlanDocument } = await import(planUrl);
  const current = {
    protocol_version: '3.0',
    reviewer_strategy: 'adaptive',
    shadow_mode: false,
    artifact_phase: 'implementation',
    risk: 'critical',
    progress: 'regression',
    minimum_reviewers: 3,
    maximum_reviewers: 4,
    provider_family_minimum: 2,
    planned_reviewers: 3,
    max_expansion_waves: 1,
    initial_reviewer_ids: ['claude-opus'],
    required_reviewer_ids: ['claude-opus'],
    candidate_reviewers: [{
      reviewer_id: 'claude-opus',
      provider: 'claude',
      adapter_id: 'claude-cli',
      assignment_roles: ['standard', 'security'],
      last_status: 'success',
    }],
    routes: [{
      reviewer_id: 'claude-opus',
      provider: 'claude',
      adapter_id: 'claude-cli',
      assignment_role: 'security',
      rubric_id: 'security-v1',
      wave: 1,
      required: true,
      selection_reason: 'critical security floor',
      resolved: { model: 'opus', effort: 'xhigh' },
    }],
  };

  assert.throws(() => parseExecutionPlanDocument({
    ...current, artifact_phase: 'mixed',
  }, 'claude-opus'), /artifact_phase/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current, risk: 'severe',
  }, 'claude-opus'), /risk/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current, planned_reviewers: 5,
  }, 'claude-opus'), /planned_reviewers/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current,
    candidate_reviewers: [{ ...current.candidate_reviewers[0], assignment_roles: ['security', 'security'] }],
  }, 'claude-opus'), /duplicate assignment roles/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current,
    candidate_reviewers: [{ ...current.candidate_reviewers[0], provider: 'agy' }],
    routes: [{ ...current.routes[0], provider: 'agy' }],
  }, 'claude-opus'), /provider is not canonical/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current,
    routes: [{ ...current.routes[0], selection_reason: '' }],
  }, 'claude-opus'), /selection_reason/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current,
    max_expansion_waves: 0,
    routes: [{ ...current.routes[0], wave: 2 }],
  }, 'claude-opus'), /expansion wave is disabled/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current,
    routes: [{ ...current.routes[0], required: false }],
  }, 'claude-opus'), /hard-required reviewer set/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current,
    routes: [{ ...current.routes[0], wave: 2 }],
  }, 'claude-opus'), /initial reviewer set/);
  assert.throws(() => parseExecutionPlanDocument({
    ...current,
    routes: [],
  }, 'claude-opus'), /reviewer without a route/);
});

test('Claude execution plan forwards verified effort transport and normalizes unreported application', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let invocation;
  const result = await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    executionPlan: {
      model: 'vendor=model 품질', effort: 'xhigh', source: 'cli-provider', allowFallback: false,
      modelTransport: 'flag:--model', effortTransport: 'flag:--effort',
    },
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.equal(invocation.binary, '/fake/claude');
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 4), ['--model', 'vendor=model 품질', '--effort', 'xhigh']);
  assert.equal(result.requested_model, 'vendor=model 품질');
  assert.equal(result.resolved_effort, 'xhigh');
  assert.equal(result.applied_model, null);
  assert.equal(result.verification_status, 'provider-did-not-report');
});

test('Claude explicit effort fails closed without transport; allow-fallback omits it with provenance', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let calls = 0;
  const base = {
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    processRunner: async () => { calls += 1; return processResult(); },
  };
  await assert.rejects(runClaudeReviewer({ ...base, executionPlan: { model: 'm', effort: 'high', source: 'cli-provider', allowFallback: false, effortTransport: 'unknown' } }), /ERROR_EFFORT_TRANSPORT_UNAVAILABLE/);
  assert.equal(calls, 0);
  const fallback = await runClaudeReviewer({ ...base, executionPlan: { model: 'm', effort: 'high', source: 'cli-provider', allowFallback: true, effortTransport: 'none' } });
  assert.equal(calls, 1);
  assert.equal(fallback.fallback.occurred, true);
  assert.equal(fallback.resolved_effort, null);
  assert.equal(fallback.verification_status, 'fallback');
});

test('agy explicit unsupported model never retries unless fallback was authorized', async () => {
  const { runAgyReviewer } = await import(agyUrl);
  const fixture = workspace();
  const privacyPreparer = async () => ({ outcome: 'auto_ack', fingerprint: 'same' });
  const fingerprintCapturer = async () => ({ mode: 'off', digest: null, error: null });
  let calls = 0;
  const strict = await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    executionPlan: { model: 'unsupported-model', effort: null, source: 'cli-reviewer', allowFallback: false },
    privacyPreparer, fingerprintCapturer,
    processRunner: async () => { calls += 1; return processResult({ code: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('unsupported model\n') }); },
  });
  assert.equal(calls, 1);
  assert.equal(strict.error_code, 'ERROR_UNSUPPORTED_MODEL');
  assert.equal(strict.verification_status, 'failed');

  calls = 0;
  const fallback = await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    executionPlan: { model: 'unsupported-model', effort: null, source: 'cli-provider', allowFallback: true },
    privacyPreparer, fingerprintCapturer,
    processRunner: async (_binary, args) => {
      calls += 1;
      return args.includes('--model')
        ? processResult({ code: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('unsupported model\n') })
        : processResult();
    },
  });
  assert.equal(calls, 2);
  assert.equal(fallback.status, 'success');
  assert.equal(fallback.fallback.occurred, true);
  assert.equal(fallback.verification_status, 'fallback');
});

// ---------------------------------------------------------------------------
// H4: an execution plan's resolved model is authoritative, including null
// (provider default) — the legacy options.model must never resurrect a stale
// --model value once a plan is present.
// ---------------------------------------------------------------------------

test('H4: agy with an execution plan whose resolved model is null never falls back to legacy options.model', async () => {
  const { runAgyReviewer } = await import(agyUrl);
  const fixture = workspace();
  const privacyPreparer = async () => ({ outcome: 'auto_ack', fingerprint: 'same' });
  const fingerprintCapturer = async () => ({ mode: 'off', digest: null, error: null });
  let invocation;
  const result = await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    model: 'gemini-x',
    executionPlan: { model: null, effort: null, source: 'cli-provider', allowFallback: true },
    privacyPreparer, fingerprintCapturer,
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.equal(invocation.args.includes('--model'), false);
  assert.equal(result.resolved_model, null);
});

test('H4: agy without an execution plan still honors the legacy options.model', async () => {
  const { runAgyReviewer } = await import(agyUrl);
  const fixture = workspace();
  const privacyPreparer = async () => ({ outcome: 'auto_ack', fingerprint: 'same' });
  const fingerprintCapturer = async () => ({ mode: 'off', digest: null, error: null });
  let invocation;
  await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    model: 'gemini-x',
    privacyPreparer, fingerprintCapturer,
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 2), ['--model', 'gemini-x']);
});

test('H4: agy with an execution plan whose model is explicitly set still lands in argv', async () => {
  const { runAgyReviewer } = await import(agyUrl);
  const fixture = workspace();
  const privacyPreparer = async () => ({ outcome: 'auto_ack', fingerprint: 'same' });
  const fingerprintCapturer = async () => ({ mode: 'off', digest: null, error: null });
  let invocation;
  await runAgyReviewer({
    ...fixture, pluginRoot: root, configPath: path.join(fixture.dir, 'config.yaml'), binary: '/fake/agy', mode: 'off',
    model: 'gemini-x',
    executionPlan: { model: 'explicit-plan-model', effort: null, source: 'cli-provider', allowFallback: true },
    privacyPreparer, fingerprintCapturer,
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 2), ['--model', 'explicit-plan-model']);
});

// ---------------------------------------------------------------------------
// H4B: parity with the agy fix (d0459e9) — a Claude execution plan's resolved
// model is authoritative, including null (provider default) — the legacy
// options.model must never resurrect a stale --model value once a plan is
// present.
// ---------------------------------------------------------------------------

test('H4B: claude with an execution plan whose resolved model is null never falls back to legacy options.model', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let invocation;
  const result = await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    model: 'sonnet',
    executionPlan: { model: null, effort: null, source: 'cli-provider', allowFallback: true },
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.equal(invocation.args.includes('--model'), false);
  assert.equal(result.resolved_model, null);
});

test('H4B: claude without an execution plan still honors the legacy options.model default', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let invocation;
  await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 2), ['--model', 'opus']);
});

test('H4B: claude with an execution plan whose model is explicitly set still lands in argv', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let invocation;
  await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    model: 'sonnet',
    executionPlan: { model: 'explicit-plan-model', effort: null, source: 'cli-provider', allowFallback: true },
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 2), ['--model', 'explicit-plan-model']);
});

// ---------------------------------------------------------------------------
// J4: when a catalog-incomplete explicit Claude model passes preflight but
// the CLI rejects it at execution time, --allow-fallback (executionPlan
// .allowFallback) authorizes exactly one retry without --model, mirroring
// run-agy-reviewer.mjs's UNSUPPORTED_MODEL_PATTERN + retry logic.
// ---------------------------------------------------------------------------

test('J4: Claude CLI model rejection retries once without --model when the execution plan authorizes fallback', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let calls = 0;
  const result = await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    executionPlan: { model: 'opaque-x', effort: null, source: 'cli-provider', allowFallback: true },
    processRunner: async (binary, args) => {
      calls += 1;
      return args.includes('--model')
        ? processResult({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('unknown model: opaque-x\n') })
        : processResult();
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'success');
  assert.equal(result.fallback.occurred, true);
  assert.equal(result.resolved_model, null);
  assert.equal(result.verification_status, 'fallback');
});

test('J4: Claude CLI model rejection is not retried when the execution plan forbids fallback', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let calls = 0;
  const result = await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    executionPlan: { model: 'opaque-x', effort: null, source: 'cli-provider', allowFallback: false },
    processRunner: async () => {
      calls += 1;
      return processResult({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('unknown model: opaque-x\n') });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.fallback.occurred, false);
});

test('J4: an auth-failure stderr never triggers a Claude CLI model-rejection retry even when it also mentions model', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let calls = 0;
  const result = await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    executionPlan: { model: 'opaque-x', effort: null, source: 'cli-provider', allowFallback: true },
    processRunner: async () => {
      calls += 1;
      return processResult({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Not signed in: unknown model requested\n') });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'not_authenticated');
  assert.equal(result.fallback.occurred, false);
});

// ---------------------------------------------------------------------------
// J6: parity with run-agy-reviewer.mjs's SAFE_MODEL_PATTERN — a plan-supplied
// Claude model carrying NUL/newline/control characters is never pushed as an
// argv token; a strict cli- source without allow_fallback fails closed
// instead of silently omitting it.
// ---------------------------------------------------------------------------

test('J6: Claude explicit unsupported-character model fails closed without fallback authorization', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let calls = 0;
  await assert.rejects(runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    executionPlan: { model: 'opus\ninjected', effort: null, source: 'cli-reviewer', allowFallback: false },
    processRunner: async () => { calls += 1; return processResult(); },
  }), /ERROR_UNSUPPORTED_MODEL/);
  assert.equal(calls, 0);
});

test('J6: Claude model containing a NUL byte is omitted with a warning when fallback is authorized', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let invocation;
  const result = await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    executionPlan: { model: 'opus\0injected', effort: null, source: 'cli-provider', allowFallback: true },
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.equal(invocation.args.includes('--model'), false);
  assert.equal(result.resolved_model, null);
  const tail = fs.readFileSync(`${fixture.outputFile}.stderr-tail`, 'utf8');
  assert.match(tail, /unsupported characters/);
});

test('J6: a normal Claude model alias still lands in argv unmodified', async () => {
  const { runClaudeReviewer } = await import(claudeUrl);
  const fixture = workspace();
  let invocation;
  await runClaudeReviewer({
    ...fixture, pluginRoot: root, binary: '/fake/claude', timeoutSeconds: 5,
    executionPlan: { model: 'claude-sonnet-4-5', effort: null, source: 'cli-provider', allowFallback: true },
    processRunner: async (binary, args, options) => { invocation = { binary, args, options }; return processResult(); },
  });
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 2), ['--model', 'claude-sonnet-4-5']);
});

test('native Claude documentation states the real model-only override boundary', () => {
  const source = fs.readFileSync(path.join(root, 'skills/deep-review-workflow/references/review-execution.md'), 'utf8');
  assert.match(source, /Agent\(code-reviewer\)[\s\S]{0,500}model parameter/i);
  assert.match(source, /effort[\s\S]{0,180}(?:unsupported|not support|지원하지)/i);
  assert.match(source, /explicit\s+effort[\s\S]{0,220}(?:strict|error|오류)/i);
});

test('K4: native Claude dispatch consumes only an applicable routing plan model', () => {
  const source = fs.readFileSync(path.join(root, 'skills/deep-review-workflow/references/review-execution.md'), 'utf8');
  const nativeClaude = source.match(/### 4\.1 `claude-opus`([\s\S]*?)### 4\.2 `codex-review`/u)?.[1] || '';
  assert.match(nativeClaude, /read the `claude-opus`\s+route from the emitted routing plan/u);
  assert.match(nativeClaude, /`explicit_overrides: true` or `apply_automatic: true`/u);
  assert.match(nativeClaude, /pass its `resolved\.model` as the Agent\s+model parameter/u);
  assert.match(nativeClaude, /shadow-only plan or no emitted plan[\s\S]{0,120}configured model alias unchanged/u);
});
