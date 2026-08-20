'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const path = require('node:path');
const { after, test } = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  cleanupGitFixtures,
  createGitFixture,
  fixtureRootFor,
  git,
} = require('./helpers/git-fixture.js');

const sourceRoot = path.resolve(__dirname, '..');
const temporaryRoots = new Set();
const nativeRelativeRoot = path.join('hooks', 'scripts', 'lib', 'native');
const nativeArtifacts = Object.freeze({
  'linux/x64': 'linux-x64/grok-linux-pidns-owner',
  'win32/x64': 'win32-x64/grok-win32-job-owner.exe',
});
const packedProviderRanProof = 'T-PACK-1_PROVIDER_RAN';

function packedProviderCommand() {
  return [
    process.execPath,
    '-e',
    `process.stdout.write(${JSON.stringify(`${packedProviderRanProof}\n`)})`,
  ];
}

after(() => {
  cleanupGitFixtures();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function copyInstalledTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyInstalledTree(from, to);
    else if (entry.isFile()) {
      copyFileSync(from, to);
      chmodSync(to, statSync(from).mode & 0o777);
    } else {
      throw new Error(`unsupported installed fixture entry: ${from}`);
    }
  }
}

function installPluginFixture() {
  const repo = createGitFixture('deep review 공간 한글 Ω');
  const installedRoot = path.join(fixtureRootFor(repo), 'installed plugin 공간 Ω');
  mkdirSync(installedRoot, { recursive: true });
  for (const relativePath of [
    'agents',
    'commands',
    'hooks',
    'skills',
    '.claude-plugin',
    '.codex-plugin',
  ]) {
    copyInstalledTree(
      path.join(sourceRoot, relativePath),
      path.join(installedRoot, relativePath),
    );
  }
  copyFileSync(path.join(sourceRoot, 'package.json'), path.join(installedRoot, 'package.json'));
  assert.equal(path.basename(repo), 'deep review 공간 한글 Ω');
  return { repo, installedRoot };
}

function readInstalled(installedRoot, relativePath) {
  return readFileSync(path.join(installedRoot, relativePath), 'utf8');
}

function workflowJob(workflow, name) {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `workflow job missing: ${name}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function workflowStep(job, name) {
  const lines = job.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `workflow step missing: ${name}`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^      - (?:name:|uses:)/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function assertOrdered(source, earlier, later, label) {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);
  assert.notEqual(earlierIndex, -1, `${label}: missing ${earlier}`);
  assert.notEqual(laterIndex, -1, `${label}: missing ${later}`);
  assert.ok(earlierIndex < laterIndex, `${label}: ${earlier} must precede ${later}`);
}

function sourceBetween(source, start, end, label) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `${label}: missing start marker ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `${label}: missing end marker ${end}`);
  return source.slice(startIndex, endIndex);
}

