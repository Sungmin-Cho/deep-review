#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalStringify, isFindingRef } from './document-readiness.mjs';
import { rubricIdForRole } from './lib/assignment-rubrics.mjs';
import { parseExecutionPlanDocument, parseExecutionRoute } from './lib/execution-plan.mjs';
import { REVIEWER_IDS, REVIEWER_PROVIDERS } from './lib/reviewer-ids.mjs';
import { UNSUPPORTED_GROK_CONTAINMENT } from './lib/grok-process-supervisor.mjs';

const VERDICTS = new Set(['APPROVE', 'CONCERN', 'REQUEST_CHANGES']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const READINESS_ADMISSION_SCHEMA = '1.0';

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

export function parseReviewerReport(output, options = {}) {
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

function fingerprintFailure(before, after) {
  if (!before || !after || before.error || after.error) return 'fingerprint_error';
  if (before.mode !== after.mode || before.digest !== after.digest) return 'fingerprint_mismatch';
  return null;
}

export function evaluateReviewerAttempt({
  reviewer_id: reviewerId,
  role,
  output,
  beforeFingerprint,
  afterFingerprint,
}) {
  if (typeof role !== 'string' || role.length === 0) throw new TypeError('role must be non-empty');
  const outputDigest = typeof output === 'string'
    ? createHash('sha256').update(output).digest('hex')
    : null;
  const fingerprintExclusion = fingerprintFailure(beforeFingerprint, afterFingerprint);
  if (fingerprintExclusion) {
    return {
      ...(reviewerId ? { reviewer_id: reviewerId } : {}),
      role,
      output_digest: outputDigest,
      included: false,
      exclusion: fingerprintExclusion,
      verdict: null,
      issues: null,
    };
  }
  const parsed = parseReviewerReport(output, { strict: true });
  if (!parsed) {
    return {
      ...(reviewerId ? { reviewer_id: reviewerId } : {}),
      role,
      output_digest: outputDigest,
      included: false,
      exclusion: 'malformed_or_empty_result',
      verdict: null,
      issues: null,
    };
  }
  return {
    ...(reviewerId ? { reviewer_id: reviewerId } : {}),
    role,
    output_digest: outputDigest,
    included: true,
    exclusion: null,
    ...parsed,
  };
}

function consensusVerdict(consensus, included) {
  if (!consensus || typeof consensus !== 'object' || Array.isArray(consensus)
    || !Array.isArray(consensus.findings)) return null;
  const roles = included.map(attemptReviewerId);
  if (roles.some((role) => typeof role !== 'string' || role.length === 0)
    || new Set(roles).size !== roles.length) return null;
  const admittedRoles = new Set(roles);
  const counts = new Map(roles.map((role) => [role, { critical: 0, warning: 0 }]));
  let hasCritical = false;
  let hasAgreedWarning = false;
  let hasSplitWarning = false;

  for (const finding of consensus.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)
      || !['critical', 'warning'].includes(finding.severity)
      || !Array.isArray(finding.roles) || finding.roles.length === 0
      || new Set(finding.roles).size !== finding.roles.length
      || finding.roles.some((role) => !admittedRoles.has(role))) return null;
    for (const role of finding.roles) counts.get(role)[finding.severity] += 1;
    if (finding.severity === 'critical') hasCritical = true;
    else if (finding.roles.length === included.length) hasAgreedWarning = true;
    else hasSplitWarning = true;
  }

  for (const attempt of included) {
    const expected = counts.get(attemptReviewerId(attempt));
    if (!attempt.issues || !Number.isSafeInteger(attempt.issues.critical)
      || !Number.isSafeInteger(attempt.issues.warning)
      || attempt.issues.critical < 0 || attempt.issues.warning < 0
      || attempt.issues.critical !== expected.critical
      || attempt.issues.warning !== expected.warning) return null;
  }

  if (hasCritical || hasAgreedWarning) return 'REQUEST_CHANGES';
  if (hasSplitWarning) return 'CONCERN';
  return 'APPROVE';
}

