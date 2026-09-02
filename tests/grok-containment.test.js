// SLICE-008c — D19/D20/D21 and I35/I36/I38/I41: enforceable containment,
// process-tree lifecycle, and the unsupported-containment reason carrier.
//
// This machine is darwin/arm64. D21 (design.md:3114) states plainly that macOS
// is unsupported for Grok provider-content spawn: there is no shipped macOS
// helper and no macOS success polarity. So the polarity proven by execution
// here is the whole fail-closed path. The two supported-platform success
// polarities (Linux `CLONE_NEWPID` through the PID-namespace helper, native
// Windows `CreateProcessW` + `CREATE_SUSPENDED` + `AssignProcessToJobObject`
// before resume) are enrolled below with their contract asserted and the launch
// itself marked an explicit platform skip — a simulated branch is not proof.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
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

import {
  GROK_CONTAINMENT_HELPER_FAILED,
  GROK_CONTAINMENT_INVENTORY,
  GROK_CONTAINMENT_PROTOCOL_VERSION,
  GROK_CONTAINMENT_TOKEN_TTL_MS,
  GROK_ENABLED_PLATFORMS,
  GROK_INVALID_LIFECYCLE,
  GROK_LIFECYCLE_UNCONFIRMED,
  GROK_OWNER_START_DEADLINE_MS,
  GROK_TREE_HARD_DEADLINE_MS,
  GROK_TREE_POLL_MS,
  UNSUPPORTED_GROK_CONTAINMENT,
  assertContainmentReadyToken,
  evaluateContainedLaunchAdmission,
  evaluateTerminationReport,
  isGrokContainmentOwnerLive,
  isGrokContainmentPlatformSupported,
  isGrokPlatformEnabled,
  preflightGrokContainment,
  releaseGrokContainment,
  resolveGrokContainmentPlatform,
  runGrokContainedProcess,
  runGrokContainedProcessSync,
  scrubGrokEnvironment,
  __testing as supervisorTesting,
} from '../hooks/scripts/lib/grok-process-supervisor.mjs';
import {
  OWNER_ID_PATTERN,
  readOwnerRecord,
  recordDirectory,
  validateOwnerRecord,
} from '../hooks/scripts/lib/grok-owner-record.mjs';
import {
  classifyContainmentRelease,
  withGrokContainment,
} from '../hooks/scripts/grok-containment-preflight.mjs';
import { buildCapabilities } from '../hooks/scripts/lib/capability-registry.mjs';
import { buildRoutingPlan } from '../hooks/scripts/lib/model-router.mjs';
import { planReviewerAssignments } from '../hooks/scripts/lib/adaptive-review-routing.mjs';
import { synthesizeReviewRound } from '../hooks/scripts/review-synthesis.mjs';
import {
  NATIVE_INVENTORY_PATHS,
  NATIVE_PLACEHOLDER_DIGEST,
  evaluateHelperArtifact,
  nativeTreeState,
  parseSha256Sums,
} from '../hooks/scripts/lib/grok-native-artifact.mjs';
import {
  createGrokCarrierCoordinator,
  evaluateCoordinatorContainment,
} from '../hooks/scripts/lib/grok-carrier-coordinator.mjs';
import { parseOwnerControlLines } from '../hooks/scripts/lib/grok-owner-control.mjs';
import {
  comparePreparedSpawnChains,
  closedPreparedChainResult,
  signalPosixProcessGroup,
  isPosixProcessGroupGone,
  POSIX_TERMINATION_GRACE_MS,
  prepareSpawnChain,
} from '../hooks/scripts/lib/process.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_COMMIT = '1c3ef2d';
const HOST_CONTAINMENT_GATE = resolveGrokContainmentPlatform();
const SUPPORTED_HERE = HOST_CONTAINMENT_GATE.supported;
const PLATFORM_SKIP = `${HOST_CONTAINMENT_GATE.key} is not a Grok containment platform`;
const LINUX = { platform: 'linux', arch: 'x64' };
const ALL_INVENTORIED = ['linux/x64', 'win32/x64'];
function gateFor(nativeDirectory, { platform = 'linux', arch = 'x64', enabledPlatforms = ALL_INVENTORIED } = {}) {
  return resolveGrokContainmentPlatform({ platform, arch, nativeDirectory, enabledPlatforms });
}
const ARTIFACT_OK = () => ({ present: true, executable: true, integrity: 'ok', helper_sha256: 'a'.repeat(64), real_path: '/fixture/helper', detail: null });
const require = createRequire(import.meta.url);
const { stubNativeRoot, ARGV_MATRIX, HOST_STUB_PLATFORM, HOST_STUB_ARCH, INVENTORY } = require('./helpers/native-stub.cjs');
const HOST_STUB_KEY = `${HOST_STUB_PLATFORM}/${HOST_STUB_ARCH}`;

const READY = '{"protocol_version":"1.0","handshake":"containment_ready","containment_ready":true,"mechanism":"pid-namespace"}';
const REPORT = '{"protocol_version":"1.0","handshake":"termination_report","live_members":0,"member_pids":[]}';

function workspace(label) {
  return mkdtempSync(join(tmpdir(), `deep-review-${label}-`));
}

function sourceEntriesBelow(directory, prefix = '') {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return sourceEntriesBelow(join(directory, entry.name), relativePath);
    return [relativePath];
  });
}

test('the native source inventory observes symlinks instead of silently dropping them', {
  skip: process.platform === 'win32' ? 'file symlink creation is not guaranteed for unprivileged Windows CI' : false,
}, (t) => {
  const root = workspace('native-symlink-inventory');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'source.c'), 'int main(void) { return 0; }\n');
  symlinkSync('source.c', join(root, 'SHA256SUMS'));
  assert.deepEqual(sourceEntriesBelow(root).sort(), ['SHA256SUMS', 'source.c']);
});

// ---------------------------------------------------------------------------
// D21 — the platform/arch gate, evaluated before anything else exists.
// ---------------------------------------------------------------------------

test('the containment inventory names exactly the two supported platforms and never a macOS helper', () => {
  assert.deepEqual(Object.keys(GROK_CONTAINMENT_INVENTORY).sort(), ['linux/x64', 'win32/x64']);
  assert.equal(GROK_CONTAINMENT_INVENTORY['linux/x64'].mechanism, 'pid-namespace');
  assert.equal(GROK_CONTAINMENT_INVENTORY['win32/x64'].mechanism, 'job-object');
  const serialized = JSON.stringify(GROK_CONTAINMENT_INVENTORY);
  assert.equal(/darwin|macos|mach|libproc/iu.test(serialized), false,
    'the supervisor must never invent a macOS containment helper');
});

test('resolveGrokContainmentPlatform refuses every unsupported platform/arch pair with the canonical reason', () => {
  const unsupported = [
    ['darwin', 'arm64'], ['darwin', 'x64'],
    ['linux', 'arm64'], ['linux', 'ia32'],
    ['win32', 'arm64'], ['win32', 'ia32'],
    ['freebsd', 'x64'], ['sunos', 'x64'], ['aix', 'ppc64'],
  ];
  for (const [platform, arch] of unsupported) {
    const gate = resolveGrokContainmentPlatform({ platform, arch });
    assert.equal(gate.supported, false, `${platform}/${arch} must not be a containment platform`);
    assert.equal(gate.inventoried, false, `${platform}/${arch} is not inventoried`);
    assert.equal(gate.reason, UNSUPPORTED_GROK_CONTAINMENT, `${platform}/${arch}`);
    assert.equal(gate.detail, null, `${platform}/${arch}`);
    assert.equal(gate.mechanism, null);
    assert.equal(gate.helper_path, null);
  }
  const linux = resolveGrokContainmentPlatform({ platform: 'linux', arch: 'x64' });
  assert.equal(linux.supported, true, 'linux/x64 is enabled');
  assert.equal(linux.inventoried, true);
  assert.equal(linux.reason, null);
  assert.equal(linux.detail, null);
  assert.equal(linux.mechanism, 'pid-namespace');
  assert.equal(typeof linux.helper_path, 'string');
  const winPending = resolveGrokContainmentPlatform({ platform: 'win32', arch: 'x64' });
  assert.equal(winPending.supported, false, 'win32/x64 is inventoried but not enabled');
  assert.equal(winPending.inventoried, true);
  assert.equal(winPending.reason, UNSUPPORTED_GROK_CONTAINMENT);
  assert.equal(winPending.detail, 'platform_verification_pending');
  assert.equal(winPending.mechanism, 'job-object');
  const winEnabled = resolveGrokContainmentPlatform({
    platform: 'win32', arch: 'x64', enabledPlatforms: ALL_INVENTORIED,
  });
  assert.equal(winEnabled.supported, true, 'win32/x64 is supported only when enabledPlatforms admits it');
  assert.equal(winEnabled.inventoried, true);
  assert.equal(winEnabled.reason, null);
  assert.equal(winEnabled.detail, null);
  assert.equal(winEnabled.mechanism, 'job-object');
});

