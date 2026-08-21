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
  realpathSync,
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
  gitResult,
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
  const canonicalSource = source.replace(/\r\n|\r/gu, '\n');
  const canonicalStart = start.replace(/\r\n|\r/gu, '\n');
  const canonicalEnd = end.replace(/\r\n|\r/gu, '\n');
  const startIndex = canonicalSource.indexOf(canonicalStart);
  assert.notEqual(startIndex, -1, `${label}: missing start marker ${canonicalStart}`);
  const endIndex = canonicalSource.indexOf(canonicalEnd, startIndex + canonicalStart.length);
  assert.notEqual(endIndex, -1, `${label}: missing end marker ${canonicalEnd}`);
  return canonicalSource.slice(startIndex, endIndex);
}

test('source-shape slicing treats checkout CRLF as formatting rather than C semantics', () => {
  assert.equal(
    sourceBetween('prefix\r\nstart\r\nbody\r\nend\r\n', 'start\nbody', 'end', 'CRLF source'),
    'start\nbody\n',
  );
});

test('the recursive legacy job fetches the pinned replay history it executes', () => {
  const workflow = readFileSync(path.join(sourceRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const legacy = workflowJob(workflow, 'legacy-unix');
  assert.match(legacy, /uses:\s*actions\/checkout@v4[\s\S]{0,120}fetch-depth:\s*0/u);
  assert.match(workflowStep(legacy, 'Run recursive legacy oracle'), /run:\s*npm run test:legacy/u);
});

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
  const load = (relativePath) => import(pathToFileURL(
    path.join(installedRoot, ...relativePath.split('/')),
  ).href);
  return {
    adaptive: await load('hooks/scripts/lib/adaptive-review-routing.mjs'),
    capabilities: await load('hooks/scripts/lib/capability-registry.mjs'),
    compatibility: await load('hooks/scripts/lib/grok-compatibility-carrier.mjs'),
    detect: await load('hooks/scripts/detect-environment.mjs'),
    document: await load('hooks/scripts/document-readiness.mjs'),
    executionPlan: await load('hooks/scripts/lib/execution-plan.mjs'),
    grok: await load('hooks/scripts/run-grok-reviewer.mjs'),
    modelRouter: await load('hooks/scripts/lib/model-router.mjs'),
    mutation: await load('hooks/scripts/mutation-protocol.mjs'),
    phase6: await load('hooks/scripts/phase6-protocol.mjs'),
    route: await load('hooks/scripts/public-route.mjs'),
    supervisor: await load('hooks/scripts/lib/grok-process-supervisor.mjs'),
    synthesis: await load('hooks/scripts/review-synthesis.mjs'),
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

const smokeReviewers = Object.freeze([
  {
    id: 'claude-opus', provider: 'claude', adapter_id: 'claude-cli', role: 'standard',
    assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    id: 'codex-review', provider: 'codex', adapter_id: 'codex-native-generic', role: 'standard',
    assignment_roles: ['standard', 'feasibility', 'traceability', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    id: 'codex-adversarial', provider: 'codex', adapter_id: 'codex-native-generic', role: 'adversarial',
    assignment_roles: ['adversarial', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    id: 'agy', provider: 'agy', adapter_id: 'agy-cli', role: 'standard',
    assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    id: 'grok', provider: 'grok', adapter_id: 'grok-cli', role: 'standard',
    assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
    last_status: 'success',
  },
]);

const smokeProviders = Object.freeze({
  'claude-opus': 'claude',
  'codex-review': 'codex',
  'codex-adversarial': 'codex',
  agy: 'agy',
  grok: 'grok',
});

const smokeFingerprint = Object.freeze({ mode: 'hybrid', digest: 'unchanged', error: null });
const smokeSessionId = '4d0b1f1a-9c2e-4c66-9b7c-1f2a3b4c5d6e';
const mutationPublicationRef = 'refs/worktree/deep-review/mutation/v3/publication';
const cadenceNormalizerStart = '<!-- ultracode-round-2-normalizer:start -->';
const cadenceNormalizerEnd = '<!-- ultracode-round-2-normalizer:end -->';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function findingCounts(findings) {
  return findings.reduce((counts, finding) => {
    counts[finding.severity] += 1;
    return counts;
  }, { critical: 0, warning: 0, info: 0 });
}

function smokeReviewerReport({
  reviewerId = 'codex-review',
  findings = [],
  includeGate = false,
  gateBody,
  verdict,
} = {}) {
  const counts = findingCounts(findings);
  const resolvedVerdict = verdict
    ?? (counts.critical > 0 ? 'REQUEST_CHANGES' : counts.warning > 0 ? 'CONCERN' : 'APPROVE');
  const findingLines = (severity, label) => {
    const count = counts[severity];
    return count === 0
      ? ['None.']
      : Array.from({ length: count }, (_, index) => `- ${label} ${index + 1}.`);
  };
  const lines = [
    '# Deep Review Report — 2026-08-20',
    '',
    '## Summary',
    '',
    `- **Verdict**: ${resolvedVerdict}`,
    `- **Issues**: 🔴 ${counts.critical}건, 🟡 ${counts.warning}건, ℹ️ ${counts.info}건`,
    '',
    '## Code Review',
    '',
    '### 🔴 Critical',
    '',
    ...findingLines('critical', 'Critical finding'),
    '',
    '### 🟡 Warning',
    '',
    ...findingLines('warning', 'Warning finding'),
    '',
    '### ℹ️ Info',
    '',
    ...findingLines('info', 'Info finding'),
    '',
    '### 🟢 Passed',
    '',
    `- ${reviewerId} production-path smoke.`,
    '',
  ];
  if (includeGate) {
    lines.push(
      '## Artifact Gate',
      '```json',
      typeof gateBody === 'string'
        ? gateBody
        : JSON.stringify({ schema_version: 1, findings }, null, 2),
      '```',
      '',
    );
  }
  return lines.join('\n');
}

function smokeGrokCarrier(runtime, binary) {
  const identity = process.platform === 'win32'
    ? { kind: 'win32-file-id-v1', fields: { final_path: binary, volume: '3', file_id: '4' } }
    : { kind: 'posix-dev-ino-v1', fields: { dev: '1', ino: '2', type: 'regular-file', uid: '0' } };
  const launcher = {
    path: binary,
    real_path: binary,
    platform_identity: identity,
    sha256: 'a'.repeat(64),
    size: 12,
    classification_purpose: process.platform === 'win32' ? null : 'effective-executable',
  };
  const chainBody = {
    schema_version: '1.0',
    prepared_kind: 'direct',
    launcher,
    shim: null,
    interpreter: null,
    shebang: null,
    posix_executable_type: process.platform === 'win32'
      ? null
      : process.platform === 'darwin' ? 'native-macho' : 'native-elf',
    native_loader: null,
  };
  const preparedSpawnChain = {
    ...chainBody,
    chain_sha256: sha256(Buffer.from(runtime.compatibility.canonicalStringify(chainBody), 'utf8')),
  };
  const evidence = {
    schema_version: '1.0',
    launcher_path: binary,
    real_path: binary,
    platform_identity: identity,
    executable_sha256: 'a'.repeat(64),
    executable_size: 12,
    prepared_spawn_chain: preparedSpawnChain,
    version: '1.0.4',
    version_build: 'd846eb93d94d',
    version_banner_sha256: 'b'.repeat(64),
    help_sha256: 'c'.repeat(64),
    help_size: 1024,
    required_help_flags: [
      '--cwd', '--max-turns', '--model', '--no-memory', '--no-subagents',
      '--output-format', '--permission-mode', '--prompt-file', '--reasoning-effort',
      '--sandbox', '--session-id', '--single',
    ],
  };
  return {
    ...evidence,
    evidence_sha256: sha256(Buffer.from(runtime.compatibility.canonicalStringify(evidence), 'utf8')),
  };
}

function smokePlan(runtime, {
  reviewers = smokeReviewers,
  artifactPhase = 'implementation',
  risk = 'low',
  grokCarrier = null,
} = {}) {
  const artifacts = [{
    path: artifactPhase === 'document' ? 'docs/plan.md' : 'src/change.js',
    target_kind: artifactPhase === 'document' ? 'implementation-plan' : 'code-change',
  }];
  const planned = runtime.adaptive.planReviewerAssignments({
    artifacts,
    risk,
    candidates: reviewers,
    reviewerStrategy: 'static',
    maximumReviewers: reviewers.length,
    progress: { state: 'initial', used_reviewers: [] },
  });
  const context = {
    artifact_phase: planned.artifact_phase,
    risk,
    document_review_mode: planned.document_review_mode,
  };
  const routes = planned.assignments.map((assignment) => ({
    ...assignment,
    resolved: {
      model: assignment.reviewer_id === 'grok' ? 'grok-4.6' : null,
      effort: 'high',
    },
    ...context,
    ...(assignment.reviewer_id === 'grok'
      ? { grok_compatibility_evidence: grokCarrier }
      : {}),
  }));
  return {
    protocol_version: '3.0',
    ...context,
    reviewer_strategy: 'static',
    shadow_mode: false,
    progress: planned.progress,
    candidate_reviewers: planned.candidate_reviewers,
    minimum_reviewers: planned.minimum_reviewers,
    maximum_reviewers: planned.maximum_reviewers,
    provider_family_minimum: planned.provider_family_minimum,
    planned_reviewers: planned.planned_reviewers,
    initial_reviewer_ids: planned.initial_reviewer_ids,
    required_reviewer_ids: planned.required_reviewer_ids,
    shortfalls: planned.shortfalls,
    confidence_floor: planned.confidence_floor,
    operational_failure: planned.operational_failure,
    max_expansion_waves: 1,
    routes,
  };
}

function attemptFromReport(runtime, reviewerId, output, fingerprints = {}) {
  return runtime.synthesis.evaluateReviewerAttempt({
    reviewer_id: reviewerId,
    role: reviewerId,
    output,
    beforeFingerprint: fingerprints.before ?? smokeFingerprint,
    afterFingerprint: fingerprints.after ?? smokeFingerprint,
  });
}

function executionRoute(plan, reviewerId) {
  const route = plan.routes.find((candidate) => candidate.reviewer_id === reviewerId);
  assert.ok(route, `missing route for ${reviewerId}`);
  return { protocol_version: '3.0', ...route };
}

function trustedDispatch(runtime, plan, attempts, sessions = {}) {
  const records = attempts.map((attempt) => {
    const route = executionRoute(plan, attempt.reviewer_id);
    return {
      attempt_id: `attempt-${attempt.reviewer_id}`,
      reviewer_id: attempt.reviewer_id,
      provider_family: smokeProviders[attempt.reviewer_id],
      execution_route: route,
      route_sha256: sha256(runtime.document.canonicalStringify(route)),
      output_sha256: attempt.output_digest,
      model: route.resolved.model ?? null,
      session_id: sessions[attempt.reviewer_id] ?? `session-${attempt.reviewer_id}`,
      compatibility_evidence_sha256: route.grok_compatibility_evidence?.evidence_sha256 ?? null,
    };
  });
  return {
    round_id: 'round-smoke',
    routing_plan_sha256: sha256(runtime.document.canonicalStringify(plan)),
    records,
  };
}

function containedResult(stdout) {
  return {
    code: 0,
    timedOut: false,
    stdout: Buffer.from(stdout, 'utf8'),
    stderr: Buffer.alloc(0),
    termination_confirmed: true,
    termination_report: {
      owner_id: 'smoke-owner',
      generation: 1,
      live_members: 0,
      member_pids: [],
      observed_at: 1_700_000_000_100,
    },
  };
}

async function runInstalledGrok(runtime, {
  repo,
  installedRoot,
  output,
  artifactPhase = 'implementation',
  effort = 'high',
  body = 'review the production composition\n',
  fingerprintCapturer,
  duringProcess,
} = {}) {
  const binary = path.join(repo, process.platform === 'win32' ? 'grok.exe' : 'grok');
  writeFileSync(binary, 'not a real Grok executable\n');
  const carrier = smokeGrokCarrier(runtime, binary);
  const route = {
    protocol_version: '3.0',
    reviewer_id: 'grok',
    provider: 'grok',
    adapter_id: 'grok-cli',
    assignment_role: 'standard',
    rubric_id: 'standard-v1',
    wave: 1,
    required: false,
    selection_reason: 'SLICE-012 production composition',
    artifact_phase: artifactPhase,
    risk: 'low',
    document_review_mode: 'full-readiness',
    requested: {
      model: 'grok-4.6', effort, model_source: 'auto', effort_source: 'auto',
    },
    resolved: { model: 'grok-4.6', effort },
    grok_compatibility_evidence: carrier,
  };
  const promptFile = path.join(repo, 'smoke-prompt.md');
  writeFileSync(promptFile, body);
  const outputFile = path.join(fixtureRootFor(repo), `grok-output-${Date.now()}-${Math.random()}.md`);
  const calls = [];
  const containmentToken = runtime.supervisor.__testing.mintOwnerToken({
    platform: 'linux',
    arch: 'x64',
    ownerId: 'smoke-owner',
    generation: 1,
    startedAt: 1_700_000_000_000,
  });
  const options = {
    projectRoot: repo,
    pluginRoot: installedRoot,
    promptFile,
    outputFile,
    binary,
    executionPlan: runtime.executionPlan.parseExecutionRoute(route, 'grok'),
    containmentToken,
    privacyPreparer: async () => ({
      outcome: 'auto_ack', fingerprint: 'privacy-smoke', hits: [], error: null,
    }),
    uuidGenerator: () => smokeSessionId,
    processRunner: async (command, args, processOptions) => {
      calls.push({ command, args, options: processOptions });
      await duringProcess?.({ command, args, options: processOptions });
      return containedResult(output);
    },
    ...(fingerprintCapturer === null
      ? {}
      : { fingerprintCapturer: fingerprintCapturer ?? (async () => ({ ...smokeFingerprint })) }),
  };
  const result = await runtime.grok.runGrokReviewer(options);
  return { binary, calls, carrier, containmentToken, outputFile, result, route };
}

function prepareDocumentRepo(label = 'document smoke') {
  const repo = createGitFixture(label);
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  mkdirSync(path.join(repo, '.deep-review', 'reports'), { recursive: true });
  mkdirSync(path.join(repo, '.deep-review', 'tmp', 'reviewer-reports'), { recursive: true });
  writeFileSync(path.join(repo, 'docs', 'plan.md'), '# Plan\n\nImplement the verified change.\n');
  return repo;
}

function writeTrustedReport(repo, name, output, { privateReport = false } = {}) {
  const relative = privateReport
    ? path.join('.deep-review', 'tmp', 'reviewer-reports', name)
    : path.join('.deep-review', 'reports', name);
  const target = path.join(repo, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, output);
  return target;
}

function implementationPlan(runtime) {
  return smokePlan(runtime, { reviewers: smokeReviewers.slice(0, 2) });
}

function deferredCollisionFixture(runtime, label) {
  const repo = prepareDocumentRepo(label);
  const claudeFinding = {
    id: 'DOC-1',
    severity: 'warning',
    stage: 'implementation_verification',
    acceptance_evidence: ['claude: migration dry-run passes'],
  };
  const codexFinding = {
    id: 'DOC-1',
    severity: 'warning',
    stage: 'implementation_verification',
    acceptance_evidence: ['codex: rollback restores the prior schema'],
  };
  const claudePath = writeTrustedReport(repo, 'claude-collision-review.md', smokeReviewerReport({
    reviewerId: 'claude-opus', findings: [claudeFinding], includeGate: true,
  }));
  const codexPath = writeTrustedReport(repo, 'codex-collision-review.md', smokeReviewerReport({
    reviewerId: 'codex-review', findings: [codexFinding], includeGate: true,
  }));
  const created = runtime.document.createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/plan.md', target_kind: 'implementation-plan' }],
    reports: [
      { path: claudePath, reviewer_id: 'claude-opus', provider_family: 'claude' },
      { path: codexPath, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    risk: 'low',
    generatedAt: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(created.status, 'READY_FOR_IMPLEMENTATION');
  const verified = runtime.document.verifyReadinessReceipt({
    repo,
    receiptPath: created.receipt_path,
  });
  writeFileSync(path.join(repo, 'implementation.js'), 'export const migrated = true;\n');
  writeFileSync(path.join(repo, 'migration-test.tap'), 'ok 1 - migration rollback roundtrip\n');
  const implementationArtifacts = [{ path: 'implementation.js' }];
  const pending = runtime.document.evaluateDeferredAcceptance({
    receipt: verified.receipt,
    verifiedItems: [],
    repo,
    implementationArtifacts,
  });
  const evidenceSha256 = sha256(readFileSync(path.join(repo, 'migration-test.tap')));
  const refs = {
    claude: { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
    codex: { finding_id: 'DOC-1', reviewer_id: 'codex-review' },
  };
  const verification = (findingRef, criterion) => ({
    finding_ref: findingRef,
    implementation_scope_sha256: pending.implementation_scope_sha256,
    verification_results: [{
      criterion,
      status: 'passed',
      evidence_path: 'migration-test.tap',
      evidence_sha256: evidenceSha256,
    }],
  });
  const acceptance = (verifiedItems) => runtime.document.evaluateDeferredAcceptance({
    receipt: verified.receipt,
    verifiedItems,
    repo,
    implementationArtifacts,
    implementationScopeSha256: pending.implementation_scope_sha256,
  });
  return {
    repo,
    created,
    verified,
    implementationArtifacts,
    pending,
    refs,
    claudeItem: verification(refs.claude, claudeFinding.acceptance_evidence[0]),
    codexItem: verification(refs.codex, codexFinding.acceptance_evidence[0]),
    acceptance,
  };
}

function mutationProtocolSnapshot(repo) {
  const reviewRoot = path.join(repo, '.deep-review');
  const files = {};
  if (existsSync(reviewRoot)) {
    for (const name of readdirSync(reviewRoot).sort()) {
      if (!/^\.pending-mutation\.v3\.[ab]\.json$/u.test(name)) continue;
      files[name] = readFileSync(path.join(reviewRoot, name)).toString('base64');
    }
  }
  const ref = gitResult(repo, ['rev-parse', '--verify', mutationPublicationRef]);
  const oid = ref.code === 0 ? ref.stdout.toString('utf8').trim() : null;
  const bytes = oid === null
    ? null
    : gitResult(repo, ['cat-file', 'blob', oid]).stdout.toString('base64');
  return { oid, bytes, files };
}

function legacyDuplicateReceipt(runtime, label) {
  const repo = prepareDocumentRepo(label);
  const finding = {
    id: 'DOC-1',
    severity: 'warning',
    stage: 'implementation_verification',
    acceptance_evidence: ['migration dry-run passes'],
  };
  const gate = { schema_version: 1, findings: [finding] };
  const claudeOutput = `${smokeReviewerReport({
    reviewerId: 'claude-opus', findings: [finding], includeGate: true,
  })}<!-- claude legacy identity -->\n`;
  const codexOutput = `${smokeReviewerReport({
    reviewerId: 'codex-review', findings: [finding], includeGate: true,
  })}<!-- codex legacy identity -->\n`;
  const claudePath = writeTrustedReport(repo, 'legacy-claude-review.md', claudeOutput);
  const codexPath = writeTrustedReport(repo, 'legacy-codex-review.md', codexOutput);
  const documentBytes = readFileSync(path.join(repo, 'docs', 'plan.md'));
  const documents = [{
    byte_size: documentBytes.length,
    path: 'docs/plan.md',
    sha256: sha256(documentBytes),
    target_kind: 'implementation-plan',
  }];
  const canonical = runtime.document.canonicalStringify;
  const scopeSha256 = sha256(Buffer.from(canonical(documents.map((entry) => ({
    path: entry.path,
    target_kind: entry.target_kind,
    sha256: entry.sha256,
  }))), 'utf8'));
  const record = (relativePath, reviewerId, providerFamily, output) => ({
    artifact_gate_sha256: sha256(Buffer.from(canonical(gate), 'utf8')),
    path: `.deep-review/reports/${relativePath}`,
    provider_family: providerFamily,
    reviewer_id: reviewerId,
    sha256: sha256(Buffer.from(output, 'utf8')),
  });
  const body = {
    deferred_findings: [{
      acceptance_evidence: [...finding.acceptance_evidence],
      finding_id: finding.id,
      severity: finding.severity,
    }],
    documents,
    generated_at: '2026-08-20T00:00:00.000Z',
    reports: [
      record(path.basename(claudePath), 'claude-opus', 'claude', claudeOutput),
      record(path.basename(codexPath), 'codex-review', 'codex', codexOutput),
    ],
    repository_identity_sha256: sha256(Buffer.from(realpathSync(repo), 'utf8')),
    reviewer_requirements: {
      actual_provider_families: 2,
      actual_reviewers: 2,
      provider_family_minimum: 2,
      required_reviewers: 2,
    },
    risk: 'low',
    schema_version: '1.0',
    scope_sha256: scopeSha256,
    status: 'READY_FOR_IMPLEMENTATION',
  };
  const receipt = {
    ...body,
    receipt_sha256: sha256(Buffer.from(canonical(body), 'utf8')),
  };
  const receiptDirectory = path.join(repo, '.deep-review', 'receipts', 'document-readiness');
  mkdirSync(receiptDirectory, { recursive: true });
  const receiptPath = path.join(receiptDirectory, `${scopeSha256}-${receipt.receipt_sha256}.json`);
  writeFileSync(receiptPath, `${canonical(receipt)}\n`);
  return { repo, receiptPath };
}

function cadenceNormalizer(installedRoot, relativePath) {
  const source = readInstalled(installedRoot, relativePath).replace(/\r\n|\r/gu, '\n');
  const start = source.indexOf(cadenceNormalizerStart);
  const end = source.indexOf(cadenceNormalizerEnd);
  assert.notEqual(start, -1, `${relativePath}: cadence normalizer start marker`);
  assert.notEqual(end, -1, `${relativePath}: cadence normalizer end marker`);
  const block = source.slice(start + cadenceNormalizerStart.length, end).trim();
  const match = block.match(/^```javascript\n([\s\S]+)\n```$/u);
  assert.ok(match, `${relativePath}: cadence normalizer JavaScript fence`);
  return Function(`"use strict"; return (${match[1]});`)();
}

function writeFakeGrok(repo) {
  const bin = path.join(fixtureRootFor(repo), `grok-bin-${Date.now()}-${Math.random()}`);
  mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, process.platform === 'win32' ? 'grok.cmd' : 'grok');
  if (process.platform === 'win32') {
    writeFileSync(executable, '@echo off\r\nexit /b 0\r\n');
  } else {
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
  }
  return { bin, executable };
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

test('a five-candidate round with a trusted grok voice reaches the production approval path and supplies cardinality-generic synthesis counts', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const grokOutput = smokeReviewerReport({ reviewerId: 'grok' });
  const bridge = await runInstalledGrok(runtime, {
    repo, installedRoot, output: grokOutput,
  });
  assert.equal(bridge.result.status, 'success');
  assert.equal(bridge.result.contributes_vote, true);

  const plan = smokePlan(runtime, { grokCarrier: bridge.carrier });
  assert.equal(plan.candidate_reviewers.length, 5);
  assert.equal(plan.routes.length, 5);
  const outputs = new Map(smokeReviewers.map(({ id }) => [
    id,
    id === 'grok' ? bridge.result.raw_stdout : smokeReviewerReport({ reviewerId: id }),
  ]));
  const attempts = smokeReviewers.map(({ id }) => attemptFromReport(runtime, id, outputs.get(id)));
  assert.ok(attempts.every((attempt) => attempt.included === true));
  const result = runtime.synthesis.synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: plan,
    dispatch: trustedDispatch(runtime, plan, attempts, {
      grok: bridge.result.session_isolation.session_id,
    }),
  });
  assert.equal(result.status, 'reviewed');
  assert.equal(result.verdict, 'APPROVE');
  assert.equal(result.phase6_allowed, true);
  assert.equal(result.n_actual, smokeReviewers.length);
  assert.equal(result.provider_families, new Set(smokeReviewers.map(({ provider }) => provider)).size);
  assert.equal(result.readiness_admission.records.length, smokeReviewers.length);
});

test('a document-phase five-voice round admits Grok only through the canonical gate parser', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'docs', 'plan.md'), '# Plan\n\nFive-voice readiness.\n');
  const outputs = new Map(smokeReviewers.map(({ id }) => [
    id,
    smokeReviewerReport({ reviewerId: id, includeGate: true }),
  ]));
  const bridge = await runInstalledGrok(runtime, {
    repo,
    installedRoot,
    artifactPhase: 'document',
    output: outputs.get('grok'),
  });
  assert.equal(bridge.result.status, 'success');
  assert.deepEqual(runtime.document.parseArtifactGate(bridge.result.raw_stdout), {
    schema_version: 1,
    findings: [],
  });

  const plan = smokePlan(runtime, {
    artifactPhase: 'document',
    reviewers: smokeReviewers,
    grokCarrier: bridge.carrier,
  });
  const attempts = smokeReviewers.map(({ id }) => attemptFromReport(runtime, id, outputs.get(id)));
  const synthesis = runtime.synthesis.synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: plan,
    dispatch: trustedDispatch(runtime, plan, attempts, {
      grok: bridge.result.session_isolation.session_id,
    }),
  });
  assert.equal(synthesis.status, 'reviewed');
  assert.equal(synthesis.n_actual, 5);

  const reports = smokeReviewers.map(({ id }) => ({
    attempt_id: `attempt-${id}`,
    path: writeTrustedReport(
      repo,
      `round-smoke-${id}.md`,
      outputs.get(id),
      { privateReport: true },
    ),
    reviewer_id: id,
    provider_family: smokeProviders[id],
  }));
  let readiness;
  assert.doesNotThrow(() => {
    readiness = runtime.document.createDocumentReadinessReceipt({
      repo,
      artifacts: [{ path: 'docs/plan.md', target_kind: 'implementation-plan' }],
      reports,
      readinessAdmission: synthesis.readiness_admission,
      risk: 'low',
      requiredReviewers: 5,
      providerFamilyMinimum: 4,
      generatedAt: '2026-08-20T00:00:00.000Z',
    });
  }, 'the canonical Grok identity must reach readiness after its gate was parsed');
  assert.equal(readiness.status, 'READY_FOR_IMPLEMENTATION');
  assert.equal(readiness.reviewer_count, 5);
  assert.equal(readiness.provider_family_count, 4);
  assert.equal(runtime.document.verifyReadinessReceipt({
    repo,
    receiptPath: readiness.receipt_path,
  }).status, 'READY_FOR_IMPLEMENTATION');
});

