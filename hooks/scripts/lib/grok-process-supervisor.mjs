// The retained OS containment owner for the Grok provider-content tree
// (SLICE-008c — D19, D20, D21; I35, I36, I38, I41).
//
// What this module is: the JS supervisor that loads an inventoried platform
// helper, or refuses provider-content spawn before it starts. What it is not:
// a containment mechanism of its own. A `/proc` or `libproc` snapshot census,
// setsid/group membership, a start-time window, `PR_SET_CHILD_SUBREAPER` plus
// pidfd tracking, and `taskkill` completion are each explicitly rejected as
// containment (D20/D21) — a rapid escaped descendant can double-fork, call
// `setsid`, and reparent between two polls.
//
// Two platforms are inventoried and no more:
//
//   linux/x64  a PID namespace created with `CLONE_NEWPID` (plus `CLONE_NEWUSER`
//              when the helper is unprivileged). Every Grok descendant starts
//              inside the namespace and cannot leave it; enumeration is the
//              namespace member set.
//   win32/x64  a Job Object created before spawn, with kill-on-close set and
//              both breakaway limits denied, assigned to a `CREATE_SUSPENDED`
//              process before it resumes. Ordinary Node spawn followed by a
//              later `AssignProcessToJobObject` is refused, because it is not
//              atomic and Node 22 exposes no Job Object API.
//
// macOS is not on that list and never gets invented onto it: D21 states there
// is no shipped macOS helper and no macOS success polarity. Every other
// platform/arch pair — macOS, Linux aarch64, Windows ARM64 — is known from
// `process.platform` / `process.arch` at process start and fails closed with
// `unsupported_grok_containment` before executable lookup, carrier creation,
// compatibility probes, or provider spawn.
//
// The inventoried helper artifacts are production artifacts that are not
// present in this tree. Until one exists and loads, every platform refuses.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  DEFAULT_NATIVE_DIRECTORY,
  DEFAULT_PLUGIN_ROOT,
  GROK_CONTAINMENT_INVENTORY,
  NATIVE_INVENTORY_PATHS,
  NATIVE_PLACEHOLDER_DIGEST,
  evaluateHelperArtifact,
  isNativeGrokLauncher,
  nativeTreeState,
  parseSha256Sums,
} from './grok-native-artifact.mjs';
import { parseOwnerControlLines, sanitizeHelperStderr } from './grok-owner-control.mjs';
import {
  OWNER_ID_PATTERN,
  consumeOwnerRecord,
  readOwnerRecord,
  recordDirectory,
  sweepOwnerRecords,
  unlinkOwnerRecord,
  validateOwnerRecord,
  writeOwnerRecord,
} from './grok-owner-record.mjs';
import {
  POSIX_GROUP_EXIT_HARD_DEADLINE_MS,
  POSIX_GROUP_EXIT_POLL_MS,
  POSIX_TERMINATION_GRACE_MS,
  closedPreparedChainResult,
  comparePreparedSpawnChains,
  isPosixProcessGroupGone,
  prepareSpawnChain,
  signalPosixProcessGroup,
} from './process.mjs';
export {
  GROK_CONTAINMENT_INVENTORY,
  NATIVE_INVENTORY_PATHS,
  NATIVE_PLACEHOLDER_DIGEST,
  isNativeGrokLauncher,
  nativeTreeState,
  parseSha256Sums,
};

export const GROK_CONTAINMENT_PROTOCOL_VERSION = '1.0';

// The canonical shortfall reason. `capability-registry.mjs` seals it,
// `model-router.mjs` carries it, `adaptive-review-routing.mjs` translates it
// and `review-synthesis.mjs` reads it terminally.
export const UNSUPPORTED_GROK_CONTAINMENT = 'unsupported_grok_containment';
export const MISSING_GROK_CONTAINMENT_HELPER = 'missing_grok_containment_helper';
export const GROK_CONTAINMENT_HELPER_FAILED = 'grok_containment_helper_failed';
const ENABLED_PLATFORM_SET = new Set(['linux/x64']);
export const GROK_ENABLED_PLATFORMS = Object.freeze([...ENABLED_PLATFORM_SET]);
export function isGrokPlatformEnabled(key, enabledPlatforms) {
  return (enabledPlatforms ? new Set(enabledPlatforms) : ENABLED_PLATFORM_SET).has(key);
}

export const GROK_LIFECYCLE_UNCONFIRMED = 'lifecycle_unconfirmed';
export const GROK_INVALID_LIFECYCLE = 'invalid_grok_process_lifecycle';

