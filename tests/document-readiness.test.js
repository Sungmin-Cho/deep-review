'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const readinessUrl = pathToFileURL(path.join(root, 'hooks/scripts/document-readiness.mjs')).href;
const payloadUrl = pathToFileURL(path.join(root, 'hooks/scripts/build-reviewer-payload.mjs')).href;
const synthesisUrl = pathToFileURL(path.join(root, 'hooks/scripts/review-synthesis.mjs')).href;

function repoFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-readiness-'));
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.deep-review', 'reports'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', '계획 Ω.md'), '# Plan\n\nImplement the safe migration.\n');
  return repo;
}

function report({
  verdict = 'CONCERN',
  critical = 0,
  warning = 1,
  info = 0,
  findings = [{
    id: 'DOC-1',
    severity: 'warning',
    stage: 'implementation_verification',
    acceptance_evidence: ['migration dry-run passes and rollback restores the prior schema'],
  }],
} = {}) {
  return [
    '# Deep Review Report — 2026-07-24',
    '',
    '## Summary',
    `- **Verdict**: ${verdict}`,
    `- **Issues**: 🔴 ${critical}건, 🟡 ${warning}건, ℹ️ ${info}건`,
    '',
    '## Artifact Gate',
    '```json',
    JSON.stringify({ schema_version: 1, findings }, null, 2),
    '```',
    '',
  ].join('\n');
}

function writeReport(repo, name, contents) {
  const file = path.join(repo, '.deep-review', 'reports', name);
  fs.writeFileSync(file, contents);
  return file;
}

function canonicalJsonV22(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV22).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('unsupported canonical JSON value');
  const keys = Object.keys(value).sort((left, right) => Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8'),
  ));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonV22(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// The same sealed Warning/advisory evidence under either receipt label. The
// `1.0` arm is the genuine pre-2.3 artifact; the `2.0` arm is the same bytes
// relabelled, which is exactly the input that must now be read strictly.
function historicalV22Fixture(schemaVersion = '1.0') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-readiness-v22-'));
  const sourceRoot = path.join(root, 'tests', 'fixtures', 'document-readiness-v22');
  const documentPath = path.join(repo, 'docs', 'implementation-plan.md');
  const reportPath = path.join(repo, '.deep-review', 'reports', 'v2.2-warning-advisory-review.md');
  const receiptDirectory = path.join(repo, '.deep-review', 'receipts', 'document-readiness');
  fs.mkdirSync(path.dirname(documentPath), { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.mkdirSync(receiptDirectory, { recursive: true });
  fs.copyFileSync(
    path.join(sourceRoot, 'implementation-plan.fixture.md'),
    documentPath,
  );
  fs.copyFileSync(
    path.join(sourceRoot, 'v2.2-warning-advisory-review.fixture.md'),
    reportPath,
  );

  const documentBytes = fs.readFileSync(documentPath);
  const reportBytes = fs.readFileSync(reportPath);
  const document = {
    byte_size: documentBytes.length,
    path: 'docs/implementation-plan.md',
    sha256: sha256(documentBytes),
    target_kind: 'implementation-plan',
  };
  const artifactGate = {
    schema_version: 1,
    findings: [{
      id: 'DOC-LEGACY',
      severity: 'warning',
      stage: 'advisory',
      acceptance_evidence: ['The observation is advisory and does not block implementation.'],
    }],
  };
  const report = {
    artifact_gate_sha256: sha256(Buffer.from(canonicalJsonV22(artifactGate), 'utf8')),
    path: '.deep-review/reports/v2.2-warning-advisory-review.md',
    provider_family: 'claude',
    reviewer_id: 'claude-opus',
    sha256: sha256(reportBytes),
  };
  const documents = [document];
  const scopeSha256 = sha256(Buffer.from(canonicalJsonV22(documents.map((entry) => ({
    path: entry.path,
    target_kind: entry.target_kind,
    sha256: entry.sha256,
  }))), 'utf8'));
  const body = {
    deferred_findings: [],
    documents,
    generated_at: '2026-07-24T00:00:00.000Z',
    ...(schemaVersion === '1.0' ? {} : { readiness_admission: null }),
    reports: [report],
    repository_identity_sha256: sha256(Buffer.from(fs.realpathSync(repo), 'utf8')),
    reviewer_requirements: {
      actual_provider_families: 1,
      actual_reviewers: 1,
      provider_family_minimum: 1,
      required_reviewers: 1,
    },
    risk: 'low',
    schema_version: schemaVersion,
    scope_sha256: scopeSha256,
    status: 'READY_FOR_IMPLEMENTATION',
  };
  const receipt = {
    ...body,
    receipt_sha256: sha256(Buffer.from(canonicalJsonV22(body), 'utf8')),
  };
  const receiptPath = path.join(
    receiptDirectory,
    `${scopeSha256}-${receipt.receipt_sha256}.json`,
  );
  fs.writeFileSync(receiptPath, `${canonicalJsonV22(receipt)}\n`);
  return { repo, documentPath, reportPath, receiptPath };
}

// The smallest trusted protocol-3 implementation plan that admits the two
// reviewers below, so a deferred obligation can be followed from the sealed
// receipt all the way into round synthesis.
function implementationRoutingPlan() {
  const context = {
    artifact_phase: 'implementation',
    risk: 'low',
    document_review_mode: 'full-readiness',
  };
  return {
    protocol_version: '3.0',
    ...context,
    reviewer_strategy: 'adaptive',
    shadow_mode: false,
    progress: 'initial',
    minimum_reviewers: 2,
    planned_reviewers: 2,
    provider_family_minimum: 2,
    maximum_reviewers: 4,
    max_expansion_waves: 1,
    initial_reviewer_ids: ['claude-opus', 'codex-review'],
    required_reviewer_ids: [],
    candidate_reviewers: [
      {
        reviewer_id: 'claude-opus',
        provider: 'claude',
        adapter_id: 'claude-cli',
        assignment_roles: ['standard'],
        last_status: 'success',
      },
      {
        reviewer_id: 'codex-review',
        provider: 'codex',
        adapter_id: 'codex-native-generic',
        assignment_roles: ['traceability'],
        last_status: 'success',
      },
    ],
    routes: [
      {
        reviewer_id: 'claude-opus',
        provider: 'claude',
        adapter_id: 'claude-cli',
        assignment_role: 'standard',
        rubric_id: 'standard-v1',
        wave: 1,
        required: false,
        selection_reason: 'initial standard route',
        resolved: { model: null, effort: 'high' },
        ...context,
      },
      {
        reviewer_id: 'codex-review',
        provider: 'codex',
        adapter_id: 'codex-native-generic',
        assignment_role: 'traceability',
        rubric_id: 'traceability-v1',
        wave: 1,
        required: false,
        selection_reason: 'initial traceability route',
        resolved: { model: null, effort: 'high' },
        ...context,
      },
    ],
  };
}

function approvingAttempt(reviewerId, outputDigest = sha256(`review:${reviewerId}`)) {
  return {
    reviewer_id: reviewerId,
    role: reviewerId,
    output_digest: outputDigest,
    included: true,
    exclusion: null,
    verdict: 'APPROVE',
    issues: { critical: 0, warning: 0, info: 0 },
  };
}

// The document-phase twin of the plan above. Readiness admission is round-level
// evidence, so the carrier that reaches document readiness is emitted by the
// document round, not by an implementation one.
function documentRoutingPlan() {
  const plan = implementationRoutingPlan();
  const context = {
    artifact_phase: 'document',
    risk: 'low',
    document_review_mode: 'full-readiness',
  };
  return {
    ...plan,
    ...context,
    routes: plan.routes.map((route) => ({ ...route, ...context })),
  };
}

function executionRouteFor(plan, reviewerId) {
  const route = plan.routes.find((item) => item.reviewer_id === reviewerId);
  if (!route) throw new Error(`fixture has no planned route for ${reviewerId}`);
  return { protocol_version: '3.0', ...route };
}

// The trusted dispatch record: one fresh opaque attempt id bound to one parsed
// protocol-3 route and the immutable plan, assigned before the attempt ran.
function trustedDispatch(plan, reviewerIds, { outputDigest = null } = {}) {
  return {
    round_id: 'document-round-1',
    routing_plan_sha256: sha256(Buffer.from(canonicalJsonV22(plan), 'utf8')),
    records: reviewerIds.map((reviewerId) => {
      const route = executionRouteFor(plan, reviewerId);
      return {
        attempt_id: `attempt-${reviewerId}`,
        reviewer_id: reviewerId,
        provider_family: route.provider,
        execution_route: route,
        route_sha256: sha256(Buffer.from(canonicalJsonV22(route), 'utf8')),
        output_sha256: outputDigest ?? sha256(`review:${reviewerId}`),
        model: route.resolved.model ?? null,
        session_id: `session-${reviewerId}`,
        compatibility_evidence_sha256: null,
      };
    }),
  };
}

// A receipt an attacker resealed: the body is mutated and the seal and
// content-addressed filename are recomputed, so nothing downstream of the seal
// can be what rejects it.
function resealReceiptAt(receiptPath, mutate) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const { receipt_sha256: ignored, ...body } = receipt;
  mutate(body);
  const sealed = { ...body, receipt_sha256: sha256(Buffer.from(canonicalJsonV22(body), 'utf8')) };
  const forged = path.join(
    path.dirname(receiptPath),
    `${sealed.scope_sha256}-${sealed.receipt_sha256}.json`,
  );
  fs.writeFileSync(forged, `${canonicalJsonV22(sealed)}\n`);
  return forged;
}

test('Artifact Gate is singular, structured, and Critical is always pre-implementation', async () => {
  const { parseArtifactGate } = await import(readinessUrl);
  const parsed = parseArtifactGate(report());
  assert.equal(parsed.findings[0].stage, 'implementation_verification');
  assert.throws(() => parseArtifactGate(`${report()}\n${report()}`), /exactly one Artifact Gate/);
  assert.throws(() => parseArtifactGate(report({
    verdict: 'REQUEST_CHANGES',
    critical: 1,
    warning: 0,
    findings: [{
      id: 'DOC-C1',
      severity: 'critical',
      stage: 'implementation_verification',
      acceptance_evidence: ['evidence'],
    }],
  })), /Critical.*pre_implementation/);
  assert.throws(() => parseArtifactGate(report({
    findings: [{
      id: 'DOC-X',
      severity: 'warning',
      stage: 'invented',
      acceptance_evidence: ['evidence'],
    }],
  })), /stage/);
  assert.throws(() => parseArtifactGate(report({
    warning: 1,
    findings: [{
      id: 'DOC-A1',
      severity: 'warning',
      stage: 'advisory',
      acceptance_evidence: ['explain why this observation is advisory'],
    }],
  })), /advisory.*info|info.*advisory/);
});

test('pre-2.3 schema-1.0 sealed Warning/advisory receipt verifies and derives APPROVE', async () => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const fixture = historicalV22Fixture();
  // The current writer still refuses this evidence; D16 changed only how the
  // refusal is spelled. A canonical gate-parse failure is now that reviewer's
  // stable exclusion rather than the round's abort, so nothing is admitted,
  // no receipt is sealed, and the invalid stage is named in the exclusion
  // record — a strictly narrower admission than the throw it replaces.
  const refused = createDocumentReadinessReceipt({
    repo: fixture.repo,
    artifacts: [{ path: 'docs/implementation-plan.md', target_kind: 'implementation-plan' }],
    reports: [{ path: fixture.reportPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  });
  assert.equal(refused.status, 'DOCUMENT_BLOCKED');
  assert.equal(refused.receipt_path, null);
  assert.equal(refused.reviewer_count, 0);
  assert.deepEqual(refused.gate_exclusions, [{
    code: 'ERROR_ARTIFACT_GATE_INVALID_STAGE',
    path: '.deep-review/reports/v2.2-warning-advisory-review.md',
    provider_family: 'claude',
    reviewer_id: 'claude-opus',
  }]);
  const verified = verifyReadinessReceipt({ repo: fixture.repo, receiptPath: fixture.receiptPath });
  assert.equal(verified.status, 'READY_FOR_IMPLEMENTATION');
  assert.equal(verified.document_verdict, 'APPROVE');
  assert.deepEqual(verified.deferred_findings, []);
});

test('document final verdict is derived from readiness stages and recomputed without a receipt field', async () => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const cases = [
    {
      name: 'advisory only',
      reportOptions: {
        verdict: 'APPROVE',
        warning: 0,
        info: 1,
        findings: [{
          id: 'DOC-I1',
          severity: 'info',
          stage: 'advisory',
          acceptance_evidence: [],
        }],
      },
      status: 'READY_FOR_IMPLEMENTATION',
      verdict: 'APPROVE',
    },
    {
      name: 'deferred implementation verification',
      reportOptions: {},
      status: 'READY_FOR_IMPLEMENTATION',
      verdict: 'CONCERN',
    },
    {
      name: 'pre-implementation blocker',
      reportOptions: {
        verdict: 'REQUEST_CHANGES',
        warning: 1,
        findings: [{
          id: 'DOC-B1',
          severity: 'warning',
          stage: 'pre_implementation',
          acceptance_evidence: ['resolve the concrete rollback contradiction'],
        }],
      },
      status: 'DOCUMENT_BLOCKED',
      verdict: 'REQUEST_CHANGES',
    },
  ];

  for (const current of cases) {
    const repo = repoFixture();
    const reviewPath = writeReport(repo, `${current.name.replaceAll(' ', '-')}-review.md`, report(current.reportOptions));
    const created = createDocumentReadinessReceipt({
      repo,
      artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
      reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
      risk: 'low',
    });
    assert.equal(created.status, current.status, current.name);
    assert.equal(created.document_verdict, current.verdict, current.name);
    if (created.receipt_path) {
      const onDisk = JSON.parse(fs.readFileSync(created.receipt_path, 'utf8'));
      assert.equal(Object.hasOwn(onDisk, 'document_verdict'), false, current.name);
      const verified = verifyReadinessReceipt({ repo, receiptPath: created.receipt_path });
      assert.equal(verified.document_verdict, current.verdict, current.name);
    }
  }
});

test('low-risk warning-only plan becomes READY and emits a sealed content-addressed receipt', async () => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'plan-review.md', report());
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{
      path: reviewPath,
      reviewer_id: 'claude-opus',
      provider_family: 'claude',
    }],
    risk: 'low',
    requiredReviewers: 1,
    providerFamilyMinimum: 1,
    generatedAt: '2026-07-24T00:00:00.000Z',
  });
  assert.equal(created.status, 'READY_FOR_IMPLEMENTATION');
  assert.match(
    created.receipt_path.replaceAll('\\', '/'),
    /\/\.deep-review\/receipts\/document-readiness\/[a-f0-9]{64}-[a-f0-9]{64}\.json$/,
  );
  const onDisk = JSON.parse(fs.readFileSync(created.receipt_path, 'utf8'));
  assert.equal(
    path.basename(created.receipt_path, '.json'),
    `${onDisk.scope_sha256}-${onDisk.receipt_sha256}`,
  );
  assert.match(onDisk.receipt_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(onDisk.deferred_findings[0].finding_ref, {
    finding_id: 'DOC-1',
    reviewer_id: 'claude-opus',
  });

  const verified = verifyReadinessReceipt({ repo, receiptPath: created.receipt_path });
  assert.equal(verified.status, 'READY_FOR_IMPLEMENTATION');
  assert.equal(verified.scope_sha256, onDisk.scope_sha256);
  assert.equal(verified.risk, 'low');
});

