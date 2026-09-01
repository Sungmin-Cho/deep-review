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
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const { createHash } = require('node:crypto');
const {
  cleanupGitFixtures,
  createGitFixture,
  fixtureRootFor,
  git,
} = require('./helpers/git-fixture.js');

const detectorPath = join(__dirname, '..', 'hooks', 'scripts', 'detect-environment.mjs');
const detectorUrl = pathToFileURL(detectorPath).href;
const gitModuleUrl = pathToFileURL(join(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'lib',
  'git.mjs',
)).href;

const temporaryRoots = new Set();

function makeTemporaryDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(directory);
  return directory;
}

test.after(() => {
  cleanupGitFixtures();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

async function loadDetector() {
  return import(detectorUrl);
}

async function loadGitModule() {
  return import(gitModuleUrl);
}

function isolatedEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:CODEX_|CLAUDE_|PLUGIN_ROOT$)/i.test(key)) delete env[key];
  }
  return { ...env, ...overrides };
}

function makeExecutable(filePath, source) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
  if (process.platform !== 'win32') chmodSync(filePath, 0o755);
}

function createFakeCliDirectory(name, scripts = {}) {
  const root = makeTemporaryDirectory(`${name}-`);
  const bin = join(root, 'bin 공간 Ω');
  mkdirSync(bin, { recursive: true });

  for (const [command, body] of Object.entries(scripts)) {
    const program = join(root, `${command}-probe.js`);
    writeFileSync(program, body);
    if (process.platform === 'win32') {
      const launcher = join(bin, `${command}.cmd`);
      makeExecutable(
        launcher,
        `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`,
      );
    } else {
      const launcher = join(bin, command);
      writeFileSync(launcher, `#!/usr/bin/env node\n${body}`);
      chmodSync(launcher, 0o755);
    }
  }
  return { root, bin };
}

function writeCompanion(root, version) {
  const companion = join(
    root,
    'plugins',
    'cache',
    'openai-codex',
    'codex',
    version,
    'scripts',
    'codex-companion.mjs',
  );
  mkdirSync(join(companion, '..'), { recursive: true });
  writeFileSync(companion, '// deterministic companion fixture\n');
  return companion;
}

function writeClaudeCompanion(home, version) {
  const companion = join(
    home,
    '.claude',
    'plugins',
    'cache',
    'openai-codex',
    'codex',
    version,
    'scripts',
    'codex-companion.mjs',
  );
  mkdirSync(join(companion, '..'), { recursive: true });
  writeFileSync(companion, '// deterministic companion fixture\n');
  return companion;
}

function assertAvailabilityShape(result) {
  for (const key of [
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
  ]) {
    assert.equal(Object.hasOwn(result, key), true, `missing stable key ${key}`);
  }
}

test('non-Git directory emits the stable shape and every CLI availability field', async () => {
  const { detectEnvironment } = await loadDetector();
  const cwd = makeTemporaryDirectory('deep-review-non-git-');
  const result = await detectEnvironment({
    cwd,
    env: isolatedEnvironment({ PATH: '' }),
  });

  assert.equal(result.is_git, false);
  assert.equal(result.has_commits, false);
  assert.equal(result.change_state, 'non-git');
  assert.equal(result.staged, 0);
  assert.equal(result.unstaged, 0);
  assert.equal(result.untracked, 0);
  assert.equal(result.has_untracked, false);
  assert.equal(result.review_base, '');
  assert.equal(result.review_base_method, '');
  assert.equal(result.is_shallow, false);
  assert.equal(result.node_available, true);
  assert.equal(result.node_path, process.execPath);
  assertAvailabilityShape(result);
});

test('zero-commit repository is initial and retains zeroed Git fields', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('deep review 환경 Ω', { initialCommit: false });
  const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });

  assert.equal(result.is_git, true);
  assert.equal(result.has_commits, false);
  assert.equal(result.change_state, 'initial');
  assert.equal(result.staged, 0);
  assert.equal(result.unstaged, 0);
  assert.equal(result.untracked, 0);
  assert.equal(result.has_untracked, false);
  assert.equal(result.review_base, '');
  assert.equal(result.review_base_method, '');
});

test('clean, staged, unstaged, mixed, and untracked-only states have exact counts', async (t) => {
  const { detectEnvironment } = await loadDetector();

  await t.test('clean', async () => {
    const repo = createGitFixture('clean 환경 Ω');
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['clean', 0, 0, 0, false],
    );
  });

  await t.test('staged with spaces and Unicode', async () => {
    const repo = createGitFixture('staged 환경 Ω');
    writeFileSync(join(repo, '한 글.txt'), 'one');
    git(repo, ['add', '--', '한 글.txt']);
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['staged', 1, 0, 0, false],
    );
  });

  await t.test('unstaged', async () => {
    const repo = createGitFixture('unstaged 환경 Ω');
    writeFileSync(join(repo, 'tracked.txt'), 'changed\n');
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['unstaged', 0, 1, 0, false],
    );
  });

  await t.test('mixed counts the same path in both index and worktree', async () => {
    const repo = createGitFixture('mixed 환경 Ω');
    writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
    git(repo, ['add', '--', 'tracked.txt']);
    writeFileSync(join(repo, 'tracked.txt'), 'unstaged after staged\n');
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['mixed', 1, 1, 0, false],
    );
  });

  await t.test('untracked-only', async () => {
    const repo = createGitFixture('untracked 환경 Ω');
    writeFileSync(join(repo, '새 파일.txt'), 'new\n');
    const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
    assert.deepEqual(
      [result.change_state, result.staged, result.unstaged, result.untracked, result.has_untracked],
      ['untracked-only', 0, 0, 1, true],
    );
  });
});

test('root commit computes the empty-tree base inside the repository', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('root base 환경 Ω');
  const expected = git(repo, ['hash-object', '-t', 'tree', '--stdin'], { input: Buffer.alloc(0) });
  const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });

  assert.equal(result.review_base, expected);
  assert.equal(result.review_base_method, 'empty-tree');
});

test('two-commit base prefers origin HEAD, main, master, then HEAD parent', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('base precedence 환경 Ω');
  const rootCommit = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'tracked.txt'), 'second\n');
  git(repo, ['add', '--', 'tracked.txt']);
  git(repo, ['commit', '--quiet', '-m', 'second']);
  const headCommit = git(repo, ['rev-parse', 'HEAD']);

  git(repo, ['update-ref', 'refs/remotes/origin/trunk', headCommit]);
  git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
  git(repo, ['update-ref', 'refs/remotes/origin/main', rootCommit]);
  git(repo, ['update-ref', 'refs/remotes/origin/master', rootCommit]);
  let result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.deepEqual([result.review_base, result.review_base_method], [headCommit, 'merge-base']);

  git(repo, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
  result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.deepEqual([result.review_base, result.review_base_method], [rootCommit, 'merge-base']);

  git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
  result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.deepEqual([result.review_base, result.review_base_method], [rootCommit, 'merge-base']);

  git(repo, ['update-ref', '-d', 'refs/remotes/origin/master']);
  result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.deepEqual([result.review_base, result.review_base_method], ['HEAD~1', 'head-parent']);
});

