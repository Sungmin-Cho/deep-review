'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const carrierModuleUrl = pathToFileURL(join(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'lib',
  'grok-compatibility-carrier.mjs',
)).href;

const runtimePromise = import(carrierModuleUrl);

const REQUIRED_FLAGS = Object.freeze([
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`,
  ).join(',')}}`;
}

function identity() {
  return {
    kind: 'posix-dev-ino-v1',
    fields: {
      dev: '1',
      ino: '2',
      type: 'regular-file',
      uid: '0',
    },
  };
}

function member(path, purpose) {
  return {
    path,
    real_path: path,
    platform_identity: identity(),
    sha256: 'a'.repeat(64),
    size: 12,
    classification_purpose: purpose,
  };
}

function validCarrier() {
  const chain = {
    schema_version: '1.0',
    prepared_kind: 'direct',
    launcher: member('/opt/grok', 'effective-executable'),
    shim: null,
    interpreter: null,
    shebang: null,
    posix_executable_type: 'native-elf',
    native_loader: member('/lib64/ld-linux-x86-64.so.2', 'native-loader'),
  };
  const prepared_spawn_chain = {
    ...chain,
    chain_sha256: sha256(Buffer.from(canonicalStringify(chain), 'utf8')),
  };
  const evidence = {
    schema_version: '1.0',
    launcher_path: '/opt/grok',
    real_path: '/opt/grok',
    platform_identity: identity(),
    executable_sha256: 'a'.repeat(64),
    executable_size: 12,
    prepared_spawn_chain,
    version: '1.0.4',
    version_build: 'd846eb93d94d',
    version_banner_sha256: 'b'.repeat(64),
    help_sha256: 'c'.repeat(64),
    help_size: 1024,
    required_help_flags: [...REQUIRED_FLAGS],
  };
  return {
    ...evidence,
    evidence_sha256: sha256(Buffer.from(canonicalStringify(evidence), 'utf8')),
  };
}

function windowsIdentity(finalPath) {
  return {
    kind: 'win32-file-id-v1',
    fields: {
      final_path: finalPath,
      volume: '3',
      file_id: '4',
    },
  };
}

function windowsMember(path) {
  return {
    path,
    real_path: path,
    platform_identity: windowsIdentity(path),
    sha256: 'a'.repeat(64),
    size: 12,
    classification_purpose: null,
  };
}

function validWindowsCarrier() {
  const chain = {
    schema_version: '1.0',
    prepared_kind: 'powershell-shim',
    launcher: windowsMember('C:\\tools\\grok.cmd'),
    shim: windowsMember('C:\\tools\\grok.ps1'),
    interpreter: windowsMember('C:\\Windows\\System32\\pwsh.exe'),
    shebang: null,
    posix_executable_type: null,
    native_loader: null,
  };
  return seal({
    schema_version: '1.0',
    launcher_path: 'C:\\tools\\grok.cmd',
    real_path: 'C:\\tools\\grok.cmd',
    platform_identity: windowsIdentity('C:\\tools\\grok.cmd'),
    executable_sha256: 'a'.repeat(64),
    executable_size: 12,
    prepared_spawn_chain: chain,
    version: '1.0.4',
    version_build: 'd846eb93d94d',
    version_banner_sha256: 'b'.repeat(64),
    help_sha256: 'c'.repeat(64),
    help_size: 1024,
    required_help_flags: [...REQUIRED_FLAGS],
  });
}

// Recomputes both seals so every polarity below is a *sealed* contradiction:
// the hashes agree with the bytes and only the cross-field semantics conflict.
function seal(carrier) {
  const { chain_sha256: _chainSeal, ...chainBody } = carrier.prepared_spawn_chain;
  const body = {
    ...carrier,
    prepared_spawn_chain: {
      ...chainBody,
      chain_sha256: sha256(Buffer.from(canonicalStringify(chainBody), 'utf8')),
    },
  };
  delete body.evidence_sha256;
  return {
    ...body,
    evidence_sha256: sha256(Buffer.from(canonicalStringify(body), 'utf8')),
  };
}

function frame(payload) {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

test('frame transport round-trips exactly one bounded UTF-8 JSON payload without schema admission', async () => {
  const {
    GROK_CARRIER_MAX_BYTES,
    encodeGrokCompatibilityCarrierFrame,
    parseGrokCompatibilityCarrierFrame,
  } = await runtimePromise;
  const payload = { deliberately_unvalidated: true };
  const encoded = encodeGrokCompatibilityCarrierFrame(payload);

  assert.equal(encoded.readUInt32BE(0), Buffer.byteLength(JSON.stringify(payload)));
  assert.deepEqual(parseGrokCompatibilityCarrierFrame(encoded), payload);
  assert.throws(
    () => encodeGrokCompatibilityCarrierFrame({ data: 'x'.repeat(GROK_CARRIER_MAX_BYTES) }),
    /maximum/u,
  );
});

test('frame transport rejects missing, truncated, over-limit, trailing, and invalid UTF-8 JSON payloads', async () => {
  const { GROK_CARRIER_MAX_BYTES, parseGrokCompatibilityCarrierFrame } = await runtimePromise;
  const overLimit = Buffer.alloc(4);
  overLimit.writeUInt32BE(GROK_CARRIER_MAX_BYTES + 1, 0);
  const invalidUtf8Json = Buffer.from([0xc3, 0x28]);

  for (const [name, bytes, pattern] of [
    ['missing frame', Buffer.alloc(0), /missing/u],
    ['truncated frame', Buffer.from([0, 0, 0, 2, 0x7b]), /truncated/u],
    ['over-limit frame', overLimit, /maximum/u],
    ['trailing bytes', Buffer.concat([frame('{}'), Buffer.from('x')]), /trailing/u],
    ['invalid UTF-8 JSON', frame(invalidUtf8Json), /UTF-8|JSON/u],
  ]) {
    assert.throws(() => parseGrokCompatibilityCarrierFrame(bytes), pattern, name);
  }
});

test('a validly framed carrier still fails closed unless its compatibility evidence schema is complete and sealed', async () => {
  const {
    parseGrokCompatibilityCarrierFrame,
    validateGrokCompatibilityCarrier,
  } = await runtimePromise;
  const valid = validCarrier();

  const decode = (carrier) => parseGrokCompatibilityCarrierFrame(frame(JSON.stringify(carrier)));
  assert.deepEqual(validateGrokCompatibilityCarrier(decode(valid)), valid);
  for (const [name, mutation, pattern] of [
    ['unknown key', (carrier) => ({ ...carrier, covert_channel: true }), /unknown/u],
    ['missing version', (carrier) => ({ ...carrier, version: undefined }), /version/u],
    ['malformed version', (carrier) => ({ ...carrier, version: '1.0.4-beta' }), /version/u],
    ['incomplete required flag set', (carrier) => ({
      ...carrier,
      required_help_flags: carrier.required_help_flags.slice(1),
    }), /required_help_flags/u],
    ['missing chain seal', (carrier) => ({
      ...carrier,
      prepared_spawn_chain: { ...carrier.prepared_spawn_chain, chain_sha256: undefined },
    }), /chain_sha256/u],
    ['mismatched chain seal', (carrier) => ({
      ...carrier,
      prepared_spawn_chain: { ...carrier.prepared_spawn_chain, chain_sha256: 'd'.repeat(64) },
    }), /chain_sha256/u],
  ]) {
    assert.throws(
      () => validateGrokCompatibilityCarrier(decode(mutation(structuredClone(valid)))),
      pattern,
      name,
    );
  }
});

test('a resealed carrier is still rejected when its fields contradict the sealed chain', async () => {
  const { validateGrokCompatibilityCarrier } = await runtimePromise;
  const posix = validCarrier();
  const windows = validWindowsCarrier();

  assert.deepEqual(validateGrokCompatibilityCarrier(seal(structuredClone(posix))), posix);
  assert.deepEqual(validateGrokCompatibilityCarrier(windows), windows);

  const contradictions = [
    ['launcher_path is not the sealed launcher path', (carrier) => {
      carrier.launcher_path = '/opt/other-grok';
    }, /launcher_path/u],
    ['real_path is not the sealed launcher real path', (carrier) => {
      carrier.real_path = '/opt/other-grok';
    }, /real_path/u],
    ['executable_sha256 is not the sealed launcher digest', (carrier) => {
      carrier.executable_sha256 = 'f'.repeat(64);
    }, /executable_sha256/u],
    ['executable_size is not the sealed launcher size', (carrier) => {
      carrier.executable_size = 13;
    }, /executable_size/u],
    ['platform_identity is not the sealed launcher identity', (carrier) => {
      carrier.platform_identity.fields.ino = '99';
    }, /platform_identity/u],
    ['a POSIX chain carrying a null launcher purpose', (carrier) => {
      carrier.prepared_spawn_chain.launcher.classification_purpose = null;
    }, /classification_purpose/u],
    ['a POSIX chain with no POSIX executable type', (carrier) => {
      carrier.prepared_spawn_chain.posix_executable_type = null;
      carrier.prepared_spawn_chain.native_loader = null;
    }, /posix_executable_type/u],
    ['mixed platform identity kinds across members', (carrier) => {
      carrier.prepared_spawn_chain.native_loader.platform_identity = windowsIdentity('C:\\ld.dll');
    }, /platform_identity/u],
  ];
  for (const [name, contradict, pattern] of contradictions) {
    const carrier = structuredClone(posix);
    contradict(carrier);
    assert.throws(() => validateGrokCompatibilityCarrier(seal(carrier)), pattern, name);
  }

  const windowsContradictions = [
    ['a Windows chain carrying a POSIX executable purpose', (carrier) => {
      carrier.prepared_spawn_chain.launcher.classification_purpose = 'effective-executable';
    }, /classification_purpose/u],
    ['a Windows identity whose final path is not the sealed real path', (carrier) => {
      carrier.prepared_spawn_chain.launcher.platform_identity.fields.final_path = 'C:\\other.cmd';
    }, /final_path/u],
    ['a Windows-identity chain claiming a POSIX executable type', (carrier) => {
      carrier.prepared_spawn_chain.prepared_kind = 'direct';
      carrier.prepared_spawn_chain.shim = null;
      carrier.prepared_spawn_chain.interpreter = null;
      carrier.prepared_spawn_chain.posix_executable_type = 'native-elf';
    }, /posix_executable_type/u],
  ];
  for (const [name, contradict, pattern] of windowsContradictions) {
    const carrier = structuredClone(windows);
    contradict(carrier);
    assert.throws(() => validateGrokCompatibilityCarrier(seal(carrier)), pattern, name);
  }
});

test('the sole Grok CLI stdout parser accepts only the admitted version banner and complete help flags', async () => {
  const { parseGrokCompatibilityStdout } = await runtimePromise;
  const completeHelp = REQUIRED_FLAGS.join('\n');

  assert.deepEqual(
    parseGrokCompatibilityStdout('grok 1.0.4 (d846eb93d94d) [stable]\n', 'version'),
    { version: '1.0.4', version_build: 'd846eb93d94d' },
  );
  assert.deepEqual(
    parseGrokCompatibilityStdout(completeHelp, 'help'),
    { required_help_flags: [...REQUIRED_FLAGS] },
  );
  for (const [name, text, kind, pattern] of [
    ['unparseable version', 'grok 1.0.4\n', 'version', /version/u],
    ['unsupported version', 'grok 1.0.5 (d846eb93d94d) [stable]', 'version', /unsupported/u],
    ['missing required flag', REQUIRED_FLAGS.slice(1).join('\n'), 'help', /required/u],
  ]) {
    assert.throws(() => parseGrokCompatibilityStdout(text, kind), pattern, name);
  }
  let rejected;
  try {
    parseGrokCompatibilityStdout('grok 1.0.13 (d846eb93d94d) [stable]\n', 'version');
  } catch (error) {
    rejected = error;
  }
  assert.match(rejected.message, /unsupported Grok CLI version: 1\.0\.13 \(supported: 1\.0\.4\)/u);
  assert.deepEqual(rejected.grokVersionRejection, { observed: '1.0.13', supported: ['1.0.4'] });
  let rejectedUnstable;
  try {
    parseGrokCompatibilityStdout('grok 1.0.13 (d846eb93d94d)\n', 'version');
  } catch (error) {
    rejectedUnstable = error;
  }
  assert.equal(rejectedUnstable.grokVersionRejection.observed, '1.0.13');
});
