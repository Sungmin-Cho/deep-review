// SLICE-008a — the Grok bridge core: argv construction (D11/D12/E3), session
// isolation (I26), prompt transport (D8) and sealed compatibility evidence
// (D18). The D16 Artifact Gate is owned by SLICE-008b.
//
// SLICE-008c added the bridge's half of the containment contract: it consumes
// the owner-bound `containment_ready_token` and never establishes readiness,
// and it admits a post-fingerprint or a sibling only behind the retained
// owner's proof of whole-tree termination. Containment itself — the platform
// gate, the preflight, the owner and the reason carrier — lives in
// `tests/grok-containment.test.js`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { canonicalStringify } from '../hooks/scripts/lib/grok-compatibility-carrier.mjs';
import { parseExecutionRoute } from '../hooks/scripts/lib/execution-plan.mjs';
import {
  GROK_CONTAINMENT_HELPER_FAILED,
  GROK_INVALID_LIFECYCLE,
  preflightGrokContainment,
  __testing as supervisorTesting,
} from '../hooks/scripts/lib/grok-process-supervisor.mjs';
import { OWNER_ID_PATTERN } from '../hooks/scripts/lib/grok-owner-record.mjs';
import {
  GROK_AUTHORIZED_MODEL,
  GROK_SUPPORTED_EFFORTS,
  buildGrokArgv,
  parseCli as parseGrokCli,
  runBridgeCli,
  runGrokReviewer,
  validateGrokArgv,
  __testing as grokTesting,
} from '../hooks/scripts/run-grok-reviewer.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bridgePath = join(pluginRoot, 'hooks', 'scripts', 'run-grok-reviewer.mjs');
const WINDOWS = process.platform === 'win32';
const require = createRequire(import.meta.url);
const { stubNativeRoot } = require('./helpers/native-stub.cjs');

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
// Containment (SLICE-008c). The bridge consumes an owner-bound
// `containment_ready_token` issued one layer up and never establishes
// `containment_ready` itself, so every harness carries one — and every runner
// result carries the owner-bound `termination_report` the serial gate needs.
// ---------------------------------------------------------------------------

const CONTAINMENT_OWNER = 'grok-containment-owner-1-6-00000004';
const CONTAINMENT_TOKEN = supervisorTesting.mintOwnerToken({
  platform: 'linux', arch: 'x64', ownerId: CONTAINMENT_OWNER, generation: 1, startedAt: 1_700_000_000_000,
});
test('the harness containment owner id matches the record grammar', () => {
  assert.match(CONTAINMENT_OWNER, OWNER_ID_PATTERN);
});

function terminationReport(overrides = {}) {
  return {
    owner_id: CONTAINMENT_OWNER,
    generation: 1,
    live_members: 0,
    member_pids: [],
    observed_at: 1_700_000_000_100,
    ...overrides,
  };
}

