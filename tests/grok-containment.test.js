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
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  GROK_CONTAINMENT_INVENTORY,
  GROK_CONTAINMENT_PROTOCOL_VERSION,
  GROK_INVALID_LIFECYCLE,
  GROK_LIFECYCLE_UNCONFIRMED,
  GROK_TREE_HARD_DEADLINE_MS,
  GROK_TREE_POLL_MS,
  UNSUPPORTED_GROK_CONTAINMENT,
  assertContainmentReadyToken,
  evaluateContainedLaunchAdmission,
  evaluateTerminationReport,
  isGrokContainmentPlatformSupported,
  preflightGrokContainment,
  releaseGrokContainment,
  resolveGrokContainmentPlatform,
  runGrokContainedProcess,
  runGrokContainedProcessSync,
  __testing as supervisorTesting,
} from '../hooks/scripts/lib/grok-process-supervisor.mjs';
import {
  classifyContainmentRelease,
  withGrokContainment,
} from '../hooks/scripts/grok-containment-preflight.mjs';
import { buildCapabilities } from '../hooks/scripts/lib/capability-registry.mjs';
import { buildRoutingPlan } from '../hooks/scripts/lib/model-router.mjs';
import { planReviewerAssignments } from '../hooks/scripts/lib/adaptive-review-routing.mjs';
import { synthesizeReviewRound } from '../hooks/scripts/review-synthesis.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_COMMIT = '1c3ef2d';
const HOST_CONTAINMENT_GATE = resolveGrokContainmentPlatform();
const SUPPORTED_HERE = HOST_CONTAINMENT_GATE.supported;
const PLATFORM_SKIP = `${HOST_CONTAINMENT_GATE.key} is not a Grok containment platform`;
const HELPER_SKIP = 'the inventoried native containment helpers are not present in this tree';

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
    assert.equal(gate.reason, UNSUPPORTED_GROK_CONTAINMENT, `${platform}/${arch}`);
    assert.equal(gate.mechanism, null);
    assert.equal(gate.helper_path, null);
  }
  for (const [platform, arch, mechanism] of [
    ['linux', 'x64', 'pid-namespace'],
    ['win32', 'x64', 'job-object'],
  ]) {
    const gate = resolveGrokContainmentPlatform({ platform, arch });
    assert.equal(gate.supported, true, `${platform}/${arch} is a declared containment platform`);
    assert.equal(gate.reason, null);
    assert.equal(gate.mechanism, mechanism);
    assert.equal(typeof gate.helper_path, 'string');
  }
});

test('the native source tree contains no built artifact, so D21 still fails closed on every platform', () => {
  const nativeDirectory = join(pluginRoot, 'hooks', 'scripts', 'lib', 'native');
  for (const [key, entry] of Object.entries(GROK_CONTAINMENT_INVENTORY)) {
    const [platform, arch] = key.split('/');
    const gate = resolveGrokContainmentPlatform({ platform, arch });
    assert.equal(existsSync(gate.helper_path), false, `${entry.helper} must not be present`);
  }
  const nativeEntries = sourceEntriesBelow(nativeDirectory);
  assert.equal(nativeEntries.includes('SHA256SUMS'), false,
    'SHA256SUMS is release-automation output and must not exist in the source tree');
  assert.deepEqual(nativeEntries.filter((relativePath) => !relativePath.endsWith('.c')), [],
    'only reproducible C sources may exist under the native source tree');
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
    const supported = preflightGrokContainment({ platform, arch });
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
    ownerIdGenerator: () => { events.push('owner'); return 'owner-x'; },
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

// ---------------------------------------------------------------------------
// D21 — the bounded owner-handshake constants and the token contract.
// ---------------------------------------------------------------------------

test('the owner handshake uses the D20 bounded polling constants', () => {
  assert.equal(GROK_TREE_POLL_MS, 10);
  assert.equal(GROK_TREE_HARD_DEADLINE_MS, 1000);
});

test('assertContainmentReadyToken refuses a missing, unready, foreign-sealed or malformed token', () => {
  const valid = supervisorTesting.mintOwnerToken({
    platform: 'linux', arch: 'x64', ownerId: 'owner-1', generation: 1, startedAt: 1000,
  });
  assert.equal(assertContainmentReadyToken(valid).owner_id, 'owner-1');
  assert.equal(valid.protocol_version, GROK_CONTAINMENT_PROTOCOL_VERSION);

  const refusals = [
    [undefined, 'missing'],
    [null, 'null'],
    ['token', 'string'],
    [{ ...valid, protocol_version: '9.9' }, 'wrong protocol'],
    [{ ...valid, containment_ready: false }, 'not ready'],
    [{ ...valid, owner_id: 'someone-else' }, 'foreign owner breaks the seal'],
    [{ ...valid, mechanism: 'setsid-census' }, 'census is not containment'],
    [{ ...valid, token_sha256: 'f'.repeat(64) }, 'forged seal'],
    [{ ...valid, generation: 0 }, 'non-positive generation'],
    [{ ...valid, helper_path: '' }, 'no helper'],
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
    platform: 'linux', arch: 'x64', ownerId: 'owner-life', generation: 2, startedAt: 5000, ...overrides,
  });
}

test('termination_confirmed is true only for an owner-bound report of zero live members', () => {
  const token = liveToken();
  const confirmed = evaluateTerminationReport({
    token,
    report: { owner_id: 'owner-life', generation: 2, live_members: 0, member_pids: [], observed_at: 5100 },
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
    [{ owner_id: 'owner-life', generation: 2, live_members: 0 }, 'malformed_termination_report'],
    [{ owner_id: 'foreign', generation: 2, live_members: 0, member_pids: [], observed_at: 1 }, 'foreign_owner'],
    [{ owner_id: 'owner-life', generation: 9, live_members: 0, member_pids: [], observed_at: 1 }, 'foreign_owner'],
    [{ owner_id: 'owner-life', generation: 2, live_members: 3, member_pids: [11, 12, 13], observed_at: 1 }, 'live_members_remain'],
    [{ owner_id: 'owner-life', generation: 2, live_members: 0, member_pids: [7], observed_at: 1 }, 'member_pids_contradict_live_members'],
    [{ owner_id: 'owner-life', generation: 2, live_members: 0, member_pids: [], observed_at: 1, handshake: 'lost' }, 'handshake_lost'],
    [{ owner_id: 'owner-life', generation: 2, live_members: 0, member_pids: [], observed_at: 1, deadline_exceeded: true }, 'hard_deadline_exceeded'],
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
    ? /containment_owner_not_live/u
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
    helperExists: () => true,
    executableResolver: (helperPath) => helperPath,
    helperSpawner: () => ({ ok: true }),
    ownerIdGenerator: () => 'owner-live-on-foreign-host',
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
    hostGate: resolveGrokContainmentPlatform({ platform: 'win32', arch: 'x64' }),
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

test('a contained Grok provider launch inside a Linux PID namespace leaves zero surviving namespace members', {
  skip: process.platform === 'linux' && process.arch === 'x64' ? HELPER_SKIP : PLATFORM_SKIP,
}, () => {
  assert.fail('unreachable: this polarity requires the inventoried Linux helper');
});

test('a contained Grok provider launch inside a native Windows Job Object reports zero live members', {
  skip: process.platform === 'win32' && process.arch === 'x64' ? HELPER_SKIP : PLATFORM_SKIP,
}, () => {
  assert.fail('unreachable: this polarity requires the inventoried native Windows helper');
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
  const token = liveToken({ ownerId: 'owner-release' });
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
    assert.deepEqual(releases, [{ owner_id: 'owner-release', reason: expected }], label);
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