// D20's bounded owner-handshake polling.
export const GROK_TREE_POLL_MS = 10;
export const GROK_TREE_HARD_DEADLINE_MS = 1000;
export const GROK_OWNER_START_DEADLINE_MS = 5000;
export const GROK_CONTAINMENT_TOKEN_TTL_MS = 30 * 60 * 1000;
export const GROK_PROVIDER_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
export const GROK_CONTROL_CAPTURE_MAX_BYTES = 65536;

export function scrubGrokEnvironment(parentEnv = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(parentEnv)) { if (key.toUpperCase() === 'GROK_SANDBOX') continue; out[key] = value; }
  return out;
}

function containmentError(reason, detail) {
  const error = new Error(`ERROR_GROK_CONTAINMENT: ${reason}${detail ? ` — ${detail}` : ''}`);
  error.reason = reason;
  return error;
}

// ---------------------------------------------------------------------------
// D21 — the platform/arch gate. Evaluated from `process.platform` and
// `process.arch` alone, so it decides before anything can be looked up, probed
// or spawned.
// ---------------------------------------------------------------------------

export function resolveGrokContainmentPlatform({
  platform = process.platform,
  arch = process.arch,
  nativeDirectory = DEFAULT_NATIVE_DIRECTORY,
  enabledPlatforms,
} = {}) {
  const key = `${platform}/${arch}`;
  const entry = Object.hasOwn(GROK_CONTAINMENT_INVENTORY, key)
    ? GROK_CONTAINMENT_INVENTORY[key]
    : null;
  if (entry === null) {
    return Object.freeze({
      key,
      platform,
      arch,
      supported: false,
      inventoried: false,
      reason: UNSUPPORTED_GROK_CONTAINMENT,
      detail: null,
      mechanism: null,
      helper_path: null,
      source: null,
    });
  }
  if (!isGrokPlatformEnabled(key, enabledPlatforms)) {
    return Object.freeze({
      key,
      platform,
      arch,
      supported: false,
      inventoried: true,
      reason: UNSUPPORTED_GROK_CONTAINMENT,
      detail: 'platform_verification_pending',
      mechanism: entry.mechanism,
      helper_path: join(nativeDirectory, ...entry.helper.split('/')),
      source: entry.source,
    });
  }
  return Object.freeze({
    key,
    platform,
    arch,
    supported: true,
    inventoried: true,
    reason: null,
    detail: null,
    mechanism: entry.mechanism,
    helper_path: join(nativeDirectory, ...entry.helper.split('/')),
    source: entry.source,
  });
}

export function isGrokContainmentPlatformSupported(options = {}) {
  return resolveGrokContainmentPlatform(options).supported;
}

// ---------------------------------------------------------------------------
// The owner-bound `containment_ready_token`.
//
// The seal is what makes the token *owner-bound*: it is a digest over the
// durable owner record, so a token whose owner, generation, platform,
// mechanism, helper or readiness has been edited no longer verifies. Only
// `preflightGrokContainment` registers a live owner, so a well-formed token
// alone still cannot run a contained process.
// ---------------------------------------------------------------------------

const TOKEN_FIELDS = Object.freeze([
  'protocol_version',
  'containment_ready',
  'owner_id',
  'generation',
  'platform',
  'arch',
  'mechanism',
  'helper_path',
  'started_at',
]);

