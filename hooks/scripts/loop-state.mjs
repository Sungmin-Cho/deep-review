#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAssignmentRole } from './lib/assignment-rubrics.mjs';
import { isReviewerId } from './lib/reviewer-ids.mjs';
import { canonicalizeRepoPath, extractFindings, matchFindings } from './lib/finding-identity.mjs';
import { isSessionDocReportName } from './lib/session-doc.js';
import { classifyLiveness, currentHostHash, processStartMs } from './mutation-protocol.mjs';
import { buildSchema3Round, readSchema3Round, loopCapDecision, decideRound, decideOperationalStop, buildResponseEvidence, adaptiveCarrier } from './lib/review-loop-decision.mjs';
import { readControlFile, containedPath, CONTROL_LIMIT } from './lib/review-target-snapshot.mjs';
import { compareFindingStates } from './lib/finding-identity.mjs';
export { decideRound, decideOperationalStop, buildResponseEvidence, adaptiveCarrier };

const SNAPSHOT_SCHEMA = 1;
const ROUND_STATE_SCHEMA = 2;
const LEGACY_ROUND_STATE_SCHEMA = 1;
const PRIOR_CONTEXT_MAX_BYTES_DEFAULT = 16384;
const PRIOR_CONTEXT_REJECT_NOTICE = '재검증 필수, 억제 금지 (advisory — re-verify, never suppress)';
const STALLED_REPEAT_RATIO_THRESHOLD = 0.5;
const RESIDUE_STALE_MS_DEFAULT = 3_600_000;
const RESIDUE_STATE_PATTERN = /^loop-(.+)-round-(\d+)\.state\.json$/u;
const RESIDUE_PRIOR_PATTERN = /^loop-(.+)-round-(\d+)\.prior\.md$/u;
const SESSION_DOC_SCHEMA = 1;
const TAXONOMY = new Set([
  'error-handling',
  'naming-convention',
  'type-safety',
  'test-coverage',
  'security',
  'performance',
  'architecture',
]);
const ARTIFACT_PHASES = new Set(['document', 'implementation']);
const RISK_VALUES = new Set(['low', 'medium', 'high', 'critical']);
const READINESS_VALUES = new Set(['READY_FOR_IMPLEMENTATION', 'DOCUMENT_BLOCKED']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

class LoopStateError extends Error {
  constructor(message, code = 'LOOP_STATE_ERROR', details = {}) {
    super(message);
    this.name = 'LoopStateError';
    this.code = code;
    this.details = details;
  }
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function absolute(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new LoopStateError(`${label} must be a non-empty NUL-free path`, 'INVALID_PATH');
  }
  return resolve(value);
}

function atomicText(filePath, text, label = 'output') {
  const target = absolute(filePath, label);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

function atomicJson(filePath, value) {
  atomicText(filePath, `${JSON.stringify(value)}\n`, 'output');
}

function listReports(reportsDir) {
  const root = absolute(reportsDir, 'reports directory');
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile()
      && entry.name.endsWith('-review.md')
      && !isSessionDocReportName(entry.name))
    .map((entry) => resolve(root, entry.name))
    .sort(utf8Compare);
}

export function snapshotReports({ reportsDir, output } = {}) {
  const snapshot = {
    schema_version: SNAPSHOT_SCHEMA,
    reports_dir: absolute(reportsDir, 'reports directory'),
    reports: listReports(reportsDir),
  };
  if (output) atomicJson(output, snapshot);
  return { ...snapshot, ...(output ? { snapshot_file: absolute(output, 'output') } : {}) };
}

function readSnapshot(snapshotFile) {
  const filePath = absolute(snapshotFile, 'snapshot file');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new LoopStateError(`cannot read snapshot: ${error.message}`, 'INVALID_SNAPSHOT');
  }
  if (parsed?.schema_version !== SNAPSHOT_SCHEMA || !Array.isArray(parsed.reports)) {
    throw new LoopStateError('snapshot schema is invalid', 'INVALID_SNAPSHOT');
  }
  return parsed;
}

export function resolveRoundReport({ reportsDir, snapshotFile } = {}) {
  const before = readSnapshot(snapshotFile);
  const currentDir = absolute(reportsDir, 'reports directory');
  if (absolute(before.reports_dir, 'snapshot reports directory') !== currentDir) {
    throw new LoopStateError('snapshot reports directory differs from current directory', 'SNAPSHOT_DIRECTORY_MISMATCH');
  }
  const previous = new Set(before.reports.map((entry) => absolute(entry, 'snapshot report')));
  const delta = listReports(currentDir).filter((entry) => !previous.has(entry));
  if (delta.length !== 1) {
    throw new LoopStateError(
      `review round must create exactly one report, observed ${delta.length}`,
      'REPORT_DELTA_COUNT',
      { count: delta.length, reports: delta },
    );
  }
  return { report_path: delta[0], count: 1 };
}

export function assertSamePath({ expected, actual, platform = process.platform } = {}) {
  const expectedPath = absolute(expected, 'expected path');
  const actualPath = absolute(actual, 'actual path');
  const canonical = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const same = canonical(expectedPath) === canonical(actualPath);
  if (!same) {
    throw new LoopStateError('captured and loaded report paths differ', 'PATH_MISMATCH', {
      expected: expectedPath,
      actual: actualPath,
      same: false,
    });
  }
  return { expected: expectedPath, actual: actualPath, same: true };
}

function integerMatch(text, expression, fallback = 0) {
  const match = expression.exec(text);
  return match ? Number(match[1]) : fallback;
}

function parseIssues(review) {
  const issues = /\*\*Issues\*\*\s*:\s*[^\n]*?🔴\s*(\d+)[^\n]*?🟡\s*(\d+)[^\n]*?ℹ(?:️)?\s*(\d+)/u.exec(review);
  if (issues) return issues.slice(1).map(Number);
  const fallback = [
    /count_red\s*[:=]\s*(\d+)/iu.exec(review),
    /count_yellow\s*[:=]\s*(\d+)/iu.exec(review),
    /count_info\s*[:=]\s*(\d+)/iu.exec(review),
  ];
  return fallback.every(Boolean) ? fallback.map((match) => Number(match[1])) : null;
}

function parseRecurring(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const payload = parsed?.payload && !Array.isArray(parsed.payload) ? parsed.payload : parsed;
    return Array.isArray(payload?.findings) ? payload.findings : [];
  } catch {
    return [];
  }
}

function categoryFor(findings, file, line) {
  const target = `${file}:${line}`;
  for (const finding of findings) {
    if (!TAXONOMY.has(finding?.category) || !Array.isArray(finding.example_files)) continue;
    if (finding.example_files.some((entry) => entry === target)) return finding.category;
  }
  return 'untagged';
}

/**
 * Vestigial display/back-compat `findings_signature` set for `collectMetrics`.
 * Reuses the shared `extractFindings` parser (finding-identity.mjs) — the same
 * parser `record-round` uses — so a multi-range citation such as
 * `src/a.js:1-2, 83-100` resolves to the identical first-range start location
 * in both paths, instead of the old single-token matcher's bogus capture.
 * `repoRoot` is threaded straight into `extractFindings` so paths canonicalize
 * on the SAME basis as `record-round` (single source of truth): with a repo
 * root an absolute `/repo/src/a.js` and a `./src/a.js` both fold to `src/a.js`,
 * and without one the legacy relative-path signature is unchanged. Because
 * `extractFindings` yields case-PRESERVING display paths (no win32 lowercasing),
 * the signature reads byte-identically on win32 and posix; cross-round identity
 * folding lives in `matchFindings`, never here. Each entry buckets the line
 * into a 7-line window and tags it with the recurring-findings category; the
 * set is deterministically sorted.
 */