test('a malformed Grok gate yields a stable exclusion and the correct floor result', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const malformed = smokeReviewerReport({ reviewerId: 'grok' });
  const bridge = await runInstalledGrok(runtime, {
    repo,
    installedRoot,
    artifactPhase: 'document',
    output: malformed,
  });
  assert.equal(bridge.result.status, 'failed');
  assert.equal(bridge.result.contributes_vote, false);

  let gateError;
  assert.throws(
    () => runtime.document.parseArtifactGate(malformed),
    (error) => {
      gateError = error;
      return error.code === runtime.document.ARTIFACT_GATE_ERROR_CODES.MISSING_GATE;
    },
  );
  assert.ok(bridge.result.warnings.some((warning) => warning.startsWith(`${gateError.code}:`)));
  const claudeOutput = smokeReviewerReport({ reviewerId: 'claude-opus', includeGate: true });
  const readiness = runtime.document.evaluateDocumentReadiness({
    reportEvidence: [{
      reviewer_id: 'claude-opus',
      provider_family: 'claude',
      artifact_gate: runtime.document.parseArtifactGate(claudeOutput),
    }],
    risk: 'high',
    requiredReviewers: 2,
    providerFamilyMinimum: 2,
    gateExclusions: [{
      code: gateError.code,
      path: '.deep-review/tmp/reviewer-reports/round-smoke-grok.md',
      provider_family: 'grok',
      reviewer_id: 'grok',
    }],
  });
  assert.deepEqual(readiness.gate_exclusions, [{
    code: runtime.document.ARTIFACT_GATE_ERROR_CODES.MISSING_GATE,
    path: '.deep-review/tmp/reviewer-reports/round-smoke-grok.md',
    provider_family: 'grok',
    reviewer_id: 'grok',
  }]);
  assert.equal(readiness.status, 'DOCUMENT_BLOCKED');
  assert.equal(readiness.reviewer_count, 1);
  assert.equal(readiness.provider_family_count, 1);
  assert.ok(readiness.blocking_reasons.includes('required_reviewers'));
  assert.ok(readiness.blocking_reasons.includes('provider_families'));
});