function linkFile(target, path) {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'file' : undefined);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return false;
    throw error;
  }
}
function linkDirectory(target, path) {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

function nativeFixture(label, {
  linux = true, win = true, sums = 'match', extra = null,
  symlinkSums = false, symlinkHelper = false, mode = 0o755, hostPlaceholder = false,
} = {}) {
  const root = workspace(label);
  const write = (rel, bytes) => {
    const p = join(root, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
    return p;
  };
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  if (linux) {
    const p = write('linux-x64/grok-linux-pidns-owner', 'linux-bytes');
    if (process.platform !== 'win32') chmodSync(p, mode);
  }
  if (win) write('win32-x64/grok-win32-job-owner.exe', 'win-bytes');
  let skipped = false;
  if (sums !== 'absent') {
    const linuxDigest = hostPlaceholder ? NATIVE_PLACEHOLDER_DIGEST
      : sums === 'wrong' ? 'f'.repeat(64)
        : linux ? digest('linux-bytes') : NATIVE_PLACEHOLDER_DIGEST;
    const lines = [
      `${linuxDigest}  linux-x64/grok-linux-pidns-owner`,
      `${win ? digest('win-bytes') : NATIVE_PLACEHOLDER_DIGEST}  win32-x64/grok-win32-job-owner.exe`,
    ];
    if (extra) lines.push(`${'a'.repeat(64)}  ${extra}`);
    const text = sums === 'crlf' ? `${lines.join('\r\n')}\r\n`
      : sums === 'truncated' ? lines[0].slice(0, 40)
        : `${lines.join('\n')}\n`;
    if (symlinkSums) {
      writeFileSync(join(root, 'real-sums'), text);
      skipped = !linkFile(join(root, 'real-sums'), join(root, 'SHA256SUMS'));
    } else writeFileSync(join(root, 'SHA256SUMS'), text);
  }
  if (symlinkHelper) {
    rmSync(join(root, 'linux-x64', 'grok-linux-pidns-owner'));
    writeFileSync(join(root, 'elsewhere'), 'linux-bytes');
    skipped = skipped || !linkFile(join(root, 'elsewhere'), join(root, 'linux-x64', 'grok-linux-pidns-owner'));
  }
  return { root, skipped };
}

test('T-PACK-3: the plugin native tree is source (or release under DEEP_REVIEW_PACKED_ROOT), and every partial fixture is invalid', (t) => {
  const packedRoot = process.env.DEEP_REVIEW_PACKED_ROOT;
  const pluginNative = join(packedRoot ?? pluginRoot, 'hooks', 'scripts', 'lib', 'native');
  const state = nativeTreeState(pluginNative);
  if (packedRoot) assert.equal(state, 'release', 'a packed/release tree must be complete');
  else assert.equal(state, 'source', 'I-E1-1: the source tree carries no built artifact (a tag checkout is tested with DEEP_REVIEW_PACKED_ROOT set)');
  assert.deepEqual([...NATIVE_INVENTORY_PATHS].sort(), ['linux-x64/grok-linux-pidns-owner', 'win32-x64/grok-win32-job-owner.exe']);
  assert.equal(nativeTreeState(nativeFixture('t-pack-3-release').root), 'release');
  assert.equal(nativeTreeState(nativeFixture('t-pack-3-crlf', { sums: 'crlf' }).root), 'release');
  const invalid = [
    ['missing sums', { sums: 'absent' }], ['wrong digest', { sums: 'wrong' }], ['truncated sums', { sums: 'truncated' }],
    ['extra path', { extra: 'linux-x64/other' }], ['one helper with placeholder', { win: false }], ['placeholder for a present helper', { hostPlaceholder: true }],
    ['symlinked sums', { symlinkSums: true }], ['symlinked helper', { symlinkHelper: true }],
  ];
  for (const [label, options] of invalid) {
    const fixture = nativeFixture(`t-pack-3-${label.replaceAll(' ', '-')}`, options);
    if (fixture.skipped) { t.diagnostic(`${label}: file symlinks need elevation on this host; skipped`); continue; }
    assert.equal(nativeTreeState(fixture.root), 'invalid', label);
  }
  if (process.platform !== 'win32') {
    for (const mode of [0o644, 0o777, 0o751, 0o711]) {
      assert.equal(
        nativeTreeState(nativeFixture(`t-pack-3-mode-${mode.toString(8)}`, { mode }).root),
        'invalid',
        `Linux helper must be exactly 0755, not ${mode.toString(8)}`,
      );
    }
  }
  const buildNativeSource = readFileSync(join(pluginRoot, 'scripts', 'build-native.mjs'), 'utf8');
  assert.match(buildNativeSource, /export const NATIVE_PLACEHOLDER_DIGEST = '0'\.repeat\(64\)/u);
  assert.equal(NATIVE_PLACEHOLDER_DIGEST, '0'.repeat(64));
});

test('parseSha256Sums accepts the inventory in either separator form and refuses everything else', () => {
  const [linux, win] = ['linux-x64/grok-linux-pidns-owner', 'win32-x64/grok-win32-job-owner.exe'];
  const ok = parseSha256Sums(`${'a'.repeat(64)}  ${linux}\r\n${'b'.repeat(64)} *${win}\r\n`);
  assert.equal(ok.ok, true);
  assert.equal(ok.entries.get(linux), 'a'.repeat(64));
  assert.equal(parseSha256Sums(`${'a'.repeat(64)}  ${linux}\n`).reason, 'not_inventory');
  assert.equal(parseSha256Sums(`${'a'.repeat(64)}  ${linux}\n${'b'.repeat(64)}  ${win}\n${'c'.repeat(64)}  other\n`).reason, 'not_inventory');
  assert.equal(parseSha256Sums(`${'A'.repeat(64)}  ${linux}\n${'b'.repeat(64)}  ${win}\n`).reason, 'malformed');
  assert.equal(parseSha256Sums(`${'a'.repeat(64)}  ${linux}\n${'a'.repeat(64)}  ${linux}\n`).reason, 'malformed');
  assert.equal(parseSha256Sums('').reason, 'malformed');
});

test('preflightGrokContainment on this host refuses before provider spawn and issues no containment_ready_token', () => {
  const preflight = preflightGrokContainment();
  assert.equal(preflight.ok, false);
  assert.equal(preflight.containment_ready, false);
  assert.equal(preflight.containment_ready_token, null);
  assert.equal(
    preflight.reason,
    SUPPORTED_HERE ? 'missing_grok_containment_helper' : UNSUPPORTED_GROK_CONTAINMENT,
  );
  assert.equal(preflight.platform, process.platform);
  assert.equal(preflight.arch, process.arch);
});

test('an unsupported platform and a supported platform with no loadable artifact are distinct refusals', () => {
  const macos = preflightGrokContainment({ platform: 'darwin', arch: 'arm64' });
  assert.equal(macos.ok, false);
  assert.equal(macos.reason, UNSUPPORTED_GROK_CONTAINMENT);
  assert.equal(macos.containment_ready_token, null);
  assert.equal(macos.mechanism, null);

  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64']]) {
    const supported = preflightGrokContainment({ platform, arch, enabledPlatforms: ALL_INVENTORIED });
    assert.equal(supported.ok, false, 'the inventoried helper is not in this tree');
    assert.equal(supported.reason, 'missing_grok_containment_helper');
    assert.equal(supported.containment_ready_token, null);
    assert.notEqual(supported.reason, UNSUPPORTED_GROK_CONTAINMENT,
      'a supported platform missing its artifact is not an unsupported platform');
  }
});

test('an unsupported-platform preflight observes zero executable lookup and zero child spawn', () => {
  const events = [];
  const preflight = preflightGrokContainment({
    platform: 'darwin',
    arch: 'arm64',
    // Every side-effecting dependency the supervisor could reach is
    // instrumented. A refusal that is evaluated from process.platform before
    // executable lookup touches none of them.
    executableResolver: (name) => { events.push(`lookup ${name}`); return null; },
    helperSpawner: (...args) => { events.push(`child ${JSON.stringify(args)}`); return null; },
    ownerIdGenerator: () => { events.push('owner'); return 'grok-containment-owner-1-1-0000000a'; },
  });
  assert.equal(preflight.ok, false);
  assert.deepEqual(events, []);
});

test('releaseGrokContainment on a refused preflight releases nothing and never claims containment', () => {
  const released = releaseGrokContainment(null, { reason: 'no_launch' });
  assert.equal(released.released, false);
  assert.equal(released.reason, 'no_owner');
  assert.equal(released.containment_ready, false);
});

const TOKEN_OWNER_ID = 'grok-containment-owner-1-3-00000001';
const LIFE_OWNER_ID = 'grok-containment-owner-1-4-00000002';
const RELEASE_OWNER_ID = 'grok-containment-owner-1-5-00000003';

// ---------------------------------------------------------------------------
// D21 — the bounded owner-handshake constants and the token contract.
// ---------------------------------------------------------------------------

test('the owner handshake uses the D20 bounded polling constants', () => {
  assert.equal(GROK_TREE_POLL_MS, 10);
  assert.equal(GROK_TREE_HARD_DEADLINE_MS, 1000);
});

test('assertContainmentReadyToken refuses a missing, unready, foreign-sealed or malformed token', () => {
  const valid = supervisorTesting.mintOwnerToken({
    platform: 'linux', arch: 'x64', ownerId: TOKEN_OWNER_ID, generation: 1, startedAt: 1000,
  });
  assert.equal(assertContainmentReadyToken(valid).owner_id, TOKEN_OWNER_ID);
  assert.match(valid.owner_id, OWNER_ID_PATTERN);
  assert.equal(valid.protocol_version, GROK_CONTAINMENT_PROTOCOL_VERSION);

  const refusals = [
    [undefined, 'missing'],
    [null, 'null'],
    ['token', 'string'],
    [{ ...valid, protocol_version: '9.9' }, 'wrong protocol'],
    [{ ...valid, containment_ready: false }, 'not ready'],
    [{ ...valid, owner_id: 'grok-containment-owner-1-8-ffffffff' }, 'foreign owner breaks the seal'],
    [{ ...valid, mechanism: 'setsid-census' }, 'census is not containment'],
    [{ ...valid, token_sha256: 'f'.repeat(64) }, 'forged seal'],
    [{ ...valid, generation: 0 }, 'non-positive generation'],
    [{ ...valid, helper_path: '' }, 'no helper'],
    [{ ...valid, owner_id: 'owner-x', token_sha256: supervisorTesting.tokenSeal({ ...valid, owner_id: 'owner-x' }) }, 'bad owner grammar'],
  ];
  for (const [token, label] of refusals) {
    assert.throws(
      () => assertContainmentReadyToken(token),
      /ERROR_GROK_CONTAINMENT/u,
      `${label} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// D19 / I36 / I38 / T-LIFE-8 — termination is proven, never assumed.
// ---------------------------------------------------------------------------

function liveToken(overrides = {}) {
  return supervisorTesting.mintOwnerToken({
    platform: 'linux', arch: 'x64', ownerId: LIFE_OWNER_ID, generation: 2, startedAt: 5000, ...overrides,
  });
}

test('termination_confirmed is true only for an owner-bound report of zero live members', () => {
  const token = liveToken();
  assert.match(token.owner_id, OWNER_ID_PATTERN);
  const confirmed = evaluateTerminationReport({
    token,
    report: { owner_id: LIFE_OWNER_ID, generation: 2, live_members: 0, member_pids: [], observed_at: 5100 },
  });
  assert.equal(confirmed.termination_confirmed, true);
  assert.equal(confirmed.process_tree_termination.state, 'confirmed');
  assert.equal(confirmed.process_tree_termination.observer, 'grok-process-supervisor');
  assert.equal(confirmed.process_tree_termination.live_members, 0);
  assert.equal(confirmed.diagnostic, null);
  assert.equal(confirmed.error_code, null);
});

test('every missing, foreign, nonzero, contradictory or lost-handshake report is lifecycle_unconfirmed', () => {
  const token = liveToken();
  const cases = [
    [undefined, 'missing_termination_report'],
    [null, 'missing_termination_report'],
    ['report', 'malformed_termination_report'],
    [{ owner_id: LIFE_OWNER_ID, generation: 2, live_members: 0 }, 'malformed_termination_report'],
    [{ owner_id: 'foreign', generation: 2, live_members: 0, member_pids: [], observed_at: 1 }, 'foreign_owner'],
    [{ owner_id: LIFE_OWNER_ID, generation: 9, live_members: 0, member_pids: [], observed_at: 1 }, 'foreign_owner'],
    [{ owner_id: LIFE_OWNER_ID, generation: 2, live_members: 3, member_pids: [11, 12, 13], observed_at: 1 }, 'live_members_remain'],
    [{ owner_id: LIFE_OWNER_ID, generation: 2, live_members: 0, member_pids: [7], observed_at: 1 }, 'member_pids_contradict_live_members'],
    [{ owner_id: LIFE_OWNER_ID, generation: 2, live_members: 0, member_pids: [], observed_at: 1, handshake: 'lost' }, 'handshake_lost'],
    [{ owner_id: LIFE_OWNER_ID, generation: 2, live_members: 0, member_pids: [], observed_at: 1, deadline_exceeded: true }, 'hard_deadline_exceeded'],
  ];
  for (const [report, expected] of cases) {
    const outcome = evaluateTerminationReport({ token, report });
    assert.equal(outcome.termination_confirmed, false, `${expected} must not confirm`);
    assert.equal(outcome.process_tree_termination.state, 'unconfirmed', expected);
    assert.equal(outcome.diagnostic, GROK_LIFECYCLE_UNCONFIRMED, expected);
    assert.equal(outcome.error_code, GROK_INVALID_LIFECYCLE, expected);
    assert.equal(outcome.reason, expected);
  }
});

test('a report with no token to bind it to can never confirm termination', () => {
  const outcome = evaluateTerminationReport({
    token: null,
    report: { owner_id: 'anyone', generation: 1, live_members: 0, member_pids: [], observed_at: 1 },
  });
  assert.equal(outcome.termination_confirmed, false);
  assert.equal(outcome.error_code, GROK_INVALID_LIFECYCLE);
});

test('runGrokContainedProcess and runGrokContainedProcessSync refuse on this host before any child', async () => {
  const spawned = [];
  const token = SUPPORTED_HERE
    ? liveToken({
      platform: HOST_CONTAINMENT_GATE.platform,
      arch: HOST_CONTAINMENT_GATE.arch,
    })
    : liveToken();
  const options = {
    containmentToken: token,
    spawner: (...args) => { spawned.push(args); throw new Error('a refused containment must never spawn'); },
  };
  const expected = SUPPORTED_HERE
    ? /missing_grok_containment_helper/u
    : new RegExp(UNSUPPORTED_GROK_CONTAINMENT, 'u');
  await assert.rejects(() => runGrokContainedProcess('/opt/grok', ['--version'], options), expected);
  assert.throws(() => runGrokContainedProcessSync('/opt/grok', ['--version'], options), expected);
  assert.deepEqual(spawned, []);
});

test('a live retained owner still cannot launch on a host that cannot contain the tree', {
  skip: SUPPORTED_HERE ? 'this host is a declared containment platform' : false,
}, async () => {
  // A genuinely preflighted, registered, live owner for a supported platform.
  // Nothing about it is faked; the only thing standing between it and a launch
  // is that *this* host is not a containment platform, so that is the refusal.
  const preflight = preflightGrokContainment({
    platform: 'linux',
    arch: 'x64',
    helperArtifact: ARTIFACT_OK,
    executableResolver: (helperPath) => helperPath,
    helperSpawner: () => ({ ok: true }),
    ownerIdGenerator: () => 'grok-containment-owner-1-2-0000000b',
    now: () => 4242,
  });
  assert.equal(preflight.ok, true, 'the owner registry accepted a real supported-platform owner');
  try {
    await assert.rejects(
      () => runGrokContainedProcess('/opt/grok', [], { containmentToken: preflight.containment_ready_token }),
      new RegExp(UNSUPPORTED_GROK_CONTAINMENT, 'u'),
    );
  } finally {
    releaseGrokContainment(preflight.containment_ready_token, { reason: 'no_launch' });
  }
});

test('the contained-launch admission refuses an uncontainable host, a foreign token, a released owner and a missing helper', () => {
  const linuxGate = resolveGrokContainmentPlatform({ platform: 'linux', arch: 'x64' });
  const macosGate = resolveGrokContainmentPlatform({ platform: 'darwin', arch: 'arm64' });
  const token = liveToken();
  const all = { token, hostGate: linuxGate, ownerLive: true, helperPresent: true };

  assert.equal(evaluateContainedLaunchAdmission({ ...all, hostGate: macosGate }).reason, UNSUPPORTED_GROK_CONTAINMENT);
  assert.equal(evaluateContainedLaunchAdmission({
    ...all,
    hostGate: resolveGrokContainmentPlatform({ platform: 'win32', arch: 'x64', enabledPlatforms: ALL_INVENTORIED }),
  }).reason, 'foreign_containment_owner');
  assert.equal(evaluateContainedLaunchAdmission({ ...all, ownerLive: false }).reason, 'containment_owner_not_live');
  assert.equal(evaluateContainedLaunchAdmission({ ...all, helperPresent: false }).reason, 'missing_grok_containment_helper');
  // Admitting the launch is a decision, not a launch: nothing is spawned here,
  // and the helper this decision presumes is not in the tree.
  assert.deepEqual(evaluateContainedLaunchAdmission(all), { ok: true, reason: null, detail: null });
});

test('the Grok contained runners refuse a missing token even before the platform gate is consulted', async () => {
  await assert.rejects(
    () => runGrokContainedProcess('/opt/grok', [], {}),
    /ERROR_GROK_CONTAINMENT/u,
  );
  assert.throws(() => runGrokContainedProcessSync('/opt/grok', [], {}), /ERROR_GROK_CONTAINMENT/u);
});

// The two supported-platform success polarities. Their contract is asserted
// here by execution; the contained launch itself is an explicit platform skip.
test('D21 Linux containment is CLONE_NEWPID through the inventoried PID-namespace helper', () => {
  const linux = GROK_CONTAINMENT_INVENTORY['linux/x64'];
  assert.deepEqual(linux.clone_flags, ['CLONE_NEWPID', 'CLONE_NEWUSER']);
  assert.equal(linux.source, 'grok-linux-pidns-owner.c');
  assert.equal(linux.helper, 'linux-x64/grok-linux-pidns-owner');
  assert.equal(linux.enumeration, 'namespace-member-set');
  assert.equal(/census|snapshot|setsid|start-time|subreaper|pidfd/iu.test(JSON.stringify(linux)), false,
    'snapshot census is not containment (I38)');
});

test('D21 native Windows containment assigns the Job Object before the suspended process resumes', () => {
  const win32 = GROK_CONTAINMENT_INVENTORY['win32/x64'];
  assert.equal(win32.source, 'grok-win32-job-owner.c');
  assert.equal(win32.helper, 'win32-x64/grok-win32-job-owner.exe');
  assert.equal(win32.enumeration, 'JobObjectBasicProcessIdList');
  const plan = win32.spawn_plan;
  assert.ok(plan.indexOf('CreateProcessW:CREATE_SUSPENDED') !== -1);
  assert.ok(
    plan.indexOf('AssignProcessToJobObject') < plan.indexOf('ResumeThread'),
    'ordinary spawn followed by later Job assignment is refused (D20)',
  );
  assert.deepEqual(win32.denied_limits, [
    'JOB_OBJECT_LIMIT_BREAKAWAY_OK',
    'JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK',
  ]);
  assert.ok(win32.applied_limits.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'));
});

function builtNativeRoot() {
  const host = resolveGrokContainmentPlatform({ enabledPlatforms: ALL_INVENTORIED });
  if (!host.inventoried) return { skip: PLATFORM_SKIP };
  const root = process.env.GROK_NATIVE_OUTPUT_ROOT;
  if (!root) return { skip: 'GROK_NATIVE_OUTPUT_ROOT is unset: no CI-built helper on this host' };
  const helper = join(root, ...GROK_CONTAINMENT_INVENTORY[host.key].helper.split('/'));
  if (!existsSync(helper) || !existsSync(join(root, 'SHA256SUMS'))) return { fail: `GROK_NATIVE_OUTPUT_ROOT is set but ${helper} or SHA256SUMS is missing` };
  return { root, host: resolveGrokContainmentPlatform({ nativeDirectory: root, enabledPlatforms: ALL_INVENTORIED }) };
}

function lifeContext(t, label) {
  const built = builtNativeRoot();
  if (built.skip) { t.skip(built.skip); return null; }
  if (built.fail) assert.fail(built.fail);
  const tmpRoot = workspace(`${label}-tmp`);
  const preflight = preflightGrokContainment({ platform: built.host.platform, arch: built.host.arch, nativeDirectory: built.root, pluginRoot: built.root, tmpRoot, enabledPlatforms: [built.host.key] });
  assert.equal(preflight.ok, true, JSON.stringify(preflight));
  const runner = supervisorTesting.createContainedRunner({ platform: built.host.platform, arch: built.host.arch, nativeDirectory: built.root, pluginRoot: built.root, enabledPlatforms: [built.host.key], tmpRoot });
  return { ...built, tmpRoot, preflight, runner, token: preflight.containment_ready_token, recordPath: join(tmpRoot, 'deep-review-grok-containment', `${preflight.containment_ready_token.owner_id}.json`) };
}

function providerScript(dir, body) {
  const file = join(dir, `provider-${Math.random().toString(16).slice(2, 8)}.cjs`);
  writeFileSync(file, body);
  return file;
}

async function launch(ctx, script, { timeoutMs = 20000, onSpawn } = {}) {
  const env = scrubGrokEnvironment(process.env);
  const chain = prepareSpawnChain(process.execPath, [script], { cwd: ctx.tmpRoot, env }).prepared_spawn_chain;
  return ctx.runner.run(process.execPath, [script], { cwd: ctx.tmpRoot, env, timeoutMs, expectedPreparedSpawnChain: chain, containmentToken: ctx.token, onSpawn });
}

const sleepAndMark = (marker, ms) => `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), ${ms})`;

test('T-LIFE-9: a contained launch waits for (Linux) or kills (Windows) an escaped descendant and reports zero members', async (t) => {
  const ctx = lifeContext(t, 't-life-9-escape'); if (!ctx) return;
  const marker = join(ctx.tmpRoot, 'escapee.marker');
  const script = providerScript(ctx.tmpRoot, `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(sleepAndMark(marker, 1000))}], { detached: true, stdio: 'ignore' }).unref();
    process.stdout.write('PROVIDER-RAN\\n');
    process.exit(0);
  `);
  const started = Date.now();
  const result = await launch(ctx, script);
  assert.match(result.stdout.toString('utf8'), /PROVIDER-RAN/u);
  assert.equal(result.termination_confirmed, true, JSON.stringify({ detail: result.detail, lines: result.control_lines }));
  assert.equal(result.termination_report.live_members, 0);
  if (process.platform === 'linux') { assert.ok(Date.now() - started >= 1000, 'namespace init waited for the escapee'); assert.equal(existsSync(marker), true); }
  else { await new Promise((r) => setTimeout(r, 3000)); assert.equal(existsSync(marker), false, 'the Job killed the escapee before it wrote'); }
  assert.equal(existsSync(ctx.recordPath), false, 'consumed at admission');
});

test('T-LIFE-9: a second admission after consume is refused (real helper)', async (t) => {
  const ctx = lifeContext(t, 't-life-9-second'); if (!ctx) return;
  const script = providerScript(ctx.tmpRoot, 'process.exit(0)');
  assert.equal((await launch(ctx, script)).termination_confirmed, true);
  await assert.rejects(() => launch(ctx, script), /containment_owner_not_live/u, 'second admission after consume');
});

test('T-LIFE-9: timeout leaves no survivor', async (t) => {
  const ctx = lifeContext(t, 't-life-9-timeout'); if (!ctx) return;
  const marker = join(ctx.tmpRoot, 'late.marker');
  const pidFile = join(ctx.tmpRoot, 'tree.pids');
  const script = providerScript(ctx.tmpRoot, `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(sleepAndMark(marker, 3000))}], { detached: true, stdio: 'ignore' });
    child.unref();
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ provider: process.pid, grandchild: child.pid }));
    setTimeout(() => {}, 30000);
  `);
  const pids = [];
  const result = await launch(ctx, script, { timeoutMs: 1000, onSpawn: (info) => pids.push(info.pid) });
  assert.deepEqual([result.timedOut, result.code, result.termination_confirmed], [true, 124, false]);
  await new Promise((r) => setTimeout(r, 5000));
  assert.equal(existsSync(marker), false, 'the grandchild never wrote after the tree was killed');
  const tree = JSON.parse(readFileSync(pidFile, 'utf8'));
  const isGone = (pid) => {
    try { process.kill(pid, 0); } catch { return true; }
    if (process.platform !== 'linux') return false;
    try {
      return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch { return true; }
  };
  for (const [label, pid] of [['helper', pids[0]], ['provider', tree.provider], ['grandchild', tree.grandchild]]) {
    assert.equal(isGone(pid), true, `${label} is gone`);
  }
  if (process.platform === 'linux') assert.equal(result.group_gone, true);
});

test('T-LIFE-9: killing the bridge process tears the whole tree down (parent leash)', async (t) => {
  const ctx = lifeContext(t, 't-life-9-crash'); if (!ctx) return;
  const marker = join(ctx.tmpRoot, 'orphan.marker');
  const pidFile = join(ctx.tmpRoot, 'helper.pid');
  const readyFile = join(ctx.tmpRoot, 'tree.ready');
  const script = providerScript(ctx.tmpRoot, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    // double-fork/setsid-style escapee: detached, unref'd, writes a marker after 5 s
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(sleepAndMark(marker, 5000))}], { detached: true, stdio: 'ignore' });
    grandchild.unref();
    // atomic ready record: provider and grandchild pids, written only once the grandchild exists
    fs.writeFileSync(${JSON.stringify(readyFile + '.tmp')}, JSON.stringify({ provider: process.pid, grandchild: grandchild.pid }));
    fs.renameSync(${JSON.stringify(readyFile + '.tmp')}, ${JSON.stringify(readyFile)});
    setTimeout(() => {}, 30000);
  `);
  const env = scrubGrokEnvironment(process.env);
  const chain = prepareSpawnChain(process.execPath, [script], { cwd: ctx.tmpRoot, env }).prepared_spawn_chain;
  const spec = join(ctx.tmpRoot, 'bridge-spec.json');   // by file, never on argv (Windows 32767-char command line)
  writeFileSync(spec, JSON.stringify({ context: { platform: ctx.host.platform, arch: ctx.host.arch, nativeDirectory: ctx.root, pluginRoot: ctx.root, enabledPlatforms: [ctx.host.key], tmpRoot: ctx.tmpRoot }, script, cwd: ctx.tmpRoot, env, chain, token: ctx.token, pidFile }));
  const bridge = spawn(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { __testing } from ${JSON.stringify(pathToFileURL(join(pluginRoot, 'hooks', 'scripts', 'lib', 'grok-process-supervisor.mjs')).href)};
    const spec = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const runner = __testing.createContainedRunner(spec.context);
    await runner.run(process.execPath, [spec.script], { cwd: spec.cwd, env: spec.env, timeoutMs: 60000, expectedPreparedSpawnChain: spec.chain, containmentToken: spec.token, onSpawn: (info) => writeFileSync(spec.pidFile, String(info.pid)) });
  `, spec], { stdio: 'ignore' });
  for (let i = 0; i < 200 && !(existsSync(pidFile) && existsSync(readyFile)); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(existsSync(pidFile), true, 'the bridge spawned the helper');
  assert.equal(existsSync(readyFile), true, 'the provider and its grandchild were running before the crash');
  const helperPid = Number(readFileSync(pidFile, 'utf8'));
  const tree = JSON.parse(readFileSync(readyFile, 'utf8'));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(tree.provider) && alive(tree.grandchild) && alive(helperPid), true, 'all three processes are alive before the crash');
  bridge.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 3000));
  for (const [label, pid] of [['helper', helperPid], ['provider', tree.provider], ['grandchild', tree.grandchild]]) {
    if (process.platform === 'linux') assert.equal(existsSync(`/proc/${pid}`), false, `${label} is gone`);
    else assert.equal(alive(pid), false, `${label} is gone`);
  }
  await new Promise((r) => setTimeout(r, 5000));
  assert.equal(existsSync(marker), false, 'no descendant survived the bridge');
});

test('T-LIFE-9: the argv matrix is refused by the real helper with exit 64, empty control stdout and no provider spawn', (t) => {
  const built = builtNativeRoot();
  if (built.skip) { t.skip(built.skip); return; }
  if (built.fail) assert.fail(built.fail);
  const helper = join(built.root, ...GROK_CONTAINMENT_INVENTORY[built.host.key].helper.split('/'));
  const dir = workspace('t-life-9-matrix');
  for (const row of ARGV_MATRIX) {
    const marker = join(dir, `${row.name.replaceAll(/\W+/gu, '-')}.marker`);
    const argv = row.withCommandMarker ? [...row.argv, '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] : row.argv;
    const run = spawnSync(helper, argv, { input: '', encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 64, `${row.name}: ${run.stderr}`);
    assert.equal(run.stdout, '', row.name);
    assert.equal(existsSync(marker), false, `${row.name}: the provider never ran`);
  }
});

test('T-LIFE-9: --parent-pid after -- is a command operand for the real helper', async (t) => {
  const ctx = lifeContext(t, 't-life-9-operand'); if (!ctx) return;
  const built = builtNativeRoot();
  const helper = join(built.root, ...GROK_CONTAINMENT_INVENTORY[built.host.key].helper.split('/'));
  const marker = join(ctx.tmpRoot, 'operand.argv');
  const probe = providerScript(ctx.tmpRoot, 'require("node:fs").writeFileSync(process.argv[2], process.argv.slice(2).join(" "))');
  const run = spawnSync(helper, ['--own-grok-tree', '--parent-pid', String(process.pid), '--', process.execPath, probe, marker, '--parent-pid', 'x'], { input: '', encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(readFileSync(marker, 'utf8'), /--parent-pid x/u, 'the operand reached the provider argv');
  assert.equal(parseOwnerControlLines(Buffer.from(run.stdout)).ok, true);
});

test('T-LIFE-9: provider exit 125 and 127 propagate with a confirmed report', async (t) => {
  for (const code of [125, 127]) {
    const ctx = lifeContext(t, `t-life-9-exit-${code}`); if (!ctx) return;
    const result = await launch(ctx, providerScript(ctx.tmpRoot, `process.exit(${code})`));
    assert.equal(result.code, code);
    assert.equal(result.termination_confirmed, true, JSON.stringify(result.control_lines));
  }
});

// ---------------------------------------------------------------------------
// D21 — the callable preflight owns the ordering and the release discipline.
// ---------------------------------------------------------------------------

test('withGrokContainment on a refused platform never runs the launch and issues no token', async () => {
  const events = [];
  const outcome = await withGrokContainment(
    () => { events.push('launch'); return { attempted: true }; },
    { platform: 'darwin', arch: 'arm64' },
  );
  assert.deepEqual(events, []);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, UNSUPPORTED_GROK_CONTAINMENT);
  assert.equal(outcome.containment_ready, false);
  assert.equal(outcome.containment_ready_token, null);
  assert.equal(outcome.launched, false);
});

test('classifyContainmentRelease names privacy decline, error and no-launch distinctly', () => {
  assert.equal(classifyContainmentRelease({ error: new Error('boom') }), 'error');
  assert.equal(classifyContainmentRelease({ result: { attempted: false, privacyOutcome: 'declined' } }), 'privacy_decline');
  assert.equal(classifyContainmentRelease({ result: { attempted: false, privacyOutcome: 'auto_ack' } }), 'no_launch');
  assert.equal(classifyContainmentRelease({ result: null }), 'no_launch');
  assert.equal(classifyContainmentRelease({ result: { attempted: true, privacyOutcome: 'auto_ack' } }), 'completed');
});

test('withGrokContainment releases the preflighted owner on privacy decline, on error and on no-launch', async () => {
  const token = liveToken({ ownerId: RELEASE_OWNER_ID });
  assert.match(token.owner_id, OWNER_ID_PATTERN);
  const stubPreflight = () => ({
    ok: true, containment_ready: true, containment_ready_token: token,
    reason: null, platform: 'linux', arch: 'x64', mechanism: 'pid-namespace',
  });

  for (const [label, launch, expected] of [
    ['privacy decline', async () => ({ attempted: false, privacyOutcome: 'declined' }), 'privacy_decline'],
    ['no launch', async () => ({ attempted: false, privacyOutcome: 'auto_ack' }), 'no_launch'],
    ['error', async () => { throw new Error('bridge exploded'); }, 'error'],
  ]) {
    const releases = [];
    const call = withGrokContainment(launch, {
      preflight: stubPreflight,
      release: (releasedToken, options) => {
        releases.push({ owner_id: releasedToken?.owner_id, reason: options.reason });
        return { released: true, reason: options.reason, owner_id: releasedToken?.owner_id };
      },
    });
    if (expected === 'error') {
      await assert.rejects(() => call, /bridge exploded/u, label);
    } else {
      await call;
    }
    assert.deepEqual(releases, [{ owner_id: RELEASE_OWNER_ID, reason: expected }], label);
  }
});

// ---------------------------------------------------------------------------
// The shortfall-to-reason carrier: four owners, in order.
// ---------------------------------------------------------------------------

const GROK_DETECTED = Object.freeze({
  grok_cli: true,
  grok_cli_path: '/tools/grok',
  grok_version: '1.0.4',
  grok_compatibility_verified: true,
});

function grokCapability(options = {}) {
  return buildCapabilities(options).find((item) => item.adapter_id === 'grok-cli');
}

test('capability-registry seals unsupported_grok_containment when the platform/arch gate is false', () => {
  const sealed = grokCapability({
    detected: GROK_DETECTED,
    containment: { platform: 'darwin', arch: 'arm64' },
  });
  assert.equal(sealed.unavailable_reason, UNSUPPORTED_GROK_CONTAINMENT);
});

test('the sealed containment reason cannot be overwritten by a detected reason', () => {
  const sealed = grokCapability({
    detected: { ...GROK_DETECTED, grok_unavailable_reason: 'incompatible_grok_cli' },
    containment: { platform: 'darwin', arch: 'arm64' },
  });
  assert.equal(sealed.unavailable_reason, UNSUPPORTED_GROK_CONTAINMENT,
    'the containment-specific reason is sealed and wins over every other absence cause');
});

test('on a containment platform the generic detected reason is preserved untouched', () => {
  const generic = grokCapability({
    detected: { ...GROK_DETECTED, grok_cli: false, grok_unavailable_reason: 'incompatible_grok_cli' },
    containment: { platform: 'linux', arch: 'x64' },
  });
  assert.equal(generic.unavailable_reason, 'incompatible_grok_cli');
  const none = grokCapability({ detected: GROK_DETECTED, containment: { platform: 'linux', arch: 'x64' } });
  assert.equal(Object.hasOwn(none, 'unavailable_reason'), false);
});

function routingPlanRequiringGrok(grokCapabilityOverrides) {
  return buildRoutingPlan({
    artifacts: [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 1 }],
    reviewers: [
      { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' },
      { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' },
    ],
    policy: { routing: { policy: 'auto', reviewer_strategy: 'static', maximum_reviewers: 4 } },
    overrides: { required_providers: ['grok'], providers: {}, reviewers: {} },
    capabilities: [
      { adapter_id: 'codex-native-generic', provider: 'codex', available: true, roles: ['standard', 'adversarial'], model_selection: { supported: false }, effort_selection: { supported: false } },
      { adapter_id: 'claude-cli', provider: 'claude', available: true, roles: ['standard', 'adversarial'], model_selection: { supported: false }, effort_selection: { supported: false } },
      { adapter_id: 'grok-cli', provider: 'grok', available: false, roles: ['standard'], model_selection: { supported: false }, effort_selection: { supported: false }, ...grokCapabilityOverrides },
    ],
  });
}

test('model-router carries the provider-unavailability map from capabilities into the assignment planner', () => {
  const sealed = routingPlanRequiringGrok({ unavailable_reason: UNSUPPORTED_GROK_CONTAINMENT });
  assert.equal(sealed.operational_failure, true);
  assert.ok(sealed.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT));
  assert.equal(sealed.shortfalls.includes('required_provider:grok'), false,
    'the generic shortfall may not overwrite or duplicate the containment-specific reason');

  // The map's *content* is what crossed the boundary: the same shape carrying a
  // different reason keeps the generic shortfall, and no reason at all does too.
  const otherReason = routingPlanRequiringGrok({ unavailable_reason: 'incompatible_grok_cli' });
  assert.ok(otherReason.shortfalls.includes('required_provider:grok'));
  assert.equal(otherReason.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT), false);

  const noReason = routingPlanRequiringGrok({});
  assert.ok(noReason.shortfalls.includes('required_provider:grok'));
  assert.equal(noReason.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT), false);
});

const CODEX_CANDIDATE = Object.freeze({ id: 'codex-review', provider: 'codex', adapter_id: 'codex-native-generic', assignment_roles: ['standard', 'adversarial'] });
const CLAUDE_CANDIDATE = Object.freeze({ id: 'claude-opus', provider: 'claude', adapter_id: 'claude-cli', assignment_roles: ['standard', 'adversarial'] });
const GROK_CANDIDATE = Object.freeze({ id: 'grok', provider: 'grok', adapter_id: 'grok-cli', assignment_roles: ['standard'] });

function plannerCase(overrides = {}) {
  return planReviewerAssignments({
    artifacts: [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 1 }],
    risk: 'medium',
    candidates: [CODEX_CANDIDATE, CLAUDE_CANDIDATE],
    reviewerStrategy: 'static',
    requiredProviders: ['grok'],
    ...overrides,
  });
}

test('adaptive-review-routing translates an absent required grok into the canonical containment shortfall', () => {
  const sealed = plannerCase({ providerUnavailability: { grok: UNSUPPORTED_GROK_CONTAINMENT } });
  assert.ok(sealed.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT));
  assert.equal(sealed.shortfalls.includes('required_provider:grok'), false);
  assert.equal(sealed.operational_failure, true);
});

test('the generic required_provider shortfall stays correct for every other absence cause', () => {
  const generic = plannerCase();
  assert.ok(generic.shortfalls.includes('required_provider:grok'));
  assert.equal(generic.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT), false);
  assert.equal(generic.operational_failure, true);

  const otherReason = plannerCase({ providerUnavailability: { grok: 'incompatible_grok_cli' } });
  assert.ok(otherReason.shortfalls.includes('required_provider:grok'));
  assert.equal(otherReason.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT), false);

  const otherProvider = planReviewerAssignments({
    artifacts: [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 1 }],
    risk: 'medium',
    candidates: [CLAUDE_CANDIDATE],
    reviewerStrategy: 'static',
    requiredProviders: ['codex'],
    providerUnavailability: { grok: UNSUPPORTED_GROK_CONTAINMENT },
  });
  assert.ok(otherProvider.shortfalls.includes('required_provider:codex'));
  assert.equal(otherProvider.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT), false);
});

test('a present grok candidate never produces the containment shortfall, whatever the map says', () => {
  const present = planReviewerAssignments({
    artifacts: [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 1 }],
    risk: 'medium',
    candidates: [GROK_CANDIDATE, CLAUDE_CANDIDATE],
    reviewerStrategy: 'static',
    requiredProviders: ['grok'],
    providerUnavailability: { grok: UNSUPPORTED_GROK_CONTAINMENT },
  });
  assert.equal(present.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT), false);
  assert.equal(present.shortfalls.includes('required_provider:grok'), false);
});

test('review-synthesis is the terminal reader: a --grok review on an unsupported platform fails the whole review', () => {
  const routingPlan = {
    protocol_version: '3.0',
    operational_failure: true,
    shortfalls: [UNSUPPORTED_GROK_CONTAINMENT],
    routes: [],
    candidate_reviewers: [],
  };
  const result = synthesizeReviewRound({ attempts: [], consensus: {}, routingPlan });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'routing_plan_operational_failure');
  assert.deepEqual(result.routing_shortfalls, [UNSUPPORTED_GROK_CONTAINMENT]);
  assert.equal(result.operational_failure_reason, UNSUPPORTED_GROK_CONTAINMENT);
  assert.equal(result.n_actual, 0, 'it is not a four-voice degradation');
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('the terminal reader reports no containment reason for an ordinary operational failure', () => {
  const result = synthesizeReviewRound({
    attempts: [],
    consensus: {},
    routingPlan: {
      protocol_version: '3.0',
      operational_failure: true,
      shortfalls: ['required_provider:codex'],
      routes: [],
      candidate_reviewers: [],
    },
  });
  assert.equal(result.status, 'operational_failure');
  assert.deepEqual(result.routing_shortfalls, ['required_provider:codex']);
  assert.equal(result.operational_failure_reason, null);
});

test('the whole carrier chain runs end to end: sealed capability to terminal synthesis', () => {
  const capabilities = buildCapabilities({
    detected: GROK_DETECTED,
    hostAssertions: { codexNativeGeneric: true, claudeNativeAgent: true },
    containment: { platform: 'darwin', arch: 'arm64' },
  }).filter((capability) => capability.provider !== 'grok' || capability.adapter_id === 'grok-cli');
  const grok = capabilities.find((item) => item.adapter_id === 'grok-cli');
  assert.equal(grok.unavailable_reason, UNSUPPORTED_GROK_CONTAINMENT);

  const routingPlan = buildRoutingPlan({
    artifacts: [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 1 }],
    reviewers: [
      { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' },
      { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-native-agent' },
    ],
    policy: { routing: { policy: 'auto', reviewer_strategy: 'static', maximum_reviewers: 4 } },
    overrides: { required_providers: ['grok'], providers: {}, reviewers: {} },
    capabilities,
  });
  assert.equal(routingPlan.operational_failure, true);
  assert.ok(routingPlan.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT));

  const synthesis = synthesizeReviewRound({ attempts: [], consensus: {}, routingPlan });
  assert.equal(synthesis.status, 'operational_failure');
  assert.equal(synthesis.operational_failure_reason, UNSUPPORTED_GROK_CONTAINMENT);
  assert.equal(synthesis.n_actual, 0);
});

// ---------------------------------------------------------------------------
// D21 / I41 — the whole chain for a Grok that *is* installed and
// compatibility-verified, on a host that cannot contain its process tree.
//
// The chain tests above all run with Grok absent or with a hand-written
// capability, so they exercise a D13 candidacy gate that was already closed.
// This is the case nothing covered: with Grok present, `available` is the only
// thing between an uncontainable host and a planned Grok seat, because nothing
// downstream of the registry consults containment.
// ---------------------------------------------------------------------------

const CONTAINABLE = Object.freeze({ platform: 'linux', arch: 'x64' });
const UNCONTAINABLE = Object.freeze({ platform: 'darwin', arch: 'arm64' });
const REVIEW_ARTIFACTS = Object.freeze([
  Object.freeze({ target_kind: 'code-change', path: 'src/a.js', changed_lines: 1 }),
]);

// The D13 election rule, mirrored from `defaultReviewers` in
// `classify-artifacts.mjs`: an opt-in provider becomes a candidate reviewer
// exactly when its capability is `available` and the review asked for it.
function electReviewers(capabilities, enabledProviders) {
  const has = (adapterId) => capabilities.some(
    (item) => item.adapter_id === adapterId && item.available === true,
  );
  const reviewers = [];
  if (has('claude-native-agent')) {
    reviewers.push({ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-native-agent' });
  }
  if (has('codex-native-generic')) {
    reviewers.push({ id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' });
    reviewers.push({ id: 'codex-adversarial', provider: 'codex', role: 'adversarial', adapter_id: 'codex-native-generic' });
  }
  if (has('grok-cli') && enabledProviders.includes('grok')) {
    reviewers.push({ id: 'grok', provider: 'grok', role: 'standard', adapter_id: 'grok-cli' });
  }
  return reviewers;
}

function planGrokReview(capabilities) {
  return buildRoutingPlan({
    artifacts: [...REVIEW_ARTIFACTS],
    reviewers: electReviewers(capabilities, ['grok']),
    policy: { routing: { policy: 'auto', reviewer_strategy: 'static', maximum_reviewers: 4 } },
    overrides: { required_providers: ['grok'], providers: {}, reviewers: {} },
    capabilities,
  });
}

// One `--grok` review, from detection through to the terminal reader.
function d21GrokReview(containment, detected = GROK_DETECTED) {
  const capabilities = buildCapabilities({
    detected,
    hostAssertions: { claudeNativeAgent: true, codexNativeGeneric: true },
    containment,
  });
  const routingPlan = planGrokReview(capabilities);
  return {
    capabilities,
    capability: capabilities.find((item) => item.adapter_id === 'grok-cli'),
    reviewers: electReviewers(capabilities, ['grok']),
    routingPlan,
    synthesis: synthesizeReviewRound({ attempts: [], consensus: {}, routingPlan }),
  };
}

test('an installed, verified Grok on an uncontainable host fails the whole review through all four carriers', () => {
  const { capabilities, capability, reviewers, routingPlan, synthesis } = d21GrokReview(UNCONTAINABLE);

  // 1 — registry. D21 folds into the D13 candidacy gate, so the record is
  // unavailable *and* says why, and the two never contradict each other.
  assert.equal(capability.available, false,
    'a host that cannot contain a Grok provider tree advertises no Grok capability');
  assert.equal(capability.unavailable_reason, UNSUPPORTED_GROK_CONTAINMENT);
  assert.equal(
    reviewers.some((reviewer) => reviewer.provider === 'grok'), false,
    'the D13 election must not elect a provider whose tree cannot be contained',
  );

  // 2 — router. The map's *content* is what crossed the boundary: strip the
  // sealed reason from the capability the router reads and the very same plan
  // degrades to the generic shortfall, so the reason below came from the map.
  assert.ok(routingPlan.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT));
  const withoutSealedReason = planGrokReview(capabilities.map((item) => {
    const { unavailable_reason: _reason, ...rest } = item;
    return rest;
  }));
  assert.ok(withoutSealedReason.shortfalls.includes('required_provider:grok'));
  assert.equal(withoutSealedReason.shortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT), false);

  // 3 — planner. The containment-specific reason replaces the generic one.
  assert.equal(routingPlan.shortfalls.includes('required_provider:grok'), false);
  assert.equal(routingPlan.operational_failure, true);

  // 4 — synthesis. The whole review fails; it is not a four-voice degradation.
  assert.equal(synthesis.status, 'operational_failure');
  assert.equal(synthesis.error, 'routing_plan_operational_failure');
  assert.equal(synthesis.operational_failure_reason, UNSUPPORTED_GROK_CONTAINMENT);
  assert.equal(synthesis.n_actual, 0);
});

test('the same installed, verified Grok on a containable host is admitted and plans its seat', () => {
  const { capability, reviewers, routingPlan, synthesis } = d21GrokReview(CONTAINABLE);

  // 1 — registry.
  assert.equal(capability.available, true,
    'a containment platform admits a compatibility-verified Grok');
  assert.equal(Object.hasOwn(capability, 'unavailable_reason'), false);
  assert.deepEqual(
    reviewers.filter((reviewer) => reviewer.provider === 'grok').map((reviewer) => reviewer.id),
    ['grok'],
  );

  // 2/3 — router and planner. There is a candidate, so there is no shortfall of
  // either form and no operational failure to carry a reason.
  assert.deepEqual(routingPlan.shortfalls, []);
  assert.equal(routingPlan.operational_failure, false);
  assert.ok(routingPlan.routes.some((route) => route.reviewer_id === 'grok'),
    'a --grok review on a containable host plans a Grok seat');

  // 4 — synthesis. The containment path is not taken. This round still ends in
  // an unrelated operational failure because it is called with zero attempts,
  // which is a property of this call and not of containment — so the assertion
  // is on the failure's identity, not on its absence.
  assert.notEqual(synthesis.error, 'routing_plan_operational_failure');
  assert.notEqual(synthesis.operational_failure_reason, UNSUPPORTED_GROK_CONTAINMENT);
});

test('no detection and containment pair yields a capability that is available and says it is not', () => {
  // The detected shapes are the ones `detect-environment.mjs` can return: the
  // verified shape (:157-162), the incompatible shape (:52-59) — the only one
  // that carries `grok_unavailable_reason` — and no Grok keys at all. The
  // producer never emits a reason alongside `grok_compatibility_verified: true`,
  // so that combination is not a reachable input and is not asserted here.
  const detectedShapes = [
    {},
    { ...GROK_DETECTED },
    {
      grok_cli: false,
      grok_cli_path: '',
      grok_version: '',
      grok_compatibility_verified: false,
      grok_compatibility_evidence: null,
      grok_unavailable_reason: 'incompatible_grok_cli',
    },
  ];
  const containments = [
    CONTAINABLE,
    UNCONTAINABLE,
    { platform: 'win32', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
  ];
  for (const containment of containments) {
    for (const detected of detectedShapes) {
      const capability = grokCapability({ detected, containment });
      const label = `${containment.platform}/${containment.arch} ${JSON.stringify(detected)}`;
      assert.equal(
        capability.available === true && Object.hasOwn(capability, 'unavailable_reason'),
        false,
        `a capability may never be available and carry an unavailable reason: ${label}`,
      );
      if (!isGrokContainmentPlatformSupported(containment)) {
        assert.equal(capability.available, false, label);
        assert.equal(capability.unavailable_reason, UNSUPPORTED_GROK_CONTAINMENT, label);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The bridge consumes the token; it never establishes readiness.
// ---------------------------------------------------------------------------

test('run-grok-reviewer.mjs consumes the owner-bound token and never establishes containment_ready itself', () => {
  const bridge = readFileSync(join(pluginRoot, 'hooks', 'scripts', 'run-grok-reviewer.mjs'), 'utf8');
  const code = bridge.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.equal(/preflightGrokContainment\s*\(/u.test(code), false,
    'the bridge consumes the owner-bound token; it does not preflight containment');
  assert.equal(/from\s+'\.\/grok-containment-preflight\.mjs'/u.test(code), false,
    'the bridge does not import the preflight entry');
  assert.match(code, /containmentToken/u);
  assert.match(code, /assertContainmentReadyToken\(/u);

  const entry = readFileSync(join(pluginRoot, 'hooks', 'scripts', 'grok-containment-preflight.mjs'), 'utf8');
  const entryCode = entry.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.match(entryCode, /preflightGrokContainment/u);
  assert.match(entryCode, /releaseGrokContainment/u);
  assert.equal(/run-grok-reviewer/u.test(entryCode), false,
    'the thin preflight entry does not reach into the bridge');
});

// ---------------------------------------------------------------------------
// Replay-and-diff — the four carrier files are live and shared, so their
// non-Grok behaviour is pinned against the commit before this slice.
// ---------------------------------------------------------------------------

const CARRIER_FILES = Object.freeze([
  'hooks/scripts/lib/capability-registry.mjs',
  'hooks/scripts/lib/model-router.mjs',
  'hooks/scripts/lib/adaptive-review-routing.mjs',
  'hooks/scripts/review-synthesis.mjs',
]);

function extractBaseline(commit, label, mutate = null) {
  const dest = workspace(label);
  const list = spawnSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'hooks/scripts'], {
    cwd: pluginRoot, encoding: 'utf8',
  });
  assert.equal(list.status, 0, list.stderr);
  const paths = list.stdout.trim().split('\n').filter(Boolean);
  for (const carrier of CARRIER_FILES) assert.ok(paths.includes(carrier), `${carrier} must exist at ${commit}`);
  for (const relPath of paths) {
    const show = spawnSync('git', ['show', `${commit}:${relPath}`], { cwd: pluginRoot, encoding: 'buffer' });
    assert.equal(show.status, 0, show.stderr && show.stderr.toString());
    const destPath = join(dest, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, mutate ? mutate(relPath, show.stdout) : show.stdout);
  }
  return dest;
}

async function loadCarriers(root) {
  const load = (relPath) => import(pathToFileURL(join(root, relPath)).href);
  const [registry, router, routing, synthesis] = await Promise.all(CARRIER_FILES.map(load));
  return { registry, router, routing, synthesis };
}

// The non-Grok matrix. Every case names a capability, planner, routing-plan or
// synthesis shape that this slice must leave byte-identical.
function capabilityMatrix() {
  return [
    {},
    { detected: { claude_cli: true, claude_cli_path: '/x/claude' } },
    { detected: { codex_cli: true, codex_cli_path: '/x/codex' }, hostAssertions: { codexExecReviewer: true },
      probes: { codex: { ok: true, version: 'codex 1.0', help: '--sandbox read-only --json --skip-git-repo-check --model --cd' } } },
    { detected: { agy_cli: true, agy_version: '2.1' } },
    { detected: { codex_plugin: true } },
    { hostAssertions: { claudeNativeAgent: true, codexNativeGeneric: true } },
    { detected: { claude_cli: true, claude_cli_path: '/x/claude' }, probes: { claude: { ok: true, version: 'Claude Code v2', help: '--effort' } } },
    { detected: { claude_cli: true, claude_cli_path: '/x/claude' }, probes: { claude: { ok: true, captureOverflow: true } } },
    { detected: { ...GROK_DETECTED } },
    { detected: { ...GROK_DETECTED, grok_unavailable_reason: 'incompatible_grok_cli' } },
    // The verified shape carries its compatibility-evidence carrier. Without a
    // case that has one, the exact diff below cannot see the evidence being
    // dropped on an uncontainable host, which its own contract forbids.
    { detected: { ...GROK_DETECTED, grok_compatibility_evidence: { sealed: 'carrier' } } },
  ];
}

function plannerMatrix() {
  const codex = CODEX_CANDIDATE;
  const claude = CLAUDE_CANDIDATE;
  const agy = { id: 'agy', provider: 'agy', adapter_id: 'agy-cli', assignment_roles: ['standard'] };
  const code = [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 40 }];
  const doc = [{ target_kind: 'document', path: 'docs/plan.md', changed_lines: 10 }];
  return [
    { artifacts: code, risk: 'low', candidates: [codex, claude] },
    { artifacts: code, risk: 'medium', candidates: [codex, claude, agy] },
    { artifacts: code, risk: 'high', candidates: [codex, claude, agy] },
    { artifacts: code, risk: 'critical', candidates: [codex, claude, agy] },
    { artifacts: code, risk: 'critical', candidates: [codex] },
    { artifacts: doc, risk: 'medium', candidates: [codex, claude] },
    { artifacts: code, risk: 'medium', candidates: [codex, claude], reviewerStrategy: 'static' },
    { artifacts: code, risk: 'medium', candidates: [codex, claude], requiredProviders: ['codex'] },
    { artifacts: code, risk: 'medium', candidates: [codex, claude], requiredProviders: ['agy'] },
    { artifacts: code, risk: 'medium', candidates: [codex, claude], requiredReviewers: ['agy'] },
    { artifacts: code, risk: 'medium', candidates: [codex, claude], codexOnly: true, reviewerStrategy: 'static' },
    { artifacts: code, risk: 'medium', candidates: [codex, claude], progress: { state: 'stalled', used_reviewers: ['codex'] } },
    { artifacts: code, risk: 'medium', candidates: [codex, claude], maximumReviewers: 1 },
    { artifacts: code, risk: 'medium', candidates: [], requiredProviders: ['grok'] },
  ];
}

function routingMatrix() {
  const capabilities = [
    { adapter_id: 'codex-native-generic', provider: 'codex', available: true, roles: ['standard', 'adversarial'], model_selection: { supported: false }, effort_selection: { supported: false } },
    { adapter_id: 'claude-cli', provider: 'claude', available: true, roles: ['standard', 'adversarial'], model_selection: { supported: true, aliases: ['haiku', 'sonnet', 'opus', 'best'], catalog_complete: false, transport: 'flag:--model' }, effort_selection: { supported: false, levels: [], transport: 'none' } },
  ];
  const reviewers = [
    { id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: 'codex-native-generic' },
    { id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' },
  ];
  const artifacts = [{ target_kind: 'code-change', path: 'src/a.js', changed_lines: 40 }];
  return [
    { artifacts, reviewers, capabilities, policy: { routing: { policy: 'auto', maximum_reviewers: 4 } }, overrides: { providers: {}, reviewers: {} } },
    { artifacts, reviewers, capabilities, policy: { routing: { policy: 'auto', reviewer_strategy: 'static', maximum_reviewers: 4 } }, overrides: { providers: {}, reviewers: {} } },
    { artifacts, reviewers, capabilities, policy: { routing: { policy: 'auto', maximum_reviewers: 2 } }, overrides: { required_providers: ['codex'], providers: {}, reviewers: {} } },
    { artifacts, reviewers, capabilities, policy: { routing: { policy: 'auto', maximum_reviewers: 2 } }, overrides: { required_providers: ['agy'], providers: {}, reviewers: {} } },
    { artifacts: [{ target_kind: 'document', path: 'docs/x.md', changed_lines: 4 }], reviewers, capabilities, policy: {}, overrides: { providers: {}, reviewers: {} } },
    { artifacts, reviewers, capabilities, policy: {}, overrides: { codex_only: true, reviewer_strategy: 'static', providers: {}, reviewers: {} } },
    { artifacts: [{ target_kind: 'code-change', path: 'src/auth.js', content_risk: 'critical', changed_lines: 4 }], reviewers, capabilities, policy: {}, overrides: { providers: {}, reviewers: {} } },
    { artifacts, reviewers, capabilities, policy: {}, overrides: { providers: {}, reviewers: {} }, riskFloor: 'high' },
  ];
}

function synthesisMatrix() {
  const plan = (shortfalls, operational) => ({
    protocol_version: '3.0',
    operational_failure: operational,
    shortfalls,
    routes: [],
    candidate_reviewers: [],
  });
  return [
    { attempts: [], consensus: {}, routingPlan: plan(['required_provider:codex'], true) },
    { attempts: [], consensus: {}, routingPlan: plan(['required_reviewer:agy'], true) },
    { attempts: [], consensus: {}, routingPlan: plan(['minimum_reviewers', 'provider_families'], true) },
    { attempts: [], consensus: {}, routingPlan: plan([], true) },
    { attempts: [], consensus: {}, routingPlan: plan(['minimum_reviewers'], false) },
    { attempts: [], consensus: {}, routingPlan: { protocol_version: '3.0', operational_failure: false, shortfalls: [], routes: [], candidate_reviewers: [] } },
  ];
}

function safeJson(thunk) {
  try {
    return JSON.stringify(thunk(), (_key, value) => (value === undefined ? '<undefined>' : value));
  } catch (error) {
    return `THROWN ${error.message}`;
  }
}

function runMatrix(modules) {
  const rows = [];
  for (const [index, input] of capabilityMatrix().entries()) {
    // The Grok capability is the one row this slice is allowed to touch, and it
    // is diffed separately and exactly below. Everything else must be identical.
    rows.push(`capability:${index} ${safeJson(() => modules.registry
      .buildCapabilities(input)
      .filter((capability) => capability.adapter_id !== 'grok-cli'))}`);
  }
  for (const [index, input] of plannerMatrix().entries()) {
    rows.push(`planner:${index} ${safeJson(() => modules.routing.planReviewerAssignments(input))}`);
  }
  for (const [index, input] of routingMatrix().entries()) {
    rows.push(`routing:${index} ${safeJson(() => modules.router.buildRoutingPlan(input))}`);
  }
  for (const [index, input] of synthesisMatrix().entries()) {
    // `operational_failure_reason` is the field this slice adds, and both of
    // its polarities are asserted exactly by the terminal-reader tests above.
    // Everything else the round returns must be identical.
    rows.push(`synthesis:${index} ${safeJson(() => {
      const result = modules.synthesis.synthesizeReviewRound(input);
      const { operational_failure_reason: _reason, ...rest } = result;
      return rest;
    })}`);
  }
  return rows;
}

const MATRIX_SIZE = capabilityMatrix().length + plannerMatrix().length
  + routingMatrix().length + synthesisMatrix().length;

test('the four carrier files keep their non-Grok behaviour byte-identical to the pinned pre-slice commit', async () => {
  const baselineRoot = extractBaseline(BASELINE_COMMIT, 'carrier-baseline');
  const baselineModules = await loadCarriers(baselineRoot);
  const liveModules = await loadCarriers(pluginRoot);
  const baseline = runMatrix(baselineModules);
  const live = runMatrix(liveModules);
  assert.equal(baseline.length, MATRIX_SIZE);

  const differences = [];
  for (const [index, row] of baseline.entries()) {
    if (row !== live[index]) {
      differences.push({ case: row.slice(0, row.indexOf(' ')), baseline: row, live: live[index] });
    }
  }
  assert.deepEqual(differences, [], 'no non-Grok carrier behaviour may change');

  // The one row this slice owns, diffed exactly and on *both* polarities with
  // pinned platform/arch, so neither assertion can silently disappear on a host
  // that happens to be the other polarity. On an uncontainable containment the
  // row may differ in `available` and `unavailable_reason`; on a containable one
  // it may differ in nothing at all.
  const grokRow = (modules, input) => modules.registry.buildCapabilities(input)
    .find((capability) => capability.adapter_id === 'grok-cli');
  const strip = (capability) => {
    const { available: _available, unavailable_reason: _reason, ...rest } = capability;
    return rest;
  };
  for (const input of capabilityMatrix()) {
    const before = grokRow(baselineModules, input);

    const uncontainable = grokRow(liveModules, { ...input, containment: UNCONTAINABLE });
    assert.deepEqual(strip(uncontainable), strip(before),
      'on an uncontainable host only available and unavailable_reason may change on grok-cli');
    assert.equal(uncontainable.available, false);
    assert.equal(uncontainable.unavailable_reason, UNSUPPORTED_GROK_CONTAINMENT);

    const containable = grokRow(liveModules, { ...input, containment: CONTAINABLE });
    assert.deepEqual(containable, before,
      'on a containable host the grok-cli row is unchanged from the pinned baseline');
  }
});

test('the replay harness observes a mutation planted in the pinned baseline', async () => {
  const baselineRoot = extractBaseline(BASELINE_COMMIT, 'carrier-baseline-control');
  const mutatedRoot = extractBaseline(BASELINE_COMMIT, 'carrier-mutant', (relPath, bytes) => (
    relPath === 'hooks/scripts/lib/adaptive-review-routing.mjs'
      ? Buffer.from(bytes.toString('utf8').replace(
        "missingHardConstraints.push(`required_provider:${provider}`);",
        "missingHardConstraints.push(`required_provider_mutated:${provider}`);",
      ), 'utf8')
      : bytes
  ));
  const baseline = runMatrix(await loadCarriers(baselineRoot));
  const mutated = runMatrix(await loadCarriers(mutatedRoot));
  const observed = baseline.filter((row, index) => row !== mutated[index]);
  assert.ok(observed.length > 0, 'the positive control must be visible to the diff');
});

test('T-OWN-17: an inventoried platform outside GROK_ENABLED_PLATFORMS is refused before helper lookup', () => {
  assert.deepEqual([...GROK_ENABLED_PLATFORMS], ['linux/x64']);
  assert.equal(Object.isFrozen(GROK_ENABLED_PLATFORMS), true);
  assert.equal(typeof GROK_ENABLED_PLATFORMS.add, 'undefined', 'the public value is an array, not a mutable Set');
  assert.throws(() => { GROK_ENABLED_PLATFORMS.push('win32/x64'); }, TypeError);
  assert.equal(isGrokPlatformEnabled('win32/x64'), false);
  assert.equal(isGrokPlatformEnabled('linux/x64'), true);
  for (const key of GROK_ENABLED_PLATFORMS) assert.ok(Object.hasOwn(GROK_CONTAINMENT_INVENTORY, key));
  const lookups = [];
  const win = preflightGrokContainment({ platform: 'win32', arch: 'x64', executableResolver: (p) => { lookups.push(p); return p; }, helperSpawner: () => ({ ok: true }) });
  assert.equal(win.ok, false);
  assert.equal(win.reason, UNSUPPORTED_GROK_CONTAINMENT);
  assert.equal(win.detail, 'platform_verification_pending');
  assert.deepEqual(lookups, []);
  const artifactCalls = [];
  assert.throws(() => evaluateCoordinatorContainment({ platform: 'win32', arch: 'x64', helperArtifact: (...a) => { artifactCalls.push(a); return ARTIFACT_OK(); } }),
    (error) => error.containment_refusal?.reason === UNSUPPORTED_GROK_CONTAINMENT && error.containment_refusal?.detail === 'platform_verification_pending');
  assert.deepEqual(artifactCalls, [], 'zero helper lookup at the coordinator for a pending platform');
  const gate = resolveGrokContainmentPlatform({ platform: 'win32', arch: 'x64' });
  assert.deepEqual([gate.supported, gate.inventoried, gate.detail, gate.mechanism], [false, true, 'platform_verification_pending', 'job-object']);
  // a token can be minted and asserted for an inventoried-but-not-enabled pair (inventory-bound), yet the preflight refuses it
  const winToken = supervisorTesting.mintOwnerToken({ platform: 'win32', arch: 'x64', ownerId: 'grok-containment-owner-1-1-0000000c', generation: 1, startedAt: 1 });
  assert.equal(assertContainmentReadyToken(winToken).mechanism, 'job-object');
  const enabled = resolveGrokContainmentPlatform({ platform: 'win32', arch: 'x64', enabledPlatforms: ALL_INVENTORIED });
  assert.equal(enabled.supported, true);
  assert.deepEqual(resolveGrokContainmentPlatform({ platform: 'darwin', arch: 'arm64' }).inventoried, false);
});

test('T-OWN-9: evaluateHelperArtifact names every integrity state and never follows a symlink', (t) => {
  const good = nativeFixture('t-own-9-ok').root;
  const ok = evaluateHelperArtifact(gateFor(good), { nativeDirectory: good, pluginRoot: good });
  assert.deepEqual([ok.present, ok.executable, ok.integrity], [true, true, 'ok']);
  assert.match(ok.helper_sha256, /^[a-f0-9]{64}$/u);
  const cases = [
    ['mismatch', { sums: 'wrong' }], ['sums_missing', { sums: 'absent' }], ['sums_malformed', { sums: 'truncated' }],
    ['sums_malformed', { extra: 'linux-x64/other' }], ['not_listed', { hostPlaceholder: true }], ['sums_symlink', { symlinkSums: true }],
  ];
  for (const [expected, options] of cases) {
    const fixture = nativeFixture(`t-own-9-${expected}-${Math.random().toString(16).slice(2, 6)}`, options);
    if (fixture.skipped) { t.diagnostic(`${expected}: file symlinks need elevation; skipped`); continue; }
    assert.equal(evaluateHelperArtifact(gateFor(fixture.root), { nativeDirectory: fixture.root, pluginRoot: fixture.root }).integrity, expected, expected);
  }
  const sym = nativeFixture('t-own-9-symlink-helper', { symlinkHelper: true });
  if (!sym.skipped) assert.equal(evaluateHelperArtifact(gateFor(sym.root), { nativeDirectory: sym.root, pluginRoot: sym.root }).present, false);
  // a symlinked/junctioned platform directory component under a real native dir
  const comp = nativeFixture('t-own-9-symlink-dir').root;
  renameSync(join(comp, 'linux-x64'), join(comp, 'real-linux'));
  linkDirectory(join(comp, 'real-linux'), join(comp, 'linux-x64'));
  assert.equal(evaluateHelperArtifact(gateFor(comp), { nativeDirectory: comp, pluginRoot: comp }).integrity, 'symlink_component');
  // the native directory itself is a link: the component walk from the plugin root sees it before any realpath
  const plugin = workspace('t-own-9-plugin');
  const realNative = nativeFixture('t-own-9-real-native').root;
  linkDirectory(realNative, join(plugin, 'native'));
  assert.equal(evaluateHelperArtifact(gateFor(join(plugin, 'native')), { nativeDirectory: join(plugin, 'native'), pluginRoot: plugin }).integrity, 'symlink_component');
  // a native directory that is not under the plugin root at all
  const elsewhere = nativeFixture('t-own-9-elsewhere').root;
  assert.equal(evaluateHelperArtifact(gateFor(elsewhere), { nativeDirectory: elsewhere, pluginRoot: workspace('t-own-9-other-root') }).integrity, 'outside_root');
  // production mode requires the release polarity; the same one-helper root is fine for a test locator
  const oneHelper = nativeFixture('t-own-9-one-helper', { win: false }).root;
  assert.equal(evaluateHelperArtifact(gateFor(oneHelper), { nativeDirectory: oneHelper, pluginRoot: oneHelper, productionMode: true }).integrity, 'not_release');
  assert.equal(evaluateHelperArtifact(gateFor(oneHelper), { nativeDirectory: oneHelper, pluginRoot: oneHelper }).integrity, 'ok');
});

test('T-OWN-9: the coordinator and the preflight refuse integrity failures, and production mode refuses a one-helper root', () => {
  const bad = nativeFixture('t-own-9-coord', { sums: 'wrong' }).root;
  assert.throws(
    () => evaluateCoordinatorContainment({ ...LINUX, nativeDirectory: bad, pluginRoot: bad }),
    (error) => error.containment_refusal?.reason === GROK_CONTAINMENT_HELPER_FAILED && error.containment_refusal?.detail === 'integrity_mismatch',
  );
  const preflight = preflightGrokContainment({ ...LINUX, nativeDirectory: bad, pluginRoot: bad });
  assert.deepEqual([preflight.ok, preflight.reason, preflight.detail, preflight.containment_ready_token], [false, GROK_CONTAINMENT_HELPER_FAILED, 'integrity_mismatch', null]);
  const absent = workspace('t-own-9-absent');
  assert.equal(preflightGrokContainment({ ...LINUX, nativeDirectory: absent, pluginRoot: absent }).reason, 'missing_grok_containment_helper');
  // production mode: no nativeDirectory supplied, but the plugin root is pointed at a fixture whose native tree is a one-helper root
  const fixturePlugin = workspace('t-own-9-prod-plugin');
  mkdirSync(join(fixturePlugin, 'hooks', 'scripts', 'lib'), { recursive: true });
  renameSync(nativeFixture('t-own-9-prod-native', { win: false }).root, join(fixturePlugin, 'hooks', 'scripts', 'lib', 'native'));
  const prod = preflightGrokContainment({ ...LINUX, pluginRoot: fixturePlugin, helperSpawner: () => ({ ok: true }) });
  assert.equal(prod.reason, GROK_CONTAINMENT_HELPER_FAILED);
  assert.equal(prod.detail, 'integrity_not_release');
  assert.throws(() => evaluateCoordinatorContainment({ ...LINUX, pluginRoot: fixturePlugin }), (error) => error.containment_refusal?.detail === 'integrity_not_release');
  // the same tree accepted through the test locator
  const native = join(fixturePlugin, 'hooks', 'scripts', 'lib', 'native');
  assert.equal(preflightGrokContainment({ ...LINUX, nativeDirectory: native, pluginRoot: fixturePlugin, helperSpawner: () => ({ ok: true }) }).ok, true);
});

test('T-OWN-12: integrity runs on the production default path; only helperArtifact bypasses it', async () => {
  const production = preflightGrokContainment();
  assert.equal(production.ok, false);
  assert.ok([UNSUPPORTED_GROK_CONTAINMENT, 'missing_grok_containment_helper'].includes(production.reason), production.reason);
  const bad = nativeFixture('t-own-12', { sums: 'wrong' }).root;
  assert.throws(
    () => evaluateCoordinatorContainment({ ...LINUX, nativeDirectory: bad, pluginRoot: bad, helperExists: () => true }),
    (error) => error.containment_refusal?.detail === 'integrity_mismatch',
    'an injected helperExists alone does not skip integrity',
  );
  assert.equal(evaluateCoordinatorContainment({ ...LINUX, nativeDirectory: bad, pluginRoot: bad, helperArtifact: ARTIFACT_OK }).supported, true);
  // createGrokCarrierCoordinator with neither seam consults SHA256SUMS before spawning the detector
  await assert.rejects(
    () => createGrokCarrierCoordinator({ cwd: workspace('t-own-12-cwd'), mode: 'review', ...LINUX, nativeDirectory: bad, pluginRoot: bad, detectorPath: join(bad, 'never-run.mjs') }),
    (error) => error.containment_refusal?.detail === 'integrity_mismatch',
  );
});

test('T-OWN-6 (parser): the normative control-line grammar is CRLF tolerant and admits exactly ready-then-report', () => {
  assert.equal(parseOwnerControlLines(Buffer.from(`${READY}\n${REPORT}\n`)).ok, true);
  assert.equal(parseOwnerControlLines(Buffer.from(`${READY}\r\n${REPORT}\r\n`)).ok, true);
  assert.equal(parseOwnerControlLines(Buffer.from(`  ${READY}\n${REPORT}  \n\n`)).ok, true);
  assert.deepEqual(parseOwnerControlLines(Buffer.alloc(0)), { ok: false, reason: 'empty', lines: [] });
  assert.equal(parseOwnerControlLines(Buffer.from(`${READY}\nnot json\n${REPORT}\n`)).reason, 'malformed');
  assert.equal(parseOwnerControlLines(Buffer.from(`${READY}\n`)).reason, 'shape');
  assert.equal(parseOwnerControlLines(Buffer.from(`${REPORT}\n${READY}\n`)).reason, 'shape');
  assert.equal(parseOwnerControlLines(Buffer.from(`${READY}\n${READY}\n${REPORT}\n`)).reason, 'shape');
  assert.equal(parseOwnerControlLines(Buffer.from(`${READY}\n${REPORT}\n{"handshake":"extra"}\n`)).reason, 'shape');
  const withOwner = REPORT.replace('"live_members"', '"owner_id":"x","generation":1,"observed_at":5,"live_members"');
  assert.equal(parseOwnerControlLines(Buffer.from(`${READY}\n${withOwner}\n`)).reason, 'shape');
  assert.equal(parseOwnerControlLines(Buffer.from(`${READY.replace('"1.0"', '"2.0"')}\n${REPORT}\n`)).reason, 'shape');
});

test('the stub helper compiles and speaks the two-line protocol in preflight and launch mode', (t) => {
  const stub = stubNativeRoot({ platform: HOST_STUB_PLATFORM, arch: HOST_STUB_ARCH });
  if (stub.skipReason) { t.skip(stub.skipReason); return; }
  const preflight = spawnSync(stub.helperPath, ['--own-grok-tree', '--parent-pid', String(process.pid)], { input: '', encoding: 'utf8', timeout: 5000 });
  assert.equal(preflight.status, 0, preflight.stderr);
  assert.equal(parseOwnerControlLines(Buffer.from(preflight.stdout)).ok, true);
  const launch = spawnSync(stub.helperPath, ['--own-grok-tree', '--parent-pid', String(process.pid), '--', 'provider', 'arg'], {
    input: '', encoding: 'utf8', timeout: 5000, env: { ...process.env, STUB_PROVIDER_OUTPUT: 'hello from provider', STUB_EXIT: '3' },
  });
  assert.equal(launch.status, 3);
  assert.match(launch.stderr, /hello from provider/u);
  assert.equal(parseOwnerControlLines(Buffer.from(launch.stdout)).ok, true);
  // `--parent-pid` after `--` is a command operand, not an option
  const operand = spawnSync(stub.helperPath, ['--own-grok-tree', '--', '--parent-pid', 'x'], { input: '', encoding: 'utf8', timeout: 5000 });
  assert.equal(operand.status, 0, operand.stderr);
  for (const row of ARGV_MATRIX) {
    const marker = join(stub.root, `${row.name.replaceAll(/\W+/gu, '-')}.marker`);
    const argv = row.withCommandMarker ? [...row.argv, '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] : row.argv;
    const bad = spawnSync(stub.helperPath, argv, { input: '', encoding: 'utf8', timeout: 5000 });
    assert.equal(bad.status, 64, `${row.name}: ${bad.stderr}`);
    assert.equal(bad.stdout, '', row.name);
    assert.equal(existsSync(marker), false, `${row.name}: the provider must never run`);
  }
});

// ---------------------------------------------------------------------------
// E2a / E2b -- durable owner record, production preflight spawner, env scrub.
// ---------------------------------------------------------------------------

// Preflight always runs with a CLEAN stub environment (no fault, no exit code):
// faults belong to the launch (Task 8). `spawnFault` is the one exception, for
// T-OWN-2, where the preflight itself is under test.
function stubPreflight(label, { spawnFault = '', platform = HOST_STUB_PLATFORM, arch = HOST_STUB_ARCH, now, tmpRoot, spy = null } = {}) {
  const stub = stubNativeRoot({ platform, arch });
  if (stub.skipReason) return { skipReason: stub.skipReason };
  const env = { ...process.env, STUB_FAULT: spawnFault, STUB_MECHANISM: platform === 'linux' ? 'pid-namespace' : 'job-object', GROK_SANDBOX: 'must-not-leak', STUB_EXIT: '' };
  const root = tmpRoot ?? workspace(`${label}-tmp`);
  const options = { platform, arch, nativeDirectory: stub.root, pluginRoot: stub.root, env, tmpRoot: root, enabledPlatforms: ALL_INVENTORIED, ...(now ? { now } : {}) };
  if (spy) options.helperSpawner = (helperPath, args, spawnOptions) => { spy.push({ helperPath, args, env: spawnOptions.env }); return supervisorTesting.defaultHelperSpawner(helperPath, args, spawnOptions); };
  const result = preflightGrokContainment(options);
  return { stub, tmpRoot: root, result };
}

test('T-OWN-1: the production spawner issues a token and a durable record with the leash argv and a scrubbed env', (t) => {
  const spy = [];
  const p = stubPreflight('t-own-1', { spy });
  if (p.skipReason) { t.skip(p.skipReason); return; }
  assert.equal(p.result.ok, true, JSON.stringify(p.result));
  const token = p.result.containment_ready_token;
  assert.match(token.owner_id, OWNER_ID_PATTERN);
  assert.equal(token.helper_path, p.stub.helperPath);
  assert.equal(spy.length, 1);
  assert.deepEqual(spy[0].args, ['--own-grok-tree', '--parent-pid', String(process.pid)]);
  assert.equal(Object.hasOwn(spy[0].env, 'GROK_SANDBOX'), false);
  assert.equal(typeof spy[0].env.PATH, 'string');
  assert.ok(spy[0].env.PATH.length > 0);
  const record = readOwnerRecord(token.owner_id, { tmpRoot: p.tmpRoot });
  assert.equal(record.ok, true, JSON.stringify(record));
  assert.deepEqual(validateOwnerRecord(token, record.body), { ok: true });
  assert.equal(record.body.helper_sha256, p.stub.helperSha256);
  assert.equal(isGrokContainmentOwnerLive(token, { tmpRoot: p.tmpRoot }), true);
  const recordPath = record.path;
  const st = lstatSync(recordPath);
  assert.equal(st.isFile() && !st.isSymbolicLink(), true);
  if (process.platform !== 'win32') {
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(lstatSync(dirname(recordPath)).mode & 0o777, 0o700);
  }
  // O_EXCL: a second write for the same owner id is refused
  assert.throws(() => supervisorTesting.writeOwnerRecordForTest(record.body, p.tmpRoot), /EEXIST/u);
  assert.equal(GROK_OWNER_START_DEADLINE_MS, 5000);
  assert.equal(GROK_CONTAINMENT_TOKEN_TTL_MS, 30 * 60 * 1000);
});

test('T-OWN-18: scrubGrokEnvironment drops every GROK_SANDBOX spelling and keeps the rest; the bridge delegates', async () => {
  const scrubbed = scrubGrokEnvironment({ PATH: '/x', SYSTEMROOT: 'C:\\Windows', GROK_SANDBOX: 'a', grok_sandbox: 'b', Grok_Sandbox: 'c', OTHER: 'keep' });
  assert.deepEqual(scrubbed, { PATH: '/x', SYSTEMROOT: 'C:\\Windows', OTHER: 'keep' });
  const bridgeSource = readFileSync(join(pluginRoot, 'hooks', 'scripts', 'run-grok-reviewer.mjs'), 'utf8');
  assert.match(bridgeSource, /scrubGrokEnvironment\(parentEnv\)/u, 'childEnvironment delegates to the supervisor');
  const supervisorSource = readFileSync(join(pluginRoot, 'hooks', 'scripts', 'lib', 'grok-process-supervisor.mjs'), 'utf8');
  assert.doesNotMatch(supervisorSource, /run-grok-reviewer/u, 'the supervisor never imports the bridge');
});

test('T-OWN-2: every preflight fault is a grok_containment_helper_failed refusal with a named detail', async (t) => {
  const expectations = [
    ['no_ready', 'handshake_lost'], ['wrong_mechanism', 'handshake_lost'], ['extra_line', 'handshake_lost'],
    ['report_not_last', 'handshake_lost'], ['exit_125_no_report', 'helper_exit_125'], ['hang', 'start_deadline'],
  ];
  for (const [fault, detail] of expectations) {
    const p = stubPreflight(`t-own-2-${fault}`, { spawnFault: fault });
    if (p.skipReason) { t.skip(p.skipReason); return; }
    assert.equal(p.result.ok, false, fault);
    assert.equal(p.result.reason, GROK_CONTAINMENT_HELPER_FAILED, fault);
    assert.equal(p.result.detail, detail, fault);
    assert.equal(p.result.containment_ready_token, null, fault);
    assert.equal(typeof p.result.helper_stderr, 'string', fault);
    assert.doesNotMatch(p.result.helper_stderr, new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'u'), fault);
  }
  const { sanitizeHelperStderr } = await import('../hooks/scripts/lib/grok-owner-control.mjs');
  assert.equal(sanitizeHelperStderr(Buffer.from('a\u0000b\rc\u007fd\u0085e\tf\ng')), 'abcde\tf\ng');
  assert.equal(sanitizeHelperStderr(Buffer.from('/plugin/root/x'), { pluginRoot: '/plugin/root' }), '{plugin_root}/x');
  const crlf = stubPreflight('t-own-2-crlf', { spawnFault: 'crlf' });
  assert.equal(crlf.result.ok, true, 'CRLF control lines are accepted');
});

test('T-OWN-4: an aged or future-dated record is refused and swept', (t) => {
  const base = 1_800_000_000_000;
  const p = stubPreflight('t-own-4', { now: () => base });
  if (p.skipReason) { t.skip(p.skipReason); return; }
  const token = p.result.containment_ready_token;
  assert.equal(readOwnerRecord(token.owner_id, { tmpRoot: p.tmpRoot, now: () => base + GROK_CONTAINMENT_TOKEN_TTL_MS + 1 }).reason, 'expired');
  assert.equal(readOwnerRecord(token.owner_id, { tmpRoot: p.tmpRoot, now: () => base - 1 }).reason, 'future');
  assert.equal(isGrokContainmentOwnerLive(token, { tmpRoot: p.tmpRoot, now: () => base + GROK_CONTAINMENT_TOKEN_TTL_MS + 1 }), false, 'the registry never substitutes for an expired record');
  // a future-dated record is refused but NOT swept
  stubPreflight('t-own-4-earlier', { now: () => base - 1000, tmpRoot: p.tmpRoot });
  assert.equal(existsSync(join(p.tmpRoot, 'deep-review-grok-containment', `${token.owner_id}.json`)), true, 'future-dated records survive a sweep');
  stubPreflight('t-own-4-later', { now: () => base + GROK_CONTAINMENT_TOKEN_TTL_MS + 1, tmpRoot: p.tmpRoot });
  assert.equal(existsSync(join(p.tmpRoot, 'deep-review-grok-containment', `${token.owner_id}.json`)), false, 'expired records are swept');
});

test('T-OWN-5: symlinked, foreign, tampered, planted or untrusted-directory records are refused', async (t) => {
  const p = stubPreflight('t-own-5');
  if (p.skipReason) { t.skip(p.skipReason); return; }
  const token = p.result.containment_ready_token;
  const dir = join(p.tmpRoot, 'deep-review-grok-containment');
  const recordPath = join(dir, `${token.owner_id}.json`);
  const body = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(validateOwnerRecord(token, { ...body, token_sha256: 'f'.repeat(64) }).reason, 'seal');
  assert.equal(validateOwnerRecord(token, { ...body, record: { ...body.record, generation: 2 } }).reason, 'generation');
  assert.equal(validateOwnerRecord({ ...token, owner_id: 'grok-containment-owner-1-1-deadbeef' }, body).reason, 'owner');
  writeFileSync(recordPath, JSON.stringify({ ...body, token_sha256: 'f'.repeat(64) }));
  assert.equal(isGrokContainmentOwnerLive(token, { tmpRoot: p.tmpRoot }), false, 'a tampered seal is not live');
  writeFileSync(recordPath, '{not json');
  assert.equal(readOwnerRecord(token.owner_id, { tmpRoot: p.tmpRoot }).reason, 'malformed');
  assert.equal(readOwnerRecord('grok-containment-owner-1-1-deadbeef', { tmpRoot: p.tmpRoot }).reason, 'absent');
  assert.equal(readOwnerRecord('../etc/passwd', { tmpRoot: p.tmpRoot }).reason, 'absent');
  if (process.platform !== 'win32') assert.equal(readOwnerRecord(token.owner_id, { tmpRoot: p.tmpRoot, expectedUid: process.getuid() + 1 }).reason, 'foreign_uid', 'a record owned by another uid is refused (the uid is injected because a test cannot chown)');
  // a planted record for a token that names a foreign helper path: the record binds but admission (Task 8) refuses on inventory-path equality
  const planted = { ...token, helper_path: '/elsewhere/helper' };
  planted.token_sha256 = supervisorTesting.tokenSeal(planted);
  assert.equal(isGrokContainmentOwnerLive(planted, { tmpRoot: p.tmpRoot }), false, 'the seal binds helper_path, so a planted path never validates against the stored seal');
  // a fully matching planted record for that foreign-path token: admission (Task 8) refuses on inventory-path equality BEFORE reading it
  // O_EXCL is the sole create predicate; the malformed file for this owner id must be gone first.
  rmSync(recordPath);
  supervisorTesting.writeOwnerRecordForTest({ record: Object.fromEntries(Object.keys(body.record).map((k) => [k, planted[k]])), token_sha256: planted.token_sha256, helper_sha256: body.helper_sha256, created_at: body.created_at }, p.tmpRoot);
  assert.equal(isGrokContainmentOwnerLive(planted, { tmpRoot: p.tmpRoot }), true, 'the planted record validates as a record');
  const runner = supervisorTesting.createContainedRunner({ platform: HOST_STUB_PLATFORM, arch: HOST_STUB_ARCH, nativeDirectory: p.stub.root, pluginRoot: p.stub.root, enabledPlatforms: ALL_INVENTORIED, tmpRoot: p.tmpRoot });
  await assert.rejects(() => runner.run(process.execPath, ['-e', '0'], { cwd: p.stub.root, env: process.env, timeoutMs: 5000, containmentToken: planted }), /foreign_containment_owner/u);
  assert.equal(existsSync(join(dir, `${planted.owner_id}.json`)), true, 'the planted record was not consumed');
  if (process.platform !== 'win32') {
    writeFileSync(recordPath, JSON.stringify(body));
    rmSync(recordPath); writeFileSync(join(p.tmpRoot, 'elsewhere.json'), JSON.stringify(body)); symlinkSync(join(p.tmpRoot, 'elsewhere.json'), recordPath);
    assert.equal(readOwnerRecord(token.owner_id, { tmpRoot: p.tmpRoot }).reason, 'symlink');
    const open = workspace('t-own-5-open');
    mkdirSync(join(open, 'deep-review-grok-containment'), { mode: 0o777 });
    chmodSync(join(open, 'deep-review-grok-containment'), 0o777);
    assert.equal(recordDirectory({ tmpRoot: open }).reason, 'record_directory_untrusted');
    const refused = stubPreflight('t-own-5-open-preflight', { tmpRoot: open });
    assert.equal(refused.result.reason, GROK_CONTAINMENT_HELPER_FAILED);
    assert.equal(refused.result.detail, 'record_directory_untrusted');
    // a directory that becomes untrusted AFTER the preflight: release and consume both refuse and unlink nothing
    const later = stubPreflight('t-own-5-later-untrusted');
    const laterDir = join(later.tmpRoot, 'deep-review-grok-containment');
    chmodSync(laterDir, 0o777);
    assert.deepEqual(releaseGrokContainment(later.result.containment_ready_token, { tmpRoot: later.tmpRoot }).released, false);
    assert.equal(existsSync(join(laterDir, `${later.result.containment_ready_token.owner_id}.json`)), true, 'nothing was unlinked through an untrusted directory');
    chmodSync(laterDir, 0o700);
    // a record replaced by a symlink to an outside file: consume refuses and the outside file survives
    const outside = join(later.tmpRoot, 'outside.json'); writeFileSync(outside, 'keep');
    const rec = join(laterDir, `${later.result.containment_ready_token.owner_id}.json`); rmSync(rec); symlinkSync(outside, rec);
    assert.equal(supervisorTesting.consumeOwnerRecordForTest(later.result.containment_ready_token.owner_id, later.tmpRoot).consumed, false);
    assert.equal(existsSync(outside), true, 'the symlink target was never unlinked');
  }
});

const preflightCli = join(pluginRoot, 'hooks', 'scripts', 'grok-containment-preflight.mjs');
function childEnvFor(tmpRoot) { return { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot }; }

test('T-OWN-14: --release from a child process removes the record with an empty registry and validates the whole token first', (t) => {
  const p = stubPreflight('t-own-14');
  if (p.skipReason) { t.skip(p.skipReason); return; }
  const token = p.result.containment_ready_token;
  const env = childEnvFor(p.tmpRoot);
  const recordPath = join(p.tmpRoot, 'deep-review-grok-containment', `${token.owner_id}.json`);
  for (const [label, bad] of [
    ['invalid json', '{'],
    ['owner id only', JSON.stringify({ owner_id: token.owner_id })],
    ['tampered seal', JSON.stringify({ ...token, token_sha256: 'f'.repeat(64) })],
    ['tampered helper path', JSON.stringify({ ...token, helper_path: '/elsewhere/helper' })],
    ['bad owner grammar', JSON.stringify({ ...token, owner_id: 'owner-x', token_sha256: supervisorTesting.tokenSeal({ ...token, owner_id: 'owner-x' }) })],
  ]) {
    const run = spawnSync(process.execPath, [preflightCli, '--release', '--containment-ready-token-json', bad], { encoding: 'utf8', env });
    assert.equal(run.status, 1, `${label}: ${run.stderr}`);
    assert.equal(run.stdout, '', label);
    assert.equal(existsSync(recordPath), true, `${label}: the record is untouched`);
  }
  const released = spawnSync(process.execPath, [preflightCli, '--release', '--containment-ready-token-json', JSON.stringify(token)], { encoding: 'utf8', env });
  assert.equal(released.status, 0, released.stderr);
  const parsed = JSON.parse(released.stdout.trim());
  assert.deepEqual([parsed.released, parsed.owner_id], [true, token.owner_id]);
  assert.equal(existsSync(recordPath), false);
  const again = spawnSync(process.execPath, [preflightCli, '--release', '--containment-ready-token-json', JSON.stringify(token)], { encoding: 'utf8', env });
  assert.equal(again.status, 3);
  assert.equal(JSON.parse(again.stdout.trim()).released, false);
});

// The preflight runs with a clean stub environment; faults and exit codes are
// applied to the LAUNCH environment only (sol R1 F7).
function stubRunner(label, { fault = '', platform = HOST_STUB_PLATFORM, arch = HOST_STUB_ARCH, providerOutput = 'PROVIDER OUTPUT LINE', exit = '0' } = {}) {
  const p = stubPreflight(label, { platform, arch });
  if (p.skipReason) return { skipReason: p.skipReason };
  const launchEnv = { ...scrubGrokEnvironment(process.env), STUB_FAULT: fault, STUB_MECHANISM: platform === 'linux' ? 'pid-namespace' : 'job-object', STUB_PROVIDER_OUTPUT: providerOutput, STUB_EXIT: exit };
  const runner = supervisorTesting.createContainedRunner({ platform, arch, nativeDirectory: p.stub.root, pluginRoot: p.stub.root, enabledPlatforms: ALL_INVENTORIED, tmpRoot: p.tmpRoot });
  const provider = process.execPath;   // sealed as native-elf on Linux, native-macho on macOS, PE on Windows -- all native
  const chain = prepareSpawnChain(provider, ['-e', '0'], { cwd: p.stub.root, env: launchEnv }).prepared_spawn_chain;
  const launch = (extra = {}) => runner.run(provider, ['-e', '0'], { cwd: p.stub.root, env: launchEnv, timeoutMs: 10000, expectedPreparedSpawnChain: chain, containmentToken: p.result.containment_ready_token, ...extra });
  return { ...p, launchEnv, runner, provider, chain, launch, token: p.result.containment_ready_token, recordPath: join(p.tmpRoot, 'deep-review-grok-containment', `${p.result.containment_ready_token.owner_id}.json`) };
}

test('T-OWN-6: the adapter maps the provider channel, binds the report, spawns the inventoried path and propagates exit status', async (t) => {
  const r = stubRunner('t-own-6');
  if (r.skipReason) { t.skip(r.skipReason); return; }
  const spawns = [];
  const result = await r.launch({ onSpawn: (info) => spawns.push(info) });
  assert.equal(result.code, 0);
  assert.equal(result.provider_channel, 'merged-owner-stderr');
  assert.match(result.stdout.toString('utf8'), /PROVIDER OUTPUT LINE/u);
  assert.equal(result.stderr.length, 0);
  assert.equal(result.termination_confirmed, true, JSON.stringify(result.detail));
  assert.deepEqual([result.termination_report.owner_id, result.termination_report.generation, result.termination_report.live_members, result.termination_report.handshake], [r.token.owner_id, 1, 0, 'ok']);
  assert.ok(Number.isFinite(result.termination_report.observed_at));
  assert.equal(result.control_lines.length, 2);
  assert.deepEqual([result.helper.path, result.helper.sha256], [r.stub.helperPath, r.stub.helperSha256]);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].helperPath, r.stub.helperPath, 'the adapter spawns gate.helper_path');
  assert.deepEqual(spawns[0].argv.slice(0, 4), ['--own-grok-tree', '--parent-pid', String(process.pid), '--']);
  assert.equal(Object.hasOwn(spawns[0].env, 'GROK_SANDBOX'), false);
  assert.equal(evaluateTerminationReport({ token: r.token, report: result.control_lines[1] }).termination_confirmed, false, 'a raw helper line never confirms on its own');
  for (const exit of ['64', '125', '127']) {
    const rr = stubRunner(`t-own-6-exit-${exit}`, { exit });
    const res = await rr.launch();
    assert.equal(res.code, Number(exit));
    assert.equal(res.termination_confirmed, true, `exit ${exit} with a report is still a confirmed tree`);
  }
  const crlf = stubRunner('t-own-6-crlf', { fault: 'crlf' });
  assert.equal((await crlf.launch()).termination_confirmed, true);
});

test('T-OWN-7: handshake-lost variants are unconfirmed whatever the exit status', async (t) => {
  for (const [fault, expectedCode] of [['no_ready', 0], ['wrong_mechanism', 0], ['extra_line', 0], ['report_not_last', 0], ['exit_125_no_report', 125]]) {
    const r = stubRunner(`t-own-7-${fault}`, { fault });
    if (r.skipReason) { t.skip(r.skipReason); return; }
    const res = await r.launch();
    assert.equal(res.code, expectedCode, fault);
    assert.equal(res.termination_confirmed, false, fault);
    assert.equal(res.termination_report, null, fault);
    assert.equal(res.detail, 'handshake_lost', `${fault}: the stub exits at once, so this is a lost handshake, never the start deadline (T-OWN-8 covers the hang)`);
  }
  const usage = stubRunner('t-own-7-usage');
  const res = await usage.launch({ __argvOverride: ['--own-grok-tree', '--parent-pid', 'abc'] });
  assert.deepEqual([res.code, res.termination_confirmed, res.detail], [64, false, 'handshake_lost']);
});

test('T-OWN-3: the record is consumed exactly once, only after every pre-spawn check, and never restored', async (t) => {
  const r = stubRunner('t-own-3');
  if (r.skipReason) { t.skip(r.skipReason); return; }
  const mismatch = await r.launch({ expectedPreparedSpawnChain: { ...r.chain, chain_sha256: 'f'.repeat(64) } });
  assert.equal(mismatch.preparedChainMismatch, true);
  assert.equal(existsSync(r.recordPath), true, 'a pre-spawn failure leaves the record');
  // the registry alone never admits: age the record past the TTL while liveOwners still holds the owner
  assert.equal(supervisorTesting.liveOwners.has(r.token.owner_id), true);
  const aged = supervisorTesting.createContainedRunner({ platform: HOST_STUB_PLATFORM, arch: HOST_STUB_ARCH, nativeDirectory: r.stub.root, pluginRoot: r.stub.root, enabledPlatforms: ALL_INVENTORIED, tmpRoot: r.tmpRoot, now: () => Date.now() + GROK_CONTAINMENT_TOKEN_TTL_MS + 1 });
  await assert.rejects(() => aged.run(r.provider, ['-e', '0'], { cwd: r.stub.root, env: r.launchEnv, timeoutMs: 10000, expectedPreparedSpawnChain: r.chain, containmentToken: r.token }), /containment_owner_not_live/u);
  assert.equal(existsSync(r.recordPath), true);
  // consume then spawn failure: not restored
  const r2 = stubRunner('t-own-3-spawnfail');
  await assert.rejects(() => r2.launch({ __spawnFailure: true }), /spawn_error/u);
  assert.equal(existsSync(r2.recordPath), false, 'consumed before the failed spawn, never restored');
  await assert.rejects(() => r2.launch(), /containment_owner_not_live/u);
  // the happy path consumes; a second in-process launch is refused; --release reports consumed
  const first = await r.launch();
  assert.equal(first.termination_confirmed, true);
  assert.equal(existsSync(r.recordPath), false);
  await assert.rejects(() => r.launch(), /containment_owner_not_live/u);
  assert.deepEqual(releaseGrokContainment(r.token, { tmpRoot: r.tmpRoot }), { released: true, reason: 'consumed', owner_id: r.token.owner_id, containment_ready: false });
  // cross-process: a child consumes, the parent is then refused. Everything the
  // child needs travels by FILE, never on argv: a Windows command line is capped
  // at 32767 characters and the launch env alone can exceed it.
  const r3 = stubRunner('t-own-3-child');
  const spec = join(r3.tmpRoot, 'child-spec.json');
  writeFileSync(spec, JSON.stringify({ context: { platform: HOST_STUB_PLATFORM, arch: HOST_STUB_ARCH, nativeDirectory: r3.stub.root, pluginRoot: r3.stub.root, enabledPlatforms: ALL_INVENTORIED, tmpRoot: r3.tmpRoot }, provider: r3.provider, cwd: r3.stub.root, env: r3.launchEnv, chain: r3.chain, token: r3.token }));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { __testing } from ${JSON.stringify(pathToFileURL(join(pluginRoot, 'hooks', 'scripts', 'lib', 'grok-process-supervisor.mjs')).href)};
    const spec = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const runner = __testing.createContainedRunner(spec.context);
    const result = await runner.run(spec.provider, ['-e', '0'], { cwd: spec.cwd, env: spec.env, timeoutMs: 10000, expectedPreparedSpawnChain: spec.chain, containmentToken: spec.token });
    process.stdout.write(JSON.stringify({ confirmed: result.termination_confirmed }));
  `, spec], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).confirmed, true);
  await assert.rejects(() => r3.launch(), /containment_owner_not_live/u);
});

