#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeContainedFile } from './lib/runtime-context.mjs';

const DOCUMENT_TARGETS = new Set([
  'design-document',
  'implementation-plan',
  'requirements-specification',
  'architecture-decision-record',
  'test-plan',
]);
const FINDING_STAGES = new Set([
  'pre_implementation',
  'implementation_verification',
  'advisory',
]);
const FINDING_SEVERITIES = new Set(['critical', 'warning', 'info']);
const RISK_VALUES = new Set(['low', 'medium', 'high', 'critical']);
const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// The label identifies the shape. `2.0` carries the reviewer-scoped
// `finding_ref` deferred body and the D17 admission provenance; `1.0` carries a
// bare global `finding_id` and no admission at all. They are mutually
// unreadable, so one label could never have named both.
const RECEIPT_SCHEMA = '2.0';
const LEGACY_RECEIPT_SCHEMA = '1.0';
const ACCEPTED_RECEIPT_SCHEMAS = new Set([LEGACY_RECEIPT_SCHEMA, RECEIPT_SCHEMA]);
const READINESS_ADMISSION_SCHEMA = '1.0';
const LEGACY_SCOPE = 'legacy_global';
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const RECEIPT_ERROR = 'ERROR_READINESS_RECEIPT_STALE';

// C-GATE-PARSER (SLICE-008) — stable codes for the six malformed-gate classes
// `parseArtifactGate` can reject. Any caller that needs to distinguish why a
// document-phase report failed reads `error.code`, not the message text: the
// message stays human-readable and may still change independently.
export const ARTIFACT_GATE_ERROR_CODES = Object.freeze({
  MISSING_GATE: 'ERROR_ARTIFACT_GATE_MISSING',
  DUPLICATE_GATE: 'ERROR_ARTIFACT_GATE_DUPLICATE',
  INVALID_SCHEMA: 'ERROR_ARTIFACT_GATE_INVALID_SCHEMA',
  INVALID_STAGE: 'ERROR_ARTIFACT_GATE_INVALID_STAGE',
  MISSING_ACCEPTANCE_EVIDENCE: 'ERROR_ARTIFACT_GATE_MISSING_ACCEPTANCE_EVIDENCE',
  COUNT_MISMATCH: 'ERROR_ARTIFACT_GATE_COUNT_MISMATCH',
});

function gateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const GATE_ERROR_CODES = new Set(Object.values(ARTIFACT_GATE_ERROR_CODES));

// A local Artifact Gate id is a *string* before it is a pattern. `RegExp.test`
// coerces its argument, so a pattern check alone admits `7`, `true`, `false`
// and `['DOC-1']` — every one of which stringifies into the allowed alphabet —
// while refusing `0` only by the falsy accident of `0 || ''`. The type is
// checked first everywhere the id enters or is read back, because a
// verification input spelling `"7"` never matches an obligation carrying `7`,
// and that round fails quiet rather than loud.
function isFindingId(value) {
  return typeof value === 'string' && FINDING_ID.test(value);
}
const REVIEWER_PROVIDERS = new Map([
  ['claude-opus', 'claude'],
  ['codex-review', 'codex'],
  ['codex-adversarial', 'codex'],
  ['agy', 'agy'],
  ['grok', 'grok'],
]);

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('unsupported canonical JSON value');
  const keys = Object.keys(value).sort(utf8Compare);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

