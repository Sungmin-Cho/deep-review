'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
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

// A launcher that records one line per invocation. The log file existing at all
// is the observable proof that a child ran; its absence is the zero-child proof.
function loggingLauncher(root, name, log, marker) {
  return executable(root, name, [
    `#!${process.execPath}`,
    "'use strict';",
    `require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(marker)} + '\\n');`,
    '',
  ].join('\n'));
}

function childCount(log) {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0;
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

test('a launcher replaced between seal and spawn reaches zero child in runProcess', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the POSIX shebang replacement polarity is not observable on native Windows');
    return;
  }
  const root = workspace('runner-swap-async');
  const log = join(root, 'children.log');
  const launcher = loggingLauncher(root, 'grok', log, 'sealed');
  const { prepareSpawnChain, runProcess } = await runtimePromise;
  const sealed = prepareSpawnChain(launcher, ['--version'], { cwd: root, env: process.env });
  assert.equal(sealed.ok, true, sealed.reason);

  // The replacement is already present before the final identity comparison.
  loggingLauncher(root, 'grok', log, 'replacement');
  const result = await runProcess(launcher, ['--version'], {
    cwd: root,
    env: process.env,
    expectedPreparedSpawnChain: sealed.prepared_spawn_chain,
  });

  assert.equal(result.preparedChainMismatch, true, result.stderr.toString('utf8'));
  assert.notEqual(result.code, 0);
  assert.equal(childCount(log), 0, 'a replaced launcher must reach zero child');
});

test('a launcher replaced between seal and spawn reaches zero child in runProcessSync', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the POSIX shebang replacement polarity is not observable on native Windows');
    return;
  }
  const root = workspace('runner-swap-sync');
  const log = join(root, 'children.log');
  const launcher = loggingLauncher(root, 'grok', log, 'sealed');
  const { prepareSpawnChain, runProcessSync } = await runtimePromise;
  const sealed = prepareSpawnChain(launcher, ['--version'], { cwd: root, env: process.env });
  assert.equal(sealed.ok, true, sealed.reason);

  loggingLauncher(root, 'grok', log, 'replacement');
  const result = runProcessSync(launcher, ['--version'], {
    cwd: root,
    env: process.env,
    expectedPreparedSpawnChain: sealed.prepared_spawn_chain,
  });

  assert.equal(result.preparedChainMismatch, true, result.stderr.toString('utf8'));
  assert.notEqual(result.code, 0);
  assert.equal(childCount(log), 0, 'a replaced launcher must reach zero child');
});

test('an unchanged sealed chain spawns, and no supplied chain keeps today\'s behaviour', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the POSIX shebang chain positive is not observable on native Windows');
    return;
  }
  const root = workspace('runner-gate-positive');
  const log = join(root, 'children.log');
  const launcher = loggingLauncher(root, 'grok', log, 'ran');
  const { prepareSpawnChain, runProcess, runProcessSync } = await runtimePromise;
  const sealed = prepareSpawnChain(launcher, [], { cwd: root, env: process.env });
  assert.equal(sealed.ok, true, sealed.reason);

  const supervised = await runProcess(launcher, [], {
    cwd: root,
    env: process.env,
    expectedPreparedSpawnChain: sealed.prepared_spawn_chain,
  });
  assert.equal(supervised.code, 0, supervised.stderr.toString('utf8'));
  assert.equal(supervised.preparedChainMismatch, undefined);

  const unsupervised = await runProcess(launcher, [], { cwd: root, env: process.env });
  assert.equal(unsupervised.code, 0, unsupervised.stderr.toString('utf8'));
  assert.equal(unsupervised.preparedChainMismatch, undefined);

  const supervisedSync = runProcessSync(launcher, [], {
    cwd: root,
    env: process.env,
    expectedPreparedSpawnChain: sealed.prepared_spawn_chain,
  });
  assert.equal(supervisedSync.code, 0, supervisedSync.stderr.toString('utf8'));
  const unsupervisedSync = runProcessSync(launcher, [], { cwd: root, env: process.env });
  assert.equal(unsupervisedSync.code, 0, unsupervisedSync.stderr.toString('utf8'));
  assert.equal(childCount(log), 4);
});