function signatures(review, recurringFindings, { repoRoot } = {}) {
  const result = new Set();
  for (const finding of extractFindings(review, { repoRoot })) {
    const bucket = Math.floor(finding.line / 7);
    const category = categoryFor(recurringFindings, finding.path, finding.line);
    result.add(`${finding.severity}:${finding.path}:${bucket}:${category}`);
  }
  return [...result].sort(utf8Compare);
}

function readOptional(filePath) {
  return filePath ? readFileSync(absolute(filePath, 'report path'), 'utf8') : '';
}

export function collectMetrics(options = {}) {
  const roundNumber = Number(options.roundNumber);
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new LoopStateError('round number must be a positive integer', 'INVALID_ROUND');
  }
  const reviewPath = absolute(options.reviewReport, 'review report');
  const responsePath = options.responseReport ? absolute(options.responseReport, 'response report') : '';
  const review = readFileSync(reviewPath, 'utf8');
  const response = readOptional(responsePath);
  const verdictMatch = /\*\*Verdict\*\*\s*:\s*(APPROVE|REQUEST_CHANGES|CONCERN)/iu.exec(review);
  if (!verdictMatch) throw new LoopStateError('review report has no valid Verdict', 'INVALID_REPORT');
  const issueCounts = parseIssues(review);
  if (!issueCounts) throw new LoopStateError('review report has no valid Issues summary', 'INVALID_REPORT');
  const [countRed, countYellow, countInfo] = issueCounts;
  const itemCounts = /\*\*Items\*\*\s*:\s*(?:수락|accepted?)\s*(\d+)[^\n]*?(?:반박|rejected?)\s*(\d+)[^\n]*?(?:보류|deferred?)\s*(\d+)/iu.exec(response);
  const executionMatch = /\*\*execution_path\*\*\s*:\s*(subagent|main_fallback|mixed|n\/a)/iu.exec(response);
  const haltedMatch = /\*\*halted\*\*\s*:\s*(true|false)/iu.exec(response);
  const implemented = integerMatch(response, /\*\*implemented_count\*\*\s*:\s*(\d+)/iu);
  const recurringPath = options.recurringFindings
    || join(dirname(dirname(reviewPath)), 'recurring-findings.json');
  return {
    round_number: roundNumber,
    round_review_report_path: reviewPath,
    response_report_path: responsePath || null,
    verdict: verdictMatch[1].toUpperCase(),
    count_red: countRed,
    count_yellow: countYellow,
    count_info: countInfo,
    accepted_count: itemCounts ? Number(itemCounts[1]) : 0,
    rejected_count: itemCounts ? Number(itemCounts[2]) : 0,
    deferred_count: itemCounts ? Number(itemCounts[3]) : 0,
    implemented_count: implemented,
    halted: haltedMatch ? haltedMatch[1].toLowerCase() === 'true' : false,
    execution_path: executionMatch ? executionMatch[1].toLowerCase() : 'n/a',
    findings_signature: signatures(review, parseRecurring(recurringPath), { repoRoot: options.repoRoot }),
  };
}

function splitItemBlocks(response) {
  const headerPattern = /^###\s+ITEM-\d+:[^\n]*$/gmu;
  const starts = [...response.matchAll(headerPattern)];
  const blocks = [];
  for (let index = 0; index < starts.length; index += 1) {
    const begin = starts[index].index;
    const end = index + 1 < starts.length ? starts[index + 1].index : response.length;
    blocks.push(response.slice(begin, end));
  }
  return blocks;
}