function contained(root, candidate) {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function normalizedRelative(value) {
  return value.split(sep).join('/');
}

function safeExistingFile(repo, suppliedPath, label) {
  if (typeof suppliedPath !== 'string' || suppliedPath.length === 0 || suppliedPath.includes('\0')) {
    throw new Error(`${label} path must be non-empty and NUL-free`);
  }
  const suppliedRoot = resolve(repo);
  const root = realpathSync(suppliedRoot);
  const suppliedCandidate = resolve(
    isAbsolute(suppliedPath) ? suppliedPath : resolve(suppliedRoot, suppliedPath),
  );
  const candidate = contained(suppliedRoot, suppliedCandidate)
    ? resolve(root, relative(suppliedRoot, suppliedCandidate))
    : suppliedCandidate;
  if (!contained(root, candidate) || candidate === root) {
    throw new Error(`${label} path is outside the repository`);
  }
  const rel = relative(root, candidate);
  const segments = rel.split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symlink`);
    if (current !== candidate && !stat.isDirectory()) {
      throw new Error(`${label} path has a non-directory ancestor`);
    }
  }
  const stat = lstatSync(candidate);
  if (!stat.isFile()) throw new Error(`${label} path is not a regular file`);
  const real = realpathSync(candidate);
  if (!contained(root, real)) throw new Error(`${label} path escapes the repository`);
  return {
    root,
    absolute_path: candidate,
    relative_path: normalizedRelative(relative(root, candidate)),
    bytes: readFileSync(candidate),
  };
}

function repositoryIdentity(repo) {
  return sha256(Buffer.from(realpathSync(resolve(repo)), 'utf8'));
}

function validateFinding(value, index, { allowLegacyAdvisoryWarnings = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw gateError(ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA, `Artifact Gate finding ${index} must be an object`);
  }
  if (!isFindingId(value.id)) {
    throw gateError(ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA, `Artifact Gate finding ${index} has an invalid id`);
  }
  if (!FINDING_SEVERITIES.has(value.severity)) {
    throw gateError(ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA, `Artifact Gate finding ${value.id} has an invalid severity`);
  }
  if (!FINDING_STAGES.has(value.stage)) {
    throw gateError(ARTIFACT_GATE_ERROR_CODES.INVALID_STAGE, `Artifact Gate finding ${value.id} has an invalid stage`);
  }
  if (value.severity === 'critical' && value.stage !== 'pre_implementation') {
    throw gateError(ARTIFACT_GATE_ERROR_CODES.INVALID_STAGE, `Critical finding ${value.id} must be pre_implementation`);
  }
  if (value.stage === 'advisory'
      && value.severity !== 'info'
      && !allowLegacyAdvisoryWarnings) {
    throw gateError(ARTIFACT_GATE_ERROR_CODES.INVALID_STAGE, `advisory finding ${value.id} must have info severity`);
  }
  if (!Array.isArray(value.acceptance_evidence)
      || value.acceptance_evidence.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)
      || (value.severity !== 'info' && value.acceptance_evidence.length === 0)) {
    throw gateError(
      ARTIFACT_GATE_ERROR_CODES.MISSING_ACCEPTANCE_EVIDENCE,
      `Artifact Gate finding ${value.id} has invalid acceptance_evidence`,
    );
  }
  return {
    id: value.id,
    severity: value.severity,
    stage: value.stage,
    acceptance_evidence: [...value.acceptance_evidence],
  };
}

function parseArtifactGateInternal(reportText, { allowLegacyAdvisoryWarnings = false } = {}) {
  if (typeof reportText !== 'string') throw new TypeError('review report must be text');
  const headings = [...reportText.matchAll(/^## Artifact Gate[ \t]*$/gmu)];
  const blocks = [...reportText.matchAll(
    /^## Artifact Gate[ \t]*\r?\n(?:[ \t]*\r?\n)*```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/gmu,
  )];
  if (headings.length !== 1 || blocks.length !== 1) {
    const code = headings.length === 0 || blocks.length === 0
      ? ARTIFACT_GATE_ERROR_CODES.MISSING_GATE
      : ARTIFACT_GATE_ERROR_CODES.DUPLICATE_GATE;
    throw gateError(code, 'review report must contain exactly one Artifact Gate JSON block');
  }
  let parsed;
  try {
    parsed = JSON.parse(blocks[0][1]);
  } catch (error) {
    throw gateError(ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA, `Artifact Gate JSON is invalid: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || parsed.schema_version !== 1 || !Array.isArray(parsed.findings)) {
    throw gateError(ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA, 'Artifact Gate schema is invalid');
  }
  const findings = parsed.findings.map((finding, index) => validateFinding(
    finding,
    index,
    { allowLegacyAdvisoryWarnings },
  ));
  const ids = new Set();
  for (const finding of findings) {
    if (ids.has(finding.id)) {
      throw gateError(ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA, `Artifact Gate contains duplicate finding id ${finding.id}`);
    }
    ids.add(finding.id);
  }
  const issueMatch = /\*\*Issues\*\*\s*:\s*[^\n]*?🔴\s*(\d+)[^\n]*?🟡\s*(\d+)[^\n]*?ℹ(?:️)?\s*(\d+)/u.exec(reportText);
  if (!issueMatch) throw gateError(ARTIFACT_GATE_ERROR_CODES.COUNT_MISMATCH, 'review report has no valid Issues summary');
  const expected = {
    critical: Number(issueMatch[1]),
    warning: Number(issueMatch[2]),
    info: Number(issueMatch[3]),
  };
  const actual = findings.reduce((counts, finding) => {
    counts[finding.severity] += 1;
    return counts;
  }, { critical: 0, warning: 0, info: 0 });
  if (canonicalStringify(actual) !== canonicalStringify(expected)) {
    throw gateError(ARTIFACT_GATE_ERROR_CODES.COUNT_MISMATCH, 'Artifact Gate finding counts do not match the report Issues summary');
  }
  return { schema_version: 1, findings };
}

export function parseArtifactGate(reportText) {
  return parseArtifactGateInternal(reportText);
}

function parseHistoricalReceiptArtifactGate(reportText) {
  return parseArtifactGateInternal(reportText, { allowLegacyAdvisoryWarnings: true });
}

function documentRecords(repo, artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error('document readiness requires at least one artifact');
  }
  const seen = new Set();
  return artifacts.map((artifact) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
        || typeof artifact.path !== 'string' || !DOCUMENT_TARGETS.has(artifact.target_kind)) {
      throw new Error('readiness artifact must be a supported document target');
    }
    if (isAbsolute(artifact.path) || artifact.path.replaceAll('\\', '/').split('/').includes('..')) {
      throw new Error('readiness artifact path must be repository-relative without dot-dot');
    }
    const file = safeExistingFile(repo, artifact.path, 'document');
    if (seen.has(file.relative_path)) throw new Error(`duplicate readiness artifact: ${file.relative_path}`);
    seen.add(file.relative_path);
    return {
      path: file.relative_path,
      target_kind: artifact.target_kind,
      sha256: sha256(file.bytes),
      byte_size: file.bytes.length,
    };
  }).sort((left, right) => utf8Compare(left.path, right.path)
    || utf8Compare(left.target_kind, right.target_kind));
}

function scopeDigest(documents) {
  return sha256(Buffer.from(canonicalStringify(
    documents.map(({ path, target_kind: targetKind, sha256: digest }) => ({
      path,
      target_kind: targetKind,
      sha256: digest,
    })),
  ), 'utf8'));
}

function isReadinessReportPath(relativePath) {
  return (
    relativePath.startsWith('.deep-review/reports/')
    && relativePath.endsWith('-review.md')
  ) || (
    relativePath.startsWith('.deep-review/tmp/reviewer-reports/')
    && relativePath.endsWith('.md')
  );
}

// C-REPORT-IDENTITY (D17) — report identity is the pair
// `(reviewer_id, trusted_report_path)`. SHA-256 is an integrity binding only:
// equal digests across two distinct report identities are valid, and neither
// `reportDigests` here nor `seenReportDigests` in verification is a uniqueness
// authority any more. What makes two records two *independent* records is the
// sealed synthesis admission below, which joins each report one-to-one to its
// own trusted attempt and route. Every record still keeps its own digest and
// every report's current bytes are still compared to it.
const ADMISSION_RECORD_KEYS = canonicalStringify([
  'admission_sha256',
  'attempt_id',
  'output_sha256',
  'provider_family',
  'reviewer_id',
  'route_sha256',
]);

function admissionRecordDigest(record) {
  return sha256(Buffer.from(canonicalStringify({
    attempt_id: record.attempt_id,
    output_sha256: record.output_sha256,
    provider_family: record.provider_family,
    reviewer_id: record.reviewer_id,
    route_sha256: record.route_sha256,
  }), 'utf8'));
}

// The carrier is emitted only by final production synthesis and arrives verbatim
// from the trusted coordinator. Readiness re-checks its seals; it never rebuilds
// a field of it from a reviewer id, a provider string, or a report path.
function parseReadinessAdmission(admission) {
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)
      || admission.schema_version !== READINESS_ADMISSION_SCHEMA
      || typeof admission.round_id !== 'string' || admission.round_id.length === 0
      || !SHA256_HEX.test(admission.routing_plan_sha256 || '')
      || !SHA256_HEX.test(admission.carrier_sha256 || '')
      || !Array.isArray(admission.records) || admission.records.length === 0) {
    throw new Error('readiness admission carrier is malformed');
  }
  const byAttempt = new Map();
  const routeIdentities = new Set();
  for (const record of admission.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || canonicalStringify(Object.keys(record).sort(utf8Compare)) !== ADMISSION_RECORD_KEYS
        || typeof record.attempt_id !== 'string' || record.attempt_id.length === 0
        || REVIEWER_PROVIDERS.get(record.reviewer_id) !== record.provider_family
        || !SHA256_HEX.test(record.route_sha256 || '')
        || !SHA256_HEX.test(record.output_sha256 || '')
        || record.admission_sha256 !== admissionRecordDigest(record)
        || byAttempt.has(record.attempt_id)
        || routeIdentities.has(record.route_sha256)) {
      throw new Error('readiness admission record is not sealed trusted attempt evidence');
    }
    byAttempt.set(record.attempt_id, record);
    routeIdentities.add(record.route_sha256);
  }
  const { carrier_sha256: seal, ...body } = admission;
  if (sha256(Buffer.from(canonicalStringify(body), 'utf8')) !== seal) {
    throw new Error('readiness admission carrier seal is invalid');
  }
  return byAttempt;
}

// Joins one trusted report input to at most one admission record. `exhaustive`
// is true at creation, where readiness sees every report of the round and so
// every admitted attempt must be consumed by one of them — including a report
// whose Artifact Gate is later excluded. Verification sees only the reports the
// receipt counted, so there it is injective rather than bijective: an
// unconsumed record can inflate nothing, because each counted report still has
// to bring its own.
function joinAdmittedAttempt(admittedByAttempt, report, digest, consumedAttempts) {
  if (admittedByAttempt === null) {
    if (Object.hasOwn(report, 'attempt_id')) {
      throw new Error('an admitted attempt id requires a sealed readiness admission carrier');
    }
    return null;
  }
  if (typeof report.attempt_id !== 'string' || !admittedByAttempt.has(report.attempt_id)) {
    throw new Error(`reviewer report names no admitted attempt: ${report.reviewer_id}`);
  }
  if (consumedAttempts.has(report.attempt_id)) {
    throw new Error(`admitted attempt is claimed twice: ${report.attempt_id}`);
  }
  consumedAttempts.add(report.attempt_id);
  const admitted = admittedByAttempt.get(report.attempt_id);
  // Reviewer and provider are derived from the admitted route, never accepted
  // from the report or path claim.
  if (admitted.reviewer_id !== report.reviewer_id
      || admitted.provider_family !== report.provider_family) {
    throw new Error(`admitted attempt does not authorise reviewer ${report.reviewer_id}`);
  }
  if (admitted.output_sha256 !== digest) {
    throw new Error(`admitted attempt output does not match the report bytes: ${report.reviewer_id}`);
  }
  return admitted;
}

function reportRecords(repo, reports, admission) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error('document readiness requires at least one reviewer report');
  }
  const admittedByAttempt = admission === null || admission === undefined
    ? null
    : parseReadinessAdmission(admission);
  const reviewerIds = new Set();
  const reportPaths = new Set();
  const consumedAttempts = new Set();
  // Without a carrier readiness holds no independence evidence at all, so it
  // cannot admit a second byte-identical report. The refusal is the missing
  // attempt evidence — not a claim that the digest is an identity.
  const unbackedDigests = new Set();
  const records = [];
  const exclusions = [];
  for (const report of reports) {
    if (!report || typeof report !== 'object' || Array.isArray(report)
        || typeof report.reviewer_id !== 'string' || report.reviewer_id.length === 0
        || typeof report.provider_family !== 'string' || report.provider_family.length === 0) {
      throw new Error('reviewer report evidence is malformed');
    }
    if (REVIEWER_PROVIDERS.get(report.reviewer_id) !== report.provider_family) {
      throw new Error(`reviewer/provider identity mismatch: ${report.reviewer_id}`);
    }
    if (reviewerIds.has(report.reviewer_id)) {
      throw new Error(`duplicate reviewer evidence: ${report.reviewer_id}`);
    }
    reviewerIds.add(report.reviewer_id);
    const file = safeExistingFile(repo, report.path, 'review report');
    if (!isReadinessReportPath(file.relative_path)) {
      throw new Error('review report must be canonical or a private reviewer report');
    }
    if (reportPaths.has(file.relative_path)) {
      throw new Error(`duplicate reviewer report path: ${file.relative_path}`);
    }
    reportPaths.add(file.relative_path);
    const digest = sha256(file.bytes);
    const admitted = joinAdmittedAttempt(admittedByAttempt, report, digest, consumedAttempts);
    if (admittedByAttempt === null) {
      if (unbackedDigests.has(digest)) {
        throw new Error('byte-identical reviewer reports require distinct admitted attempt evidence');
      }
      unbackedDigests.add(digest);
    }
    // C-GATE-EXCLUSION (D16) — only a canonical gate-parse failure is that one
    // reviewer's local failure. It becomes a stable exclusion record and lowers
    // the admitted floor; it never aborts readiness, and the excluded reviewer's
    // local id never joins another reviewer's namespace. Anything else — a path
    // escape, a forged identity — is still the round's failure.
    let artifactGate;
    try {
      artifactGate = parseArtifactGate(file.bytes.toString('utf8'));
    } catch (error) {
      if (!GATE_ERROR_CODES.has(error?.code)) throw error;
      exclusions.push({
        code: error.code,
        path: file.relative_path,
        provider_family: report.provider_family,
        reviewer_id: report.reviewer_id,
      });
      continue;
    }
    records.push({
      path: file.relative_path,
      reviewer_id: report.reviewer_id,
      provider_family: report.provider_family,
      sha256: digest,
      artifact_gate_sha256: sha256(Buffer.from(canonicalStringify(artifactGate), 'utf8')),
      artifact_gate: artifactGate,
      ...(admitted ? {
        attempt_id: admitted.attempt_id,
        route_sha256: admitted.route_sha256,
        admission_sha256: admitted.admission_sha256,
      } : {}),
    });
  }
  if (admittedByAttempt !== null && consumedAttempts.size !== admittedByAttempt.size) {
    throw new Error('every admitted attempt must be consumed by exactly one reviewer report');
  }
  return {
    records: records.sort((left, right) => utf8Compare(left.reviewer_id, right.reviewer_id)),
    exclusions: exclusions.sort((left, right) => utf8Compare(left.reviewer_id, right.reviewer_id)),
  };
}

// C-FINDING-IDENTITY (D17) — a local Artifact Gate id is the reviewer's own
// namespace, never a global one. The authoritative carrier is `finding_ref`,
// naming both the reviewer and the local id; every identity, lookup,
// deduplication and gate-arithmetic operation keys on `canonicalStringify` of
// that ref. A bare local id may be projected for display and may never be read
// back by an authority, because two reviewers naming `DOC-1` are two findings.
function findingRef(reviewerId, findingId) {
  return { finding_id: findingId, reviewer_id: reviewerId };
}

function findingRefKey(ref) {
  return canonicalStringify(ref);
}

// Deterministic order for every authoritative list: reviewer first, local id
// second. Sorting the canonical ref string instead would order by local id,
// which is precisely the global namespace this rule denies.
function compareFindingRefs(left, right) {
  return utf8Compare(left.reviewer_id, right.reviewer_id)
    || utf8Compare(left.finding_id, right.finding_id);
}

const FINDING_REF_KEYS = canonicalStringify(['finding_id', 'reviewer_id']);

// The single shape authority for a reviewer-scoped reference. `review-synthesis.mjs`
// imports it rather than keeping a second copy, so the deferred carrier crossing
// that boundary is admitted by this definition alone and cannot drift from it —
// and so shadow and active synthesis cannot end up reading different carriers.
export function isFindingRef(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && canonicalStringify(Object.keys(value).sort(utf8Compare)) === FINDING_REF_KEYS
    // A reference nobody wrote is the unattributed fallback D17 forbids: an empty
    // or non-string reviewer id names no reviewer, so it names no finding either.
    && typeof value.reviewer_id === 'string' && value.reviewer_id.length > 0
    && isFindingId(value.finding_id);
}

function requireFindingRef(value, label) {
  if (!isFindingRef(value)) {
    throw new Error(`${label} requires a reviewer-scoped finding_ref`);
  }
  return findingRef(value.reviewer_id, value.finding_id);
}

// The schema-1.0 arm. That writer collapsed canonically identical cross-reviewer
// duplicates of a bare local id into one obligation, so a verified historical
// receipt exposes an explicitly non-attributing reference rather than a guess at
// which reviewer produced it. The two arms carry different key sets, so they are
// structurally distinct before `canonicalStringify` and a historical global
// obligation can never collide with a present or future reviewer id.
const LEGACY_FINDING_REF_KEYS = canonicalStringify(['finding_id', 'scope']);

function legacyFindingRef(findingId) {
  return { finding_id: findingId, scope: LEGACY_SCOPE };
}

function isLegacyFindingRef(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && canonicalStringify(Object.keys(value).sort(utf8Compare)) === LEGACY_FINDING_REF_KEYS
    && value.scope === LEGACY_SCOPE
    && isFindingId(value.finding_id);
}

function requireLegacyFindingRef(value, label) {
  const findingId = isLegacyFindingRef(value?.finding_ref)
    ? value.finding_ref.finding_id
    : value?.finding_id;
  if (!isFindingId(findingId)) {
    throw new Error(`${label} requires a ${LEGACY_SCOPE} finding id`);
  }
  return legacyFindingRef(findingId);
}

function mergeGateFindings(reports) {
  const byRef = new Map();
  for (const report of reports) {
    // No reviewer, no reference. An unattributed gate fails closed here rather
    // than falling back to the bare local id further downstream.
    if (typeof report?.reviewer_id !== 'string' || report.reviewer_id.length === 0) {
      throw new Error('Artifact Gate evidence requires an admitted reviewer id');
    }
    for (const finding of report.artifact_gate.findings) {
      // The canonical parser already refuses a non-string id; hand-built gate
      // evidence reaches this authority without passing through it, and a
      // non-string id here would be carried verbatim into `blocking_finding_refs`.
      if (!isFindingId(finding?.id)) {
        throw new Error('Artifact Gate evidence requires a string finding id');
      }
      const ref = findingRef(report.reviewer_id, finding.id);
      const key = findingRefKey(ref);
      const prior = byRef.get(key);
      if (prior && (
        prior.severity !== finding.severity
        || prior.stage !== finding.stage
        || canonicalStringify(prior.acceptance_evidence) !== canonicalStringify(finding.acceptance_evidence)
      )) {
        throw new Error(`one reviewer contradicts itself on Artifact Gate finding ${key}`);
      }
      if (!prior) byRef.set(key, { ...finding, finding_ref: ref });
    }
  }
  return [...byRef.values()]
    .sort((left, right) => compareFindingRefs(left.finding_ref, right.finding_ref));
}

function documentVerdict(readiness) {
  if (readiness.status === 'DOCUMENT_BLOCKED') return 'REQUEST_CHANGES';
  return readiness.deferred_findings.length > 0 ? 'CONCERN' : 'APPROVE';
}

export function evaluateDocumentReadiness({
  reportEvidence,
  risk,
  requiredReviewers,
  providerFamilyMinimum,
  gateExclusions = [],
} = {}) {
  if (!RISK_VALUES.has(risk)) throw new Error(`invalid document readiness risk: ${String(risk)}`);
  const riskMinimum = ['high', 'critical'].includes(risk) ? 2 : 1;
  if (requiredReviewers !== undefined
      && (!Number.isInteger(requiredReviewers) || requiredReviewers < 1)) {
    throw new Error('requiredReviewers must be a positive integer');
  }
  if (providerFamilyMinimum !== undefined
      && (!Number.isInteger(providerFamilyMinimum) || providerFamilyMinimum < 1)) {
    throw new Error('providerFamilyMinimum must be a positive integer');
  }
  const reviewerMinimum = Math.max(riskMinimum, requiredReviewers ?? riskMinimum);
  const familyMinimum = Math.max(riskMinimum, providerFamilyMinimum ?? riskMinimum);
  const findings = mergeGateFindings(reportEvidence);
  const blockingFindingRefs = findings
    .filter((finding) => ['critical', 'warning'].includes(finding.severity)
      && finding.stage === 'pre_implementation')
    .map((finding) => finding.finding_ref);
  const blockingReasons = [];
  if (reportEvidence.length < reviewerMinimum) blockingReasons.push('required_reviewers');
  const providerFamilies = new Set(reportEvidence.map((report) => report.provider_family)).size;
  if (providerFamilies < familyMinimum) blockingReasons.push('provider_families');
  if (blockingFindingRefs.length > 0) blockingReasons.push('pre_implementation_findings');
  const deferredFindings = findings
    .filter((finding) => ['critical', 'warning'].includes(finding.severity)
      && finding.stage === 'implementation_verification')
    .map((finding) => ({
      finding_ref: finding.finding_ref,
      severity: finding.severity,
      acceptance_evidence: finding.acceptance_evidence,
    }));
  const status = blockingReasons.length === 0 ? 'READY_FOR_IMPLEMENTATION' : 'DOCUMENT_BLOCKED';
  const readiness = {
    status,
    blocking_finding_refs: blockingFindingRefs,
    // Display projection only: one entry per authoritative ref, same order, so a
    // local id shared by two reviewers renders twice. Never read back.
    blocking_finding_ids: blockingFindingRefs.map((ref) => ref.finding_id),
    blocking_reasons: blockingReasons,
    deferred_findings: deferredFindings,
    // Stable per-report exclusion records. The floor above is computed from
    // admitted reports only, so an excluded reviewer lowers it rather than
    // aborting the round.
    gate_exclusions: [...gateExclusions],
    reviewer_count: reportEvidence.length,
    provider_family_count: providerFamilies,
    required_reviewers: reviewerMinimum,
    provider_family_minimum: familyMinimum,
  };
  return {
    ...readiness,
    document_verdict: documentVerdict(readiness),
  };
}

// The schema-1.0 writer semantics, reproduced exactly so a historical receipt is
// recomputed with the rule that produced it. That writer keyed every admitted
// finding globally by its bare local id and collapsed cross-reviewer duplicates
// whose severity, stage and acceptance evidence were canonically equal; only a
// non-identical duplicate threw. A `1.0` receipt is never compared against a
// reviewer-scoped recomputation, and its bytes are never rewritten or resealed.
function legacyMergeGateFindings(reports) {
  const byId = new Map();
  for (const report of reports) {
    for (const finding of report.artifact_gate.findings) {
      const prior = byId.get(finding.id);
      if (prior && (
        prior.severity !== finding.severity
        || prior.stage !== finding.stage
        || canonicalStringify(prior.acceptance_evidence) !== canonicalStringify(finding.acceptance_evidence)
      )) {
        throw new Error(`reviewers disagree on Artifact Gate finding ${finding.id}`);
      }
      if (!prior) byId.set(finding.id, finding);
    }
  }
  return [...byId.values()].sort((left, right) => utf8Compare(left.id, right.id));
}

function evaluateLegacyDocumentReadiness({
  reportEvidence,
  risk,
  requiredReviewers,
  providerFamilyMinimum,
}) {
  const riskMinimum = ['high', 'critical'].includes(risk) ? 2 : 1;
  const reviewerMinimum = Math.max(riskMinimum, requiredReviewers ?? riskMinimum);
  const familyMinimum = Math.max(riskMinimum, providerFamilyMinimum ?? riskMinimum);
  const findings = legacyMergeGateFindings(reportEvidence);
  const blockingFindingIds = findings
    .filter((finding) => ['critical', 'warning'].includes(finding.severity)
      && finding.stage === 'pre_implementation')
    .map((finding) => finding.id);
  const blockingReasons = [];
  if (reportEvidence.length < reviewerMinimum) blockingReasons.push('required_reviewers');
  const providerFamilies = new Set(reportEvidence.map((report) => report.provider_family)).size;
  if (providerFamilies < familyMinimum) blockingReasons.push('provider_families');
  if (blockingFindingIds.length > 0) blockingReasons.push('pre_implementation_findings');
  return {
    status: blockingReasons.length === 0 ? 'READY_FOR_IMPLEMENTATION' : 'DOCUMENT_BLOCKED',
    deferred_findings: findings
      .filter((finding) => ['critical', 'warning'].includes(finding.severity)
        && finding.stage === 'implementation_verification')
      .map((finding) => ({
        finding_id: finding.id,
        severity: finding.severity,
        acceptance_evidence: finding.acceptance_evidence,
      })),
    reviewer_count: reportEvidence.length,
    provider_family_count: providerFamilies,
  };
}

export function createDocumentReadinessReceipt(options = {}) {
  const repo = resolve(options.repo);
  if (!RISK_VALUES.has(options.risk)) {
    throw new Error('document readiness receipt risk is required');
  }
  const risk = options.risk;
  const documents = documentRecords(repo, options.artifacts);
  const readinessAdmission = options.readinessAdmission ?? null;
  const {
    records: reportsWithGates,
    exclusions,
  } = reportRecords(repo, options.reports, readinessAdmission);
  const readiness = evaluateDocumentReadiness({
    reportEvidence: reportsWithGates,
    risk,
    requiredReviewers: options.requiredReviewers,
    providerFamilyMinimum: options.providerFamilyMinimum,
    gateExclusions: exclusions,
  });
  if (readiness.status !== 'READY_FOR_IMPLEMENTATION') {
    return { ...readiness, receipt_path: null };
  }
  const scopeSha256 = scopeDigest(documents);
  const reports = reportsWithGates.map(({ artifact_gate: ignored, ...report }) => report);
  const body = {
    schema_version: RECEIPT_SCHEMA,
    status: 'READY_FOR_IMPLEMENTATION',
    scope_sha256: scopeSha256,
    repository_identity_sha256: repositoryIdentity(repo),
    risk,
    generated_at: options.generatedAt || new Date().toISOString(),
    documents,
    // Persisted verbatim, so verification repeats the same attempt/route join
    // rather than trusting a historical reviewer/path assertion.
    readiness_admission: readinessAdmission,
    reports,
    reviewer_requirements: {
      required_reviewers: readiness.required_reviewers,
      provider_family_minimum: readiness.provider_family_minimum,
      actual_reviewers: readiness.reviewer_count,
      actual_provider_families: readiness.provider_family_count,
    },
    deferred_findings: readiness.deferred_findings,
  };
  const receipt = {
    ...body,
    receipt_sha256: sha256(Buffer.from(canonicalStringify(body), 'utf8')),
  };
  const receiptPath = resolve(
    repo,
    '.deep-review',
    'receipts',
    'document-readiness',
    `${scopeSha256}-${receipt.receipt_sha256}.json`,
  );
  writeContainedFile(repo, receiptPath, `${canonicalStringify(receipt)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return {
    ...readiness,
    receipt_path: receiptPath,
    scope_sha256: scopeSha256,
    receipt_sha256: receipt.receipt_sha256,
  };
}

function stale(message, cause) {
  const error = new Error(`${RECEIPT_ERROR}: ${message}`, cause ? { cause } : undefined);
  error.code = RECEIPT_ERROR;
  return error;
}

function verifyReceipt(options) {
  const repo = resolve(options.repo);
  const file = safeExistingFile(repo, options.receiptPath, 'readiness receipt');
  const expectedPrefix = '.deep-review/receipts/document-readiness/';
  if (!file.relative_path.startsWith(expectedPrefix)) {
    throw new Error('receipt is outside the document-readiness runtime directory');
  }
  let receipt;
  try {
    receipt = JSON.parse(file.bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`receipt JSON is invalid: ${error.message}`);
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || !ACCEPTED_RECEIPT_SCHEMAS.has(receipt.schema_version)
      || receipt.status !== 'READY_FOR_IMPLEMENTATION'
      || !RISK_VALUES.has(receipt.risk)
      || !/^[a-f0-9]{64}$/u.test(receipt.scope_sha256 || '')
      || !/^[a-f0-9]{64}$/u.test(receipt.receipt_sha256 || '')
      || !Array.isArray(receipt.documents)
      || !Array.isArray(receipt.reports)
      || !Array.isArray(receipt.deferred_findings)
      || receipt.documents.length === 0
      || receipt.reports.length === 0
      || !receipt.reviewer_requirements
      || typeof receipt.reviewer_requirements !== 'object'
      || Array.isArray(receipt.reviewer_requirements)) {
    throw new Error('receipt schema is invalid');
  }
  if (basename(file.relative_path)
      !== `${receipt.scope_sha256}-${receipt.receipt_sha256}.json`) {
    throw new Error('receipt path does not match its scope and authority hashes');
  }
  const { receipt_sha256: seal, ...body } = receipt;
  if (sha256(Buffer.from(canonicalStringify(body), 'utf8')) !== seal) {
    throw new Error('receipt seal is invalid');
  }
  if (receipt.repository_identity_sha256 !== repositoryIdentity(repo)) {
    throw new Error('receipt belongs to a different repository');
  }
  const seenDocuments = new Set();
  const documents = receipt.documents.map((document) => {
    if (!DOCUMENT_TARGETS.has(document?.target_kind)
        || typeof document.path !== 'string'
        || !/^[a-f0-9]{64}$/u.test(document.sha256 || '')
        || !Number.isInteger(document.byte_size)
        || document.byte_size < 0
        || seenDocuments.has(document.path)) {
      throw new Error('receipt document target is invalid');
    }
    seenDocuments.add(document.path);
    const current = safeExistingFile(repo, document.path, 'receipt document');
    const digest = sha256(current.bytes);
    if (digest !== document.sha256 || current.bytes.length !== document.byte_size) {
      throw new Error(`document hash changed: ${document.path}`);
    }
    return {
      path: current.relative_path,
      target_kind: document.target_kind,
      sha256: digest,
      byte_size: current.bytes.length,
    };
  }).sort((left, right) => utf8Compare(left.path, right.path)
    || utf8Compare(left.target_kind, right.target_kind));
  if (scopeDigest(documents) !== receipt.scope_sha256) {
    throw new Error('receipt scope hash is stale');
  }
  // The dual reader. A sealed `1.0` receipt is read with its own schema and
  // recomputed under that schema's writer semantics — including the digest
  // uniqueness the `1.0` writer itself enforced, which is what stands in for the
  // admission evidence a `1.0` receipt cannot carry. A `2.0` receipt is read
  // strictly and its independence comes from the admission join instead, so
  // `seenReportDigests` is not a uniqueness authority there.
  const legacy = receipt.schema_version === LEGACY_RECEIPT_SCHEMA;
  if (legacy === Object.hasOwn(receipt, 'readiness_admission')) {
    throw new Error('receipt admission provenance does not match its schema');
  }
  const admittedByAttempt = legacy || receipt.readiness_admission === null
    ? null
    : parseReadinessAdmission(receipt.readiness_admission);
  const admissionKeys = ['attempt_id', 'route_sha256', 'admission_sha256'];
  const seenReviewers = new Set();
  const seenReportPaths = new Set();
  const seenLegacyDigests = new Set();
  const consumedAttempts = new Set();
  const reportEvidence = receipt.reports.map((report) => {
    if (!report || typeof report !== 'object' || Array.isArray(report)
        || typeof report.reviewer_id !== 'string' || report.reviewer_id.length === 0
        || typeof report.provider_family !== 'string' || report.provider_family.length === 0
        || !SHA256_HEX.test(report.sha256 || '')
        || !SHA256_HEX.test(report.artifact_gate_sha256 || '')
        || seenReviewers.has(report.reviewer_id)
        || seenReportPaths.has(report.path)
        || (legacy && seenLegacyDigests.has(report.sha256))
        || admissionKeys.some((key) => Object.hasOwn(report, key)) !== (admittedByAttempt !== null)
        || REVIEWER_PROVIDERS.get(report.reviewer_id) !== report.provider_family) {
      throw new Error('receipt reviewer evidence is invalid');
    }
    seenReviewers.add(report.reviewer_id);
    seenReportPaths.add(report.path);
    seenLegacyDigests.add(report.sha256);
    const current = safeExistingFile(repo, report.path, 'receipt report');
    if (!isReadinessReportPath(current.relative_path)) {
      throw new Error('receipt report path is not trusted runtime evidence');
    }
    // Every record still keeps its own digest, and each report's current bytes
    // are still compared to it. Only the cross-record equality constraint went.
    if (sha256(current.bytes) !== report.sha256) {
      throw new Error(`review report hash changed: ${report.path}`);
    }
    const admitted = joinAdmittedAttempt(admittedByAttempt, report, report.sha256, consumedAttempts);
    if (admitted && (admitted.route_sha256 !== report.route_sha256
        || admitted.admission_sha256 !== report.admission_sha256)) {
      throw new Error(`receipt admission provenance is inconsistent: ${report.path}`);
    }
    // Schema-2.0 parsing is strict; only the sealed schema-1.0 recomputation
    // relaxes the advisory rule its writer accepted.
    const gate = legacy
      ? parseHistoricalReceiptArtifactGate(current.bytes.toString('utf8'))
      : parseArtifactGate(current.bytes.toString('utf8'));
    if (sha256(Buffer.from(canonicalStringify(gate), 'utf8')) !== report.artifact_gate_sha256) {
      throw new Error(`Artifact Gate hash changed: ${report.path}`);
    }
    return {
      path: current.relative_path,
      reviewer_id: report.reviewer_id,
      provider_family: report.provider_family,
      sha256: report.sha256,
      artifact_gate_sha256: report.artifact_gate_sha256,
      artifact_gate: gate,
    };
  });
  const requirements = receipt.reviewer_requirements;
  for (const key of [
    'required_reviewers',
    'provider_family_minimum',
    'actual_reviewers',
    'actual_provider_families',
  ]) {
    if (!Number.isInteger(requirements[key]) || requirements[key] < 1) {
      throw new Error('receipt reviewer requirements are invalid');
    }
  }
  const evaluate = legacy ? evaluateLegacyDocumentReadiness : evaluateDocumentReadiness;
  const readiness = evaluate({
    reportEvidence,
    risk: receipt.risk,
    requiredReviewers: requirements.required_reviewers,
    providerFamilyMinimum: requirements.provider_family_minimum,
  });
  if (readiness.status !== 'READY_FOR_IMPLEMENTATION'
      || readiness.reviewer_count !== requirements.actual_reviewers
      || readiness.provider_family_count !== requirements.actual_provider_families
      || canonicalStringify(readiness.deferred_findings)
        !== canonicalStringify(receipt.deferred_findings)) {
    throw new Error('receipt readiness evidence is inconsistent');
  }
  // Only after the whole historical receipt verifies does each bare `1.0`
  // obligation normalize — in memory — to an explicitly non-attributing
  // `legacy_global` reference. One or more canonically identical historical
  // matches are one obligation; zero matches and conflicting multi-matches
  // already failed the comparison above. Nothing on disk is rewritten.
  const deferredFindings = legacy
    ? receipt.deferred_findings.map((finding) => ({
      acceptance_evidence: finding.acceptance_evidence,
      finding_ref: legacyFindingRef(finding.finding_id),
      severity: finding.severity,
    }))
    : receipt.deferred_findings;
  return {
    status: receipt.status,
    receipt,
    receipt_path: file.absolute_path,
    scope_sha256: receipt.scope_sha256,
    risk: receipt.risk,
    deferred_findings: deferredFindings,
    document_verdict: documentVerdict(readiness),
  };
}

export function verifyReadinessReceipt(options = {}) {
  try {
    return verifyReceipt(options);
  } catch (error) {
    if (error?.code === RECEIPT_ERROR) throw error;
    throw stale(error.message, error);
  }
}

export function evaluateDeferredAcceptance({
  receipt,
  verifiedItems = [],
  repo,
  implementationArtifacts,
  implementationScopeSha256,
} = {}) {
  const document = receipt?.receipt || receipt;
  if (!document || !Array.isArray(document.deferred_findings)) {
    throw new Error('verified readiness receipt is required');
  }
  if (!Array.isArray(verifiedItems)) throw new TypeError('verifiedItems must be an array');
  if (!Array.isArray(implementationArtifacts) || implementationArtifacts.length === 0) {
    throw new Error('current implementation artifacts are required');
  }
  const implementationRecords = implementationArtifacts.map((artifact) => {
    if (!artifact || typeof artifact.path !== 'string') {
      throw new Error('implementation artifact is malformed');
    }
    const file = safeExistingFile(resolve(repo), artifact.path, 'implementation artifact');
    return { path: file.relative_path, sha256: sha256(file.bytes) };
  }).sort((left, right) => utf8Compare(left.path, right.path));
  const duplicatePaths = new Set(implementationRecords.map((record) => record.path));
  if (duplicatePaths.size !== implementationRecords.length) {
    throw new Error('duplicate implementation artifact');
  }
  const computedScopeSha256 = sha256(Buffer.from(canonicalStringify(implementationRecords), 'utf8'));
  if (implementationScopeSha256 !== undefined
      && implementationScopeSha256 !== computedScopeSha256) {
    throw new Error('implementation scope SHA-256 is stale');
  }
  // A bare `finding_id` is accepted only for a verified `1.0` receipt, where it
  // normalizes to the same `legacy_global` reference the reader exposed. A `2.0`
  // receipt requires the full reviewer-scoped ref on every input and refuses a
  // bare-id or `legacy_global` fallback, and so does a receipt that names no
  // schema at all.
  const legacy = document.schema_version === LEGACY_RECEIPT_SCHEMA;
  const requireRef = (value, label) => (legacy
    ? requireLegacyFindingRef(value, label)
    : requireFindingRef(value?.finding_ref, label));
  const requiredRefs = document.deferred_findings.map(
    (finding) => requireRef(finding, 'deferred readiness obligation'),
  );
  const requiredByRef = new Map(document.deferred_findings.map((finding, index) => [
    findingRefKey(requiredRefs[index]),
    finding.acceptance_evidence,
  ]));
  const verifiedByRef = new Map();
  for (const item of verifiedItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || item.implementation_scope_sha256 !== computedScopeSha256
        || !Array.isArray(item.verification_results)
        || item.verification_results.length === 0) {
      throw new Error('deferred acceptance verification item is malformed');
    }
    const itemRef = findingRefKey(
      requireRef(item, 'deferred acceptance verification item'),
    );
    if (verifiedByRef.has(itemRef)) {
      throw new Error(`duplicate deferred verification: ${itemRef}`);
    }
    const requiredEvidence = requiredByRef.get(itemRef);
    const resultByCriterion = new Map();
    for (const result of item.verification_results) {
      if (!result || typeof result.criterion !== 'string'
          || result.status !== 'passed'
          || typeof result.evidence_path !== 'string'
          || !/^[a-f0-9]{64}$/u.test(result.evidence_sha256 || '')
          || resultByCriterion.has(result.criterion)) {
        throw new Error('deferred acceptance verification result is malformed');
      }
      const evidence = safeExistingFile(resolve(repo), result.evidence_path, 'acceptance evidence');
      if (sha256(evidence.bytes) !== result.evidence_sha256) {
        throw new Error(`acceptance evidence hash changed: ${result.evidence_path}`);
      }
      resultByCriterion.set(result.criterion, {
        criterion: result.criterion,
        status: result.status,
        evidence_path: evidence.relative_path,
        evidence_sha256: result.evidence_sha256,
      });
    }
    if (!requiredEvidence
        || requiredEvidence.some((criterion) => !resultByCriterion.has(criterion))) {
      throw new Error(`deferred acceptance evidence does not satisfy ${itemRef}`);
    }
    verifiedByRef.set(itemRef, [...resultByCriterion.values()]);
  }
  const pendingRefs = requiredRefs.filter((ref) => !verifiedByRef.has(findingRefKey(ref)));
  return {
    complete: pendingRefs.length === 0,
    required_count: requiredRefs.length,
    verified_count: requiredRefs.length - pendingRefs.length,
    pending_finding_refs: pendingRefs,
    // Display projection only, on the same terms as `blocking_finding_ids`.
    pending_finding_ids: pendingRefs.map((ref) => ref.finding_id),
    verified_items: requiredRefs
      .filter((ref) => verifiedByRef.has(findingRefKey(ref)))
      .map((ref) => ({
        finding_ref: ref,
        verification_results: verifiedByRef.get(findingRefKey(ref)),
        implementation_scope_sha256: computedScopeSha256,
      })),
    implementation_scope_sha256: computedScopeSha256,
  };
}

export function gateImplementationVerdict(synthesis, deferredAcceptance) {
  if (!synthesis || typeof synthesis !== 'object' || !deferredAcceptance) {
    throw new TypeError('synthesis and deferred acceptance are required');
  }
  // The gate names the obligations it is still holding open, and it names them
  // the way the arithmetic that produced them did: by reviewer-scoped ref, read
  // from the structured carrier and never rebuilt from the bare projection.
  const pendingRefs = (deferredAcceptance.pending_finding_refs || []).map(
    (ref) => requireFindingRef(ref, 'pending deferred obligation'),
  );
  const floored = !deferredAcceptance.complete && synthesis.verdict === 'APPROVE';
  return {
    ...synthesis,
    ...(floored ? { verdict: 'CONCERN' } : {}),
    deferred_acceptance_floor: floored,
    pending_deferred_finding_refs: pendingRefs,
    // Display projection only, on the same terms as `blocking_finding_ids`.
    pending_deferred_finding_ids: pendingRefs.map((ref) => ref.finding_id),
  };
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const inputIndex = process.argv.indexOf('--input');
    if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error('--input FILE is required');
    const input = JSON.parse(readFileSync(resolve(process.argv[inputIndex + 1]), 'utf8'));
    const result = input.action === 'create'
      ? createDocumentReadinessReceipt(input)
      : input.action === 'verify'
        ? verifyReadinessReceipt({ repo: input.repo, receiptPath: input.receipt_path })
        : input.action === 'evaluate-deferred'
          ? evaluateDeferredAcceptance(input)
          : (() => { throw new Error('input action must be create, verify, or evaluate-deferred'); })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code || 'DOCUMENT_READINESS_ERROR', error: error.message })}\n`);
    process.exitCode = 2;
  }
}