test('shallow repositories are detected through Git plumbing', async () => {
  const { detectEnvironment } = await loadDetector();
  const source = createGitFixture('shallow source 환경 Ω');
  writeFileSync(join(source, 'tracked.txt'), 'second\n');
  git(source, ['add', '--', 'tracked.txt']);
  git(source, ['commit', '--quiet', '-m', 'second']);

  const target = join(fixtureRootFor(source), 'shallow clone 환경 Ω');
  const cloned = spawnSync('git', [
    'clone',
    '--quiet',
    '--depth',
    '1',
    pathToFileURL(source).href,
    target,
  ], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(cloned.status, 0, cloned.stderr);

  const result = await detectEnvironment({ cwd: target, env: isolatedEnvironment() });
  assert.equal(result.is_shallow, true);
});

test('companion discovery spans trusted Codex and Claude caches with stable semver ordering', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('companion 환경 Ω');
  const codexHome = makeTemporaryDirectory('codex-home 공간 Ω-');
  const home = makeTemporaryDirectory('home 공간 Ω-');

  writeCompanion(codexHome, '1.9.9');
  writeCompanion(codexHome, '2.0.0-rc.1');
  const stable = writeClaudeCompanion(home, '2.0.0');
  writeClaudeCompanion(home, '1.100.0');

  const result = await detectEnvironment({
    cwd: repo,
    env: isolatedEnvironment({ CODEX_HOME: codexHome, HOME: home }),
  });
  assert.equal(result.codex_plugin, true);
  assert.equal(result.codex_companion_path, stable);
  assert.equal(result.codex_installed, true);
});

test('explicit companion path wins and similarly named untrusted marketplaces are ignored', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('trusted boundary 환경 Ω');
  const codexHome = makeTemporaryDirectory('codex-boundary-');
  const home = makeTemporaryDirectory('home-boundary-');
  const trusted = writeCompanion(codexHome, '3.0.0');
  const explicit = join(home, 'explicit companion 공간 Ω.mjs');
  writeFileSync(explicit, '// explicit fixture\n');

  const untrusted = join(
    home,
    '.claude',
    'plugins',
    'cache',
    'not-openai-codex',
    'codex',
    '999.0.0',
    'scripts',
    'codex-companion.mjs',
  );
  mkdirSync(join(untrusted, '..'), { recursive: true });
  writeFileSync(untrusted, '// untrusted fixture\n');

  let result = await detectEnvironment({
    cwd: repo,
    env: isolatedEnvironment({
      CODEX_HOME: codexHome,
      HOME: home,
      CODEX_COMPANION_PATH: explicit,
    }),
  });
  assert.equal(result.codex_companion_path, explicit);

  result = await detectEnvironment({
    cwd: repo,
    env: isolatedEnvironment({ CODEX_HOME: codexHome, HOME: home }),
  });
  assert.equal(result.codex_companion_path, trusted);

  result = await detectEnvironment({
    cwd: repo,
    env: isolatedEnvironment({
      CODEX_HOME: join(home, 'empty-codex-home'),
      HOME: home,
    }),
  });
  assert.equal(result.codex_plugin, false);
  assert.equal(result.codex_companion_path, '');
});

test('CLI paths with spaces and Unicode survive detection and agy version timeout is bounded', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('cli path 환경 Ω');
  const cli = createFakeCliDirectory('deep-review-cli', {
    claude: 'process.exit(0);\n',
    codex: 'process.exit(0);\n',
    agy: "if (process.argv.includes('--version')) setInterval(() => {}, 1000);\n",
  });
  const env = isolatedEnvironment({
    PATH: `${cli.bin}${delimiter}${process.env.PATH || ''}`,
    PATHEXT: process.platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : process.env.PATHEXT,
  });

  const started = Date.now();
  const result = await detectEnvironment({ cwd: repo, env });
  const elapsed = Date.now() - started;

  assert.equal(result.claude_cli, true);
  assert.equal(result.codex_cli, true);
  assert.equal(result.agy_cli, true);
  assert.equal(result.claude_cli_path.startsWith(cli.bin), true);
  assert.equal(result.codex_cli_path.startsWith(cli.bin), true);
  assert.equal(result.agy_cli_path.startsWith(cli.bin), true);
  assert.equal(result.agy_version, '');
  assert.equal(elapsed >= 2900, true, `agy timeout returned too early: ${elapsed}ms`);
  assert.equal(elapsed < 5000, true, `agy timeout was not bounded: ${elapsed}ms`);
});

test('agy version probing uses finite capture limits and overflow cannot enable agy', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = makeTemporaryDirectory('deep-review-agy-overflow-repo-');
  const cli = createFakeCliDirectory('deep-review-agy-overflow', {
    agy: "process.stdout.write('real runner must not be used\\n');\n",
  });
  const calls = [];
  const processRunner = async (binary, args, options) => {
    calls.push({ binary, args, options });
    return {
      code: 0,
      timedOut: false,
      captureOverflow: true,
      stdout: Buffer.from('agy 9.9.9\n' + 'x'.repeat(200_000)),
      stderr: Buffer.alloc(0),
    };
  };
  const result = await detectEnvironment({
    cwd: repo,
    env: isolatedEnvironment({
      PATH: `${cli.bin}${delimiter}${process.env.PATH || ''}`,
      PATHEXT: process.platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : process.env.PATHEXT,
    }),
    processRunner,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(Number.isSafeInteger(calls[0].options.maxCaptureBytesPerStream), true);
  assert.equal(calls[0].options.maxCaptureBytesPerStream > 0, true);
  assert.equal(Number.isSafeInteger(calls[0].options.maxCaptureBytesTotal), true);
  assert.equal(calls[0].options.maxCaptureBytesTotal > 0, true);
  assert.equal(result.agy_cli, false);
  assert.equal(result.agy_version, '');
});

test('CLI JSON round-trips equals signs and KV remains a compatibility format', async () => {
  const repo = createGitFixture('cli output 환경 Ω');
  const cli = createFakeCliDirectory('deep-review-cli-output', {
    agy: "if (process.argv.includes('--version')) process.stdout.write('agy=9.4.0 Ω\\n');\n",
  });
  const env = isolatedEnvironment({
    PATH: `${cli.bin}${delimiter}${process.env.PATH || ''}`,
    PATHEXT: process.platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : process.env.PATHEXT,
    PLUGIN_ROOT: join(repo, 'plugin root 공간 Ω'),
  });

  const jsonRun = spawnSync(process.execPath, [detectorPath, '--cwd', repo, '--format', 'json'], {
    encoding: 'utf8',
    env,
    shell: false,
    windowsHide: true,
  });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.agy_version, 'agy=9.4.0 Ω');
  assert.equal(parsed.plugin_root, resolve(env.PLUGIN_ROOT));

  const kvRun = spawnSync(process.execPath, [detectorPath, '--cwd', repo, '--format', 'kv'], {
    encoding: 'utf8',
    env,
    shell: false,
    windowsHide: true,
  });
  assert.equal(kvRun.status, 0, kvRun.stderr);
  assert.equal(kvRun.stdout.includes('agy_version=agy=9.4.0 Ω\n'), true);
  assert.equal(kvRun.stdout.includes('plugin_root='), true);
});