test('pre-implementation blockers and high-risk reviewer-family shortages produce DOCUMENT_BLOCKED without a receipt', async () => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const repo = repoFixture();
  const blockedReport = writeReport(repo, 'blocked-review.md', report({
    warning: 1,
    findings: [{
      id: 'DOC-B1',
      severity: 'warning',
      stage: 'pre_implementation',
      acceptance_evidence: ['choose and document a rollback owner'],
    }],
  }));
  const blocked = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: blockedReport, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
    requiredReviewers: 1,
    providerFamilyMinimum: 1,
  });
  assert.equal(blocked.status, 'DOCUMENT_BLOCKED');
  assert.equal(blocked.receipt_path, null);
  assert.deepEqual(blocked.blocking_finding_ids, ['DOC-B1']);

  const highReport = writeReport(repo, 'high-review.md', report({ verdict: 'APPROVE', warning: 0, findings: [] }));
  const shortage = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: highReport, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'high',
    requiredReviewers: 2,
    providerFamilyMinimum: 2,
  });
  assert.equal(shortage.status, 'DOCUMENT_BLOCKED');
  assert.ok(shortage.blocking_reasons.includes('required_reviewers'));
  assert.ok(shortage.blocking_reasons.includes('provider_families'));

  const cannotLowerRiskFloor = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: highReport, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'high',
    requiredReviewers: 1,
    providerFamilyMinimum: 1,
  });
  assert.equal(cannotLowerRiskFloor.status, 'DOCUMENT_BLOCKED');
  assert.ok(cannotLowerRiskFloor.blocking_reasons.includes('required_reviewers'));
});

test('stale document/report hashes, tampering, and symlink receipts fail with ERROR_READINESS_RECEIPT_STALE', async (t) => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);

  const makeReceipt = () => {
    const repo = repoFixture();
    const reviewPath = writeReport(repo, 'fixture-review.md', report());
    const created = createDocumentReadinessReceipt({
      repo,
      artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
      reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
      risk: 'low',
      requiredReviewers: 1,
      providerFamilyMinimum: 1,
    });
    return { repo, reviewPath, ...created };
  };

  await t.test('document changed', () => {
    const fixture = makeReceipt();
    fs.appendFileSync(path.join(fixture.repo, 'docs', '계획 Ω.md'), '\nchanged\n');
    assert.throws(
      () => verifyReadinessReceipt({ repo: fixture.repo, receiptPath: fixture.receipt_path }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
    );
  });
  await t.test('report changed', () => {
    const fixture = makeReceipt();
    fs.appendFileSync(fixture.reviewPath, '\nchanged\n');
    assert.throws(
      () => verifyReadinessReceipt({ repo: fixture.repo, receiptPath: fixture.receipt_path }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
    );
  });
  await t.test('receipt tampered', () => {
    const fixture = makeReceipt();
    const body = JSON.parse(fs.readFileSync(fixture.receipt_path, 'utf8'));
    body.risk = 'critical';
    fs.writeFileSync(fixture.receipt_path, JSON.stringify(body));
    assert.throws(
      () => verifyReadinessReceipt({ repo: fixture.repo, receiptPath: fixture.receipt_path }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
    );
  });
  await t.test('receipt symlinked', { skip: process.platform === 'win32' }, () => {
    const fixture = makeReceipt();
    const link = path.join(fixture.repo, '.deep-review', 'receipts', 'document-readiness', 'link.json');
    fs.symlinkSync(fixture.receipt_path, link);
    assert.throws(
      () => verifyReadinessReceipt({ repo: fixture.repo, receiptPath: link }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
    );
  });
});

test('receipt creation rejects path escape and document symlinks', { skip: process.platform === 'win32' }, async () => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'fixture-review.md', report());
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: '../outside.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  }), /repository-relative|outside/i);

  const target = path.join(repo, 'docs', '계획 Ω.md');
  const link = path.join(repo, 'docs', 'linked-plan.md');
  fs.symlinkSync(target, link);
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/linked-plan.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  }), /symlink/i);
});