export function synthesizeReviewAttempts(attempts, consensus) {
  if (!Array.isArray(attempts)) throw new TypeError('attempts must be an array');
  const included = attempts.filter((attempt) => attempt?.included === true);
  const exclusions = attempts
    .filter((attempt) => attempt?.included !== true)
    .map((attempt) => ({ role: attempt?.role || 'unknown', reason: attempt?.exclusion || 'not_successful' }));
  if (included.length === 0) {
    return {
      status: 'operational_failure',
      n_actual: 0,
      verdict: null,
      phase6_allowed: false,
      exclusions,
    };
  }
  const includedRoles = included.map((attempt) => attempt?.role);
  const includedDigests = included.map((attempt) => attempt?.output_digest);
  if (includedRoles.some((role) => !REVIEWER_IDS.includes(role))
      || new Set(includedRoles).size !== includedRoles.length
      || includedDigests.some((digest) => !SHA256_PATTERN.test(digest || ''))) {
    return {
      status: 'operational_failure',
      n_actual: 0,
      verdict: null,
      phase6_allowed: false,
      exclusions,
      error: 'invalid_reviewer_identity',
    };
  }
  let verdict;
  if (included.length === 1) {
    const critical = included[0].issues.critical;
    const warning = included[0].issues.warning;
    verdict = critical > 0 ? 'REQUEST_CHANGES' : warning > 0 ? 'CONCERN' : 'APPROVE';
  } else {
    verdict = consensusVerdict(consensus, included);
    if (verdict === null) {
      return {
        status: 'operational_failure',
        n_actual: included.length,
        verdict: null,
        phase6_allowed: false,
        exclusions,
        error: 'consensus_required',
      };
    }
  }
  return {
    status: 'reviewed',
    n_actual: included.length,
    verdict,
    phase6_allowed: true,
    exclusions,
  };
}