test('same-local-id pre-implementation blockers retain both reviewer-scoped refs', async () => {
  const { installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const repo = prepareDocumentRepo('same local blockers');
  const blocker = (reviewerId, evidence) => smokeReviewerReport({
    reviewerId,
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'pre_implementation',
      acceptance_evidence: [evidence],
    }],
    includeGate: true,
    verdict: 'REQUEST_CHANGES',
  });
  const claudePath = writeTrustedReport(repo, 'claude-blocker-review.md', blocker(
    'claude-opus',
    'claude: resolve the migration contradiction',
  ));
  const codexPath = writeTrustedReport(repo, 'codex-blocker-review.md', blocker(
    'codex-review',
    'codex: bound the retry budget',
  ));
  const readiness = runtime.document.createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/plan.md', target_kind: 'implementation-plan' }],
    reports: [
      { path: claudePath, reviewer_id: 'claude-opus', provider_family: 'claude' },
      { path: codexPath, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    risk: 'low',
  });
  assert.equal(readiness.status, 'DOCUMENT_BLOCKED');
  assert.deepEqual(readiness.blocking_finding_refs, [
    { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
    { finding_id: 'DOC-1', reviewer_id: 'codex-review' },
  ]);
  assert.deepEqual(readiness.blocking_finding_ids, ['DOC-1', 'DOC-1']);
});

