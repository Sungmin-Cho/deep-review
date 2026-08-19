import { createHash } from 'node:crypto';

export const GROK_CARRIER_MAX_BYTES = 65536;

const SUPPORTED_GROK_CLI_VERSIONS = new Set(['1.0.4']);
const GROK_REQUIRED_HELP_FLAGS = Object.freeze([
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

const CARRIER_KEYS = Object.freeze([
  'schema_version',
  'launcher_path',
  'real_path',
  'platform_identity',
  'executable_sha256',
  'executable_size',
  'prepared_spawn_chain',
  'version',
  'version_build',
  'version_banner_sha256',
  'help_sha256',
  'help_size',
  'required_help_flags',
  'evidence_sha256',
]);
const CHAIN_KEYS = Object.freeze([
  'schema_version',
  'prepared_kind',
  'launcher',
  'shim',
  'interpreter',
  'shebang',
  'posix_executable_type',
  'native_loader',
  'chain_sha256',
]);
const MEMBER_KEYS = Object.freeze([
  'path',
  'real_path',
  'platform_identity',
  'sha256',
  'size',
  'classification_purpose',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('unsupported canonical JSON value');
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`,
  ).join(',')}}`;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireExactKeys(value, keys, name) {
  requireObject(value, name);
  const actual = Object.keys(value);
  const unknown = actual.filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new TypeError(`${name} has unknown keys: ${unknown.join(', ')}`);
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new TypeError(`${name} is missing keys: ${missing.join(', ')}`);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be non-empty`);
}

function requireDigest(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
}

function requireSize(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
}

// Native Windows seals emit drive paths with backslash separators, which is what
// the producer's `normalize(resolve(...))` actually returns on that platform.
function requireAbsolutePath(value, name) {
  requireString(value, name);
  if (!/^(?:\/|[A-Za-z]:[\\/])/u.test(value)) throw new TypeError(`${name} must be absolute`);
}

function validatePlatformIdentity(identity, name) {
  requireExactKeys(identity, ['kind', 'fields'], name);
  if (identity.kind === 'posix-dev-ino-v1') {
    requireExactKeys(identity.fields, ['dev', 'ino', 'type', 'uid'], `${name}.fields`);
    for (const field of ['dev', 'ino', 'type', 'uid']) requireString(identity.fields[field], `${name}.fields.${field}`);
    if (identity.fields.type !== 'regular-file') throw new TypeError(`${name}.fields.type is invalid`);
    return;
  }
  if (identity.kind === 'win32-file-id-v1') {
    requireExactKeys(identity.fields, ['final_path', 'volume', 'file_id'], `${name}.fields`);
    requireAbsolutePath(identity.fields.final_path, `${name}.fields.final_path`);
    requireString(identity.fields.volume, `${name}.fields.volume`);
    requireString(identity.fields.file_id, `${name}.fields.file_id`);
    return;
  }
  throw new TypeError(`${name}.kind is invalid`);
}

function validateMember(member, name, allowedPurposes) {
  requireExactKeys(member, MEMBER_KEYS, name);
  requireAbsolutePath(member.path, `${name}.path`);
  requireAbsolutePath(member.real_path, `${name}.real_path`);
  validatePlatformIdentity(member.platform_identity, `${name}.platform_identity`);
  requireDigest(member.sha256, `${name}.sha256`);
  requireSize(member.size, `${name}.size`);
  if (!allowedPurposes.includes(member.classification_purpose)) {
    throw new TypeError(`${name}.classification_purpose is invalid`);
  }
}

function validateOptionalMember(member, name, allowedPurposes) {
  if (member !== null) validateMember(member, name, allowedPurposes);
}

function validateShebang(shebang) {
  requireExactKeys(shebang, ['shebang_form', 'interpreter', 'path_target'], 'prepared_spawn_chain.shebang');
  if (shebang.shebang_form !== 'absolute' && shebang.shebang_form !== 'env-path') {
    throw new TypeError('prepared_spawn_chain.shebang.shebang_form is invalid');
  }
  validateMember(
    shebang.interpreter,
    'prepared_spawn_chain.shebang.interpreter',
    ['effective-executable'],
  );
  if (shebang.shebang_form === 'absolute') {
    if (shebang.path_target !== null) throw new TypeError('absolute shebang path_target must be null');
    return;
  }
  validateMember(
    shebang.path_target,
    'prepared_spawn_chain.shebang.path_target',
    ['effective-executable'],
  );
}

function chainMembers(chain) {
  const members = [chain.launcher, chain.shim, chain.interpreter, chain.native_loader];
  if (chain.shebang) members.push(chain.shebang.interpreter, chain.shebang.path_target);
  return members.filter((member) => member !== null && member !== undefined);
}

// Field-by-field shape admits chains the producer cannot emit: a POSIX chain
// whose members carry Windows identities, a Windows chain claiming a POSIX
// executable type, a purpose that belongs to the other platform. One producer
// seals one chain on one platform, so the identity kind decides the rest.
function validateChainIdentityMatrix(chain) {
  const members = chainMembers(chain);
  const identityKinds = new Set(members.map((member) => member.platform_identity.kind));
  if (identityKinds.size !== 1) {
    throw new TypeError('prepared_spawn_chain members mix platform_identity kinds');
  }
  const [identityKind] = identityKinds;
  if (identityKind === 'win32-file-id-v1') {
    for (const member of members) {
      if (member.platform_identity.fields.final_path !== member.real_path) {
        throw new TypeError('prepared_spawn_chain member platform_identity.fields.final_path is not its sealed real_path');
      }
      if (member.classification_purpose !== null) {
        throw new TypeError('a Windows-identity prepared_spawn_chain member classification_purpose must be null');
      }
    }
    if (chain.posix_executable_type !== null || chain.shebang !== null
        || chain.native_loader !== null) {
      throw new TypeError('a Windows-identity prepared_spawn_chain must not carry posix_executable_type, shebang, or native_loader');
    }
    return;
  }
  if (chain.prepared_kind !== 'direct') {
    throw new TypeError('a POSIX-identity prepared_spawn_chain prepared_kind must be direct');
  }
  if (!['shebang', 'native-elf', 'native-macho'].includes(chain.posix_executable_type)) {
    throw new TypeError('a POSIX-identity prepared_spawn_chain must carry a POSIX posix_executable_type');
  }
  if (chain.launcher.classification_purpose !== 'effective-executable') {
    throw new TypeError('a POSIX-identity prepared_spawn_chain launcher classification_purpose must be effective-executable');
  }
}

function validatePreparedSpawnChain(chain) {
  requireExactKeys(chain, CHAIN_KEYS, 'prepared_spawn_chain');
  if (chain.schema_version !== '1.0') throw new TypeError('prepared_spawn_chain.schema_version is invalid');
  if (!['direct', 'powershell-shim', 'comspec-batch'].includes(chain.prepared_kind)) {
    throw new TypeError('prepared_spawn_chain.prepared_kind is invalid');
  }
  validateMember(chain.launcher, 'prepared_spawn_chain.launcher', ['effective-executable', null]);
  validateOptionalMember(chain.shim, 'prepared_spawn_chain.shim', [null]);
  validateOptionalMember(chain.interpreter, 'prepared_spawn_chain.interpreter', [null]);
  validateOptionalMember(chain.native_loader, 'prepared_spawn_chain.native_loader', ['native-loader']);

  if (chain.prepared_kind === 'direct') {
    if (chain.shim !== null || chain.interpreter !== null) {
      throw new TypeError('direct prepared chain must not contain a shim or interpreter');
    }
    if (chain.posix_executable_type === 'shebang') {
      validateShebang(chain.shebang);
    } else {
      if (!['native-elf', 'native-macho', null].includes(chain.posix_executable_type)) {
        throw new TypeError('prepared_spawn_chain.posix_executable_type is invalid');
      }
      if (chain.shebang !== null) throw new TypeError('native prepared chain must not contain shebang metadata');
    }
  } else {
    if (chain.shebang !== null || chain.posix_executable_type !== null || chain.native_loader !== null) {
      throw new TypeError('Windows prepared chain contains POSIX-only members');
    }
    if (chain.prepared_kind === 'powershell-shim') {
      validateMember(chain.shim, 'prepared_spawn_chain.shim', [null]);
    } else if (chain.shim !== null) {
      throw new TypeError('comspec-batch prepared chain must not contain a shim');
    }
    validateMember(chain.interpreter, 'prepared_spawn_chain.interpreter', [null]);
  }

  validateChainIdentityMatrix(chain);

  requireDigest(chain.chain_sha256, 'prepared_spawn_chain.chain_sha256');
  const { chain_sha256: chainSha256, ...body } = chain;
  if (sha256(Buffer.from(canonicalStringify(body), 'utf8')) !== chainSha256) {
    throw new TypeError('prepared_spawn_chain.chain_sha256 does not match sealed members');
  }
}

// The top-level executable fields and the sealed launcher are two views of one
// file. A recomputed seal over disagreeing views is still a contradiction, so
// they are bound before either hash is accepted.
function bindCarrierToSealedLauncher(carrier) {
  const launcher = carrier.prepared_spawn_chain.launcher;
  for (const [carrierField, memberField] of [
    ['launcher_path', 'path'],
    ['real_path', 'real_path'],
    ['executable_sha256', 'sha256'],
    ['executable_size', 'size'],
  ]) {
    if (carrier[carrierField] !== launcher[memberField]) {
      throw new TypeError(`carrier.${carrierField} is not the sealed prepared_spawn_chain.launcher.${memberField}`);
    }
  }
  if (canonicalStringify(carrier.platform_identity)
      !== canonicalStringify(launcher.platform_identity)) {
    throw new TypeError('carrier.platform_identity is not the sealed prepared_spawn_chain.launcher.platform_identity');
  }
}

export function encodeGrokCompatibilityCarrierFrame(carrier) {
  let payload;
  try {
    payload = JSON.stringify(carrier);
  } catch (error) {
    throw new TypeError(`carrier is not JSON serializable: ${error.message}`);
  }
  if (typeof payload !== 'string') throw new TypeError('carrier must encode as JSON');
  const bytes = Buffer.from(payload, 'utf8');
  if (bytes.length > GROK_CARRIER_MAX_BYTES) {
    throw new RangeError(`carrier payload exceeds maximum ${GROK_CARRIER_MAX_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + bytes.length);
  frame.writeUInt32BE(bytes.length, 0);
  bytes.copy(frame, 4);
  return frame;
}

export function parseGrokCompatibilityCarrierFrame(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError('carrier frame must be bytes');
  }
  const frame = Buffer.from(bytes);
  if (frame.length === 0) throw new TypeError('carrier frame is missing');
  if (frame.length < 4) throw new TypeError('carrier frame is truncated');
  const declaredLength = frame.readUInt32BE(0);
  if (declaredLength > GROK_CARRIER_MAX_BYTES) {
    throw new RangeError(`carrier frame exceeds maximum ${GROK_CARRIER_MAX_BYTES} bytes`);
  }
  if (frame.length < 4 + declaredLength) throw new TypeError('carrier frame is truncated');
  if (frame.length !== 4 + declaredLength) throw new TypeError('carrier frame has trailing bytes');

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4));
  } catch {
    throw new TypeError('carrier frame payload is not valid UTF-8 JSON');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError('carrier frame payload is not valid UTF-8 JSON');
  }
}