function canonicalReviewerIndex(reviewerId) {
  const index = REVIEWER_IDS.indexOf(reviewerId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function attemptReviewerId(attempt) {
  return attempt?.reviewer_id || attempt?.role || null;
}

function providerForReviewer(routingPlan, reviewerId) {
  const route = routingPlan.routes?.find((item) => item.reviewer_id === reviewerId);
  if (route?.provider) return route.provider;
  return routingPlan.candidate_reviewers
    ?.find((item) => item.reviewer_id === reviewerId)?.provider ?? null;
}

function routingIdentityError(routingPlan) {
  if (!Array.isArray(routingPlan.candidate_reviewers)
      || !Array.isArray(routingPlan.routes)
      || routingPlan.routes.length === 0) {
    return true;
  }
  try {
    for (const route of routingPlan.routes) {
      parseExecutionPlanDocument(routingPlan, route?.reviewer_id);
    }
  } catch {
    return true;
  }
  const candidateProviders = new Map();
  for (const candidate of routingPlan.candidate_reviewers || []) {
    const reviewerId = candidate?.reviewer_id;
    if (!REVIEWER_IDS.includes(reviewerId)
        || candidateProviders.has(reviewerId)
        || candidate?.provider !== REVIEWER_PROVIDERS[reviewerId]) {
      return true;
    }
    candidateProviders.set(reviewerId, candidate.provider);
  }
  const routeIds = new Set();
  for (const route of routingPlan.routes || []) {
    const reviewerId = route?.reviewer_id;
    if (!REVIEWER_IDS.includes(reviewerId)
        || routeIds.has(reviewerId)
        || route?.provider !== REVIEWER_PROVIDERS[reviewerId]
        || candidateProviders.get(reviewerId) !== route.provider
        || !Number.isInteger(route?.wave)
        || route.wave < 1
        || route.wave > 2
        || typeof route?.required !== 'boolean') {
      return true;
    }
    routeIds.add(reviewerId);
  }
  return false;
}

function expansionReasons({ included, synthesis, routingPlan, readinessMismatch }) {
  const reasons = [];
  if (included.length < Number(routingPlan.minimum_reviewers || 0)) {
    reasons.push('reviewer_minimum_broken');
  }
  const criticalVoices = included.filter((attempt) => Number(attempt?.issues?.critical || 0) > 0);
  const securityVoices = included.filter((attempt) => {
    const reviewerId = attemptReviewerId(attempt);
    const route = routingPlan.routes?.find((item) => item.reviewer_id === reviewerId);
    const blockingFindings = Number(attempt?.issues?.critical || 0)
      + Number(attempt?.issues?.warning || 0);
    return route?.assignment_role === 'security' && blockingFindings > 0;
  });
  if (criticalVoices.length === 1 || securityVoices.length === 1) {
    reasons.push('single_critical_or_security');
  }
  if (synthesis.status === 'reviewed' && synthesis.verdict === 'CONCERN' && included.length > 1) {
    reasons.push('split_concern');
  }
  if (readinessMismatch) reasons.push('readiness_mismatch');
  if (routingPlan.artifact_phase === 'document') {
    return reasons.filter((reason) => ![
      'single_critical_or_security',
      'split_concern',
    ].includes(reason));
  }
  return reasons;
}

function roleForExpansion(reasons) {
  if (reasons.includes('readiness_mismatch')) return 'traceability';
  if (reasons.includes('single_critical_or_security')) return 'security';
  if (reasons.includes('split_concern')) return 'adversarial';
  return 'standard';
}

function chooseExpansionAssignment({ attempts, routingPlan, reasons }) {
  if ((routingPlan.routes?.length || 0) >= Number(routingPlan.maximum_reviewers || 0)) {
    return null;
  }
  const attempted = new Set(attempts.map(attemptReviewerId).filter(Boolean));
  const includedProviders = new Set(
    attempts.filter((attempt) => attempt?.included === true)
      .map((attempt) => providerForReviewer(routingPlan, attemptReviewerId(attempt)))
      .filter(Boolean),
  );
  const preferredRole = roleForExpansion(reasons);
  const candidates = (routingPlan.candidate_reviewers || [])
    .filter((candidate) => !attempted.has(candidate.reviewer_id))
    .map((candidate) => ({
      ...candidate,
      assignment_roles: Array.isArray(candidate.assignment_roles)
        ? candidate.assignment_roles
        : ['standard'],
    }))
    .map((candidate) => {
      const assignmentRole = candidate.assignment_roles.includes(preferredRole)
        ? preferredRole
        : candidate.assignment_roles[0];
      const template = candidate.expansion_route_templates
        ?.find((route) => route.assignment_role === assignmentRole);
      return { ...candidate, assignmentRole, template };
    })
    .filter((candidate) => candidate.assignment_roles.length > 0 && candidate.template)
    .sort((left, right) => {
      const leftSupports = left.assignment_roles.includes(preferredRole) ? 0 : 1;
      const rightSupports = right.assignment_roles.includes(preferredRole) ? 0 : 1;
      const leftDiversity = includedProviders.has(left.provider) ? 1 : 0;
      const rightDiversity = includedProviders.has(right.provider) ? 1 : 0;
      return leftSupports - rightSupports
        || leftDiversity - rightDiversity
        || canonicalReviewerIndex(left.reviewer_id) - canonicalReviewerIndex(right.reviewer_id);
    });
  const candidate = candidates[0];
  if (!candidate) return null;
  const { assignmentRole, template } = candidate;
  return {
    ...template,
    assignment_role: assignmentRole,
    rubric_id: rubricIdForRole(assignmentRole),
    wave: 2,
    required: false,
    tier_adjustment: 1,
    independent: true,
    selection_reason: `same-round expansion for ${reasons.join(', ')}`,
  };
}

// C-READINESS-ADMISSION (D17) — the readiness independence carrier.
//
// Report bytes prove nothing about independence: two trusted paths may hold
// byte-identical reports and still be two genuine attempts, and one attempt
// copied to a second path is still one attempt. Independence is therefore
// carried, not inferred. Dispatch binds a fresh opaque `attempt_id` to one
// parsed protocol-3 route and the immutable routing plan before an attempt
// runs; this function re-derives every admitted field from that trusted record
// and the plan, and seals the result once. Nothing here is reconstructed from a
// reviewer id, a provider string, a report path, or prose inside the report —
// the report contributes exactly one thing, the digest of its own bytes, and
// even that is only ever *compared*, never copied in.
function admissionFailure(reason) {
  const error = new Error(`readiness admission is invalid: ${reason}`);
  error.reason = reason;
  return error;
}

function admissionSha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function sealReadinessAdmission({ dispatch, routingPlan, included }) {
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)
      || !isNonEmptyString(dispatch.round_id)
      || !SHA256_PATTERN.test(dispatch.routing_plan_sha256 || '')
      || !Array.isArray(dispatch.records) || dispatch.records.length === 0) {
    throw admissionFailure('dispatch_malformed');
  }
  const routingPlanSha256 = admissionSha256(canonicalStringify(routingPlan));
  if (routingPlanSha256 !== dispatch.routing_plan_sha256) {
    throw admissionFailure('routing_plan_seal_mismatch');
  }
  // The expected route identity comes from the immutable plan, so a dispatch
  // record cannot authorise a route the plan never selected by presenting a
  // self-consistent digest of its own.
  const plannedRouteDigests = new Map((routingPlan.routes || []).map((route) => [
    route.reviewer_id,
    admissionSha256(canonicalStringify({ protocol_version: '3.0', ...route })),
  ]));
  const digestByReviewer = new Map(
    included.map((attempt) => [attemptReviewerId(attempt), attempt.output_digest]),
  );
  const attemptIds = new Set();
  const routeIdentities = new Set();
  const sessionIds = new Set();
  const consumed = new Set();
  const records = dispatch.records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || !isNonEmptyString(record.attempt_id)
        || !isNonEmptyString(record.reviewer_id)
        || !isNonEmptyString(record.provider_family)
        || !SHA256_PATTERN.test(record.route_sha256 || '')
        || !SHA256_PATTERN.test(record.output_sha256 || '')
        || !Object.hasOwn(record, 'model')
        || !Object.hasOwn(record, 'compatibility_evidence_sha256')) {
      throw admissionFailure('dispatch_malformed');
    }
    if (attemptIds.has(record.attempt_id)) throw admissionFailure('duplicate_attempt_id');
    attemptIds.add(record.attempt_id);
    let route;
    try {
      route = parseExecutionRoute(record.execution_route, record.reviewer_id);
    } catch {
      throw admissionFailure('unplanned_route');
    }
    const routeSha256 = admissionSha256(canonicalStringify(record.execution_route));
    if (routeSha256 !== record.route_sha256) throw admissionFailure('route_digest_mismatch');
    if (plannedRouteDigests.get(record.reviewer_id) !== routeSha256) {
      throw admissionFailure('unplanned_route');
    }
    if (routeIdentities.has(routeSha256)) throw admissionFailure('duplicate_route_identity');
    routeIdentities.add(routeSha256);
    if (record.provider_family !== REVIEWER_PROVIDERS[record.reviewer_id]) {
      throw admissionFailure('provider_mismatch');
    }
    if (record.model !== route.model) throw admissionFailure('model_mismatch');
    if (!isNonEmptyString(record.session_id) || sessionIds.has(record.session_id)) {
      throw admissionFailure('session_identity_invalid');
    }
    sessionIds.add(record.session_id);
    if (record.compatibility_evidence_sha256
        !== (route.grokCompatibilityEvidence?.evidence_sha256 ?? null)) {
      throw admissionFailure('compatibility_evidence_mismatch');
    }
    if (!digestByReviewer.has(record.reviewer_id) || consumed.has(record.reviewer_id)) {
      throw admissionFailure('admission_join_not_one_to_one');
    }
    if (digestByReviewer.get(record.reviewer_id) !== record.output_sha256) {
      throw admissionFailure('output_digest_mismatch');
    }
    consumed.add(record.reviewer_id);
    const body = {
      attempt_id: record.attempt_id,
      output_sha256: record.output_sha256,
      provider_family: record.provider_family,
      reviewer_id: record.reviewer_id,
      route_sha256: record.route_sha256,
    };
    return { ...body, admission_sha256: admissionSha256(canonicalStringify(body)) };
  }).sort((left, right) => Buffer.compare(
    Buffer.from(left.attempt_id, 'utf8'),
    Buffer.from(right.attempt_id, 'utf8'),
  ));
  if (consumed.size !== included.length) throw admissionFailure('admission_join_not_one_to_one');
  const body = {
    schema_version: READINESS_ADMISSION_SCHEMA,
    round_id: dispatch.round_id,
    routing_plan_sha256: routingPlanSha256,
    records,
  };
  return { ...body, carrier_sha256: admissionSha256(canonicalStringify(body)) };
}

