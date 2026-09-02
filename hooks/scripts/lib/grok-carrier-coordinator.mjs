// D22 — the production carrier coordinator.
//
// A file descriptor is process-local, so a one-fd handoff cannot carry authority
// across process A (the standalone `detect-environment.mjs` producer) and process
// B (every downstream consumer). This module owns the private channel between
// them: it creates and owns the bounded `--grok-carrier-fd` channel, drains
// exactly one framed carrier from A, and then re-supplies a FRESH readable
// endpoint plus the complete detected environment to each consumer that asks.
//
// Consumers re-detect nothing. Classification, dry-run/explain, route
// persistence, `parseExecutionRoute` and the Grok bridge all reuse the canonical
// bytes served here, byte-for-byte, and never call `detectEnvironment` or spawn
// a `--version` / `--help` child of their own.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  GROK_CONTAINMENT_HELPER_FAILED,
  MISSING_GROK_CONTAINMENT_HELPER,
  UNSUPPORTED_GROK_CONTAINMENT,
  resolveGrokContainmentPlatform,
} from './grok-process-supervisor.mjs';
import { DEFAULT_PLUGIN_ROOT, evaluateHelperArtifact, isNativeGrokLauncher } from './grok-native-artifact.mjs';
import { fileURLToPath } from 'node:url';
import {
  GROK_CARRIER_MAX_BYTES,
  canonicalStringify,
  parseGrokCompatibilityCarrierFrame,
  validateGrokCompatibilityCarrier,
} from './grok-compatibility-carrier.mjs';

export const COORDINATOR_PROTOCOL_VERSION = '1.0';
export const COORDINATOR_MODES = Object.freeze(['review', 'dry-run']);
export const COORDINATOR_DRAIN_TIMEOUT_MS = 20000;
export const COORDINATOR_ACQUIRE_TIMEOUT_MS = 10000;

export const COORDINATOR_CONTROL_MESSAGES = Object.freeze([
  'coordinator_ready',
  'acquire_endpoint',
  'environment_endpoint',
  'shutdown',
  'coordinator_terminated',
]);

// The payload is the COMPLETE detected environment, not only the compatibility
// evidence. One canonical frame carries every field below.
export const COORDINATOR_ENVIRONMENT_FIELDS = Object.freeze([
  'runtime_host',
  'plugin_root',
  'node_available',
  'node_path',
  'claude_cli',
  'claude_cli_path',
  'codex_plugin',
  'codex_companion_path',
  'codex_cli',
  'codex_cli_path',
  'codex_installed',
  'agy_cli',
  'agy_cli_path',
  'agy_version',
  'is_git',
  'has_commits',
  'change_state',
  'staged',
  'unstaged',
  'untracked',
  'has_untracked',
  'review_base',
  'review_base_method',
  'is_shallow',
]);

export const COORDINATOR_GROK_FIELDS = Object.freeze([
  'grok_cli',
  'grok_cli_path',
  'grok_version',
  'grok_compatibility_verified',
  'grok_compatibility_evidence',
]);

// The detector adds this diagnostic only on the incompatible polarity, so it is
// admitted but never required.
const COORDINATOR_OPTIONAL_FIELDS = Object.freeze(['grok_unavailable_reason']);

// fd 0/1/2 by POSIX path. A private descriptor that resolves to one of these
// is a stdio substitution, not a private channel. Matched case-insensitively:
// macOS APFS is case-insensitive by default, so on this project's own primary
// development platform "/DEV/STDOUT" opens stdout even though a case-sensitive
// filesystem would treat it as an unrelated path. No legitimate coordinator
// endpoint is ever spelled like one of these, so folding case costs nothing.
const STDIO_SUBSTITUTE_PATHS = new Set([
  '/dev/stdin', '/dev/stdout', '/dev/stderr',
  '/dev/fd/0', '/dev/fd/1', '/dev/fd/2',
  '/proc/self/fd/0', '/proc/self/fd/1', '/proc/self/fd/2',
]);

// Windows reserved device names that resolve to the console or the null
// device regardless of an optional trailing ':' device suffix or a
// `\\.\`/`\\?\` device-namespace prefix (normalized to `//./` / `//?/`).
const WINDOWS_DEVICE_NAMES = new Set(['CON', 'CONIN$', 'CONOUT$', 'NUL']);
const WINDOWS_DEVICE_NAMESPACE_PREFIX = /^\/\/[.?]\//u;