test('SHA-256 root repositories use their dynamically computed 64-hex empty tree', async () => {
  const { detectEnvironment } = await loadDetector();
  const repo = createGitFixture('sha256 환경 Ω', { objectFormat: 'sha256' });
  const expected = git(repo, ['hash-object', '-t', 'tree', '--stdin'], { input: Buffer.alloc(0) });
  assert.match(expected, /^[0-9a-f]{64}$/);

  const result = await detectEnvironment({ cwd: repo, env: isolatedEnvironment() });
  assert.equal(result.review_base, expected);
  assert.notEqual(result.review_base, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  assert.equal(result.review_base_method, 'empty-tree');
});

test('Git path codec is byte-bijective and porcelain -z consumes rename source tokens', async () => {
  const {
    decodeGitPath,
    encodeGitPath,
    parsePorcelainV1Z,
    splitNul,
  } = await loadGitModule();

  for (const bytes of [
    Buffer.from('한 글 Ω.txt', 'utf8'),
    Buffer.from([0x61, 0x80, 0x62]),
    Buffer.from([0x66, 0xe2, 0x82]),
  ]) {
    const decoded = decodeGitPath(bytes);
    assert.equal(encodeGitPath(decoded).equals(bytes), true, bytes.toString('hex'));
  }

  const surrogateEscaped = `prefix-${String.fromCharCode(0xdc80)}-${String.fromCharCode(0xdcff)}-Ω`;
  assert.equal(decodeGitPath(encodeGitPath(surrogateEscaped)), surrogateEscaped);
  assert.deepEqual(splitNul(Buffer.from('a\0b\0')), [Buffer.from('a'), Buffer.from('b')]);

  const status = Buffer.concat([
    Buffer.from('R  renamed Ω.txt\0', 'utf8'),
    Buffer.from([0x6f, 0x6c, 0x64, 0x80]),
    Buffer.from('\0?? untracked.txt\0', 'utf8'),
  ]);
  const records = parsePorcelainV1Z(status);
  assert.equal(records.length, 2);
  assert.deepEqual(
    {
      index: records[0].index,
      workTree: records[0].workTree,
      path: records[0].path,
      originalPath: records[0].originalPath,
    },
    {
      index: 'R',
      workTree: ' ',
      path: 'renamed Ω.txt',
      originalPath: decodeGitPath(Buffer.from([0x6f, 0x6c, 0x64, 0x80])),
    },
  );
  assert.deepEqual(records[1], {
    index: '?',
    workTree: '?',
    path: 'untracked.txt',
  });
});

test('async and sync Git wrappers preserve argv and Buffer results', async () => {
  const { git: runGit, gitSync } = await loadGitModule();
  const repo = createGitFixture('git wrapper 환경 Ω');
  writeFileSync(join(repo, '한 글.txt'), 'one');
  git(repo, ['add', '--', '한 글.txt']);

  const asyncResult = await runGit(repo, ['ls-files', '-z', '--', '한 글.txt']);
  assert.equal(asyncResult.code, 0);
  assert.equal(Buffer.isBuffer(asyncResult.stdout), true);
  assert.equal(asyncResult.stdout.equals(Buffer.from('한 글.txt\0')), true);

  const syncResult = gitSync(repo, ['hash-object', '-t', 'tree', '--stdin'], {
    input: Buffer.alloc(0),
  });
  assert.equal(syncResult.code, 0);
  assert.equal(Buffer.isBuffer(syncResult.stdout), true);
  assert.match(syncResult.stdout.toString('utf8').trim(), /^[0-9a-f]{40,64}$/);
});

test('Git fixture naming contract remains argv-safe', () => {
  const repo = createGitFixture('deep review 환경 Ω');
  writeFileSync(join(repo, '한 글.txt'), 'one');
  git(repo, ['add', '--', '한 글.txt']);
  assert.equal(git(repo, ['-c', 'core.quotePath=false', 'ls-files', '--', '한 글.txt']), '한 글.txt');
  assert.equal(readFileSync(join(repo, '한 글.txt'), 'utf8'), 'one');
});

// ---------------------------------------------------------------------------
// D22 / T-PROBE-7 — the production carrier coordinator.
//
// `hooks/scripts/grok-carrier-coordinator.mjs` is the shipped executable that
// owns the private channel from process A (the standalone detector) to process
// B (every downstream consumer). These fixtures spawn both halves as real OS
// processes: a same-process fake cannot prove that a file descriptor, which is
// process-local, was actually re-supplied as a fresh readable endpoint.
// ---------------------------------------------------------------------------

const coordinatorExecutablePath = join(
  __dirname, '..', 'hooks', 'scripts', 'grok-carrier-coordinator.mjs',
);
const coordinatorLibUrl = pathToFileURL(join(
  __dirname, '..', 'hooks', 'scripts', 'lib', 'grok-carrier-coordinator.mjs',
)).href;
const standaloneDetectorPath = join(__dirname, '..', 'hooks', 'scripts', 'detect-environment.mjs');

const GROK_HELP_FLAGS = [
  '--single', '--prompt-file', '--model', '--reasoning-effort',
  '--permission-mode', '--sandbox', '--cwd', '--output-format', '--max-turns',
  '--session-id', '--no-memory', '--no-subagents',
].join(' ');

const liveCoordinators = new Set();

test.after(() => {
  for (const child of liveCoordinators) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

function grokStubSource(log) {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    `const log = ${JSON.stringify(log)};`,
    'fs.appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\\n`);',
    "if (process.argv[2] === '--version') process.stdout.write('grok 1.0.4 (d846eb93d94d) [stable]\\n');",
    `else if (process.argv[2] === '--help') process.stdout.write(${JSON.stringify(`${GROK_HELP_FLAGS}\n`)});`,
    'else process.exitCode = 2;',
    '',
  ].join('\n');
}

function makeGrokBin(prefix) {
  const root = makeTemporaryDirectory(prefix);
  const bin = join(root, 'bin');
  const log = join(root, 'grok-calls.ndjson');
  mkdirSync(bin, { recursive: true });
  const source = grokStubSource(log);
  if (process.platform === 'win32') {
    const program = join(root, 'grok-probe.js');
    writeFileSync(program, source);
    makeExecutable(join(bin, 'grok.cmd'), `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`);
  } else {
    makeExecutable(join(bin, 'grok'), `#!/usr/bin/env node\n${source}`);
  }
  return { root, bin, log };
}

function grokChildren(log) {
  let text;
  try { text = readFileSync(log, 'utf8'); } catch { return []; }
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function pathEnvironment(bin) {
  return isolatedEnvironment({
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
  });
}

// Real process B. It links the shipped owner module and nothing else, so what
// it proves is the production acquisition path, not a test re-implementation.
function writeConsumer(root, name) {
  const consumer = join(root, name);
  writeFileSync(consumer, [
    `import { acquireEnvironmentEndpoint } from ${JSON.stringify(coordinatorLibUrl)};`,
    'const [controlPath, consumerId] = process.argv.slice(2);',
    'const acquired = await acquireEnvironmentEndpoint({ controlPath, consumerId });',
    'process.stdout.write(`${JSON.stringify({',
    '  coordinator_id: acquired.coordinator_id,',
    '  generation: acquired.generation,',
    '  environment_sha256: acquired.environment_sha256,',
    '  environment: acquired.environment,',
    "  canonical: acquired.canonical_bytes.toString('utf8'),",
    '  endpoint: acquired.endpoint,',
    '})}\\n`);',
    '',
  ].join('\n'));
  return consumer;
}

function readLines(stream, count) {
  return new Promise((resolvePromise, reject) => {
    let text = '';
    const onData = (chunk) => {
      text += chunk.toString('utf8');
      const lines = text.split('\n');
      if (lines.length > count) {
        stream.off('data', onData);
        stream.off('error', reject);
        resolvePromise(lines.slice(0, count));
      }
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

async function startCoordinator(repo, env, mode = 'review') {
  const child = spawn(process.execPath, [
    coordinatorExecutablePath, '--cwd', repo, '--mode', mode,
  ], { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  liveCoordinators.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const exited = new Promise((resolvePromise) => child.once('exit', (code) => resolvePromise(code)));
  const lines = await Promise.race([
    readLines(child.stdout, 2),
    exited.then((code) => { throw new Error(`coordinator exited early (${code}): ${stderr}`); }),
  ]);
  return {
    child,
    exited,
    environment: JSON.parse(lines[0]),
    descriptor: JSON.parse(lines[1]),
  };
}

test('the shipped coordinator executable drains one frame from real process A and serves the complete environment to real process B', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX private-socket endpoints; the Windows named-pipe polarity is covered by the release smoke job');
    return;
  }
  const { resolveGrokContainmentPlatform } = await import(pathToFileURL(join(
    __dirname, '..', 'hooks', 'scripts', 'lib', 'grok-process-supervisor.mjs',
  )).href);
  const { defaultCoordinatorHelperExists } = await import(coordinatorLibUrl);
  const gate = resolveGrokContainmentPlatform();
  if (!gate.supported || !defaultCoordinatorHelperExists(gate.helper_path)) {
    t.skip('shipped coordinator CLI success path requires an inventoried executable helper');
    return;
  }
  const grok = makeGrokBin('coordinator-e2e-');
  const repo = createGitFixture('coordinator repo');
  writeFileSync(join(repo, 'candidate.md'), '# Candidate\n');
  const env = pathEnvironment(grok.bin);
  const {
    COORDINATOR_ENVIRONMENT_FIELDS,
    COORDINATOR_GROK_FIELDS,
    requestCoordinatorShutdown,
  } = await import(coordinatorLibUrl);

  const coordinator = await startCoordinator(repo, env);

  // Public stdout is the environment JSON; the private descriptor is a path,
  // never fd 1, and the canonical frame never appears on stdout.
  for (const field of [...COORDINATOR_ENVIRONMENT_FIELDS, ...COORDINATOR_GROK_FIELDS]) {
    assert.ok(Object.hasOwn(coordinator.environment, field), `stdout environment is missing ${field}`);
  }
  assert.equal(coordinator.environment.grok_compatibility_verified, true);
  assert.equal(typeof coordinator.descriptor.control_path, 'string');
  assert.notEqual(coordinator.descriptor.control_path, '1');
  assert.equal(coordinator.descriptor.mode, 'review');
  assert.match(coordinator.descriptor.environment_sha256, /^[a-f0-9]{64}$/u);

  // Exactly one frame was drained from real process A: the standalone detector
  // spawned exactly the two compatibility children and no consumer adds more.
  assert.deepEqual(grokChildren(grok.log), [['--version'], ['--help']]);

  const consumer = writeConsumer(fixtureRootFor(repo), 'process-b.mjs');
  const first = spawnSync(process.execPath, [
    consumer, coordinator.descriptor.control_path, 'classify-artifacts',
  ], { env, encoding: 'utf8', shell: false });
  assert.equal(first.status, 0, first.stderr);
  const acquired = JSON.parse(first.stdout);
  assert.equal(acquired.coordinator_id, coordinator.descriptor.coordinator_id);
  assert.equal(acquired.environment_sha256, coordinator.descriptor.environment_sha256);
  assert.deepEqual(acquired.environment, coordinator.environment);
  assert.equal(createHash('sha256').update(acquired.canonical).digest('hex'), acquired.environment_sha256);
  assert.equal(acquired.environment.grok_compatibility_evidence.version, '1.0.4');

  // A second consumer gets a FRESH readable endpoint, not the first one's.
  const second = spawnSync(process.execPath, [
    consumer, coordinator.descriptor.control_path, 'grok-bridge',
  ], { env, encoding: 'utf8', shell: false });
  assert.equal(second.status, 0, second.stderr);
  const reacquired = JSON.parse(second.stdout);
  assert.notEqual(reacquired.endpoint.path, acquired.endpoint.path, 'each consumer must get a fresh endpoint');
  assert.equal(reacquired.canonical, acquired.canonical, 'consumers must not reserialize the canonical buffer');
  assert.deepEqual(grokChildren(grok.log), [['--version'], ['--help']], 'consumers must re-detect nothing');

  const terminated = await requestCoordinatorShutdown({
    controlPath: coordinator.descriptor.control_path,
    coordinatorId: coordinator.descriptor.coordinator_id,
  });
  assert.equal(terminated.coordinator_id, coordinator.descriptor.coordinator_id);
  assert.equal(terminated.consumers_served, 2);
  assert.equal(await coordinator.exited, 0);
});

test('every control-protocol message is observed on the private control path', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX private-socket endpoints');
    return;
  }
  const { resolveGrokContainmentPlatform } = await import(pathToFileURL(join(
    __dirname, '..', 'hooks', 'scripts', 'lib', 'grok-process-supervisor.mjs',
  )).href);
  const { defaultCoordinatorHelperExists } = await import(coordinatorLibUrl);
  const gate = resolveGrokContainmentPlatform();
  if (!gate.supported || !defaultCoordinatorHelperExists(gate.helper_path)) {
    t.skip('shipped coordinator CLI success path requires an inventoried executable helper');
    return;
  }
  const grok = makeGrokBin('coordinator-protocol-');
  const repo = createGitFixture('coordinator protocol repo');
  const env = pathEnvironment(grok.bin);
  const { decodeControlFrames, encodeControlFrame } = await import(coordinatorLibUrl);
  const coordinator = await startCoordinator(repo, env, 'dry-run');

  const observed = [];
  const socket = net.connect(coordinator.descriptor.control_path);
  // Bounded on purpose. A coordinator that never handshakes would otherwise
  // leave this promise pending forever, and node:test has no default per-test
  // timeout — the run would read as a hang instead of the failure it is.
  await Promise.race([
    new Promise((_resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`control protocol stalled after: ${observed.map((m) => m.message).join(', ') || '(nothing)'}`)),
        5000,
      );
      timer.unref();
    }),
    new Promise((resolvePromise, reject) => {
      let rest = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        const decoded = decodeControlFrames(Buffer.concat([rest, chunk]));
        rest = decoded.rest;
        for (const message of decoded.messages) {
          observed.push(message);
          if (message.message === 'coordinator_ready') {
            socket.write(encodeControlFrame({ message: 'acquire_endpoint', consumer_id: 'probe' }));
          } else if (message.message === 'environment_endpoint') {
            socket.write(encodeControlFrame({
              message: 'shutdown', coordinator_id: coordinator.descriptor.coordinator_id,
            }));
          } else if (message.message === 'coordinator_terminated') {
            socket.end();
            resolvePromise();
          }
        }
      });
      socket.once('error', reject);
    }),
  ]);

  assert.deepEqual(observed.map((message) => message.message), [
    'coordinator_ready', 'environment_endpoint', 'coordinator_terminated',
  ]);
  const [ready, endpoint, terminated] = observed;
  assert.deepEqual(
    Object.keys(ready).sort(),
    ['coordinator_id', 'generation', 'message', 'pid'],
  );
  assert.equal(ready.pid, coordinator.descriptor.pid);
  assert.equal(endpoint.environment_sha256, coordinator.descriptor.environment_sha256);
  assert.equal(typeof endpoint.endpoint.path, 'string');
  assert.equal(terminated.consumers_served, 1);
  assert.equal(await coordinator.exited, 0);
});