test('T-OWN-6 (sync): runSync mirrors run for a clean launch, a timeout and an overflow, and reports onSpawn after the fact', (t) => {
  const r = stubRunner('t-own-6-sync');
  if (r.skipReason) { t.skip(r.skipReason); return; }
  const spawns = [];
  const res = r.runner.runSync(r.provider, ['-e', '0'], { cwd: r.stub.root, env: r.launchEnv, timeoutMs: 10000, expectedPreparedSpawnChain: r.chain, containmentToken: r.token, onSpawn: (i) => spawns.push(i) });
  assert.deepEqual([res.code, res.termination_confirmed, res.termination_ladder, res.provider_channel], [0, true, 'sync-kill', 'merged-owner-stderr']);
  assert.equal(spawns.length, 1);
  assert.match(res.stdout.toString('utf8'), /PROVIDER OUTPUT LINE/u);
  const hang = stubRunner('t-own-6-sync-timeout', { fault: 'hang_after_ready' });
  const late = hang.runner.runSync(hang.provider, ['-e', '0'], { cwd: hang.stub.root, env: hang.launchEnv, timeoutMs: 1000, expectedPreparedSpawnChain: hang.chain, containmentToken: hang.token });
  assert.deepEqual([late.timedOut, late.code, late.termination_confirmed], [true, 124, false]);
  const overflow = stubRunner('t-own-6-sync-overflow', { fault: 'overflow' });
  const big = overflow.runner.runSync(overflow.provider, ['-e', '0'], { cwd: overflow.stub.root, env: overflow.launchEnv, timeoutMs: 20000, expectedPreparedSpawnChain: overflow.chain, containmentToken: overflow.token });
  assert.deepEqual([big.captureOverflow, big.detail, big.termination_confirmed], [true, 'capture_overflow', false]);
});