test('receipt creation requires explicit risk and rejects duplicated or forged reviewer evidence', async () => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'fixture-review.md', report());
  const base = {
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
  };
  assert.throws(() => createDocumentReadinessReceipt(base), /risk is required/);
  assert.throws(() => createDocumentReadinessReceipt({
    ...base,
    risk: 'high',
    reports: [
      ...base.reports,
      { path: reviewPath, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    // D17 removed content-hash equality as a uniqueness authority; the
    // duplicate *trusted path* under distinct reviewer ids is unchanged.
  }), /duplicate reviewer report path/);
  assert.throws(() => createDocumentReadinessReceipt({
    ...base,
    risk: 'low',
    reports: [{ path: reviewPath, reviewer_id: 'codex-review', provider_family: 'claude' }],
  }), /reviewer\/provider identity mismatch/);
});

test('a self-resealed high-risk receipt cannot lower risk or remove reviewer evidence', async () => {
  const {
    canonicalStringify,
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const repo = repoFixture();
  const claudeReport = writeReport(repo, 'fixture-review.md', report());
  const codexReport = writeReport(repo, 'fixture-codex-review.md', report({
    verdict: 'APPROVE',
    warning: 0,
    findings: [],
  }));
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [
      { path: claudeReport, reviewer_id: 'claude-opus', provider_family: 'claude' },
      { path: codexReport, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    risk: 'high',
  });
  const receipt = JSON.parse(fs.readFileSync(created.receipt_path, 'utf8'));
  receipt.risk = 'low';
  receipt.reports = receipt.reports.slice(0, 1);
  receipt.deferred_findings = [];
  receipt.reviewer_requirements = {
    required_reviewers: 1,
    provider_family_minimum: 1,
    actual_reviewers: 1,
    actual_provider_families: 1,
  };
  const { receipt_sha256: ignored, ...body } = receipt;
  receipt.receipt_sha256 = createHash('sha256')
    .update(Buffer.from(canonicalStringify(body), 'utf8'))
    .digest('hex');
  fs.writeFileSync(created.receipt_path, `${canonicalStringify(receipt)}\n`);
  assert.throws(
    () => verifyReadinessReceipt({ repo, receiptPath: created.receipt_path }),
    (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
  );
});

test('implementation APPROVE is floored until every deferred acceptance item has fresh evidence', async () => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
    evaluateDeferredAcceptance,
    gateImplementationVerdict,
  } = await import(readinessUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'fixture-review.md', report());
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  });
  const verifiedReceipt = verifyReadinessReceipt({ repo, receiptPath: created.receipt_path });
  fs.writeFileSync(path.join(repo, 'implementation.js'), 'export const migrated = true;\n');
  fs.writeFileSync(path.join(repo, 'migration-test.tap'), 'ok 1 - migration rollback roundtrip\n');
  const implementationArtifacts = [{ path: 'implementation.js' }];
  const pending = evaluateDeferredAcceptance({
    receipt: verifiedReceipt.receipt,
    verifiedItems: [],
    repo,
    implementationArtifacts,
  });
  const implementationScopeSha256 = pending.implementation_scope_sha256;
  const evidenceSha256 = createHash('sha256')
    .update(fs.readFileSync(path.join(repo, 'migration-test.tap')))
    .digest('hex');
  assert.equal(pending.complete, false);
  assert.deepEqual(pending.pending_finding_refs, [{
    finding_id: 'DOC-1',
    reviewer_id: 'claude-opus',
  }]);
  const floored = gateImplementationVerdict({
    status: 'reviewed', verdict: 'APPROVE', phase6_allowed: true,
  }, pending);
  assert.equal(floored.verdict, 'CONCERN');
  assert.equal(floored.deferred_acceptance_floor, true);

  const complete = evaluateDeferredAcceptance({
    receipt: verifiedReceipt.receipt,
    verifiedItems: [{
      finding_ref: { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
      implementation_scope_sha256: implementationScopeSha256,
      verification_results: [{
        criterion: 'migration dry-run passes and rollback restores the prior schema',
        status: 'passed',
        evidence_path: 'migration-test.tap',
        evidence_sha256: evidenceSha256,
      }],
    }],
    repo,
    implementationArtifacts,
    implementationScopeSha256,
  });
  assert.equal(complete.complete, true);
  assert.throws(() => evaluateDeferredAcceptance({
    receipt: verifiedReceipt.receipt,
    verifiedItems: [{
      finding_ref: { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
      implementation_scope_sha256: implementationScopeSha256,
      verification_results: [{
        criterion: 'verified',
        status: 'passed',
        evidence_path: 'migration-test.tap',
        evidence_sha256: evidenceSha256,
      }],
    }],
    repo,
    implementationArtifacts,
    implementationScopeSha256,
  }), /does not satisfy/);
  fs.appendFileSync(path.join(repo, 'implementation.js'), '// changed\n');
  assert.throws(() => evaluateDeferredAcceptance({
    receipt: verifiedReceipt.receipt,
    verifiedItems: [],
    repo,
    implementationArtifacts,
    implementationScopeSha256,
  }), /scope SHA-256 is stale/);
  assert.equal(gateImplementationVerdict({
    status: 'reviewed', verdict: 'APPROVE', phase6_allowed: true,
  }, complete).verdict, 'APPROVE');
});

test('verified readiness receipt is injected into implementation payload as trusted bounded JSON', async () => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const { buildReviewerPayload } = await import(payloadUrl);
  const repo = repoFixture();
  const reviewPath = writeReport(repo, 'fixture-review.md', report());
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reviewPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  });
  const payload = buildReviewerPayload({
    pluginRoot: root,
    repo,
    readinessReceipt: created.receipt_path,
    diff: 'IMPLEMENTATION DIFF',
  });
  const prompt = fs.readFileSync(payload.promptFile, 'utf8');
  assert.match(prompt, /VERIFIED DOCUMENT READINESS RECEIPT/);
  assert.match(prompt, /"finding_id": "DOC-1"/);
  assert.ok(prompt.trimEnd().endsWith('IMPLEMENTATION DIFF'));
});

// A local Artifact Gate id belongs to the reviewer that wrote it, so the same
// local id from two reviewers is two findings, not one (D17).
test('T-READY-3 same local id remains distinct by reviewer through readiness', async () => {
  const {
    createDocumentReadinessReceipt,
    evaluateDocumentReadiness,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const repo = repoFixture();
  const claudeReport = writeReport(repo, 'claude-collision-review.md', report({
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'implementation_verification',
      acceptance_evidence: ['claude: migration dry-run passes'],
    }],
  }));
  const codexReport = writeReport(repo, 'codex-collision-review.md', report({
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'implementation_verification',
      acceptance_evidence: ['codex: rollback restores the prior schema'],
    }],
  }));
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [
      { path: claudeReport, reviewer_id: 'claude-opus', provider_family: 'claude' },
      { path: codexReport, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    risk: 'low',
  });
  assert.equal(created.status, 'READY_FOR_IMPLEMENTATION');
  const expected = [
    {
      acceptance_evidence: ['claude: migration dry-run passes'],
      finding_ref: { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
      severity: 'warning',
    },
    {
      acceptance_evidence: ['codex: rollback restores the prior schema'],
      finding_ref: { finding_id: 'DOC-1', reviewer_id: 'codex-review' },
      severity: 'warning',
    },
  ];
  assert.deepEqual(created.deferred_findings, expected);
  const onDisk = JSON.parse(fs.readFileSync(created.receipt_path, 'utf8'));
  assert.deepEqual(onDisk.deferred_findings, expected);
  const verified = verifyReadinessReceipt({ repo, receiptPath: created.receipt_path });
  assert.deepEqual(verified.deferred_findings, expected);
  assert.equal(verified.document_verdict, 'CONCERN');

  // The key became composite, not absent. One reviewer contradicting itself on
  // its own local id is still a contradiction and never resolves first-wins,
  // while an identical repeat stays one finding.
  const claudeEvidence = (stage) => ({
    reviewer_id: 'claude-opus',
    provider_family: 'claude',
    artifact_gate: {
      schema_version: 1,
      findings: [{
        id: 'DOC-1',
        severity: 'warning',
        stage,
        acceptance_evidence: ['claude: migration dry-run passes'],
      }],
    },
  });
  assert.throws(() => evaluateDocumentReadiness({
    reportEvidence: [
      claudeEvidence('implementation_verification'),
      claudeEvidence('pre_implementation'),
    ],
    risk: 'low',
  }), /contradicts itself/);
  assert.deepEqual(
    evaluateDocumentReadiness({
      reportEvidence: [
        claudeEvidence('implementation_verification'),
        claudeEvidence('implementation_verification'),
      ],
      risk: 'low',
    }).deferred_findings,
    [{
      acceptance_evidence: ['claude: migration dry-run passes'],
      finding_ref: { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
      severity: 'warning',
    }],
  );
});