export function validateGrokCompatibilityCarrier(carrier) {
  requireExactKeys(carrier, CARRIER_KEYS, 'grok compatibility carrier');
  if (carrier.schema_version !== '1.0') throw new TypeError('carrier.schema_version is invalid');
  requireAbsolutePath(carrier.launcher_path, 'carrier.launcher_path');
  requireAbsolutePath(carrier.real_path, 'carrier.real_path');
  validatePlatformIdentity(carrier.platform_identity, 'carrier.platform_identity');
  requireDigest(carrier.executable_sha256, 'carrier.executable_sha256');
  requireSize(carrier.executable_size, 'carrier.executable_size');
  validatePreparedSpawnChain(carrier.prepared_spawn_chain);
  if (carrier.version !== '1.0.4') throw new TypeError('carrier.version is unsupported or malformed');
  if (!/^[a-f0-9]+$/u.test(carrier.version_build)) throw new TypeError('carrier.version_build is malformed');
  requireDigest(carrier.version_banner_sha256, 'carrier.version_banner_sha256');
  requireDigest(carrier.help_sha256, 'carrier.help_sha256');
  requireSize(carrier.help_size, 'carrier.help_size');
  if (!Array.isArray(carrier.required_help_flags)
      || carrier.required_help_flags.length !== GROK_REQUIRED_HELP_FLAGS.length
      || carrier.required_help_flags.some((flag, index) => flag !== GROK_REQUIRED_HELP_FLAGS[index])) {
    throw new TypeError('carrier.required_help_flags is incomplete or malformed');
  }
  bindCarrierToSealedLauncher(carrier);
  requireDigest(carrier.evidence_sha256, 'carrier.evidence_sha256');
  const { evidence_sha256: evidenceSha256, ...body } = carrier;
  if (sha256(Buffer.from(canonicalStringify(body), 'utf8')) !== evidenceSha256) {
    throw new TypeError('carrier.evidence_sha256 does not match sealed evidence');
  }
  return carrier;
}

export function parseGrokCompatibilityStdout(text, kind) {
  if (typeof text !== 'string') throw new TypeError('Grok CLI stdout must be text');
  if (kind === 'version') {
    const match = /^grok (\d+\.\d+\.\d+) \(([a-f0-9]+)\) \[stable\]\s*$/u.exec(text);
    if (!match) throw new TypeError('Grok CLI version stdout is malformed');
    const [, version, versionBuild] = match;
    if (!SUPPORTED_GROK_CLI_VERSIONS.has(version)) {
      throw new TypeError(`unsupported Grok CLI version: ${version}`);
    }
    return { version, version_build: versionBuild };
  }
  if (kind === 'help') {
    for (const flag of GROK_REQUIRED_HELP_FLAGS) {
      const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (!new RegExp(`(?:^|[\\s,[\\(])${escaped}(?=$|[\\s,=\\]>)])`, 'mu').test(text)) {
        throw new TypeError(`Grok CLI help stdout is missing required flag ${flag}`);
      }
    }
    return { required_help_flags: [...GROK_REQUIRED_HELP_FLAGS] };
  }
  throw new TypeError('Grok CLI stdout kind is invalid');
}
