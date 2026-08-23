'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const registryUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/capability-registry.mjs')).href;
const CODEX_EXEC_HELP = [
  '--ephemeral', '--sandbox', '--ignore-user-config', '--ignore-rules', '--cd',
  '--skip-git-repo-check', '--output-last-message', '--color', '--model', '-c',
].join(' ');

function detected(overrides = {}) {
  return {
    claude_cli: false, claude_cli_path: '', codex_cli: false, codex_cli_path: '',
    codex_plugin: false, codex_companion_path: '', agy_cli: false, agy_cli_path: '',
    agy_version: '', grok_cli: false, grok_cli_path: '', grok_version: '',
    grok_compatibility_verified: false, ...overrides,
  };
}

test('buildCapabilities emits codex-exec while preserving protocol 2.0 and legacy companion detection', async () => {
  const { buildCapabilities } = await import(registryUrl);
  const capabilities = buildCapabilities({
    detected: detected({
      claude_cli: true, claude_cli_path: '/tools/claude',
      codex_cli: true, codex_cli_path: '/tools/codex',
      codex_plugin: true, codex_companion_path: '/plugins/codex-companion.mjs',
      agy_cli: true, agy_cli_path: '/tools/agy', agy_version: 'agy 1.2.3',
    }),
    hostAssertions: { claudeNativeAgent: true, codexExecReviewer: true, codexNativeGeneric: false },
    probes: {
      claude: { ok: true, version: 'Claude Code v2.3.4 (stable)', help: '  --effort <level>' },
      codex: { ok: true, version: 'codex-cli 0.42.0', help: CODEX_EXEC_HELP },
    },
  });
  assert.equal(capabilities.length, 7);
  assert.deepEqual(capabilities.map((item) => item.adapter_id), [
    'claude-native-agent', 'claude-cli', 'codex-exec', 'codex-native-generic', 'codex-companion', 'agy-cli',
    'grok-cli',
  ]);
  for (const item of capabilities) {
    assert.equal(item.protocol_version, '2.0');
    for (const field of ['provider', 'available', 'roles', 'assignment_roles', 'model_selection', 'effort_selection', 'structured_output', 'read_only_enforcement']) {
      assert.ok(Object.hasOwn(item, field), `${item.adapter_id} missing ${field}`);
    }
    assert.ok(item.assignment_roles.every((role) => [
      'standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation',
    ].includes(role)));
  }
  assert.equal(capabilities[0].available, true);
  assert.equal(capabilities[1].effort_selection.transport, 'flag:--effort');
  assert.equal(capabilities[2].available, true);
  assert.equal(capabilities[2].model_selection.transport, 'flag:--model');
  assert.equal(capabilities[2].effort_selection.transport, 'config:model_reasoning_effort');
  assert.equal(capabilities[3].available, false);
  assert.equal(capabilities[4].model_selection.supported, false);
  assert.equal(capabilities[4].effort_selection.supported, false);
  assert.notEqual(capabilities[3].adapter_id, capabilities[4].adapter_id);
});

test('both Codex reviewer transports support every canonical assignment role and model/effort transport', async () => {
  const { buildCapabilities } = await import(registryUrl);
  const capabilities = buildCapabilities({
    detected: detected({ codex_cli: true, codex_cli_path: '/tools/codex', codex_plugin: true, agy_cli: true }),
    hostAssertions: { claudeNativeAgent: true, codexExecReviewer: true, codexNativeGeneric: true },
    probes: { codex: { ok: true, version: 'codex-cli 1.2.3', help: CODEX_EXEC_HELP } },
  });
  const byId = new Map(capabilities.map((item) => [item.adapter_id, item]));
  assert.ok(byId.get('claude-native-agent').assignment_roles.includes('feasibility'));
  for (const adapterId of ['codex-exec', 'codex-native-generic']) {
    assert.deepEqual(byId.get(adapterId).assignment_roles, [
      'standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation',
    ]);
    assert.equal(byId.get(adapterId).model_selection.supported, true);
    assert.equal(byId.get(adapterId).effort_selection.supported, true);
    assert.deepEqual(
      byId.get(adapterId).effort_selection.levels,
      ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      `${adapterId} must advertise the complete Codex effort enum`,
    );
  }
  assert.deepEqual(
    byId.get('codex-companion').assignment_roles,
    ['standard', 'adversarial'],
  );
  assert.ok(byId.get('agy-cli').assignment_roles.includes('traceability'));
});

