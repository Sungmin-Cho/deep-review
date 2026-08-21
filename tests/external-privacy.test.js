import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  prepareAgyPrivacy,
  prepareExternalPrivacy,
  scanAgyPrivacy,
  scanExternalPrivacy,
} from '../hooks/scripts/lib/agy-privacy.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agyCliPath = join(pluginRoot, 'hooks', 'scripts', 'agy-privacy-preflight.mjs');
const SENSITIVE_PATTERNS_RELATIVE_PATH = 'hooks/scripts/lib/sensitive-patterns.list';

// Pinned to the commit this slice starts from, not HEAD, so the hard-gate
// replay-and-diff stays meaningful once this slice's own commit lands.
const BASELINE_COMMIT = '52c1f6b101b75568cd71f2c2889a59a409cdca07';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function workspace(label) {
  // The CLI entry-point self-check compares argv[1] to import.meta.url. Use the
  // native canonicalizer so macOS's /var alias and Windows short/long path
  // aliases resolve the same way as Node's main-module loader.
  return realpathSync.native(mkdtempSync(join(tmpdir(), `deep-review-${label}-`)));
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: pluginRoot, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function gitInit(repo) {
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
}

function repository(label, { withHits } = {}) {
  const repo = workspace(label);
  gitInit(repo);
  writeFileSync(join(repo, '.gitignore'), 'dist/\n.env\nsecret.env\n.deep-review/\n');
  writeFileSync(join(repo, 'tracked.txt'), 'v1');
  if (withHits) {
    writeFileSync(join(repo, '.env'), 'TOKEN=secret');
  }
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
  return repo;
}

function config(repo, entries = {}) {
  const dir = join(repo, '.deep-review');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.yaml');
  const lines = ['agy_enabled: true'];
  for (const [key, value] of Object.entries(entries)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('last_review: null', '');
  writeFileSync(path, lines.join('\n'));
  return path;
}

// ---------------------------------------------------------------------------
// RED clause 1: provider: 'agy' renders the historical domain string and
// config keys byte-for-byte.
// ---------------------------------------------------------------------------

test("provider: 'agy' renders the historical domain string and config keys byte-for-byte", async () => {
  const repo = repository('external-privacy-agy-domain', { withHits: true });
  const configPath = config(repo);

  const scanned = scanAgyPrivacy({ repo, pluginRoot });
  const viaExternal = scanExternalPrivacy({ provider: 'agy', repo, pluginRoot });
  assert.deepEqual(scanned, viaExternal);

  // Reproduce the historical domain-separation string independently (the
  // exact literal from agy-privacy.mjs before parameterization) and confirm
  // the fingerprint still matches it byte-for-byte.
  const patternsPath = join(pluginRoot, 'hooks', 'scripts', 'lib', 'sensitive-patterns.list');
  const patternVersion = createHash('sha256').update(readFileSync(patternsPath)).digest('hex');
  const hash = createHash('sha256');
  hash.update(`deep-review-agy-privacy-v1\0${patternVersion}\0`);
  const hitEntries = [...scanned.hits]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((hit) => ({ path: Buffer.from(hit), value: Buffer.from('sensitive') }));
  for (const entry of hitEntries) {
    // Matches fingerprint.mjs's framedEntry() exactly: length-prefixed path,
    // a NUL separator, length-prefixed value, then a trailing newline.
    hash.update(Buffer.concat([
      Buffer.from(String(entry.path.length)), Buffer.from(':'), entry.path, Buffer.from('\0'),
      Buffer.from(String(entry.value.length)), Buffer.from(':'), entry.value, Buffer.from('\n'),
    ]));
  }
  assert.equal(scanned.fingerprint, hash.digest('hex'));

  const prepared = await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'approve' });
  assert.equal(prepared.outcome, 'acknowledged');
  const persisted = readFileSync(configPath, 'utf8');
  assert.match(persisted, new RegExp(`^agy_sensitive_acked_fingerprint: "${prepared.fingerprint}"$`, 'mu'));
  assert.match(persisted, /^agy_sensitive_acked_at: "\d{4}-\d{2}-\d{2}T/mu);

  const viaExplicitProvider = await prepareExternalPrivacy({
    provider: 'agy', repo, pluginRoot, configPath, approval: 'auto',
  });
  assert.equal(viaExplicitProvider.outcome, 'acknowledged');
  assert.equal(viaExplicitProvider.fingerprint, prepared.fingerprint);
});

// ---------------------------------------------------------------------------
// RED clause 2: provider: 'grok' renders a distinct, non-colliding namespace.
// ---------------------------------------------------------------------------

test("provider: 'grok' renders a distinct, non-colliding namespace", async () => {
  const repo = repository('external-privacy-grok-namespace', { withHits: true });
  const configPath = config(repo);

  const agyScan = scanExternalPrivacy({ provider: 'agy', repo, pluginRoot });
  const grokScan = scanExternalPrivacy({ provider: 'grok', repo, pluginRoot });
  assert.deepEqual(agyScan.hits, grokScan.hits);
  assert.notEqual(agyScan.fingerprint, grokScan.fingerprint);

  const grokPrepared = await prepareExternalPrivacy({
    provider: 'grok', repo, pluginRoot, configPath, approval: 'approve',
  });
  assert.equal(grokPrepared.outcome, 'acknowledged');
  const persisted = readFileSync(configPath, 'utf8');
  assert.match(persisted, new RegExp(`^grok_sensitive_acked_fingerprint: "${grokPrepared.fingerprint}"$`, 'mu'));
  assert.match(persisted, /^grok_sensitive_acked_at: "\d{4}-\d{2}-\d{2}T/mu);
  // The agy keys must not appear at all — grok acknowledgment writes only
  // its own namespace.
  assert.doesNotMatch(persisted, /^agy_sensitive_acked_fingerprint:/mu);

  // Non-collision: agy's stored acknowledgment must not satisfy grok's gate,
  // and vice versa, even though both scan the same tree.
  const preAgyAcked = config(repo, { agy_sensitive_acked_fingerprint: grokPrepared.fingerprint, agy_sensitive_acked_at: '2026-01-01T00:00:00Z' });
  const agyStillNeedsApproval = await prepareExternalPrivacy({
    provider: 'agy', repo, pluginRoot, configPath: preAgyAcked, approval: 'auto',
  });
  assert.equal(agyStillNeedsApproval.outcome, 'needs_approval');

  const preGrokAcked = config(repo, { grok_sensitive_acked_fingerprint: agyScan.fingerprint, grok_sensitive_acked_at: '2026-01-01T00:00:00Z' });
  const grokStillNeedsApproval = await prepareExternalPrivacy({
    provider: 'grok', repo, pluginRoot, configPath: preGrokAcked, approval: 'auto',
  });
  assert.equal(grokStillNeedsApproval.outcome, 'needs_approval');

  assert.throws(() => scanExternalPrivacy({ provider: 'unknown-provider', repo, pluginRoot }), /provider/u);
});

// ---------------------------------------------------------------------------
// Hard gate: agy-privacy-preflight.mjs's CLI output is unchanged for every
// existing input, replayed against the pinned pre-slice commit rather than
// asserted.
// ---------------------------------------------------------------------------

function matchCheckoutLineEndings(bytes, checkoutBytes) {
  const baselineText = bytes.toString('utf8');
  const checkoutText = checkoutBytes.toString('utf8');
  assert.deepEqual(Buffer.from(baselineText, 'utf8'), bytes, 'baseline patterns must be UTF-8');
  assert.deepEqual(Buffer.from(checkoutText, 'utf8'), checkoutBytes, 'checkout patterns must be UTF-8');

  const checkoutHasCrlf = checkoutText.includes('\r\n');
  const checkoutWithoutCrlf = checkoutText.replaceAll('\r\n', '');
  assert.equal(
    checkoutHasCrlf && checkoutWithoutCrlf.includes('\n'),
    false,
    'checkout patterns must not mix LF and CRLF',
  );
  assert.equal(checkoutWithoutCrlf.includes('\r'), false, 'checkout patterns must not contain bare CR');
  assert.equal(
    baselineText.replaceAll('\r\n', '').includes('\r'),
    false,
    'baseline patterns must not contain bare CR',
  );

  const normalized = baselineText.replaceAll('\r\n', '\n');
  return Buffer.from(checkoutHasCrlf ? normalized.replaceAll('\n', '\r\n') : normalized, 'utf8');
}

function extractBaseline(commit, checkoutRoot = pluginRoot) {
  const dest = workspace('external-privacy-baseline');
  const list = spawnSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'hooks/scripts'], {
    cwd: pluginRoot, encoding: 'utf8',
  });
  assert.equal(list.status, 0, list.stderr);
  const paths = list.stdout.trim().split('\n').filter(Boolean);
  assert.ok(paths.includes('hooks/scripts/agy-privacy-preflight.mjs'));
  assert.ok(paths.includes('hooks/scripts/lib/agy-privacy.mjs'));
  for (const relPath of paths) {
    const show = spawnSync('git', ['show', `${commit}:${relPath}`], { cwd: pluginRoot, encoding: null });
    assert.equal(show.status, 0, show.stderr && show.stderr.toString());
    const destPath = join(dest, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    const bytes = relPath === SENSITIVE_PATTERNS_RELATIVE_PATH
      ? matchCheckoutLineEndings(
        show.stdout,
        readFileSync(join(checkoutRoot, SENSITIVE_PATTERNS_RELATIVE_PATH)),
      )
      : show.stdout;
    writeFileSync(destPath, bytes);
  }
  return dest;
}

function extractCurrentScripts() {
  const dest = workspace('external-privacy-current');
  const paths = git(['ls-files', 'hooks/scripts']).trim().split('\n').filter(Boolean);
  assert.ok(paths.includes(SENSITIVE_PATTERNS_RELATIVE_PATH));
  for (const relPath of paths) {
    const sourcePath = join(pluginRoot, relPath);
    const destPath = join(dest, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, readFileSync(sourcePath));
  }
  return dest;
}

function runCli(cliPath, cliPluginRoot, repo, configPath, approval) {
  const canonicalCliPath = realpathSync.native(cliPath);
  const result = spawnSync(process.execPath, [
    canonicalCliPath,
    '--repo', repo,
    '--plugin-root', cliPluginRoot,
    '--config', configPath,
    '--approval', approval,
  ], { encoding: 'utf8', shell: false });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('the pinned CLI replay invokes the canonical target when its entry path is an alias', (t) => {
  const baselineRoot = extractBaseline(BASELINE_COMMIT);
  const aliasRoot = workspace('external-privacy-alias');
  const alias = join(aliasRoot, 'plugin-link');
  try {
    symlinkSync(baselineRoot, alias, 'dir');
  } catch (error) {
    t.skip(`directory aliases unavailable: ${error.code || error.message}`);
    return;
  }
  const repo = repository('external-privacy-alias-repo');
  const configPath = config(repo);
  const result = runCli(
    join(alias, 'hooks', 'scripts', 'agy-privacy-preflight.mjs'),
    baselineRoot,
    repo,
    configPath,
    'auto',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"outcome":"auto_ack"/u);
});

test('the pinned CLI replay compares a CRLF checkout against like-for-like pattern bytes', () => {
  const currentRoot = extractCurrentScripts();
  const currentPatternsPath = join(currentRoot, SENSITIVE_PATTERNS_RELATIVE_PATH);
  const originalPatterns = readFileSync(currentPatternsPath);
  const originalPatternsDigest = sha256(originalPatterns);
  const crlfPatterns = Buffer.from(
    originalPatterns.toString('utf8').replace(/\r?\n/gu, '\r\n'),
    'utf8',
  );
  assert.equal(crlfPatterns.includes(Buffer.from('\r\n')), true);

  try {
    writeFileSync(currentPatternsPath, crlfPatterns);
    const baselineRoot = extractBaseline(BASELINE_COMMIT, currentRoot);
    const baselineCliPath = join(baselineRoot, 'hooks', 'scripts', 'agy-privacy-preflight.mjs');
    const currentCliPath = join(currentRoot, 'hooks', 'scripts', 'agy-privacy-preflight.mjs');
    const repo = repository('external-privacy-crlf-replay', { withHits: true });
    const configPath = config(repo);

    const before = runCli(baselineCliPath, baselineRoot, repo, configPath, 'auto');
    const after = runCli(currentCliPath, currentRoot, repo, configPath, 'auto');

    assert.deepEqual(after, before, 'CRLF checkout must replay the complete CLI result byte-for-byte');
  } finally {
    writeFileSync(currentPatternsPath, originalPatterns);
    assert.equal(
      sha256(readFileSync(currentPatternsPath)),
      originalPatternsDigest,
      'CRLF simulation must restore the current mirror byte-for-byte',
    );
  }
});

function buildMatrixCases() {
  // Five repo/config shapes crossed with the three --approval values, per
  // the slice's required coverage: hits vs no hits, missing config, a
  // pre-set matching acknowledgment fingerprint, and a malformed config.
  const cases = [];
  const noHitsRepo = repository('matrix-no-hits');
  const noHitsFingerprint = scanAgyPrivacy({ repo: noHitsRepo, pluginRoot }).fingerprint;
  const withHitsRepo = repository('matrix-with-hits', { withHits: true });
  const withHitsFingerprint = scanAgyPrivacy({ repo: withHitsRepo, pluginRoot }).fingerprint;

  const shapes = [
    {
      name: 'no-hits-missing-config',
      repo: noHitsRepo,
      configPath: join(noHitsRepo, '.deep-review', 'config.yaml'),
      makeConfig: false,
    },
    {
      name: 'no-hits-preset-config',
      repo: noHitsRepo,
      makeConfig: () => config(noHitsRepo, {
        agy_sensitive_acked_fingerprint: noHitsFingerprint,
        agy_sensitive_acked_at: '2026-01-01T00:00:00Z',
      }),
    },
    {
      name: 'with-hits-missing-config',
      repo: withHitsRepo,
      configPath: join(withHitsRepo, '.deep-review', 'config.yaml'),
      makeConfig: false,
    },
    {
      name: 'with-hits-preset-fingerprint',
      repo: withHitsRepo,
      makeConfig: () => config(withHitsRepo, {
        agy_sensitive_acked_fingerprint: withHitsFingerprint,
        agy_sensitive_acked_at: '2026-01-01T00:00:00Z',
      }),
    },
    {
      name: 'with-hits-malformed-config',
      repo: withHitsRepo,
      makeConfig: () => {
        const dir = join(withHitsRepo, '.deep-review');
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'config.yaml');
        // An unterminated double-quoted scalar: the config parser throws on
        // this rather than silently skipping it, exercising the error path.
        writeFileSync(path, 'agy_enabled: true\nagy_sensitive_acked_fingerprint: "unterminated\nlast_review: null\n');
        return path;
      },
    },
  ];

  for (const shape of shapes) {
    for (const approval of ['auto', 'approve', 'decline']) {
      cases.push({ shape, approval });
    }
  }
  return cases;
}

test("agy-privacy-preflight.mjs CLI output is unchanged for every existing input (hard gate replay-and-diff)", () => {
  const baselineRoot = extractBaseline(BASELINE_COMMIT);
  const baselineCliPath = join(baselineRoot, 'hooks', 'scripts', 'agy-privacy-preflight.mjs');

  const matrix = buildMatrixCases();
  const differences = [];

  for (const { shape, approval } of matrix) {
    const key = `${shape.name}::${approval}`;
    // Fresh, independent config for each run so before/after don't observe
    // each other's ack-file mutation, and so re-running a later matrix
    // entry starts from the same pre-run state on both sides.
    const beforeConfigPath = shape.makeConfig
      ? shape.makeConfig()
      : (mkdirSync(join(shape.repo, '.deep-review'), { recursive: true }), shape.configPath);
    const beforeConfigBytes = tryRead(beforeConfigPath);

    const before = runCli(baselineCliPath, baselineRoot, shape.repo, beforeConfigPath, approval);
    restoreConfig(beforeConfigPath, beforeConfigBytes);

    const after = runCli(agyCliPath, pluginRoot, shape.repo, beforeConfigPath, approval);
    restoreConfig(beforeConfigPath, beforeConfigBytes);

    if (before.status !== after.status || before.stdout !== after.stdout || before.stderr !== after.stderr) {
      differences.push({
        key, before, after,
      });
    }
  }

  assert.deepEqual(differences, [], `agy CLI output diverged for: ${differences.map((d) => d.key).join(', ')}`);

  // Positive controls: prove the exact stdout comparison still observes both
  // a changed existing field and an added field. Each mutation is restored
  // byte-for-byte and digest-checked before the next one runs.
  const originalCli = readFileSync(baselineCliPath);
  const originalCliDigest = sha256(originalCli);
  const originalCliText = originalCli.toString('utf8');
  const resultAnchor = 'const result = await prepareAgyPrivacy(options);';
  assert.equal(originalCliText.split(resultAnchor).length, 2, 'preflight result anchor must be unique');
  const controlRepo = repository('external-privacy-output-controls', { withHits: true });
  const controlConfigPath = config(controlRepo);

  const controls = [
    {
      name: 'different outcome',
      replacement: "const result = { ...(await prepareAgyPrivacy(options)), outcome: 'mutated_outcome' };",
      observe: (value) => assert.equal(value.outcome, 'mutated_outcome'),
    },
    {
      name: 'extra field',
      replacement: 'const result = { ...(await prepareAgyPrivacy(options)), replay_extra_field: true };',
      observe: (value) => assert.equal(value.replay_extra_field, true),
    },
  ];

  for (const control of controls) {
    const mutatedCli = Buffer.from(originalCliText.replace(resultAnchor, control.replacement), 'utf8');
    assert.notEqual(sha256(mutatedCli), originalCliDigest, `${control.name} must change the preflight bytes`);
    try {
      writeFileSync(baselineCliPath, mutatedCli);
      const controlBefore = runCli(
        baselineCliPath, baselineRoot, controlRepo, controlConfigPath, 'auto',
      );
      const controlAfter = runCli(
        agyCliPath, pluginRoot, controlRepo, controlConfigPath, 'auto',
      );
      assert.equal(controlBefore.status, 0, controlBefore.stderr);
      control.observe(JSON.parse(controlBefore.stdout));
      assert.notEqual(
        controlBefore.stdout,
        controlAfter.stdout,
        `${control.name} positive control must be visible to the full stdout diff`,
      );
    } finally {
      writeFileSync(baselineCliPath, originalCli);
      assert.equal(
        sha256(readFileSync(baselineCliPath)),
        originalCliDigest,
        `${control.name} mutation must restore the baseline preflight byte-for-byte`,
      );
    }
  }
});

test('a pre-existing agy_sensitive_acked_fingerprint computed before this slice still validates after it', async () => {
  const repo = repository('external-privacy-preexisting-fingerprint', { withHits: true });
  const baselineRoot = extractBaseline(BASELINE_COMMIT);
  const baselineCliPath = join(baselineRoot, 'hooks', 'scripts', 'agy-privacy-preflight.mjs');

  const configPath = config(repo);
  const before = runCli(baselineCliPath, baselineRoot, repo, configPath, 'approve');
  assert.equal(before.status, 0, before.stderr);
  const storedFingerprint = readFileSync(configPath, 'utf8').match(/^agy_sensitive_acked_fingerprint: "([0-9a-f]+)"$/mu)[1];

  const after = await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'auto' });
  assert.equal(after.outcome, 'acknowledged');
  assert.equal(after.fingerprint, storedFingerprint);
});

function tryRead(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function restoreConfig(path, bytes) {
  if (bytes === null) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, bytes);
}
