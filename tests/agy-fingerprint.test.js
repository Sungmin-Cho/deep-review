import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { captureFingerprint, __testing as fingerprintTesting } from '../hooks/scripts/lib/fingerprint.mjs';
import { prepareAgyPrivacy, scanAgyPrivacy } from '../hooks/scripts/lib/agy-privacy.mjs';
import * as processRuntime from '../hooks/scripts/lib/process.mjs';
import {
  ensureCutover,
  __testing as mutationTesting,
} from '../hooks/scripts/mutation-protocol.mjs';
import {
  __testing as agyTesting,
  normalizeAgyReport,
  parseCli as parseAgyCli,
  runAgyReviewer,
} from '../hooks/scripts/run-agy-reviewer.mjs';
import { parseReviewerReport } from '../hooks/scripts/review-synthesis.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const privacyCliPath = join(pluginRoot, 'hooks', 'scripts', 'agy-privacy-preflight.mjs');
const agyCliPath = join(pluginRoot, 'hooks', 'scripts', 'run-agy-reviewer.mjs');

function workspace(label) {
  return mkdtempSync(join(tmpdir(), `deep-review-${label}-`));
}

function git(repo, args) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(label = 'repo') {
  const repo = workspace(label);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, '.gitignore'), 'dist/\n.env\nsecret.env\n.deep-review/\n');
  writeFileSync(join(repo, 'tracked.txt'), 'v1');
  git(repo, ['add', '.gitignore', 'tracked.txt']);
  git(repo, ['commit', '-qm', 'initial']);
  return repo;
}

function fakeAgy(root) {
  const script = join(root, 'agy.mjs');
  writeFileSync(script, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const row = { argv: process.argv.slice(2), cwd: process.cwd() };
appendFileSync(process.env.FAKE_LOG, JSON.stringify(row) + '\\n');
if (process.env.FAKE_MUTATE) writeFileSync(process.env.FAKE_MUTATE, 'mutated');
if (process.env.FAKE_BEHAVIOR === 'auth') { process.stderr.write('Authentication failed\\n'); process.exit(7); }
if (process.env.FAKE_BEHAVIOR === 'timeout') setInterval(() => {}, 1000);
if (process.env.FAKE_BEHAVIOR === 'failed') { process.stderr.write('ordinary failure\\n'); process.exit(9); }
if (process.env.FAKE_BEHAVIOR === 'unsupported' && process.argv.includes('--model')) {
  process.stderr.write('unsupported model value\\n'); process.exit(2);
}
process.stdout.write('# Deep Review Report — 2026-07-24\\n\\n## Summary\\n\\n- **Verdict**: APPROVE\\n- **Review Mode**: 1-way (agy only)\\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\\n\\n## Code Review\\n\\n### 🔴 Critical\\n\\nNone.\\n\\n### 🟡 Warning\\n\\nNone.\\n\\n### ℹ️ Info\\n\\nNone.\\n\\n### 🟢 Passed\\n\\n- Contract valid.\\n');
`, { mode: 0o700 });
  chmodSync(script, 0o700);
  if (process.platform !== 'win32') return script;
  const wrapper = join(root, 'agy.cmd');
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  writeFileSync(join(root, 'agy.ps1'), `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}' @args\r\nexit $LASTEXITCODE\r\n`);
  return wrapper;
}