test('a supplied chain that is not the freshly prepared chain reaches zero child', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the POSIX shebang chain polarity is not observable on native Windows');
    return;
  }
  const root = workspace('runner-gate-negative');
  const log = join(root, 'children.log');
  const launcher = loggingLauncher(root, 'grok', log, 'ran');
  const other = loggingLauncher(root, 'other', join(root, 'other.log'), 'other');
  const { prepareSpawnChain, runProcess, runProcessSync } = await runtimePromise;
  const sealed = prepareSpawnChain(launcher, [], { cwd: root, env: process.env });
  const foreign = prepareSpawnChain(other, [], { cwd: root, env: process.env });
  assert.equal(sealed.ok, true, sealed.reason);
  assert.equal(foreign.ok, true, foreign.reason);

  const rejected = [
    ['not an object', 'not-even-an-object'],
    ['null chain', null],
    ['empty chain', {}],
    ['another launcher\'s chain', foreign.prepared_spawn_chain],
    ['forged seal', { ...sealed.prepared_spawn_chain, chain_sha256: 'd'.repeat(64) }],
    ['doctored launcher digest', {
      ...sealed.prepared_spawn_chain,
      launcher: { ...sealed.prepared_spawn_chain.launcher, sha256: 'e'.repeat(64) },
    }],
  ];
  for (const [name, expectedPreparedSpawnChain] of rejected) {
    const asynchronous = await runProcess(launcher, [], {
      cwd: root, env: process.env, expectedPreparedSpawnChain,
    });
    assert.equal(asynchronous.preparedChainMismatch, true, name);
    assert.notEqual(asynchronous.code, 0, name);
    const synchronous = runProcessSync(launcher, [], {
      cwd: root, env: process.env, expectedPreparedSpawnChain,
    });
    assert.equal(synchronous.preparedChainMismatch, true, name);
    assert.notEqual(synchronous.code, 0, name);
  }
  assert.equal(childCount(log), 0, 'no mismatching chain may reach a child');
  assert.equal(childCount(join(root, 'other.log')), 0);
});

test('sealing a member rejects a file that changed after it was classified', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    t.skip('the closed POSIX prepared chain supports macOS and Linux');
    return;
  }
  const root = workspace('seal-binding-identity');
  const target = executable(root, 'grok', `#!${process.execPath}\n`);
  const { __testing } = await runtimePromise;

  const observation = __testing.observePreparedMember(target, 'launcher');
  assert.equal(observation.ok, true, observation.reason);
  const unchanged = __testing.sealObservedMember(target, 'launcher', observation);
  assert.equal(unchanged.ok, true, unchanged.reason);

  // The replacement lands between the classifier's open and the seal's open.
  executable(root, 'grok', `#!${process.execPath}\n# replaced\n`);
  const replaced = __testing.sealObservedMember(target, 'launcher', observation);
  assert.equal(replaced.ok, false);
  assert.match(replaced.reason, /changed_between_classification_and_seal/u);
});

test('sealing a member rejects bytes that contradict the classification they carry', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    t.skip('the closed POSIX prepared chain supports macOS and Linux');
    return;
  }
  const root = workspace('seal-binding-bytes');
  const target = executable(root, 'grok', `#!${process.execPath}\n`);
  const { __testing } = await runtimePromise;
  const observation = __testing.observePreparedMember(target, 'launcher');
  assert.equal(observation.ok, true, observation.reason);

  const nativeType = process.platform === 'darwin' ? 'native-macho' : 'native-elf';
  const doctored = {
    ...observation,
    classification: { ...observation.classification, type: nativeType },
  };
  const sealed = __testing.sealObservedMember(target, 'launcher', doctored);
  assert.equal(sealed.ok, false);
  assert.match(sealed.reason, /bytes_contradict_classification/u);
});

test('native-Windows prepared chain seals launcher, selected shim, and interpreter', {
  skip: process.platform === 'win32' ? false : 'requires a native Windows file-identity and spawn-selection seam',
}, async () => {
  const { prepareSpawnChain } = await runtimePromise;
  assert.equal(typeof prepareSpawnChain, 'function');
});
