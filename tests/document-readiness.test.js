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

function historicalV22Fixture() {
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
    reports: [report],
    repository_identity_sha256: sha256(Buffer.from(fs.realpathSync(repo), 'utf8')),
    reviewer_requirements: {
      actual_provider_families: 1,
      actual_reviewers: 1,
      provider_family_minimum: 1,
      required_reviewers: 1,
    },
    risk: 'low',
    schema_version: '1.0',
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
  assert.throws(() => createDocumentReadinessReceipt({
    repo: fixture.repo,
    artifacts: [{ path: 'docs/implementation-plan.md', target_kind: 'implementation-plan' }],
    reports: [{ path: fixture.reportPath, reviewer_id: 'claude-opus', provider_family: 'claude' }],
    risk: 'low',
  }), /advisory.*info|info.*advisory/);
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
  }), /duplicate reviewer report path or content hash/);
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