function rows(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function config(repo, fingerprint = '', at = '') {
  const dir = join(repo, '.deep-review');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.yaml');
  writeFileSync(path, [
    'agy_enabled: true',
    `agy_sensitive_acked_fingerprint: ${JSON.stringify(fingerprint)}`,
    `agy_sensitive_acked_at: ${JSON.stringify(at)}`,
    'last_review: null',
    '',
  ].join('\n'));
  return path;
}

test('agy CLI accepts exactly one execution source paired with reviewer-id', () => {
  assert.deepEqual(
    parseAgyCli(['--routing-plan', 'routing.json', '--reviewer-id', 'agy']),
    { routingPlan: 'routing.json', reviewerId: 'agy' },
  );
  assert.deepEqual(
    parseAgyCli(['--execution-route-json', '{"reviewer_id":"agy"}', '--reviewer-id', 'agy']),
    { executionRouteJson: '{"reviewer_id":"agy"}', reviewerId: 'agy' },
  );
  for (const argv of [
    ['--routing-plan', 'routing.json'],
    ['--execution-route-json', '{}'],
    ['--reviewer-id', 'agy'],
    ['--routing-plan', 'routing.json', '--execution-route-json', '{}', '--reviewer-id', 'agy'],
  ]) {
    assert.throws(() => parseAgyCli(argv), /exactly one execution source.*reviewer-id/u);
  }
});

test('agy CLI rejects present-but-empty execution source and reviewer values', () => {
  for (const argv of [
    ['--reviewer-id', ''],
    ['--routing-plan', ''],
    ['--execution-route-json', ''],
    ['--routing-plan', '', '--reviewer-id', ''],
    ['--execution-route-json', '', '--reviewer-id', ''],
    ['--routing-plan', '', '--reviewer-id', 'agy'],
    ['--routing-plan', 'routing.json', '--reviewer-id', ''],
    ['--execution-route-json', '', '--reviewer-id', 'agy'],
    ['--execution-route-json', '{}', '--reviewer-id', ''],
    ['--routing-plan', '', '--execution-route-json', '{}', '--reviewer-id', 'agy'],
    ['--routing-plan', 'routing.json', '--execution-route-json', '', '--reviewer-id', 'agy'],
  ]) {
    assert.throws(() => parseAgyCli(argv), /non-empty|exactly one execution source/u);
  }
});

test('agy inline fallback authority rejects malformed values before spawn and gates unsupported-model retry', () => {
  const repo = repository('agy-inline-fallback-authority');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const binary = fakeAgy(repo);
  writeFileSync(promptFile, 'review this change');
  const routeFor = (allowed) => ({
    protocol_version: '3.0', reviewer_id: 'agy', provider: 'agy', adapter_id: 'agy-cli',
    assignment_role: 'standard', rubric_id: 'standard-v1', wave: 1, required: true,
    selection_reason: 'bridge fallback authority test',
    requested: { model: 'future-model', effort: null, source: 'cli-reviewer' },
    resolved: { model: 'future-model', effort: null },
    fallback: { allowed, occurred: false },
    artifact_phase: 'implementation', risk: 'medium', document_review_mode: 'full-readiness',
  });
  const invoke = (label, allowed) => {
    const outputFile = join(repo, `${label}.txt`);
    const log = join(workspace(`agy-inline-${label}-log`), 'argv.jsonl');
    const result = spawnSync(process.execPath, [
      agyCliPath,
      '--binary', binary,
      '--project-root', repo,
      '--plugin-root', pluginRoot,
      '--config', configPath,
      '--prompt-file', promptFile,
      '--output', outputFile,
      '--mode', 'off',
      '--execution-route-json', JSON.stringify(routeFor(allowed)),
      '--reviewer-id', 'agy',
      '--timeout-seconds', '5',
    ], {
      encoding: 'utf8', shell: false,
      env: { ...process.env, FAKE_LOG: log, FAKE_BEHAVIOR: 'unsupported' },
    });
    return { result, calls: rows(log) };
  };

  const malformed = invoke('malformed', 'false');
  assert.equal(malformed.result.status, 2, malformed.result.stderr);
  assert.equal(malformed.calls.length, 0);

  const denied = invoke('denied', false);
  assert.equal(denied.result.status, 2, denied.result.stderr);
  assert.equal(denied.calls.length, 1);

  const authorized = invoke('authorized', true);
  assert.equal(authorized.result.status, 0, authorized.result.stderr);
  assert.equal(authorized.calls.length, 2);
});

test('agy report normalization accepts only canonical reports with section/count consistency', () => {
  const clean = normalizeAgyReport([
    '# Deep Review Report — 2026-07-24',
    '',
    '## Summary',
    '- **Verdict**: APPROVE',
    '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건',
    '',
    '## Code Review',
    '### 🔴 Critical',
    'None.',
    '### 🟡 Warning',
    'None.',
    '### ℹ️ Info',
    'None.',
    '### 🟢 Passed',
    '- Security assignment cleared.',
  ].join('\n'));
  assert.equal(clean.includes('**Verdict**: APPROVE'), true);
  const localizedEmptySections = normalizeAgyReport(clean.replaceAll('None.', '(없음)'));
  assert.equal(localizedEmptySections, clean);
  assert.notEqual(parseReviewerReport(localizedEmptySections, { strict: true }), null);

  const missingContainer = [
    '# Deep Review Report — 2026-07-24',
    '',
    '## Summary',
    '- **Verdict**: APPROVE',
    '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건',
    '',
    '### 🔴 Critical',
    'None.',
    '### 🟡 Warning',
    'None.',
    '### ℹ️ Info',
    'None.',
    '### 🟢 Passed',
    '- Security assignment cleared.',
  ].join('\n');
  const admittedMissing = normalizeAgyReport(missingContainer);
  assert.equal(admittedMissing, missingContainer);
  assert.deepEqual(
    parseReviewerReport(admittedMissing, { strict: true }).tolerances,
    ['missing_code_review_heading'],
  );

  const findingReport = [
    '# Deep Review Report — 2026-07-24',
    '',
    '## Summary',
    '- **Verdict**: REQUEST_CHANGES',
    '- **Issues**: 🔴 1건, 🟡 1건, ℹ️ 0건',
    '',
    '## Code Review',
    '### 🔴 Critical',
    '#### C1. reachable authorization bypass',
    'Evidence and remediation.',
    '### 🟡 Warning',
    '- Missing regression coverage.',
    '### ℹ️ Info',
    'None.',
  ].join('\n');
  assert.equal(normalizeAgyReport(findingReport), null);

  const strictFindingReport = [
    '# Deep Review Report — 2026-07-24',
    '',
    '## Summary',
    '- **Verdict**: REQUEST_CHANGES',
    '- **Issues**: 🔴 1건, 🟡 1건, ℹ️ 0건',
    '',
    '## Code Review',
    '### 🔴 Critical',
    '- C1. reachable authorization bypass with literal (없음) evidence.',
    '### 🟡 Warning',
    '- Missing regression coverage.',
    '### ℹ️ Info',
    'None.',
    '### 🟢 Passed',
    '- Remaining contract checks passed.',
  ].join('\n');
  const findingWithLocalizedEmptySection = strictFindingReport.replace('None.', '(없음)');
  const normalizedFindingWithLocalizedEmptySection = normalizeAgyReport(findingWithLocalizedEmptySection);
  assert.equal(normalizedFindingWithLocalizedEmptySection, strictFindingReport);
  assert.match(normalizedFindingWithLocalizedEmptySection, /literal \(없음\) evidence/u);
  assert.notEqual(parseReviewerReport(normalizedFindingWithLocalizedEmptySection, { strict: true }), null);

  const contradictory = [
    '# Deep Review Report — 2026-07-24',
    '',
    '## Summary',
    '- **Verdict**: APPROVE',
    '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건',
    '## Code Review',
    '### 🔴 Critical',
    '#### C1. hidden blocker',
    '### 🟡 Warning',
    'None.',
    '### ℹ️ Info',
    'None.',
  ].join('\n');
  assert.equal(normalizeAgyReport(contradictory), null);
  assert.equal(normalizeAgyReport(clean.replace('ℹ️ Info', 'Info')), null);
  assert.equal(normalizeAgyReport(clean.replace('🟡 0건', '🟡 1건')), null);
  assert.equal(normalizeAgyReport('# Deep Review v2.0 — Security Review Report\n**Verdict**: **PASS**'), null);
  assert.equal(normalizeAgyReport('agy review ok'), null);
});

test('agy bridge cannot publish success for a report rejected by strict synthesis', async () => {
  const repo = repository('agy-strict-report');
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'review.txt');
  writeFileSync(promptFile, 'review this change');
  const nonStrictReport = [
    '# Deep Review Report — 2026-07-24',
    '',
    '## Summary',
    '- **Verdict**: REQUEST_CHANGES',
    '- **Issues**: 🔴 1건, 🟡 0건, ℹ️ 0건',
    '',
    '## Code Review',
    '### 🔴 Critical',
    '#### C1. subheading finding is not strict',
    'Evidence and remediation.',
    '### 🟡 Warning',
    'None.',
    '### ℹ️ Info',
    'None.',
    '### 🟢 Passed',
    '- Remaining checks passed.',
  ].join('\n');
  const result = await runAgyReviewer({
    binary: '/fake/agy', projectRoot: repo, pluginRoot, promptFile, outputFile,
    mode: 'off', timeoutSeconds: 5,
    privacyPreparer: async () => ({ outcome: 'auto_ack', fingerprint: 'same' }),
    fingerprintCapturer: async () => ({ mode: 'off', digest: null, error: null }),
    processRunner: async () => ({
      code: 0, timedOut: false, stdout: Buffer.from(nonStrictReport), stderr: Buffer.alloc(0),
    }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(readFileSync(`${outputFile}.status`, 'utf8'), 'failed\n');
});

test('fingerprint modes detect tracked, untracked, HEAD, sensitive ignored, and runtime-state drift', async () => {
  const repo = repository('fingerprint');
  const before = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  writeFileSync(join(repo, 'tracked.txt'), 'v2');
  const tracked = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.notEqual(tracked.digest, before.digest);

  writeFileSync(join(repo, 'new.txt'), 'new');
  const untracked = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.notEqual(untracked.digest, tracked.digest);

  writeFileSync(join(repo, '.env'), 'TOKEN=one');
  const sensitive = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  writeFileSync(join(repo, '.env'), 'TOKEN=two');
  const sensitiveChanged = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.notEqual(sensitiveChanged.digest, sensitive.digest);

  config(repo);
  const runtime = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  writeFileSync(join(repo, '.deep-review', 'config.yaml'), 'agy_enabled: false\n');
  const runtimeChanged = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.notEqual(runtimeChanged.digest, runtime.digest);

  writeFileSync(join(repo, 'tracked.txt'), 'committed');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-qm', 'head drift']);
  const movedHead = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.notEqual(movedHead.digest, runtimeChanged.digest);

  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, 'dist', 'ordinary.js'), 'one');
  const ignoredOrdinary = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  writeFileSync(join(repo, 'dist', 'ordinary.js'), 'two');
  const ignoredOrdinaryChanged = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.equal(ignoredOrdinaryChanged.digest, ignoredOrdinary.digest);

  const gitStatus = await captureFingerprint({ repo, pluginRoot, mode: 'git-status' });
  writeFileSync(join(repo, '.env'), 'TOKEN=three');
  const gitStatusAfter = await captureFingerprint({ repo, pluginRoot, mode: 'git-status' });
  assert.equal(gitStatusAfter.digest, gitStatus.digest);
  const off = await captureFingerprint({ repo, pluginRoot, mode: 'off' });
  assert.equal(off.digest, null);
});

test('hybrid detects rewrites of already-dirty paths and ignores review report churn', async () => {
  const repo = repository('dirty-rewrite');
  writeFileSync(join(repo, 'tracked.txt'), 'dirty one');
  const dirtyOne = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  writeFileSync(join(repo, 'tracked.txt'), 'dirty two');
  const dirtyTwo = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.notEqual(dirtyTwo.digest, dirtyOne.digest);

  writeFileSync(join(repo, 'new.txt'), 'untracked one');
  const untrackedOne = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  writeFileSync(join(repo, 'new.txt'), 'untracked two');
  const untrackedTwo = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.notEqual(untrackedTwo.digest, untrackedOne.digest);

  mkdirSync(join(repo, '.deep-review', 'reports'), { recursive: true });
  writeFileSync(join(repo, '.deep-review', 'reports', 'review.md'), 'one');
  const reportOne = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  writeFileSync(join(repo, '.deep-review', 'reports', 'review.md'), 'two');
  const reportTwo = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.equal(reportTwo.digest, reportOne.digest);
  const fullReportOne = await captureFingerprint({ repo, pluginRoot, mode: 'full-walk' });
  writeFileSync(join(repo, '.deep-review', 'reports', 'review.md'), 'three');
  const fullReportTwo = await captureFingerprint({ repo, pluginRoot, mode: 'full-walk' });
  assert.notEqual(fullReportTwo.digest, fullReportOne.digest);
});

test('hybrid degrades missing or BOM pattern data to a full walk', async () => {
  const repo = repository('pattern-degrade');
  const missingPlugin = workspace('missing-pattern-plugin');
  const missing = await captureFingerprint({ repo, pluginRoot: missingPlugin, mode: 'hybrid' });
  assert.equal(missing.mode, 'full-walk');
  assert.equal(missing.degradedFrom, 'hybrid');
  assert.equal(missing.error, null);

  assert.equal(ensureCutover({ repo }).status, 'ready');
  const degradedV3 = await captureFingerprint({ repo, pluginRoot: missingPlugin, mode: 'hybrid' });
  const explicitV3 = await captureFingerprint({ repo, pluginRoot, mode: 'full-walk' });
  assert.equal(degradedV3.error, null);
  assert.equal(degradedV3.digest, explicitV3.digest);
  assert.equal(degradedV3.entries, explicitV3.entries);

  const bomPlugin = workspace('bom-pattern-plugin');
  const lib = join(bomPlugin, 'hooks', 'scripts', 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'sensitive-patterns.list'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('.env\n'),
  ]));
  const bom = await captureFingerprint({ repo, pluginRoot: bomPlugin, mode: 'hybrid' });
  assert.equal(bom.mode, 'full-walk');
  assert.equal(bom.degradedFrom, 'hybrid');
  assert.equal(bom.error, null);
});

