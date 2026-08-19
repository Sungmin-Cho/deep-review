// SLICE-008a — the Grok bridge core: argv construction (D11/D12/E3), session
// isolation (I26), prompt transport (D8) and sealed compatibility evidence
// (D18). The D16 Artifact Gate and the containment lifecycle are owned by
// SLICE-008b and SLICE-008c and are deliberately not asserted here.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonicalStringify } from '../hooks/scripts/lib/grok-compatibility-carrier.mjs';
import { parseExecutionRoute } from '../hooks/scripts/lib/execution-plan.mjs';
import {
  GROK_AUTHORIZED_MODEL,
  GROK_SUPPORTED_EFFORTS,
  buildGrokArgv,
  parseCli as parseGrokCli,
  runGrokReviewer,
  validateGrokArgv,
  __testing as grokTesting,
} from '../hooks/scripts/run-grok-reviewer.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bridgePath = join(pluginRoot, 'hooks', 'scripts', 'run-grok-reviewer.mjs');
const WINDOWS = process.platform === 'win32';

const REQUIRED_HELP_FLAGS = Object.freeze([
  '--cwd',
  '--max-turns',
  '--model',
  '--no-memory',
  '--no-subagents',
  '--output-format',
  '--permission-mode',
  '--prompt-file',
  '--reasoning-effort',
  '--sandbox',
  '--session-id',
  '--single',
]);

const FRESH_UUID = '4d0b1f1a-9c2e-4c66-9b7c-1f2a3b4c5d6e';
const SECOND_UUID = '8f0d3c2b-1a4e-4bb1-8c9d-0e1f2a3b4c5d';

const REPORT = [
  '# Deep Review Report — 2026-08-19',
  '',
  '## Summary',
  '',
  '- **Verdict**: APPROVE',
  '- **Review Mode**: 5-way',
  '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건',
  '',
  '## Code Review',
  '',
  '### 🔴 Critical',
  '',
  'None.',
  '',
  '### 🟡 Warning',
  '',
  'None.',
  '',
  '### ℹ️ Info',
  '',
  'None.',
  '',
  '### 🟢 Passed',
  '',
  '- Contract valid.',
  '',
].join('\n');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function workspace(label) {
  return mkdtempSync(join(tmpdir(), `deep-review-${label}-`));
}

// ---------------------------------------------------------------------------
// A sealed protocol-3 D18 carrier. The bridge consumes it and never re-probes,
// so the fixture only has to be internally consistent, not a real CLI.
// ---------------------------------------------------------------------------

function identity(finalPath) {
  return WINDOWS
    ? { kind: 'win32-file-id-v1', fields: { final_path: finalPath, volume: '3', file_id: '4' } }
    : {
      kind: 'posix-dev-ino-v1',
      fields: { dev: '1', ino: '2', type: 'regular-file', uid: '0' },
    };
}

function member(path) {
  return {
    path,
    real_path: path,
    platform_identity: identity(path),
    sha256: 'a'.repeat(64),
    size: 12,
    classification_purpose: WINDOWS ? null : 'effective-executable',
  };
}

function sealedCarrier(launcherPath) {
  const chainBody = {
    schema_version: '1.0',
    prepared_kind: 'direct',
    launcher: member(launcherPath),
    shim: null,
    interpreter: null,
    shebang: null,
    posix_executable_type: WINDOWS
      ? null
      : (process.platform === 'darwin' ? 'native-macho' : 'native-elf'),
    native_loader: null,
  };
  const preparedSpawnChain = {
    ...chainBody,
    chain_sha256: sha256(Buffer.from(canonicalStringify(chainBody), 'utf8')),
  };
  const evidence = {
    schema_version: '1.0',
    launcher_path: launcherPath,
    real_path: launcherPath,
    platform_identity: identity(launcherPath),
    executable_sha256: 'a'.repeat(64),
    executable_size: 12,
    prepared_spawn_chain: preparedSpawnChain,
    version: '1.0.4',
    version_build: 'd846eb93d94d',
    version_banner_sha256: 'b'.repeat(64),
    help_sha256: 'c'.repeat(64),
    help_size: 1024,
    required_help_flags: [...REQUIRED_HELP_FLAGS],
  };
  return {
    ...evidence,
    evidence_sha256: sha256(Buffer.from(canonicalStringify(evidence), 'utf8')),
  };
}