// A rule, not a literal list: any spelling that *names* a console, null, or
// standard-stream device is a substitute, however it is cased, prefixed, or
// suffixed — not just the exact strings the coordinator happens to emit.
function isStdioSubstitutePath(rawPath) {
  const normalized = rawPath.replace(/\\/gu, '/');
  if (STDIO_SUBSTITUTE_PATHS.has(normalized.toLowerCase())) return true;

  let windowsCandidate = normalized;
  const prefixMatch = WINDOWS_DEVICE_NAMESPACE_PREFIX.exec(windowsCandidate);
  if (prefixMatch) windowsCandidate = windowsCandidate.slice(prefixMatch[0].length);
  windowsCandidate = windowsCandidate.replace(/:$/u, '');
  return WINDOWS_DEVICE_NAMES.has(windowsCandidate.toUpperCase());
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function defaultDetectorPath() {
  return fileURLToPath(new URL('../detect-environment.mjs', import.meta.url));
}

// A named pipe on native Windows, a private-directory socket everywhere else.
// Neither spelling can ever be fd 1.
function privatePath(root, name) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${basename(root)}-${name}`;
  return join(root, name);
}

export function assertPrivateEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
    throw new TypeError('carrier endpoint descriptor must be an object');
  }
  if (Object.hasOwn(endpoint, 'fd')) {
    throw new TypeError('carrier endpoint descriptor must not be an inherited stdio descriptor (fd 0/1/2)');
  }
  if (endpoint.kind !== 'private-stream') {
    throw new TypeError('carrier endpoint descriptor kind must be private-stream');
  }
  requireNonEmptyString(endpoint.path, 'carrier endpoint descriptor path');
  if (isStdioSubstitutePath(endpoint.path)) {
    throw new TypeError('carrier endpoint descriptor must not be a stdio substitute');
  }
  if (!Number.isSafeInteger(endpoint.generation) || endpoint.generation < 1) {
    throw new TypeError('carrier endpoint descriptor generation must be a positive integer');
  }
  return endpoint;
}

export function validateCoordinatorEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('coordinator environment must be an object');
  }
  for (const field of [...COORDINATOR_ENVIRONMENT_FIELDS, ...COORDINATOR_GROK_FIELDS]) {
    if (!Object.hasOwn(environment, field)) {
      throw new TypeError(`coordinator environment is missing ${field}`);
    }
  }
  const known = new Set([
    ...COORDINATOR_ENVIRONMENT_FIELDS,
    ...COORDINATOR_GROK_FIELDS,
    ...COORDINATOR_OPTIONAL_FIELDS,
  ]);
  const unknown = Object.keys(environment).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`coordinator environment has unknown fields: ${unknown.join(', ')}`);
  }
  return environment;
}

export function canonicalEnvironmentBytes(environment) {
  return Buffer.from(canonicalStringify(validateCoordinatorEnvironment(environment)), 'utf8');
}

export function encodeControlFrame(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('control message must be an object');
  }
  if (!COORDINATOR_CONTROL_MESSAGES.includes(message.message)) {
    throw new TypeError(`unknown control message: ${message.message}`);
  }
  const bytes = Buffer.from(JSON.stringify(message), 'utf8');
  if (bytes.length > GROK_CARRIER_MAX_BYTES) {
    throw new RangeError(`control frame exceeds maximum ${GROK_CARRIER_MAX_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + bytes.length);
  frame.writeUInt32BE(bytes.length, 0);
  bytes.copy(frame, 4);
  return frame;
}

export function decodeControlFrames(bytes) {
  let rest = Buffer.from(bytes);
  const messages = [];
  while (rest.length >= 4) {
    const declared = rest.readUInt32BE(0);
    if (declared > GROK_CARRIER_MAX_BYTES) {
      throw new RangeError(`control frame exceeds maximum ${GROK_CARRIER_MAX_BYTES} bytes`);
    }
    if (rest.length < 4 + declared) break;
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rest.subarray(4, 4 + declared)));
    } catch {
      throw new TypeError('control frame payload is not valid UTF-8 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !COORDINATOR_CONTROL_MESSAGES.includes(parsed.message)) {
      throw new TypeError('control frame carries no known control message');
    }
    messages.push(parsed);
    rest = rest.subarray(4 + declared);
  }
  return { messages, rest: Buffer.from(rest) };
}