test('capture returns a conservative error result when the repository cannot be resolved', async () => {
  const missing = join(workspace('missing-capture-parent'), 'gone');
  const result = await captureFingerprint({ repo: missing, pluginRoot, mode: 'hybrid' });
  assert.equal(result.digest, null);
  assert.match(result.error, /ENOENT|realpath|no such file/i);
});

test('group 24 fingerprint binds both v3 slots, fence inventory, and current publication authority', async () => {
  const repo = repository('group-24-v3-authority');
  assert.equal(ensureCutover({ repo }).status, 'ready');
  const inspection = mutationTesting.inspectProtocol({ repo });
  assert.equal(inspection.status, 'ready');

  const entries = await fingerprintTesting.v3AuthorityEntries(repo);
  const paths = entries.map((entry) => entry.path.toString('utf8'));
  assert.deepEqual(paths, [...paths].sort((left, right) => Buffer.compare(
    Buffer.from(left), Buffer.from(right),
  )));
  assert.deepEqual(paths, [
    '@MUTATION-V3/fence-inventory',
    '@MUTATION-V3/publication-current',
    '@MUTATION-V3/publication-ref',
    '@MUTATION-V3/slot-a',
    '@MUTATION-V3/slot-b',
  ]);
  const byPath = new Map(entries.map((entry) => [entry.path.toString('utf8'), entry.value]));
  assert.deepEqual(
    byPath.get('@MUTATION-V3/slot-a'),
    readFileSync(join(repo, '.deep-review', '.pending-mutation.v3.a.json')),
  );
  assert.deepEqual(
    byPath.get('@MUTATION-V3/slot-b'),
    readFileSync(join(repo, '.deep-review', '.pending-mutation.v3.b.json')),
  );
  assert.deepEqual(
    byPath.get('@MUTATION-V3/fence-inventory'),
    Buffer.from([
      inspection.fence_inventory.sha256,
      inspection.fence_inventory.entries,
      inspection.fence_inventory.bytes,
    ].join('\0')),
  );
  assert.equal(
    byPath.get('@MUTATION-V3/publication-ref').toString('ascii'),
    inspection.publication_oid,
  );
  assert.deepEqual(
    byPath.get('@MUTATION-V3/publication-current'),
    mutationTesting.encodePublication(inspection.publication),
  );

  const before = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  const slotA = join(repo, '.deep-review', '.pending-mutation.v3.a.json');
  const slotABytes = readFileSync(slotA);
  writeFileSync(slotA, '{torn');
  const corrupt = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.notEqual(corrupt.digest, before.digest);
  writeFileSync(slotA, slotABytes);
  const restored = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.equal(restored.error, null);
  assert.equal(restored.digest, before.digest);
});