test('a consumer that never sees coordinator_ready fails closed', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX private-socket endpoints');
    return;
  }
  const { acquireEnvironmentEndpoint, encodeControlFrame } = await import(coordinatorLibUrl);
  const root = makeTemporaryDirectory('coordinator-unconfirmed-');

  // Polarity 1 — an unconfirmed coordinator that pushes an endpoint anyway. The
  // consumer must refuse it on the handshake, not on the endpoint being absent:
  // the endpoint path below does not exist, so a consumer that skipped the
  // handshake check would fail with ENOENT instead.
  const forgedPath = join(root, 'forged.sock');
  const forged = net.createServer((socket) => {
    socket.write(encodeControlFrame({
      message: 'environment_endpoint',
      coordinator_id: 'forged',
      environment_sha256: 'f'.repeat(64),
      endpoint: { kind: 'private-stream', path: join(root, 'absent.sock'), generation: 1 },
    }));
  });
  await new Promise((resolvePromise) => forged.listen(forgedPath, resolvePromise));
  try {
    await assert.rejects(
      () => acquireEnvironmentEndpoint({ controlPath: forgedPath, consumerId: 'classify-artifacts', timeoutMs: 3000 }),
      /coordinator_ready/u,
    );
  } finally {
    await new Promise((resolvePromise) => forged.close(resolvePromise));
  }

  // Polarity 2 — a coordinator that never handshakes at all is unconfirmed too,
  // and the deadline must say so rather than reporting a generic timeout.
  const silentPath = join(root, 'silent.sock');
  const silent = net.createServer(() => { /* accepts and says nothing */ });
  await new Promise((resolvePromise) => silent.listen(silentPath, resolvePromise));
  try {
    await assert.rejects(
      () => acquireEnvironmentEndpoint({ controlPath: silentPath, consumerId: 'classify-artifacts', timeoutMs: 300 }),
      /coordinator_ready/u,
    );
  } finally {
    await new Promise((resolvePromise) => silent.close(resolvePromise));
  }
});