function launcherPath(root) {
  return WINDOWS ? join(root, 'grok.exe') : join(root, 'grok');
}

function grokRoute(binary, overrides = {}) {
  return {
    protocol_version: '3.0',
    reviewer_id: 'grok',
    provider: 'grok',
    adapter_id: 'grok-cli',
    assignment_role: 'standard',
    rubric_id: 'standard-v1',
    wave: 1,
    required: false,
    selection_reason: 'grok cross reviewer',
    artifact_phase: 'implementation',
    risk: 'high',
    document_review_mode: 'full-readiness',
    requested: {
      model: GROK_AUTHORIZED_MODEL,
      effort: 'high',
      model_source: 'auto',
      effort_source: 'auto',
    },
    resolved: { model: GROK_AUTHORIZED_MODEL, effort: 'high' },
    grok_compatibility_evidence: sealedCarrier(binary),
    ...overrides,
  };
}

function plannedRoute(binary, overrides) {
  return parseExecutionRoute(grokRoute(binary, overrides), 'grok');
}

// ---------------------------------------------------------------------------
// Seams. Every one counts its calls so an ordering polarity can assert zero.
// ---------------------------------------------------------------------------

function harness(label, { body = 'review this diff\n', behavior = 'success' } = {}) {
  const root = workspace(label);
  const binary = launcherPath(root);
  writeFileSync(binary, 'not a real CLI');
  const promptFile = join(root, 'payload.md');
  writeFileSync(promptFile, body);
  const outputFile = join(root, 'grok.out');
  const calls = [];
  const fingerprints = [];
  const privacyCalls = [];
  const uuids = [];
  let digest = 'digest-1';

  const seams = {
    projectRoot: root,
    pluginRoot,
    promptFile,
    outputFile,
    binary,
    executionPlan: plannedRoute(binary),
    async privacyPreparer(options) {
      privacyCalls.push(options);
      return { outcome: 'auto_ack', fingerprint: 'privacy-1', hits: [], error: null };
    },
    async fingerprintCapturer(options) {
      fingerprints.push(options);
      return {
        mode: 'hybrid', digest, entries: 1, error: null,
      };
    },
    uuidGenerator() {
      uuids.push(FRESH_UUID);
      return uuids.length === 1 ? FRESH_UUID : SECOND_UUID;
    },
    async processRunner(command, args, options) {
      calls.push({ command, args, options });
      if (behavior === 'unsupported-model') {
        return {
          code: 2,
          timedOut: false,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('unsupported model value grok-4.6\n'),
        };
      }
      if (behavior === 'malformed') {
        return {
          code: 0,
          timedOut: false,
          stdout: Buffer.from('not a report at all\n'),
          stderr: Buffer.alloc(0),
        };
      }
      return {
        code: 0,
        timedOut: false,
        stdout: Buffer.from(REPORT, 'utf8'),
        stderr: Buffer.alloc(0),
      };
    },
  };

  return {
    root,
    binary,
    promptFile,
    outputFile,
    seams,
    calls,
    fingerprints,
    privacyCalls,
    uuids,
    driftAfterFirstCapture() {
      const original = seams.fingerprintCapturer;
      seams.fingerprintCapturer = async (options) => {
        const result = await original(options);
        digest = 'digest-2';
        return result;
      };
    },
  };
}

function tokenValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

// A canonical valid argv, built by the production constructor rather than
// transcribed, so a validator oracle can mutate exactly one token.
function validArgv(overrides = {}) {
  return buildGrokArgv({
    model: GROK_AUTHORIZED_MODEL,
    effort: 'high',
    projectRoot: WINDOWS ? 'C:\\repo' : '/repo',
    sessionId: FRESH_UUID,
    maxTurns: 6,
    binary: WINDOWS ? 'C:\\opt\\grok.exe' : '/opt/grok',
    platform: process.platform,
    promptBytes: Buffer.from('body'),
    promptFilePath: WINDOWS ? 'C:\\tmp\\x.prompt' : '/tmp/x.prompt',
    ...overrides,
  }).args;
}