function tokenSeal(record) {
  const canonical = TOKEN_FIELDS.map((field) => `${field}=${String(record[field])}`).join('\0');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function mintOwnerToken({ platform, arch, ownerId, generation, startedAt, nativeDirectory }) {
  const gate = resolveGrokContainmentPlatform({ platform, arch, nativeDirectory });
  if (!gate.inventoried) throw containmentError(UNSUPPORTED_GROK_CONTAINMENT, gate.key);
  const record = {
    protocol_version: GROK_CONTAINMENT_PROTOCOL_VERSION,
    containment_ready: true,
    owner_id: ownerId,
    generation,
    platform: gate.platform,
    arch: gate.arch,
    mechanism: GROK_CONTAINMENT_INVENTORY[gate.key].mechanism,
    helper_path: gate.helper_path,
    started_at: startedAt,
  };
  return Object.freeze({ ...record, token_sha256: tokenSeal(record) });
}

export function assertContainmentReadyToken(token) {
  if (token === null || typeof token !== 'object' || Array.isArray(token)) {
    throw containmentError('missing_containment_ready_token', 'no owner-bound token was supplied');
  }
  if (token.protocol_version !== GROK_CONTAINMENT_PROTOCOL_VERSION) {
    throw containmentError('invalid_containment_ready_token', 'unknown token protocol');
  }
  if (token.containment_ready !== true) {
    throw containmentError('containment_not_ready', 'the token does not carry containment_ready');
  }
  if (typeof token.owner_id !== 'string' || !OWNER_ID_PATTERN.test(token.owner_id)) {
    throw containmentError('invalid_containment_ready_token', 'no owner_id');
  }
  if (!Number.isSafeInteger(token.generation) || token.generation <= 0) {
    throw containmentError('invalid_containment_ready_token', 'generation must be a positive integer');
  }
  const gate = resolveGrokContainmentPlatform({ platform: token.platform, arch: token.arch });
  if (!gate.inventoried || token.mechanism !== GROK_CONTAINMENT_INVENTORY[gate.key].mechanism) {
    throw containmentError(UNSUPPORTED_GROK_CONTAINMENT, `${token.platform}/${token.arch} is not an inventoried containment platform`);
  }
  if (typeof token.helper_path !== 'string' || token.helper_path.length === 0
      || !isAbsolute(token.helper_path)) {
    throw containmentError('invalid_containment_ready_token', 'no inventoried helper path');
  }
  if (token.token_sha256 !== tokenSeal(token)) {
    throw containmentError('foreign_containment_owner', 'the token is not bound to the owner it names');
  }
  return token;
}

// ---------------------------------------------------------------------------
// D20 — the retained owner registry. The owner survives orchestrator exit; in
// this process it is tracked so that a released owner cannot be reused and a
// foreign owner cannot be reconnected.
// ---------------------------------------------------------------------------

const liveOwners = new Map();
const consumedOwners = new Set();
let ownerSequence = 0;

function defaultOwnerId() {
  ownerSequence += 1;
  return `grok-containment-owner-${process.pid}-${ownerSequence}-${randomBytes(4).toString('hex')}`;
}

function defaultHelperSpawner(helperPath, args, { mechanism, env = scrubGrokEnvironment(process.env), pluginRoot = null } = {}) {
  const run = spawnSync(helperPath, args, { input: '', timeout: GROK_OWNER_START_DEADLINE_MS, killSignal: 'SIGKILL', windowsHide: true, shell: false, cwd: tmpdir(), env });
  const helperStderr = sanitizeHelperStderr(run.stderr, { pluginRoot });
  if (run.error?.code === 'ETIMEDOUT') return { ok: false, detail: 'start_deadline', helper_stderr: helperStderr };
  if (run.error) return { ok: false, detail: 'spawn_error', helper_stderr: helperStderr };
  if (run.signal) return { ok: false, detail: `helper_signal_${run.signal}`, helper_stderr: helperStderr };
  if (run.status !== 0) return { ok: false, detail: `helper_exit_${run.status}`, helper_stderr: helperStderr };
  const control = parseOwnerControlLines(run.stdout);
  if (!control.ok || control.lines[0].mechanism !== mechanism || control.lines[1].live_members !== 0 || control.lines[1].member_pids.length !== 0) {
    return { ok: false, detail: 'handshake_lost', helper_stderr: helperStderr };
  }
  return { ok: true };
}

export function isGrokContainmentOwnerLive(token, { tmpRoot = tmpdir(), now, ttlMs } = {}) {
  const read = readOwnerRecord(token?.owner_id, { tmpRoot, now, ttlMs });
  return read.ok && validateOwnerRecord(token, read.body).ok;
}

function refusal({ platform, arch, reason, gate, detail, helperStderr }) {
  return Object.freeze({
    ok: false,
    containment_ready: false,
    containment_ready_token: null,
    reason,
    detail: detail ?? gate?.detail ?? null,
    platform,
    arch,
    mechanism: gate?.supported ? gate.mechanism : null,
    helper_path: gate?.supported ? gate.helper_path : null,
    owner_id: null,
    ...(helperStderr !== undefined ? { helper_stderr: helperStderr } : {}),
  });
}

// D21's pre-launch admission. Its production call site is after routing
// classification and before privacy, fingerprint, UUID, prompt composition and
// provider launch. It issues an owner-bound token on success and none on
// refusal; a refusal produces zero executable lookup and zero child.
export function preflightGrokContainment(options = {}) {
  const {
    platform = process.platform, arch = process.arch, pluginRoot = DEFAULT_PLUGIN_ROOT,
    now = () => Date.now(), ownerIdGenerator = defaultOwnerId, helperExists = null, helperArtifact = null,
    executableResolver = (helperPath) => helperPath, helperSpawner = defaultHelperSpawner,
    enabledPlatforms, env, tmpRoot = tmpdir(), ttlMs = GROK_CONTAINMENT_TOKEN_TTL_MS,
  } = options;
  const productionMode = !Object.hasOwn(options, 'nativeDirectory');
  const nativeDirectory = productionMode ? join(pluginRoot, 'hooks', 'scripts', 'lib', 'native') : options.nativeDirectory;
  const gate = resolveGrokContainmentPlatform({ platform, arch, nativeDirectory, enabledPlatforms });
  if (!gate.supported) return refusal({ platform, arch, reason: UNSUPPORTED_GROK_CONTAINMENT, gate });
  const artifact = helperArtifact
    ? helperArtifact(gate, { nativeDirectory, pluginRoot, productionMode })
    : evaluateHelperArtifact(gate, { nativeDirectory, pluginRoot, productionMode });
  if (!artifact.present || !artifact.executable || (helperExists && !helperExists(gate.helper_path))) {
    return refusal({ platform, arch, reason: MISSING_GROK_CONTAINMENT_HELPER, gate });
  }
  if (artifact.integrity !== 'ok') {
    return refusal({ platform, arch, reason: GROK_CONTAINMENT_HELPER_FAILED, gate, detail: `integrity_${artifact.integrity}` });
  }
  sweepOwnerRecords({ tmpRoot, now, ttlMs });
  const directory = recordDirectory({ tmpRoot });
  if (!directory.ok) return refusal({ platform, arch, reason: GROK_CONTAINMENT_HELPER_FAILED, gate, detail: 'record_directory_untrusted' });
  const helperExecutable = executableResolver(gate.helper_path);
  if (typeof helperExecutable !== 'string' || helperExecutable.length === 0) {
    return refusal({ platform, arch, reason: MISSING_GROK_CONTAINMENT_HELPER, gate });
  }
  const owner = helperSpawner(helperExecutable, ['--own-grok-tree', '--parent-pid', String(process.pid)], {
    mechanism: gate.mechanism, env: scrubGrokEnvironment(env ?? process.env), pluginRoot,
  });
  if (!owner?.ok) {
    return refusal({
      platform, arch, reason: GROK_CONTAINMENT_HELPER_FAILED, gate,
      detail: owner?.detail ?? 'spawn_error', helperStderr: owner?.helper_stderr ?? '',
    });
  }
  const ownerId = ownerIdGenerator();
  const generation = 1;
  const startedAt = now();
  const token = mintOwnerToken({ platform, arch, ownerId, generation, startedAt, nativeDirectory });
  liveOwners.set(ownerId, { generation, mechanism: gate.mechanism, helper_path: gate.helper_path, started_at: startedAt });
  try {
    writeOwnerRecord({
      record: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, token[field]])),
      tokenSha256: token.token_sha256,
      helperSha256: artifact.helper_sha256,
      createdAt: startedAt,
    }, { tmpRoot });
  } catch (error) {
    liveOwners.delete(ownerId);
    return refusal({ platform, arch, reason: GROK_CONTAINMENT_HELPER_FAILED, gate, detail: error.reason ?? 'record_write_failed' });
  }
  return Object.freeze({ ok: true, containment_ready: true, containment_ready_token: token, reason: null, platform: gate.platform, arch: gate.arch, mechanism: gate.mechanism, helper_path: gate.helper_path, owner_id: ownerId });
}