test('codex-native-generic declares direct native model and effort transports', async () => {
  const { buildCapabilities } = await import(registryUrl);
  const capabilities = buildCapabilities({
    detected: detected(),
    hostAssertions: { claudeNativeAgent: true, codexNativeGeneric: true },
  });
  const codexNativeGeneric = capabilities.find((item) => item.adapter_id === 'codex-native-generic');
  assert.equal(codexNativeGeneric.model_selection.supported, true);
  assert.equal(codexNativeGeneric.model_selection.transport, 'agent-parameter:model');
  assert.equal(codexNativeGeneric.effort_selection.supported, true);
  assert.equal(codexNativeGeneric.effort_selection.transport, 'agent-parameter:reasoning_effort');
  assert.equal(
    codexNativeGeneric.read_only_enforcement,
    'instruction-and-fingerprint-rejection',
  );
  assert.notEqual(codexNativeGeneric.read_only_enforcement, 'agent-tool-allowlist');
});

test('host assertions are injected per run and absent assertions remain unknown', async () => {
  const { buildCapabilities } = await import(registryUrl);
  const absent = buildCapabilities({ detected: detected() });
  assert.equal(absent.find((item) => item.adapter_id === 'claude-native-agent').available, 'unknown');
  assert.equal(absent.find((item) => item.adapter_id === 'codex-exec').available, false);
  assert.equal(absent.find((item) => item.adapter_id === 'codex-native-generic').available, 'unknown');
  const injected = buildCapabilities({ detected: detected(), hostAssertions: { claudeNativeAgent: false } });
  assert.equal(injected.find((item) => item.adapter_id === 'claude-native-agent').available, false);
});

test('codex-exec availability requires the current host assertion, absolute detected path, and successful probe', async () => {
  const { buildCapabilities } = await import(registryUrl);
  const availability = (options) => buildCapabilities(options)
    .find((item) => item.adapter_id === 'codex-exec').available;
  const readyDetected = detected({ codex_cli: true, codex_cli_path: '/tools/codex' });
  const successfulProbe = {
    codex: { ok: true, version: 'codex-cli 1.2.3', help: CODEX_EXEC_HELP },
  };

  assert.equal(availability({
    detected: readyDetected,
    hostAssertions: { codexExecReviewer: true },
    probes: successfulProbe,
  }), true);
  assert.equal(availability({
    detected: detected(),
    hostAssertions: { codexExecReviewer: true },
    probes: successfulProbe,
  }), false);
  assert.equal(availability({
    detected: readyDetected,
    hostAssertions: { codexExecReviewer: true },
    probes: { codex: { ok: false, error: 'probe failed' } },
  }), false);
  assert.equal(availability({
    detected: readyDetected,
    hostAssertions: { codexExecReviewer: false },
    probes: successfulProbe,
  }), false);
  assert.equal(availability({
    detected: readyDetected,
    probes: successfulProbe,
  }), 'unknown');
});

test('probe parsing tolerates version variants and reports safe unknown/false states', async () => {
  const { parseVersion, detectEffortTransport, buildCapabilities } = await import(registryUrl);
  assert.equal(parseVersion('Claude Code v2.3.4 (stable)\nmore'), '2.3.4');
  assert.equal(parseVersion('codex-cli 0.42.0-beta.1'), '0.42.0-beta.1');
  assert.equal(parseVersion('development build'), 'development build');
  assert.equal(detectEffortTransport('set CLAUDE_CODE_EFFORT_LEVEL to low'), 'env:CLAUDE_CODE_EFFORT_LEVEL');
  assert.equal(detectEffortTransport('', false), 'unknown');

  const capabilities = buildCapabilities({
    detected: detected({ claude_cli: true, claude_cli_path: '/missing/claude' }),
    probes: { claude: { ok: false, error: 'ENOENT' } },
  });
  const claude = capabilities.find((item) => item.adapter_id === 'claude-cli');
  assert.equal(claude.available, false);
  assert.equal(claude.effort_selection.transport, 'unknown');
});

