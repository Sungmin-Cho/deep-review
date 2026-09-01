'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseReviewerReportFrozen } = require('./helpers/frozen-review-parser.cjs');

const root = path.resolve(__dirname, '..');
const synthesisUrl = pathToFileURL(path.join(root, 'hooks/scripts/review-synthesis.mjs')).href;

function canonicalReviewerReport({
  date = '2026-07-26',
  verdict = 'APPROVE',
  critical = 0,
  warning = 0,
  info = 0,
  bodyCritical = critical,
  bodyWarning = warning,
  bodyInfo = info,
  includeCodeReview = true,
  passed = 'Contract valid.',
} = {}) {
  const findings = (count, label) => (
    count === 0
      ? 'None.'
      : Array.from({ length: count }, (_, index) => `- ${label} ${index + 1}.`).join('\n')
  );
  return [
    `# Deep Review Report — ${date}`,
    '',
    '## Summary',
    '',
    `- **Verdict**: ${verdict}`,
    `- **Issues**: 🔴 ${critical}건, 🟡 ${warning}건, ℹ️ ${info}건`,
    ...(includeCodeReview
      ? [
          '',
          '## Code Review',
          '',
          '### 🔴 Critical',
          '',
          findings(bodyCritical, 'Critical finding'),
          '',
          '### 🟡 Warning',
          '',
          findings(bodyWarning, 'Warning finding'),
          '',
          '### ℹ️ Info',
          '',
          findings(bodyInfo, 'Info finding'),
          '',
          '### 🟢 Passed',
          '',
          `- ${passed}`,
        ]
      : []),
    '',
  ].join('\n');
}

const valid = canonicalReviewerReport();

function withoutCodeReview() {
  return canonicalReviewerReport({ includeCodeReview: false });
}

test('diagnoseReviewerReport reports the first closed-enum failure (T4)', async () => {
  const { diagnoseReviewerReport } = await import(synthesisUrl);
  const cases = [
    ['empty_output', '', 'empty_output'],
    ['empty_output non-string', 0, 'empty_output'],
    ['report_title_invalid', '## Summary\n\n- **Verdict**: APPROVE\n', 'report_title_invalid'],
    [
      'prose_before_title',
      `Preamble\n${valid}`,
      'prose_before_title',
    ],
    [
      'summary_heading_invalid',
      valid.replace('## Summary', '## Overview'),
      'summary_heading_invalid',
    ],
    [
      'code_review_heading_invalid duplicate',
      `${valid}\n## Code Review\n`,
      'code_review_heading_invalid',
    ],
    [
      'prose_before_summary',
      valid.replace('## Summary', 'noise\n\n## Summary'),
      'prose_before_summary',
    ],
    [
      'code_review_before_summary is prose_before_summary first',
      withoutCodeReview().replace(
        '## Summary',
        '## Code Review\n\n### 🔴 Critical\n\nNone.\n\n## Summary',
      ),
      'prose_before_summary',
    ],
    [
      'verdict_label_invalid',
      valid.replace('- **Verdict**: APPROVE\n', ''),
      'verdict_label_invalid',
    ],
    [
      'issues_label_invalid',
      valid.replace('- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n', ''),
      'issues_label_invalid',
    ],
    [
      'verdict_value_invalid',
      valid.replace('- **Verdict**: APPROVE', '- **Verdict**: MAYBE'),
      'verdict_value_invalid',
    ],
    [
      'issues_line_invalid',
      valid.replace('- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건', '- **Issues**: unavailable'),
      'issues_line_invalid',
    ],
    [
      'verdict_issues_inconsistent',
      canonicalReviewerReport({ verdict: 'APPROVE', warning: 1 }),
      'verdict_issues_inconsistent',
    ],
    [
      'section_headings_invalid order',
      valid
        .replace('### 🔴 Critical', '### 🔴 TMP')
        .replace('### 🟡 Warning', '### 🔴 Critical')
        .replace('### 🔴 TMP', '### 🟡 Warning'),
      'section_headings_invalid',
    ],
    [
      'prose_before_first_section',
      valid.replace(
        '## Code Review\n\n### 🔴 Critical',
        '## Code Review\n\n- Unscoped finding.\n\n### 🔴 Critical',
      ),
      'prose_before_first_section',
    ],
    [
      'finding_lines_invalid:critical',
      valid.replace('### 🔴 Critical\n\nNone.', '### 🔴 Critical\n\nprose finding without bullet'),
      'finding_lines_invalid:critical',
    ],
    [
      'finding_lines_invalid:passed',
      valid.replace('- Contract valid.', 'Contract valid.'),
      'finding_lines_invalid:passed',
    ],
    [
      'count_mismatch:warning',
      canonicalReviewerReport({ verdict: 'CONCERN', warning: 1, bodyWarning: 0 }),
      'count_mismatch:warning',
    ],
  ];

  for (const [name, report, failure] of cases) {
    const diagnosed = diagnoseReviewerReport(report, { strict: true });
    assert.equal(diagnosed.ok, false, name);
    assert.equal(diagnosed.failure, failure, name);
  }
});

