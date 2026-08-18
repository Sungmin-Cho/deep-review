'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const processModuleUrl = pathToFileURL(join(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'lib',
  'process.mjs',
)).href;
const runtimePromise = import(processModuleUrl);

function workspace(label) {
  const root = mkdtempSync(join(tmpdir(), `deep-review-chain-${label}-`));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function executable(root, name, source) {
  const path = join(root, name);
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function assertMember(member, purpose) {
  assert.equal(typeof member.path, 'string');
  assert.equal(typeof member.real_path, 'string');
  assert.equal(typeof member.sha256, 'string');
  assert.match(member.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Number.isSafeInteger(member.size), true);
  assert.equal(member.classification_purpose, purpose);
  assert.equal(typeof member.platform_identity, 'object');
}

test('native prepared chain seals the actual launcher and native loader', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    t.skip('the closed POSIX prepared chain supports macOS and Linux');
    return;
  }
  const { prepareSpawnChain } = await runtimePromise;
  const result = prepareSpawnChain(process.execPath, ['--version'], {
    cwd: process.cwd(),
    env: process.env,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.prepared.command, process.execPath);
  assert.deepEqual(result.prepared.args, ['--version']);
  const chain = result.prepared_spawn_chain;
  assert.equal(chain.schema_version, '1.0');
  assert.equal(chain.prepared_kind, 'direct');
  assert.equal(chain.posix_executable_type, process.platform === 'darwin' ? 'native-macho' : 'native-elf');
  assert.equal(chain.shebang, null);
  assert.equal(chain.shim, null);
  assert.equal(chain.interpreter, null);
  assertMember(chain.launcher, 'effective-executable');
  if (process.platform === 'darwin') {
    assertMember(chain.native_loader, 'native-loader');
    assert.equal(chain.native_loader.path, '/usr/lib/dyld');
  }
  assert.match(chain.chain_sha256, /^[a-f0-9]{64}$/u);
});

test('absolute shebang chain seals and classifies the selected interpreter', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shebang chains are not observable on native Windows');
    return;
  }
  const root = workspace('absolute');
  const launcher = executable(root, 'grok', `#!${process.execPath}\n`);
  const { prepareSpawnChain } = await runtimePromise;
  const result = prepareSpawnChain(launcher, [], { cwd: root, env: process.env });

  assert.equal(result.ok, true, result.reason);
  const chain = result.prepared_spawn_chain;
  assert.equal(chain.prepared_kind, 'direct');
  assert.equal(chain.posix_executable_type, 'shebang');
  assert.equal(chain.shebang.shebang_form, 'absolute');
  assertMember(chain.launcher, 'effective-executable');
  assertMember(chain.shebang.interpreter, 'effective-executable');
  assert.equal(chain.shebang.interpreter.real_path, process.execPath);
  assert.equal(chain.shebang.path_target, null);
});

test('env-path shebang chain seals /usr/bin/env and the spawn-environment PATH target', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shebang chains are not observable on native Windows');
    return;
  }
  const root = workspace('env-path');
  const launcher = executable(root, 'grok', '#!/usr/bin/env node\n');
  const { prepareSpawnChain } = await runtimePromise;
  const result = prepareSpawnChain(launcher, [], {
    cwd: root,
    env: { ...process.env, PATH: dirname(process.execPath) },
  });

  assert.equal(result.ok, true, result.reason);
  const shebang = result.prepared_spawn_chain.shebang;
  assert.equal(shebang.shebang_form, 'env-path');
  assertMember(shebang.interpreter, 'effective-executable');
  assert.equal(shebang.interpreter.path, '/usr/bin/env');
  assertMember(shebang.path_target, 'effective-executable');
  assert.equal(shebang.path_target.real_path, process.execPath);
});