function firstLocationToken(blockText) {
  // Accept single-range and comma-separated multi-range backticked citations
  // (`path:1-2, 83-100`), anchoring on the FIRST range's start line. Kept
  // semantically aligned with finding-identity.mjs `BACKTICKED_LOCATION` so the
  // two parsers never disagree about what counts as a location.
  const match = /`([^`\r\n]+):(\d+)(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*`/u.exec(blockText);
  if (!match) return null;
  return { path: match[1], line: Number(match[2]) };
}

function actionReason(blockText) {
  const match = /-\s*\*\*Action\*\*\s*:\s*([^\n]*)/u.exec(blockText);
  return match ? match[1].trim() : '';
}

/**
 * Parse REJECT-decision ITEM blocks from a response report into
 * `{path, line, reason}` entries. An item without a backtick `path:line` (or
 * `path:line-line`, or comma-separated multi-range `path:1-2, 83-100` — start
 * line only) location token anywhere in its block is conservatively excluded
 * and counted in `skippedRejects` — session-only, advisory-only memory never
 * silently invents a location.
 *
 * The stored `path` is a case-PRESERVING display path (`caseFold: false`):
 * rejected items are rendered verbatim in the prior-context advisory and never
 * identity-matched, so they read identically on win32 and posix.
 */
function parseRejectedItems(response, { repoRoot } = {}) {
  if (!response) return { rejected: [], skippedRejects: 0 };
  const rejected = [];
  let skippedRejects = 0;
  for (const block of splitItemBlocks(response)) {
    if (!/-\s*\*\*Decision\*\*\s*:\s*REJECT/iu.test(block)) continue;
    const location = firstLocationToken(block);
    if (!location) {
      skippedRejects += 1;
      continue;
    }
    rejected.push({
      path: canonicalizeRepoPath(location.path, { repoRoot, caseFold: false }),
      line: location.line,
      reason: actionReason(block),
    });
  }
  return { rejected, skippedRejects };
}

function parseDurablePid(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[1-9][0-9]*$/u.test(trimmed)) return null;
  const pid = Number(trimmed);
  // Reject pid <= 1 (init/launchd) so a probe never signals the process group.
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

function nonEmptyEnv(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve a DURABLE session identity for residue ownership: the long-lived host
 * session process that drives this loop across every round and idle gap — NOT
 * this ephemeral `node loop-state.mjs` invocation, whose direct parent is the
 * transient per-command shell the tool spawns and which is already dead by the
 * time a sibling `cleanup-residue` inspects the residue.
 *
 * - Claude Code: `CLAUDE_PID` (=== `CMUX_CLAUDE_PID`) is the top-level `claude`
 *   process, alive across rounds/idle and gone when the session ends;
 *   `CLAUDE_CODE_SESSION_ID` is that session's UUID.
 * - Codex: `CODEX_COMPANION_SESSION_ID` is a session id only (no durable pid).
 *
 * Returns `{ pid, session_id }` (pid may be null for a session-id-only anchor)
 * or null when nothing durable is resolvable, so callers stay keep-biased.
 */
function durableSessionAnchor(env) {
  const durablePid = parseDurablePid(env.CLAUDE_PID ?? env.CMUX_CLAUDE_PID);
  const sessionId = nonEmptyEnv(env.CLAUDE_CODE_SESSION_ID) ?? nonEmptyEnv(env.CODEX_COMPANION_SESSION_ID);
  if (durablePid !== null) return { pid: durablePid, session_id: sessionId };
  if (sessionId !== null) return { pid: null, session_id: sessionId };
  return null;
}

/**
 * Stamp the round state with the DURABLE session owner resolved above, so
 * `cleanupResidue` (via mutation-protocol.mjs `classifyLiveness`) tells a
 * live-but-idle concurrent loop from crashed residue by probing a process that
 * is actually still alive between rounds. Never a mutation owner; gates only
 * tmp-residue removal.
 *
 * - Durable pid available (Claude Code): stamp pid + host + session_id.
 *   `process_start_ms` is a timeline-consistency anchor only — `classifyLiveness`
 *   cross-checks `start_ms` solely on a SELF probe (the default probe returns a
 *   start time only for the calling process), and the durable pid is by
 *   construction never this node child, so liveness rests on probing the durable
 *   pid's existence: live/uncertain/foreign/timeline-inconsistent → keep, and
 *   only a probed-departed pid past the stale window is deleted. A reused pid
 *   probes live → keep (fail-safe over-retention).
 * - Session-id only (e.g. Codex, no durable pid): stamp host + session_id with a
 *   null pid; `residueOwnerDisposition` keeps it unprobed (liveness unknowable).
 * - No durable identity: return null → the round state carries `owner: null`,
 *   never a transient pid → `classifyLiveness` = 'manual' → keep. Strictly no
 *   more aggressive than the age-only baseline this replaced.
 */
function buildOwnerStamp(env = process.env) {
  const anchor = durableSessionAnchor(env);
  if (!anchor) return null;
  return {
    host_hash: currentHostHash(),
    pid: anchor.pid === null ? null : String(anchor.pid),
    process_start_ms: anchor.pid === null ? null : String(processStartMs()),
    session_id: anchor.session_id,
    started_at: new Date().toISOString(),
  };
}

function uniqueReviewerIds(value, label) {
  if (!Array.isArray(value)
      || value.some((entry) => !isReviewerId(entry))
      || new Set(value).size !== value.length) {
    throw new LoopStateError(`${label} must be an array of unique reviewer ids`, 'INVALID_ROUTING_METADATA');
  }
  return [...value];
}

function responseMetrics(response) {
  const itemCounts = /\*\*Items\*\*\s*:\s*(?:수락|accepted?)\s*(\d+)[^\n]*?(?:반박|rejected?)\s*(\d+)[^\n]*?(?:보류|deferred?)\s*(\d+)/iu.exec(response);
  const execution = /\*\*execution_path\*\*\s*:\s*(subagent|main_fallback|mixed|n\/a)/iu.exec(response);
  const halted = /\*\*halted\*\*\s*:\s*(true|false)/iu.exec(response);
  return {
    accepted_count: itemCounts ? Number(itemCounts[1]) : 0,
    rejected_count: itemCounts ? Number(itemCounts[2]) : 0,
    deferred_count: itemCounts ? Number(itemCounts[3]) : 0,
    implemented_count: integerMatch(response, /\*\*implemented_count\*\*\s*:\s*(\d+)/iu),
    halted: halted ? halted[1].toLowerCase() === 'true' : false,
    execution_path: execution ? execution[1].toLowerCase() : 'n/a',
  };
}

function readRoutingMetadata(options) {
  if (options.routingMetadata !== undefined && options.routingMetadataFile !== undefined) {
    throw new LoopStateError(
      'routingMetadata and routingMetadataFile are mutually exclusive',
      'INVALID_ROUTING_METADATA',
    );
  }
  let metadata = options.routingMetadata;
  if (options.routingMetadataFile !== undefined) {
    try {
      metadata = JSON.parse(readFileSync(absolute(options.routingMetadataFile, 'routing metadata file'), 'utf8'));
    } catch (error) {
      throw new LoopStateError(
        `cannot read routing metadata: ${error.message}`,
        'INVALID_ROUTING_METADATA',
      );
    }
  }
  if (metadata === undefined || metadata === null) {
    return {
      artifact_phase: null,
      risk: null,
      routing_plan_digest: null,
      planned_reviewers: [],
      actual_reviewers: [],
      wave: 1,
      expansion: false,
      reviewer_calls_saved: 0,
      readiness: null,
      receipt_path: null,
      assignments: [],
    };
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || !ARTIFACT_PHASES.has(metadata.artifact_phase)
      || !RISK_VALUES.has(metadata.risk)
      || !SHA256_PATTERN.test(metadata.routing_plan_digest || '')) {
    throw new LoopStateError('routing metadata header is invalid', 'INVALID_ROUTING_METADATA');
  }
  const plannedReviewers = uniqueReviewerIds(metadata.planned_reviewers, 'planned_reviewers');
  const actualReviewers = uniqueReviewerIds(metadata.actual_reviewers, 'actual_reviewers');
  if (![1, 2].includes(metadata.wave)
      || typeof metadata.expansion !== 'boolean'
      || !Number.isInteger(metadata.reviewer_calls_saved)
      || metadata.reviewer_calls_saved < 0
      || (metadata.readiness !== null
        && metadata.readiness !== undefined
        && !READINESS_VALUES.has(metadata.readiness))
      || !Array.isArray(metadata.assignments)) {
    throw new LoopStateError('routing metadata fields are invalid', 'INVALID_ROUTING_METADATA');
  }
  const assignmentReviewers = new Set();
  const assignments = metadata.assignments.map((assignment) => {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)
        || !isReviewerId(assignment.reviewer_id)
        || !actualReviewers.includes(assignment.reviewer_id)
        || assignmentReviewers.has(assignment.reviewer_id)
        || !isAssignmentRole(assignment.assignment_role)
        || (assignment.model !== null
          && (typeof assignment.model !== 'string' || assignment.model.length === 0))
        || (assignment.effort !== null
          && (typeof assignment.effort !== 'string' || assignment.effort.length === 0))
        || ![1, 2].includes(assignment.wave)) {
      throw new LoopStateError('routing assignment is invalid', 'INVALID_ROUTING_METADATA');
    }
    assignmentReviewers.add(assignment.reviewer_id);
    return {
      reviewer_id: assignment.reviewer_id,
      assignment_role: assignment.assignment_role,
      model: assignment.model,
      effort: assignment.effort,
      wave: assignment.wave,
    };
  });
  return {
    artifact_phase: metadata.artifact_phase,
    risk: metadata.risk,
    routing_plan_digest: metadata.routing_plan_digest,
    planned_reviewers: plannedReviewers,
    actual_reviewers: actualReviewers,
    wave: metadata.wave,
    expansion: metadata.expansion,
    reviewer_calls_saved: metadata.reviewer_calls_saved,
    readiness: metadata.readiness ?? null,
    receipt_path: metadata.receipt_path ? absolute(metadata.receipt_path, 'readiness receipt') : null,
    assignments,
  };
}

export function resolveLoopRoundPolicy({
  artifactPhase = 'implementation',
  risk = 'low',
  max,
  maxExplicit = false,
  documentRoundLimit = 2,
  highRiskDocumentRoundLimit = 3,
} = {}) {
  if (!ARTIFACT_PHASES.has(artifactPhase) || !RISK_VALUES.has(risk)) {
    throw new LoopStateError('loop artifact phase or risk is invalid', 'INVALID_LOOP_POLICY');
  }
  const explicitMax = Number(max);
  if (maxExplicit && (!Number.isInteger(explicitMax) || explicitMax < 1)) {
    throw new LoopStateError('explicit loop max must be a positive integer', 'INVALID_LOOP_POLICY');
  }
  const configured = ['high', 'critical'].includes(risk)
    ? Number(highRiskDocumentRoundLimit)
    : Number(documentRoundLimit);
  const roundLimit = maxExplicit
    ? explicitMax
    : artifactPhase === 'document'
      ? configured
      : 5;
  if (!Number.isInteger(roundLimit) || roundLimit < 1) {
    throw new LoopStateError('loop round limit must be a positive integer', 'INVALID_LOOP_POLICY');
  }
  return {
    artifact_phase: artifactPhase,
    risk,
    round_limit: roundLimit,
    max_explicit: Boolean(maxExplicit),
  };
}

export function evaluateLoopTermination({
  roundNumber,
  roundLimit,
  artifactPhase,
  readiness = null,
} = {}) {
  const round = Number(roundNumber);
  const limit = Number(roundLimit);
  if (!Number.isInteger(round) || round < 1 || !Number.isInteger(limit) || limit < 1
      || !ARTIFACT_PHASES.has(artifactPhase)
      || (readiness !== null && !READINESS_VALUES.has(readiness))) {
    throw new LoopStateError('loop termination input is invalid', 'INVALID_LOOP_POLICY');
  }
  const stopReason = loopCapDecision({ round, limit, artifactPhase, readiness });
  if (stopReason) {
    return {
      should_stop: true,
      stop_reason: stopReason,
      start_another_review: false,
      run_respond: false,
    };
  }
  return {
    should_stop: false,
    stop_reason: null,
    start_another_review: true,
    run_respond: artifactPhase === 'implementation',
  };
}

/**
 * Record one round's finding-state snapshot from a canonical review report
 * (+ optional response report) into a loop-bound, schema-versioned JSON file.
 * `loopId` is minted with `randomUUID()` when omitted (round 1) and echoed
 * back alongside the absolute `state_file` so callers never need to know the
 * file naming convention. `baseCommit` is required (fail-closed).
 */
export function recordRound(options = {}) {
  if (options.decisionFile !== undefined) {
    const repo = options.repoRoot;
    const post = readControlFile(repo, options.postResponseTargetFile);
    const capturedFile = containedPath(repo, join(options.stateDir, `loop-target-${randomUUID()}.json`));
    atomicJson(capturedFile, post);
    const state = { ...buildSchema3Round({ ...options, postResponseTargetFile: capturedFile }), owner: buildOwnerStamp(options.env || process.env) };
    const file = containedPath(repo, join(options.stateDir, `loop-${state.loop_id}-round-${state.round_number}.state.json`));
    if (Buffer.byteLength(JSON.stringify(state)) > CONTROL_LIMIT) throw new Error('schema-3 state exceeds control byte limit');
    if (existsSync(file)) throw new Error('round state already exists');
    atomicJson(file, state);
    return { loop_id: state.loop_id, state_file: file };
  }
  const roundNumber = Number(options.roundNumber);
  if (!Number.isInteger(roundNumber) || roundNumber < 1) {
    throw new LoopStateError('round number must be a positive integer', 'INVALID_ROUND');
  }
  if (typeof options.baseCommit !== 'string' || options.baseCommit.length === 0) {
    throw new LoopStateError('base_commit is required', 'MISSING_BASE_COMMIT');
  }
  const reviewPath = absolute(options.reviewReport, 'review report');
  const review = readFileSync(reviewPath, 'utf8');
  const verdictMatch = /\*\*Verdict\*\*\s*:\s*(APPROVE|REQUEST_CHANGES|CONCERN)/iu.exec(review);
  if (!verdictMatch) throw new LoopStateError('review report has no valid Verdict', 'INVALID_REPORT');
  const issueCounts = parseIssues(review);
  if (!issueCounts) throw new LoopStateError('review report has no valid Issues summary', 'INVALID_REPORT');
  const [countRed, countYellow, countInfo] = issueCounts;

  const responsePath = options.responseReport ? absolute(options.responseReport, 'response report') : '';
  const response = readOptional(responsePath);
  const recurringPath = options.recurringFindings
    || join(dirname(dirname(reviewPath)), 'recurring-findings.json');
  const recurring = parseRecurring(recurringPath);

  const findings = extractFindings(review, { repoRoot: options.repoRoot }).map((finding) => ({
    ...finding,
    category: categoryFor(recurring, finding.path, finding.line),
  }));
  const { rejected, skippedRejects } = parseRejectedItems(response, { repoRoot: options.repoRoot });
  const routingMetadata = readRoutingMetadata(options);

  const loopId = options.loopId || randomUUID();
  const stateDir = absolute(options.stateDir, 'state directory');
  const stateFile = resolve(stateDir, `loop-${loopId}-round-${roundNumber}.state.json`);
  const state = {
    schema_version: ROUND_STATE_SCHEMA,
    source: 'report-parse',
    loop_id: loopId,
    round_number: roundNumber,
    base_commit: options.baseCommit,
    verdict: verdictMatch[1].toUpperCase(),
    counts: { critical: countRed, warning: countYellow, info: countInfo },
    // Persist the canonical report paths (additive, back-compat — older readers
    // ignore unknown fields) so the derived session doc can link each round's
    // review/response without re-deriving them; mirrors collectMetrics's naming.
    round_review_report_path: reviewPath,
    response_report_path: responsePath || null,
    findings,
    rejected,
    skipped_rejects: skippedRejects,
    ...routingMetadata,
    response_metrics: responseMetrics(response),
    owner: buildOwnerStamp(options.env || process.env),
  };
  atomicJson(stateFile, state);
  return { loop_id: loopId, state_file: stateFile };
}

export function readRoundState(stateFile) {
  const filePath = absolute(stateFile, 'state file');
  let parsed;
  try {
    parsed = readControlFile(dirname(filePath), filePath);
  } catch (error) {
    throw new LoopStateError(`cannot read round state: ${error.message}`, 'INVALID_STATE');
  }
  if (parsed?.schema_version === 3) return readSchema3Round(filePath);
  if (
    ![LEGACY_ROUND_STATE_SCHEMA, ROUND_STATE_SCHEMA].includes(parsed?.schema_version)
    || typeof parsed.loop_id !== 'string'
    || typeof parsed.base_commit !== 'string'
    || !Number.isInteger(parsed.round_number)
  ) {
    throw new LoopStateError('round state schema is invalid', 'INVALID_STATE');
  }
  return parsed;
}

function truncateUtf8(text, maxBytes, marker) {
  const bodyBuffer = Buffer.from(text, 'utf8');
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  let sliceEnd = Math.min(budget, bodyBuffer.length);
  // Never split a multi-byte UTF-8 sequence: back up to the previous
  // lead-byte boundary (a continuation byte has the high bits 10xxxxxx).
  while (sliceEnd > 0 && (bodyBuffer[sliceEnd] & 0xc0) === 0x80) sliceEnd -= 1;
  return `${bodyBuffer.subarray(0, sliceEnd).toString('utf8')}${marker}`;
}

/**
 * Render a loop-bound prior-round advisory context file: a `PRIOR-CONTEXT v1`
 * header carrying `loop_id`/`base_commit`/`round` (consumed by
 * build-reviewer-payload.mjs's ingest validation), an open-findings summary,
 * and a REJECT list explicitly marked re-verify/never-suppress. Truncates at
 * `maxBytes` with a visible marker rather than silently growing unbounded.
 */
export function renderPriorContext(options = {}) {
  const state = readRoundState(options.stateFile);
  const maxBytes = options.maxBytes ? Number(options.maxBytes) : PRIOR_CONTEXT_MAX_BYTES_DEFAULT;

  const header = `<!-- PRIOR-CONTEXT v1 loop_id=${state.loop_id} base_commit=${state.base_commit} round=${state.round_number} -->`;
  const lines = [header, '', `# Prior round ${state.round_number} context (loop ${state.loop_id})`, ''];

  const findings = Array.isArray(state.findings) ? state.findings : [];
  lines.push(`## Open findings from round ${state.round_number} (${findings.length})`);
  if (findings.length === 0) {
    lines.push('- (none)');
  } else {
    for (const finding of findings) {
      lines.push(findingBullet(finding));
    }
  }
  lines.push('');

  const rejected = Array.isArray(state.rejected) ? state.rejected : [];
  lines.push(`## Previously rejected — ${PRIOR_CONTEXT_REJECT_NOTICE}`);
  if (rejected.length === 0) {
    lines.push('- (none)');
  } else {
    for (const entry of rejected) {
      lines.push(`- \`${entry.path}:${entry.line}\` — ${entry.reason || '(no reason recorded)'}`);
    }
  }
  lines.push('');

  const body = lines.join('\n');
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  const truncated = bodyBytes > maxBytes;
  const finalText = truncated
    ? truncateUtf8(body, maxBytes, '\n\n<!-- TRUNCATED: prior-context exceeded maxBytes -->\n')
    : body;

  const outputFile = atomicText(options.output, finalText, 'output');
  return {
    output_file: outputFile,
    loop_id: state.loop_id,
    round_number: state.round_number,
    truncated,
  };
}

