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
} = {}) {
  const contract = BASE_CONTRACT.replace('{{REVIEW_MODE}}', reviewMode);
  if (artifactPhase !== 'document') return contract;
  // `documentReviewMode` ('full-readiness' | 'design-validation') does not
  // change the gate schema itself — report-format.md:53-75 is invariant
  // across both document review modes.
  void documentReviewMode;
  return contract + DOCUMENT_ARTIFACT_GATE_SECTION;
}