export function releaseGrokContainment(token, { reason = 'no_launch', tmpRoot = tmpdir() } = {}) {
  if (token === null || typeof token !== 'object' || typeof token.owner_id !== 'string') {
    return Object.freeze({ released: false, reason: 'no_owner', owner_id: null, containment_ready: false });
  }
  const directoryTrusted = recordDirectory({ tmpRoot }).ok;
  const registry = liveOwners.delete(token.owner_id);
  const record = directoryTrusted ? unlinkOwnerRecord(token.owner_id, { tmpRoot }) : false;
  const consumed = consumedOwners.has(token.owner_id);
  const released = consumed || (directoryTrusted && (registry || record));
  return Object.freeze({
    released,
    reason: released ? (record || (directoryTrusted && registry) ? reason : 'consumed') : 'no_owner',
    owner_id: token.owner_id,
    containment_ready: false,
  });
}

// ---------------------------------------------------------------------------
// D19 / I36 / I38 — termination is proven by the owner, never assumed.
//
// `termination_confirmed: true` is reachable only through an owner-bound
// `termination_report` that names this owner and this generation and reports
// zero live members. Everything else — a missing report, a foreign owner, a
// dropped handshake, a deadline, or any surviving member — is the terminal
// `lifecycle_unconfirmed` / `invalid_grok_process_lifecycle` state, which is
// round-terminal and has no retry or resume fallback.
// ---------------------------------------------------------------------------

