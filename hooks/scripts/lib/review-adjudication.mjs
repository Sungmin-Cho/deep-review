import { parseReviewerReport } from '../review-synthesis.mjs';
import { evidenceHash, CONTROL_LIMIT, sameReviewTarget } from './review-target-snapshot.mjs';

const internals = new WeakMap();
const admissions = new WeakMap();
const severities = ['critical', 'warning'];
const categories = new Set([
  'error-handling',
  'naming-convention',
  'type-safety',
  'test-coverage',
  'security',
  'performance',
  'architecture',
  'unclassified',
]);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (reason) => {
  throw new Error(`invalid_adjudication: ${reason}`);
};
export function registerAttemptEvidence(attempt, raw) {
  internals.set(attempt, structuredClone(raw));
  admissions.set(attempt, evidenceHash(attempt));
  return attempt;
}
export function getAttemptEvidence(attempt) {
  if (!object(attempt)) return null;
  const raw = admissions.get(attempt) === evidenceHash(attempt) ? internals.get(attempt) : null;
  return raw ? structuredClone(raw) : null;
}
export function extractSourceFindings(output, reviewerId) {
  if (!parseReviewerReport(output, { strict: true }) || !nonempty(reviewerId))
    fail('unadmitted raw report');
  const report_sha256 = evidenceHash(output);
  const rows = [];
  for (const severity of severities) {
    const heading = severity === 'critical' ? '### 🔴 Critical' : '### 🟡 Warning';
    const start = output.indexOf(heading) + heading.length;
    const rest = output.slice(start);
    const next = /^#{2,3} /mu.exec(rest);
    const region = next ? rest.slice(0, next.index) : rest;
    const bullets = region.split(/\r?\n/).filter((line) => line.startsWith('- '));
    bullets.forEach((bullet, index) =>
      rows.push({ reviewer_id: reviewerId, report_sha256, severity, ordinal: index + 1, bullet }),
    );
  }
  return rows;
}
function refKey(ref) {
  if (
    !object(ref) ||
    Object.keys(ref).sort().join(',') !== 'ordinal,report_sha256,reviewer_id,severity' ||
    !nonempty(ref.reviewer_id) ||
    !/^[a-f0-9]{64}$/.test(ref.report_sha256) ||
    !severities.includes(ref.severity) ||
    !Number.isSafeInteger(ref.ordinal) ||
    ref.ordinal < 1
  )
    fail('malformed source ref');
  return JSON.stringify([ref.reviewer_id, ref.report_sha256, ref.severity, ref.ordinal]);
}
function concreteEvidence(rows) {
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every(
      (row) =>
        object(row) &&
        nonempty(row.location) &&
        nonempty(row.observation) &&
        !/[\r\n\0]/.test(row.location) &&
        !/^(?:unknown|n\/?a|none|todo|tbd|see above)$/i.test(row.location.trim()) &&
        (/:\d+\b/.test(row.location) ||
          /^(?:test|command|contract|artifact):\S/.test(row.location)),
    )
  );
}
export function evaluateAdjudication({ adjudication, attempts, routingPlan } = {}) {
  if (routingPlan?.artifact_phase === 'document') fail('document route cannot be adjudicated');
  if (
    !object(adjudication) ||
    adjudication.schema_version !== '1.0' ||
    !Array.isArray(adjudication.groups) ||
    Buffer.byteLength(JSON.stringify(adjudication)) > CONTROL_LIMIT
  )
    fail('malformed envelope');
  const sources = [];
  for (const attempt of attempts || []) {
    if (attempt?.included !== true) continue;
    const raw = getAttemptEvidence(attempt);
    if (!raw || evidenceHash(raw.output) !== attempt.output_digest)
      fail('raw source descriptors required');
    const parsed = parseReviewerReport(raw.output, { strict: true });
    if (!parsed || JSON.stringify(parsed.issues) !== JSON.stringify(attempt.issues))
      fail('raw admission mismatch');
    sources.push(...extractSourceFindings(raw.output, attempt.reviewer_id));
  }
  const available = new Map(sources.map(({ bullet, ...ref }) => [refKey(ref), { ...ref, bullet }]));
  const consumed = new Set();
  const groups = adjudication.groups.map((group) => {
    if (
      !object(group) ||
      !Array.isArray(group.source_refs) ||
      !group.source_refs.length ||
      !['confirmed_blocker', 'refuted', 'advisory', 'unresolved'].includes(group.disposition) ||
      !severities.includes(group.severity) ||
      !categories.has(group.category) ||
      !nonempty(group.rationale) ||
      !concreteEvidence(group.evidence)
    )
      fail('malformed group or nonconcrete evidence');
    const bound = group.source_refs.map((ref) => {
      const key = refKey(ref);
      if (!available.has(key) || consumed.has(key)) fail('foreign or duplicate ref');
      consumed.add(key);
      return available.get(key);
    });
    const critical = bound.some((source) => source.severity === 'critical');
    if (critical && group.disposition === 'advisory') fail('critical cannot become advisory');
    if (
      group.disposition === 'unresolved' &&
      (!nonempty(group.missing_evidence) || (critical && group.severity !== 'critical'))
    )
      fail('unresolved evidence/severity floor');
    return { ...structuredClone(group), source_findings: bound };
  });
  if (consumed.size !== available.size) fail('incomplete source coverage');
  const material_groups = groups.filter((group) =>
    ['confirmed_blocker', 'unresolved'].includes(group.disposition),
  );
  const counts = {
    critical: material_groups.filter((g) => g.severity === 'critical').length,
    warning: material_groups.filter((g) => g.severity === 'warning').length,
    info: 0,
  };
  const blocking = material_groups.some(
    (g) =>
      g.disposition === 'confirmed_blocker' ||
      g.severity === 'critical' ||
      g.category === 'security',
  );
  return {
    schema_version: '1.0',
    status: 'validated',
    source_findings: sources,
    groups,
    material_groups,
    counts,
    verdict: blocking ? 'REQUEST_CHANGES' : material_groups.length ? 'CONCERN' : 'APPROVE',
    unresolved_sensitive: groups.some(
      (g) =>
        g.disposition === 'unresolved' && (g.severity === 'critical' || g.category === 'security'),
    ),
  };
}
export function parseConfirmation(output) {
  if (typeof output !== 'string') throw new Error('invalid confirmation output');
  const headings = [...output.matchAll(/^## Confirmation\s*$/gmu)];
  if (!headings.length) return null;
  if (headings.length !== 1) throw new Error('duplicate Confirmation section');
  const rest = output.slice(headings[0].index + headings[0][0].length);
  const match = /^\r?\n```json\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)/u.exec(rest);
  if (!match || Buffer.byteLength(match[1]) > CONTROL_LIMIT)
    throw new Error('malformed Confirmation section');
  const section = JSON.parse(match[1]);
  if (
    !object(section) ||
    section.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(section.target_digest) ||
    !Array.isArray(section.items)
  )
    throw new Error('invalid Confirmation schema');
  const ids = new Set();
  for (const row of section.items) {
    if (
      !object(row) ||
      !nonempty(row.finding_id) ||
      ids.has(row.finding_id) ||
      !['verified_closed', 'still_open', 'indeterminate'].includes(row.status) ||
      !concreteEvidence(row.evidence)
    )
      throw new Error('invalid Confirmation item');
    ids.add(row.finding_id);
  }
  return section;
}
export function verifyConfirmation({ attempts, requiredFindings, target, currentFindings }) {
  const ids = (requiredFindings || []).map((row) =>
    typeof row === 'string' ? row : row?.finding_id,
  );
  if (
    ids.some((id) => !nonempty(id)) ||
    new Set(ids).size !== ids.length ||
    !sameReviewTarget(target, target)
  )
    throw new Error('invalid confirmation request');
  const current = new Set(
    (currentFindings || []).map((row) => (typeof row === 'string' ? row : row.finding_id)),
  );
  const reports = [];
  for (const attempt of attempts || []) {
    if (attempt?.included !== true) continue;
    const raw = getAttemptEvidence(attempt);
    if (!raw || evidenceHash(raw.output) !== attempt.output_digest)
      throw new Error('confirmation requires admitted raw source');
    const section = parseConfirmation(raw.output);
    if (!section) continue;
    if (!sameReviewTarget(raw.target_before, target) || !sameReviewTarget(raw.target_after, target))
      throw new Error('confirmation target admission mismatch');
    if (
      section.target_digest !== target.target_digest ||
      section.items.length !== ids.length ||
      section.items.some((row) => !ids.includes(row.finding_id))
    )
      throw new Error('stale or foreign confirmation coverage');
    reports.push({
      reviewer_id: attempt.reviewer_id,
      report_sha256: attempt.output_digest,
      section,
    });
  }
  const items = ids.map((finding_id) => {
    const claims = reports.map((report) => ({
      ...report.section.items.find((row) => row.finding_id === finding_id),
      reviewer_id: report.reviewer_id,
      report_sha256: report.report_sha256,
    }));
    const statuses = new Set(claims.map((row) => row.status));
    const status = current.has(finding_id)
      ? 'still_open'
      : !claims.length
        ? 'not_reobserved'
        : claims.length !== attempts.filter((attempt) => attempt?.included === true).length ||
            statuses.size > 1
          ? 'indeterminate'
          : claims[0].status;
    return { finding_id, status, claims };
  });
  return {
    schema_version: 1,
    target_digest: target.target_digest,
    items,
    complete: items.every((row) => row.status === 'verified_closed'),
  };
}