test('full-walk fingerprints regular content and bounded in-repo symlink targets', async (t) => {
  const repo = repository('full-walk');
  const target = join(repo, 'tracked.txt');
  const link = join(repo, 'link.txt');
  try {
    symlinkSync('tracked.txt', link);
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows symlink privilege unavailable');
      return;
    }
    throw error;
  }
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  const before = await captureFingerprint({ repo, pluginRoot, mode: 'full-walk' });
  writeFileSync(target, 'changed through target');
  const after = await captureFingerprint({ repo, pluginRoot, mode: 'full-walk' });
  assert.notEqual(after.digest, before.digest);
});

test('full-walk bounds symlink cycles without hanging or escaping', async (t) => {
  const repo = repository('symlink-cycle');
  try {
    symlinkSync('cycle-b', join(repo, 'cycle-a'));
    symlinkSync('cycle-a', join(repo, 'cycle-b'));
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows symlink privilege unavailable');
      return;
    }
    throw error;
  }
  const result = await captureFingerprint({ repo, pluginRoot, mode: 'full-walk' });
  assert.equal(result.error, null);
  assert.match(result.digest, /^[0-9a-f]{64}$/u);
});

test('full-walk binds every intermediate symlink hop even when final bytes are identical', async (t) => {
  const repo = repository('symlink-intermediate');
  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, 'dist', 'target-one.txt'), 'same bytes');
  writeFileSync(join(repo, 'dist', 'target-two.txt'), 'same bytes');
  try {
    symlinkSync('target-one.txt', join(repo, 'dist', 'middle-link'));
    symlinkSync('dist/middle-link', join(repo, 'outer-link'));
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows symlink privilege unavailable');
      return;
    }
    throw error;
  }
  const before = await captureFingerprint({ repo, pluginRoot, mode: 'full-walk' });
  const { unlinkSync } = await import('node:fs');
  unlinkSync(join(repo, 'dist', 'middle-link'));
  symlinkSync('target-two.txt', join(repo, 'dist', 'middle-link'));
  const after = await captureFingerprint({ repo, pluginRoot, mode: 'full-walk' });
  assert.notEqual(after.digest, before.digest);
});