function unconfirmed(reason, observedAt = null) {
  return Object.freeze({
    termination_confirmed: false,
    process_tree_termination: Object.freeze({
      state: 'unconfirmed',
      observer: 'grok-process-supervisor',
      observed_at: observedAt,
      live_members: null,
    }),
    diagnostic: GROK_LIFECYCLE_UNCONFIRMED,
    error_code: GROK_INVALID_LIFECYCLE,
    reason,
  });
}

export function evaluateTerminationReport({ token = null, report = null } = {}) {
  if (report === null || report === undefined) return unconfirmed('missing_termination_report');
  if (typeof report !== 'object' || Array.isArray(report)) {
    return unconfirmed('malformed_termination_report');
  }
  if (typeof report.owner_id !== 'string'
      || !Number.isSafeInteger(report.generation)
      || !Number.isSafeInteger(report.live_members)
      || report.live_members < 0
      || !Array.isArray(report.member_pids)
      || !Number.isFinite(report.observed_at)) {
    return unconfirmed('malformed_termination_report');
  }
  if (token === null || typeof token !== 'object'
      || report.owner_id !== token.owner_id
      || report.generation !== token.generation) {
    return unconfirmed('foreign_owner', report.observed_at);
  }
  if (report.handshake === 'lost') return unconfirmed('handshake_lost', report.observed_at);
  if (report.deadline_exceeded === true) return unconfirmed('hard_deadline_exceeded', report.observed_at);
  if (report.live_members !== 0) return unconfirmed('live_members_remain', report.observed_at);
  if (report.member_pids.length !== 0) {
    return unconfirmed('member_pids_contradict_live_members', report.observed_at);
  }
  return Object.freeze({
    termination_confirmed: true,
    process_tree_termination: Object.freeze({
      state: 'confirmed',
      observer: 'grok-process-supervisor',
      observed_at: report.observed_at,
      live_members: 0,
    }),
    diagnostic: null,
    error_code: null,
    reason: null,
  });
}

// ---------------------------------------------------------------------------
// The Grok-specific contained runners. Shared `runProcess` / `runProcessSync`
// keep their wait, kill, timeout and return semantics unchanged; only the Grok
// provider-content tree comes through here.
// ---------------------------------------------------------------------------

// The admission predicate, as a decision rather than a sequence of throws, so
// each of its four rules is independently observable. Deciding `ok: true` is
// not a launch and not a containment success: it only says nothing refused the
// launch, and the caller still has to load a helper that does not exist here.
export function evaluateContainedLaunchAdmission({
  token, hostGate, ownerLive, helperPresent,
} = {}) {
  if (!hostGate?.supported) {
    return { ok: false, reason: UNSUPPORTED_GROK_CONTAINMENT, detail: `${hostGate?.key} cannot contain a Grok provider tree` };
  }
  if (token.platform !== hostGate.platform || token.arch !== hostGate.arch) {
    return { ok: false, reason: 'foreign_containment_owner', detail: 'the token was issued for another platform' };
  }
  if (ownerLive !== true) {
    return { ok: false, reason: 'containment_owner_not_live', detail: 'the preflighted owner was released or never existed' };
  }
  if (helperPresent !== true) {
    return { ok: false, reason: MISSING_GROK_CONTAINMENT_HELPER, detail: token.helper_path };
  }
  return { ok: true, reason: null, detail: null };
}

function refusalError(reason, detail, { remedy = null, ownerId = null } = {}) {
  const error = containmentError(reason, detail);
  error.detail = detail;
  error.containment_refusal = { ok: false, stage: 'bridge_admission', reason, detail, remedy, owner_id: ownerId };
  return error;
}