test('prepared chain rejects a shebangless text PATH target and unsupported shebang grammar', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shebang chains are not observable on native Windows');
    return;
  }
  const root = workspace('rejections');
  const launcher = executable(root, 'grok', '#!/usr/bin/env node\n');
  executable(root, 'node', 'console.log("implicit shell fallback")\n');
  const unsupported = executable(root, 'unsupported', '#!/usr/bin/env -Snode\n');
  const { prepareSpawnChain } = await runtimePromise;

  const fallback = prepareSpawnChain(launcher, [], {
    cwd: root,
    env: { ...process.env, PATH: root },
  });
  assert.equal(fallback.ok, false);
  assert.match(fallback.reason, /unrecognized_posix_executable|shebangless_text/u);

  const grammar = prepareSpawnChain(unsupported, [], {
    cwd: root,
    env: { ...process.env, PATH: dirname(process.execPath) },
  });
  assert.equal(grammar.ok, false);
  assert.match(grammar.reason, /unsupported_shebang/u);
});

test('classification purpose is producer-derived and caller-controlled relabeling fails closed', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    t.skip('the closed POSIX prepared chain supports macOS and Linux');
    return;
  }
  const { prepareSpawnChain } = await runtimePromise;
  const normal = prepareSpawnChain(process.execPath, [], { env: process.env });
  const attemptedRelabel = prepareSpawnChain(process.execPath, [], {
    env: process.env,
    classification_purpose: 'native-loader',
  });

  assert.equal(normal.ok, true, normal.reason);
  assert.deepEqual(attemptedRelabel, {
    ok: false,
    reason: 'caller_controlled_classification_purpose',
  });
});

test('launcher bytes participate in chain_sha256', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shebang chains are not observable on native Windows');
    return;
  }
  const root = workspace('digest');
  const first = executable(root, 'first', `#!${process.execPath}\n# first\n`);
  const second = executable(root, 'second', `#!${process.execPath}\n# second\n`);
  const { prepareSpawnChain } = await runtimePromise;
  const firstChain = prepareSpawnChain(first, [], { cwd: root, env: process.env });
  const secondChain = prepareSpawnChain(second, [], { cwd: root, env: process.env });

  assert.equal(firstChain.ok, true, firstChain.reason);
  assert.equal(secondChain.ok, true, secondChain.reason);
  assert.notEqual(
    firstChain.prepared_spawn_chain.launcher.sha256,
    secondChain.prepared_spawn_chain.launcher.sha256,
  );
  assert.notEqual(
    firstChain.prepared_spawn_chain.chain_sha256,
    secondChain.prepared_spawn_chain.chain_sha256,
  );
});

test('prepared chain rejects nested shebang interpreters and PATH targets', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shebang chains are not observable on native Windows');
    return;
  }
  const root = workspace('nested');
  const nested = executable(root, 'nested', `#!${process.execPath}\n`);
  const absolute = executable(root, 'absolute', `#!${nested}\n`);
  const envPath = executable(root, 'env-path', '#!/usr/bin/env nested\n');
  const { prepareSpawnChain } = await runtimePromise;

  for (const [name, launcher, env] of [
    ['absolute nested shebang', absolute, process.env],
    ['env-path nested shebang', envPath, { ...process.env, PATH: root }],
  ]) {
    const result = prepareSpawnChain(launcher, [], { cwd: root, env });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /nested_shebang/u, name);
  }
});

test('chain_sha256 is the canonical seal of the complete chain without its hash field', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    t.skip('the closed POSIX prepared chain supports macOS and Linux');
    return;
  }
  const { createHash } = require('node:crypto');
  const { __testing, prepareSpawnChain } = await runtimePromise;
  const result = prepareSpawnChain(process.execPath, [], { env: process.env });
  assert.equal(result.ok, true, result.reason);
  const { chain_sha256: seal, ...body } = result.prepared_spawn_chain;
  const expected = createHash('sha256')
    .update(Buffer.from(__testing.canonicalStringify(body), 'utf8'))
    .digest('hex');
  assert.equal(seal, expected);
});

test('native-Windows prepared chain seals launcher, selected shim, and interpreter', {
  skip: process.platform === 'win32' ? false : 'requires a native Windows file-identity and spawn-selection seam',
}, async () => {
  const { prepareSpawnChain } = await runtimePromise;
  assert.equal(typeof prepareSpawnChain, 'function');
});