// Blockers carry the same identity. The ordering is reviewer first, local id
// second, so neither a reversal nor an id-first sort can reproduce it.
test('T-READY-4 both reviewer-scoped pre-implementation blockers survive', async () => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const repo = repoFixture();
  const claudeReport = writeReport(repo, 'claude-blocker-review.md', report({
    verdict: 'REQUEST_CHANGES',
    warning: 2,
    findings: [
      {
        id: 'DOC-9',
        severity: 'warning',
        stage: 'pre_implementation',
        acceptance_evidence: ['claude: name the rollback owner'],
      },
      {
        id: 'DOC-1',
        severity: 'warning',
        stage: 'pre_implementation',
        acceptance_evidence: ['claude: resolve the migration contradiction'],
      },
    ],
  }));
  const codexReport = writeReport(repo, 'codex-blocker-review.md', report({
    verdict: 'REQUEST_CHANGES',
    warning: 1,
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'pre_implementation',
      acceptance_evidence: ['codex: bound the retry budget'],
    }],
  }));
  const blocked = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [
      { path: claudeReport, reviewer_id: 'claude-opus', provider_family: 'claude' },
      { path: codexReport, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    risk: 'low',
  });
  assert.equal(blocked.status, 'DOCUMENT_BLOCKED');
  assert.equal(blocked.receipt_path, null);
  assert.equal(blocked.document_verdict, 'REQUEST_CHANGES');
  assert.deepEqual(blocked.blocking_finding_refs, [
    { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
    { finding_id: 'DOC-9', reviewer_id: 'claude-opus' },
    { finding_id: 'DOC-1', reviewer_id: 'codex-review' },
  ]);
  assert.ok(blocked.blocking_reasons.includes('pre_implementation_findings'));
  // The bare-id list is a display projection: one entry per authoritative ref,
  // in the same order, so a shared local id renders twice and collapses to two
  // under any set-keyed operation. That is why it can never be the authority.
  assert.deepEqual(blocked.blocking_finding_ids, ['DOC-1', 'DOC-9', 'DOC-1']);
  assert.equal(blocked.blocking_finding_ids.length, blocked.blocking_finding_refs.length);
  assert.equal(new Set(blocked.blocking_finding_ids).size, 2);
});

test('T-READY-7 no authoritative blocker operation keys on a bare local id', async () => {
  const {
    createDocumentReadinessReceipt,
    evaluateDeferredAcceptance,
    evaluateDocumentReadiness,
    verifyReadinessReceipt,
  } = await import(readinessUrl);

  // One local id, two reviewers, two stages: a bare-id key would collapse them
  // and route one finding to the other's authority.
  const mixedRepo = repoFixture();
  const mixedClaude = writeReport(mixedRepo, 'claude-mixed-review.md', report({
    verdict: 'REQUEST_CHANGES',
    warning: 1,
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'pre_implementation',
      acceptance_evidence: ['claude: resolve the migration contradiction'],
    }],
  }));
  const mixedCodex = writeReport(mixedRepo, 'codex-mixed-review.md', report({
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'implementation_verification',
      acceptance_evidence: ['codex: rollback restores the prior schema'],
    }],
  }));
  const mixed = createDocumentReadinessReceipt({
    repo: mixedRepo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [
      { path: mixedClaude, reviewer_id: 'claude-opus', provider_family: 'claude' },
      { path: mixedCodex, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    risk: 'low',
  });
  assert.equal(mixed.status, 'DOCUMENT_BLOCKED');
  assert.deepEqual(mixed.blocking_finding_refs, [
    { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
  ]);
  assert.deepEqual(mixed.deferred_findings, [{
    acceptance_evidence: ['codex: rollback restores the prior schema'],
    finding_ref: { finding_id: 'DOC-1', reviewer_id: 'codex-review' },
    severity: 'warning',
  }]);

  // No reviewer, no reference. A blocker operation must fail closed rather than
  // fall back to the bare local id when the ref cannot be formed.
  const gateEvidence = (extra) => ({
    ...extra,
    provider_family: 'claude',
    artifact_gate: {
      schema_version: 1,
      findings: [{
        id: 'DOC-1',
        severity: 'warning',
        stage: 'pre_implementation',
        acceptance_evidence: ['resolve the migration contradiction'],
      }],
    },
  });
  assert.throws(
    () => evaluateDocumentReadiness({ reportEvidence: [gateEvidence({})], risk: 'low' }),
    /reviewer id/,
  );
  assert.throws(
    () => evaluateDocumentReadiness({
      reportEvidence: [gateEvidence({ reviewer_id: '' })],
      risk: 'low',
    }),
    /reviewer id/,
  );
  // The same evidence with a reviewer id is admitted, so the two negatives above
  // fail on the missing reference and not on the hand-built evidence shape.
  assert.deepEqual(
    evaluateDocumentReadiness({
      reportEvidence: [gateEvidence({ reviewer_id: 'claude-opus' })],
      risk: 'low',
    }).blocking_finding_refs,
    [{ finding_id: 'DOC-1', reviewer_id: 'claude-opus' }],
  );

  // Deferred acceptance keys on the same reference. Two reviewers sharing a
  // local id are two obligations, and a bare id satisfies neither by fallback.
  const deferredRepo = repoFixture();
  const deferredClaude = writeReport(deferredRepo, 'claude-deferred-review.md', report({
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'implementation_verification',
      acceptance_evidence: ['claude: migration dry-run passes'],
    }],
  }));
  const deferredCodex = writeReport(deferredRepo, 'codex-deferred-review.md', report({
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'implementation_verification',
      acceptance_evidence: ['codex: rollback restores the prior schema'],
    }],
  }));
  const deferredCreated = createDocumentReadinessReceipt({
    repo: deferredRepo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [
      { path: deferredClaude, reviewer_id: 'claude-opus', provider_family: 'claude' },
      { path: deferredCodex, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    risk: 'low',
  });
  const deferredVerified = verifyReadinessReceipt({
    repo: deferredRepo,
    receiptPath: deferredCreated.receipt_path,
  });
  fs.writeFileSync(path.join(deferredRepo, 'implementation.js'), 'export const migrated = true;\n');
  fs.writeFileSync(path.join(deferredRepo, 'migration-test.tap'), 'ok 1 - migration rollback roundtrip\n');
  const implementationArtifacts = [{ path: 'implementation.js' }];
  const pending = evaluateDeferredAcceptance({
    receipt: deferredVerified.receipt,
    verifiedItems: [],
    repo: deferredRepo,
    implementationArtifacts,
  });
  assert.equal(pending.required_count, 2);
  assert.deepEqual(pending.pending_finding_refs, [
    { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
    { finding_id: 'DOC-1', reviewer_id: 'codex-review' },
  ]);
  // Same display projection rule as the blockers: parallel, duplicated, never an
  // identity — two obligations cannot be told apart by it.
  assert.deepEqual(pending.pending_finding_ids, ['DOC-1', 'DOC-1']);
  const claudeVerification = (findingReference) => ({
    ...findingReference,
    implementation_scope_sha256: pending.implementation_scope_sha256,
    verification_results: [{
      criterion: 'claude: migration dry-run passes',
      status: 'passed',
      evidence_path: 'migration-test.tap',
      evidence_sha256: sha256(fs.readFileSync(path.join(deferredRepo, 'migration-test.tap'))),
    }],
  });
  const acceptance = (verifiedItem) => evaluateDeferredAcceptance({
    receipt: deferredVerified.receipt,
    verifiedItems: [verifiedItem],
    repo: deferredRepo,
    implementationArtifacts,
    implementationScopeSha256: pending.implementation_scope_sha256,
  });
  assert.throws(
    () => acceptance(claudeVerification({ finding_id: 'DOC-1' })),
    /reviewer-scoped finding_ref/,
  );
  // Nor is a differently scoped identity a reviewer-scoped reference: the ref is
  // exactly the pair, so no other shape can normalize into this obligation.
  assert.throws(
    () => acceptance(claudeVerification({
      finding_ref: { finding_id: 'DOC-1', reviewer_id: 'claude-opus', scope: 'legacy_global' },
    })),
    /reviewer-scoped finding_ref/,
  );
  // The same evidence under the exact reference is accepted, so both negatives
  // fail on the reference shape and not on the evidence.
  const claudeVerified = acceptance(claudeVerification({
    finding_ref: { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
  }));
  assert.equal(claudeVerified.verified_count, 1);
  assert.deepEqual(claudeVerified.verified_items[0].finding_ref, {
    finding_id: 'DOC-1',
    reviewer_id: 'claude-opus',
  });
});

// Two reviewers, one shared local id, both deferred. Verifying one of them
// discharges one obligation; the other survives, reviewer-scoped, through the
// gate and into round synthesis. A carrier that collapses on the bare local id
// clears both from a single verification — the defect this test exists for.
test('T-READY-5 verification of one reviewer ref leaves the other pending', async () => {
  const {
    createDocumentReadinessReceipt,
    evaluateDeferredAcceptance,
    gateImplementationVerdict,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const repo = repoFixture();
  const claudeReport = writeReport(repo, 'claude-shared-id-review.md', report({
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'implementation_verification',
      acceptance_evidence: ['claude: migration dry-run passes'],
    }],
  }));
  const codexReport = writeReport(repo, 'codex-shared-id-review.md', report({
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'implementation_verification',
      acceptance_evidence: ['codex: rollback restores the prior schema'],
    }],
  }));
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [
      { path: claudeReport, reviewer_id: 'claude-opus', provider_family: 'claude' },
      { path: codexReport, reviewer_id: 'codex-review', provider_family: 'codex' },
    ],
    risk: 'low',
  });
  const verified = verifyReadinessReceipt({ repo, receiptPath: created.receipt_path });
  fs.writeFileSync(path.join(repo, 'implementation.js'), 'export const migrated = true;\n');
  fs.writeFileSync(path.join(repo, 'migration-test.tap'), 'ok 1 - migration rollback roundtrip\n');
  const implementationArtifacts = [{ path: 'implementation.js' }];
  const claudeRef = { finding_id: 'DOC-1', reviewer_id: 'claude-opus' };
  const codexRef = { finding_id: 'DOC-1', reviewer_id: 'codex-review' };
  const pending = evaluateDeferredAcceptance({
    receipt: verified.receipt,
    verifiedItems: [],
    repo,
    implementationArtifacts,
  });
  const scope = pending.implementation_scope_sha256;
  const evidenceSha256 = sha256(fs.readFileSync(path.join(repo, 'migration-test.tap')));
  assert.equal(pending.required_count, 2);
  assert.equal(pending.complete, false);
  assert.deepEqual(pending.pending_finding_refs, [claudeRef, codexRef]);

  const verification = (findingRef, criterion) => ({
    finding_ref: findingRef,
    implementation_scope_sha256: scope,
    verification_results: [{
      criterion,
      status: 'passed',
      evidence_path: 'migration-test.tap',
      evidence_sha256: evidenceSha256,
    }],
  });
  const claudeItem = verification(claudeRef, 'claude: migration dry-run passes');
  const codexItem = verification(codexRef, 'codex: rollback restores the prior schema');
  const acceptance = (verifiedItems) => evaluateDeferredAcceptance({
    receipt: verified.receipt,
    verifiedItems,
    repo,
    implementationArtifacts,
    implementationScopeSha256: scope,
  });

  // Verifying either reviewer leaves exactly the other one pending. Both
  // directions are asserted, so neither a collapse nor a first-wins ordering
  // can satisfy this by accident.
  const claudeOnly = acceptance([claudeItem]);
  assert.equal(claudeOnly.complete, false);
  assert.equal(claudeOnly.verified_count, 1);
  assert.deepEqual(claudeOnly.pending_finding_refs, [codexRef]);
  const codexOnly = acceptance([codexItem]);
  assert.equal(codexOnly.complete, false);
  assert.equal(codexOnly.verified_count, 1);
  assert.deepEqual(codexOnly.pending_finding_refs, [claudeRef]);
  // The obligations are not interchangeable either: one reviewer's evidence
  // cannot discharge the other's criterion.
  assert.throws(
    () => acceptance([verification(codexRef, 'claude: migration dry-run passes')]),
    /does not satisfy/,
  );

  // The surviving obligation stays reviewer-scoped through the gate...
  const gated = gateImplementationVerdict({
    status: 'reviewed', verdict: 'APPROVE', phase6_allowed: true,
  }, claudeOnly);
  assert.equal(gated.verdict, 'CONCERN');
  assert.equal(gated.deferred_acceptance_floor, true);
  assert.deepEqual(gated.pending_deferred_finding_refs, [codexRef]);
  // ...and into round synthesis, which reads the same structured carrier.
  const round = synthesizeReviewRound({
    attempts: [approvingAttempt('claude-opus'), approvingAttempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: implementationRoutingPlan(),
    deferredAcceptance: claudeOnly,
  });
  assert.equal(round.status, 'reviewed');
  assert.equal(round.verdict, 'CONCERN');
  assert.equal(round.deferred_acceptance_floor, true);
  assert.deepEqual(round.pending_deferred_finding_refs, [codexRef]);

  // Only both reviewer-scoped verifications complete deferred acceptance.
  const both = acceptance([claudeItem, codexItem]);
  assert.equal(both.complete, true);
  assert.equal(both.verified_count, 2);
  assert.deepEqual(both.pending_finding_refs, []);
  assert.deepEqual(both.verified_items.map((item) => item.finding_ref), [claudeRef, codexRef]);
  const cleared = gateImplementationVerdict({
    status: 'reviewed', verdict: 'APPROVE', phase6_allowed: true,
  }, both);
  assert.equal(cleared.verdict, 'APPROVE');
  assert.equal(cleared.deferred_acceptance_floor, false);
  assert.deepEqual(cleared.pending_deferred_finding_refs, []);
  const clearedRound = synthesizeReviewRound({
    attempts: [approvingAttempt('claude-opus'), approvingAttempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: implementationRoutingPlan(),
    deferredAcceptance: both,
  });
  assert.equal(clearedRound.verdict, 'APPROVE');
  assert.equal(clearedRound.deferred_acceptance_floor, false);

  // R5 — a reviewer identity that is empty, absent, or not a string is no
  // identity at all. Admitting such an obligation would make it live and
  // unattributed, which is exactly the fallback D17 forbids.
  const obligationReceipt = (reviewerId) => ({
    deferred_findings: [{
      finding_ref: { finding_id: 'DOC-1', reviewer_id: reviewerId },
      severity: 'warning',
      acceptance_evidence: ['claude: migration dry-run passes'],
    }],
  });
  for (const malformed of ['', null, { a: 1 }, 7]) {
    assert.throws(
      () => evaluateDeferredAcceptance({
        receipt: obligationReceipt(malformed),
        verifiedItems: [],
        repo,
        implementationArtifacts,
      }),
      /deferred readiness obligation requires a reviewer-scoped finding_ref/,
    );
  }
  // The same obligation with a real reviewer id is admitted, so each refusal
  // above is about the reviewer identity and not the surrounding shape.
  assert.deepEqual(
    evaluateDeferredAcceptance({
      receipt: obligationReceipt('claude-opus'),
      verifiedItems: [],
      repo,
      implementationArtifacts,
    }).pending_finding_refs,
    [claudeRef],
  );
  // The gate holds the same line one layer up: an obligation it cannot attribute
  // is refused rather than carried into a verdict as an unattributed pending ref.
  for (const malformed of [
    { finding_id: 'DOC-1' },
    { finding_id: 'DOC-1', reviewer_id: '' },
    { finding_id: 'DOC-1', reviewer_id: null },
    { finding_id: 'DOC-1', reviewer_id: 'claude-opus', scope: 'legacy_global' },
  ]) {
    assert.throws(() => gateImplementationVerdict({
      status: 'reviewed', verdict: 'APPROVE', phase6_allowed: true,
    }, { complete: false, pending_finding_refs: [malformed] }),
    /pending deferred obligation requires a reviewer-scoped finding_ref/);
  }
});