function providerFamilyCount(attempts, routingPlan) {
  return new Set(
    attempts.filter((attempt) => attempt?.included === true)
      .map((attempt) => providerForReviewer(routingPlan, attemptReviewerId(attempt)))
      .filter(Boolean),
  ).size;
}

/**
 * Two-wave synthesis authority. Wave 1 may return `needs_expansion` without a
 * verdict. The caller dispatches exactly `next_assignment` with the same
 * original evidence and its canonical rubric, then calls this function again
 * with every attempt and `expansionWavesUsed: 1`.
 */
export function synthesizeReviewRound({
  attempts,
  consensus,
  routingPlan,
  expansionWavesUsed = 0,
  readinessMismatch = false,
  deferredAcceptance = null,
  dispatch = null,
} = {}) {
  if (!Array.isArray(attempts)) throw new TypeError('attempts must be an array');
  if (!routingPlan || routingPlan.protocol_version !== '3.0') {
    throw new Error('adaptive synthesis requires routing plan protocol 3.0');
  }
  if (!Number.isInteger(expansionWavesUsed) || expansionWavesUsed < 0) {
    throw new Error('expansionWavesUsed must be a non-negative integer');
  }
  if (routingPlan.operational_failure === true) {
    const routingShortfalls = Array.isArray(routingPlan.shortfalls)
      ? [...routingPlan.shortfalls]
      : [];
    return {
      status: 'operational_failure',
      needs_expansion: false,
      n_actual: 0,
      verdict: null,
      phase6_allowed: false,
      exclusions: [],
      error: 'routing_plan_operational_failure',
      routing_shortfalls: routingShortfalls,
      // D21 / I41 — the terminal reader of the containment carrier. A `--grok`
      // review on a host with no enforceable containment fails the *entire*
      // review here, with `n_actual: 0`; it is never degraded to a four-voice
      // round.
      operational_failure_reason: routingShortfalls.includes(UNSUPPORTED_GROK_CONTAINMENT)
        ? UNSUPPORTED_GROK_CONTAINMENT
        : null,
    };
  }
  if (routingIdentityError(routingPlan)) {
    return {
      status: 'operational_failure',
      needs_expansion: false,
      n_actual: 0,
      verdict: null,
      phase6_allowed: false,
      exclusions: [],
      error: 'invalid_routing_plan_identity',
    };
  }
  const hasMaterializedWave2 = (routingPlan.routes || []).some((route) => route.wave === 2);
  if (expansionWavesUsed > 0 && !hasMaterializedWave2) {
    return {
      status: 'operational_failure',
      needs_expansion: false,
      n_actual: 0,
      verdict: null,
      phase6_allowed: false,
      exclusions: [],
      error: 'invalid_routing_plan_identity',
    };
  }
  const effectiveExpansionWavesUsed = hasMaterializedWave2
    ? Math.max(1, expansionWavesUsed)
    : expansionWavesUsed;
  // C-DEFERRED-REF (D17) — the deferred carrier crossing this boundary is the
  // reviewer-scoped ref, in shadow mode and active mode alike. The bare local id
  // is a display projection this authority never reads back: two reviewers who
  // each name a finding `DOC-1` are two pending obligations, and a bare-id
  // carrier delivers one, so verifying either reviewer would lift the floor for
  // both. `isFindingRef` is imported rather than restated so both modes admit a
  // carrier by exactly the definition readiness sealed it with.
  if (deferredAcceptance !== null && (
    !deferredAcceptance
    || typeof deferredAcceptance !== 'object'
    || Array.isArray(deferredAcceptance)
    || typeof deferredAcceptance.complete !== 'boolean'
    || !Array.isArray(deferredAcceptance.pending_finding_refs)
    || deferredAcceptance.pending_finding_refs.some((ref) => !isFindingRef(ref))
  )) {
    throw new Error('deferredAcceptance is malformed');
  }
  const admittedIds = attempts
    .filter((attempt) => attempt?.included === true)
    .map(attemptReviewerId);
  const attemptedIds = attempts.map(attemptReviewerId);
  const selectedRouteIds = new Set(
    (routingPlan.routes || []).map((route) => route.reviewer_id),
  );
  const admittedOutputDigests = attempts
    .filter((attempt) => attempt?.included === true)
    .map((attempt) => attempt.output_digest);
  if (attemptedIds.some((id) => !REVIEWER_IDS.includes(id) || !selectedRouteIds.has(id))
      || new Set(attemptedIds).size !== attemptedIds.length
      || admittedOutputDigests.some((digest) => !SHA256_PATTERN.test(digest || ''))
      || attempts.some((attempt) => (
        typeof attempt?.reviewer_id !== 'string'
        || attempt.role !== attempt.reviewer_id
      ))) {
    return {
      status: 'operational_failure',
      needs_expansion: false,
      n_actual: new Set(admittedIds.filter((id) => REVIEWER_IDS.includes(id))).size,
      verdict: null,
      phase6_allowed: false,
      exclusions: [],
      error: 'invalid_reviewer_identity',
    };
  }
  const shadowMode = routingPlan.shadow_mode === true;
  const included = attempts.filter((attempt) => attempt?.included === true);
  // The carrier is emitted only by final *production* synthesis, so a shadow
  // round never seals one. A dispatch record that does not reconcile with the
  // plan and the admitted attempts is an operational failure with Phase 6
  // false, ahead of any verdict.
  let readinessAdmission = null;
  if (dispatch !== null && !shadowMode) {
    try {
      readinessAdmission = sealReadinessAdmission({ dispatch, routingPlan, included });
    } catch (error) {
      return {
        status: 'operational_failure',
        needs_expansion: false,
        n_actual: included.length,
        verdict: null,
        phase6_allowed: false,
        exclusions: [],
        error: 'invalid_readiness_admission',
        readiness_admission_error: error.reason || 'dispatch_malformed',
      };
    }
  }
  const synthesis = synthesizeReviewAttempts(attempts, consensus);
  const includedIds = new Set(included.map(attemptReviewerId));
  const missingSelectedRoutes = (routingPlan.routes || [])
    .filter((route) => !includedIds.has(route.reviewer_id));
  const missingRequiredRoutes = (routingPlan.routes || [])
    .filter((route) => route.required === true && !includedIds.has(route.reviewer_id));
  const missingExpansionRoutes = missingSelectedRoutes.filter((route) => route.wave === 2);
  if (missingRequiredRoutes.length > 0 || missingExpansionRoutes.length > 0) {
    const missingHardRoutes = missingRequiredRoutes.length > 0
      ? missingRequiredRoutes
      : missingExpansionRoutes;
    return {
      status: 'operational_failure',
      needs_expansion: false,
      n_actual: included.length,
      verdict: null,
      phase6_allowed: false,
      exclusions: synthesis.exclusions || [],
      error: 'required_reviewer_unavailable',
      missing_required_reviewers: missingHardRoutes.map((route) => route.reviewer_id),
    };
  }
  const reasons = shadowMode ? [] : expansionReasons({
    included,
    synthesis,
    routingPlan,
    readinessMismatch,
  });
  const maxExpansionWaves = Number.isInteger(routingPlan.max_expansion_waves)
    ? routingPlan.max_expansion_waves
    : 1;
  let expansionRejected = null;
  if (reasons.length > 0 && effectiveExpansionWavesUsed < maxExpansionWaves) {
    const replaceableAdaptiveFloor = new Set(
      reasons.includes('reviewer_minimum_broken')
        ? missingSelectedRoutes
          .filter((route) => route.required === false && route.wave === 1)
          .map((route) => route.reviewer_id)
        : [],
    );
    const replannedBase = replaceableAdaptiveFloor.size > 0
      ? {
        ...routingPlan,
        routes: (routingPlan.routes || [])
          .filter((route) => !replaceableAdaptiveFloor.has(route.reviewer_id)),
        initial_reviewer_ids: (routingPlan.initial_reviewer_ids || [])
          .filter((reviewerId) => !replaceableAdaptiveFloor.has(reviewerId)),
        required_reviewer_ids: (routingPlan.required_reviewer_ids || [])
          .filter((reviewerId) => !replaceableAdaptiveFloor.has(reviewerId)),
      }
      : routingPlan;
    const nextAssignment = chooseExpansionAssignment({
      attempts,
      routingPlan: replannedBase,
      reasons,
    });
    if (nextAssignment) {
      const replacement = replaceableAdaptiveFloor.size > 0
        ? {
          ...nextAssignment,
          required: true,
          selection_reason: `${nextAssignment.selection_reason}; replaces unavailable adaptive floor route`,
        }
        : nextAssignment;
      const expandedRoutingPlan = {
        ...replannedBase,
        routes: [...(replannedBase.routes || []), replacement],
      };
      return {
        status: 'needs_expansion',
        needs_expansion: true,
        n_actual: included.length,
        verdict: null,
        phase6_allowed: false,
        expansion_reasons: reasons,
        next_assignment: replacement,
        expanded_routing_plan: expandedRoutingPlan,
        exclusions: synthesis.exclusions || [],
      };
    }
    expansionRejected = 'no_unused_candidate';
  } else if (reasons.length > 0) {
    expansionRejected = 'maximum_expansion_waves_reached';
  }

  const providerFamilies = providerFamilyCount(attempts, routingPlan);
  const criticalImplementation = routingPlan.artifact_phase === 'implementation'
    && routingPlan.risk === 'critical';
  if (criticalImplementation && (included.length < 3 || providerFamilies < 2)) {
    return {
      status: 'operational_failure',
      needs_expansion: false,
      n_actual: included.length,
      verdict: null,
      phase6_allowed: false,
      exclusions: synthesis.exclusions || [],
      error: 'critical_reviewer_floor',
      ...(expansionRejected ? { expansion_rejected: expansionRejected } : {}),
    };
  }
  if (synthesis.status !== 'reviewed') {
    return {
      ...synthesis,
      needs_expansion: false,
      ...(expansionRejected ? { expansion_rejected: expansionRejected } : {}),
    };
  }

  const plannedReviewers = Number(routingPlan.planned_reviewers || routingPlan.minimum_reviewers || 0);
  const providerMinimum = Number(routingPlan.provider_family_minimum || 1);
  const floorBroken = !shadowMode && (included.length < plannedReviewers
    || providerFamilies < providerMinimum
    || routingPlan.confidence_floor === 'CONCERN');
  const confidenceFloorApplied = floorBroken && synthesis.verdict === 'APPROVE';
  const deferredAcceptanceFloor = routingPlan.artifact_phase === 'implementation'
    && deferredAcceptance?.complete === false
    && synthesis.verdict === 'APPROVE';
  const verdict = confidenceFloorApplied || deferredAcceptanceFloor
    ? 'CONCERN'
    : synthesis.verdict;
  const documentBlocked = routingPlan.artifact_phase === 'document'
    && ['high', 'critical'].includes(routingPlan.risk)
    && floorBroken;
  return {
    ...synthesis,
    needs_expansion: false,
    verdict,
    confidence_floor_applied: confidenceFloorApplied,
    deferred_acceptance_floor: deferredAcceptanceFloor,
    provider_families: providerFamilies,
    // Document readiness receives this verbatim from the trusted coordinator.
    ...(readinessAdmission ? { readiness_admission: readinessAdmission } : {}),
    ...(shadowMode ? { shadow_mode: true, adaptive_plan_applied: false } : {}),
    ...(deferredAcceptanceFloor
      ? {
        pending_deferred_finding_refs: deferredAcceptance.pending_finding_refs.map((ref) => ({
          finding_id: ref.finding_id,
          reviewer_id: ref.reviewer_id,
        })),
        // Display projection only: one entry per authoritative ref, same order,
        // so a local id shared by two reviewers renders twice. Never read back.
        pending_deferred_finding_ids: deferredAcceptance.pending_finding_refs
          .map((ref) => ref.finding_id),
      }
      : {}),
    ...(documentBlocked ? { document_blocked: true } : {}),
    ...(expansionRejected ? { expansion_rejected: expansionRejected } : {}),
  };
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const inputIndex = process.argv.indexOf('--input');
    if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error('--input FILE is required');
    const input = JSON.parse(readFileSync(resolve(process.argv[inputIndex + 1]), 'utf8'));
    const attemptInput = Array.isArray(input) ? input : input?.attempts;
    if (!Array.isArray(attemptInput)) throw new TypeError('input must contain an attempt array');
    if (attemptInput.some((attempt) => !Object.hasOwn(attempt || {}, 'output'))) {
      throw new Error('CLI attempts require raw output and fingerprint evidence');
    }
    const attempts = attemptInput.map((attempt) => evaluateReviewerAttempt(attempt));
    const consensus = Array.isArray(input) ? undefined : input.consensus;
    const result = !Array.isArray(input) && input.routing_plan
      ? synthesizeReviewRound({
        attempts,
        consensus,
        routingPlan: input.routing_plan,
        expansionWavesUsed: input.expansion_waves_used || 0,
        readinessMismatch: input.readiness_mismatch === true,
        deferredAcceptance: input.deferred_acceptance || null,
      })
      : synthesizeReviewAttempts(attempts, consensus);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'error', error: error.message })}\n`);
    process.exitCode = 2;
  }
}