test('capability probes use finite capture limits and reject capture overflow for every CLI probe', async () => {
  const { buildCapabilities, probeCapabilities } = await import(registryUrl);
  const calls = [];
  const noisyRunner = async (binary, args, options) => {
    calls.push({ binary, args, options });
    return {
      code: 0,
      timedOut: false,
      captureOverflow: true,
      stdout: Buffer.from('v9.9.9\n' + 'x'.repeat(200_000)),
      stderr: Buffer.from('y'.repeat(200_000)),
    };
  };
  const detectedCli = detected({
    claude_cli: true,
    claude_cli_path: '/tools/claude',
    codex_cli: true,
    codex_cli_path: '/tools/codex',
  });

  const probes = await probeCapabilities({ detected: detectedCli, run: noisyRunner });

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(({ binary, args }) => [binary, args]), [
    ['/tools/claude', ['--version']],
    ['/tools/claude', ['--help']],
    ['/tools/codex', ['--version']],
    ['/tools/codex', ['exec', '--help']],
  ]);
  for (const call of calls) {
    assert.equal(Number.isSafeInteger(call.options.maxCaptureBytesPerStream), true);
    assert.equal(call.options.maxCaptureBytesPerStream > 0, true);
    assert.equal(Number.isSafeInteger(call.options.maxCaptureBytesTotal), true);
    assert.equal(call.options.maxCaptureBytesTotal > 0, true);
  }
  assert.equal(probes.claude.ok, false);
  assert.equal(probes.claude.capture_overflow, true);
  assert.equal(probes.claude.version, '');
  assert.equal(probes.claude.help, '');
  assert.equal(probes.codex.ok, false);
  assert.equal(probes.codex.capture_overflow, true);
  assert.equal(probes.codex.version, '');
  assert.equal(probes.codex.help, '');

  const capabilities = buildCapabilities({
    detected: detectedCli,
    hostAssertions: { codexExecReviewer: true },
    probes,
  });
  assert.equal(capabilities.find((item) => item.adapter_id === 'claude-cli').available, false);
  assert.equal(capabilities.find((item) => item.adapter_id === 'codex-exec').available, false);

  const rawOverflowCapabilities = buildCapabilities({
    detected: detectedCli,
    hostAssertions: { codexExecReviewer: true },
    probes: {
      claude: {
        ok: true,
        captureOverflow: true,
        version: 'Claude Code v9.9.9',
        help: '--effort',
      },
      codex: { ok: true, captureOverflow: true, version: 'codex-cli 9.9.9' },
    },
  });
  assert.equal(
    rawOverflowCapabilities.find((item) => item.adapter_id === 'claude-cli').available,
    false,
  );
  assert.equal(
    rawOverflowCapabilities.find((item) => item.adapter_id === 'codex-exec').available,
    false,
  );
});