test('same-local-id implementation-verification findings from two reviewers stay distinct in the sealed receipt, the deferred evaluator and synthesis output', async () => {
  const { installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const fixture = deferredCollisionFixture(runtime, 'deferred refs composition');
  assert.equal(fixture.verified.receipt.schema_version, '2.0');
  assert.match(fixture.verified.receipt.receipt_sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(fixture.verified.deferred_findings.map((finding) => finding.finding_ref), [
    fixture.refs.claude,
    fixture.refs.codex,
  ]);
  assert.deepEqual(fixture.pending.pending_finding_refs, [fixture.refs.claude, fixture.refs.codex]);
  const plan = implementationPlan(runtime);
  const attempts = ['claude-opus', 'codex-review'].map((reviewerId) => attemptFromReport(
    runtime,
    reviewerId,
    smokeReviewerReport({ reviewerId }),
  ));
  const synthesis = runtime.synthesis.synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: plan,
    deferredAcceptance: fixture.pending,
  });
  assert.equal(synthesis.verdict, 'CONCERN');
  assert.equal(synthesis.deferred_acceptance_floor, true);
  assert.deepEqual(synthesis.pending_deferred_finding_refs, [
    fixture.refs.claude,
    fixture.refs.codex,
  ]);
});

test('verifying one same-local-id finding keeps the other pending; verifying both alone removes the floor', async () => {
  const { installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const fixture = deferredCollisionFixture(runtime, 'deferred verification composition');
  const claudeOnly = fixture.acceptance([fixture.claudeItem]);
  assert.equal(claudeOnly.complete, false);
  assert.deepEqual(claudeOnly.pending_finding_refs, [fixture.refs.codex]);
  const codexOnly = fixture.acceptance([fixture.codexItem]);
  assert.equal(codexOnly.complete, false);
  assert.deepEqual(codexOnly.pending_finding_refs, [fixture.refs.claude]);

  const plan = implementationPlan(runtime);
  const attempts = ['claude-opus', 'codex-review'].map((reviewerId) => attemptFromReport(
    runtime,
    reviewerId,
    smokeReviewerReport({ reviewerId }),
  ));
  const onePending = runtime.synthesis.synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: plan,
    deferredAcceptance: claudeOnly,
  });
  assert.equal(onePending.verdict, 'CONCERN');
  assert.deepEqual(onePending.pending_deferred_finding_refs, [fixture.refs.codex]);

  const both = fixture.acceptance([fixture.claudeItem, fixture.codexItem]);
  assert.equal(both.complete, true);
  assert.deepEqual(both.pending_finding_refs, []);
  const cleared = runtime.synthesis.synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: plan,
    deferredAcceptance: both,
  });
  assert.equal(cleared.verdict, 'APPROVE');
  assert.equal(cleared.deferred_acceptance_floor, false);
  assert.deepEqual(cleared.pending_deferred_finding_refs ?? [], []);
});