/**
 * Pure adjacent-round convergence summary over two findings arrays. Reuses
 * finding-identity's `matchFindings` (never reinvents identity) and returns the
 * code-owned `stalled`/`progressed`/`added_count` judgment plus the raw
 * `resolved` list. `compareRounds` strips `resolved` to keep its wire shape
 * byte-identical; `renderSessionDoc` consumes the judgment fields for the
 * per-round Progress column and derives its CUMULATIVE resolved rollup from the
 * same `matchFindings` SSOT (see `cumulativeResolved`) rather than an adjacent
 * pair — so this stays the single source of truth for the "half of the larger
 * set repeats" rule without any parallel identity logic.
 */
export function classifyRoundProgress(summary = {}) {
  if (Number(summary.added_count) > 0) return 'regression';
  if (Number(summary.resolved_count) > 0) return 'confirmation';
  if (summary.stalled === true) return 'stalled';
  return 'changed';
}

function summarizeAdjacent(previousFindings, currentFindings, { platform } = {}) {
  const previous = Array.isArray(previousFindings) ? previousFindings : [];
  const current = Array.isArray(currentFindings) ? currentFindings : [];
  // Findings carry case-preserving display paths; matchFindings re-applies the
  // win32-only case-insensitive identity fold. `platform` is undefined in
  // production, so matchFindings falls back to `process.platform`.
  const { repeated, resolved, added } = matchFindings(previous, current, { platform });
  const largerSetSize = Math.max(previous.length, current.length);
  const repeatRatio = largerSetSize > 0 ? repeated.length / largerSetSize : 0;
  const summary = {
    repeated_count: repeated.length,
    resolved_count: resolved.length,
    added_count: added.length,
    larger_set_size: largerSetSize,
    repeat_ratio: repeatRatio,
    stalled: largerSetSize > 0 && repeatRatio >= STALLED_REPEAT_RATIO_THRESHOLD,
    progressed: resolved.length > 0,
    resolved,
  };
  return { ...summary, progress: classifyRoundProgress(summary) };
}

