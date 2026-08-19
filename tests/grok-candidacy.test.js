'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const detectorPath = join(root, 'hooks', 'scripts', 'detect-environment.mjs');
const classifierPath = join(root, 'hooks', 'scripts', 'classify-artifacts.mjs');
const detectorUrl = pathToFileURL(detectorPath).href;
const registryUrl = pathToFileURL(
  join(root, 'hooks', 'scripts', 'lib', 'capability-registry.mjs'),
).href;
const carrierUrl = pathToFileURL(
  join(root, 'hooks', 'scripts', 'lib', 'grok-compatibility-carrier.mjs'),
).href;

const GROK_HELP = [
  '--single', '--prompt-file', '--model', '--reasoning-effort',
  '--permission-mode', '--sandbox', '--cwd', '--output-format', '--max-turns',
  '--session-id', '--no-memory', '--no-subagents',
].join(' ');
const temporaryRoots = new Set();

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(directory);
  return directory;
}

function isolatedEnvironment(bin, overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:CODEX_|CLAUDE_|PLUGIN_ROOT$)/iu.test(key)) delete env[key];
  }
  return {
    ...env,
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    ...overrides,
  };
}

function grokProbeSource(log, marker = '') {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `const log = ${JSON.stringify(log)};`,
    "fs.appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\\n`);",
    "if (process.argv[2] === '--version') process.stdout.write('grok 1.0.4 (d846eb93d94d) [stable]\\n');",
    `else if (process.argv[2] === '--help') process.stdout.write(${JSON.stringify(`${GROK_HELP}\n`)});`,
    "else process.exitCode = 2;",
    marker ? `// ${marker}` : '',
    '',
  ].join('\n');
}

function writeGrokLauncher(launcher, log, marker = '') {
  writeFileSync(launcher, `#!/usr/bin/env node\n${grokProbeSource(log, marker)}`);
  chmodSync(launcher, 0o755);
}

