'use strict';

// Frozen copy of parseReviewerReport / strictCodeReviewIsValid as of v2.8.1
// (review-synthesis.mjs:13-131). Used as the T4 differential-equivalence
// oracle so the new parser is not compared against itself.

const VERDICTS = new Set(['APPROVE', 'CONCERN', 'REQUEST_CHANGES']);

function matchesFor(output, pattern) {
  return [...output.matchAll(pattern)];
}

function sectionAfterHeading(output, heading) {
  const start = heading.index + heading[0].length;
  const rest = output.slice(start);
  const nextHeading = /^##\s+\S.*$/mu.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

function strictFindingCount(section) {
  const content = section.trim();
  if (content === 'None.') return 0;
  if (content.length === 0) return null;
  const lines = content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every((line) => /^- \S.*$/u.test(line))
    ? lines.length
    : null;
}

function normalizedCanonicalLabelCounts(summary) {
  const counts = { verdict: 0, issues: 0 };
  for (const line of summary.split(/\r?\n/u)) {
    const match = /^-\s+\*\*\s*([^*\r\n]+?)\s*\*\*\s*:/u.exec(line);
    if (!match) continue;
    const normalized = match[1].replace(/\s+/gu, '').toLowerCase();
    if (normalized === 'verdict' || normalized === 'issues') counts[normalized] += 1;
  }
  return counts;
}

function strictCodeReviewIsValid(output, issues) {
  const codeReviewHeadings = matchesFor(output, /^## Code Review$/gmu);
  if (codeReviewHeadings.length !== 1) return false;
  const codeReview = sectionAfterHeading(output, codeReviewHeadings[0]);
  const canonicalHeadings = [
    '### 🔴 Critical',
    '### 🟡 Warning',
    '### ℹ️ Info',
    '### 🟢 Passed',
  ];
  const headings = matchesFor(codeReview, /^###\s+\S.*$/gmu);
  if (headings.length !== canonicalHeadings.length
      || headings.some((heading, index) => heading[0] !== canonicalHeadings[index])) {
    return false;
  }
  if (codeReview.slice(0, headings[0].index).trim().length > 0) return false;
  const counts = headings.map((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? codeReview.length;
    return strictFindingCount(codeReview.slice(start, end));
  });
  return counts.every((count) => count !== null)
    && counts[0] === issues.critical
    && counts[1] === issues.warning
    && counts[2] === issues.info;
}

function parseReviewerReportFrozen(output, options = {}) {
  if (typeof output !== 'string' || output.length === 0) return null;
  const reportHeadings = matchesFor(
    output,
    /^# Deep Review Report — [0-9]{4}-[0-9]{2}-[0-9]{2}$/gmu,
  );
  if (reportHeadings.length !== 1) return null;
  const [reportHeading] = reportHeadings;
  if (output.slice(0, reportHeading.index).trim().length > 0) return null;
  const report = output.slice(reportHeading.index);
  const summaryHeadings = matchesFor(report, /^## Summary$/gmu);
  const codeReviewHeadings = matchesFor(report, /^## Code Review$/gmu);
  if (summaryHeadings.length !== 1 || codeReviewHeadings.length > 1) return null;
  const [summaryHeading] = summaryHeadings;
  const betweenReportAndSummary = report.slice(
    reportHeading[0].length,
    summaryHeading.index,
  );
  if (betweenReportAndSummary.trim().length > 0) return null;
  if (codeReviewHeadings[0] && codeReviewHeadings[0].index < summaryHeading.index) {
    return null;
  }
  if (options?.strict === true && codeReviewHeadings.length !== 1) return null;

  const summary = sectionAfterHeading(report, summaryHeading);
  const verdictLabels = matchesFor(summary, /^- \*\*Verdict\*\*:/gmu);
  const issuesLabels = matchesFor(summary, /^- \*\*Issues\*\*:/gmu);
  if (verdictLabels.length !== 1 || issuesLabels.length !== 1) return null;
  if (options?.strict === true) {
    const normalizedLabels = normalizedCanonicalLabelCounts(summary);
    if (normalizedLabels.verdict !== 1 || normalizedLabels.issues !== 1) return null;
  }
  const verdictMatches = [
    ...summary.matchAll(
      /^- \*\*Verdict\*\*:\s*(APPROVE|CONCERN|REQUEST_CHANGES)\s*$/gmu,
    ),
  ];
  const issuesPattern = options?.strict === true
    ? /^- \*\*Issues\*\*: 🔴 ([0-9]+)건, 🟡 ([0-9]+)건, ℹ(?:️)? ([0-9]+)건$/gmu
    : /^- \*\*Issues\*\*:\s*[^\n]*?🔴\s*([0-9]+)[^\n]*?🟡\s*([0-9]+)[^\n]*?ℹ(?:️)?\s*([0-9]+)[^\n]*$/gmu;
  const issuesMatches = [...summary.matchAll(issuesPattern)];
  if (verdictMatches.length !== 1 || issuesMatches.length !== 1) return null;
  const [verdictMatch] = verdictMatches;
  const [issuesMatch] = issuesMatches;
  if (!VERDICTS.has(verdictMatch[1])) return null;
  const issues = {
    critical: Number(issuesMatch[1]),
    warning: Number(issuesMatch[2]),
    info: Number(issuesMatch[3]),
  };
  if (issues.critical > 0 && verdictMatch[1] !== 'REQUEST_CHANGES') return null;
  if (issues.critical === 0 && issues.warning > 0 && verdictMatch[1] === 'APPROVE') return null;
  if (issues.critical === 0 && issues.warning === 0 && verdictMatch[1] !== 'APPROVE') return null;
  if (options?.strict === true && !strictCodeReviewIsValid(report, issues)) return null;
  return { verdict: verdictMatch[1], issues };
}

module.exports = { parseReviewerReportFrozen, strictCodeReviewIsValidFrozen: strictCodeReviewIsValid };