test('hybrid binds an ignored runtime-state symlink through its bounded in-repo target', async (t) => {
  const repo = repository('hybrid-runtime-symlink');
  const runtime = join(repo, '.deep-review');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'state.yaml'), 'value: one\n');
  try {
    symlinkSync('state.yaml', join(runtime, 'config.yaml'));
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows symlink privilege unavailable');
      return;
    }
    throw error;
  }
  const before = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  writeFileSync(join(runtime, 'state.yaml'), 'value: two\n');
  const after = await captureFingerprint({ repo, pluginRoot, mode: 'hybrid' });
  assert.notEqual(after.digest, before.digest);
});

test('privacy preflight scans the full tree, byte-sorts hits, and handles auto/reuse/approve/decline', async () => {
  const repo = repository('privacy 리뷰 Ω');
  const configPath = config(repo);
  mkdirSync(join(repo, 'nested'));
  writeFileSync(join(repo, 'nested', 'SECRET.ENV'), 'x');
  writeFileSync(join(repo, '.env'), 'y');
  writeFileSync(join(repo, '.git', 'secret.env'), 'must never scan');

  const needed = await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'auto' });
  assert.equal(needed.outcome, 'needs_approval');
  assert.deepEqual(needed.hits, [...needed.hits].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.equal(needed.hits.some((hit) => hit.startsWith('.git/')), false);
  assert.match(needed.fingerprint, /^[0-9a-f]{64}$/u);

  const approved = await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'approve' });
  assert.equal(approved.outcome, 'acknowledged');
  assert.equal(approved.fingerprint, needed.fingerprint);
  const persisted = readFileSync(configPath, 'utf8');
  assert.match(persisted, new RegExp(`agy_sensitive_acked_fingerprint: "${needed.fingerprint}"`, 'u'));
  assert.match(persisted, /agy_sensitive_acked_at: "\d{4}-\d{2}-\d{2}T/u);

  const reused = await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'auto' });
  assert.equal(reused.outcome, 'acknowledged');
  writeFileSync(join(repo, 'token.pem'), 'new sensitive path');
  const changed = await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'auto' });
  assert.equal(changed.outcome, 'needs_approval');
  assert.notEqual(changed.fingerprint, approved.fingerprint);
  const declined = await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'decline' });
  assert.equal(declined.outcome, 'declined');
  assert.equal(readFileSync(configPath, 'utf8'), persisted);

  const emptyRepo = repository('privacy-empty');
  const emptyConfig = config(emptyRepo);
  const empty = await prepareAgyPrivacy({ repo: emptyRepo, pluginRoot, configPath: emptyConfig, approval: 'auto' });
  assert.equal(empty.outcome, 'auto_ack');
  assert.deepEqual(empty.hits, []);
});

test('privacy fingerprint is independent of directory enumeration and binds only raw sorted hit paths', () => {
  const first = repository('privacy-order-a');
  const second = repository('privacy-order-b');
  mkdirSync(join(first, 'a'));
  mkdirSync(join(first, 'z'));
  writeFileSync(join(first, 'z', 'token.pem'), 'content A');
  writeFileSync(join(first, 'a', 'SECRET.ENV'), 'content B');
  mkdirSync(join(second, 'z'));
  mkdirSync(join(second, 'a'));
  writeFileSync(join(second, 'a', 'SECRET.ENV'), 'different content');
  writeFileSync(join(second, 'z', 'token.pem'), 'also different');
  const scanFirst = scanAgyPrivacy({ repo: first, pluginRoot });
  const scanSecond = scanAgyPrivacy({ repo: second, pluginRoot });
  assert.deepEqual(scanFirst.hits, scanSecond.hits);
  assert.equal(scanFirst.fingerprint, scanSecond.fingerprint);
});