function readChecksums(nativeRoot) {
  const sums = new Map();
  for (const line of readFileSync(path.join(nativeRoot, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/u)) {
    const match = line.match(/^([a-f0-9]{64}) [ *](.+)$/u);
    assert.ok(match, `malformed SHA256SUMS line: ${line}`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

async function loadInstalledRuntime(installedRoot) {
  const routeUrl = pathToFileURL(
    path.join(installedRoot, 'hooks', 'scripts', 'public-route.mjs'),
  ).href;
  const synthesisUrl = pathToFileURL(
    path.join(installedRoot, 'hooks', 'scripts', 'review-synthesis.mjs'),
  ).href;
  return {
    route: await import(routeUrl),
    synthesis: await import(synthesisUrl),
  };
}

async function exercisePublicRoute(installedRoot, host, route) {
  assert.ok(['claude', 'codex'].includes(host));
  assert.ok(['review', 'respond', 'loop'].includes(route));
  const { route: runtime } = await loadInstalledRuntime(installedRoot);
  const entry = route === 'loop' ? 'loop' : 'review';
  const argv = route === 'respond' ? ['--respond'] : [];
  const parsed = runtime.parsePublicRoute({ entry, argv, host });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.route, route);
  assert.equal(parsed.host, host);
}

function validReviewerReport() {
  return [
    '# Deep Review Report — 2026-07-18',
    '',
    '## Summary',
    '',
    '- **Verdict**: APPROVE',
    '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건',
    '',
    '## Code Review',
    '',
    '### 🔴 Critical',
    '',
    'None.',
    '',
    '### 🟡 Warning',
    '',
    'None.',
    '',
    '### ℹ️ Info',
    '',
    'None.',
    '',
    '### 🟢 Passed',
    '',
    '- Installed runtime contract valid.',
    '',
  ].join('\n');
}

function reviewerOutputDigest(output) {
  return createHash('sha256').update(output, 'utf8').digest('hex');
}

async function runGenericReviewerFake({ repo, installedRoot, behavior }) {
  const fingerprintUrl = pathToFileURL(
    path.join(installedRoot, 'hooks', 'scripts', 'lib', 'fingerprint.mjs'),
  ).href;
  const { captureFingerprint } = await import(fingerprintUrl);
  const before = await captureFingerprint({
    repo,
    pluginRoot: installedRoot,
    mode: 'hybrid',
  });
  assert.equal(before.error, null);

  let output;
  if (behavior === 'mutate') {
    writeFileSync(path.join(repo, 'generic reviewer mutation Ω.txt'), 'untrusted edit\n');
    output = validReviewerReport();
  } else if (behavior === 'malformed') {
    output = 'APPROVE without the shipped report contract';
  } else if (behavior === 'unavailable') {
    output = '';
  } else if (behavior === 'valid') {
    output = validReviewerReport();
  } else {
    throw new Error('unknown reviewer fake behavior');
  }

  const after = await captureFingerprint({
    repo,
    pluginRoot: installedRoot,
    mode: 'hybrid',
  });
  assert.equal(after.error, null);
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  return synthesis.evaluateReviewerAttempt({
    role: 'codex-review',
    output,
    beforeFingerprint: before,
    afterFingerprint: after,
  });
}

test('installed Claude and Codex routes execute the production route grammar in a spaces/Unicode fixture', async () => {
  const { repo, installedRoot } = installPluginFixture();
  for (const host of ['claude', 'codex']) {
    for (const route of ['review', 'respond', 'loop']) {
      await exercisePublicRoute(installedRoot, host, route);
    }
  }
  const codexManifest = JSON.parse(readInstalled(installedRoot, '.codex-plugin/plugin.json'));
  assert.deepEqual(codexManifest.interface.defaultPrompt, [
    '$deep-review:deep-review',
    '$deep-review:deep-review-loop',
  ]);
  assert.equal(Object.hasOwn(codexManifest, 'hooks'), false);
  assert.equal(Object.hasOwn(codexManifest, 'mcpServers'), false);
  const { route } = await loadInstalledRuntime(installedRoot);
  assert.equal(route.parsePublicRoute({
    entry: 'review', host: 'codex', argv: ['--ultracode', '--no-opus'],
  }).ok, false);
  assert.equal(route.parsePublicRoute({
    entry: 'loop', host: 'claude', argv: ['--respond'],
  }).ok, false);
  const reportPath = path.join(repo, 'review report 한글.md');
  writeFileSync(reportPath, validReviewerReport());
  const explicitReport = route.parsePublicRoute({
    entry: 'review',
    host: 'codex',
    cwd: repo,
    argv: [
      '--respond',
      '--codex',
      '--no-codex',
      'review report 한글.md',
      '--ultracode',
      '--no-opus',
    ],
  });
  assert.equal(explicitReport.ok, true);
  assert.equal(explicitReport.route, 'respond');
  assert.equal(explicitReport.reportPath, reportPath);
  assert.deepEqual(explicitReport.ignoredReviewerFlags, [
    '--codex', '--no-codex', '--ultracode', '--no-opus',
  ]);
  const missingReport = route.parsePublicRoute({
    entry: 'review',
    host: 'codex',
    cwd: repo,
    argv: ['--respond', '--codex', 'missing report.md'],
  });
  assert.equal(missingReport.ok, false);
  assert.match(missingReport.error, /existing file/u);
  assert.equal(route.parsePublicRoute({
    entry: 'review',
    host: 'codex',
    cwd: repo,
    argv: ['--respond', '--pr=7'],
  }).ok, false);
  assert.equal(route.parsePublicRoute({
    entry: 'review',
    host: 'codex',
    cwd: repo,
    argv: ['--respond', '--source=pr', '--pr=7'],
  }).ok, true);
});

test('trusted installed reviewer output reaches the production one-reviewer approval path', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const review = await runGenericReviewerFake({ repo, installedRoot, behavior: 'valid' });
  assert.deepEqual(review, {
    role: 'codex-review',
    included: true,
    exclusion: null,
    verdict: 'APPROVE',
    issues: { critical: 0, warning: 0, info: 0 },
    output_digest: reviewerOutputDigest(validReviewerReport()),
  });
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  assert.deepEqual(synthesis.synthesizeReviewAttempts([review]), {
    status: 'reviewed',
    n_actual: 1,
    verdict: 'APPROVE',
    phase6_allowed: true,
    exclusions: [],
  });
});

test('multi-reviewer synthesis requires materialized agreement and preserves split warnings', async () => {
  const { installedRoot } = installPluginFixture();
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  const attempts = [
    {
      role: 'codex-review',
      output_digest: reviewerOutputDigest('codex warning voice'),
      included: true,
      exclusion: null,
      verdict: 'CONCERN',
      issues: { critical: 0, warning: 1, info: 0 },
    },
    {
      role: 'agy',
      output_digest: reviewerOutputDigest('agy approval voice'),
      included: true,
      exclusion: null,
      verdict: 'APPROVE',
      issues: { critical: 0, warning: 0, info: 0 },
    },
  ];
  assert.deepEqual(synthesis.synthesizeReviewAttempts(attempts), {
    status: 'operational_failure',
    n_actual: 2,
    verdict: null,
    phase6_allowed: false,
    exclusions: [],
    error: 'consensus_required',
  });
  assert.deepEqual(synthesis.synthesizeReviewAttempts(attempts, {
    findings: [{ severity: 'warning', roles: ['codex-review'] }],
  }), {
    status: 'reviewed',
    n_actual: 2,
    verdict: 'CONCERN',
    phase6_allowed: true,
    exclusions: [],
  });
  const agreedAttempts = [
    attempts[0],
    {
      ...attempts[1],
      verdict: 'CONCERN',
      issues: { critical: 0, warning: 1, info: 0 },
    },
  ];
  assert.equal(synthesis.synthesizeReviewAttempts(agreedAttempts, {
    findings: [{ severity: 'warning', roles: ['codex-review', 'agy'] }],
  }).verdict, 'REQUEST_CHANGES');
  assert.deepEqual(synthesis.synthesizeReviewAttempts(attempts, {
    findings: [],
  }), {
    status: 'operational_failure',
    n_actual: 2,
    verdict: null,
    phase6_allowed: false,
    exclusions: [],
    error: 'consensus_required',
  });

  assert.deepEqual(synthesis.synthesizeReviewAttempts([
    attempts[0],
    { ...attempts[1], output_digest: attempts[0].output_digest },
  ], { findings: [] }), {
    status: 'operational_failure',
    n_actual: 2,
    verdict: null,
    phase6_allowed: false,
    exclusions: [],
    error: 'consensus_required',
  });

  const criticalAttempts = [
    {
      role: 'codex-review',
      output_digest: reviewerOutputDigest('codex critical voice'),
      included: true,
      exclusion: null,
      verdict: 'REQUEST_CHANGES',
      issues: { critical: 1, warning: 0, info: 0 },
    },
    attempts[1],
  ];
  assert.equal(synthesis.synthesizeReviewAttempts(criticalAttempts, {
    findings: [],
  }).phase6_allowed, false);
  assert.equal(synthesis.synthesizeReviewAttempts(criticalAttempts, {
    findings: [{ severity: 'critical', roles: ['codex-review'] }],
  }).verdict, 'REQUEST_CHANGES');
});

test('Codex generic reviewer mutation is fingerprinted and excluded', async () => {
  const { repo, installedRoot } = installPluginFixture();
  await exercisePublicRoute(installedRoot, 'codex', 'review');
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const review = await runGenericReviewerFake({ repo, installedRoot, behavior: 'mutate' });
  assert.deepEqual(review, {
    role: 'codex-review',
    included: false,
    exclusion: 'fingerprint_mismatch',
    verdict: null,
    issues: null,
    output_digest: reviewerOutputDigest(validReviewerReport()),
  });
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  const terminal = synthesis.synthesizeReviewAttempts([review]);
  assert.deepEqual(terminal, {
    status: 'operational_failure',
    n_actual: 0,
    verdict: null,
    phase6_allowed: false,
    exclusions: [{ role: 'codex-review', reason: 'fingerprint_mismatch' }],
  });
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
});

test('malformed generic reviewer result fails closed with no Phase 6 commit', async () => {
  const { repo, installedRoot } = installPluginFixture();
  await exercisePublicRoute(installedRoot, 'codex', 'respond');
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const review = await runGenericReviewerFake({ repo, installedRoot, behavior: 'malformed' });
  assert.equal(review.included, false);
  assert.equal(review.verdict, null);
  assert.equal(review.exclusion, 'malformed_or_empty_result');
  const { synthesis } = await loadInstalledRuntime(installedRoot);
  const terminal = synthesis.synthesizeReviewAttempts([review]);
  assert.equal(terminal.status, 'operational_failure');
  assert.equal(terminal.phase6_allowed, false);
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
});

test('N_actual=0 is terminal on both hosts and the loop cannot commit', async () => {
  for (const host of ['claude', 'codex']) {
    const { repo, installedRoot } = installPluginFixture();
    await exercisePublicRoute(installedRoot, host, 'loop');
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const review = await runGenericReviewerFake({
      repo,
      installedRoot,
      behavior: 'unavailable',
    });
    const { synthesis } = await loadInstalledRuntime(installedRoot);
    const terminal = synthesis.synthesizeReviewAttempts([review]);
    assert.equal(terminal.n_actual, 0);
    assert.equal(terminal.status, 'operational_failure');
    assert.equal(terminal.verdict, null);
    assert.equal(terminal.phase6_allowed, false);
    assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
  }
});

test('T-PACK-1: a no-compiler packed installation loads its architecture-correct helper and completes a contained stub launch', (t) => {
  const packedRoot = process.env.DEEP_REVIEW_PACKED_ROOT;
  if (!packedRoot) {
    t.skip('D21 intentionally withholds built helpers from the source tree; T-PACK-1 runs only against a release-generated packed tree');
    return;
  }

  const platformKey = `${process.platform}/${process.arch}`;
  const artifact = nativeArtifacts[platformKey];
  assert.ok(artifact, `T-PACK-1 requires Linux x86_64 or native Windows 11 x86_64, not ${platformKey}`);
  const nativeRoot = path.join(packedRoot, nativeRelativeRoot);
  const helper = path.join(nativeRoot, ...artifact.split('/'));
  assert.equal(existsSync(helper), true, `packed helper missing: ${artifact}`);

  const sums = readChecksums(nativeRoot);
  assert.deepEqual([...sums.keys()].sort(), Object.values(nativeArtifacts).sort());
  for (const [relativePath, expected] of sums) {
    const actual = createHash('sha256')
      .update(readFileSync(path.join(nativeRoot, ...relativePath.split('/'))))
      .digest('hex');
    assert.equal(actual, expected, `packed checksum mismatch: ${relativePath}`);
  }

  const [providerExecutable, ...providerArguments] = packedProviderCommand();
  const launch = spawnSync(helper, [
    '--own-grok-tree',
    '--',
    providerExecutable,
    ...providerArguments,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '', CC: 'compiler-must-not-be-used' },
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(launch.error, undefined);
  assert.equal(launch.status, 0, launch.stderr);
  assert.match(launch.stderr, new RegExp(`(?:^|\\r?\\n)${packedProviderRanProof}(?:\\r?\\n|$)`, 'u'),
    'the provider output channel must carry the child ran proof');
  const handshakes = launch.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(handshakes.length, 2, 'control stdout must contain only the two owner handshakes');
  assert.equal(handshakes[0]?.handshake, 'containment_ready');
  assert.equal(handshakes[0]?.containment_ready, true);
  assert.equal(handshakes.at(-1)?.handshake, 'termination_report');
  assert.equal(handshakes.at(-1)?.live_members, 0);
  assert.deepEqual(handshakes.at(-1)?.member_pids, []);
});

test('T-PACK-1 provider stub emits the ran proof required by the packed helper smoke', () => {
  const [providerExecutable, ...providerArguments] = packedProviderCommand();
  const launch = spawnSync(providerExecutable, providerArguments, {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(launch.error, undefined);
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.stdout, `${packedProviderRanProof}\n`);
});

test('T-PACK-2: release automation builds, packs, verifies and integrity-binds both native helpers', () => {
  const manifest = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const buildNative = manifest.scripts?.['build:native'];
  assert.equal(typeof buildNative, 'string', 'package.json must define build:native');
  for (const required of [
    'GROK_NATIVE_TARGET',
    'GROK_NATIVE_OUTPUT_ROOT',
    'grok-linux-pidns-owner.c',
    'linux-x64/grok-linux-pidns-owner',
    'grok-win32-job-owner.c',
    'win32-x64/grok-win32-job-owner.exe',
  ]) {
    assert.match(buildNative, new RegExp(required.replaceAll('.', '\\.'), 'u'), `build:native misses ${required}`);
  }

  const workflow = readFileSync(path.join(sourceRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const nativeTests = workflowJob(workflow, 'tests');
  const linuxCompile = workflowStep(nativeTests, 'Compile Linux containment helper');
  assert.match(linuxCompile, /if:\s*runner\.os == 'Linux'/u);
  assert.match(linuxCompile, /GROK_NATIVE_OUTPUT_ROOT:\s*\$\{\{ runner\.temp \}\}\/deep-review-native-build/u);
  assert.match(linuxCompile, /run:\s*npm run build:native/u);
  assertOrdered(nativeTests, 'name: Compile Linux containment helper', 'name: Run native tests', 'ubuntu compile-before-test');

  const windowsShards = workflowJob(workflow, 'windows-test-shards');
  const msvcSetup = workflowStep(windowsShards, 'Set up MSVC');
  assert.match(msvcSetup, /uses:\s*ilammy\/msvc-dev-cmd@v1/u);
  const windowsCompile = workflowStep(windowsShards, 'Compile Windows containment helper');
  assert.match(windowsCompile, /GROK_NATIVE_OUTPUT_ROOT:\s*\$\{\{ runner\.temp \}\}\\deep-review-native-build/u);
  assert.match(windowsCompile, /run:\s*npm run build:native/u);
  assertOrdered(windowsShards, 'name: Set up MSVC', 'name: Compile Windows containment helper', 'MSVC setup before Windows compile');
  assertOrdered(windowsShards, 'name: Compile Windows containment helper', 'name: Run native test shard', 'Windows compile-before-test');

  const releaseBundle = workflowJob(workflow, 'release-bundle');
  assert.match(releaseBundle, /runs-on:\s*ubuntu-latest/u);
  const buildBoth = workflowStep(releaseBundle, 'Build both native helpers');
  assert.match(buildBoth, /npm run build:native/u);
  assert.match(buildBoth, /GROK_NATIVE_TARGET=win32-x64/u);
  assert.match(buildBoth, /CC=x86_64-w64-mingw32-gcc/u);

  const integrity = workflowStep(releaseBundle, 'Integrity-bind native helpers');
  for (const artifact of Object.values(nativeArtifacts)) {
    assert.match(integrity, new RegExp(artifact.replaceAll('.', '\\.'), 'u'));
  }
  assert.match(integrity, /> SHA256SUMS/u);
  assert.match(integrity, /sha256sum --check SHA256SUMS/u);

  const pack = workflowStep(releaseBundle, 'Pack into an isolated release tree');
  assert.match(pack, /npm pack/u);
  assert.match(pack, /\$RUNNER_TEMP\/packed-tree/u);
  const verifyPacked = workflowStep(releaseBundle, 'Verify packed native inventory');
  assert.match(verifyPacked, /packed-tree\/package\/hooks\/scripts\/lib\/native/u);
  assert.match(verifyPacked, /sha256sum --check SHA256SUMS/u);
  assert.doesNotMatch(verifyPacked, /github\.workspace|GITHUB_WORKSPACE/iu);

  const linuxSmoke = workflowStep(releaseBundle, 'Run packed-tree T-PACK-1 on Linux x86_64');
  assert.match(linuxSmoke, /DEEP_REVIEW_PACKED_ROOT:\s*\$\{\{ runner\.temp \}\}\/packed-tree\/package/u);
  assert.match(linuxSmoke, /--test-name-pattern=['"]T-PACK-1['"]/u);
  assert.doesNotMatch(linuxSmoke, /github\.workspace|GITHUB_WORKSPACE/iu);
  assertOrdered(releaseBundle, 'name: Integrity-bind native helpers', 'name: Pack into an isolated release tree', 'integrity before pack');
  assertOrdered(releaseBundle, 'name: Pack into an isolated release tree', 'name: Verify packed native inventory', 'pack before packed-tree verification');
  assertOrdered(releaseBundle, 'name: Verify packed native inventory', 'name: Run packed-tree T-PACK-1 on Linux x86_64', 'packed-tree verification before Linux smoke');

  const windowsSmoke = workflowJob(workflow, 'release-bundle-windows-smoke');
  assert.match(windowsSmoke, /runs-on:\s*windows-latest/u);
  assert.match(windowsSmoke, /needs:\s*release-bundle/u);
  assert.match(windowsSmoke, /actions\/download-artifact@v4/u);
  assert.doesNotMatch(windowsSmoke, /actions\/checkout|npm run build:native|\bcl(?:\.exe)?\b|\bgcc\b/iu);
  const nativeWindowsSmoke = workflowStep(windowsSmoke, 'Run packed-tree T-PACK-1 on native Windows x86_64');
  assert.match(nativeWindowsSmoke, /DEEP_REVIEW_PACKED_ROOT:\s*\$\{\{ runner\.temp \}\}\\packed-tree\\package/u);
  assert.match(nativeWindowsSmoke, /--test-name-pattern=['"]T-PACK-1['"]/u);
  assert.doesNotMatch(nativeWindowsSmoke, /github\.workspace|GITHUB_WORKSPACE/iu);
});

test('native owner sources implement the inventoried containment mechanisms and owner handshakes without literal NUL bytes', async () => {
  const nativeRoot = path.join(sourceRoot, nativeRelativeRoot);
  const linuxPath = path.join(nativeRoot, 'grok-linux-pidns-owner.c');
  const windowsPath = path.join(nativeRoot, 'grok-win32-job-owner.c');
  const supervisor = await import(pathToFileURL(
    path.join(sourceRoot, 'hooks', 'scripts', 'lib', 'grok-process-supervisor.mjs'),
  ).href);
  assert.equal(supervisor.GROK_CONTAINMENT_PROTOCOL_VERSION, '1.0');
  assert.deepEqual(Object.keys(supervisor.GROK_CONTAINMENT_INVENTORY).sort(), ['linux/x64', 'win32/x64']);
  const linuxInventory = supervisor.GROK_CONTAINMENT_INVENTORY['linux/x64'];
  const windowsInventory = supervisor.GROK_CONTAINMENT_INVENTORY['win32/x64'];
  assert.equal(linuxInventory.source, path.basename(linuxPath));
  assert.equal(linuxInventory.helper, nativeArtifacts['linux/x64']);
  assert.equal(linuxInventory.enumeration, 'namespace-member-set');
  assert.equal(windowsInventory.source, path.basename(windowsPath));
  assert.equal(windowsInventory.helper, nativeArtifacts['win32/x64']);
  assert.equal(windowsInventory.enumeration, 'JobObjectBasicProcessIdList');
  const linuxBytes = readFileSync(linuxPath);
  const windowsBytes = readFileSync(windowsPath);
  assert.equal(linuxBytes.includes(0), false, 'Linux helper source contains a literal NUL byte');
  assert.equal(windowsBytes.includes(0), false, 'Windows helper source contains a literal NUL byte');

  const linux = linuxBytes.toString('utf8');
  const linuxReady = sourceBetween(
    linux,
    'static void emit_containment_ready(void)',
    'static void emit_termination_report(void)',
    'Linux containment-ready emitter',
  );
  const linuxTermination = sourceBetween(
    linux,
    'static void emit_termination_report(void)',
    'static int write_all(',
    'Linux termination-report emitter',
  );
  for (const [emitter, label] of [
    [linuxReady, 'Linux containment-ready emitter'],
    [linuxTermination, 'Linux termination-report emitter'],
  ]) {
    assert.match(emitter, /fputs\([\s\S]{0,360}stdout\);\s*fflush\(stdout\);/u,
      `${label} must write and flush owner control stdout`);
    assert.equal(emitter.includes('protocol_version\\":\\"1.0'), true,
      `${label} must carry protocol version 1.0`);
  }
  assert.equal(linuxReady.includes('containment_ready\\":true'), true);
  assert.match(linuxReady, new RegExp(linuxInventory.mechanism, 'u'));
  assert.equal(linuxTermination.includes('live_members\\":0'), true);
  assert.equal(linuxTermination.includes('member_pids\\":[]'), true);

  const linuxMain = linux.slice(linux.indexOf('int main(int argc, char **argv)'));
  const cloneSetup = sourceBetween(
    linuxMain,
    'int clone_flags =',
    'const pid_t init_pid = clone(',
    'Linux clone flag setup',
  );
  assert.match(cloneSetup, /int clone_flags\s*=\s*CLONE_NEWPID\s*\|\s*SIGCHLD/u);
  assert.match(cloneSetup, /const int unprivileged\s*=\s*geteuid\(\)\s*!=\s*0/u);
  assert.match(cloneSetup, /if\s*\(unprivileged\)\s*clone_flags\s*\|=\s*CLONE_NEWUSER/u);
  assert.deepEqual(
    (cloneSetup.match(/\bclone_flags\s*(?:=|\|=|&=|\^=|\+=|-=)/gu) ?? [])
      .map((assignment) => assignment.replaceAll(/\s/gu, '')),
    ['clone_flags=', 'clone_flags|='],
    'Linux clone flags must not be overwritten or have containment flags removed before clone',
  );
  assert.match(
    linuxMain,
    /const pid_t init_pid\s*=\s*clone\(\s*namespace_init,\s*\(char \*\)stack \+ OWNER_STACK_SIZE,\s*clone_flags,\s*&context\s*\);/u,
    'the namespace clone must consume the checked containment flags and owner context',
  );

  const namespaceInit = sourceBetween(
    linux,
    'static int namespace_init(void *opaque)',
    'static int wait_for_init(',
    'Linux namespace init',
  );
  assert.match(
    namespaceInit,
    /close\(context->gate_write_fd\);[\s\S]{0,160}if \(prctl\(PR_SET_PDEATHSIG, SIGKILL\) < 0\) \{[\s\S]{0,200}return 125;\s*\}[\s\S]{0,120}if \(write_all\(context->armed_fd, "A", 1U\) < 0\) \{[\s\S]{0,200}return 125;\s*\}[\s\S]{0,120}if \(await_parent_gate\(context->gate_fd\) < 0\) \{[\s\S]{0,200}return 125;\s*\}/u,
    'namespace PID 1 must fail closed while arming parent-death teardown before awaiting release',
  );
  assert.match(
    linuxMain,
    /if \(await_owner_armed\(armed\[0\]\) < 0\) \{[\s\S]{0,360}return 125;\s*\}[\s\S]{0,760}if \(write_all\(gate\[1\], "R", 1U\) < 0\) \{/u,
    'the Linux parent must fail closed unless the namespace owner arms teardown before release',
  );

  const windows = windowsBytes.toString('utf8');
  for (const required of [
    'CreateJobObjectW',
    'SetInformationJobObject',
    'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
    'JOB_OBJECT_LIMIT_BREAKAWAY_OK',
    'JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK',
    'CreateProcessW',
    'CREATE_SUSPENDED',
    'AssignProcessToJobObject',
    'ResumeThread',
    'JobObjectBasicProcessIdList',
    '"containment_ready"',
    '"termination_report"',
  ]) {
    assert.match(windows, new RegExp(required, 'u'), `Windows helper misses ${required}`);
  }
  const windowsReady = sourceBetween(
    windows,
    'static void emit_containment_ready(void)',
    'static void emit_termination_report(void)',
    'Windows containment-ready emitter',
  );
  const windowsTermination = sourceBetween(
    windows,
    'static void emit_termination_report(void)',
    'static wchar_t *build_command_line(',
    'Windows termination-report emitter',
  );
  for (const [emitter, label] of [
    [windowsReady, 'Windows containment-ready emitter'],
    [windowsTermination, 'Windows termination-report emitter'],
  ]) {
    assert.match(emitter, /fputs\([\s\S]{0,360}stdout\);\s*fflush\(stdout\);/u,
      `${label} must write and flush owner control stdout`);
    assert.equal(emitter.includes('protocol_version\\":\\"1.0'), true,
      `${label} must carry protocol version 1.0`);
  }
  assert.equal(windowsReady.includes('containment_ready\\":true'), true);
  assert.match(windowsReady, new RegExp(windowsInventory.mechanism, 'u'));
  assert.equal(windowsTermination.includes('live_members\\":0'), true);
  assert.equal(windowsTermination.includes('member_pids\\":[]'), true);

  const windowsMain = windows.slice(windows.indexOf('int wmain(int argc, wchar_t **argv)'));
  assert.match(
    windowsMain,
    /LimitFlags\s*=\s*JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;\s*limits\.BasicLimitInformation\.LimitFlags\s*&=\s*~\(\s*JOB_OBJECT_LIMIT_BREAKAWAY_OK\s*\|\s*JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK\s*\);\s*if \(!SetInformationJobObject\(\s*job,\s*JobObjectExtendedLimitInformation,\s*&limits,\s*\(DWORD\)sizeof\(limits\)\s*\)\) \{[\s\S]{0,280}CloseHandle\(job\);\s*return 125;\s*\}/u,
    'the Windows job limits must be passed to a checked SetInformationJobObject call',
  );
  assert.match(
    windowsMain,
    /const BOOL created\s*=\s*CreateProcessW\(\s*NULL,\s*command_line,\s*NULL,\s*NULL,\s*TRUE,\s*CREATE_SUSPENDED \| CREATE_UNICODE_ENVIRONMENT \| EXTENDED_STARTUPINFO_PRESENT,\s*NULL,\s*NULL,\s*&startup\.StartupInfo,\s*&process\s*\);[\s\S]{0,360}if \(!created\) \{[\s\S]{0,240}CloseHandle\(job\);\s*return 125;\s*\}/u,
    'the Windows provider must be created suspended with explicit stdio and creation failure must stop assignment',
  );
  assert.match(
    windowsMain,
    /if \(ResumeThread\(process\.hThread\) == \(DWORD\)-1\) \{[\s\S]{0,240}TerminateJobObject\(job, 125U\);[\s\S]{0,160}close_process\(&process\);[\s\S]{0,160}return 125;\s*\}/u,
    'resume failure must be checked and fail closed before waiting on the provider',
  );
  assertOrdered(windowsMain, 'CreateProcessW(', 'AssignProcessToJobObject(', 'Windows create before assignment');
  assertOrdered(windowsMain, 'AssignProcessToJobObject(', 'ResumeThread(', 'Windows assignment before resume');

  const queryMembers = sourceBetween(
    windows,
    'static int query_job_members(',
    'static int wait_for_empty_job(',
    'Windows Job Object member query',
  );
  assert.match(
    queryMembers,
    /const BOOL queried\s*=\s*QueryInformationJobObject\(\s*job,\s*JobObjectBasicProcessIdList,\s*members,\s*\(DWORD\)bytes,\s*NULL\s*\);[\s\S]{0,360}if \(queried\) \{[\s\S]{0,240}\*assigned = observed_assigned;[\s\S]{0,120}\*listed = observed_listed;[\s\S]{0,120}return 1;\s*\}[\s\S]{0,120}if \(error != ERROR_MORE_DATA\) return 0;/u,
    'the Windows member query must check success and fail closed except for bounded buffer growth',
  );
  const waitEmpty = sourceBetween(
    windows,
    'static int wait_for_empty_job(',
    'struct provider_stdio {',
    'Windows empty-Job proof',
  );
  assert.match(
    waitEmpty,
    /if \(!query_job_members\(job, &assigned, &listed\)\) return 0;\s*if \(assigned == 0U && listed == 0U\) return 1;\s*Sleep\(10U\);/u,
    'only a successful query observing both zero counts may prove an empty Job Object',
  );
  assert.equal((waitEmpty.match(/\breturn 1;/gu) ?? []).length, 1,
    'the Windows empty-Job proof must have exactly one success return');
});

test('native owners keep control stdout unreachable from provider stdio on both platforms', () => {
  const nativeRoot = path.join(sourceRoot, nativeRelativeRoot);
  const linux = readFileSync(path.join(nativeRoot, 'grok-linux-pidns-owner.c'), 'utf8');
  const windows = readFileSync(path.join(nativeRoot, 'grok-win32-job-owner.c'), 'utf8');

  const linuxStdio = sourceBetween(
    linux,
    'static int connect_provider_stdio(void)',
    'static int drain_preflight_control(void)',
    'Linux provider stdio connector',
  );
  assert.match(
    linuxStdio,
    /const int provider_input_fd\s*=\s*fcntl\(STDIN_FILENO, F_DUPFD_CLOEXEC, 3\);\s*if \(provider_input_fd < 0\) return -1;/u,
    'Linux provider stdin duplication must fail closed',
  );
  assert.match(
    linuxStdio,
    /const int provider_output_fd\s*=\s*fcntl\(STDERR_FILENO, F_DUPFD_CLOEXEC, 3\);\s*if \(provider_output_fd < 0\) \{[\s\S]{0,240}return -1;\s*\}/u,
    'Linux provider output must come from owner stderr and duplication must fail closed',
  );
  assert.match(
    linuxStdio,
    /if \(dup2\(provider_input_fd, STDIN_FILENO\) < 0\s*\|\| dup2\(provider_output_fd, STDOUT_FILENO\) < 0\s*\|\| dup2\(provider_output_fd, STDERR_FILENO\) < 0\) \{[\s\S]{0,320}return -1;\s*\}/u,
    'every Linux provider stdio remap must be checked before exec',
  );
  const namespaceInit = sourceBetween(
    linux,
    'static int namespace_init(void *opaque)',
    'static int wait_for_init(',
    'Linux namespace init',
  );
  assert.match(
    namespaceInit,
    /if \(provider_pid == 0\) \{\s*if \(connect_provider_stdio\(\) < 0\) \{[\s\S]{0,240}_exit\(127\);\s*\}\s*execvp/u,
    'Linux must stop the child when provider stdio isolation fails before execvp',
  );

  const duplicateHandle = sourceBetween(
    windows,
    'static int duplicate_inheritable_standard_handle(',
    'static int prepare_provider_stdio(',
    'Windows inheritable-handle duplication',
  );
  assert.match(
    duplicateHandle,
    /if \(source == NULL \|\| source == INVALID_HANDLE_VALUE\) \{[\s\S]{0,160}return 0;\s*\}[\s\S]{0,120}return DuplicateHandle\([\s\S]{0,360}TRUE,\s*DUPLICATE_SAME_ACCESS\s*\) != 0;/u,
    'Windows standard-handle duplication must reject invalid handles and check DuplicateHandle',
  );
  const prepareStdio = sourceBetween(
    windows,
    'static int prepare_provider_stdio(',
    'static int terminate_process_and_wait(',
    'Windows provider stdio setup',
  );
  assert.match(
    prepareStdio,
    /if \(!duplicate_inheritable_standard_handle\(STD_INPUT_HANDLE, &provider_stdio->handles\[0\]\)\s*\|\| !duplicate_inheritable_standard_handle\(STD_ERROR_HANDLE, &provider_stdio->handles\[1\]\)\) \{\s*goto fail;\s*\}/u,
    'Windows provider stdin and stderr duplication must both fail closed',
  );
  assert.match(
    prepareStdio,
    /if \(!UpdateProcThreadAttribute\([\s\S]{0,360}PROC_THREAD_ATTRIBUTE_HANDLE_LIST,[\s\S]{0,280}\)\) \{\s*goto fail;\s*\}/u,
    'Windows inherited-handle allowlist installation must be checked',
  );
  assert.match(prepareStdio, /startup->lpAttributeList\s*=\s*provider_stdio->attributes/u,
    'Windows CreateProcess startup info must consume the checked handle allowlist');
  assert.match(prepareStdio, /startup->StartupInfo\.dwFlags\s*\|=\s*STARTF_USESTDHANDLES/u,
    'Windows provider standard handles must be explicit');
  assert.match(
    prepareStdio,
    /hStdInput\s*=\s*provider_stdio->handles\[0\][\s\S]{0,240}hStdOutput\s*=\s*provider_stdio->handles\[1\][\s\S]{0,240}hStdError\s*=\s*provider_stdio->handles\[1\]/u,
    'Windows provider stdout and stderr must use the provider output handle',
  );
  assert.doesNotMatch(windows, /STD_OUTPUT_HANDLE/u,
    'the Windows control stdout handle must never enter the provider handle set');
  const windowsMain = windows.slice(windows.indexOf('int wmain(int argc, wchar_t **argv)'));
  assert.match(
    windowsMain,
    /if \(!prepare_provider_stdio\(&startup, &provider_stdio\)\) \{[\s\S]{0,280}free\(command_line\);[\s\S]{0,120}CloseHandle\(job\);[\s\S]{0,120}return 125;\s*\}/u,
    'Windows must stop before CreateProcessW when explicit provider stdio setup fails',
  );
  assert.match(
    windowsMain,
    /CreateProcessW\([\s\S]{0,520}TRUE,[\s\S]{0,240}EXTENDED_STARTUPINFO_PRESENT[\s\S]{0,320}&startup\.StartupInfo/u,
    'Windows CreateProcessW must inherit only the explicit provider handle list',
  );
});

test('Linux preflight drain retries EINTR and fails closed on every other read error', () => {
  const linux = readFileSync(
    path.join(sourceRoot, nativeRelativeRoot, 'grok-linux-pidns-owner.c'),
    'utf8',
  );
  const drain = sourceBetween(
    linux,
    'static int drain_preflight_control(void)',
    'static int write_proc_file(',
    'Linux preflight control drain',
  );
  assert.match(
    drain,
    /for \(;;\) \{\s*const ssize_t received\s*=\s*read\(STDIN_FILENO, discard, sizeof\(discard\)\);\s*if \(received > 0\) continue;\s*if \(received == 0\) return 0;\s*if \(received < 0 && errno == EINTR\) continue;\s*return -1;\s*\}/u,
    'Linux preflight drain must accept only EOF, retry only EINTR and reject every other read result',
  );
  const namespaceInit = sourceBetween(
    linux,
    'static int namespace_init(void *opaque)',
    'static int wait_for_init(',
    'Linux namespace init',
  );
  assert.match(
    namespaceInit,
    /if \(context->command_argc == 0\) \{\s*if \(drain_preflight_control\(\) < 0\) \{\s*perror\([^;]+\);\s*return 125;\s*\}\s*emit_termination_report\(\);\s*return 0;\s*\}/u,
    'a preflight read error must not manufacture a termination report',
  );
});

test('Linux unexpected waitpid errors deliberately withhold the zero-member report', () => {
  const linux = readFileSync(
    path.join(sourceRoot, nativeRelativeRoot, 'grok-linux-pidns-owner.c'),
    'utf8',
  );
  const namespaceInit = sourceBetween(
    linux,
    'static int namespace_init(void *opaque)',
    'static int wait_for_init(',
    'Linux namespace init',
  );
  const reapLoop = sourceBetween(
    namespaceInit,
    'for (;;) {\n    int status = 0;',
    '/* waitpid(-1) == ECHILD',
    'Linux namespace reap loop',
  );
  assert.match(reapLoop, /const pid_t reaped\s*=\s*waitpid\(-1, &status, 0\)/u,
    'namespace PID 1 must wait for every reparented descendant');
  assert.match(
    reapLoop,
    /if \(reaped > 0\) \{[\s\S]{0,280}if \(reaped == provider_pid\) \{[\s\S]{0,200}provider_reaped = 1;\s*\}\s*continue;\s*\}/u,
    'reaping the provider must continue until the namespace member set reaches ECHILD',
  );
  assert.equal((reapLoop.match(/\bbreak;/gu) ?? []).length, 1,
    'only ECHILD may leave the namespace reap loop');
  assert.match(reapLoop, /if \(reaped < 0 && errno == EINTR\) continue;\s*if \(reaped < 0 && errno == ECHILD\) break;/u);
  assert.match(reapLoop, /not a zero-member proof/u,
    'the missing termination report must be an explicit safety decision');
  assert.doesNotMatch(reapLoop, /emit_termination_report/u,
    'an unexpected waitpid error cannot truthfully report zero members');
  assert.match(reapLoop, /perror\("grok-linux-pidns-owner: waitpid"\);\s*return 125;/u,
    'an unexpected waitpid error must fail instead of leaving the reap loop');
  assert.match(namespaceInit, /\/\* waitpid\(-1\) == ECHILD[\s\S]{0,320}emit_termination_report\(\)/u,
    'only the ECHILD zero-member proof may authorize the Linux termination report');
});

test('Windows assignment failure checks termination and waits before closing process handles', () => {
  const windows = readFileSync(
    path.join(sourceRoot, nativeRelativeRoot, 'grok-win32-job-owner.c'),
    'utf8',
  );
  const terminateAndWait = sourceBetween(
    windows,
    'static int terminate_process_and_wait(',
    'static void close_process(',
    'Windows suspended-process teardown',
  );
  assert.match(
    terminateAndWait,
    /\{\s*if \(!TerminateProcess\(process->hProcess, exit_code\)\) return 0;\s*return WaitForSingleObject\(process->hProcess, INFINITE\) == WAIT_OBJECT_0;\s*\}/u,
    'TerminateProcess failure must return before the suspended-process wait',
  );
  const windowsMain = windows.slice(windows.indexOf('int wmain(int argc, wchar_t **argv)'));
  assert.match(
    windowsMain,
    /if \(!AssignProcessToJobObject\(job, process\.hProcess\)\) \{[\s\S]{0,320}if \(!terminate_process_and_wait\(&process, 125U\)\) \{[\s\S]{0,240}\}[\s\S]{0,120}close_process\(&process\);/u,
    'assignment failure must use terminate-and-wait before handle close',
  );
});