function contained(result, overrides = {}) {
  return {
    ...result,
    termination_confirmed: true,
    termination_report: terminationReport(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Seams. Every one counts its calls so an ordering polarity can assert zero.
// ---------------------------------------------------------------------------

function harness(label, { body = 'review this diff\n', behavior = 'success', lifecycleOverride = {} } = {}) {
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
    containmentToken: CONTAINMENT_TOKEN,
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
        return contained({
          code: 2,
          timedOut: false,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('unsupported model value grok-4.6\n'),
        });
      }
      if (behavior === 'malformed') {
        return contained({
          code: 0,
          timedOut: false,
          stdout: Buffer.from('not a report at all\n'),
          stderr: Buffer.alloc(0),
        });
      }
      return contained({
        code: 0,
        timedOut: false,
        stdout: Buffer.from(REPORT, 'utf8'),
        stderr: Buffer.alloc(0),
      }, lifecycleOverride);
    },
  };

  return {
    root,
    projectRoot: root,
    binary,
    promptFile,
    outputFile,
    route: grokRoute(binary),
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
    'grok-4.6\0',
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
// D21 / I41 (SLICE-008c) — the bridge consumes the owner-bound containment
// token and never establishes readiness itself.
// ---------------------------------------------------------------------------

function zeroDownstream(fixture, label) {
  assert.equal(fixture.privacyCalls.length, 0, `${label}: zero privacy/config work`);
  assert.equal(fixture.fingerprints.length, 0, `${label}: zero fingerprint`);
  assert.equal(fixture.uuids.length, 0, `${label}: zero UUID`);
  assert.equal(fixture.calls.length, 0, `${label}: zero provider-child calls`);
  assert.equal(existsSync(fixture.outputFile), false, `${label}: no output is published`);
}

test('missing or unsupported containment produces zero privacy, fingerprint, UUID, prompt and provider-child calls', async () => {
  const cases = [
    ['no token at all', undefined, /missing_containment_ready_token/u],
    ['an explicitly absent token', null, /missing_containment_ready_token/u],
    ['a token that is not ready', { ...CONTAINMENT_TOKEN, containment_ready: false }, /containment_not_ready/u],
    ['a forged owner binding', { ...CONTAINMENT_TOKEN, owner_id: 'grok-containment-owner-1-8-ffffffff' }, /foreign_containment_owner/u],
    ['an unsupported containment platform', { ...CONTAINMENT_TOKEN, platform: 'darwin', arch: 'arm64' }, /unsupported_grok_containment/u],
    ['a census mechanism that is not containment', { ...CONTAINMENT_TOKEN, mechanism: 'setsid-census' }, /unsupported_grok_containment/u],
  ];
  for (const [label, containmentToken, expected] of cases) {
    const fixture = harness(`grok-containment-${label.replaceAll(/[^a-z]+/gu, '-')}`);
    fixture.seams.containmentToken = containmentToken;
    await assert.rejects(() => runGrokReviewer(fixture.seams), expected, label);
    zeroDownstream(fixture, label);
  }
});

test('the bridge refuses before it even consumes the sealed compatibility carrier', async () => {
  const fixture = harness('grok-containment-precedes-carrier');
  fixture.seams.containmentToken = null;
  fixture.seams.executionPlan = { ...fixture.seams.executionPlan, grokCompatibilityEvidence: null };
  await assert.rejects(() => runGrokReviewer(fixture.seams), /ERROR_GROK_CONTAINMENT/u);
  zeroDownstream(fixture, 'containment precedes the carrier');
});

test('the owner-bound token reaches the contained runner unchanged', async () => {
  const fixture = harness('grok-containment-token-forwarded');
  await runGrokReviewer(fixture.seams);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].options.containmentToken, CONTAINMENT_TOKEN);
});