function replaceValue(args, flag, value) {
  const mutated = [...args];
  mutated[mutated.indexOf(flag) + 1] = value;
  return mutated;
}

function occurrences(args, token) {
  return args.filter((candidate) => candidate === token).length;
}

// ---------------------------------------------------------------------------
// D11 / D12 — argv construction.
// ---------------------------------------------------------------------------

test('every constructed Grok argv carries one adjacent --model grok-4.6 pair, no -m, and the preventive read-only controls', async () => {
  const fixture = harness('grok-argv-shape');
  const result = await runGrokReviewer(fixture.seams);

  assert.equal(result.status, 'success');
  assert.equal(fixture.calls.length, 1);
  const { args } = fixture.calls[0];

  assert.equal(occurrences(args, '--model'), 1);
  assert.equal(args[args.indexOf('--model') + 1], GROK_AUTHORIZED_MODEL);
  assert.equal(occurrences(args, '-m'), 0);
  assert.equal(tokenValue(args, '--permission-mode'), 'plan');
  assert.equal(tokenValue(args, '--sandbox'), 'read-only');
  assert.equal(tokenValue(args, '--cwd'), fixture.root);
  assert.equal(occurrences(args, '--output-format'), 1);
  assert.equal(tokenValue(args, '--output-format'), 'plain');
  assert.equal(result.argv_sha256, sha256(Buffer.from(JSON.stringify(args), 'utf8')));
});

test('argv construction throws when the resolved model is not exactly grok-4.6, whatever its source', () => {
  const base = {
    effort: 'high',
    projectRoot: '/repo',
    sessionId: FRESH_UUID,
    binary: '/opt/grok',
    platform: 'linux',
    promptBytes: Buffer.from('body'),
    promptFilePath: '/tmp/x.prompt',
  };
  for (const model of [
    null,
    undefined,
    '',
    'grok-4.5',
    'Grok-4.6',
    'grok-4.6 ',
    ' grok-4.6',
    'grok-4.6\n',
    'grok-4.6;rm -rf /',
    'grok-4.6 ',
    'GROK-4.6',
    'grok',
  ]) {
    assert.throws(
      () => buildGrokArgv({ ...base, model }),
      /ERROR_UNSUPPORTED_MODEL/u,
      `model ${JSON.stringify(model)} must be refused, never blanked`,
    );
  }
});

test('no fallback authority can substitute the Grok model', async () => {
  for (const allowFallback of [false, true]) {
    const fixture = harness(`grok-no-fallback-${allowFallback}`);
    fixture.seams.executionPlan = {
      ...plannedRoute(fixture.binary, {
        resolved: { model: 'grok-4.5', effort: 'high' },
        allow_fallback: allowFallback,
      }),
    };
    await assert.rejects(
      () => runGrokReviewer(fixture.seams),
      /ERROR_UNSUPPORTED_MODEL/u,
    );
    assert.equal(fixture.calls.length, 0);
  }
});

test('terminal argv validation rejects duplicate --model, an appended -m, and a token between --model and its value', () => {
  const valid = validArgv();
  assert.deepEqual(validateGrokArgv(valid).model, GROK_AUTHORIZED_MODEL);

  assert.throws(
    () => validateGrokArgv([...valid, '--model', GROK_AUTHORIZED_MODEL]),
    /ERROR_FORBIDDEN_GROK_ARGV|exactly once/u,
  );
  // Named by the forbidden list, not merely unknown to the grammar: the two
  // layers are independent, and the short alias must stay refused even if the
  // grammar later admits a flag spelled that way.
  assert.throws(
    () => validateGrokArgv([...valid, '-m', GROK_AUTHORIZED_MODEL]),
    /ERROR_FORBIDDEN_GROK_ARGV: -m — this token is forbidden/u,
  );
  const separated = [...valid];
  separated.splice(separated.indexOf('--model') + 1, 0, '--verbose');
  assert.throws(() => validateGrokArgv(separated), /ERROR_/u);
});