/**
 * Deterministic, code-owned convergence judgment between two adjacent round
 * state files (SKILL §5 condition 3's former natural-language "half of the
 * larger set repeats" rule, now this function's `stalled` output). Rejects a
 * `loop_id`/`schema_version`/`base_commit` mismatch as `STALE_STATE` rather
 * than comparing unrelated loops. Only critical/warning findings ever appear
 * in round state (extractFindings never captures info-level items), so no
 * extra filtering is needed before matchFindings.
 */
export function compareRounds(options = {}) {
  const previous = readRoundState(options.previous);
  const current = readRoundState(options.current);
  if (
    previous.loop_id !== current.loop_id
    || previous.base_commit !== current.base_commit
  ) {
    throw new LoopStateError('previous/current round state is from a different loop or base', 'STALE_STATE', {
      previous_loop_id: previous.loop_id,
      current_loop_id: current.loop_id,
      previous_base_commit: previous.base_commit,
      current_base_commit: current.base_commit,
    });
  }
  if (previous.schema_version === 3 || current.schema_version === 3) {
    if (previous.schema_version !== 3 || current.schema_version !== 3 || current.round_number !== previous.round_number + 1
        || current.previous_state_file !== resolve(options.previous)) throw new Error('schema-3 comparison requires adjacent bound state');
    return { ...compareFindingStates(previous.observations, current.observations), verified_closed_count: current.verified_closed_ids.length };
  }
  // Drop the raw `resolved` list so the returned wire shape is byte-identical to
  // the pre-refactor output.
  const { resolved, ...summary } = summarizeAdjacent(previous.findings, current.findings, { platform: options.platform });
  return summary;
}

function readSessionRounds(tmpDir, loopId) {
  const root = absolute(tmpDir, 'tmp directory');
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rounds = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = RESIDUE_STATE_PATTERN.exec(entry.name);
    // The greedy `(.+)` capture folds the whole id before `-round-<N>`, so a
    // hyphenated loop id round-trips exactly. Only THIS loop's state is read;
    // sibling loops sharing the tmp dir are ignored.
    if (!match || match[1] !== loopId) continue;
    const state = readRoundState(resolve(root, entry.name));
    if (state.loop_id !== loopId) continue;
    rounds.push(state);
  }
  rounds.sort((left, right) => left.round_number - right.round_number);
  return rounds;
}

function findingBullet(finding) {
  if (finding.finding_id) return `- [${finding.severity}] ${finding.finding_id} — ${finding.claim} (${finding.locations.map(l => `\`${l.path}:${l.line}\``).join(', ') || 'location indeterminate'})`;
  return `- [${finding.severity}] \`${finding.path}:${finding.line}\` (${finding.category}) — ${finding.title_slug}`;
}

/**
 * Cumulative resolved rollup across the WHOLE session: findings that appeared in
 * some round before the latest and are no longer open in the latest round. The
 * prior rounds fold into an identity-deduped pool via `matchFindings` (the same
 * identity SSOT `summarizeAdjacent` wraps) — each round's `added` extends the
 * pool, and each round's `repeated` pair REPLACES the pool's prior representative
 * with the current round's one so the representative tracks cumulative line
 * drift. That forward-carry is load-bearing: `matchFindings`' ±tolerance window
 * is NON-transitive, so a finding drifting within tolerance each round but beyond
 * it overall (e.g. line 10→16→22) would, if pinned to its first-seen line (10),
 * no longer match the latest open line (22; distance 12 > tolerance) and be
 * emitted as resolved while it is still open — double-listed. Chaining through
 * the intermediate positions instead keeps a still-open drifting finding out of
 * the resolved set, while a finding genuinely resolved between two early rounds
 * still stays listed across later rounds and one re-added and open again is
 * correctly excluded. Determinism holds: the pool preserves its
 * (round-then-finding) order because `.map` replaces in place and `added` is
 * appended in current-round order, and `matchFindings` returns `resolved` in that
 * same pool order.
 */
function cumulativeResolved(rounds, openFindings) {
  let priorUnion = [];
  for (let index = 0; index < rounds.length - 1; index += 1) {
    const { repeated, added } = matchFindings(priorUnion, rounds[index].findings ?? []);
    // matchFindings is 1:1 (each prior entry matches at most one current
    // finding), and `previous[p]` in each pair is the exact object reference held
    // in priorUnion — so an identity-keyed Map cleanly forward-carries the latest
    // representative without disturbing the pool's order.
    const forwardCarry = new Map(repeated.map(([prior, current]) => [prior, current]));
    priorUnion = priorUnion.map((entry) => forwardCarry.get(entry) ?? entry).concat(added);
  }
  return matchFindings(priorUnion, openFindings).resolved;
}

/**
 * Resolve the optional, explicit final-summary input for the post-stop render
 * pass (SKILL §5/§6). Accepts either a parsed object (`options.finalSummary`,
 * for direct callers/tests) or a JSON file path (`options.finalSummaryFile`, the
 * CLI form); returns null when neither is given so the default render stays
 * byte-identical. All inputs are explicit — the function reads nothing implicit.
 */