test('diagnoseReviewerReport first-failure order is the table order, not defect severity (T4)', async () => {
  const { diagnoseReviewerReport } = await import(synthesisUrl);

  const missingContainerAndVerdict = withoutCodeReview().replace('- **Verdict**: APPROVE\n', '');
  assert.deepEqual(
    diagnoseReviewerReport(missingContainerAndVerdict, { strict: true }),
    { ok: false, failure: 'verdict_label_invalid' },
  );

  const preambleAndMalformedHeading = valid
    .replace(
      '## Code Review\n\n### 🔴 Critical',
      '## Code Review\n\n- Unscoped finding.\n\n### 🔴 Critical',
    )
    .replace('### 🟢 Passed', '### 🟢 Notes');
  assert.deepEqual(
    diagnoseReviewerReport(preambleAndMalformedHeading, { strict: true }),
    { ok: false, failure: 'section_headings_invalid' },
  );

  const duplicateContainerAndMissingVerdict = `${valid.replace('- **Verdict**: APPROVE\n', '')}\n## Code Review\n`;
  assert.deepEqual(
    diagnoseReviewerReport(duplicateContainerAndMissingVerdict, { strict: true }),
    { ok: false, failure: 'code_review_heading_invalid' },
  );
});

test('strict container-zero reports stay rejected until T5 (T4)', async () => {
  const { diagnoseReviewerReport, parseReviewerReport } = await import(synthesisUrl);
  const missingContainer = withoutCodeReview();
  assert.deepEqual(
    diagnoseReviewerReport(missingContainer, { strict: true }),
    { ok: false, failure: 'section_headings_invalid' },
  );
  assert.equal(parseReviewerReport(missingContainer, { strict: true }), null);
});

test('non-strict admission set is unchanged (T4)', async () => {
  const { diagnoseReviewerReport, parseReviewerReport } = await import(synthesisUrl);
  const summaryOnly = withoutCodeReview();
  assert.deepEqual(
    diagnoseReviewerReport(summaryOnly),
    { ok: true, verdict: 'APPROVE', issues: { critical: 0, warning: 0, info: 0 } },
  );
  assert.deepEqual(
    parseReviewerReport(summaryOnly),
    { verdict: 'APPROVE', issues: { critical: 0, warning: 0, info: 0 } },
  );
  assert.equal(Object.hasOwn(parseReviewerReport(summaryOnly), 'tolerances'), false);
});

test('parseReviewerReport stays equivalent to the frozen v2.8.1 oracle (T4)', async () => {
  const { parseReviewerReport } = await import(synthesisUrl);
  const fixtures = [
    ['', {}],
    [valid, {}],
    [valid, { strict: true }],
    [withoutCodeReview(), {}],
    [withoutCodeReview(), { strict: true }],
    [`Preamble\n${valid}`, { strict: true }],
    [valid.replace('## Summary', '## Overview'), { strict: true }],
    [`${valid}\n## Code Review\n`, {}],
    [`${valid}\n## Code Review\n`, { strict: true }],
    [valid.replace('## Summary', 'noise\n\n## Summary'), {}],
    [
      valid.replace(
        '## Summary',
        '## Code Review\n\n### 🔴 Critical\n\nNone.\n\n## Summary',
      ),
      { strict: true },
    ],
    [valid.replace('- **Verdict**: APPROVE\n', ''), { strict: true }],
    [valid.replace('- **Verdict**: APPROVE', '- **Verdict**: MAYBE'), {}],
    [canonicalReviewerReport({ verdict: 'APPROVE', warning: 1 }), {}],
    [canonicalReviewerReport({ warning: 1, bodyWarning: 0 }), { strict: true }],
    [
      valid.replace(
        '## Code Review\n\n### 🔴 Critical',
        '## Code Review\n\n- Unscoped finding.\n\n### 🔴 Critical',
      ),
      { strict: true },
    ],
    [
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n\n## Appendix\n\n- **Verdict**: REQUEST_CHANGES\n- **Issues**: 🔴 9건, 🟡 9건, ℹ️ 9건\n',
      {},
    ],
    [
      canonicalReviewerReport({ verdict: 'CONCERN', warning: 1, info: 1 }),
      { strict: true },
    ],
    [
      valid.replace('- **Verdict**: APPROVE', '- **Verdict**: APPROVE\n- **verdict**: REQUEST_CHANGES'),
      { strict: true },
    ],
  ];

  for (const [report, options] of fixtures) {
    assert.deepEqual(
      parseReviewerReport(report, options),
      parseReviewerReportFrozen(report, options),
    );
  }
});