// EOF, size, and exactly-one-frame in one place. Trailing bytes and a second
// frame are the same observation and are both refused.
export function decodeExactlyOneFrame(bytes) {
  const frame = Buffer.from(bytes);
  if (frame.length === 0) throw new TypeError('carrier frame is missing');
  if (frame.length < 4) throw new TypeError('carrier frame is truncated');
  const declared = frame.readUInt32BE(0);
  if (declared > GROK_CARRIER_MAX_BYTES) {
    throw new RangeError(`carrier frame exceeds maximum ${GROK_CARRIER_MAX_BYTES} bytes`);
  }
  if (frame.length < 4 + declared) throw new TypeError('carrier frame is truncated');
  if (frame.length !== 4 + declared) throw new TypeError('carrier frame has trailing bytes');
  return frame.subarray(4);
}

function readToEof(stream, { deadlineMs, deadlineMessage }) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(new Error(deadlineMessage));
    }, deadlineMs);
    if (typeof timer.unref === 'function') timer.unref();
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      reject(error);
    };
    stream.on('data', (chunk) => {
      total += chunk.length;
      // Bounded before it is buffered: an over-limit producer never gets to
      // allocate more than the contract allows.
      if (total > 4 + GROK_CARRIER_MAX_BYTES) {
        fail(new RangeError(`carrier frame exceeds maximum ${GROK_CARRIER_MAX_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.once('error', fail);
    stream.once('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(Buffer.concat(chunks, total));
    });
  });
}

function drainProducer({ nodePath, detectorPath, cwd, env, drainTimeoutMs }) {
  const child = spawn(
    nodePath,
    [detectorPath, '--cwd', cwd, '--format', 'json', '--grok-candidate', '--grok-carrier-fd', '3'],
    { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] },
  );
  const stdoutChunks = [];
  let stderrText = '';
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk) => { stderrText += chunk.toString('utf8'); });
  const exited = new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => resolvePromise(signal ? 1 : (code ?? 1)));
  });
  const drained = readToEof(child.stdio[3], {
    deadlineMs: drainTimeoutMs,
    deadlineMessage: 'carrier drain deadline exceeded before the private channel reached EOF',
  });
  return {
    child,
    exited,
    drained,
    stdout: () => Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: () => stderrText,
  };
}

export function defaultCoordinatorHelperExists(helperPath) {
  try {
    const stat = lstatSync(helperPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    accessSync(helperPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function containmentRefusalError({
  reason, platform, arch, mechanism, helperPath, mode, remedy, observed, supported, detail = null, helperStderr,
  launcherKind,
}) {
  const refusal = {
    ok: false,
    reason,
    platform,
    arch,
    mechanism,
    helper_path: helperPath,
    mode,
    remedy,
    detail,
    ...(helperStderr ? { helper_stderr: helperStderr } : {}),
    ...(observed ? { grok_version: observed } : {}),
    ...(supported ? { grok_supported_versions: supported } : {}),
    ...(launcherKind ? { launcher_kind: launcherKind } : {}),
  };
  const error = new Error(reason);
  error.containment_refusal = refusal;
  return error;
}

export function evaluateCoordinatorContainment(options = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    helperExists = null,
    helperArtifact = null,
    mode = 'review',
    pluginRoot = DEFAULT_PLUGIN_ROOT,
    enabledPlatforms,
  } = options;
  const productionMode = !Object.hasOwn(options, 'nativeDirectory');
  const nativeDirectory = productionMode ? join(pluginRoot, 'hooks', 'scripts', 'lib', 'native') : options.nativeDirectory;
  const gate = resolveGrokContainmentPlatform({ platform, arch, nativeDirectory, enabledPlatforms });
  if (!gate.supported) {
    throw containmentRefusalError({
      reason: UNSUPPORTED_GROK_CONTAINMENT,
      platform: gate.platform,
      arch: gate.arch,
      mechanism: null,
      helperPath: null,
      mode,
      remedy: 'Grok containment is not inventoried on this platform; --grok stays inactive.',
      detail: gate.detail,
    });
  }
  const artifact = helperArtifact
    ? helperArtifact(gate, { nativeDirectory, pluginRoot, productionMode })
    : evaluateHelperArtifact(gate, { nativeDirectory, pluginRoot, productionMode });
  if (!artifact.present || !artifact.executable || (helperExists && !helperExists(gate.helper_path))) {
    throw containmentRefusalError({
      reason: MISSING_GROK_CONTAINMENT_HELPER,
      platform: gate.platform,
      arch: gate.arch,
      mechanism: gate.mechanism,
      helperPath: gate.helper_path,
      mode,
      remedy: 'The inventoried containment helper is missing or not a regular executable file.',
    });
  }
  if (artifact.integrity !== 'ok') {
    throw containmentRefusalError({
      reason: GROK_CONTAINMENT_HELPER_FAILED,
      platform: gate.platform,
      arch: gate.arch,
      mechanism: gate.mechanism,
      helperPath: gate.helper_path,
      mode,
      remedy: 'The containment helper is present but failed integrity verification.',
      detail: `integrity_${artifact.integrity}`,
    });
  }
  return gate;
}

function isVersionString(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/u.test(value);
}

function closedSchemaContainmentRefusal(stdout, mode) {
  let environment;
  try {
    environment = JSON.parse(String(stdout ?? '').trim().split('\n')[0] ?? '');
  } catch {
    return null;
  }
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return null;
  if (environment.grok_cli !== false) return null;
  if (environment.grok_compatibility_verified !== false) return null;
  if (environment.grok_compatibility_evidence !== null) return null;
  const reason = environment.grok_unavailable_reason;
  if (reason !== 'incompatible_grok_cli' && reason !== 'unsupported_grok_cli_version') {
    return null;
  }
  if (reason === 'unsupported_grok_cli_version') {
    if (!isVersionString(environment.grok_version)) return null;
    if (!Array.isArray(environment.grok_supported_versions)
        || environment.grok_supported_versions.length === 0
        || environment.grok_supported_versions.some((value) => !isVersionString(value))) {
      return null;
    }
  }
  return {
    reason,
    platform: process.platform,
    arch: process.arch,
    mechanism: null,
    helperPath: null,
    mode,
    remedy: reason === 'unsupported_grok_cli_version'
      ? `Unsupported Grok CLI version ${environment.grok_version}.`
      : 'Grok CLI is present but incompatible.',
    observed: environment.grok_version || null,
    supported: environment.grok_supported_versions || null,
  };
}

export async function createGrokCarrierCoordinator(options = {}) {
  const {
    cwd = process.cwd(),
    mode = 'review',
    env = process.env,
    detectorPath = defaultDetectorPath(),
    nodePath = process.execPath,
    drainTimeoutMs = COORDINATOR_DRAIN_TIMEOUT_MS,
    platform = process.platform,
    arch = process.arch,
    helperExists = null,
    helperArtifact = null,
    pluginRoot = DEFAULT_PLUGIN_ROOT,
    enabledPlatforms,
  } = options;
  if (!COORDINATOR_MODES.includes(mode)) {
    throw new TypeError(`coordinator mode must be one of ${COORDINATOR_MODES.join(', ')}`);
  }
  evaluateCoordinatorContainment({
    platform,
    arch,
    helperExists,
    helperArtifact,
    pluginRoot,
    enabledPlatforms,
    mode,
    ...(Object.hasOwn(options, 'nativeDirectory') ? { nativeDirectory: options.nativeDirectory } : {}),
  });
  const workingDirectory = resolve(cwd);
  const producer = drainProducer({
    nodePath, detectorPath, cwd: workingDirectory, env, drainTimeoutMs,
  });

  // Every frame polarity is settled here, BEFORE any coordinator identity,
  // private path, or downstream work exists.
  let carrierBytes;
  let drainError = null;
  try {
    carrierBytes = await producer.drained;
  } catch (error) {
    drainError = error;
  }
  let exitCode;
  try {
    exitCode = await Promise.race([
      producer.exited,
      new Promise((_resolvePromise, reject) => {
        const timer = setTimeout(
          () => reject(new Error('carrier producer exit deadline exceeded')),
          drainTimeoutMs,
        );
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } catch (error) {
    producer.child.kill('SIGKILL');
    throw drainError ?? error;
  }
  if (drainError) {
    if (exitCode === 0 && /carrier frame is missing/u.test(drainError.message)) {
      const refusal = closedSchemaContainmentRefusal(producer.stdout(), mode);
      if (refusal) throw containmentRefusalError(refusal);
    }
    producer.child.kill('SIGKILL');
    throw drainError;
  }
  if (exitCode !== 0) {
    throw new Error(`carrier producer exited with code ${exitCode}: ${producer.stderr().trim()}`);
  }
  let parsedFrame;
  try {
    parsedFrame = parseGrokCompatibilityCarrierFrame(carrierBytes);
  } catch (error) {
    if (/carrier frame is missing/u.test(error.message)) {
      const refusal = closedSchemaContainmentRefusal(producer.stdout(), mode);
      if (refusal) throw containmentRefusalError(refusal);
      throw new Error('carrier frame is missing');
    }
    throw error;
  }
  const carrier = validateGrokCompatibilityCarrier(parsedFrame);

  const chain = carrier.prepared_spawn_chain;
  if (!isNativeGrokLauncher(chain)) {
    producer.child.kill('SIGKILL');
    throw containmentRefusalError({
      reason: 'incompatible_grok_cli', platform, arch, mechanism: null, helperPath: null, mode,
      remedy: 'the Grok launcher must be a native executable, not a .cmd/.bat, PowerShell shim or #! script',
      launcherKind: chain.prepared_kind === 'direct' ? `direct:${chain.posix_executable_type}` : chain.prepared_kind,
    });
  }

  let environment;
  try {
    environment = JSON.parse(producer.stdout());
  } catch (error) {
    throw new Error(`carrier producer stdout is not environment JSON: ${error.message}`);
  }
  validateCoordinatorEnvironment(environment);
  if (environment.grok_compatibility_verified !== true) {
    throw new Error('carrier frame arrived without a compatibility-verified Grok environment');
  }
  if (canonicalStringify(carrier) !== canonicalStringify(environment.grok_compatibility_evidence)) {
    throw new Error('carrier identity does not match the compatibility evidence in the detected environment');
  }

  const coordinatorId = randomUUID();
  const generation = 1;
  const canonicalBytes = canonicalEnvironmentBytes(environment);
  const environmentSha256 = sha256Hex(canonicalBytes);
  const root = mkdtempSync(join(tmpdir(), 'dr-carrier-'));
  const controlPath = privatePath(root, 'c.sock');

  let consumersServed = 0;
  let endpointSerial = 0;
  let closed = false;
  const sockets = new Set();
  const endpointServers = new Set();
  let settleTerminated;
  const terminated = new Promise((resolvePromise) => { settleTerminated = resolvePromise; });

  const server = net.createServer();

  async function close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const endpointServer of endpointServers) endpointServer.close();
    endpointServers.clear();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  async function serveEndpoint(socket, message) {
    if (typeof message.consumer_id !== 'string' || message.consumer_id.length === 0) {
      socket.destroy();
      return;
    }
    endpointSerial += 1;
    // A FRESH readable endpoint per acquisition. It is never fd 1, never stdio,
    // and it is never the endpoint a previous consumer was handed.
    const endpoint = assertPrivateEndpoint({
      kind: 'private-stream',
      path: privatePath(root, `e${endpointSerial}.sock`),
      generation,
    });
    const endpointServer = net.createServer((consumer) => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(canonicalBytes.length, 0);
      consumer.end(Buffer.concat([head, canonicalBytes]));
      endpointServers.delete(endpointServer);
      endpointServer.close();
    });
    endpointServers.add(endpointServer);
    await new Promise((resolvePromise, reject) => {
      endpointServer.once('error', reject);
      endpointServer.listen(endpoint.path, () => resolvePromise());
    });
    consumersServed += 1;
    socket.write(encodeControlFrame({
      message: 'environment_endpoint',
      coordinator_id: coordinatorId,
      environment_sha256: environmentSha256,
      endpoint,
    }));
  }

  function serveShutdown(socket, message) {
    if (message.coordinator_id !== coordinatorId) {
      socket.destroy();
      return;
    }
    socket.write(encodeControlFrame({
      message: 'coordinator_terminated',
      coordinator_id: coordinatorId,
      consumers_served: consumersServed,
    }), () => {
      socket.end();
      void close().then(() => settleTerminated({
        coordinator_id: coordinatorId,
        consumers_served: consumersServed,
      }));
    });
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let rest = Buffer.alloc(0);
    // A missing ready handshake is unconfirmed, so it is sent first and never
    // conditionally: consumers fail closed without it.
    socket.write(encodeControlFrame({
      message: 'coordinator_ready', coordinator_id: coordinatorId, generation, pid: process.pid,
    }));
    socket.on('data', (chunk) => {
      let decoded;
      try {
        decoded = decodeControlFrames(Buffer.concat([rest, chunk]));
      } catch {
        socket.destroy();
        return;
      }
      rest = decoded.rest;
      for (const message of decoded.messages) {
        if (message.message === 'acquire_endpoint') {
          void serveEndpoint(socket, message).catch(() => socket.destroy());
        } else if (message.message === 'shutdown') {
          serveShutdown(socket, message);
        }
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(controlPath, () => resolvePromise());
  });

  return {
    coordinator_id: coordinatorId,
    generation,
    pid: process.pid,
    mode,
    control_path: controlPath,
    environment,
    environment_sha256: environmentSha256,
    canonical_bytes: canonicalBytes,
    consumersServed: () => consumersServed,
    terminated,
    close,
  };
}

function readPrivateEndpoint(endpoint, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(endpoint.path);
    socket.once('error', reject);
    socket.once('connect', () => {
      readToEof(socket, {
        deadlineMs: timeoutMs,
        deadlineMessage: 'private endpoint read deadline exceeded before EOF',
      }).then(resolvePromise, reject);
    });
  });
}

export async function acquireEnvironmentEndpoint({
  controlPath,
  consumerId,
  timeoutMs = COORDINATOR_ACQUIRE_TIMEOUT_MS,
} = {}) {
  requireNonEmptyString(controlPath, 'controlPath');
  requireNonEmptyString(consumerId, 'consumerId');

  const socket = net.connect(controlPath);
  let ready = null;
  let settled = false;
  let settleResolve;
  let settleReject;
  const reply = new Promise((resolvePromise, rejectPromise) => {
    settleResolve = (value) => { if (!settled) { settled = true; resolvePromise(value); } };
    settleReject = (error) => { if (!settled) { settled = true; rejectPromise(error); } };
  });
  const timer = setTimeout(() => settleReject(new Error(ready
    ? 'coordinator environment_endpoint deadline exceeded'
    : 'coordinator_ready handshake was never received; the coordinator is unconfirmed')), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  socket.once('error', settleReject);
  socket.once('close', () => settleReject(new Error(ready
    ? 'coordinator control path closed before an environment_endpoint reply'
    : 'coordinator_ready handshake was never received; the control path closed first')));
  let rest = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    let decoded;
    try {
      decoded = decodeControlFrames(Buffer.concat([rest, chunk]));
    } catch (error) {
      settleReject(error);
      return;
    }
    rest = decoded.rest;
    for (const message of decoded.messages) {
      if (message.message === 'coordinator_ready') {
        if (ready) {
          settleReject(new Error('coordinator sent a second coordinator_ready'));
          return;
        }
        ready = message;
        socket.write(encodeControlFrame({ message: 'acquire_endpoint', consumer_id: consumerId }));
        continue;
      }
      if (message.message === 'environment_endpoint') {
        if (!ready) {
          settleReject(new Error('coordinator_ready handshake was never received; the coordinator is unconfirmed'));
          return;
        }
        if (message.coordinator_id !== ready.coordinator_id) {
          settleReject(new Error('environment_endpoint coordinator_id is not the confirmed coordinator'));
          return;
        }
        settleResolve(message);
        return;
      }
      settleReject(new Error(`unexpected control message ${message.message}`));
      return;
    }
  });

  let endpointMessage;
  try {
    endpointMessage = await reply;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }

  const endpoint = assertPrivateEndpoint(endpointMessage.endpoint);
  if (!/^[a-f0-9]{64}$/u.test(endpointMessage.environment_sha256 || '')) {
    throw new TypeError('environment_endpoint environment_sha256 is malformed');
  }
  const canonicalBytes = decodeExactlyOneFrame(await readPrivateEndpoint(endpoint, timeoutMs));
  const actual = sha256Hex(canonicalBytes);
  if (actual !== endpointMessage.environment_sha256) {
    throw new Error('carrier environment_sha256 does not match the canonical bytes served on the private endpoint');
  }
  const canonicalText = canonicalBytes.toString('utf8');
  let environment;
  try {
    environment = JSON.parse(canonicalText);
  } catch (error) {
    throw new TypeError(`carrier environment payload is not valid UTF-8 JSON: ${error.message}`);
  }
  validateCoordinatorEnvironment(environment);
  // Consumers reuse the canonical buffer; they never reserialize it. A payload
  // that is not already canonical would silently break that identity.
  if (canonicalStringify(environment) !== canonicalText) {
    throw new Error('carrier environment payload is not the canonical serialization');
  }
  return {
    coordinator_id: ready.coordinator_id,
    generation: ready.generation,
    environment_sha256: actual,
    environment,
    canonical_bytes: canonicalBytes,
    endpoint,
  };
}

export async function requestCoordinatorShutdown({
  controlPath,
  coordinatorId,
  timeoutMs = COORDINATOR_ACQUIRE_TIMEOUT_MS,
} = {}) {
  requireNonEmptyString(controlPath, 'controlPath');
  requireNonEmptyString(coordinatorId, 'coordinatorId');

  const socket = net.connect(controlPath);
  let settled = false;
  let settleResolve;
  let settleReject;
  const reply = new Promise((resolvePromise, rejectPromise) => {
    settleResolve = (value) => { if (!settled) { settled = true; resolvePromise(value); } };
    settleReject = (error) => { if (!settled) { settled = true; rejectPromise(error); } };
  });
  const timer = setTimeout(
    () => settleReject(new Error('coordinator shutdown deadline exceeded')),
    timeoutMs,
  );
  if (typeof timer.unref === 'function') timer.unref();
  socket.once('error', settleReject);
  socket.once('close', () => settleReject(new Error('coordinator control path closed before coordinator_terminated')));

  let ready = null;
  let rest = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    let decoded;
    try {
      decoded = decodeControlFrames(Buffer.concat([rest, chunk]));
    } catch (error) {
      settleReject(error);
      return;
    }
    rest = decoded.rest;
    for (const message of decoded.messages) {
      if (message.message === 'coordinator_ready') {
        if (message.coordinator_id !== coordinatorId) {
          settleReject(new Error('coordinator_ready coordinator_id is not the coordinator being shut down'));
          return;
        }
        ready = message;
        socket.write(encodeControlFrame({ message: 'shutdown', coordinator_id: coordinatorId }));
        continue;
      }
      if (message.message === 'coordinator_terminated') {
        if (!ready) {
          settleReject(new Error('coordinator_ready handshake was never received; the coordinator is unconfirmed'));
          return;
        }
        settleResolve(message);
        return;
      }
    }
  });

  try {
    const terminated = await reply;
    return {
      coordinator_id: terminated.coordinator_id,
      consumers_served: terminated.consumers_served,
    };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

// Route persistence stores the carrier identity WITH the canonical bytes, so a
// persisted route can be re-bound to the coordinator that produced it.
export function carrierIdentity(acquisition) {
  return {
    coordinator_id: acquisition.coordinator_id,
    generation: acquisition.generation,
    environment_sha256: acquisition.environment_sha256,
  };
}

export function bindRouteCarrierIdentity(route, acquisition) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw new TypeError('route must be an object');
  }
  const canonicalText = acquisition.canonical_bytes.toString('utf8');
  if (sha256Hex(canonicalText) !== acquisition.environment_sha256) {
    throw new Error('carrier identity does not bind the canonical bytes it is persisted with');
  }
  route.carrier_identity = carrierIdentity(acquisition);
  route.environment_canonical = canonicalText;
  return route;
}