test('the Grok provider tree is launched only through the contained runner, never the shared one', async () => {
  const source = readFileSync(join(pluginRoot, 'hooks', 'scripts', 'run-grok-reviewer.mjs'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.match(code, /options\.processRunner \?\? runGrokContainedProcess/u);
  assert.equal(/\brunProcess\b/u.test(code), false,
    'the bridge does not reach the shared runner, whose semantics stay unchanged for its own callers');

  // And behaviourally: with no runner injected, the default is the contained
  // one, which refuses on a host that cannot contain a Grok tree. The shared
  // runner would instead return a result and the attempt would merely fail.
  const fixture = harness('grok-containment-default-runner');
  delete fixture.seams.processRunner;
  await assert.rejects(() => runGrokReviewer(fixture.seams), /ERROR_GROK_CONTAINMENT/u);
});

// ---------------------------------------------------------------------------
// D19 / I36 — post-fingerprint and sibling dispatch wait for the owner's proof.
// ---------------------------------------------------------------------------

test('an unconfirmed process-tree lifecycle is round-terminal and never captures a post-fingerprint', async () => {
  const cases = [
    ['no evidence at all', { termination_confirmed: undefined, termination_report: undefined }],
    ['a false claim', { termination_confirmed: false, termination_report: terminationReport() }],
    ['a claim with no owner-bound report', { termination_confirmed: true, termination_report: null }],
    ['a report from a foreign owner', { termination_confirmed: true, termination_report: terminationReport({ owner_id: 'other' }) }],
    ['a report from another generation', { termination_confirmed: true, termination_report: terminationReport({ generation: 7 }) }],
    ['surviving members', { termination_confirmed: true, termination_report: terminationReport({ live_members: 2, member_pids: [9, 10] }) }],
    ['a lost handshake', { termination_confirmed: true, termination_report: terminationReport({ handshake: 'lost' }) }],
    ['a deadline', { termination_confirmed: true, termination_report: terminationReport({ deadline_exceeded: true }) }],
  ];
  for (const [label, lifecycleOverride] of cases) {
    const fixture = harness(`grok-lifecycle-${label.replaceAll(/[^a-z]+/gu, '-')}`, { lifecycleOverride });
    const result = await runGrokReviewer(fixture.seams);
    assert.equal(result.status, 'failed', label);
    assert.equal(result.error_code, GROK_INVALID_LIFECYCLE, label);
    assert.equal(result.report, null, label);
    assert.equal(result.contributes_vote, false, label);
    assert.equal(result.containment.termination_confirmed, false, label);
    assert.equal(result.containment.diagnostic, 'lifecycle_unconfirmed', label);
    // The gate must stop the round: no sibling, no retry, no resume.
    assert.equal(result.containment.sibling_dispatch_allowed, false, label);
    assert.equal(result.containment.retry_allowed, false, label);
    assert.equal(result.containment.resume_allowed, false, label);
    // One fingerprint only — the pre-snapshot. The post-fingerprint is behind
    // the proof that never arrived.
    assert.equal(fixture.fingerprints.length, 1, `${label}: post-fingerprint must not run`);
    assert.equal(result.after, null, label);
  }
});

test('a confirmed owner-bound termination admits the post-fingerprint and a sibling', async () => {
  const fixture = harness('grok-lifecycle-confirmed');
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'success');
  assert.equal(result.containment.termination_confirmed, true);
  assert.equal(result.containment.sibling_dispatch_allowed, true);
  assert.equal(result.containment.owner_id, CONTAINMENT_OWNER);
  assert.equal(result.containment.mechanism, 'pid-namespace');
  assert.equal(result.containment.process_tree_termination.state, 'confirmed');
  assert.equal(result.containment.process_tree_termination.live_members, 0);
  assert.equal(fixture.fingerprints.length, 2);
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

test('build-reviewer-payload.mjs does not inject D16 into grok or agy payloads (T8)', async () => {
  const { buildReviewerPayload } = await import(
    pathToFileURL(join(pluginRoot, 'hooks', 'scripts', 'build-reviewer-payload.mjs')).href
  );
  const result = buildReviewerPayload({
    pluginRoot,
    diff: 'GROK_OR_AGY_DIFF',
  });
  const prompt = readFileSync(result.promptFile, 'utf8');
  assert.doesNotMatch(prompt, /===== OUTPUT CONTRACT =====/);
  assert.equal(prompt.trimEnd().endsWith('GROK_OR_AGY_DIFF'), true);
});

// ---------------------------------------------------------------------------
// D16 / I16 (SLICE-008b) — the bridge's returned-report validation wired to
// the canonical `parseArtifactGate`. Zero, two, and count-mismatched gates
// on a document-phase report all fail closed; a single count-matched gate is
// accepted; and any gate on a code-phase report is rejected because the
// document parser is not applicable there.
// ---------------------------------------------------------------------------

const GATE_FINDING = Object.freeze({
  id: 'DOC-1', severity: 'warning', stage: 'implementation_verification', acceptance_evidence: ['evidence'],
});

function gateSectionLines(findings, { schemaVersion = 1 } = {}) {
  return [
    '## Artifact Gate',
    '```json',
    JSON.stringify({ schema_version: schemaVersion, findings }, null, 2),
    '```',
  ];
}

function gateBearingReport({ warning = 1, gates = [] } = {}) {
  const verdict = warning > 0 ? 'CONCERN' : 'APPROVE';
  return [
    '# Deep Review Report — 2026-08-19',
    '',
    '## Summary',
    '',
    `- **Verdict**: ${verdict}`,
    '- **Review Mode**: 5-way',
    `- **Issues**: 🔴 0건, 🟡 ${warning}건, ℹ️ 0건`,
    '',
    ...gates,
    '',
    '## Code Review',
    '',
    '### 🔴 Critical',
    '',
    'None.',
    '',
    '### 🟡 Warning',
    '',
    warning > 0 ? Array.from({ length: warning }, (_, i) => `- Finding ${i + 1}.`).join('\n') : 'None.',
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
}

function documentHarness(label, reportBody, overrides = {}) {
  const fixture = harness(label);
  fixture.seams.executionPlan = plannedRoute(fixture.binary, {
    artifact_phase: 'document',
    document_review_mode: 'full-readiness',
    ...overrides,
  });
  fixture.seams.processRunner = async (command, args, options) => {
    fixture.calls.push({ command, args, options });
    return contained({
      code: 0,
      timedOut: false,
      stdout: Buffer.from(reportBody, 'utf8'),
      stderr: Buffer.alloc(0),
    });
  };
  return fixture;
}

test('T-GATE-1: a returned document report with zero gates is failed', async () => {
  const fixture = documentHarness('grok-gate-missing', gateBearingReport({ warning: 1, gates: [] }));
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'failed');
  assert.equal(result.report, null);
  assert.equal(result.contributes_vote, false);
});

test('T-GATE-2: a returned document report with two gates is failed', async () => {
  const fixture = documentHarness('grok-gate-duplicate', gateBearingReport({
    warning: 1,
    gates: [
      ...gateSectionLines([GATE_FINDING]),
      '',
      ...gateSectionLines([{ ...GATE_FINDING, id: 'DOC-2' }]),
    ],
  }));
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'failed');
  assert.equal(result.report, null);
});

test('T-GATE-6: a returned document report whose gate JSON finding counts differ from the Summary Issues counts is failed', async () => {
  const fixture = documentHarness('grok-gate-count-mismatch', gateBearingReport({
    warning: 1,
    gates: gateSectionLines([GATE_FINDING, { ...GATE_FINDING, id: 'DOC-2' }]),
  }));
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'failed');
  assert.equal(result.report, null);
});

test('a returned document report with one count-matched gate is accepted', async () => {
  const fixture = documentHarness('grok-gate-accepted', gateBearingReport({
    warning: 1,
    gates: gateSectionLines([GATE_FINDING]),
  }));
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'success');
  assert.notEqual(result.report, null);
  assert.equal(result.contributes_vote, true);
});