test('the coordinator drain fails closed across the negative frame matrix, with real process A', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX private-socket endpoints');
    return;
  }
  const { createGrokCarrierCoordinator } = await import(coordinatorLibUrl);
  const grok = makeGrokBin('coordinator-negative-');
  const repo = createGitFixture('coordinator negative repo');
  const env = pathEnvironment(grok.bin);
  const root = makeTemporaryDirectory('coordinator-producers-');

  // Each producer is a REAL spawned process standing in for process A: it emits
  // the same public environment JSON on stdout and a deliberately broken
  // private frame on the carrier descriptor.
  const good = spawnSync(process.execPath, [
    standaloneDetectorPath,
    '--cwd', repo, '--format', 'json', '--grok-candidate', '--grok-carrier-fd', '3',
  ], { env, encoding: null, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  assert.equal(good.status, 0, good.stderr.toString('utf8'));
  const goodEnvironment = good.stdout.toString('utf8').trim();
  const goodFrame = good.output[3];

  const producer = (name, body) => {
    const filePath = join(root, `${name}.mjs`);
    writeFileSync(filePath, [
      "import { writeSync } from 'node:fs';",
      `const environment = ${JSON.stringify(goodEnvironment)};`,
      `const frame = Buffer.from(${JSON.stringify(goodFrame.toString('base64'))}, 'base64');`,
      body,
      'process.stdout.write(`${environment}\\n`);',
      '',
    ].join('\n'));
    return filePath;
  };

  const matrix = [
    ['missing', producer('missing', '// writes no frame at all'), /carrier frame is missing/u],
    ['duplicate', producer('duplicate', 'writeSync(3, Buffer.concat([frame, frame]));'), /trailing bytes/u],
    ['trailing', producer('trailing', "writeSync(3, Buffer.concat([frame, Buffer.from('\\0')]));"), /trailing bytes/u],
    ['short', producer('short', 'writeSync(3, frame.subarray(0, frame.length - 8));'), /truncated/u],
    ['malformed', producer('malformed', 'const bad = Buffer.from(frame); bad.fill(0x7b, 4, 12); writeSync(3, bad);'), /UTF-8 JSON|carrier/u],
    ['over-limit', producer('overlimit', 'const head = Buffer.alloc(4); head.writeUInt32BE(65537, 0); writeSync(3, Buffer.concat([head, Buffer.alloc(70000)]));'), /maximum|exceed/u],
    ['stdio-substituted', producer('stdio', 'process.stdout.write(frame);'), /carrier frame is missing/u],
  ];

  for (const [label, detectorPath, expected] of matrix) {
    await assert.rejects(
      () => createGrokCarrierCoordinator({
        cwd: repo, mode: 'review', env, detectorPath, drainTimeoutMs: 5000,
        platform: 'linux', arch: 'x64', helperExists: () => true,
      }),
      expected,
      `${label} must fail closed`,
    );
  }

  // The read deadline is mandatory: a producer that holds the descriptor open
  // and never reaches EOF must not hang the coordinator.
  // A pending top-level await would let Node exit (and so close the descriptor);
  // a live timer is what actually holds the private channel open past EOF.
  const stalled = producer('stalled', 'writeSync(3, frame); setTimeout(() => {}, 60000);');
  await assert.rejects(
    () => createGrokCarrierCoordinator({
      cwd: repo, mode: 'review', env, detectorPath: stalled, drainTimeoutMs: 400,
      platform: 'linux', arch: 'x64', helperExists: () => true,
    }),
    /deadline/u,
  );

  // Identity: a frame that is not the carrier the public environment reports.
  const swapped = producer('swapped', [
    "const parsed = JSON.parse(frame.subarray(4).toString('utf8'));",
    "parsed.version_build = 'deadbeef';",
    "const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');",
    'const head = Buffer.alloc(4); head.writeUInt32BE(bytes.length, 0);',
    'writeSync(3, Buffer.concat([head, bytes]));',
  ].join('\n'));
  await assert.rejects(
    () => createGrokCarrierCoordinator({
      cwd: repo, mode: 'review', env, detectorPath: swapped, drainTimeoutMs: 5000,
      platform: 'linux', arch: 'x64', helperExists: () => true,
    }),
    /carrier|identity|evidence/u,
  );
});