test('privacy preflight CLI emits one deterministic JSON result and patches only the ack pair', () => {
  const repo = repository('privacy-cli 리뷰 Ω');
  const configPath = config(repo);
  const result = spawnSync(process.execPath, [
    privacyCliPath,
    '--repo', repo,
    '--plugin-root', pluginRoot,
    '--config', configPath,
    '--approval', 'auto',
  ], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.outcome, 'auto_ack');
  assert.deepEqual(parsed.hits, []);
  const source = readFileSync(configPath, 'utf8');
  assert.equal((source.match(/^agy_sensitive_acked_fingerprint:/gmu) || []).length, 1);
  assert.equal((source.match(/^agy_sensitive_acked_at:/gmu) || []).length, 1);
  assert.match(source, /last_review: null/u);
});

test('agy bridge enforces privacy before spawn, prepends readonly text, retries only unsupported model, and writes terminal sidecars', async () => {
  const repo = repository('agy bridge 리뷰 Ω');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'review output Ω.txt');
  const log = join(workspace('agy-argv-log'), 'argv.jsonl');
  const binary = fakeAgy(repo);
  writeFileSync(promptFile, 'ORIGINAL BODY 리뷰 Ω');

  writeFileSync(join(repo, '.env'), 'secret');
  const blocked = await runAgyReviewer({
    binary, projectRoot: repo, pluginRoot, configPath, promptFile, outputFile,
    mode: 'hybrid', model: 'Gemini 3.5 Flash (High)', timeoutSeconds: 5,
    env: { ...process.env, FAKE_LOG: log },
  });
  assert.equal(blocked.attempted, false);
  assert.equal(blocked.privacyOutcome, 'needs_approval');
  assert.deepEqual(rows(log), []);

  await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'approve' });
  const result = await runAgyReviewer({
    binary, projectRoot: repo, pluginRoot, configPath, promptFile, outputFile,
    mode: 'hybrid', model: 'Gemini 3.5 Flash (High)', timeoutSeconds: 5,
    executionPlan: {
      model: 'Gemini 3.5 Flash (High)', effort: null, source: 'cli-reviewer', allowFallback: true,
    },
    env: { ...process.env, FAKE_LOG: log, FAKE_BEHAVIOR: 'unsupported' },
  });
  assert.equal(result.status, 'success');
  assert.equal(rows(log).length, 2);
  const [first, second] = rows(log);
  assert.equal(first.argv.includes('--model'), true);
  assert.equal(second.argv.includes('--model'), false);
  const prompt = first.argv[first.argv.indexOf('-p') + 1];
  assert.equal(prompt.startsWith('READ-ONLY REVIEW MODE'), true);
  assert.match(prompt, /OUTPUT CONTRACT - REQUIRED/u);
  assert.match(prompt, /# Deep Review Report — YYYY-MM-DD/u);
  assert.match(prompt, /\*\*Issues\*\*: 🔴 N건, 🟡 N건, ℹ️ N건/u);
  assert.equal(prompt.endsWith('ORIGINAL BODY 리뷰 Ω'), true);
  assert.equal(readFileSync(`${outputFile}.status`, 'utf8'), 'success\n');
  assert.equal(readdirSync(repo).some((name) => name.endsWith('.tmp')), false);
});

test('agy bridge does not retry an unsupported legacy model without affirmative fallback authority', async () => {
  const repo = repository('agy-legacy-no-fallback');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'review.txt');
  const log = join(workspace('agy-legacy-no-fallback-log'), 'argv.jsonl');
  const binary = fakeAgy(repo);
  writeFileSync(promptFile, 'review this change');

  const result = await runAgyReviewer({
    binary, projectRoot: repo, pluginRoot, configPath, promptFile, outputFile,
    mode: 'hybrid', model: 'Gemini 3.5 Flash (High)', timeoutSeconds: 5,
    env: { ...process.env, FAKE_LOG: log, FAKE_BEHAVIOR: 'unsupported' },
  });
  assert.equal(rows(log).length, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'ERROR_UNSUPPORTED_MODEL');
  assert.equal(readFileSync(`${outputFile}.status`, 'utf8'), 'failed\n');
});

test('agy classifier prioritizes mutation then truncation and bypass flags are true no-ops', async () => {
  const repo = repository('agy-classifier');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'out.txt');
  const log = join(workspace('agy-classifier-log'), 'argv.jsonl');
  const binary = fakeAgy(repo);
  writeFileSync(promptFile, 'x');
  await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'auto' });

  const bypassConfig = readFileSync(configPath);
  for (const flags of [{ noAgy: true }, { codexOnly: true }, { enabled: false }]) {
    const bypass = await runAgyReviewer({
      binary, projectRoot: repo, pluginRoot, configPath, promptFile, outputFile,
      timeoutSeconds: 5, env: { ...process.env, FAKE_LOG: log }, ...flags,
    });
    assert.equal(bypass.attempted, false);
    assert.equal(bypass.status, 'failed');
  }
  assert.deepEqual(rows(log), []);
  assert.deepEqual(readFileSync(configPath), bypassConfig);

  writeFileSync(promptFile, Buffer.alloc(198001, 97));
  const truncation = await runAgyReviewer({
    binary, projectRoot: repo, pluginRoot, configPath, promptFile, outputFile,
    timeoutSeconds: 5, mode: 'off', env: { ...process.env, FAKE_LOG: log },
  });
  assert.equal(truncation.status, 'prompt_too_large');

  writeFileSync(promptFile, 'small');
  const mutatePath = join(repo, 'tracked.txt');
  const mutation = await runAgyReviewer({
    binary, projectRoot: repo, pluginRoot, configPath, promptFile, outputFile,
    timeoutSeconds: 5, mode: 'full-walk',
    env: { ...process.env, FAKE_LOG: log, FAKE_MUTATE: mutatePath, FAKE_BEHAVIOR: 'failed' },
  });
  assert.equal(mutation.status, 'mutated');
  assert.equal(existsSync(`${outputFile}.mutation-warning`), true);
});