test('--reasoning-effort appears exactly once inside low|medium|high (E3)', () => {
  const base = {
    model: GROK_AUTHORIZED_MODEL,
    projectRoot: '/repo',
    sessionId: FRESH_UUID,
    binary: '/opt/grok',
    platform: 'linux',
    promptBytes: Buffer.from('body'),
    promptFilePath: '/tmp/x.prompt',
  };
  for (const effort of GROK_SUPPORTED_EFFORTS) {
    const built = buildGrokArgv({ ...base, effort });
    assert.equal(occurrences(built.args, '--reasoning-effort'), 1);
    assert.equal(tokenValue(built.args, '--reasoning-effort'), effort);
  }
  for (const effort of [null, undefined, '', 'xhigh', 'max', 'minimal', 'HIGH', 'high ']) {
    assert.throws(
      () => buildGrokArgv({ ...base, effort }),
      /ERROR_UNSUPPORTED_EFFORT/u,
      `effort ${JSON.stringify(effort)} must be a construction error, never an omitted flag`,
    );
  }
  const valid = validArgv();
  assert.throws(
    () => validateGrokArgv([...valid, '--reasoning-effort', 'low']),
    /exactly once/u,
  );
  assert.throws(
    () => validateGrokArgv(replaceValue(valid, '--reasoning-effort', 'xhigh')),
    /reasoning-effort/u,
  );
});

test('no constructed Grok argv contains a forbidden token and terminal validation rejects each one', async () => {
  const fixture = harness('grok-forbidden-tokens');
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'success');
  const { args } = fixture.calls[0];
  for (const token of [
    '--dangerously-skip-permissions',
    '--always-approve',
    '--allow',
    '--allowedTools',
    '--no-plan',
    '--restore-code',
    '-w',
    '--worktree',
  ]) {
    assert.equal(occurrences(args, token), 0, `${token} must never be constructed`);
    assert.throws(
      () => validateGrokArgv([...args, token]),
      /ERROR_FORBIDDEN_GROK_ARGV/u,
      `${token} must be rejected at terminal argv validation`,
    );
  }
});

test('the argv grammar is closed: an unlisted flag is refused even though no forbidden list names it', () => {
  const valid = validArgv();
  for (const unknown of ['--verbose', '--print', '--experimental-anything', '-x', '--sandbox-profile']) {
    assert.throws(
      () => validateGrokArgv([...valid, unknown]),
      /unknown token in flag position/u,
      `${unknown} must be refused by the closed grammar, not merely absent from the forbidden list`,
    );
  }
  assert.throws(
    () => validateGrokArgv([...valid, '--single']),
    /flag has no adjacent value/u,
  );
});

test('a forbidden token inside the prompt value is not mistaken for a flag', () => {
  const built = buildGrokArgv({
    model: GROK_AUTHORIZED_MODEL,
    effort: 'low',
    projectRoot: '/repo',
    sessionId: FRESH_UUID,
    binary: '/opt/grok',
    platform: 'linux',
    promptBytes: Buffer.from('the reviewer must never pass --dangerously-skip-permissions or -w'),
    promptFilePath: '/tmp/x.prompt',
  });
  assert.equal(built.transport, 'inline');
  assert.equal(validateGrokArgv(built.args).model, GROK_AUTHORIZED_MODEL);
});

test('GROK_SANDBOX in the parent environment does not reach the child', async () => {
  const fixture = harness('grok-sandbox-scrub');
  const parentEnv = { PATH: '/usr/bin', GROK_SANDBOX: 'workspace-write', HOME: '/home/x' };
  fixture.seams.env = parentEnv;
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'success');
  const childEnv = fixture.calls[0].options.env;
  assert.ok(!Object.keys(childEnv).some((key) => key.toLowerCase() === 'grok_sandbox'));
  assert.equal(childEnv.PATH, '/usr/bin');
  assert.equal(parentEnv.GROK_SANDBOX, 'workspace-write', 'the parent environment must not be mutated');
});