test('T-OWN-8: timeout, start deadline and overflow are unconfirmed and the group is proven gone', async (t) => {
  const hang = stubRunner('t-own-8-hang', { fault: 'hang' });
  if (hang.skipReason) { t.skip(hang.skipReason); return; }
  const started = Date.now();
  const res = await hang.launch({ timeoutMs: 20000 });
  assert.ok(Date.now() - started < 15000, 'the 5 s start deadline fires before the 20 s timeout');
  assert.deepEqual([res.detail, res.termination_confirmed, res.group_gone], ['start_deadline', false, process.platform === 'win32' ? null : true]);
  const slow = stubRunner('t-own-8-timeout', { fault: 'hang_after_ready' });
  const late = await slow.launch({ timeoutMs: 1000 });
  assert.deepEqual([late.timedOut, late.code, late.termination_confirmed], [true, 124, false]);
  if (process.platform !== 'win32') assert.equal(late.group_gone, true, 'isPosixProcessGroupGone proved the group empty before resolving');
  const overflow = stubRunner('t-own-8-overflow', { fault: 'overflow' });
  const big = await overflow.launch({ timeoutMs: 20000 });
  assert.deepEqual([big.captureOverflow, big.detail, big.termination_confirmed], [true, 'capture_overflow', false]);
});

