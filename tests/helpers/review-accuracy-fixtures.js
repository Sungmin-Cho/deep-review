'use strict';

function section(findings) {
  return findings.length === 0 ? 'None.' : findings.map((finding) => `- ${finding}`).join('\n');
}

function report({ critical = [], warning = [], info = [] } = {}) {
  const verdict = critical.length > 0
    ? 'REQUEST_CHANGES'
    : warning.length > 0 ? 'CONCERN' : 'APPROVE';
  return [
    '# Deep Review Report — 2026-09-06',
    '',
    '## Summary',
    '',
    `- **Verdict**: ${verdict}`,
    '- **Review Mode**: N-way',
    `- **Issues**: 🔴 ${critical.length}건, 🟡 ${warning.length}건, ℹ️ ${info.length}건`,
    '',
    '## Code Review',
    '',
    '### 🔴 Critical',
    '',
    section(critical),
    '',
    '### 🟡 Warning',
    '',
    section(warning),
    '',
    '### ℹ️ Info',
    '',
    section(info),
    '',
    '### 🟢 Passed',
    '',
    '- Report contract emitted.',
    '',
  ].join('\n');
}

module.exports = { report };