test('the private descriptor is never fd 1/stdout and never a stdio substitute', async () => {
  const { assertPrivateEndpoint } = await import(coordinatorLibUrl);

  assert.doesNotThrow(() => assertPrivateEndpoint({
    kind: 'private-stream', path: '/tmp/x/e1.sock', generation: 1,
  }));
  for (const endpoint of [
    { kind: 'inherited-fd', fd: 0 },
    { kind: 'inherited-fd', fd: 1 },
    { kind: 'inherited-fd', fd: 2 },
    { kind: 'private-stream', path: '/dev/stdout', generation: 1 },
    { kind: 'private-stream', path: '/dev/stdin', generation: 1 },
    { kind: 'private-stream', path: '/dev/stderr', generation: 1 },
    { kind: 'private-stream', path: '/dev/fd/1', generation: 1 },
    { kind: 'private-stream', path: 'CONOUT$', generation: 1 },
  ]) {
    assert.throws(() => assertPrivateEndpoint(endpoint), /stdio|descriptor/iu, JSON.stringify(endpoint));
  }
});

test('the private descriptor check rejects every console/null device spelling, on any platform', async () => {
  const { assertPrivateEndpoint } = await import(coordinatorLibUrl);

  // The accepted control must survive every mutation below: a blanket refusal
  // must never make this assertion pass.
  assert.doesNotThrow(() => assertPrivateEndpoint({
    kind: 'private-stream', path: '/tmp/deep-review/carrier-1.sock', generation: 1,
  }));

  for (const path of [
    'CON',                 // bare Windows console device
    'con',                 // case-insensitive bare form
    'CON:',                // trailing DOS device suffix
    '\\\\.\\CON',          // Win32 device-namespace prefix
    '\\\\.\\CONOUT$',
    '\\\\.\\CONIN$',
    '\\\\?\\CON',          // alternate device-namespace prefix
    'NUL',                 // the null device
    'conout$',             // lowercase bare form (pre-existing coverage, kept)
    '/DEV/STDOUT',          // case-insensitive POSIX form (macOS APFS default)
  ]) {
    assert.throws(
      () => assertPrivateEndpoint({ kind: 'private-stream', path, generation: 1 }),
      /stdio|descriptor/iu,
      `expected ${JSON.stringify(path)} to be refused as a stdio/console/null substitute`,
    );
  }
});

test('every field of the complete environment payload is required, by name', async () => {
  const {
    COORDINATOR_ENVIRONMENT_FIELDS,
    COORDINATOR_GROK_FIELDS,
    validateCoordinatorEnvironment,
  } = await import(coordinatorLibUrl);

  assert.deepEqual([...COORDINATOR_ENVIRONMENT_FIELDS], [
    'runtime_host', 'plugin_root', 'node_available', 'node_path',
    'claude_cli', 'claude_cli_path', 'codex_plugin', 'codex_companion_path',
    'codex_cli', 'codex_cli_path', 'codex_installed', 'agy_cli', 'agy_cli_path',
    'agy_version', 'is_git', 'has_commits', 'change_state', 'staged', 'unstaged',
    'untracked', 'has_untracked', 'review_base', 'review_base_method', 'is_shallow',
  ]);
  assert.deepEqual([...COORDINATOR_GROK_FIELDS], [
    'grok_cli', 'grok_cli_path', 'grok_version',
    'grok_compatibility_verified', 'grok_compatibility_evidence',
  ]);

  const complete = completeEnvironmentFixture();
  assert.doesNotThrow(() => validateCoordinatorEnvironment(complete));

  for (const field of [...COORDINATOR_ENVIRONMENT_FIELDS, ...COORDINATOR_GROK_FIELDS]) {
    const dropped = { ...complete };
    delete dropped[field];
    assert.throws(
      () => validateCoordinatorEnvironment(dropped),
      new RegExp(field, 'u'),
      `dropping ${field} must be rejected by name`,
    );
  }
});

function completeEnvironmentFixture() {
  return {
    runtime_host: 'claude-code',
    plugin_root: '/plugin',
    node_available: true,
    node_path: '/node',
    claude_cli: false,
    claude_cli_path: '',
    codex_plugin: false,
    codex_companion_path: '',
    codex_cli: false,
    codex_cli_path: '',
    codex_installed: false,
    agy_cli: false,
    agy_cli_path: '',
    agy_version: '',
    is_git: true,
    has_commits: true,
    change_state: 'clean',
    staged: 0,
    unstaged: 0,
    untracked: 0,
    has_untracked: false,
    review_base: 'abc',
    review_base_method: 'merge-base',
    is_shallow: false,
    grok_cli: false,
    grok_cli_path: '',
    grok_version: '',
    grok_compatibility_verified: false,
    grok_compatibility_evidence: null,
  };
}

// A fake coordinator whose control protocol is well-formed but whose private
// endpoint serves bytes of the test's choosing. It is the only way to reach the
// consumer-side EOF/exactly-one-frame rules, which the producer-side drain
// cannot exercise.
async function fakeCoordinator(root, encodeControlFrame, id, sha256, endpointBytes) {
  const controlPath = join(root, `c-${id}.sock`);
  const endpointPath = join(root, `e-${id}.sock`);
  const endpointServer = net.createServer((socket) => socket.end(endpointBytes));
  await new Promise((resolvePromise) => endpointServer.listen(endpointPath, resolvePromise));
  const controlServer = net.createServer((socket) => {
    socket.write(encodeControlFrame({
      message: 'coordinator_ready', coordinator_id: 'fake-id', generation: 1, pid: process.pid,
    }));
    socket.on('data', () => {
      socket.write(encodeControlFrame({
        message: 'environment_endpoint',
        coordinator_id: 'fake-id',
        environment_sha256: sha256,
        endpoint: { kind: 'private-stream', path: endpointPath, generation: 1 },
      }));
    });
  });
  await new Promise((resolvePromise) => controlServer.listen(controlPath, resolvePromise));
  return {
    controlPath,
    close: async () => {
      await new Promise((resolvePromise) => endpointServer.close(resolvePromise));
      await new Promise((resolvePromise) => controlServer.close(resolvePromise));
    },
  };
}