test('T-OWN-10/11: a non-native launcher and a sealed-chain mismatch never spawn the helper and leave the record', async (t) => {
  const r = stubRunner('t-own-10');
  if (r.skipReason) { t.skip(r.skipReason); return; }
  const spawns = [];
  if (process.platform !== 'win32') {
    const shebang = join(r.stub.root, 'grok-wrapper');
    writeFileSync(shebang, '#!/usr/bin/env node\nprocess.exit(0)\n'); chmodSync(shebang, 0o755);
    const shebangChain = prepareSpawnChain(shebang, [], { cwd: r.stub.root, env: r.launchEnv }).prepared_spawn_chain;
    await assert.rejects(() => r.runner.run(shebang, [], { cwd: r.stub.root, env: r.launchEnv, timeoutMs: 5000, expectedPreparedSpawnChain: shebangChain, containmentToken: r.token, onSpawn: (i) => spawns.push(i) }), (error) => error.reason === 'unsupported_prepared_chain' && error.containment_refusal?.stage === 'bridge_admission');
  }
  if (process.platform === 'win32') {
    const cmd = join(r.stub.root, 'grok.cmd');
    writeFileSync(cmd, '@echo off\r\nexit /b 0\r\n');
    const cmdChain = prepareSpawnChain(cmd, [], { cwd: r.stub.root, env: r.launchEnv }).prepared_spawn_chain;
    assert.notEqual(cmdChain.prepared_kind, 'direct');
    await assert.rejects(() => r.runner.run(cmd, [], { cwd: r.stub.root, env: r.launchEnv, timeoutMs: 5000, expectedPreparedSpawnChain: cmdChain, containmentToken: r.token, onSpawn: (i) => spawns.push(i) }), (error) => error.reason === 'unsupported_prepared_chain');
  }
  const mismatch = await r.launch({ expectedPreparedSpawnChain: { ...r.chain, chain_sha256: 'e'.repeat(64) }, onSpawn: (i) => spawns.push(i) });
  assert.deepEqual([mismatch.preparedChainMismatch, mismatch.code], [true, 2]);
  assert.deepEqual(spawns, []);
  assert.equal(existsSync(r.recordPath), true);
});