test('a sealed schema-1.0 identical-duplicate receipt remains one legacy-global obligation', async () => {
  const { installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const fixture = legacyDuplicateReceipt(runtime, 'legacy global composition');
  const beforeDigest = sha256(readFileSync(fixture.receiptPath));
  const verified = runtime.document.verifyReadinessReceipt({
    repo: fixture.repo,
    receiptPath: fixture.receiptPath,
  });
  assert.deepEqual(verified.deferred_findings, [{
    acceptance_evidence: ['migration dry-run passes'],
    finding_ref: { finding_id: 'DOC-1', scope: 'legacy_global' },
    severity: 'warning',
  }]);
  writeFileSync(path.join(fixture.repo, 'implementation.js'), 'export const migrated = true;\n');
  const pending = runtime.document.evaluateDeferredAcceptance({
    receipt: verified,
    verifiedItems: [],
    repo: fixture.repo,
    implementationArtifacts: [{ path: 'implementation.js' }],
  });
  assert.equal(pending.required_count, 1);
  assert.deepEqual(pending.pending_finding_refs, [{
    finding_id: 'DOC-1', scope: 'legacy_global',
  }]);
  assert.equal(sha256(readFileSync(fixture.receiptPath)), beforeDigest);
});

test('T-SMOKE-2: visible Grok mutation excludes the voice and blocks Phase 6', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const bridge = await runInstalledGrok(runtime, {
    repo,
    installedRoot,
    output: smokeReviewerReport({ reviewerId: 'grok' }),
    fingerprintCapturer: null,
    duringProcess: async () => {
      writeFileSync(path.join(repo, 'grok-visible-mutation.txt'), 'untrusted mutation\n');
    },
  });
  assert.equal(existsSync(path.join(repo, 'grok-visible-mutation.txt')), true);
  assert.equal(bridge.result.status, 'mutated');
  assert.equal(bridge.result.contributes_vote, false);
  const attempt = attemptFromReport(runtime, 'grok', bridge.result.raw_stdout, {
    before: bridge.result.before,
    after: bridge.result.after,
  });
  assert.equal(attempt.included, false);
  assert.equal(attempt.exclusion, 'fingerprint_mismatch');
  const synthesis = runtime.synthesis.synthesizeReviewAttempts([attempt]);
  assert.equal(synthesis.n_actual, 0);
  assert.equal(synthesis.verdict, null);
  assert.equal(synthesis.phase6_allowed, false);
  assert.deepEqual(synthesis.exclusions, [{ role: 'grok', reason: 'fingerprint_mismatch' }]);
});