function admit(ctx, options) {
  let token;
  try { token = assertContainmentReadyToken(options?.containmentToken ?? null); }
  catch (error) { throw refusalError(error.reason ?? 'invalid_containment_ready_token', error.message, { ownerId: options?.containmentToken?.owner_id ?? null }); }
  const gate = resolveGrokContainmentPlatform({ platform: ctx.platform, arch: ctx.arch, nativeDirectory: ctx.nativeDirectory, enabledPlatforms: ctx.enabledPlatforms });
  const base = evaluateContainedLaunchAdmission({ token, hostGate: gate, ownerLive: true, helperPresent: true });
  if (!base.ok) throw refusalError(base.reason, gate.detail ?? base.detail, { ownerId: token.owner_id });
  if (token.mechanism !== gate.mechanism || token.helper_path !== gate.helper_path) throw refusalError('foreign_containment_owner', 'the token names another helper path', { ownerId: token.owner_id });
  const artifact = evaluateHelperArtifact(gate, { nativeDirectory: ctx.nativeDirectory, pluginRoot: ctx.pluginRoot, productionMode: ctx.productionMode });
  // E5: symlink_component and outside_root are helper_failed even when present
  // is still false (the walk returns before lstat). A missing file keeps the
  // default sums_missing integrity and is missing_grok_containment_helper.
  if (artifact.integrity !== 'ok' && (artifact.present || artifact.integrity !== 'sums_missing')) {
    throw refusalError(GROK_CONTAINMENT_HELPER_FAILED, `integrity_${artifact.integrity}`, { ownerId: token.owner_id });
  }
  if (!artifact.present || !artifact.executable) throw refusalError(MISSING_GROK_CONTAINMENT_HELPER, gate.helper_path, { ownerId: token.owner_id });
  const read = readOwnerRecord(token.owner_id, { tmpRoot: ctx.tmpRoot, now: ctx.now, ttlMs: GROK_CONTAINMENT_TOKEN_TTL_MS });
  if (!read.ok) throw refusalError('containment_owner_not_live', read.reason, { ownerId: token.owner_id });
  const bound = validateOwnerRecord(token, read.body);
  if (!bound.ok) throw refusalError('containment_owner_not_live', `record_${bound.reason}`, { ownerId: token.owner_id });
  if (read.body.helper_sha256 !== artifact.helper_sha256) throw refusalError(GROK_CONTAINMENT_HELPER_FAILED, 'record_digest_mismatch', { ownerId: token.owner_id });
  return { token, gate, artifact };
}

function prepareProvider(command, args, options) {
  const reprepared = prepareSpawnChain(command, args, { cwd: options.cwd, env: options.env });
  if (!reprepared.ok) return { closed: closedPreparedChainResult(reprepared.reason, { captureOverflow: false }) };
  if (options.expectedPreparedSpawnChain !== undefined) {
    const mismatch = comparePreparedSpawnChains(options.expectedPreparedSpawnChain, reprepared.prepared_spawn_chain);
    if (mismatch) return { closed: closedPreparedChainResult(mismatch, { captureOverflow: false }) };
  }
  return { prepared: reprepared.prepared, chain: reprepared.prepared_spawn_chain };
}

function consume(token, ctx) {
  if (!consumeOwnerRecord(token.owner_id, { tmpRoot: ctx.tmpRoot }).consumed) {
    throw refusalError('containment_owner_not_live', 'the record was consumed by another admission', { ownerId: token.owner_id });
  }
  liveOwners.delete(token.owner_id);
  consumedOwners.add(token.owner_id);
}

function bindReport(token, control, now) {
  if (!control.ok || control.lines[0].mechanism !== token.mechanism) return { termination_report: null, termination_confirmed: false };
  const last = control.lines[1];
  const report = { live_members: last.live_members, member_pids: [...last.member_pids], owner_id: token.owner_id, generation: token.generation, observed_at: now(), handshake: 'ok' };
  return { termination_report: report, termination_confirmed: evaluateTerminationReport({ token, report }).termination_confirmed };
}

function helperArgv(prepared, override) {
  return override ?? ['--own-grok-tree', '--parent-pid', String(process.pid), '--', prepared.command, ...prepared.args];
}

