import { canonicalStringify } from '../document-readiness.mjs';
// D16 — the single canonical source of the outer report contract.
//
// `buildReportContract` returns the phase-independent outer contract text for
// every artifact phase, and appends exactly one `## Artifact Gate` section
// when `artifactPhase === 'document'`. It is the only place that text is
// assembled; a caller composes it into a prompt but never restates it.

const BASE_CONTRACT = `OUTPUT CONTRACT - REQUIRED
============================================================
Your entire response MUST use the canonical outer report contract below.
Do not use an alternative title, security-audit title, or free-form verdict.

# Deep Review Report — YYYY-MM-DD

## Summary

- **Verdict**: APPROVE | CONCERN | REQUEST_CHANGES
- **Review Mode**: {{REVIEW_MODE}}
- **Issues**: 🔴 N건, 🟡 N건, ℹ️ N건

## Code Review

### 🔴 Critical
### 🟡 Warning
### ℹ️ Info
### 🟢 Passed

Use REQUEST_CHANGES when any Critical exists, CONCERN when only Warnings exist,
and APPROVE only when both Critical and Warning counts are zero. The issue
counts MUST equal the findings in the sections. Missing or malformed contract
fields cause this reviewer output to be excluded.
Under each severity heading, write exactly one single-line \`- \` bullet per
finding, with its evidence and remediation on that same bullet. For an empty
severity section, write exactly \`None.\`. Keep Passed entries as \`- \` bullets.
============================================================

`;

// report-format.md:53-75 — the document-scope gate. The heading is followed
// immediately by the fenced JSON block with no intervening prose, matching
// what `document-readiness.mjs`'s canonical parser requires of a trusted
// report.
const DOCUMENT_ARTIFACT_GATE_SECTION = `For pure document scope, every trusted reviewer report must emit the literal
heading `
  + '`## Artifact Gate`'
  + ` exactly once. The `
  + '`json`'
  + ` fence must be on the
immediately following line with no intervening prose:

## Artifact Gate
\`\`\`json
{
  "schema_version": 1,
  "findings": [
    {
      "id": "DOC-1",
      "severity": "warning",
      "stage": "implementation_verification",
      "acceptance_evidence": [
        "named final implementation test or observable rollback evidence"
      ]
    }
  ]
}
\`\`\`

`
  + '`severity`'
  + ` is `
  + '`critical|warning|info`'
  + `; `
  + '`stage`'
  + ` is
`
  + '`pre_implementation|implementation_verification|advisory`'
  + `. Every Critical is
`
  + '`pre_implementation`'
  + `. Critical/Warning items require non-empty objective
acceptance evidence, and JSON counts must equal the Summary Issues counts.
============================================================

`;

export function buildReportContract({
  artifactPhase = null,
  documentReviewMode = null,
  reviewMode = 'N-way',
  confirmationRequest = null,
} = {}) {
  const contract = BASE_CONTRACT.replace('{{REVIEW_MODE}}', reviewMode);
  if (artifactPhase !== 'document') {
    if (!confirmationRequest) return contract;
    return contract + `Emit exactly one additional ## Confirmation section immediately followed by a json fence.
The object must be {"schema_version":1,"target_digest":${JSON.stringify(confirmationRequest.target_digest)},"items":[...]}.
Cover each requested finding ID exactly once: ${JSON.stringify(confirmationRequest.finding_ids)}.
Each item has finding_id, status (verified_closed|still_open|indeterminate), and nonempty evidence [{location,observation}].
Only positive code/test evidence permits verified_closed; absence from this report is not closure. Keep new material findings in the canonical sections.\n`;
  }
  // `documentReviewMode` ('full-readiness' | 'design-validation') does not
  // change the gate schema itself — report-format.md:53-75 is invariant
  // across both document review modes.
  void documentReviewMode;
  return contract + DOCUMENT_ARTIFACT_GATE_SECTION;
}

// Runtime-owned material renderer. Evidence annotations are deliberately outside
// the canonical severity sections, so suggestions cannot become material issues.
export function renderAdjudicatedReport({ date, verdict, groups = [], annotations = null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('invalid report date');
  const line = value => String(value).replace(/[\r\n\0]+/g, ' ').trim();
  const material = groups.filter(group => ['confirmed_blocker', 'unresolved'].includes(group.disposition));
  const bullets = severity => material.filter(group => group.severity === severity).map(group => {
    const source = group.source_findings?.find(row => row.severity === severity) || group.source_findings?.[0];
    return source?.bullet ? source.bullet : `- ${line(group.rationale)} (${line(group.evidence?.[0]?.location || 'unknown')})`;
  });
  const critical = bullets('critical');
  const warning = bullets('warning');
  return [`# Deep Review Report — ${date}`, '', '## Summary', '',
    `- **Verdict**: ${verdict}`, '- **Review Mode**: Evidence adjudication',
    `- **Issues**: 🔴 ${critical.length}건, 🟡 ${warning.length}건, ℹ️ 0건`, '',
    '## Code Review', '', '### 🔴 Critical', ...(critical.length ? critical : ['None.']), '',
    '### 🟡 Warning', ...(warning.length ? warning : ['None.']), '',
    '### ℹ️ Info', 'None.', '', '### 🟢 Passed', 'None.', '',
    '## Evidence Adjudication', '', '```json', JSON.stringify(JSON.parse(canonicalStringify({ groups, ...annotations })), null, 2), '```', '',
  ].join('\n');
}