test('codex-exec requires a successful compatible exec help probe', async (t) => {
  const { buildCapabilities, probeCapabilities } = await import(registryUrl);
  const detectedCli = detected({
    codex_cli: true,
    codex_cli_path: '/tools/codex',
  });
  const availability = (probes) => buildCapabilities({
    detected: detectedCli,
    hostAssertions: { codexExecReviewer: true },
    probes,
  }).find((item) => item.adapter_id === 'codex-exec').available;

  for (const testCase of [
    {
      name: 'exec help command fails',
      helpResult: { code: 2, timedOut: false, stdout: Buffer.alloc(0), stderr: Buffer.from('old codex') },
    },
    {
      name: 'exec help omits a required transport',
      helpResult: {
        code: 0,
        timedOut: false,
        stdout: Buffer.from(CODEX_EXEC_HELP.replace('--ignore-rules', '')),
        stderr: Buffer.alloc(0),
      },
    },
    {
      name: 'exec help omits the always-emitted color flag',
      helpResult: {
        code: 0,
        timedOut: false,
        stdout: Buffer.from(CODEX_EXEC_HELP.replace('--color', '')),
        stderr: Buffer.alloc(0),
      },
    },
    {
      name: 'exec help offers only long config instead of the emitted short flag',
      helpResult: {
        code: 0,
        timedOut: false,
        stdout: Buffer.from(CODEX_EXEC_HELP.replace(' -c', ' --config')),
        stderr: Buffer.alloc(0),
      },
    },
    {
      name: 'exec help capture overflows',
      helpResult: {
        code: 0,
        timedOut: false,
        captureOverflow: true,
        stdout: Buffer.from(CODEX_EXEC_HELP),
        stderr: Buffer.alloc(0),
      },
    },
  ]) {
    await t.test(testCase.name, async () => {
      const probes = await probeCapabilities({
        detected: detectedCli,
        run: async (_binary, args) => (
          args[0] === '--version'
            ? {
              code: 0,
              timedOut: false,
              stdout: Buffer.from('codex-cli 9.9.9'),
              stderr: Buffer.alloc(0),
            }
            : testCase.helpResult
        ),
      });
      assert.equal(probes.codex.ok, false);
      assert.equal(availability(probes), false);
    });
  }

  assert.equal(availability({
    codex: { ok: true, version: 'codex-cli 9.9.9' },
  }), false, 'version-only evidence must not advertise codex-exec');

  const compatible = await probeCapabilities({
    detected: detectedCli,
    run: async (_binary, args) => ({
      code: 0,
      timedOut: false,
      stdout: Buffer.from(args[0] === '--version' ? 'codex-cli 9.9.9' : CODEX_EXEC_HELP),
      stderr: Buffer.alloc(0),
    }),
  });
  assert.equal(compatible.codex.ok, true);
  assert.equal(compatible.codex.help, CODEX_EXEC_HELP);
  assert.equal(availability(compatible), true);
});

test('capability cache keeps protocol 2.0 but requires an independent cache contract revision', async () => {
  const {
    CAPABILITY_CACHE_REVISION,
    loadCapabilityCache,
    saveCapabilityCache,
  } = await import(registryUrl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-capability-'));
  const file = path.join(temp, 'capabilities.json');
  const keys = { claude: { path: '/bin/claude', mtime_ms: 10, version: '1.0.0' } };
  const probes = {
    claude: {
      ok: true,
      version: 'Claude Code v1.0.0',
      help: '  --effort <level>',
    },
  };
  saveCapabilityCache(temp, file, probes, keys);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.protocol_version, '2.0');
  assert.equal(raw.cache_contract_revision, CAPABILITY_CACHE_REVISION);
  assert.equal(Object.hasOwn(raw, 'capabilities'), false);
  assert.equal(Object.hasOwn(raw, 'probe_evidence'), false);
  assert.deepEqual(raw.probe_results, probes);
  assert.deepEqual(loadCapabilityCache(temp, file, keys), {
    invalidation_keys: keys,
    probe_results: probes,
  });
  const companionEra = { ...raw };
  delete companionEra.cache_contract_revision;
  fs.writeFileSync(file, `${JSON.stringify(companionEra)}\n`);
  assert.equal(loadCapabilityCache(temp, file, keys), null);
  fs.writeFileSync(file, `${JSON.stringify({ ...raw, cache_contract_revision: 'stale' })}\n`);
  assert.equal(loadCapabilityCache(temp, file, keys), null);
  fs.writeFileSync(file, `${JSON.stringify(raw)}\n`);
  for (const changed of [
    { claude: { path: '/other/claude', mtime_ms: 10, version: '1.0.0' } },
    { claude: { path: '/bin/claude', mtime_ms: 11, version: '1.0.0' } },
    { claude: { path: '/bin/claude', mtime_ms: 10, version: '1.0.1' } },
  ]) assert.equal(loadCapabilityCache(temp, file, changed), null);
});