// ---------------------------------------------------------------------------
// I26 / D12 — conversation isolation.
// ---------------------------------------------------------------------------

test('every attempt carries one bridge-generated fresh UUID plus --no-memory and --no-subagents', async () => {
  const fixture = harness('grok-session-isolation');
  const result = await runGrokReviewer(fixture.seams);

  assert.equal(fixture.uuids.length, 1, 'randomUUID must be called exactly once per attempt');
  const { args } = fixture.calls[0];
  assert.equal(occurrences(args, '--session-id'), 1);
  assert.equal(tokenValue(args, '--session-id'), FRESH_UUID);
  assert.equal(occurrences(args, '--no-memory'), 1);
  assert.equal(occurrences(args, '--no-subagents'), 1);
  assert.deepEqual(result.session_isolation, {
    session_id: FRESH_UUID,
    fresh: true,
    memory: 'disabled',
    subagents: 'disabled',
  });
});

test('a caller-supplied session id or any resume/reuse/continue/fork/memory/subagent option is refused', async () => {
  for (const [key, value] of [
    ['sessionId', FRESH_UUID],
    ['resume', FRESH_UUID],
    ['resumeSessionId', FRESH_UUID],
    ['continue', true],
    ['continueSession', true],
    ['forkSession', true],
    ['reuseSession', true],
    ['memory', true],
    ['experimentalMemory', true],
    ['agents', ['a']],
    ['agent', 'a'],
    ['noMemory', false],
    ['noSubagents', false],
    ['extraArgs', ['--resume']],
    ['args', ['--resume']],
  ]) {
    const fixture = harness(`grok-session-refuse-${key}`);
    await assert.rejects(
      () => runGrokReviewer({ ...fixture.seams, [key]: value }),
      /ERROR_FORBIDDEN_GROK_SESSION_OPTION/u,
      `${key} must be refused`,
    );
    assert.equal(fixture.calls.length, 0, `${key} must not reach a spawn`);
    assert.equal(fixture.uuids.length, 0, `${key} must not reach session creation`);
  }
});

test('terminal argv validation rejects every session escape hatch', () => {
  const valid = validArgv();
  for (const escape of [
    ['--resume', FRESH_UUID],
    ['-r', FRESH_UUID],
    ['--continue'],
    ['-c'],
    ['--fork-session'],
    ['--experimental-memory'],
    ['--agents', 'x'],
    ['--agent', 'x'],
  ]) {
    assert.throws(
      () => validateGrokArgv([...valid, ...escape]),
      /ERROR_FORBIDDEN_GROK_ARGV/u,
      `${escape[0]} must be rejected`,
    );
  }
  assert.throws(
    () => validateGrokArgv(replaceValue(valid, '--session-id', 'not-a-uuid')),
    /session-id/u,
  );
});

test('a session id that is not a canonical UUID never reaches a spawn', async () => {
  for (const generated of ['not-a-uuid', '', null, `${FRESH_UUID}extra`, FRESH_UUID.toUpperCase()]) {
    const fixture = harness('grok-session-id-shape');
    fixture.seams.uuidGenerator = () => generated;
    await assert.rejects(
      () => runGrokReviewer(fixture.seams),
      /ERROR_INVALID_GROK_SESSION_ID|ERROR_FORBIDDEN_GROK_ARGV: --session-id/u,
      `${JSON.stringify(generated)} must be refused`,
    );
    assert.equal(fixture.calls.length, 0);
  }
});

test('an unsupported-model stderr terminates as failed with no second spawn', async () => {
  const fixture = harness('grok-no-retry', { behavior: 'unsupported-model' });
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'failed');
  assert.equal(fixture.calls.length, 1, 'D11 P5: there is no retry path at all');
  assert.equal(fixture.uuids.length, 1, 'no second session may be created');
  assert.equal(result.error_code, 'ERROR_UNSUPPORTED_MODEL');
});