function makeGrokFixture(name) {
  const fixtureRoot = temporaryDirectory(`${name}-`);
  const bin = join(fixtureRoot, 'bin');
  const log = join(fixtureRoot, 'grok-calls.ndjson');
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, process.platform === 'win32' ? 'grok.cmd' : 'grok');
  if (process.platform === 'win32') {
    const program = join(fixtureRoot, 'grok-probe.js');
    writeFileSync(program, grokProbeSource(log));
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`);
  } else {
    writeGrokLauncher(launcher, log);
  }
  return { fixtureRoot, bin, launcher, log };
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
}

function initializeGitRepository(repo) {
  runGit(repo, ['init', '--quiet']);
  runGit(repo, ['config', 'user.email', 'fixture@example.invalid']);
  runGit(repo, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(repo, 'tracked.txt'), 'tracked\n');
  runGit(repo, ['add', '--', 'tracked.txt']);
  runGit(repo, ['commit', '--quiet', '-m', 'fixture']);
  writeFileSync(join(repo, 'candidate.md'), '# Candidate\n');
}

test.after(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true });
});

test('no Grok candidacy spawns no Grok child and writes no Grok state', async () => {
  const { detectEnvironment } = await import(detectorUrl);
  const fixture = makeGrokFixture('grok-no-candidacy');
  const calls = [];
  const result = await detectEnvironment({
    cwd: fixture.fixtureRoot,
    env: isolatedEnvironment(fixture.bin),
    processRunner: async (...args) => {
      calls.push(args);
      throw new Error('unexpected compatibility probe');
    },
  });

  assert.equal(calls.length, 0);
  assert.equal(existsSync(fixture.log), false);
  assert.deepEqual(Object.keys(result).filter((key) => key.startsWith('grok_')), []);
});

test('candidate/carrier flag pairing fails closed before any Grok probe', () => {
  const fixture = makeGrokFixture('grok-flag-pairing');
  const env = isolatedEnvironment(fixture.bin);

  const candidateOnly = spawnSync(process.execPath, [
    detectorPath, '--cwd', fixture.fixtureRoot, '--grok-candidate',
  ], { env, encoding: 'utf8', shell: false });
  assert.notEqual(candidateOnly.status, 0);
  assert.match(candidateOnly.stderr, /--grok-candidate requires --grok-carrier-fd <n>/u);
  assert.equal(existsSync(fixture.log), false);

  const carrierOnly = spawnSync(process.execPath, [
    detectorPath, '--cwd', fixture.fixtureRoot, '--grok-carrier-fd', '3',
  ], {
    env,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  assert.notEqual(carrierOnly.status, 0);
  assert.match(carrierOnly.stderr, /--grok-carrier-fd requires --grok-candidate/u);
  assert.equal(existsSync(fixture.log), false);
});

// The sole producer is `detect-environment.mjs`. The classifier consumer side of
// the private carrier channel does not exist yet: `classify-artifacts.mjs` owns
// no `--grok-carrier-fd` grammar and is not in this slice's change surface. This
// test therefore proves only the producer half plus the standing "consumers must
// not re-probe" invariant, and asserts the missing consumer so that the slice
// that lands it has to come back and widen this test.
test('the sole carrier producer frames one carrier on fd 3, keeps stdout carrier-free, and no consumer re-probes', async () => {
  const {
    parseGrokCompatibilityCarrierFrame,
    validateGrokCompatibilityCarrier,
  } = await import(carrierUrl);
  const fixture = makeGrokFixture('grok-carrier-producer');
  const repo = temporaryDirectory('grok-classifier-repo-');
  initializeGitRepository(repo);
  const env = isolatedEnvironment(fixture.bin);

  const detection = spawnSync(process.execPath, [
    detectorPath,
    '--cwd', repo,
    '--format', 'json',
    '--grok-candidate',
    '--grok-carrier-fd', '3',
  ], {
    env,
    encoding: null,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  assert.equal(detection.status, 0, detection.stderr.toString('utf8'));
  const frame = detection.output[3];
  // The evidence object is a designed part of the detector's JSON; the *frame*
  // is the private channel and must appear on fd 3 only. Checked before the
  // JSON is parsed, so it is this assertion that fails on a leak.
  assert.equal(frame.readUInt32BE(0), frame.length - 4);
  assert.equal(detection.stdout.includes(frame), false, 'stdout must carry no framed carrier');
  assert.equal(
    detection.stdout.includes(frame.subarray(0, 4)),
    false,
    'stdout must carry no frame length prefix',
  );

  const environment = JSON.parse(detection.stdout.toString('utf8'));
  const carrier = validateGrokCompatibilityCarrier(parseGrokCompatibilityCarrierFrame(frame));
  assert.equal(environment.grok_cli, true);
  assert.equal(environment.grok_compatibility_verified, true);
  assert.deepEqual(environment.grok_compatibility_evidence, carrier);
  assert.equal(carrier.prepared_spawn_chain.chain_sha256.length, 64);

  const producerCalls = readFileSync(fixture.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(producerCalls, [['--version'], ['--help']]);

  // The classifier is a consumer: it must add no compatibility child of its own.
  const classification = spawnSync(process.execPath, [
    classifierPath,
    '--repo', repo,
    '--change-state', 'untracked-only',
    '--review-base', 'HEAD',
    '--format', 'json',
  ], { env, encoding: 'utf8', shell: false });
  assert.equal(classification.status, 0, classification.stderr);
  assert.deepEqual(
    readFileSync(fixture.log, 'utf8').trim().split('\n').map(JSON.parse),
    producerCalls,
    'a consumer must spawn no additional compatibility child',
  );

  // Recorded gap: the consumer half of the private channel is unimplemented.
  const unconsumed = spawnSync(process.execPath, [
    classifierPath,
    '--repo', repo,
    '--change-state', 'untracked-only',
    '--review-base', 'HEAD',
    '--grok-carrier-fd', '3',
  ], { env, encoding: 'utf8', shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  assert.notEqual(unconsumed.status, 0);
  assert.match(unconsumed.stderr, /unknown argument: --grok-carrier-fd/u);
});

test('both compatibility probes use one identity-stable prepared-chain seal', async () => {
  const { detectEnvironment } = await import(detectorUrl);
  const fixture = makeGrokFixture('grok-chain-seal');
  const calls = [];
  const result = await detectEnvironment({
    cwd: fixture.fixtureRoot,
    env: isolatedEnvironment(fixture.bin),
    grokCandidate: true,
    processRunner: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        code: 0,
        timedOut: false,
        captureOverflow: false,
        stdout: Buffer.from(args[0] === '--version'
          ? 'grok 1.0.4 (d846eb93d94d) [stable]\n'
          : `${GROK_HELP}\n`),
        stderr: Buffer.alloc(0),
      };
    },
  });

  assert.equal(result.grok_compatibility_verified, true);
  assert.deepEqual(calls.map(({ args }) => args), [['--version'], ['--help']]);
  assert.equal(
    calls[0].options.expectedPreparedSpawnChain.chain_sha256,
    calls[1].options.expectedPreparedSpawnChain.chain_sha256,
  );
  assert.equal(
    result.grok_compatibility_evidence.prepared_spawn_chain.chain_sha256,
    calls[0].options.expectedPreparedSpawnChain.chain_sha256,
  );
});

// The seal-identity test above can only observe that the option was handed to the
// runner. This one observes the enforcement itself, through the production runner.
test('a launcher replaced after the detector sealed it reaches zero Grok child', async (t) => {
  if (process.platform === 'win32') {
    t.skip('the POSIX shebang replacement polarity is not observable on native Windows');
    return;
  }
  const { detectEnvironment } = await import(detectorUrl);
  const { runProcess } = await import(pathToFileURL(
    join(root, 'hooks', 'scripts', 'lib', 'process.mjs'),
  ).href);
  const fixture = makeGrokFixture('grok-replaced-launcher');
  let replaced = false;
  const detected = await detectEnvironment({
    cwd: fixture.fixtureRoot,
    env: isolatedEnvironment(fixture.bin),
    grokCandidate: true,
    processRunner: async (command, args, options) => {
      if (!replaced) {
        // Present before the runner's final identity comparison, after the seal.
        writeGrokLauncher(fixture.launcher, fixture.log, 'replacement');
        replaced = true;
      }
      return runProcess(command, args, options);
    },
  });

  assert.equal(replaced, true);
  assert.equal(existsSync(fixture.log), false, 'a replaced launcher must reach zero child');
  assert.equal(detected.grok_cli, false);
  assert.equal(detected.grok_compatibility_verified, false);
  assert.equal(detected.grok_compatibility_evidence, null);
  assert.equal(detected.grok_unavailable_reason, 'incompatible_grok_cli');
});

test('a prepared-chain mismatch result is incompatible even when the child reported success', async () => {
  const { detectEnvironment } = await import(detectorUrl);
  const fixture = makeGrokFixture('grok-mismatch-mapping');
  const detected = await detectEnvironment({
    cwd: fixture.fixtureRoot,
    env: isolatedEnvironment(fixture.bin),
    grokCandidate: true,
    processRunner: async (_command, args) => ({
      code: 0,
      timedOut: false,
      captureOverflow: false,
      preparedChainMismatch: true,
      preparedChainMismatchReason: 'prepared_chain_launcher_sha256_mismatch',
      stdout: Buffer.from(args[0] === '--version'
        ? 'grok 1.0.4 (d846eb93d94d) [stable]\n'
        : `${GROK_HELP}\n`),
      stderr: Buffer.alloc(0),
    }),
  });

  assert.equal(detected.grok_cli, false);
  assert.equal(detected.grok_compatibility_verified, false);
  assert.equal(detected.grok_unavailable_reason, 'incompatible_grok_cli');
});

test('grok-cli advertises prevention only for a detected, compatibility-verified executable', async () => {
  const { buildCapabilities } = await import(registryUrl);
  const evidence = Object.freeze({ sealed: true });
  // D21 folds the containment platform/arch gate into this same `available`
  // decision, and `containment` defaults to the live host. Pin a containment
  // platform so this test keeps testing compatibility verification — which is
  // what it is for — identically on every host, instead of passing on a Linux
  // runner and failing on a macOS one.
  const grok = (detected) => buildCapabilities({
    detected,
    containment: { platform: 'linux', arch: 'x64' },
  }).find((capability) => capability.adapter_id === 'grok-cli');

  const admitted = grok({
    grok_cli: true,
    grok_cli_path: '/tools/grok',
    grok_version: '1.0.4',
    grok_compatibility_verified: true,
    grok_compatibility_evidence: evidence,
  });
  assert.equal(admitted.available, true);
  assert.equal(admitted.read_only_enforcement, 'permission-mode-plan');
  assert.equal(admitted.grok_compatibility_evidence, evidence);
  assert.deepEqual(admitted.effort_selection, {
    supported: true,
    levels: ['low', 'medium', 'high'],
    transport: 'flag:--reasoning-effort',
  });

  for (const incompatible of [
    { grok_cli: true, grok_cli_path: '/tools/grok', grok_compatibility_verified: false },
    { grok_cli: false, grok_cli_path: '/tools/grok', grok_compatibility_verified: true },
    { grok_cli: true, grok_cli_path: '', grok_compatibility_verified: true },
  ]) {
    const capability = grok(incompatible);
    assert.equal(capability.available, false);
    assert.equal(capability.read_only_enforcement, 'none');
  }
});

test('compatibility failure advertises no Grok prevention claim', async () => {
  const { detectEnvironment } = await import(detectorUrl);
  const { buildCapabilities } = await import(registryUrl);
  const fixture = makeGrokFixture('grok-incompatible');
  const calls = [];
  const detected = await detectEnvironment({
    cwd: fixture.fixtureRoot,
    env: isolatedEnvironment(fixture.bin),
    grokCandidate: true,
    processRunner: async (_command, args) => {
      calls.push(args);
      return {
        code: 0,
        timedOut: false,
        captureOverflow: false,
        stdout: Buffer.from(args[0] === '--version'
          ? 'grok 1.0.5 (future) [stable]\n'
          : `${GROK_HELP}\n`),
        stderr: Buffer.alloc(0),
      };
    },
  });
  const capability = buildCapabilities({ detected })
    .find((item) => item.adapter_id === 'grok-cli');

  assert.deepEqual(calls, [['--version'], ['--help']]);
  assert.equal(detected.grok_cli, false);
  assert.equal(detected.grok_compatibility_verified, false);
  assert.equal(detected.grok_compatibility_evidence, null);
  assert.equal(capability.available, false);
  assert.equal(capability.read_only_enforcement, 'none');
});

test('old-revision capability cache is discarded', async () => {
  const { loadCapabilityCache } = await import(registryUrl);
  const repo = temporaryDirectory('grok-old-cache-');
  const cache = join(repo, 'capabilities.json');
  const keys = { claude: { path: '/tools/claude', mtime_ms: 10, version: '1.0.0' } };
  writeFileSync(cache, `${JSON.stringify({
    protocol_version: '2.0',
    cache_contract_revision: '4',
    invalidation_keys: keys,
    probe_results: {
      claude: { ok: true, version: 'Claude Code v1.0.0', help: '--effort' },
    },
  })}\n`);

  assert.equal(loadCapabilityCache(repo, cache, keys), null);
});

test('Grok cache key uses detected version and changes on a version-only upgrade', async () => {
  const { capabilityCacheKeys } = await import(registryUrl);
  const fixture = makeGrokFixture('grok-cache-version');
  const first = capabilityCacheKeys({
    grok_cli_path: fixture.launcher,
    grok_version: 'grok 1.0.4 (build) [stable]',
  });
  const upgraded = capabilityCacheKeys({
    grok_cli_path: fixture.launcher,
    grok_version: 'grok 1.0.5 (build) [stable]',
  });

  assert.equal(first.grok.version, '1.0.4');
  assert.equal(upgraded.grok.version, '1.0.5');
  assert.notDeepEqual(first, upgraded);
  assert.equal(capabilityCacheKeys({
    grok_cli_path: fixture.launcher,
    grok_version: 'grok 1.0.4 (detected) [stable]',
  }, {
    grok: { version: 'grok 1.0.6 (probe) [stable]' },
  }).grok.version, '1.0.6');
});

test('validProbeResults still rejects a persisted grok key', async () => {
  const { CAPABILITY_CACHE_REVISION, loadCapabilityCache } = await import(registryUrl);
  const repo = temporaryDirectory('grok-raw-probe-cache-');
  const cache = join(repo, 'capabilities.json');
  const fixture = makeGrokFixture('grok-raw-probe-bin');
  const keys = {
    grok: { path: fixture.launcher, mtime_ms: 10, version: '1.0.4' },
  };
  writeFileSync(cache, `${JSON.stringify({
    protocol_version: '2.0',
    cache_contract_revision: CAPABILITY_CACHE_REVISION,
    invalidation_keys: keys,
    probe_results: {
      grok: { ok: true, version: 'grok 1.0.4', help: GROK_HELP },
    },
  })}\n`);

  assert.equal(loadCapabilityCache(repo, cache, keys), null);
});