test('a no-flag round creates no Grok process or state', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const parsed = runtime.route.parsePublicRoute({
    entry: 'review', host: 'claude', cwd: repo, argv: [],
  });
  assert.equal(parsed.ok, true);
  const overrides = parsed.overrides ?? { providers: {}, reviewers: {} };
  const candidacy = runtime.route.effectiveGrokCandidacy(parsed.argv, overrides);
  const fake = writeFakeGrok(repo);
  const calls = [];
  const environment = await runtime.detect.detectEnvironment({
    cwd: repo,
    env: {
      ...process.env,
      PLUGIN_ROOT: installedRoot,
      PATH: [fake.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    },
    grokCandidate: candidacy,
    processRunner: async (...args) => {
      calls.push(args[1]);
      return {
        code: 0,
        timedOut: false,
        captureOverflow: false,
        stdout: Buffer.from('unexpected Grok probe\n'),
        stderr: Buffer.alloc(0),
      };
    },
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(Object.keys(environment).filter((key) => key.startsWith('grok_')), []);
  assert.equal(overrides.enabled_providers?.includes('grok') ?? false, false);
  assert.equal(overrides.required_providers?.includes('grok') ?? false, false);
  assert.equal(Object.hasOwn(overrides.providers, 'grok'), false);
  assert.equal(Object.hasOwn(overrides.reviewers, 'grok'), false);
});

test('every Grok argv carries one adjacent model pair and one non-null effort', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const fakeBinary = path.join(repo, process.platform === 'win32' ? 'grok.exe' : 'grok');
  writeFileSync(fakeBinary, 'not a real Grok executable\n');
  const carrier = smokeGrokCarrier(runtime, fakeBinary);
  const grokCapability = runtime.capabilities.buildCapabilities({
    detected: {
      grok_cli: true,
      grok_cli_path: fakeBinary,
      grok_version: '1.0.4',
      grok_compatibility_verified: true,
      grok_compatibility_evidence: carrier,
    },
    containment: { platform: 'linux', arch: 'x64' },
  }).find((capability) => capability.adapter_id === 'grok-cli');

  for (const effort of runtime.grok.GROK_SUPPORTED_EFFORTS) {
    const routed = runtime.modelRouter.routeReviewer({
      unit: { path: 'src/change.js', target_kind: 'code-change' },
      reviewer: {
        id: 'grok',
        provider: 'grok',
        adapter_id: 'grok-cli',
        role: 'standard',
        assignment_role: 'standard',
      },
      risk: 'low',
      size: 'small',
      policy: {},
      overrides: { providers: { grok: { effort } } },
      capabilities: [grokCapability],
      artifactPhase: 'implementation',
      documentReviewMode: 'full-readiness',
    });
    const output = smokeReviewerReport({ reviewerId: 'grok' });
    const bridge = await runInstalledGrok(runtime, {
      repo,
      installedRoot,
      output,
      effort: routed.resolved.effort,
    });
    assert.equal(bridge.calls.length, 1, effort);
    const args = bridge.calls[0].args;
    const modelIndexes = args.flatMap((token, index) => token === '--model' ? [index] : []);
    const effortIndexes = args.flatMap(
      (token, index) => token === '--reasoning-effort' ? [index] : [],
    );
    assert.equal(modelIndexes.length, 1, `${effort}: model pair count`);
    assert.equal(args[modelIndexes[0] + 1], 'grok-4.6', `${effort}: adjacent model value`);
    assert.equal(effortIndexes.length, 1, `${effort}: effort pair count`);
    assert.equal(args[effortIndexes[0] + 1], routed.resolved.effort, `${effort}: adjacent effort value`);
    assert.notEqual(bridge.result.resolved_effort, null, effort);
  }
});

test('an incompatible Grok version or help yields no candidate and no bridge spawn', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const parsed = runtime.route.parsePublicRoute({
    entry: 'review', host: 'claude', cwd: repo, argv: ['--grok'],
  });
  assert.equal(parsed.ok, true);
  assert.equal(runtime.route.effectiveGrokCandidacy(parsed.argv, parsed.overrides), true);
  const fake = writeFakeGrok(repo);
  const requiredHelp = [
    '--single', '--prompt-file', '--model', '--reasoning-effort', '--permission-mode',
    '--sandbox', '--cwd', '--output-format', '--max-turns', '--session-id',
    '--no-memory', '--no-subagents',
  ].join(' ');

  for (const [label, version, help] of [
    ['version', 'grok 1.0.5 (future) [stable]\n', `${requiredHelp}\n`],
    ['help', 'grok 1.0.4 (d846eb93d94d) [stable]\n', '--single --model\n'],
  ]) {
    const probes = [];
    const detected = await runtime.detect.detectEnvironment({
      cwd: repo,
      env: {
        ...process.env,
        PLUGIN_ROOT: installedRoot,
        PATH: [fake.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      },
      grokCandidate: true,
      processRunner: async (_command, args) => {
        probes.push(args);
        return {
          code: 0,
          timedOut: false,
          captureOverflow: false,
          stdout: Buffer.from(args[0] === '--version' ? version : help),
          stderr: Buffer.alloc(0),
        };
      },
    });
    const grokCapability = runtime.capabilities.buildCapabilities({
      detected,
      containment: { platform: 'linux', arch: 'x64' },
    }).find((capability) => capability.adapter_id === 'grok-cli');
    let bridgeSpawns = 0;
    if (grokCapability.available === true) bridgeSpawns += 1;
    assert.deepEqual(probes, [['--version'], ['--help']], label);
    assert.equal(detected.grok_unavailable_reason, 'incompatible_grok_cli', label);
    assert.equal(grokCapability.available, false, label);
    assert.equal(grokCapability.read_only_enforcement, 'none', label);
    assert.equal(bridgeSpawns, 0, label);
  }
});

test('an admitted Grok voice carries receipt-bound fresh-session controls', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const output = smokeReviewerReport({ reviewerId: 'grok' });
  const bridge = await runInstalledGrok(runtime, { repo, installedRoot, output });
  assert.equal(bridge.result.status, 'success');
  const args = bridge.calls[0].args;
  assert.equal(args.filter((token) => token === '--session-id').length, 1);
  assert.equal(args[args.indexOf('--session-id') + 1], smokeSessionId);
  assert.equal(args.filter((token) => token === '--no-memory').length, 1);
  assert.equal(args.filter((token) => token === '--no-subagents').length, 1);
  const plan = smokePlan(runtime, {
    reviewers: smokeReviewers.filter(({ id }) => id === 'grok'),
    grokCarrier: bridge.carrier,
  });
  const attempt = attemptFromReport(runtime, 'grok', bridge.result.raw_stdout);
  const dispatch = trustedDispatch(runtime, plan, [attempt], {
    grok: bridge.result.session_isolation.session_id,
  });
  const synthesis = runtime.synthesis.synthesizeReviewRound({
    attempts: [attempt],
    routingPlan: plan,
    dispatch,
  });
  assert.equal(synthesis.status, 'reviewed');
  assert.equal(synthesis.readiness_admission.records.length, 1);
  assert.equal(synthesis.readiness_admission.records[0].attempt_id, 'attempt-grok');
  const replay = structuredClone(dispatch);
  replay.records[0].session_id = '';
  const rejected = runtime.synthesis.synthesizeReviewRound({
    attempts: [attempt], routingPlan: plan, dispatch: replay,
  });
  assert.equal(rejected.error, 'invalid_readiness_admission');
  assert.equal(rejected.readiness_admission_error, 'session_identity_invalid');
  assert.equal(Object.hasOwn(rejected, 'readiness_admission'), false);
});