function createContainedRunner(context = {}) {
  const ctx = {
    platform: process.platform, arch: process.arch, pluginRoot: DEFAULT_PLUGIN_ROOT,
    enabledPlatforms: undefined, tmpRoot: tmpdir(), now: () => Date.now(), ...context,
  };
  ctx.productionMode = !Object.hasOwn(context, 'nativeDirectory');
  if (!Object.hasOwn(context, 'nativeDirectory')) {
    ctx.nativeDirectory = join(ctx.pluginRoot, 'hooks', 'scripts', 'lib', 'native');
  }
  if (ctx.enabledPlatforms !== undefined) ctx.enabledPlatforms = [...new Set(ctx.enabledPlatforms)];

  async function run(command, args = [], options = {}) {
    const { token, gate, artifact } = admit(ctx, options);
    const prep = prepareProvider(command, args, options);
    if (prep.closed) return prep.closed;
    if (!isNativeGrokLauncher(prep.chain)) throw refusalError('unsupported_prepared_chain', prep.chain.prepared_kind === 'direct' ? `direct:${prep.chain.posix_executable_type}` : prep.chain.prepared_kind, { ownerId: token.owner_id });
    consume(token, ctx);
    if (options.__spawnFailure) {
      throw refusalError('spawn_error', 'test-injected spawn failure', { ownerId: token.owner_id });
    }
    const argv = helperArgv(prep.prepared, options.__argvOverride);
    return new Promise((resolveResult) => {
      const control = []; const provider = [];
      let controlBytes = 0; let providerBytes = 0; let captureOverflow = false; let timedOut = false; let detail = null;
      let settled = false; let startTimer = null; let timeout = null; let escalation = null; let groupWait = null;
      const timers = () => { for (const t of [startTimer, timeout, escalation, groupWait]) if (t) clearTimeout(t); };
      const child = spawn(gate.helper_path, argv, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, shell: false, windowsVerbatimArguments: false });
      if (typeof options.onSpawn === 'function') options.onSpawn({ pid: child.pid, argv, helperPath: gate.helper_path, env: options.env });
      child.stdin.end();
      let groupGone = process.platform === 'win32' ? null : false;
      let groupSettled = process.platform === 'win32';
      let closeCode; let closeSignal; let closed = false;
      const finish = () => {
        if (settled) return; settled = true; timers();
        const parsed = parseOwnerControlLines(Buffer.concat(control));
        const clean = detail === null && !timedOut;
        const bound = clean ? bindReport(token, parsed, ctx.now) : { termination_report: null, termination_confirmed: false };
        if (clean && (!parsed.ok || parsed.lines[0].mechanism !== token.mechanism)) detail = 'handshake_lost';
        resolveResult({
          code: timedOut ? 124 : (closeCode ?? 127), signal: closeSignal ?? undefined, timedOut,
          stdout: Buffer.concat(provider), stderr: Buffer.alloc(0), captureOverflow,
          provider_channel: 'merged-owner-stderr', control_lines: parsed.lines.length ? parsed.lines : null,
          termination_confirmed: bound.termination_confirmed, termination_report: bound.termination_report,
          helper: { path: gate.helper_path, sha256: artifact.helper_sha256, pid: child.pid }, detail, group_gone: groupGone,
        });
      };
      let laddering = false;
      const ladder = (why) => {
        if (laddering) return; laddering = true; detail ??= why;
        if (process.platform === 'win32') { child.kill(); return; }
        groupSettled = false;
        signalPosixProcessGroup(child, 'SIGTERM');
        escalation = setTimeout(() => {
          signalPosixProcessGroup(child, 'SIGKILL');
          const deadline = Date.now() + POSIX_GROUP_EXIT_HARD_DEADLINE_MS;
          const poll = () => {
            if (isPosixProcessGroupGone(child.pid)) { groupGone = true; groupSettled = true; if (closed) finish(); return; }
            if (Date.now() >= deadline) { groupGone = false; groupSettled = true; if (closed) finish(); return; }
            groupWait = setTimeout(poll, POSIX_GROUP_EXIT_POLL_MS);
          };
          poll();
        }, POSIX_TERMINATION_GRACE_MS);
      };
      child.stdout.on('data', (chunk) => { controlBytes += chunk.length; if (controlBytes > GROK_CONTROL_CAPTURE_MAX_BYTES) { captureOverflow = true; ladder('capture_overflow'); return; } control.push(chunk); });
      child.stderr.on('data', (chunk) => { providerBytes += chunk.length; if (providerBytes > GROK_PROVIDER_CAPTURE_MAX_BYTES) { captureOverflow = true; ladder('capture_overflow'); return; } provider.push(chunk); });
      startTimer = setTimeout(() => {
        const partial = parseOwnerControlLines(Buffer.concat(control));
        const ready = partial.lines[0]?.handshake === 'containment_ready' && partial.lines[0]?.mechanism === token.mechanism;
        if (!ready) ladder('start_deadline');
      }, GROK_OWNER_START_DEADLINE_MS);
      if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) timeout = setTimeout(() => { timedOut = true; ladder(null); }, options.timeoutMs);
      child.once('error', () => { detail = 'spawn_error'; closeCode ??= 127; closed = true; finish(); });
      child.once('close', (code, signal) => {
        closeCode = code; closeSignal = signal; closed = true;
        if (!laddering || process.platform === 'win32') {
          if (!laddering && process.platform !== 'win32') groupGone = isPosixProcessGroupGone(child.pid);
          finish();
        } else if (groupSettled) {
          finish();
        }
      });
    });
  }

  function runSync(command, args = [], options = {}) {
    const { token, gate, artifact } = admit(ctx, options);
    const prep = prepareProvider(command, args, options);
    if (prep.closed) return prep.closed;
    if (!isNativeGrokLauncher(prep.chain)) throw refusalError('unsupported_prepared_chain', prep.chain.prepared_kind, { ownerId: token.owner_id });
    consume(token, ctx);
    if (options.__spawnFailure) {
      throw refusalError('spawn_error', 'test-injected spawn failure', { ownerId: token.owner_id });
    }
    const argv = helperArgv(prep.prepared, options.__argvOverride);
    const run = spawnSync(gate.helper_path, argv, {
      cwd: options.cwd, env: options.env, input: '', timeout: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : undefined,
      killSignal: 'SIGKILL', maxBuffer: GROK_PROVIDER_CAPTURE_MAX_BYTES + GROK_CONTROL_CAPTURE_MAX_BYTES, windowsHide: true, shell: false,
    });
    const timedOut = run.error?.code === 'ETIMEDOUT';
    const captureOverflow = run.error?.code === 'ENOBUFS'
      || run.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    const stdoutBytes = Buffer.from(run.stdout ?? []);
    let detail = run.error && !timedOut && !captureOverflow ? 'spawn_error' : captureOverflow ? 'capture_overflow' : null;
    const parsed = stdoutBytes.length > GROK_CONTROL_CAPTURE_MAX_BYTES ? { ok: false, reason: 'shape', lines: [] } : parseOwnerControlLines(stdoutBytes);
    const clean = detail === null && !timedOut;
    const bound = clean ? bindReport(token, parsed, ctx.now) : { termination_report: null, termination_confirmed: false };
    if (clean && (!parsed.ok || parsed.lines[0].mechanism !== token.mechanism)) detail = 'handshake_lost';
    if (typeof options.onSpawn === 'function') options.onSpawn({ pid: run.pid, argv, helperPath: gate.helper_path, env: options.env });
    return {
      code: timedOut ? 124 : (run.status ?? 127), signal: run.signal ?? undefined, timedOut, stdout: Buffer.from(run.stderr ?? []), stderr: Buffer.alloc(0),
      captureOverflow, provider_channel: 'merged-owner-stderr', control_lines: parsed.lines.length ? parsed.lines : null,
      termination_confirmed: bound.termination_confirmed, termination_report: bound.termination_report,
      helper: { path: gate.helper_path, sha256: artifact.helper_sha256, pid: run.pid }, detail, termination_ladder: 'sync-kill', group_gone: null,
    };
  }
  return { run, runSync };
}

const productionRunner = createContainedRunner({});
export async function runGrokContainedProcess(command, args = [], options = {}) {
  const { __argvOverride, __spawnFailure, onSpawn, ...safe } = options;
  return productionRunner.run(command, args, safe);
}
export function runGrokContainedProcessSync(command, args = [], options = {}) {
  const { __argvOverride, __spawnFailure, onSpawn, ...safe } = options;
  return productionRunner.runSync(command, args, safe);
}

export const __testing = Object.freeze({
  mintOwnerToken,
  tokenSeal,
  liveOwners,
  consumedOwners,
  defaultHelperSpawner,
  createContainedRunner,
  writeOwnerRecordForTest: (body, tmpRoot) => writeOwnerRecord({
    record: body.record, tokenSha256: body.token_sha256, helperSha256: body.helper_sha256, createdAt: body.created_at,
  }, { tmpRoot }),
  consumeOwnerRecordForTest: (ownerId, tmpRoot) => consumeOwnerRecord(ownerId, { tmpRoot }),
});