test('agy model filtering and retry matrix never retries auth, timeout, or generic failures', async (t) => {
  const repo = repository('agy-retry-matrix');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'out.txt');
  const binary = fakeAgy(repo);
  writeFileSync(promptFile, 'small');
  await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'auto' });

  for (const [behavior, status] of [['auth', 'not_authenticated'], ['timeout', 'timeout'], ['failed', 'failed']]) {
    await t.test(behavior, async () => {
      const log = join(workspace(`agy-${behavior}-log`), 'argv.jsonl');
      let injectedCalls = 0;
      const processRunner = behavior === 'timeout'
        ? async () => {
          injectedCalls += 1;
          return {
            code: 124,
            timedOut: true,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          };
        }
        : undefined;
      const result = await runAgyReviewer({
        binary, projectRoot: repo, pluginRoot, configPath, promptFile, outputFile,
        timeoutSeconds: 5,
        mode: 'off', model: 'Gemini 3.5 Flash (High)',
        env: { ...process.env, FAKE_LOG: log, FAKE_BEHAVIOR: behavior },
        ...(processRunner ? { processRunner } : {}),
      });
      assert.equal(result.status, status);
      assert.equal(behavior === 'timeout' ? injectedCalls : rows(log).length, 1);
    });
  }

  const hostileLog = join(workspace('agy-hostile-log'), 'argv.jsonl');
  const canary = join(repo, 'never-created');
  const hostile = await runAgyReviewer({
    binary, projectRoot: repo, pluginRoot, configPath, promptFile, outputFile,
    timeoutSeconds: 5, mode: 'off', model: `$(touch ${canary})`,
    env: { ...process.env, FAKE_LOG: hostileLog },
  });
  assert.equal(hostile.status, 'success');
  assert.equal(rows(hostileLog)[0].argv.includes('--model'), false);
  assert.equal(existsSync(canary), false);
});

test('mutation outranks truncation and capture errors classify conservatively', async () => {
  const repo = repository('agy-priority');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'out.txt');
  const log = join(workspace('agy-priority-log'), 'argv.jsonl');
  const binary = fakeAgy(repo);
  writeFileSync(promptFile, Buffer.alloc(198001, 120));
  await prepareAgyPrivacy({ repo, pluginRoot, configPath, approval: 'auto' });
  const result = await runAgyReviewer({
    binary, projectRoot: repo, pluginRoot, configPath, promptFile, outputFile,
    timeoutSeconds: 5, mode: 'full-walk',
    env: { ...process.env, FAKE_LOG: log, FAKE_MUTATE: join(repo, 'tracked.txt') },
  });
  assert.equal(result.status, 'mutated');
  assert.equal(result.truncated, true);
  assert.deepEqual(
    agyTesting.fingerprintChanged(
      { error: 'pre failed', mode: 'hybrid', digest: null },
      { error: null, mode: 'hybrid', digest: 'x' },
    ),
    { changed: true, reason: 'pre-snapshot failed: pre failed' },
  );
});

test('bypass flags return before validating paths or creating runtime state', async () => {
  const repo = workspace('agy-bypass-empty');
  let sideEffects = 0;
  for (const flags of [{ noAgy: true }, { codexOnly: true }, { enabled: false }]) {
    const result = await runAgyReviewer({
      projectRoot: repo,
      pluginRoot,
      configPath: join(repo, '.deep-review', 'config.yaml'),
      promptFile: join(repo, 'missing-prompt.txt'),
      outputFile: join(repo, '.deep-review', 'missing-output.txt'),
      binary: join(repo, 'missing-agy'),
      privacyPreparer() { sideEffects += 1; throw new Error('privacy called'); },
      fingerprintCapturer() { sideEffects += 1; throw new Error('fingerprint called'); },
      processRunner() { sideEffects += 1; throw new Error('process called'); },
      ...flags,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.attempted, false);
  }
  assert.equal(sideEffects, 0);
  assert.equal(existsSync(join(repo, '.deep-review')), false);
});

test('agy revalidates the exact approved privacy fingerprint immediately before argv assembly', async () => {
  const repo = repository('agy-privacy-revalidate');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'out.txt');
  writeFileSync(promptFile, 'body');
  let privacyCalls = 0;
  let processCalls = 0;
  const privacyPreparer = async (options) => {
    privacyCalls += 1;
    const result = await prepareAgyPrivacy(options);
    if (privacyCalls === 1) writeFileSync(join(repo, 'late-token.pem'), 'late');
    return result;
  };
  const result = await runAgyReviewer({
    binary: join(repo, 'never-run'),
    projectRoot: repo,
    pluginRoot,
    configPath,
    promptFile,
    outputFile,
    approval: 'auto',
    mode: 'hybrid',
    privacyPreparer,
    processRunner() { processCalls += 1; throw new Error('must not spawn'); },
  });
  assert.equal(privacyCalls, 2);
  assert.equal(processCalls, 0);
  assert.equal(result.attempted, false);
  assert.equal(result.privacyOutcome, 'needs_approval');
});

