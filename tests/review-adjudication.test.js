const test = require('node:test');
const assert = require('node:assert/strict');
function report(severity = 'warning', extra = '') {
  return `# Deep Review Report — 2026-09-06\n\n## Summary\n\n- **Verdict**: ${severity === 'critical' ? 'REQUEST_CHANGES' : severity ? 'CONCERN' : 'APPROVE'}\n- **Issues**: 🔴 ${severity === 'critical' ? 1 : 0}건, 🟡 ${severity === 'warning' ? 1 : 0}건, ℹ️ 0건\n\n## Code Review\n\n### 🔴 Critical\n${severity === 'critical' ? '- `src/a.js:14` can drop saved records.' : 'None.'}\n### 🟡 Warning\n${severity === 'warning' ? '- `src/a.js:14` error path lacks coverage.' : 'None.'}\n### ℹ️ Info\nNone.\n### 🟢 Passed\n- Remaining checks passed.\n${extra}`;
}
async function fixture(severity = 'warning') {
  const s = await import('../hooks/scripts/review-synthesis.mjs');
  const a = await import('../hooks/scripts/lib/review-adjudication.mjs');
  const output = report(severity);
  const attempt = s.evaluateReviewerAttempt({
    reviewer_id: 'codex-review',
    role: 'codex-review',
    output,
    target_before: typeof target === 'undefined' ? null : target,
    target_after: typeof target === 'undefined' ? null : target,
    beforeFingerprint: { mode: 'git', digest: 'a' },
    afterFingerprint: { mode: 'git', digest: 'a' },
  });
  const refs = a
    .extractSourceFindings(output, 'codex-review')
    .map(({ reviewer_id, report_sha256, severity, ordinal }) => ({
      reviewer_id,
      report_sha256,
      severity,
      ordinal,
    }));
  return { ...a, attempt, refs };
}
function adjudication(
  refs,
  disposition = 'refuted',
  severity = 'warning',
  category = 'test-coverage',
) {
  return {
    schema_version: '1.0',
    groups: [
      {
        source_refs: refs,
        disposition,
        severity,
        category,
        rationale: 'The existing assertion exercises the error path.',
        evidence: [
          { location: 'tests/a.test.js:14', observation: 'The rejected write is asserted.' },
        ],
        ...(disposition === 'unresolved'
          ? { missing_evidence: 'Cannot reproduce storage interruption.' }
          : {}),
      },
    ],
  };
}
test('raw bound evidence determines material verdict; agreement is not authority', async () => {
  const f = await fixture();
  for (const [disposition, verdict] of [
    ['refuted', 'APPROVE'],
    ['advisory', 'APPROVE'],
    ['confirmed_blocker', 'REQUEST_CHANGES'],
    ['unresolved', 'CONCERN'],
  ]) {
    const result = f.evaluateAdjudication({
      adjudication: adjudication(f.refs, disposition),
      attempts: [f.attempt],
    });
    assert.equal(result.verdict, verdict);
  }
  assert.equal(
    f.evaluateAdjudication({
      adjudication: adjudication(f.refs, 'unresolved', 'warning', 'security'),
      attempts: [f.attempt],
    }).verdict,
    'REQUEST_CHANGES',
  );
});
test('exhaustive exact refs, concrete evidence and severity floors fail closed', async () => {
  const f = await fixture('critical');
  const base = adjudication(f.refs, 'unresolved', 'critical');
  for (const mutate of [
    (a) => (a.groups[0].source_refs = []),
    (a) => a.groups.push(a.groups[0]),
    (a) => (a.groups[0].source_refs[0].report_sha256 = 'f'.repeat(64)),
    (a) => (a.groups[0].evidence = []),
    (a) => (a.groups[0].evidence[0].location = 'unknown'),
    (a) => (a.groups[0].severity = 'warning'),
    (a) => (a.groups[0].disposition = 'advisory'),
  ]) {
    const a = structuredClone(base);
    mutate(a);
    assert.throws(() => f.evaluateAdjudication({ adjudication: a, attempts: [f.attempt] }));
  }
  assert.throws(() => f.evaluateAdjudication({ adjudication: base, attempts: [{ ...f.attempt }] }));
});
test('confirmation requires exact positive raw claims and conflicts stay open', async (t) => {
  const f = await fixture();
  const s = await import('../hooks/scripts/review-synthesis.mjs');
  const fs = require('node:fs');
  const path = require('node:path');
  const repo = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'confirm-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'a.js'), 'test');
  const targets = await import('../hooks/scripts/lib/review-target-snapshot.mjs');
  const target = await targets.captureReviewTarget({
    scope: await targets.createTargetScope({
      repo,
      changeState: 'non-git',
      records: [{ path: 'a.js', status: 'non-git' }],
    }),
  });
  const output = report(
    '',
    `\n## Confirmation\n\`\`\`json\n${JSON.stringify({ schema_version: 1, target_digest: target.target_digest, items: [{ finding_id: 'f1', status: 'verified_closed', evidence: [{ location: 'src/a.js:14', observation: 'The failure is handled.' }] }] })}\n\`\`\`\n`,
  );
  const attempt = s.evaluateReviewerAttempt({
    reviewer_id: 'codex-review',
    role: 'codex-review',
    output,
    target_before: typeof target === 'undefined' ? null : target,
    target_after: typeof target === 'undefined' ? null : target,
    beforeFingerprint: { mode: 'git', digest: 'a' },
    afterFingerprint: { mode: 'git', digest: 'a' },
  });
  assert.equal(
    f.verifyConfirmation({
      attempts: [attempt],
      requiredFindings: ['f1'],
      target,
      currentFindings: [],
    }).complete,
    true,
  );
  assert.equal(
    f.verifyConfirmation({
      attempts: [attempt],
      requiredFindings: ['f1'],
      target,
      currentFindings: [{ finding_id: 'f1' }],
    }).complete,
    false,
  );
  assert.throws(() =>
    f.verifyConfirmation({
      attempts: [attempt],
      requiredFindings: ['foreign'],
      target,
      currentFindings: [],
    }),
  );
  assert.equal(
    f.verifyConfirmation({
      attempts: [f.attempt],
      requiredFindings: ['f1'],
      target,
      currentFindings: [],
    }).complete,
    false,
  );
});
module.exports = { report, adjudication };