function readFinalSummary(options) {
  let summary;
  if (options.finalSummary !== undefined && options.finalSummary !== null) {
    summary = options.finalSummary;
  } else if (options.finalSummaryFile !== undefined) {
    const summaryPath = absolute(options.finalSummaryFile, 'final summary file');
    try {
      summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    } catch (error) {
      throw new LoopStateError(`cannot read final summary: ${error.message}`, 'INVALID_FINAL_SUMMARY');
    }
  } else {
    return null;
  }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new LoopStateError('final summary must be a JSON object', 'INVALID_FINAL_SUMMARY');
  }
  return summary;
}

/**
 * Render the closing `## Final summary` section from an explicit final-summary
 * object: the stop reason plus the fields the standalone loop-summary used to
 * carry (rounds saved, implemented total, remaining human/external work). Only
 * present fields render, so the caller decides what the durable doc retains.
 */
function renderFinalSummaryLines(summary) {
  const out = ['', '## Final summary', ''];
  const stopReason = typeof summary.stop_reason === 'string' && summary.stop_reason.length > 0
    ? summary.stop_reason
    : '(unspecified)';
  out.push(`- **Stop reason**: ${stopReason}`);
  if (summary.rounds_saved !== undefined && summary.rounds_saved !== null) {
    out.push(`- **Rounds saved**: ${Number(summary.rounds_saved)} (legacy advisory; not measured savings)`);
  }
  if (summary.reviewer_calls_saved !== undefined && summary.reviewer_calls_saved !== null) {
    out.push(`- **Reviewer calls saved**: ${Number(summary.reviewer_calls_saved)} (legacy advisory; not measured savings)`);
  }
  if (summary.implemented_total !== undefined && summary.implemented_total !== null) {
    out.push(`- **Total implemented**: ${Number(summary.implemented_total)}`);
  }
  if (typeof summary.readiness === 'string' && summary.readiness.length > 0) {
    out.push(`- **Readiness**: ${summary.readiness}`);
  }
  if (typeof summary.completion_status === 'string') out.push(`- **Completion status**: ${summary.completion_status}`);
  if (typeof summary.final_tree_verified === 'boolean') out.push(`- **Final tree verified**: ${summary.final_tree_verified}`);
  if (typeof summary.reviewed_target_digest === 'string') out.push(`- **Verdict reviewed target**: ${summary.reviewed_target_digest}`);
  if (typeof summary.current_target_digest === 'string') out.push(`- **Current target**: ${summary.current_target_digest}`);
  if (typeof summary.receipt_path === 'string' && summary.receipt_path.length > 0) {
    out.push(`- **Readiness receipt**: ${summary.receipt_path}`);
  }
  const remaining = Array.isArray(summary.remaining_work)
    ? summary.remaining_work.filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  if (remaining.length === 0) {
    out.push('- **Remaining work**: (none)');
  } else {
    out.push('- **Remaining work**:');
    for (const item of remaining) out.push(`  - ${item}`);
  }
  return out;
}

/**
 * Render one derived, in-place consolidated review document for a whole loop
 * session, keyed by `loop_id`. Pure and deterministic: the SAME sorted per-round
 * `.state.json` inputs (and the same optional final-summary input) always yield
 * a byte-identical body (no timestamps, no randomness), written atomically. It
 * reuses `summarizeAdjacent` for the per-round progress column and folds the
 * per-round finding sets (identity via `matchFindings`) into a CUMULATIVE
 * open-vs-resolved rollup, so a finding resolved in an early round stays listed
 * after later rounds. It never touches the per-round canonical `*-review.md`
 * files — the session doc is an additive view, not a replacement
 * (resolveRoundReport's delta invariant holds). Report references render as real
 * Markdown links relative to the DOCUMENT's own directory (`reportsDir`, where
 * the doc is written) and forward-slashed, so they stay navigable and portable.
 * When a final-summary input is supplied — only after the loop's stop is decided
 * (SKILL §5/§6) — a closing `## Final summary` section is appended; without it
 * the body is byte-identical to the per-round render.
 */
export function renderSessionDoc(options = {}) {
  const loopId = options.loopId;
  if (typeof loopId !== 'string' || loopId.length === 0) {
    throw new LoopStateError('loop id is required', 'INVALID_ARGUMENT');
  }
  const tmpDir = absolute(options.tmpDir, 'tmp directory');
  const reportsDir = absolute(options.reportsDir, 'reports directory');
  const finalSummary = readFinalSummary(options);
  const rounds = readSessionRounds(tmpDir, loopId);
  if (rounds.length === 0) {
    throw new LoopStateError(`no round state for loop ${loopId}`, 'NO_ROUNDS', { loop_id: loopId });
  }

  // References resolve relative to the DOCUMENT's own directory: the session doc
  // is always written into reportsDir, so a canonical round report resolves by
  // bare basename and a response one directory up (../responses/…). Rendering
  // them as real Markdown links keeps them navigable, not just readable.
  const link = (target) => {
    if (typeof target !== 'string' || target.length === 0) return null;
    const rel = relative(reportsDir, target).replace(/\\/gu, '/');
    return rel.length === 0 ? target.replace(/\\/gu, '/') : rel;
  };
  const reportLink = (target) => {
    const rel = link(target);
    return rel ? `[${rel}](${rel})` : '(none)';
  };

  const latest = rounds[rounds.length - 1];
  const schema3 = latest.schema_version === 3;
  const openFindings = Array.isArray(latest.findings) ? latest.findings : [];

  const lines = [
    `<!-- SESSION-DOC v${SESSION_DOC_SCHEMA} loop_id=${loopId} rounds=${rounds.length} -->`,
    '',
    `# Deep Review session — loop ${loopId}`,
    '',
    `- **Latest verdict**: ${latest.verdict} (round ${latest.round_number})`,
    `- **Rounds executed**: ${rounds.length}`,
    `- **Base commit**: ${latest.base_commit}`,
    '',
    '## Round history',
    '',
    '| Round | Verdict | 🔴 | 🟡 | ℹ️ | Progress |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (let index = 0; index < rounds.length; index += 1) {
    const round = rounds[index];
    const counts = round.counts || {};
    let progress = '—';
    if (index > 0) {
      const summary = schema3 ? compareFindingStates(rounds[index - 1].observations, round.observations)
        : summarizeAdjacent(rounds[index - 1].findings, round.findings);
      progress = summary.progress === 'regression'
        ? `regression (+${summary.added_count})`
        : summary.progress;
    }
    lines.push(`| ${round.round_number} | ${round.verdict} | ${counts.critical ?? 0} | ${counts.warning ?? 0} | ${counts.info ?? 0} | ${progress} |`);
  }
  lines.push('');
  if (schema3) {
    lines.push('## Observed operations', '', `- **Round limit**: ${latest.round_limit}`,
      `- **Unused round capacity**: ${Math.max(0, latest.round_limit - rounds.length)}`);
    for (const key of ['planned_reviewer_calls', 'executed_reviewer_calls', 'admitted_reviewer_calls', 'not_run_reviewer_calls'])
      lines.push(`- **${key}**: ${rounds.some(row => row.accounting[key] === null) ? 'unknown' : rounds.reduce((sum, row) => sum + row.accounting[key], 0)}`);
    lines.push('- Usage not exposed by an adapter remains unknown; unused capacity is not measured savings.', '');
  }

  const adaptiveRounds = rounds.filter((round) => round.schema_version === ROUND_STATE_SCHEMA
    && round.artifact_phase !== null);
  if (adaptiveRounds.length > 0) {
    lines.push('## Adaptive routing', '');
    lines.push('| Round | Phase / risk | Assignments | Wave | Expansion | Calls saved | Readiness | Receipt |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const round of adaptiveRounds) {
      const assignments = round.assignments.length === 0
        ? '(none)'
        : round.assignments.map((assignment) => (
          `${assignment.reviewer_id} (${assignment.assignment_role}; `
          + `${assignment.model ?? 'provider-default'}/${assignment.effort ?? 'provider-default'}; wave ${assignment.wave})`
        )).join('<br>');
      const receipt = round.receipt_path ? reportLink(round.receipt_path) : '(none)';
      lines.push(
        `| ${round.round_number} | ${round.artifact_phase} / ${round.risk} `
        + `| ${assignments} | ${round.wave} | ${round.expansion ? 'yes' : 'no'} `
        + `| ${round.reviewer_calls_saved} | ${round.readiness ?? '(none)'} | ${receipt} |`,
      );
    }
    lines.push('');
  }

  lines.push(`## Open findings (round ${latest.round_number}) — ${openFindings.length}`);
  if (openFindings.length === 0) lines.push('- (none)');
  else for (const finding of openFindings) lines.push(findingBullet(finding));
  lines.push('');

  const closedIds = schema3 ? new Set(rounds.flatMap(r => r.verified_closed_ids)) : null;
  const resolved = schema3 ? [...new Map(rounds.flatMap(r => r.observations.findings)
    .filter(f => closedIds.has(f.finding_id) && !openFindings.some(o => o.finding_id === f.finding_id)).map(f => [f.finding_id, f])).values()]
    : cumulativeResolved(rounds, openFindings);
  lines.push(`## ${schema3 ? 'Verified closed' : 'Not re-observed (legacy advisory; not verified resolved)'} (cumulative) — ${resolved.length}`);
  if (resolved.length === 0) lines.push('- (none)');
  else for (const finding of resolved) lines.push(findingBullet(finding));
  lines.push('');
  if (schema3) {
    const missing = openFindings.filter(f => !latest.observations.findings.some(current => current.finding_id === f.finding_id));
    lines.push(`## Not re-observed; still pending — ${missing.length}`, ...missing.map(findingBullet), '');
  }

  lines.push('## Round reports');
  for (const round of rounds) {
    const reviewText = reportLink(round.round_review_report_path);
    const responseText = reportLink(round.response_report_path);
    lines.push(`- Round ${round.round_number} — review: ${reviewText} · response: ${responseText}`);
  }

  if (finalSummary) lines.push(...renderFinalSummaryLines(schema3 ? { ...finalSummary, rounds_saved: undefined, reviewer_calls_saved: undefined } : finalSummary));

  const outputFile = atomicText(options.output, `${lines.join('\n')}\n`, 'output');
  return { output_file: outputFile, loop_id: loopId, rounds: rounds.length };
}