test('a private endpoint serving anything but exactly one frame before EOF is refused', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX private-socket endpoints');
    return;
  }
  const {
    acquireEnvironmentEndpoint,
    canonicalEnvironmentBytes,
    encodeControlFrame,
  } = await import(coordinatorLibUrl);
  const root = makeTemporaryDirectory('coordinator-endpoint-frames-');
  const canonical = canonicalEnvironmentBytes(completeEnvironmentFixture());
  const sha = createHash('sha256').update(canonical).digest('hex');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(canonical.length, 0);
  const frame = Buffer.concat([head, canonical]);

  for (const [label, bytes, expected] of [
    ['duplicate', Buffer.concat([frame, frame]), /trailing bytes/u],
    ['trailing', Buffer.concat([frame, Buffer.from('\0')]), /trailing bytes/u],
    ['short', frame.subarray(0, frame.length - 8), /truncated/u],
    ['missing', Buffer.alloc(0), /carrier frame is missing/u],
  ]) {
    // The digest it advertises is the correct one: every polarity here must be
    // refused on the frame, before the identity check could excuse it.
    const fake = await fakeCoordinator(root, encodeControlFrame, label, sha, bytes);
    try {
      await assert.rejects(
        () => acquireEnvironmentEndpoint({
          controlPath: fake.controlPath, consumerId: 'classify-artifacts', timeoutMs: 3000,
        }),
        expected,
        `${label} must be refused before the payload is used`,
      );
    } finally {
      // Unconditional: a listening server left behind by a failed assertion
      // holds the whole runner open, which reads as a hang rather than a failure.
      await fake.close();
    }
  }
});

test('a stale environment_sha256 is rejected against the canonical bytes it claims', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX private-socket endpoints');
    return;
  }
  const {
    acquireEnvironmentEndpoint,
    canonicalEnvironmentBytes,
    encodeControlFrame,
  } = await import(coordinatorLibUrl);
  const root = makeTemporaryDirectory('coordinator-stale-');
  const controlPath = join(root, 'c.sock');
  const endpointPath = join(root, 'e.sock');
  const environment = completeEnvironmentFixture();
  const canonical = canonicalEnvironmentBytes(environment);
  // The environment changed under a retained identity: the coordinator answers
  // with the digest of a PRIOR environment.
  const staleSha = createHash('sha256')
    .update(canonicalEnvironmentBytes({ ...environment, change_state: 'unstaged' }))
    .digest('hex');

  const endpointServer = net.createServer((socket) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(canonical.length, 0);
    socket.end(Buffer.concat([head, canonical]));
  });
  await new Promise((resolvePromise) => endpointServer.listen(endpointPath, resolvePromise));
  const controlServer = net.createServer((socket) => {
    socket.write(encodeControlFrame({
      message: 'coordinator_ready', coordinator_id: 'stale-id', generation: 1, pid: process.pid,
    }));
    socket.on('data', () => {
      socket.write(encodeControlFrame({
        message: 'environment_endpoint',
        coordinator_id: 'stale-id',
        environment_sha256: staleSha,
        endpoint: { kind: 'private-stream', path: endpointPath, generation: 1 },
      }));
    });
  });
  await new Promise((resolvePromise) => controlServer.listen(controlPath, resolvePromise));

  try {
    await assert.rejects(
      () => acquireEnvironmentEndpoint({ controlPath, consumerId: 'classify-artifacts', timeoutMs: 3000 }),
      /environment_sha256/u,
    );
  } finally {
    await new Promise((resolvePromise) => endpointServer.close(resolvePromise));
    await new Promise((resolvePromise) => controlServer.close(resolvePromise));
  }
});