test('a code-phase report carrying a gate is failed', async () => {
  const fixture = harness('grok-gate-code-phase');
  // The default fixture route is artifact_phase: 'implementation'.
  fixture.seams.processRunner = async () => contained({
    code: 0,
    timedOut: false,
    stdout: Buffer.from(gateBearingReport({ warning: 1, gates: gateSectionLines([GATE_FINDING]) }), 'utf8'),
    stderr: Buffer.alloc(0),
  });
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'failed');
  assert.equal(result.report, null);
});

test('the composed Grok prompt contains exactly one gate because exactly one layer injects it', async () => {
  const fixture = documentHarness('grok-gate-single-injection', gateBearingReport({
    warning: 1,
    gates: gateSectionLines([GATE_FINDING]),
  }));
  const result = await runGrokReviewer(fixture.seams);
  assert.equal(result.status, 'success');
  const { args } = fixture.calls[0];
  const promptBytes = args.includes('--single')
    ? Buffer.from(args[args.indexOf('--single') + 1], 'utf8')
    : readFileSync(args[args.indexOf('--prompt-file') + 1]);
  const gateHeadings = [...promptBytes.toString('utf8').matchAll(/^## Artifact Gate[ \t]*$/gmu)];
  assert.equal(gateHeadings.length, 1);
});

function minimalBridgeArgv() {
  const root = workspace('bridge-cli-argv');
  const promptFile = join(root, 'payload.md');
  writeFileSync(promptFile, 'review this diff\n');
  return ['--project-root', root, '--plugin-root', pluginRoot, '--prompt-file', promptFile, '--output', join(root, 'grok.out'),
    '--execution-route-json', JSON.stringify(grokRoute(launcherPath(root))), '--reviewer-id', 'grok',
    '--containment-ready-token-json', JSON.stringify(CONTAINMENT_TOKEN), '--timeout-seconds', '5'];
}

function bridgeArgvFor(fixture, token) {
  return ['--project-root', fixture.projectRoot, '--plugin-root', pluginRoot, '--prompt-file', fixture.promptFile, '--output', fixture.outputFile,
    '--execution-route-json', JSON.stringify(fixture.route), '--reviewer-id', 'grok', '--containment-ready-token-json', JSON.stringify(token), '--timeout-seconds', '5'];
}

// mutateAfterPreflight runs once the token exists (so the preflight passed on
// a healthy tree and only ADMISSION sees the defect). productionMode builds a
// distinct plugin fixture whose own native directory is the one-helper tree,
// preflights it WITH that exact locator, and admits WITHOUT a locator.
async function expectCliRefusal(stub, detail, { pluginRoot: otherPluginRoot = null, productionMode = false, mutateAfterPreflight = null } = {}) {
  const tmpRoot = workspace(`grok-admission-${detail}-tmp`);
  let admissionPluginRoot = stub.root;
  let nativeDirectory = stub.root;
  if (productionMode) {
    admissionPluginRoot = workspace(`grok-admission-${detail}-plugin`);
    nativeDirectory = join(admissionPluginRoot, 'hooks', 'scripts', 'lib', 'native');
    mkdirSync(dirname(nativeDirectory), { recursive: true });
    renameSync(stub.root, nativeDirectory);
  }
  const preflight = preflightGrokContainment({ platform: 'linux', arch: 'x64', nativeDirectory, pluginRoot: admissionPluginRoot, tmpRoot, enabledPlatforms: ['linux/x64'] });
  assert.equal(preflight.ok, true, `${detail}: the preflight must pass on the healthy tree (got ${JSON.stringify(preflight)})`);
  if (mutateAfterPreflight) mutateAfterPreflight(nativeDirectory);
  const context = { platform: 'linux', arch: 'x64', pluginRoot: otherPluginRoot ?? admissionPluginRoot, enabledPlatforms: ['linux/x64'], tmpRoot };
  if (!productionMode) context.nativeDirectory = nativeDirectory;
  const runner = supervisorTesting.createContainedRunner(context);
  const e2e = harness(`grok-admission-cli-${detail}`);
  e2e.seams.processRunner = (command, args, options) => runner.run(command, args, options);
  const out = [];
  const err = [];
  const exit = await runBridgeCli(bridgeArgvFor(e2e, preflight.containment_ready_token), { run: (options) => runGrokReviewer({ ...e2e.seams, containmentToken: options.containmentToken }), stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  assert.equal(exit, 3, detail);
  const refusal = JSON.parse(out.at(-1).trim());
  assert.deepEqual([refusal.stage, refusal.reason, refusal.detail], ['bridge_admission', GROK_CONTAINMENT_HELPER_FAILED, detail], detail);
  assert.equal(existsSync(join(tmpRoot, 'deep-review-grok-containment', `${preflight.containment_ready_token.owner_id}.json`)), true, `${detail}: record left in place`);
}

test('T-OWN-13: terminalStatus reads the auth and unsupported-model patterns from stdout on a merged channel', async () => {
  const auth = harness('grok-merged-auth', { behavior: 'failure' });
  auth.seams.processRunner = async () => contained({ code: 1, timedOut: false, stdout: Buffer.from('Reauthentication required\n'), stderr: Buffer.alloc(0), provider_channel: 'merged-owner-stderr' });
  const result = await runGrokReviewer(auth.seams);
  assert.equal(result.status, 'not_authenticated');
  assert.ok(result.warnings.includes('provider_channel: merged-owner-stderr'));
  const tail = readFileSync(`${auth.outputFile}.stderr-tail`, 'utf8');
  assert.match(tail, /provider_channel: merged-owner-stderr/u);
  assert.doesNotMatch(tail, /Reauthentication/u, 'the merged channel is the report, not the diagnostics tail');
  const model = harness('grok-merged-model', { behavior: 'failure' });
  model.seams.processRunner = async () => contained({ code: 1, timedOut: false, stdout: Buffer.from('error: unsupported model grok-4.6\n'), stderr: Buffer.alloc(0), provider_channel: 'merged-owner-stderr' });
  assert.equal((await runGrokReviewer(model.seams)).error_code, 'ERROR_UNSUPPORTED_MODEL');
});

test('T-OWN-16: the bridge CLI serialises a containment admission refusal as stdout JSON with exit 3 and leaves the record', async () => {
  const optionOut = [];
  const optionErr = [];
  const optionExit = await runBridgeCli(minimalBridgeArgv(), {
    run: async (options) => {
      assert.equal(typeof options.executionPlan, 'object');
      assert.equal(options.containmentToken.owner_id, CONTAINMENT_TOKEN.owner_id);
      return { attempted: true, code: 7 };
    },
    stdout: { write: (s) => optionOut.push(s) },
    stderr: { write: (s) => optionErr.push(s) },
  });
  assert.equal(optionExit, 7);
  assert.equal(JSON.parse(optionOut.at(-1).trim()).code, 7);
  assert.deepEqual(optionErr, []);

  const cases = ['foreign_containment_owner', 'missing_grok_containment_helper', GROK_CONTAINMENT_HELPER_FAILED, 'containment_owner_not_live', 'unsupported_prepared_chain'];
  for (const reason of cases) {
    const out = []; const err = [];
    const refusal = Object.assign(new Error(`ERROR_GROK_CONTAINMENT: ${reason}`), { reason, detail: 'x', containment_refusal: { ok: false, stage: 'bridge_admission', reason, detail: 'x', remedy: null, owner_id: 'grok-containment-owner-1-1-0badf00d' } });
    const seams = { run: async () => { throw refusal; }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
    const exit = await runBridgeCli(minimalBridgeArgv(), seams);
    assert.equal(exit, 3, reason);
    assert.deepEqual(err, [], reason);
    assert.equal(out.length, 1, reason);
    assert.deepEqual(JSON.parse(out[0].trim()), refusal.containment_refusal, reason);
  }
  const other = { run: async () => { throw new Error('ERROR_GROK_PROMPT_TRANSPORT: boom'); }, stdout: { write: () => assert.fail('no stdout') }, stderr: { write: () => {} } };
  assert.equal(await runBridgeCli(minimalBridgeArgv(), other), 2);
  // a tampered seal through the REAL run path with a live record: typed, exit 3, record untouched
  const tamperStub = stubNativeRoot({ platform: 'linux', arch: 'x64' });
  if (!tamperStub.skipReason) {
    const tmpRoot = workspace('grok-cli-tampered-tmp');
    const preflight = preflightGrokContainment({ platform: 'linux', arch: 'x64', nativeDirectory: tamperStub.root, pluginRoot: tamperStub.root, tmpRoot, enabledPlatforms: ['linux/x64'] });
    const tampered = { ...preflight.containment_ready_token, token_sha256: 'f'.repeat(64) };
    const e2e = harness('grok-cli-tampered');
    const out = []; const err = [];
    const exit = await runBridgeCli(bridgeArgvFor(e2e, tampered), { run: (options) => runGrokReviewer({ ...e2e.seams, containmentToken: options.containmentToken }), stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
    assert.equal(exit, 3);
    assert.deepEqual(err, []);
    assert.equal(JSON.parse(out.at(-1).trim()).stage, 'bridge_admission');
    assert.equal(existsSync(join(tmpRoot, 'deep-review-grok-containment', `${preflight.containment_ready_token.owner_id}.json`)), true);
  }
  // end to end: the real default runner, a token naming a foreign helper path, privacy auto_ack through the harness
  const fixture = harness('grok-admission-e2e');
  delete fixture.seams.processRunner;
  fixture.seams.containmentToken = { ...CONTAINMENT_TOKEN, helper_path: '/elsewhere/helper', token_sha256: supervisorTesting.tokenSeal({ ...CONTAINMENT_TOKEN, helper_path: '/elsewhere/helper' }) };
  await assert.rejects(() => runGrokReviewer(fixture.seams), (error) => error.containment_refusal?.stage === 'bridge_admission'
    && ['foreign_containment_owner', 'unsupported_grok_containment'].includes(error.containment_refusal.reason));
  // end to end through a test runner with a real stub root: every integrity_* detail and record_digest_mismatch, record left in place
  const integrityStub = stubNativeRoot({ platform: 'linux', arch: 'x64' });
  if (!integrityStub.skipReason) {
    const tmpRoot = workspace('grok-admission-integrity-tmp');
    const preflight = preflightGrokContainment({ platform: 'linux', arch: 'x64', nativeDirectory: integrityStub.root, pluginRoot: integrityStub.root, tmpRoot, enabledPlatforms: ['linux/x64'] });
    assert.equal(preflight.ok, true);
    const runner = supervisorTesting.createContainedRunner({ platform: 'linux', arch: 'x64', nativeDirectory: integrityStub.root, pluginRoot: integrityStub.root, enabledPlatforms: ['linux/x64'], tmpRoot });
    const recordPath = join(tmpRoot, 'deep-review-grok-containment', `${preflight.containment_ready_token.owner_id}.json`);
    const sums = join(integrityStub.root, 'SHA256SUMS');
    const original = readFileSync(sums, 'utf8');
    for (const [detail, mutate] of [
      ['integrity_mismatch', () => writeFileSync(sums, original.replace(integrityStub.helperSha256, 'f'.repeat(64)))],
      ['integrity_sums_missing', () => rmSync(sums)],
      ['integrity_sums_malformed', () => writeFileSync(sums, 'garbage\n')],
      ['integrity_not_listed', () => writeFileSync(sums, original.replace(integrityStub.helperSha256, '0'.repeat(64)))],
    ]) {
      mutate();
      const e2e = harness(`grok-admission-${detail}`);
      e2e.seams.processRunner = (command, args, options) => runner.run(command, args, options);
      const out = []; const err = [];
      const exit = await runBridgeCli(bridgeArgvFor(e2e, preflight.containment_ready_token), { run: (options) => runGrokReviewer({ ...e2e.seams, containmentToken: options.containmentToken }), stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
      assert.equal(exit, 3, detail);
      assert.deepEqual(err, [], detail);
      const refusal = JSON.parse(out.at(-1).trim());
      assert.deepEqual([refusal.ok, refusal.stage, refusal.reason, refusal.detail], [false, 'bridge_admission', GROK_CONTAINMENT_HELPER_FAILED, detail], detail);
      assert.equal(existsSync(recordPath), true, `${detail}: record left in place`);
      writeFileSync(sums, original);
    }
    if (process.platform !== 'win32') {
      await expectCliRefusal(stubNativeRoot({ platform: 'linux', arch: 'x64' }), 'integrity_sums_symlink', { mutateAfterPreflight: (native) => { const text = readFileSync(join(native, 'SHA256SUMS'), 'utf8'); rmSync(join(native, 'SHA256SUMS')); writeFileSync(join(native, 'real-sums'), text); symlinkSync(join(native, 'real-sums'), join(native, 'SHA256SUMS')); } });
      await expectCliRefusal(stubNativeRoot({ platform: 'linux', arch: 'x64' }), 'integrity_symlink_component', { mutateAfterPreflight: (native) => { renameSync(join(native, 'linux-x64'), join(native, 'real-linux')); symlinkSync(join(native, 'real-linux'), join(native, 'linux-x64')); } });
    }
    await expectCliRefusal(stubNativeRoot({ platform: 'linux', arch: 'x64' }), 'integrity_outside_root', { pluginRoot: workspace('grok-admission-other-root') });
    await expectCliRefusal(stubNativeRoot({ platform: 'linux', arch: 'x64' }), 'integrity_not_release', { productionMode: true });
    await expectCliRefusal(stubNativeRoot({ platform: 'linux', arch: 'x64' }), 'record_digest_mismatch', { mutateAfterPreflight: (native) => { const helper = join(native, 'linux-x64', 'grok-linux-pidns-owner'); const before = createHash('sha256').update(readFileSync(helper)).digest('hex'); writeFileSync(helper, Buffer.concat([readFileSync(helper), Buffer.from('\n')])); const after = createHash('sha256').update(readFileSync(helper)).digest('hex'); writeFileSync(join(native, 'SHA256SUMS'), readFileSync(join(native, 'SHA256SUMS'), 'utf8').replace(before, after)); } });
  }
});