test('T-OWN-17 (adapter): a token for an inventoried-but-not-enabled platform is refused before any helper lookup', async (t) => {
  const r = stubRunner('t-own-17-adapter', { platform: 'win32', arch: 'x64' });
  if (r.skipReason) { t.skip(r.skipReason); return; }
  const lookups = [];
  const production = supervisorTesting.createContainedRunner({ platform: 'win32', arch: 'x64', nativeDirectory: r.stub.root, pluginRoot: r.stub.root, tmpRoot: r.tmpRoot });   // default enabled set
  const stat = lstatSync(r.stub.helperPath);
  rmSync(r.stub.helperPath);   // if admission looked the helper up it would now be missing_grok_containment_helper; the pending gate must fire first
  await assert.rejects(() => production.run(r.provider, ['-e', '0'], { cwd: r.stub.root, env: r.launchEnv, timeoutMs: 5000, expectedPreparedSpawnChain: r.chain, containmentToken: r.token, onSpawn: (i) => lookups.push(i) }),
    (error) => error.reason === UNSUPPORTED_GROK_CONTAINMENT && error.detail === 'platform_verification_pending' && error.containment_refusal?.stage === 'bridge_admission');
  assert.deepEqual(lookups, []);
  assert.equal(existsSync(r.recordPath), true);
  assert.ok(stat.isFile());
});