/**
 * Read a residue state file's liveness owner. Returns null when the file is
 * unreadable/torn, is not this loop's state, or predates owner stamping (legacy
 * residue). A null owner classifies as `manual` — i.e. keep — so ownership that
 * cannot be established always fails toward NOT deleting.
 */
function readResidueOwner(filePath, loopId) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed && parsed.loop_id === loopId
        && parsed.owner && typeof parsed.owner === 'object' && !Array.isArray(parsed.owner)) {
      return parsed.owner;
    }
  } catch {
    // Unreadable residue: ownership is unknown → keep.
  }
  return null;
}

/**
 * Per-owner disposition mirroring mutation-protocol.mjs
 * `sessionRecoveryDisposition`: liveness first, age only as a secondary gate
 * once death is proven. Any owner short of provably-departed (live, uncertain,
 * foreign, timeline-inconsistent, or absent) is kept.
 */
function residueOwnerDisposition(owner, { now, processProbe, staleMs }) {
  // A durable session id with no resolvable pid (e.g. Codex) can never be
  // probed for liveness → keep unprobed. Never delete on an unprobeable owner.
  if (owner && owner.pid == null) return { action: 'keep', reason: 'session-id-only' };
  const liveness = classifyLiveness(owner, { now, processProbe });
  if (liveness !== 'departed') return { action: 'keep', reason: liveness };
  const startedAtMs = owner && typeof owner.started_at === 'string'
    ? Date.parse(owner.started_at)
    : NaN;
  const age = now - startedAtMs;
  if (!Number.isFinite(age) || age < staleMs) return { action: 'keep', reason: 'departed-fresh' };
  return { action: 'delete', reason: 'departed-stale' };
}

function decideLoopResidue(group, context) {
  // A loop with no state file (e.g. an orphan prior.md) has no stamped owner to
  // check → ownership unknowable → keep.
  if (group.states.length === 0) return { action: 'keep', reason: 'no-owner' };
  // Conservative grouping: one round that still looks live vetoes deleting the
  // whole loop's residue.
  for (const state of group.states) {
    const disposition = residueOwnerDisposition(state.owner, context);
    if (disposition.action !== 'delete') return { action: 'keep', reason: disposition.reason };
  }
  return { action: 'delete', reason: 'departed-stale' };
}

/**
 * Ownership/liveness-based cleanup of `.deep-review/tmp` loop residue
 * (`loop-<id>-round-*.state.json` + matching `.prior.md`). Replaces the former
 * age-only staleness heuristic, which could delete a live-but-idle concurrent
 * loop's state. A loop's files are removed only when EVERY recorded round's
 * stamped owner is provably departed AND its most-recent activity predates the
 * staleness grace window; otherwise the whole loop is kept. Mirrors the
 * owner-token + liveness model in mutation-protocol.mjs and stays pure Node
 * (no shell-only helper). Within a deletion group the advisory `.prior.md`
 * file(s) are removed FIRST and the state file(s) only after every advisory
 * removal succeeds, so a mid-group removal failure leaves the state file intact
 * and the loop stays retryable next round — never orphaning a `.prior.md` whose
 * state owner was already reaped. `processProbe`/`now`/`removeFile` are
 * injectable for tests.
 */