test('coordinator startup refuses unsupported platforms before spawning process A (T9)', async () => {
  const {
    createGrokCarrierCoordinator,
  } = await import(coordinatorLibUrl);
  const marker = join(makeTemporaryDirectory('t9-no-spawn-'), 'ran');
  const detectorPath = join(makeTemporaryDirectory('t9-detector-'), 'detector.mjs');
  writeFileSync(detectorPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  await assert.rejects(
    () => createGrokCarrierCoordinator({
      cwd: createGitFixture('t9 darwin'),
      mode: 'review',
      platform: 'darwin',
      arch: 'arm64',
      detectorPath,
    }),
    (error) => {
      assert.equal(error.containment_refusal.ok, false);
      assert.equal(error.containment_refusal.reason, 'unsupported_grok_containment');
      assert.equal(error.containment_refusal.platform, 'darwin');
      assert.equal(error.containment_refusal.arch, 'arm64');
      assert.equal(error.containment_refusal.mode, 'review');
      return true;
    },
  );
  assert.equal(existsSync(marker), false);
});

test('coordinator startup refuses missing, directory, symlink, and non-executable helpers (T9)', async () => {
  const {
    createGrokCarrierCoordinator,
    defaultCoordinatorHelperExists,
  } = await import(coordinatorLibUrl);
  const root = makeTemporaryDirectory('t9-helper-');
  const cases = [
    ['missing', join(root, 'absent-helper'), () => {}],
    ['directory', join(root, 'dir-helper'), (target) => mkdirSync(target)],
    ['symlink', join(root, 'link-helper'), (target) => {
      writeFileSync(join(root, 'real-helper'), '#!/bin/sh\n', { mode: 0o755 });
      symlinkSync(join(root, 'real-helper'), target);
    }],
    ['non-executable', join(root, 'plain-helper'), (target) => {
      writeFileSync(target, '#!/bin/sh\n', { mode: 0o644 });
    }],
  ];
  for (const [label, helperPath, setup] of cases) {
    setup(helperPath);
    if (label === 'non-executable' && process.platform === 'win32') {
      // NTFS does not surface a Unix execute bit; access(X_OK) succeeds for a
      // readable regular file. The product check stays lstat + X_OK.
      continue;
    }
    assert.equal(defaultCoordinatorHelperExists(helperPath), false, label);
    await assert.rejects(
      () => createGrokCarrierCoordinator({
        cwd: createGitFixture(`t9 ${label}`),
        mode: 'dry-run',
        platform: 'linux',
        arch: 'x64',
        helperExists: () => defaultCoordinatorHelperExists(helperPath),
        detectorPath: join(root, 'unused.mjs'),
      }),
      (error) => {
        assert.equal(error.containment_refusal.reason, 'missing_grok_containment_helper', label);
        assert.equal(error.containment_refusal.mechanism, 'pid-namespace', label);
        assert.match(error.containment_refusal.helper_path, /grok-linux-pidns-owner/u, label);
        return true;
      },
    );
    assert.equal(existsSync(join(root, 'unused.mjs')), false, `${label} must not spawn`);
  }

  await assert.rejects(
    () => createGrokCarrierCoordinator({
      cwd: createGitFixture('t9 aarch64'),
      mode: 'review',
      platform: 'linux',
      arch: 'arm64',
    }),
    (error) => error.containment_refusal.reason === 'unsupported_grok_containment',
  );
});

test('coordinator CLI prints containment_refusal JSON and exits 3 (T9)', async () => {
  const { runCoordinatorCli } = await import(pathToFileURL(coordinatorExecutablePath).href);
  const lines = [];
  let spawnCount = 0;
  await runCoordinatorCli(['--cwd', createGitFixture('t9 cli'), '--mode', 'review'], {
    createCoordinator: async () => {
      spawnCount += 1;
      const error = new Error('unsupported_grok_containment');
      error.containment_refusal = {
        ok: false,
        reason: 'unsupported_grok_containment',
        platform: 'darwin',
        arch: 'arm64',
        mechanism: null,
        helper_path: null,
        mode: 'review',
        remedy: 'inactive',
      };
      throw error;
    },
    stdout: { write: (chunk) => { lines.push(chunk); } },
    stderr: { write: () => { throw new Error('stderr must stay empty for containment refusal'); } },
  });
  assert.equal(spawnCount, 1);
  assert.equal(process.exitCode, 3);
  const parsed = JSON.parse(String(lines[0]).trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'unsupported_grok_containment');
  assert.equal(Object.hasOwn(parsed, 'ok'), true);
  process.exitCode = 0;
});

test('coordinator CLI usage errors stay exit 1 and do not look like containment refusal (T9)', async () => {
  const { runCoordinatorCli } = await import(pathToFileURL(coordinatorExecutablePath).href);
  const stderr = [];
  await runCoordinatorCli(['--cwd', createGitFixture('t9 usage')], {
    stdout: { write: () => { throw new Error('usage errors must not write stdout JSON'); } },
    stderr: { write: (chunk) => { stderr.push(chunk); } },
  });
  assert.equal(process.exitCode, 1);
  assert.match(stderr.join(''), /--mode/u);
  process.exitCode = 0;
});

test('in-process coordinator success stdout has two lines and no ok key (T9)', async () => {
  const { runCoordinatorCli } = await import(pathToFileURL(coordinatorExecutablePath).href);
  const lines = [];
  await runCoordinatorCli(['--cwd', createGitFixture('t9 success'), '--mode', 'review'], {
    createCoordinator: async () => ({
      environment: { grok_cli: true, grok_compatibility_verified: true },
      coordinator_id: 'coord-1',
      generation: 1,
      pid: 1,
      mode: 'review',
      control_path: '/tmp/c.sock',
      environment_sha256: 'a'.repeat(64),
      terminated: Promise.resolve(),
    }),
    stdout: { write: (chunk) => { lines.push(String(chunk)); } },
    stderr: { write: () => { throw new Error('success path must not write stderr'); } },
  });
  assert.equal(lines.length, 2);
  const environment = JSON.parse(lines[0]);
  const descriptor = JSON.parse(lines[1]);
  assert.equal(Object.hasOwn(environment, 'ok'), false);
  assert.equal(Object.hasOwn(descriptor, 'ok'), false);
  assert.equal(descriptor.coordinator_id, 'coord-1');
});

test('detectEnvironment reports unsupported_grok_cli_version without verifying (T10)', async () => {
  const { detectEnvironment } = await loadDetector();
  const grok = makeGrokBin('t10-version-');
  const grokFile = process.platform === 'win32' ? join(grok.root, 'grok-probe.js') : join(grok.bin, 'grok');
  writeFileSync(grokFile, readFileSync(grokFile, 'utf8').replaceAll('1.0.4', '1.0.13'));
  const env = pathEnvironment(grok.bin);
  const detected = await detectEnvironment({ cwd: createGitFixture('t10 version'), env, grokCandidate: true });
  assert.equal(detected.grok_cli, false);
  assert.equal(detected.grok_compatibility_verified, false);
  assert.equal(detected.grok_version, '1.0.13');
  assert.equal(detected.grok_unavailable_reason, 'unsupported_grok_cli_version');
  assert.deepEqual(detected.grok_supported_versions, ['1.0.4']);
});

test('missing carrier frame with closed-schema stdout becomes containment_refusal (T10)', async () => {
  const { createGrokCarrierCoordinator } = await import(coordinatorLibUrl);
  const root = makeTemporaryDirectory('t10-closed-');
  const detectorPath = join(root, 'closed-schema.mjs');
  const environment = {
    grok_cli: false,
    grok_compatibility_verified: false,
    grok_compatibility_evidence: null,
    grok_unavailable_reason: 'incompatible_grok_cli',
  };
  writeFileSync(detectorPath, [
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(environment)}\n`)});`,
    '',
  ].join('\n'));
  await assert.rejects(
    () => createGrokCarrierCoordinator({
      cwd: createGitFixture('t10 closed'),
      mode: 'review',
      detectorPath,
      platform: 'linux',
      arch: 'x64',
      helperExists: () => true,
      drainTimeoutMs: 5000,
    }),
    (error) => error.containment_refusal?.reason === 'incompatible_grok_cli',
  );

  const versionDetector = join(root, 'version-schema.mjs');
  writeFileSync(versionDetector, [
    `process.stdout.write(${JSON.stringify(`${JSON.stringify({
      ...environment,
      grok_unavailable_reason: 'unsupported_grok_cli_version',
      grok_version: '1.0.13',
      grok_supported_versions: ['1.0.4'],
    })}\n`)});`,
    '',
  ].join('\n'));
  await assert.rejects(
    () => createGrokCarrierCoordinator({
      cwd: createGitFixture('t10 version schema'),
      mode: 'review',
      detectorPath: versionDetector,
      platform: 'linux',
      arch: 'x64',
      helperExists: () => true,
      drainTimeoutMs: 5000,
    }),
    (error) => {
      assert.equal(error.containment_refusal.reason, 'unsupported_grok_cli_version');
      assert.equal(error.containment_refusal.grok_version, '1.0.13');
      return true;
    },
  );
});

test('closed-schema stdout with nonzero process A exit is not laundered (T10)', async () => {
  const { createGrokCarrierCoordinator } = await import(coordinatorLibUrl);
  const detectorPath = join(makeTemporaryDirectory('t10-nonzero-'), 'bad-exit.mjs');
  writeFileSync(detectorPath, [
    "process.stdout.write('{\"grok_cli\":false,\"grok_compatibility_verified\":false,\"grok_compatibility_evidence\":null,\"grok_unavailable_reason\":\"incompatible_grok_cli\"}\\n');",
    'process.exit(2);',
    '',
  ].join('\n'));
  await assert.rejects(
    () => createGrokCarrierCoordinator({
      cwd: createGitFixture('t10 nonzero'),
      mode: 'review',
      detectorPath,
      platform: 'linux',
      arch: 'x64',
      helperExists: () => true,
      drainTimeoutMs: 5000,
    }),
    (error) => !error.containment_refusal && /exited with code 2|carrier frame is missing/u.test(error.message),
  );
});

test('coordinator CLI rejects --platform as an unknown argument (T9)', async () => {
  const { parseArguments } = await import(pathToFileURL(coordinatorExecutablePath).href);
  assert.throws(
    () => parseArguments(['--cwd', '/tmp', '--mode', 'review', '--platform', 'linux']),
    /unknown argument: --platform/u,
  );
});
