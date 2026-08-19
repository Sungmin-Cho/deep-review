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
});