test('capability cache refuses overflow and bounds every persisted probe field', async () => {
  const {
    MAX_PERSISTED_HELP_CHARS,
    MAX_PERSISTED_VERSION_CHARS,
    loadCapabilityCache,
    saveCapabilityCache,
  } = await import(registryUrl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-capability-bounds-'));
  const file = path.join(temp, 'capabilities.json');
  const keys = {
    claude: { path: '/tools/claude', mtime_ms: 10, version: '9.9.9' },
    codex: { path: '/tools/codex', mtime_ms: 10, version: '9.9.9' },
  };

  assert.throws(
    () => saveCapabilityCache(temp, file, {
      claude: {
        ok: true,
        capture_overflow: true,
        version: 'Claude Code v9.9.9',
        help: '--effort',
      },
    }, keys),
    /capture overflow/iu,
  );
  assert.equal(fs.existsSync(file), false);

  saveCapabilityCache(temp, file, {
    claude: {
      ok: true,
      version: `Claude Code v9.9.9\u0000${'v'.repeat(20_000)}`,
      help: `--effort <level>\u0000${'h'.repeat(200_000)}`,
    },
    codex: {
      ok: true,
      version: `codex-cli 9.9.9\u0000${'c'.repeat(20_000)}`,
      help: `${CODEX_EXEC_HELP}\u0000 ${'h'.repeat(200_000)}`,
    },
  }, keys);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.probe_results.claude.version.length <= MAX_PERSISTED_VERSION_CHARS, true);
  assert.equal(raw.probe_results.claude.help.length <= MAX_PERSISTED_HELP_CHARS, true);
  assert.equal(raw.probe_results.codex.version.length <= MAX_PERSISTED_VERSION_CHARS, true);
  assert.equal(raw.probe_results.codex.help.length <= MAX_PERSISTED_HELP_CHARS, true);
  assert.doesNotMatch(JSON.stringify(raw.probe_results), /\u0000/u);
  assert.ok(loadCapabilityCache(temp, file, keys));
});

test('capability cache rejects an oversized repository-controlled document', async () => {
  const {
    MAX_CAPABILITY_CACHE_BYTES,
    loadCapabilityCache,
  } = await import(registryUrl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-capability-oversized-'));
  const file = path.join(temp, 'capabilities.json');
  fs.writeFileSync(file, ' '.repeat(MAX_CAPABILITY_CACHE_BYTES + 1));

  assert.equal(loadCapabilityCache(temp, file, {}), null);
});

test('capability cache rejects repository-forged capability objects', async () => {
  const { CAPABILITY_CACHE_REVISION, loadCapabilityCache } = await import(registryUrl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-capability-forged-'));
  const file = path.join(temp, 'capabilities.json');
  const keys = { claude: { path: '/tools/claude', mtime_ms: 10, version: '' } };
  fs.writeFileSync(file, `${JSON.stringify({
    protocol_version: '2.0',
    cache_contract_revision: CAPABILITY_CACHE_REVISION,
    invalidation_keys: keys,
    probe_results: {
      claude: { ok: true, version: 'Claude Code v9.9.9', help: '--effort' },
    },
    capabilities: [{
      protocol_version: '2.0',
      adapter_id: 'claude-cli',
      provider: 'claude',
      available: true,
      assignment_roles: ['standard'],
      model_selection: { supported: true, transport: 'attacker-controlled' },
      effort_selection: { supported: true, transport: 'attacker-controlled' },
    }],
  })}\n`);
  assert.equal(loadCapabilityCache(temp, file, keys), null);
});

// ---------------------------------------------------------------------------
// H8: codex-companion availability is a pure detection derivative (no probe
// cost, unlike claude/codex/agy CLI paths) and must never be persisted to the
// on-disk capability cache — it is rebuilt fresh from this run's detected
// values on every cache hit, so installing/removing the companion without
// touching the keyed CLIs never yields a stale reviewer set.
// ---------------------------------------------------------------------------

test('H8: saveCapabilityCache persists no adapter or host-assertion authority', async () => {
  const { saveCapabilityCache } = await import(registryUrl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-capability-h8-'));
  const file = path.join(temp, 'capabilities.json');
  saveCapabilityCache(temp, file, {
    codex: { ok: true, version: 'codex-cli 1.2.3', help: CODEX_EXEC_HELP },
  }, {
    codex: { path: '/tools/codex', mtime_ms: 10, version: '' },
  });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(JSON.stringify(raw).includes('adapter_id'), false);
  assert.equal(JSON.stringify(raw).includes('hostAssertions'), false);
  assert.equal(JSON.stringify(raw).includes('available'), false);
});