// T-READY-9 (D17) — report identity is the pair (reviewer_id, trusted path).
// SHA-256 binds bytes and nothing else, so equal digests across two distinct
// report identities are valid — but only because a sealed synthesis admission
// proves two independent attempts on two trusted routes stand behind them. A
// copy with no admitted attempt of its own inflates no floor.
test('T-READY-9 a copied report cannot inflate floors while equal bytes from distinct trusted attempts and providers pass', async () => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const repo = repoFixture();
  const bytes = report({ verdict: 'APPROVE', warning: 0, findings: [] });
  const claudeReport = writeReport(repo, 'claude-equal-bytes-review.md', bytes);
  const codexReport = writeReport(repo, 'codex-equal-bytes-review.md', bytes);
  const digest = sha256(fs.readFileSync(claudeReport));
  assert.equal(digest, sha256(fs.readFileSync(codexReport)));

  const plan = documentRoutingPlan();
  const dispatch = trustedDispatch(plan, ['claude-opus', 'codex-review'], { outputDigest: digest });
  const round = synthesizeReviewRound({
    attempts: [
      approvingAttempt('claude-opus', digest),
      approvingAttempt('codex-review', digest),
    ],
    consensus: { findings: [] },
    routingPlan: plan,
    dispatch,
  });
  assert.equal(round.status, 'reviewed');
  const admission = round.readiness_admission;
  assert.ok(admission, 'the document round must seal a readiness admission');

  const artifacts = [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }];
  const admitted = [
    {
      path: claudeReport,
      reviewer_id: 'claude-opus',
      provider_family: 'claude',
      attempt_id: 'attempt-claude-opus',
    },
    {
      path: codexReport,
      reviewer_id: 'codex-review',
      provider_family: 'codex',
      attempt_id: 'attempt-codex-review',
    },
  ];
  // High risk needs two reviewers and two provider families, so this positive
  // only passes if equal bytes really did clear both floors.
  const created = createDocumentReadinessReceipt({
    repo,
    artifacts,
    reports: admitted,
    risk: 'high',
    readinessAdmission: admission,
  });
  assert.equal(created.status, 'READY_FOR_IMPLEMENTATION');
  assert.equal(created.reviewer_count, 2);
  assert.equal(created.provider_family_count, 2);
  const onDisk = JSON.parse(fs.readFileSync(created.receipt_path, 'utf8'));
  assert.equal(onDisk.schema_version, '2.0');
  // The carrier is persisted verbatim — readiness received it, it did not
  // rebuild it.
  assert.deepEqual(onDisk.readiness_admission, admission);
  assert.deepEqual(
    onDisk.reports.map((entry) => entry.attempt_id),
    ['attempt-claude-opus', 'attempt-codex-review'],
  );
  // One digest, two identities, two routes: exactly the shape the old
  // cross-record digest rule made unrepresentable.
  assert.equal(new Set(onDisk.reports.map((entry) => entry.sha256)).size, 1);
  assert.equal(new Set(onDisk.reports.map((entry) => entry.route_sha256)).size, 2);
  const verified = verifyReadinessReceipt({ repo, receiptPath: created.receipt_path });
  assert.equal(verified.status, 'READY_FOR_IMPLEMENTATION');
  assert.equal(verified.document_verdict, 'APPROVE');

  // Negatives. Equal bytes with nothing proving a second execution behind them
  // are refused — the copy never reaches a floor.
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts,
    reports: admitted.map(({ attempt_id: ignored, ...entry }) => entry),
    risk: 'high',
  }), /admitted attempt evidence/);

  // A copy that claims the one attempt its original already consumed.
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts,
    reports: admitted.map((entry) => ({ ...entry, attempt_id: 'attempt-claude-opus' })),
    risk: 'high',
    readinessAdmission: admission,
  }), /attempt/);

  // A copy that names no admitted attempt at all.
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts,
    reports: [admitted[0], { ...admitted[1], attempt_id: 'attempt-invented' }],
    risk: 'high',
    readinessAdmission: admission,
  }), /attempt/);

  // A single-attempt round cannot back two reports, so one admitted attempt
  // copied to a second trusted path satisfies neither floor.
  const soloRound = synthesizeReviewRound({
    attempts: [approvingAttempt('claude-opus', digest)],
    consensus: { findings: [] },
    routingPlan: {
      ...plan,
      minimum_reviewers: 1,
      planned_reviewers: 1,
      provider_family_minimum: 1,
      initial_reviewer_ids: ['claude-opus'],
      routes: [plan.routes[0]],
    },
    dispatch: trustedDispatch({
      ...plan,
      minimum_reviewers: 1,
      planned_reviewers: 1,
      provider_family_minimum: 1,
      initial_reviewer_ids: ['claude-opus'],
      routes: [plan.routes[0]],
    }, ['claude-opus'], { outputDigest: digest }),
  });
  assert.equal(soloRound.status, 'reviewed');
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts,
    reports: admitted,
    risk: 'high',
    readinessAdmission: soloRound.readiness_admission,
  }), /attempt/);

  // The report bytes must be the admitted output bytes, not merely similar.
  const wrongOutput = JSON.parse(JSON.stringify(admission));
  wrongOutput.records[0].output_sha256 = sha256('other report bytes');
  assert.throws(() => createDocumentReadinessReceipt({
    repo, artifacts, reports: admitted, risk: 'high', readinessAdmission: wrongOutput,
  }), /admitted|seal/);

  // Every admitted attempt must be consumed exactly once, so a carrier that
  // admits more attempts than this round supplied reports is not this round's
  // carrier and cannot be replayed against a smaller input.
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts,
    reports: [admitted[0]],
    risk: 'high',
    readinessAdmission: admission,
  }), /every admitted attempt must be consumed/);

  // The identity negatives are unchanged.
  const thirdPath = writeReport(repo, 'third-equal-bytes-review.md', bytes);
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts,
    reports: [admitted[0], { ...admitted[0], path: thirdPath }],
    risk: 'high',
    readinessAdmission: admission,
  }), /duplicate reviewer evidence/);
  assert.throws(() => createDocumentReadinessReceipt({
    repo,
    artifacts,
    reports: [admitted[0], { ...admitted[1], path: claudeReport }],
    risk: 'high',
    readinessAdmission: admission,
  }), /duplicate reviewer report path/);

  // Sealed-receipt verification repeats the join rather than trusting the
  // historical reviewer/path assertion: a resealed receipt that points both
  // reports at one admitted attempt is stale.
  for (const [label, mutate] of [
    ['replayed attempt id', (body) => {
      body.reports[1].attempt_id = body.reports[0].attempt_id;
    }],
    ['forged carrier seal', (body) => {
      body.readiness_admission = {
        ...body.readiness_admission,
        carrier_sha256: sha256('not the carrier'),
      };
    }],
    ['stripped admission', (body) => { body.readiness_admission = null; }],
    // The provenance duplicated onto each report is redundant only if it is
    // checked: a report that claims a route or admission digest its own
    // admitted attempt does not carry is stale.
    ['rebound route digest', (body) => {
      body.reports[1].route_sha256 = body.reports[0].route_sha256;
    }],
    ['rebound admission digest', (body) => {
      body.reports[1].admission_sha256 = body.reports[0].admission_sha256;
    }],
  ]) {
    assert.throws(
      () => verifyReadinessReceipt({
        repo,
        receiptPath: resealReceiptAt(created.receipt_path, mutate),
      }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
      label,
    );
  }

  // Each report's current bytes are still compared to its own sealed digest.
  fs.writeFileSync(codexReport, `${bytes}\n<!-- tampered -->\n`);
  assert.throws(
    () => verifyReadinessReceipt({ repo, receiptPath: created.receipt_path }),
    (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE'
      && /review report hash changed/.test(error.message),
  );
});