test('equal report bytes under two distinct reviewer/path identities survive readiness', async () => {
  const { installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const repo = prepareDocumentRepo('equal report identity composition');
  const output = smokeReviewerReport({ reviewerId: 'shared-byte-report', includeGate: true });
  const plan = smokePlan(runtime, {
    reviewers: smokeReviewers.slice(0, 2),
    artifactPhase: 'document',
  });
  const attempts = ['claude-opus', 'codex-review'].map((reviewerId) => (
    attemptFromReport(runtime, reviewerId, output)
  ));
  assert.equal(attempts[0].output_digest, attempts[1].output_digest);
  const synthesis = runtime.synthesis.synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: plan,
    dispatch: trustedDispatch(runtime, plan, attempts),
  });
  const reports = ['claude-opus', 'codex-review'].map((reviewerId) => ({
    attempt_id: `attempt-${reviewerId}`,
    path: writeTrustedReport(
      repo,
      `round-equal-${reviewerId}.md`,
      output,
      { privateReport: true },
    ),
    reviewer_id: reviewerId,
    provider_family: smokeProviders[reviewerId],
  }));
  const readiness = runtime.document.createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/plan.md', target_kind: 'implementation-plan' }],
    reports,
    readinessAdmission: synthesis.readiness_admission,
    risk: 'low',
    requiredReviewers: 2,
    providerFamilyMinimum: 2,
    generatedAt: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(readiness.status, 'READY_FOR_IMPLEMENTATION');
  const verified = runtime.document.verifyReadinessReceipt({
    repo,
    receiptPath: readiness.receipt_path,
  });
  assert.equal(verified.receipt.reports.length, 2);
  assert.equal(verified.receipt.reports[0].sha256, verified.receipt.reports[1].sha256);
  assert.notEqual(verified.receipt.reports[0].path, verified.receipt.reports[1].path);
  assert.notEqual(verified.receipt.reports[0].reviewer_id, verified.receipt.reports[1].reviewer_id);
});