export function cleanupResidue(options = {}) {
  const tmpDir = absolute(options.tmpDir, 'tmp directory');
  const now = options.now === undefined ? Date.now() : Number(options.now);
  const staleMs = options.staleMs === undefined
    ? RESIDUE_STALE_MS_DEFAULT
    : Number(options.staleMs);
  if (!Number.isFinite(now) || !Number.isFinite(staleMs) || staleMs < 0) {
    throw new LoopStateError('cleanup time thresholds are invalid', 'INVALID_ARGUMENT');
  }
  const removeFile = typeof options.removeFile === 'function'
    ? options.removeFile
    : (file) => rmSync(file, { force: true });
  let entries;
  try {
    entries = readdirSync(tmpDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { scanned: 0, deleted: [], kept: [], errors: [] };
    throw error;
  }

  const loops = new Map();
  const loopFor = (loopId) => {
    let group = loops.get(loopId);
    if (!group) {
      group = { states: [], priors: [] };
      loops.set(loopId, group);
    }
    return group;
  };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stateMatch = RESIDUE_STATE_PATTERN.exec(entry.name);
    if (stateMatch) {
      const filePath = resolve(tmpDir, entry.name);
      const group = loopFor(stateMatch[1]);
      group.states.push({ path: filePath, owner: readResidueOwner(filePath, stateMatch[1]) });
      continue;
    }
    const priorMatch = RESIDUE_PRIOR_PATTERN.exec(entry.name);
    if (priorMatch) loopFor(priorMatch[1]).priors.push(resolve(tmpDir, entry.name));
  }

  const context = { now, processProbe: options.processProbe, staleMs };
  const deleted = [];
  const kept = [];
  const errors = [];
  // Remove one residue file, recording (never throwing) a failure. A per-file
  // removal failure (e.g. EPERM/EBUSY on Windows; force already swallows ENOENT)
  // must not abort the whole scan or drop the JSON summary.
  const tryRemove = (file) => {
    try {
      removeFile(file);
      deleted.push(file);
      return true;
    } catch (error) {
      errors.push({
        path: file,
        code: error?.code || 'RESIDUE_RM_FAILED',
        message: error?.message || String(error),
      });
      return false;
    }
  };
  for (const group of loops.values()) {
    const statePaths = group.states.map((state) => state.path);
    const decision = decideLoopResidue(group, context);
    if (decision.action !== 'delete') {
      for (const file of [...group.priors, ...statePaths]) kept.push({ path: file, reason: decision.reason });
      continue;
    }
    // Advisory (.prior.md) first; state file(s) only once every advisory
    // removal in this group succeeds. If any advisory removal fails, preserve
    // the state file(s) so the next cleanup re-establishes ownership against the
    // surviving state and retries — instead of orphaning a `.prior.md` whose
    // state owner was already reaped (which the no-owner branch keeps forever).
    let advisoryFailed = false;
    for (const file of group.priors) {
      if (!tryRemove(file)) advisoryFailed = true;
    }
    if (advisoryFailed) {
      for (const file of statePaths) kept.push({ path: file, reason: 'retry-pending' });
      continue;
    }
    for (const file of statePaths) tryRemove(file);
  }
  deleted.sort(utf8Compare);
  kept.sort((left, right) => utf8Compare(left.path, right.path));
  errors.sort((left, right) => utf8Compare(left.path, right.path));
  return { scanned: deleted.length + kept.length + errors.length, deleted, kept, errors };
}

function parseFlags(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new LoopStateError(`unknown or incomplete argument: ${flag}`, 'INVALID_ARGUMENT');
    }
    if (Object.hasOwn(values, flag)) throw new LoopStateError(`duplicate argument: ${flag}`, 'INVALID_ARGUMENT');
    values[flag] = value;
    index += 1;
  }
  return values;
}

function commandOptions(command, flags) {
  const known = {
    'snapshot-reports': new Map([['--reports-dir', 'reportsDir'], ['--output', 'output']]),
    'resolve-round-report': new Map([['--reports-dir', 'reportsDir'], ['--snapshot-file', 'snapshotFile']]),
    'assert-same-path': new Map([['--expected', 'expected'], ['--actual', 'actual']]),
    'collect-metrics': new Map([
      ['--round-number', 'roundNumber'],
      ['--review-report', 'reviewReport'],
      ['--response-report', 'responseReport'],
      ['--recurring-findings', 'recurringFindings'],
      ['--repo-root', 'repoRoot'],
    ]),
    'record-round': new Map([
      ['--decision-file', 'decisionFile'], ['--previous-state', 'previousState'],
      ['--round-limit', 'roundLimit'], ['--round-limit-override-file', 'roundLimitOverrideFile'],
      ['--post-response-target-file', 'postResponseTargetFile'], ['--response-evidence-file', 'responseEvidenceFile'],
      ['--operation-receipts-file', 'operationReceiptsFile'],
      ['--round-number', 'roundNumber'],
      ['--review-report', 'reviewReport'],
      ['--response-report', 'responseReport'],
      ['--loop-id', 'loopId'],
      ['--base-commit', 'baseCommit'],
      ['--state-dir', 'stateDir'],
      ['--repo-root', 'repoRoot'],
      ['--recurring-findings', 'recurringFindings'],
      ['--routing-metadata-file', 'routingMetadataFile'],
    ]),
    'decide-round': new Map([
      ['--decision-file', 'decisionFile'], ['--previous-state', 'previousState'], ['--state-file', 'stateFile'],
      ['--round-number', 'roundNumber'], ['--round-limit', 'roundLimit'], ['--round-limit-override-file', 'roundLimitOverrideFile'],
      ['--current-target-file', 'currentTargetFile'], ['--phase', 'phase'],
      ['--operation-receipts-file', 'operationReceiptsFile'],
      ['--user-stop', 'userStop'], ['--defer-stop', 'deferStop'], ['--halted', 'halted'], ['--stalled', 'stalled'], ['--operational-failure', 'operationalFailure'],
    ]),
    'decide-operational-stop': new Map([['--operations-file', 'operationsFile'], ['--current-target-file', 'currentTargetFile'],
      ['--previous-state', 'previousState'], ['--decision-file', 'decisionFile'], ['--round-limit', 'roundLimit']]),
    'build-response-evidence': new Map([['--repo-root', 'repo'], ['--input', 'input']]),
    'adaptive-context': new Map([['--state-file', 'stateFile'], ['--current-target-file', 'currentTargetFile']]),
    'render-prior-context': new Map([
      ['--state-file', 'stateFile'],
      ['--output', 'output'],
      ['--max-bytes', 'maxBytes'],
    ]),
    'compare-rounds': new Map([
      ['--previous', 'previous'],
      ['--current', 'current'],
    ]),
    'render-session-doc': new Map([
      ['--loop-id', 'loopId'],
      ['--tmp-dir', 'tmpDir'],
      ['--reports-dir', 'reportsDir'],
      ['--output', 'output'],
      ['--final-summary-file', 'finalSummaryFile'],
    ]),
    'cleanup-residue': new Map([
      ['--tmp-dir', 'tmpDir'],
      ['--stale-ms', 'staleMs'],
    ]),
  }[command];
  if (!known) throw new LoopStateError(`unknown command: ${command}`, 'INVALID_COMMAND');
  const options = {};
  for (const [flag, value] of Object.entries(flags)) {
    const key = known.get(flag);
    if (!key) throw new LoopStateError(`unknown argument for ${command}: ${flag}`, 'INVALID_ARGUMENT');
    options[key] = value;
    if (['userStop', 'deferStop', 'halted', 'stalled', 'operationalFailure'].includes(key)) {
      if (!['true', 'false'].includes(value)) throw new Error(`${flag} requires true or false`);
      options[key] = value === 'true';
    }
  }
  return options;
}

export function runLoopStateCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const options = commandOptions(command, parseFlags(rest));
  if (command === 'snapshot-reports') return snapshotReports(options);
  if (command === 'resolve-round-report') return resolveRoundReport(options);
  if (command === 'assert-same-path') return assertSamePath(options);
  if (command === 'record-round') return recordRound(options);
  if (command === 'decide-round') return decideRound(options);
  if (command === 'decide-operational-stop') return decideOperationalStop(options);
  if (command === 'adaptive-context') return adaptiveCarrier(options);
  if (command === 'build-response-evidence') return buildResponseEvidence({ ...readControlFile(options.repo, options.input), repo: options.repo });
  if (command === 'render-prior-context') return renderPriorContext(options);
  if (command === 'compare-rounds') return compareRounds(options);
  if (command === 'render-session-doc') return renderSessionDoc(options);
  if (command === 'cleanup-residue') return cleanupResidue(options);
  return collectMetrics(options);
}

function serializeError(error) {
  return {
    code: error?.code || 'LOOP_STATE_ERROR',
    message: error?.message || String(error),
    ...(error?.details || {}),
  };
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  Promise.resolve().then(() => runLoopStateCli()).then(result => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  }).catch(error => {
    const detail = serializeError(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: detail, ...error?.details })}\n`);
    process.exitCode = 2;
  });
}