// T-READY-10 (D17 / I29) — the label identifies the shape. Schema-2.0 parsing is
// always strict; only a *sealed* schema-1.0 receipt recomputed under its own
// writer semantics may relax the advisory rule.
test('T-READY-10 schema-2 advisory Warning is strict while sealed schema-1 remains legacy-compatible', async () => {
  const { parseArtifactGate, verifyReadinessReceipt } = await import(readinessUrl);
  const legacy = historicalV22Fixture('1.0');
  const relabelled = historicalV22Fixture('2.0');
  // The evidence is byte-identical in both fixtures; only the receipt label
  // differs, so the outcome below is about the label and nothing else.
  assert.equal(
    sha256(fs.readFileSync(legacy.reportPath)),
    sha256(fs.readFileSync(relabelled.reportPath)),
  );
  assert.throws(
    () => parseArtifactGate(fs.readFileSync(relabelled.reportPath, 'utf8')),
    /advisory.*info|info.*advisory/,
  );

  const verifiedLegacy = verifyReadinessReceipt({
    repo: legacy.repo,
    receiptPath: legacy.receiptPath,
  });
  assert.equal(verifiedLegacy.status, 'READY_FOR_IMPLEMENTATION');
  assert.equal(verifiedLegacy.document_verdict, 'APPROVE');

  assert.throws(
    () => verifyReadinessReceipt({
      repo: relabelled.repo,
      receiptPath: relabelled.receiptPath,
    }),
    (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE'
      && /advisory|info/.test(error.message),
  );

  // The label has to identify the shape in both directions, or the two bodies
  // are back to sharing one name. A `1.0` receipt carrying admission
  // provenance, and a `2.0` receipt missing it, are each incoherent.
  for (const [fixture, mutate] of [
    [legacy, (body) => { body.readiness_admission = null; }],
    [relabelled, (body) => { delete body.readiness_admission; }],
  ]) {
    assert.throws(
      () => verifyReadinessReceipt({
        repo: fixture.repo,
        receiptPath: resealReceiptAt(fixture.receiptPath, mutate),
      }),
      (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
    );
  }
});

// A genuine reverted verifier: the current module with its dual reader narrowed
// back to schema 1.0 only. Nothing else changes, so the stale result below is
// about the accepted schema set and not about some other divergence.
function revertedTo10OnlyVerifier() {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-readiness-1only-'));
  fs.mkdirSync(path.join(dest, 'lib'), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'hooks', 'scripts', 'lib', 'runtime-context.mjs'),
    path.join(dest, 'lib', 'runtime-context.mjs'),
  );
  const current = fs.readFileSync(
    path.join(root, 'hooks', 'scripts', 'document-readiness.mjs'),
    'utf8',
  );
  const reverted = current.replace(
    'new Set([LEGACY_RECEIPT_SCHEMA, RECEIPT_SCHEMA])',
    'new Set([LEGACY_RECEIPT_SCHEMA])',
  );
  assert.notEqual(reverted, current, 'the dual reader must be revertible to a 1.0-only verifier');
  const file = path.join(dest, 'document-readiness.mjs');
  fs.writeFileSync(file, reverted);
  return pathToFileURL(file).href;
}

// T-READY-11 (D17 / I31) — the rollback path is fail-closed and explicit.
test('T-READY-11 schema-2 receipt fails stale under a 1.0-only verifier and bounded reissue restores verification', async () => {
  const {
    createDocumentReadinessReceipt,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const reverted = await import(revertedTo10OnlyVerifier());
  const repo = repoFixture();
  const reportPath = writeReport(repo, 'schema-2-review.md', report({
    verdict: 'APPROVE',
    warning: 0,
    findings: [],
  }));
  const issue = () => createDocumentReadinessReceipt({
    repo,
    artifacts: [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }],
    reports: [{ path: reportPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
    requiredReviewers: 1,
    providerFamilyMinimum: 1,
  });
  const created = issue();
  assert.equal(
    JSON.parse(fs.readFileSync(created.receipt_path, 'utf8')).schema_version,
    '2.0',
  );
  const beforeBytes = sha256(fs.readFileSync(created.receipt_path));
  assert.throws(
    () => reverted.verifyReadinessReceipt({ repo, receiptPath: created.receipt_path }),
    (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
  );
  // The rejecting verifier rewrites nothing.
  assert.equal(sha256(fs.readFileSync(created.receipt_path)), beforeBytes);

  // Bounded reissue: one re-run of the coherent document authority, not a loop.
  const maximumReissues = 1;
  let reissues = 0;
  let restored = null;
  let restoredPath = null;
  while (restored === null && reissues < maximumReissues) {
    reissues += 1;
    restoredPath = issue().receipt_path;
    restored = verifyReadinessReceipt({ repo, receiptPath: restoredPath });
  }
  assert.equal(reissues, 1);
  assert.equal(restored.status, 'READY_FOR_IMPLEMENTATION');

  // A roll-forward, not a rollback: the reissued receipt is still stale to a
  // 1.0-only verifier, so recovery needs a coordinated downgrade, and the
  // current verifier still reads a genuine sealed 1.0 receipt.
  assert.throws(
    () => reverted.verifyReadinessReceipt({ repo, receiptPath: restoredPath }),
    (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
  );
  const legacy = historicalV22Fixture('1.0');
  assert.equal(
    verifyReadinessReceipt({ repo: legacy.repo, receiptPath: legacy.receiptPath }).status,
    'READY_FOR_IMPLEMENTATION',
  );
});

// A genuine sealed `1.0` receipt written by the schema-1.0 writer, whose two
// admitted reviewers used the same local id with byte-equivalent content. That
// writer collapsed them, so the sealed evidence carries exactly one bare
// obligation and the dual reader must reproduce that, not a reviewer-scoped
// recomputation.
function legacyCollapsedFixture({
  codexEvidence = ['migration dry-run passes'],
  deferredId = 'DOC-1',
} = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-readiness-legacy-'));
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.deep-review', 'reports'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.deep-review', 'receipts', 'document-readiness'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'plan.md'), '# Plan\n\nMigrate safely.\n');
  const finding = (evidence) => ({
    id: 'DOC-1',
    severity: 'warning',
    stage: 'implementation_verification',
    acceptance_evidence: evidence,
  });
  const gate = (evidence) => ({ schema_version: 1, findings: [finding(evidence)] });
  // The two reports differ outside the gate, so their digests differ and the
  // schema-1.0 writer's own path/content rules are satisfied.
  const body = (evidence, marker) => `${report({
    findings: [finding(evidence)],
  })}\n<!-- ${marker} -->\n`;
  const claudeBytes = body(['migration dry-run passes'], 'claude');
  const codexBytes = body(codexEvidence, 'codex');
  const claudePath = path.join(repo, '.deep-review', 'reports', 'legacy-claude-review.md');
  const codexPath = path.join(repo, '.deep-review', 'reports', 'legacy-codex-review.md');
  fs.writeFileSync(claudePath, claudeBytes);
  fs.writeFileSync(codexPath, codexBytes);
  const documentBytes = fs.readFileSync(path.join(repo, 'docs', 'plan.md'));
  const documents = [{
    byte_size: documentBytes.length,
    path: 'docs/plan.md',
    sha256: sha256(documentBytes),
    target_kind: 'implementation-plan',
  }];
  const scopeSha256 = sha256(Buffer.from(canonicalJsonV22(documents.map((entry) => ({
    path: entry.path,
    target_kind: entry.target_kind,
    sha256: entry.sha256,
  }))), 'utf8'));
  const reportRecord = (relative, reviewerId, providerFamily, bytes, evidence) => ({
    artifact_gate_sha256: sha256(Buffer.from(canonicalJsonV22(gate(evidence)), 'utf8')),
    path: `.deep-review/reports/${relative}`,
    provider_family: providerFamily,
    reviewer_id: reviewerId,
    sha256: sha256(Buffer.from(bytes, 'utf8')),
  });
  const receiptBody = {
    // Exactly one bare obligation: what the 1.0 writer produced from two
    // canonically identical cross-reviewer findings.
    deferred_findings: [{
      acceptance_evidence: ['migration dry-run passes'],
      finding_id: deferredId,
      severity: 'warning',
    }],
    documents,
    generated_at: '2026-07-24T00:00:00.000Z',
    reports: [
      reportRecord('legacy-claude-review.md', 'claude-opus', 'claude', claudeBytes, ['migration dry-run passes']),
      reportRecord('legacy-codex-review.md', 'codex-review', 'codex', codexBytes, codexEvidence),
    ],
    repository_identity_sha256: sha256(Buffer.from(fs.realpathSync(repo), 'utf8')),
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
    ...receiptBody,
    receipt_sha256: sha256(Buffer.from(canonicalJsonV22(receiptBody), 'utf8')),
  };
  const receiptPath = path.join(
    repo,
    '.deep-review',
    'receipts',
    'document-readiness',
    `${scopeSha256}-${receipt.receipt_sha256}.json`,
  );
  fs.writeFileSync(receiptPath, `${canonicalJsonV22(receipt)}\n`);
  return { repo, receiptPath, claudeBytes };
}

// T-READY-6 (D17 / I20) — a valid sealed schema-1.0 receipt stays valid.
test('T-READY-6 sealed schema-1.0 identical duplicates remain one legacy-global obligation', async () => {
  const {
    evaluateDeferredAcceptance,
    verifyReadinessReceipt,
  } = await import(readinessUrl);
  const fixture = legacyCollapsedFixture();
  const legacyRef = { finding_id: 'DOC-1', scope: 'legacy_global' };
  const beforeBytes = sha256(fs.readFileSync(fixture.receiptPath));

  const verified = verifyReadinessReceipt({
    repo: fixture.repo,
    receiptPath: fixture.receiptPath,
  });
  assert.equal(verified.status, 'READY_FOR_IMPLEMENTATION');
  assert.equal(verified.document_verdict, 'CONCERN');
  // Exactly one obligation, deliberately non-attributing rather than guessing
  // which of the two identical historical reviewer gates produced it.
  assert.deepEqual(verified.deferred_findings, [{
    acceptance_evidence: ['migration dry-run passes'],
    finding_ref: legacyRef,
    severity: 'warning',
  }]);
  // No historical byte is rewritten or resealed.
  assert.equal(sha256(fs.readFileSync(fixture.receiptPath)), beforeBytes);

  fs.writeFileSync(path.join(fixture.repo, 'implementation.js'), 'export const migrated = true;\n');
  fs.writeFileSync(path.join(fixture.repo, 'migration-test.tap'), 'ok 1 - migration rollback roundtrip\n');
  const implementationArtifacts = [{ path: 'implementation.js' }];
  const pending = evaluateDeferredAcceptance({
    receipt: verified,
    verifiedItems: [],
    repo: fixture.repo,
    implementationArtifacts,
  });
  assert.equal(pending.required_count, 1);
  assert.deepEqual(pending.pending_finding_refs, [legacyRef]);

  // One discharge closes the one obligation, however many identical historical
  // reviewer gates stand behind it.
  const evidenceSha256 = sha256(fs.readFileSync(path.join(fixture.repo, 'migration-test.tap')));
  const complete = evaluateDeferredAcceptance({
    receipt: verified,
    verifiedItems: [{
      finding_id: 'DOC-1',
      implementation_scope_sha256: pending.implementation_scope_sha256,
      verification_results: [{
        criterion: 'migration dry-run passes',
        status: 'passed',
        evidence_path: 'migration-test.tap',
        evidence_sha256: evidenceSha256,
      }],
    }],
    repo: fixture.repo,
    implementationArtifacts,
    implementationScopeSha256: pending.implementation_scope_sha256,
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.verified_count, 1);
  assert.deepEqual(complete.verified_items[0].finding_ref, legacyRef);

  // Conflicting multi-match: the same local id from two reviewers with
  // different content was never one obligation, so the historical seal cannot
  // be reproduced and the receipt is stale.
  const conflicting = legacyCollapsedFixture({
    codexEvidence: ['rollback restores the prior schema'],
  });
  const conflictingBefore = sha256(fs.readFileSync(conflicting.receiptPath));
  assert.throws(
    () => verifyReadinessReceipt({
      repo: conflicting.repo,
      receiptPath: conflicting.receiptPath,
    }),
    (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
  );
  assert.equal(sha256(fs.readFileSync(conflicting.receiptPath)), conflictingBefore);

  // Zero matches: a sealed obligation no historical gate produced.
  const orphaned = legacyCollapsedFixture({ deferredId: 'DOC-404' });
  assert.throws(
    () => verifyReadinessReceipt({ repo: orphaned.repo, receiptPath: orphaned.receiptPath }),
    (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
  );

  // A `1.0` receipt carries no admission evidence, so the digest uniqueness its
  // own writer enforced is what stands in for it. Dropping the cross-record
  // digest rule from the *new* path must not open the legacy one: a resealed
  // `1.0` receipt claiming two reviewers behind one copied report is stale.
  const copied = legacyCollapsedFixture();
  const copyPath = path.join(copied.repo, '.deep-review', 'reports', 'legacy-copy-review.md');
  fs.writeFileSync(copyPath, copied.claudeBytes);
  assert.throws(
    () => verifyReadinessReceipt({
      repo: copied.repo,
      receiptPath: resealReceiptAt(copied.receiptPath, (body) => {
        body.reports[1] = {
          ...body.reports[0],
          path: '.deep-review/reports/legacy-copy-review.md',
          provider_family: 'codex',
          reviewer_id: 'codex-review',
        };
      }),
    }),
    (error) => error.code === 'ERROR_READINESS_RECEIPT_STALE',
  );
});

// The six malformed classes the canonical parser can reject, each as a report a
// reviewer actually wrote.
function malformedGateReports() {
  const finding = {
    id: 'DOC-1',
    severity: 'warning',
    stage: 'implementation_verification',
    acceptance_evidence: ['codex: rollback restores the prior schema'],
  };
  const gateBlock = (value) => ['## Artifact Gate', '```json', JSON.stringify(value, null, 2), '```'];
  const wrap = (lines, { warning = 1 } = {}) => [
    '# Deep Review Report — 2026-07-24',
    '',
    '## Summary',
    '- **Verdict**: CONCERN',
    `- **Issues**: 🔴 0건, 🟡 ${warning}건, ℹ️ 0건`,
    '',
    ...lines,
    '',
  ].join('\n');
  const valid = { schema_version: 1, findings: [finding] };
  return [
    ['missing gate', 'ERROR_ARTIFACT_GATE_MISSING', wrap([])],
    ['duplicate gate', 'ERROR_ARTIFACT_GATE_DUPLICATE', wrap([...gateBlock(valid), '', ...gateBlock(valid)])],
    ['invalid schema', 'ERROR_ARTIFACT_GATE_INVALID_SCHEMA', wrap(gateBlock({ ...valid, schema_version: 2 }))],
    ['invalid stage', 'ERROR_ARTIFACT_GATE_INVALID_STAGE', wrap(gateBlock({
      schema_version: 1,
      findings: [{ ...finding, stage: 'invented' }],
    }))],
    ['missing acceptance evidence', 'ERROR_ARTIFACT_GATE_MISSING_ACCEPTANCE_EVIDENCE', wrap(gateBlock({
      schema_version: 1,
      findings: [{ ...finding, acceptance_evidence: [] }],
    }))],
    ['count mismatch', 'ERROR_ARTIFACT_GATE_COUNT_MISMATCH', wrap(gateBlock(valid), { warning: 2 })],
  ];
}

// T-READY-2 (D16) — a canonical gate-parse failure is that reviewer's local
// failure. It becomes a stable exclusion record and lowers the admitted floor;
// it never aborts readiness and never borrows another reviewer's local id.
test('T-READY-2 malformed gate exclusion lowers the admitted readiness floor', async (t) => {
  const { createDocumentReadinessReceipt } = await import(readinessUrl);
  const artifacts = [{ path: 'docs/계획 Ω.md', target_kind: 'implementation-plan' }];
  const admittedReport = report({
    verdict: 'REQUEST_CHANGES',
    warning: 1,
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'pre_implementation',
      acceptance_evidence: ['claude: resolve the migration contradiction'],
    }],
  });
  const wellFormedCodex = report({
    findings: [{
      id: 'DOC-1',
      severity: 'warning',
      stage: 'implementation_verification',
      acceptance_evidence: ['codex: rollback restores the prior schema'],
    }],
  });
  const readinessFor = (codexBody) => {
    const repo = repoFixture();
    const claudePath = writeReport(repo, 'claude-admitted-review.md', admittedReport);
    const codexPath = writeReport(repo, 'codex-gate-review.md', codexBody);
    return createDocumentReadinessReceipt({
      repo,
      artifacts,
      reports: [
        { path: claudePath, reviewer_id: 'claude-opus', provider_family: 'claude' },
        { path: codexPath, reviewer_id: 'codex-review', provider_family: 'codex' },
      ],
      risk: 'high',
    });
  };

  // Control: with both gates well-formed the floors are met, so every floor
  // effect below is caused by the exclusion and nothing else.
  const control = readinessFor(wellFormedCodex);
  assert.equal(control.reviewer_count, 2);
  assert.equal(control.provider_family_count, 2);
  assert.deepEqual(control.gate_exclusions, []);
  assert.equal(control.blocking_reasons.includes('required_reviewers'), false);
  assert.equal(control.blocking_reasons.includes('provider_families'), false);

  for (const [label, code, body] of malformedGateReports()) {
    await t.test(label, () => {
      let result;
      // Readiness does not abort: one reviewer's malformed gate is not the
      // round's failure.
      assert.doesNotThrow(() => { result = readinessFor(body); });
      assert.deepEqual(result.gate_exclusions, [{
        code,
        path: '.deep-review/reports/codex-gate-review.md',
        provider_family: 'codex',
        reviewer_id: 'codex-review',
      }]);
      // The floor is computed from admitted reports only.
      assert.equal(result.reviewer_count, 1);
      assert.equal(result.provider_family_count, 1);
      assert.equal(result.status, 'DOCUMENT_BLOCKED');
      assert.equal(result.receipt_path, null);
      assert.ok(result.blocking_reasons.includes('required_reviewers'));
      assert.ok(result.blocking_reasons.includes('provider_families'));
      // And the excluded reviewer's local id is not conflated with the
      // admitted reviewer's identically named one.
      assert.deepEqual(result.blocking_finding_refs, [
        { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
      ]);
      assert.deepEqual(result.deferred_findings, []);
    });
  }

  // Every report excluded is fail-closed, not a crash.
  const [, , firstMalformed] = malformedGateReports()[0];
  const allExcluded = (() => {
    const repo = repoFixture();
    const claudePath = writeReport(repo, 'claude-gate-review.md', firstMalformed);
    const codexPath = writeReport(repo, 'codex-gate-review.md', `${firstMalformed}\n<!-- codex -->\n`);
    return createDocumentReadinessReceipt({
      repo,
      artifacts,
      reports: [
        { path: claudePath, reviewer_id: 'claude-opus', provider_family: 'claude' },
        { path: codexPath, reviewer_id: 'codex-review', provider_family: 'codex' },
      ],
      risk: 'high',
    });
  })();
  assert.equal(allExcluded.status, 'DOCUMENT_BLOCKED');
  assert.equal(allExcluded.reviewer_count, 0);
  assert.equal(allExcluded.gate_exclusions.length, 2);
});

// D17's identity predicate is only as strong as the shape authority under it.
// Both halves are load-bearing and neither had a test: the pattern clause, and
// the type check the pattern clause silently substitutes for via coercion.
test('the Artifact Gate finding id is a typed, pattern-checked string in every shape authority', async () => {
  const {
    evaluateDeferredAcceptance,
    evaluateDocumentReadiness,
    parseArtifactGate,
  } = await import(readinessUrl);
  const repo = repoFixture();
  fs.writeFileSync(path.join(repo, 'implementation.js'), 'export const migrated = true;\n');
  const implementationArtifacts = [{ path: 'implementation.js' }];
  const obligation = (findingId) => ({
    deferred_findings: [{
      finding_ref: { finding_id: findingId, reviewer_id: 'claude-opus' },
      severity: 'warning',
      acceptance_evidence: ['migration dry-run passes'],
    }],
  });
  const admit = (findingId) => evaluateDeferredAcceptance({
    receipt: obligation(findingId),
    verifiedItems: [],
    repo,
    implementationArtifacts,
  });

  // The pattern clause. Each of these is refused as a live pending obligation.
  for (const malformed of [
    '',
    '../../etc/passwd',
    'DOC-1\nDOC-2',
    'DOC-1\0DOC-2',
    'DOC 1',
    '-DOC-1',
    `DOC-${'x'.repeat(128)}`,
  ]) {
    assert.throws(
      () => admit(malformed),
      /deferred readiness obligation requires a reviewer-scoped finding_ref/,
      JSON.stringify(malformed),
    );
  }
  // The same obligation with a well-formed id is admitted, so each refusal is
  // about the id and not the surrounding shape.
  assert.deepEqual(admit('DOC-1').pending_finding_refs, [
    { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
  ]);

  // The type clause. `RegExp.test` coerces, so a pattern check alone admits
  // values that are not strings at all — including ones whose coercion matches.
  for (const nonString of [null, undefined, 7, 0, true, false, ['DOC-1'], { id: 'DOC-1' }]) {
    assert.throws(
      () => admit(nonString),
      /deferred readiness obligation requires a reviewer-scoped finding_ref/,
      String(nonString),
    );
  }

  // `parseArtifactGate` is where a reviewer's own JSON enters, and it is the
  // same coercion there. Truthiness does not predict the outcome; the type does.
  const gate = (id) => report({
    findings: [{
      id,
      severity: 'warning',
      stage: 'implementation_verification',
      acceptance_evidence: ['evidence'],
    }],
  });
  assert.equal(typeof parseArtifactGate(gate('DOC-1')).findings[0].id, 'string');
  assert.equal(parseArtifactGate(gate('7')).findings[0].id, '7');
  assert.equal(parseArtifactGate(gate('0')).findings[0].id, '0');
  assert.equal(parseArtifactGate(gate('false')).findings[0].id, 'false');
  for (const nonString of [7, 0, true, false, null, ['DOC-1'], { id: 'DOC-1' }]) {
    assert.throws(() => parseArtifactGate(gate(nonString)), /invalid id/, String(nonString));
  }

  // And no non-string id reaches the authoritative carrier by another door.
  assert.throws(() => evaluateDocumentReadiness({
    reportEvidence: [{
      reviewer_id: 'claude-opus',
      provider_family: 'claude',
      artifact_gate: {
        schema_version: 1,
        findings: [{
          id: true,
          severity: 'warning',
          stage: 'pre_implementation',
          acceptance_evidence: ['evidence'],
        }],
      },
    }],
    risk: 'low',
  }), /finding id/);
});