test('an above-budget Grok prompt reaches the process seam losslessly', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const sentinel = `BEGIN-ABOVE-BUDGET\n${'Ω'.repeat(120 * 1024)}\nEND-ABOVE-BUDGET\n`;
  let observed = null;
  const bridge = await runInstalledGrok(runtime, {
    repo,
    installedRoot,
    output: smokeReviewerReport({ reviewerId: 'grok' }),
    body: sentinel,
    duringProcess: async ({ args }) => {
      const promptPath = args[args.indexOf('--prompt-file') + 1];
      observed = readFileSync(promptPath);
    },
  });
  assert.equal(bridge.result.status, 'success');
  assert.equal(bridge.result.prompt_transport, 'prompt-file');
  assert.equal(bridge.calls[0].args.filter((token) => token === '--prompt-file').length, 1);
  assert.equal(bridge.calls[0].args.includes('--single'), false);
  assert.notEqual(observed, null);
  assert.equal(observed.length, bridge.result.prompt_bytes);
  assert.equal(sha256(observed), bridge.result.prompt_sha256);
  assert.equal(observed.toString('utf8').endsWith(sentinel), true);
  assert.equal(bridge.result.truncated, false);
});

test('round-2 derived argv stays parseable after Grok selector stripping', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const authorities = [
    'skills/deep-review-loop/SKILL.md',
    'skills/deep-review-workflow/references/ultracode-integration.md',
  ].map((relativePath) => cadenceNormalizer(installedRoot, relativePath));
  const original = [
    '--entropy',
    '--ultracode',
    '--grok',
    '--model', 'codex=keep--grok-literal',
    '--reviewer-effort', 'grok=high',
  ];
  const derived = authorities.map((normalize) => normalize([...original]));
  assert.deepEqual(derived[0], derived[1]);
  for (const argv of derived) {
    assert.equal(argv.filter((token) => token === '--no-grok').length, 1);
    assert.equal(argv.includes('--grok'), false);
    assert.equal(argv.includes('grok=high'), false);
    assert.ok(argv.includes('codex=keep--grok-literal'));
    const parsed = runtime.route.parsePublicRoute({
      entry: 'review', host: 'claude', cwd: repo, argv,
    });
    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(parsed.overrides.disabled_providers.includes('grok'), true);
    assert.equal(parsed.overrides.enabled_providers?.includes('grok') ?? false, false);
  }
});

test('T-MUT-1: Grok review leaves persisted mutation ownership unchanged', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  writeFileSync(path.join(repo, 'mutation-owned.txt'), 'candidate mutation\n');
  assert.equal(runtime.mutation.ensureCutover({ repo }).status, 'ready');
  const performed = runtime.mutation.performMutation({
    repo,
    files: ['mutation-owned.txt'],
    ownerToken: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(performed.status, 'committed');
  const inspectionBefore = runtime.mutation.inspectProtocol({ repo });
  assert.equal(inspectionBefore.status, 'ready');
  assert.equal(inspectionBefore.selectedRecord.owner_token, performed.owner_token);
  const persistedBefore = mutationProtocolSnapshot(repo);

  const bridge = await runInstalledGrok(runtime, {
    repo,
    installedRoot,
    output: smokeReviewerReport({ reviewerId: 'grok' }),
  });
  assert.equal(bridge.result.status, 'success');
  assert.deepEqual(
    mutationProtocolSnapshot(repo),
    persistedBefore,
    'a read-only Grok review must not rewrite persisted mutation ownership',
  );
  const inspectionAfter = runtime.mutation.inspectProtocol({ repo });
  assert.equal(inspectionAfter.selectedRecord.owner_token, performed.owner_token);
  assert.equal(inspectionAfter.selectedRecord.session_id, inspectionBefore.selectedRecord.session_id);
  assert.equal(runtime.mutation.restoreMutation({
    repo,
    ownerToken: performed.owner_token,
  }).status, 'restored');
});

test('T-SMOKE-3: Phase 6 remains gated by synthesized approval', async () => {
  const { repo, installedRoot } = installPluginFixture();
  const runtime = await loadInstalledRuntime(installedRoot);
  const headBefore = git(repo, ['rev-parse', 'HEAD']);
  const bridge = await runInstalledGrok(runtime, {
    repo,
    installedRoot,
    output: 'not a canonical review report\n',
  });
  assert.equal(bridge.result.status, 'failed');
  const attempt = attemptFromReport(runtime, 'grok', bridge.result.raw_stdout, {
    before: bridge.result.before,
    after: bridge.result.after,
  });
  const synthesis = runtime.synthesis.synthesizeReviewAttempts([attempt]);
  assert.equal(synthesis.status, 'operational_failure');
  assert.equal(synthesis.verdict, null);

  let phase6Calls = 0;
  if (synthesis.phase6_allowed === true) {
    phase6Calls += 1;
    runtime.phase6.snapshotPhase6({
      repo,
      severity: 'warning',
      acceptedItems: [{
        item_id: 'SMOKE-3',
        target_location: 'tracked.txt',
        modifiable_paths: [],
      }],
    });
  }
  assert.equal(phase6Calls, 0, 'Phase 6 must not start without synthesized approval');
  assert.equal(
    existsSync(path.join(repo, '.deep-review', 'tmp', 'phase6-warning.snapshot.json')),
    false,
  );
  assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
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