test('a malformed report normalizes to null and downgrades success to failed', async () => {
  const fixture = harness('grok-malformed-report', { behavior: 'malformed' });
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'failed');
  assert.equal(result.report, null);
  assert.equal(result.contributes_vote, false);
});

// ---------------------------------------------------------------------------
// D8 — lossless prompt transport through the shared module.
// ---------------------------------------------------------------------------

test('a below-budget prompt goes inline and an above-budget prompt goes to --prompt-file, never truncated', async () => {
  const small = harness('grok-transport-inline', { body: 'tiny body\n' });
  const smallResult = await runGrokReviewer(small.seams);
  assert.equal(smallResult.status, 'success');
  assert.equal(smallResult.prompt_transport, 'inline');
  assert.equal(occurrences(small.calls[0].args, '--single'), 1);
  assert.equal(occurrences(small.calls[0].args, '--prompt-file'), 0);
  const inlinePrompt = tokenValue(small.calls[0].args, '--single');
  assert.ok(inlinePrompt.endsWith('tiny body\n'), 'no byte may be dropped');
  assert.equal(smallResult.prompt_sha256, sha256(Buffer.from(inlinePrompt, 'utf8')));

  const bodyBytes = 'x'.repeat(200 * 1024);
  const large = harness('grok-transport-file', { body: bodyBytes });
  const largeResult = await runGrokReviewer(large.seams);
  assert.equal(largeResult.status, 'success');
  assert.equal(largeResult.prompt_transport, 'prompt-file');
  assert.equal(occurrences(large.calls[0].args, '--prompt-file'), 1);
  assert.equal(occurrences(large.calls[0].args, '--single'), 0);
  assert.equal(largeResult.truncated, false);
  assert.ok(largeResult.prompt_bytes > 200 * 1024);

  const derived = tokenValue(large.calls[0].args, '--prompt-file');
  assert.equal(existsSync(derived), false, 'owner-checked cleanup removes the derived file');
  assert.equal(existsSync(dirname(derived)), false, 'and its own private directory');
});

test('the derived prompt file holds the exact composed bytes while the child runs', async () => {
  const bodyBytes = 'y'.repeat(200 * 1024);
  const fixture = harness('grok-transport-bytes', { body: bodyBytes });
  let observed = null;
  const original = fixture.seams.processRunner;
  fixture.seams.processRunner = async (command, args, options) => {
    const path = args[args.indexOf('--prompt-file') + 1];
    observed = readFileSync(path);
    return original(command, args, options);
  };
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'success');
  assert.notEqual(observed, null);
  assert.equal(sha256(observed), result.prompt_sha256);
  assert.equal(observed.length, result.prompt_bytes);
  assert.ok(observed.toString('utf8').endsWith(bodyBytes));
});

test('the bridge takes its host budget from lib/prompt-transport.mjs rather than duplicating it', () => {
  const source = readFileSync(bridgePath, 'utf8');
  assert.match(source, /from '\.\/lib\/prompt-transport\.mjs'/u);
  assert.match(source, /selectPromptTransport/u);
  for (const duplicated of ['32_767', '32767', '8_191', '8191', '120 * 1024']) {
    assert.equal(
      source.includes(duplicated),
      false,
      `the bridge must not restate the host budget constant ${duplicated}`,
    );
  }
});

// ---------------------------------------------------------------------------
// D18 — sealed compatibility evidence, consumed and never re-probed.
// ---------------------------------------------------------------------------