test('agy revalidates privacy before an unsupported-model retry can assemble another add-dir argv', async () => {
  const repo = repository('agy-retry-privacy-revalidate');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'out.txt');
  writeFileSync(promptFile, 'body');
  let privacyCalls = 0;
  let processCalls = 0;
  const privacyPreparer = async (options) => {
    privacyCalls += 1;
    return prepareAgyPrivacy(options);
  };
  const result = await runAgyReviewer({
    binary: join(repo, 'agy-does-not-need-to-exist'),
    projectRoot: repo,
    pluginRoot,
    configPath,
    promptFile,
    outputFile,
    mode: 'hybrid',
    model: 'future-model',
    executionPlan: {
      model: 'future-model', effort: null, source: 'cli-reviewer', allowFallback: true,
    },
    privacyPreparer,
    async processRunner() {
      processCalls += 1;
      writeFileSync(join(repo, 'late-token.pem'), 'late sensitive data');
      return {
        code: 2,
        timedOut: false,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('unsupported model value\n'),
      };
    },
  });
  assert.equal(privacyCalls, 3);
  assert.equal(processCalls, 1);
  assert.equal(result.attempted, true);
  assert.equal(result.privacyOutcome, 'needs_approval');
  assert.equal(result.status, 'mutated');
});

test('native Windows agy transport truncates below CreateProcess and cmd limits without spawn errors', async () => {
  const repo = repository('agy-windows-command-line');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'out.txt');
  writeFileSync(promptFile, '%&'.repeat(50_000));

  for (const binary of ['C:\\Tools\\agy.exe', 'C:\\Tools\\agy.cmd']) {
    const calls = [];
    const privacyPreparer = async () => ({
      hits: [], fingerprint: 'same', outcome: 'acknowledged', error: null,
    });
    const result = await runAgyReviewer({
      binary,
      projectRoot: repo,
      pluginRoot,
      configPath,
      promptFile,
      outputFile,
      platform: 'win32',
      mode: 'off',
      privacyPreparer,
      fingerprintCapturer: async () => ({ mode: 'off', digest: null, entries: 0, error: null }),
      async processRunner(command, args) {
        calls.push({ command, args });
        return {
          code: 0,
          timedOut: false,
          stdout: Buffer.from('partial review must be excluded\n'),
          stderr: Buffer.alloc(0),
        };
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(result.status, 'prompt_too_large');
    assert.equal(result.truncated, true);
    const units = agyTesting.estimateWindowsCommandUnits(binary, calls[0].args);
    assert.equal(typeof processRuntime.estimateWindowsBatchCommandUnits, 'function');
    assert.equal(
      units,
      binary.endsWith('.cmd')
        ? processRuntime.estimateWindowsBatchCommandUnits(binary, calls[0].args)
        : agyTesting.estimateWindowsCommandUnits(binary, calls[0].args),
    );
    assert.ok(units <= agyTesting.windowsCommandLimit(binary), {
      binary, units, limit: agyTesting.windowsCommandLimit(binary),
    });
    const sentPrompt = calls[0].args[calls[0].args.indexOf('-p') + 1];
    assert.ok(sentPrompt.length < readFileSync(promptFile, 'utf8').length);
    assert.ok(sentPrompt.startsWith('READ-ONLY REVIEW MODE'));
    assert.ok(sentPrompt.length < (binary.endsWith('.cmd') ? 4_000 : 16_000));
  }
});

test('POSIX agy transport keeps the prompt argument below the Linux per-string exec limit', async () => {
  const repo = repository('agy-posix-command-line');
  const configPath = config(repo);
  const promptFile = join(repo, 'prompt.txt');
  const outputFile = join(repo, 'out.txt');
  writeFileSync(promptFile, Buffer.alloc(198_001, 97));

  const calls = [];
  const privacyPreparer = async () => ({
    hits: [], fingerprint: 'same', outcome: 'acknowledged', error: null,
  });
  const result = await runAgyReviewer({
    binary: '/usr/local/bin/agy',
    projectRoot: repo,
    pluginRoot,
    configPath,
    promptFile,
    outputFile,
    platform: 'linux',
    mode: 'off',
    privacyPreparer,
    fingerprintCapturer: async () => ({ mode: 'off', digest: null, entries: 0, error: null }),
    async processRunner(command, args) {
      calls.push({ command, args });
      return {
        code: 0,
        timedOut: false,
        stdout: Buffer.from('partial review must be excluded\n'),
        stderr: Buffer.alloc(0),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.status, 'prompt_too_large');
  assert.equal(result.truncated, true);
  const sentPrompt = calls[0].args[calls[0].args.indexOf('-p') + 1];
  const promptBytes = Buffer.byteLength(sentPrompt, 'utf8') + 1;
  assert.ok(promptBytes <= 120 * 1024, `prompt argument was ${promptBytes} bytes`);
  assert.ok(sentPrompt.startsWith('READ-ONLY REVIEW MODE'));
});