test('T-OWN-12 (admission): the runner accepts no helper seam', async (t) => {
  const r = stubRunner('t-own-12-admission');
  if (r.skipReason) { t.skip(r.skipReason); return; }
  writeFileSync(join(r.stub.root, 'SHA256SUMS'), readFileSync(join(r.stub.root, 'SHA256SUMS'), 'utf8').replace(r.stub.helperSha256, 'f'.repeat(64)));
  for (const seams of [{ helperExists: () => true }, { helperArtifact: ARTIFACT_OK }, { helperExists: () => true, helperArtifact: ARTIFACT_OK }]) {
    await assert.rejects(() => r.launch(seams), (error) => error.reason === GROK_CONTAINMENT_HELPER_FAILED && error.detail === 'integrity_mismatch', JSON.stringify(Object.keys(seams)));
    assert.throws(() => r.runner.runSync(r.provider, ['-e', '0'], { cwd: r.stub.root, env: r.launchEnv, timeoutMs: 5000, expectedPreparedSpawnChain: r.chain, containmentToken: r.token, ...seams }), /integrity_mismatch/u);
  }
  assert.equal(existsSync(r.recordPath), true);
});

test('T-OWN-9 (admission): a helper replaced between preflight and launch is record_digest_mismatch', async (t) => {
  const r = stubRunner('t-own-9-admit');
  if (r.skipReason) { t.skip(r.skipReason); return; }
  const bytes = readFileSync(r.stub.helperPath);
  writeFileSync(r.stub.helperPath, Buffer.concat([bytes, Buffer.from('\n')]));
  // re-sign the sums so SHA256SUMS matches the new bytes: only the record disagrees now
  const digest = createHash('sha256').update(readFileSync(r.stub.helperPath)).digest('hex');
  const sums = readFileSync(join(r.stub.root, 'SHA256SUMS'), 'utf8').replace(r.stub.helperSha256, digest);
  writeFileSync(join(r.stub.root, 'SHA256SUMS'), sums);
  await assert.rejects(() => r.launch(), (error) => error.reason === GROK_CONTAINMENT_HELPER_FAILED && error.detail === 'record_digest_mismatch');
  assert.equal(existsSync(r.recordPath), true);
});