test('missing, malformed, or seal-mismatched compatibility evidence fails before privacy, prompt, fingerprint, session and spawn', async () => {
  const cases = [
    ['missing', null],
    ['undefined', undefined],
    ['not an object', 'sealed'],
    ['malformed', { schema_version: '1.0' }],
    ['seal-mismatched', 'seal-mismatch'],
    ['downgraded version', 'version-downgrade'],
  ];
  for (const [label, mutation] of cases) {
    const fixture = harness(`grok-carrier-${label.replace(/\s+/gu, '-')}`);
    const plan = { ...fixture.seams.executionPlan };
    if (mutation === 'seal-mismatch') {
      plan.grokCompatibilityEvidence = {
        ...sealedCarrier(fixture.binary),
        executable_size: 13,
      };
    } else if (mutation === 'version-downgrade') {
      plan.grokCompatibilityEvidence = {
        ...sealedCarrier(fixture.binary),
        version: '1.0.3',
      };
    } else {
      plan.grokCompatibilityEvidence = mutation;
    }
    await assert.rejects(
      () => runGrokReviewer({ ...fixture.seams, executionPlan: plan }),
      /ERROR_INCOMPATIBLE_GROK_CLI/u,
      `${label} evidence must fail closed`,
    );
    assert.equal(fixture.privacyCalls.length, 0, `${label}: zero privacy calls`);
    assert.equal(fixture.fingerprints.length, 0, `${label}: zero fingerprint calls`);
    assert.equal(fixture.uuids.length, 0, `${label}: zero session creations`);
    assert.equal(fixture.calls.length, 0, `${label}: zero provider spawns`);
    assert.equal(existsSync(fixture.outputFile), false, `${label}: zero published output`);
    assert.deepEqual(
      readdirSync(fixture.root).sort(),
      [WINDOWS ? 'grok.exe' : 'grok', 'payload.md'].sort(),
      `${label}: zero prompt composition artifacts`,
    );
  }
});

test('the bridge passes the sealed prepared chain into every runner call and re-probes nothing', async () => {
  const fixture = harness('grok-chain-consumer');
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'success');
  assert.equal(fixture.calls.length, 1, 'the bridge is the probe consumer, never a second producer');
  const expected = fixture.seams.executionPlan.grokCompatibilityEvidence.prepared_spawn_chain;
  assert.deepEqual(fixture.calls[0].options.expectedPreparedSpawnChain, expected);
  assert.equal(fixture.calls[0].command, fixture.binary, 'the sealed launcher is the spawn target');
  assert.deepEqual(result.compatibility, {
    version: '1.0.4',
    version_build: 'd846eb93d94d',
    evidence_sha256: fixture.seams.executionPlan.grokCompatibilityEvidence.evidence_sha256,
    chain_sha256: expected.chain_sha256,
  });
});

test('a binary that disagrees with the sealed launcher is refused', async () => {
  const fixture = harness('grok-launcher-substitution');
  await assert.rejects(
    () => runGrokReviewer({ ...fixture.seams, binary: join(fixture.root, 'other-grok') }),
    /ERROR_INCOMPATIBLE_GROK_CLI/u,
  );
  assert.equal(fixture.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Fingerprints and the privacy re-check.
// ---------------------------------------------------------------------------

test('pre and post fingerprints use identical options and drift marks the attempt mutated with no vote', async () => {
  const fixture = harness('grok-fingerprint-drift');
  fixture.driftAfterFirstCapture();
  const result = await runGrokReviewer(fixture.seams);

  assert.equal(fixture.fingerprints.length, 2);
  assert.deepEqual(fixture.fingerprints[0], fixture.fingerprints[1]);
  assert.deepEqual(fixture.fingerprints[0], {
    repo: fixture.root,
    pluginRoot,
    mode: 'hybrid',
  });
  assert.equal(result.status, 'mutated');
  assert.equal(result.mutation, true);
  assert.equal(result.contributes_vote, false);
  assert.equal(readFileSync(`${fixture.outputFile}.status`, 'utf8').trim(), 'mutated');
});

test('the bridge refuses to run when the privacy outcome changes between the two preflights', async () => {
  const fixture = harness('grok-privacy-change');
  let call = 0;
  fixture.seams.privacyPreparer = async (options) => {
    fixture.privacyCalls.push(options);
    call += 1;
    return call === 1
      ? { outcome: 'auto_ack', fingerprint: 'privacy-1', hits: [], error: null }
      : { outcome: 'needs_approval', fingerprint: 'privacy-2', hits: ['.env'], error: null };
  };
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'failed');
  assert.equal(result.attempted, false);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.uuids.length, 0, 'no session is created once privacy has changed');
});

test('the bridge refuses to run when the privacy fingerprint changes while the outcome stays accepted', async () => {
  const fixture = harness('grok-privacy-fingerprint-drift');
  let call = 0;
  fixture.seams.privacyPreparer = async (options) => {
    fixture.privacyCalls.push(options);
    call += 1;
    // Both preflights are accepted; only the sensitive-file fingerprint moved,
    // which is exactly the case an outcome-only comparison would let through.
    return { outcome: 'auto_ack', fingerprint: `privacy-${call}`, hits: [], error: null };
  };
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'failed');
  assert.equal(result.attempted, false);
  assert.equal(fixture.privacyCalls.length, 2);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.uuids.length, 0);
});

test('a declined privacy outcome stops before fingerprint, prompt, session and spawn', async () => {
  const fixture = harness('grok-privacy-declined');
  fixture.seams.privacyPreparer = async (options) => {
    fixture.privacyCalls.push(options);
    return { outcome: 'declined', fingerprint: 'privacy-1', hits: ['.env'], error: null };
  };
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'failed');
  assert.equal(result.privacyOutcome, 'declined');
  assert.equal(fixture.fingerprints.length, 0);
  assert.equal(fixture.uuids.length, 0);
  assert.equal(fixture.calls.length, 0);
});

// ---------------------------------------------------------------------------
// CLI contract and the SLICE-008 absence conditions.
// ---------------------------------------------------------------------------

test('the Grok CLI accepts exactly one execution source paired with --reviewer-id', () => {
  assert.deepEqual(
    parseGrokCli(['--execution-route-json', '{"reviewer_id":"grok"}', '--reviewer-id', 'grok']),
    { executionRouteJson: '{"reviewer_id":"grok"}', reviewerId: 'grok' },
  );
  assert.deepEqual(
    parseGrokCli(['--routing-plan', 'routing.json', '--reviewer-id', 'grok']),
    { routingPlan: 'routing.json', reviewerId: 'grok' },
  );
  for (const argv of [
    ['--routing-plan', 'routing.json'],
    ['--execution-route-json', '{}'],
    ['--reviewer-id', 'grok'],
    ['--routing-plan', 'routing.json', '--execution-route-json', '{}', '--reviewer-id', 'grok'],
    ['--routing-plan', '', '--reviewer-id', 'grok'],
    ['--execution-route-json', '{}', '--reviewer-id', ''],
  ]) {
    assert.throws(
      () => parseGrokCli(argv),
      /exactly one execution source|non-empty/u,
      `${JSON.stringify(argv)} must be refused`,
    );
  }
});

test('D9: the Grok path ships no shell bridge', () => {
  assert.equal(existsSync(join(pluginRoot, 'hooks', 'scripts', 'run-grok-reviewer.sh')), false);
  const shells = readdirSync(join(pluginRoot, 'hooks', 'scripts'))
    .filter((entry) => entry.startsWith('run-grok') && entry.endsWith('.sh'));
  assert.deepEqual(shells, []);
});

test('a timeout and an auth stderr map to their own terminal statuses, not to success', () => {
  const timedOut = grokTesting.terminalStatus({
    mutation: false,
    processResult: {
      code: 124, timedOut: true, stdout: Buffer.from(REPORT), stderr: Buffer.alloc(0),
    },
  });
  assert.equal(timedOut, 'timeout');
  const unauthenticated = grokTesting.terminalStatus({
    mutation: false,
    processResult: {
      code: 7,
      timedOut: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('Authentication failed\n'),
    },
  });
  assert.equal(unauthenticated, 'not_authenticated');
});

test('build-reviewer-payload.mjs gains no Artifact Gate injection', () => {
  const source = readFileSync(join(pluginRoot, 'hooks', 'scripts', 'build-reviewer-payload.mjs'), 'utf8');
  for (const token of ['Artifact Gate', 'parseArtifactGate', 'buildReportContract', 'artifact_gate']) {
    assert.equal(
      source.includes(token),
      false,
      `the payload builder must not inject ${token} — D16 has exactly one injection site`,
    );
  }
});
