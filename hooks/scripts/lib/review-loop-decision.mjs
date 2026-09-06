import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { verifyReviewDecisionSync, verifyReviewDecisionHistorySync, verifyReviewOperations } from '../review-evidence.mjs';
import { verifyPhase6History } from '../phase6-protocol.mjs';
import { compareFindingStates } from './finding-identity.mjs';
import { captureReviewTarget, sameReviewTarget, evidenceHash, readControlFile, readBoundedFile, containedPath } from './review-target-snapshot.mjs';

const progressAuthority = new WeakSet();
const same = (a, b) => evidenceHash(a) === evidenceHash(b);
const positive = (value, label) => {
  const number = typeof value === 'string' && /^[1-9][0-9]*$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`invalid ${label}`);
  return number;
};
const bounded = file => readControlFile(dirname(resolve(file)), resolve(file));
function targetFile(file, repo) {
  const value = repo ? readControlFile(repo, file) : bounded(file);
  if (!sameReviewTarget(value, value) || (repo && value.scope.repo_root !== repo)) throw new Error('invalid current target snapshot');
  return value;
}
function historyDecision(repo, file) {
  const history = verifyReviewDecisionHistorySync({ repo, decisionFile: file });
  const decision = readControlFile(repo, file);
  if (decision.decision_sha256 !== history.decision_sha256) throw new Error('decision changed during history read');
  return { history, decision };
}
function lineage(previous, { repo, loopId, base, round, limit, override }) {
  if (!previous) {
    if (round !== 1) throw new Error('first round must be round 1');
    if (override) throw new Error('round limit override requires prior state');
    return;
  }
  if (previous.schema_version !== 3 || previous.repo_root !== repo || previous.loop_id !== loopId
      || previous.base_commit !== base || previous.round_number + 1 !== round)
    throw new Error('previous state must have the same loop/base and adjacent round');
  if (previous.round_limit !== limit) {
    if (!override || override.source !== 'user' || typeof override.reason !== 'string' || !override.reason.trim()
        || override.prior_limit !== previous.round_limit || override.new_limit !== limit
        || Object.keys(override).some(k => !['source', 'reason', 'prior_limit', 'new_limit'].includes(k)))
      throw new Error('round limit changed without a newly validated user override');
  } else if (override) throw new Error('redundant round limit override');
}
function pendingLedger(previous, history) {
  const observations = history.material_findings;
  compareFindingStates(observations, observations); // Task 1 owns typed validation.
  const prior = previous?.pending_findings ?? [];
  if (history.decision_mode === 'artifact-gate-v1') return { pending: observations.findings, closed: [] };
  const confirmation = history.confirmation;
  if (confirmation && (!previous || !same(confirmation.items.map(x => x.finding_id).sort(), prior.map(x => x.finding_id).sort())))
    throw new Error('confirmation must cover the exact prior pending ledger');
  const closed = observations.status === 'complete' && previous?.observations.status === 'complete'
    ? (confirmation?.items ?? []).filter(row => row.status === 'verified_closed').map(row => row.finding_id) : [];
  const currentIds = new Set(observations.findings.map(row => row.finding_id));
  if (closed.some(id => currentIds.has(id))) throw new Error('still-current finding cannot be closed');
  return { pending: [...prior.filter(row => !closed.includes(row.finding_id) && !currentIds.has(row.finding_id)), ...observations.findings], closed };
}

function mergedOperations(repo, decision, files) {
  const receipts = files ? readControlFile(repo, files) : [];
  if (!Array.isArray(receipts) || receipts.length > 100 || receipts.some(file => typeof file !== 'string')
      || new Set(receipts).size !== receipts.length) throw new Error('invalid operations receipt list');
  const operations = [decision.operations];
  for (const file of receipts) {
    const receipt = verifyReviewOperations({ repo, operationsFile: file });
    if (receipt.round_id !== decision.round_id || !sameReviewTarget(receipt.review_target, decision.review_target))
      throw new Error('retired operations round or target mismatch');
    operations.push(receipt.accounting);
  }
  const dispatched = operations.flatMap(o => o.dispatched_attempts);
  if (new Set(dispatched.map(row => row.attempt_id)).size !== dispatched.length
      || new Set(dispatched.map(row => row.invocation_id)).size !== dispatched.length)
    throw new Error('duplicate or inconsistent attempt accounting join');
  const planned = new Map(operations.flatMap(o => o.planned_calls).map(row => [`${row.round_id}:${row.reviewer_id}`, row]));
  return { dispatched_attempts: dispatched, planned_calls: [...planned.values()],
    planned_reviewer_calls: planned.size,
    executed_reviewer_calls: operations.some(o => o.executed_reviewer_calls === null) ? null : dispatched.length,
    admitted_reviewer_calls: decision.operations.admitted_reviewer_calls,
    not_run_reviewer_calls: operations.some(o => o.not_run_reviewer_calls === null) ? null
      : [...planned.values()].filter(row => !dispatched.some(attempt => attempt.reviewer_id === row.reviewer_id)).length };
}

function responseHistory({ repo, evidenceFile, decision, post }) {
  if (!evidenceFile) return { status: 'unknown', reason: 'not_provided', source_changed: null, changed_paths: null, halted: null };
  try {
    const evidence = readControlFile(repo, evidenceFile);
    const { evidence_sha256: seal, ...body } = evidence;
    if (evidence.schema_version !== 1 || seal !== evidenceHash(body)
        || evidence.decision_sha256 !== decision.decision_sha256
        || evidence.canonical_report_sha256 !== decision.canonical_report_sha256
        || evidence.decision_file !== containedPath(repo, decision.canonical_report_path.replace(/-review\.md$/u, '-decision.json'))
        || !sameReviewTarget(evidence.reviewed_target, decision.review_target)
        || !sameReviewTarget(evidence.post_target, post)
        || !Array.isArray(evidence.groups) || !evidence.groups.length || evidence.groups.length > 100
        || typeof evidence.halted !== 'boolean' || !['completed', 'failed', 'halted'].includes(evidence.status))
      throw new Error('response decision/target binding is invalid');
    let previous = evidence.reviewed_target;
    const changed = new Set();
    const references = new Set();
    for (const group of evidence.groups) {
      for (const [key, expected] of Object.entries(group.hashes)) {
        if (evidenceHash(readBoundedFile(repo, group[key], key === 'logFile' ? 16 * 1024 * 1024 : undefined)) !== expected)
          throw new Error('response artifact digest mismatch');
      }
      if (references.has(group.snapshotFile)) throw new Error('duplicate response group');
      references.add(group.snapshotFile);
      const result = verifyPhase6History({ repo, ...group });
      if (!sameReviewTarget(previous, result.reviewed_target)) throw new Error('unaccounted response interval change');
      previous = result.post_target;
      result.changed_paths.forEach(path => changed.add(path));
    }
    if (!sameReviewTarget(previous, evidence.proof_post_target)) throw new Error('response final target mismatch');
    if (evidence.status !== 'completed' || evidence.halted) throw new Error('response contains failed or halted work');
    if (sameReviewTarget(evidence.reviewed_target, post)) throw new Error('response has no observed target change');
    return { status: 'verified', reason: null, source_changed: true, changed_paths: [...changed].sort(),
      halted: false, evidence_sha256: seal, group_count: evidence.groups.length };
  } catch (error) {
    return { status: 'unknown', reason: error.message, source_changed: null, changed_paths: null, halted: null };
  }
}

export async function buildResponseEvidence({ repo, decisionFile, postResponseTargetFile, groups, status, halted }) {
  repo = realpathSync(repo);
  const { decision } = historyDecision(repo, decisionFile);
  const post = targetFile(postResponseTargetFile, repo);
  if (!sameReviewTarget(post, await captureReviewTarget({ scope: post.scope }))) throw new Error('stale post-response snapshot');
  if (!Array.isArray(groups) || !groups.length || groups.length > 100 || typeof halted !== 'boolean'
      || !['completed', 'failed', 'halted'].includes(status)) throw new Error('complete response group list and status required');
  const archiveDir = containedPath(repo, join('.deep-review/receipts/responses', randomUUID()));
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const archived = groups.map((group, index) => {
    const snapshot = readControlFile(repo, group.snapshot_file);
    const verification = readControlFile(repo, group.verification_result_file);
    const inputs = { snapshotFile: group.snapshot_file, groupResultFile: group.group_result_file,
      verificationResultFile: group.verification_result_file, receiptFile: verification.verification_receipt,
      logFile: snapshot.log_path, ...(group.commit_result_file ? { commitResultFile: group.commit_result_file } : {}) };
    const result = { hashes: {} };
    for (const [key, file] of Object.entries(inputs)) {
      const bytes = readBoundedFile(repo, file, key === 'logFile' ? 16 * 1024 * 1024 : undefined);
      result[key] = join(archiveDir, `${index}-${key}.${key === 'logFile' ? 'log' : key === 'groupResultFile' ? 'md' : 'json'}`);
      writeFileSync(result[key], bytes, { flag: 'wx', mode: 0o600 });
      result.hashes[key] = evidenceHash(bytes);
    }
    return result;
  });
  const last = verifyPhase6History({ repo, ...archived.at(-1) });
  // Expanded post scopes need a full review. Prove the original scope too, so
  // expansion does not hide an unaccounted source edit.
  if (!sameReviewTarget(last.post_target, await captureReviewTarget({ scope: last.post_target.scope })))
    throw new Error('unaccounted change after final response group');
  const body = { schema_version: 1, decision_file: containedPath(repo, decisionFile), decision_sha256: decision.decision_sha256,
    canonical_report_sha256: decision.canonical_report_sha256, reviewed_target: decision.review_target,
    post_target: post, proof_post_target: last.post_target, status, halted, groups: archived };
  const evidence = { ...body, evidence_sha256: evidenceHash(body) };
  const evidenceFile = join(archiveDir, 'response.json');
  writeFileSync(evidenceFile, JSON.stringify(evidence), { flag: 'wx', mode: 0o600 });
  const verified = responseHistory({ repo, evidenceFile, decision, post });
  return { evidence_file: evidenceFile, response: verified };
}

export function buildSchema3Round(options, readPrevious = readSchema3Round) {
  const repo = realpathSync(options.repoRoot);
  const round = positive(options.roundNumber, 'round number'), limit = positive(options.roundLimit, 'round limit');
  if (round > limit) throw new Error('round exceeds limit');
  const decisionFile = containedPath(repo, options.decisionFile);
  const { history, decision } = historyDecision(repo, decisionFile);
  const source = readControlFile(repo, decision.source_input_path);
  const previous = options.previousState ? readPrevious(options.previousState) : null;
  const loopId = options.loopId ?? previous?.loop_id ?? randomUUID();
  if (typeof loopId !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/u.test(loopId)) throw new Error('invalid loop id');
  const base = history.review_target.scope.review_base;
  if (options.baseCommit !== undefined && options.baseCommit !== base && !(base === null && options.baseCommit === 'null'))
    throw new Error('base commit does not match immutable decision base');
  const override = options.roundLimitOverrideFile ? readControlFile(repo, options.roundLimitOverrideFile) : null;
  lineage(previous, { repo, loopId, base, round, limit, override });
  if (previous?.decision_sha256 === decision.decision_sha256 || previous?.decision_round_id === decision.round_id)
    throw new Error('decision reused across rounds');
  if (options.reviewReport && containedPath(repo, options.reviewReport) !== containedPath(repo, history.canonical_report_path))
    throw new Error('report does not match decision companion');
  const post = targetFile(options.postResponseTargetFile, repo);
  if (post.scope.review_base !== base) throw new Error('post-response target base mismatch');
  const ledger = pendingLedger(previous, history);
  const response = responseHistory({ repo, evidenceFile: options.responseEvidenceFile, decision, post });
  const operations = mergedOperations(repo, decision, options.operationReceiptsFile);
  return { schema_version: 3, source: 'verified-decision', repo_root: repo, loop_id: loopId,
    round_number: round, round_limit: limit, round_limit_override: override, base_commit: base,
    decision_file: decisionFile, decision_sha256: decision.decision_sha256, decision_round_id: decision.round_id,
    previous_state_file: options.previousState ? containedPath(repo, options.previousState) : null,
    previous_state_sha256: options.previousState ? evidenceHash(readBoundedFile(repo, options.previousState)) : null,
    round_limit_override_file: options.roundLimitOverrideFile ? containedPath(repo, options.roundLimitOverrideFile) : null,
    operation_receipts_file: options.operationReceiptsFile ? containedPath(repo, options.operationReceiptsFile) : null,
    round_review_report_path: history.canonical_report_path, report_sha256: history.canonical_report_sha256,
    response_report_path: options.responseReport ? containedPath(repo, options.responseReport) : null,
    response_evidence_file: options.responseEvidenceFile ? containedPath(repo, options.responseEvidenceFile) : null,
    post_response_target_file: containedPath(repo, options.postResponseTargetFile),
    verdict: history.recorded_verdict, counts: history.recorded_counts,
    observations: history.material_findings, findings: ledger.pending, pending_findings: ledger.pending,
    verified_closed_ids: ledger.closed, confirmation: history.confirmation,
    reviewed_target: history.review_target, post_response_target: post, response,
    artifact_phase: history.decision_mode === 'artifact-gate-v1' ? 'document' : 'implementation',
    risk: source.routing_plan.risk, readiness: history.recorded_readiness,
    dispatched_attempts: operations.dispatched_attempts,
    admitted_reviewers: decision.admitted_attempts.filter(a => a.included).map(a => a.reviewer_id),
    observed_usage: decision.observed_usage,
    accounting: { planned_reviewer_calls: operations.planned_reviewer_calls,
      executed_reviewer_calls: operations.executed_reviewer_calls, admitted_reviewer_calls: operations.admitted_reviewer_calls,
      not_run_reviewer_calls: operations.not_run_reviewer_calls },
    rejected: [], skipped_rejects: 0 };
}

export function readSchema3Round(file, seen = new Set()) {
  file = resolve(file);
  if (seen.has(file) || seen.size > 100) throw new Error('cyclic or excessive state lineage');
  seen.add(file);
  const state = bounded(file);
  if (state.schema_version !== 3 || typeof state.repo_root !== 'string') throw new Error('schema-3 state required');
  const repo = realpathSync(state.repo_root);
  containedPath(repo, file);
  if (state.previous_state_file && evidenceHash(readBoundedFile(repo, state.previous_state_file)) !== state.previous_state_sha256)
    throw new Error('previous state digest mismatch');
  // The recorded post target is immutable state evidence, not the mutable
  // current-target file (which the next round is free to replace).
  const rebuilt = buildSchema3Round({ repoRoot: repo, roundNumber: state.round_number, roundLimit: state.round_limit,
    baseCommit: state.base_commit, loopId: state.loop_id, decisionFile: state.decision_file,
    previousState: state.previous_state_file, responseReport: state.response_report_path,
    responseEvidenceFile: state.response_evidence_file, roundLimitOverrideFile: state.round_limit_override_file,
    operationReceiptsFile: state.operation_receipts_file,
    postResponseTargetFile: state.post_response_target_file }, previous => readSchema3Round(previous, seen));
  const { owner, ...body } = state;
  if (!same(body, rebuilt)) throw new Error('schema-3 state or pending ledger does not match bound evidence');
  return state;
}

export function loopCapDecision({ round, limit, artifactPhase, readiness }) {
  if (artifactPhase === 'document' && readiness === 'READY_FOR_IMPLEMENTATION') return 'READY_FOR_IMPLEMENTATION';
  if (round >= limit) return artifactPhase === 'document' ? 'DOCUMENT_BLOCKED' : 'MAX_ROUNDS';
  return null;
}

// One pure transition authority; no skill prose computes a competing verdict.
export function transitionRound({ phase, round, limit, artifactPhase, readiness, verdict, observations,
  pending, reviewed, current, response, currentAuthority, actionableCount = 0, operationalFailure, userStop, deferStop, halted, stalled }) {
  const verifiedTree = sameReviewTarget(reviewed, current);
  const expectedChange = phase === 'after-respond' && response?.status === 'verified';
  const complete = observations.status === 'complete';
  const clean = verifiedTree && complete && currentAuthority && (artifactPhase === 'document'
    ? readiness?.status === 'READY_FOR_IMPLEMENTATION' : verdict === 'APPROVE' && pending.length === 0);
  const cap = loopCapDecision({ round, limit, artifactPhase, readiness: null });
  let reason = null, action = 'stop';
  if (operationalFailure || (!verifiedTree && !expectedChange) || (verifiedTree && !currentAuthority)) reason = 'OPERATIONAL_FAILURE';
  else if (userStop || deferStop) reason = userStop ? 'USER_STOP' : 'DEFER_AND_STOP';
  else if (clean) reason = artifactPhase === 'document' ? 'READY_FOR_IMPLEMENTATION' : 'APPROVE';
  else if (cap) reason = cap;
  else if (halted || response?.halted) reason = 'RESPONSE_HALTED';
  else if (!complete) reason = 'INDETERMINATE_OBSERVATIONS';
  else if (expectedChange && !verifiedTree) action = 'review';
  else if (artifactPhase === 'implementation' && actionableCount === 0 && pending.length > 0) reason = 'UNRESOLVED_WORK';
  else if (verdict === 'CONCERN' && artifactPhase !== 'implementation' && observations.findings.length === 0) reason = 'UNRESOLVED_WORK';
  else if (stalled) reason = 'STALLED';
  else if (phase === 'before-respond' && artifactPhase === 'implementation' && actionableCount > 0) action = 'respond';
  else if (phase === 'before-respond' && artifactPhase === 'document') action = 'respond';
  else reason = 'NO_ACTIONABLE_WORK';
  return { action, stop_reason: reason, final_tree_verified: verifiedTree && currentAuthority && complete,
    completion_status: action === 'review' ? 'verification_pending' : !verifiedTree ? 'UNVERIFIED_FINAL_TREE'
      : clean && !['OPERATIONAL_FAILURE', 'USER_STOP', 'DEFER_AND_STOP'].includes(reason) ? 'verified' : 'unresolved',
    round_number: round, round_limit: limit, unused_round_capacity: Math.max(0, limit - round),
    review_mode: action === 'review' && reviewed.scope_digest !== current.scope_digest ? 'full' : null,
    last_trusted_verdict: verdict, reviewed_target_digest: reviewed.target_digest, current_target_digest: current.target_digest };
}

export async function decideRound(options = {}) {
  const { phase } = options;
  if (!['before-respond', 'after-respond'].includes(phase)
      || (phase === 'before-respond' ? !options.decisionFile || options.stateFile : !options.stateFile || options.decisionFile || options.previousState || options.roundNumber !== undefined))
    throw new Error('decide-round modes are mutually exclusive');
  const current = targetFile(options.currentTargetFile);
  const repo = current.scope.repo_root;
  if (!sameReviewTarget(current, await captureReviewTarget({ scope: current.scope }))) throw new Error('stale or forged current snapshot');
  const state = phase === 'after-respond' ? readSchema3Round(options.stateFile) : null;
  const previous = options.previousState ? readSchema3Round(options.previousState) : null;
  const limit = positive(options.roundLimit, 'round limit');
  const round = state?.round_number ?? positive(options.roundNumber, 'round number');
  if (round > limit) throw new Error('round exceeds limit');
  if (state && (state.repo_root !== repo || state.round_limit !== limit)) throw new Error('state repository or round limit mismatch');
  const file = state?.decision_file ?? options.decisionFile;
  const { history, decision } = historyDecision(repo, file);
  if (!state) lineage(previous, { repo, loopId: previous?.loop_id, base: history.review_target.scope.review_base, round, limit,
    override: options.roundLimitOverrideFile ? readControlFile(repo, options.roundLimitOverrideFile) : null });
  if (previous?.decision_round_id === decision.round_id) throw new Error('decision reused across rounds');
  let currentAuthority = false;
  if (sameReviewTarget(history.review_target, current)) {
    try { verifyReviewDecisionSync({ repo, decisionFile: file }); currentAuthority = true; } catch { /* history is not current authority */ }
  }
  const pending = state?.pending_findings ?? pendingLedger(previous, history).pending;
  const response = state?.response?.status === 'verified' && sameReviewTarget(state.post_response_target, current) ? state.response : null;
  for (const key of ['operationalFailure', 'userStop', 'deferStop', 'halted', 'stalled'])
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`invalid ${key} signal`);
  const result = transitionRound({ phase, round, limit, artifactPhase: history.decision_mode === 'artifact-gate-v1' ? 'document' : 'implementation',
    readiness: history.recorded_readiness, verdict: history.recorded_verdict, observations: history.material_findings,
    pending, reviewed: history.review_target, current, response, currentAuthority,
    actionableCount: decision.adjudication?.groups.filter(group => group.disposition === 'confirmed_blocker').length ?? 0,
    ...Object.fromEntries(['operationalFailure', 'userStop', 'deferStop', 'halted', 'stalled'].map(k => [k, options[k]])) });
  const rounds = [];
  let cursor = state ?? previous;
  while (cursor) { rounds.push(cursor); cursor = cursor.previous_state_file ? readSchema3Round(cursor.previous_state_file) : null; }
  const operations = rounds.map(r => r.accounting);
  if (!state) operations.push(mergedOperations(repo, decision, options.operationReceiptsFile));
  return { ...result, rounds_executed: operations.length,
    ...Object.fromEntries(['planned_reviewer_calls', 'executed_reviewer_calls', 'admitted_reviewer_calls', 'not_run_reviewer_calls']
      .map(key => [key, operations.some(row => row[key] === null) ? null : operations.reduce((sum, row) => sum + row[key], 0)])) };
}

export async function decideOperationalStop({ operationsFile, currentTargetFile, previousState, decisionFile, roundLimit }) {
  const current = targetFile(currentTargetFile);
  if (!sameReviewTarget(current, await captureReviewTarget({ scope: current.scope }))) throw new Error('stale or forged current snapshot');
  const repo = current.scope.repo_root;
  const receipt = verifyReviewOperations({ repo, operationsFile });
  if (!sameReviewTarget(receipt.current_target, current)) throw new Error('stale operational receipt target');
  const previous = previousState ? readSchema3Round(previousState) : null;
  if (previous && (previous.repo_root !== repo || previous.base_commit !== receipt.review_target.scope.review_base)) throw new Error('foreign previous state or base');
  const limit = roundLimit === undefined ? previous?.round_limit ?? null : positive(roundLimit, 'round limit');
  if (previous && limit !== previous.round_limit) throw new Error('operational stop round limit mismatch');
  if (previous && decisionFile && containedPath(repo, decisionFile) !== previous.decision_file) throw new Error('conflicting prior decision');
  const history = decisionFile || previous ? historyDecision(repo, decisionFile ?? previous.decision_file).history : null;
  if (history && history.review_target.scope.review_base !== receipt.review_target.scope.review_base) throw new Error('foreign previous decision base');
  const operations = [receipt.accounting];
  let cursor = previous;
  while (cursor) { operations.push(cursor.accounting); cursor = cursor.previous_state_file ? readSchema3Round(cursor.previous_state_file) : null; }
  return { action: 'stop', stop_reason: receipt.reason, completion_status: 'UNVERIFIED_FINAL_TREE', final_tree_verified: false,
    rounds_executed: operations.length, round_limit: limit, unused_round_capacity: limit === null ? null : Math.max(0, limit - operations.length),
    last_trusted_verdict: history?.recorded_verdict ?? null, reviewed_target_digest: history?.review_target.target_digest ?? null,
    current_target_digest: current.target_digest, operations_file: containedPath(repo, operationsFile),
    ...Object.fromEntries(['planned_reviewer_calls', 'executed_reviewer_calls', 'admitted_reviewer_calls', 'not_run_reviewer_calls']
      .map(key => [key, operations.some(row => row[key] === null) ? null : operations.reduce((sum, row) => sum + row[key], 0)])) };
}

export function isValidatedLoopProgress(value) { return progressAuthority.has(value); }
export async function verifyAdaptiveContext({ repo, context, currentTarget }) {
  if (context.schema_version !== 3) return { state: 'changed', used_reviewers: context.used_reviewers, risk: context.risk };
  const current = targetFile(context.current_target_file, repo);
  if (!sameReviewTarget(current, await captureReviewTarget({ scope: current.scope }))
      || (currentTarget && !sameReviewTarget(currentTarget, current))) throw new Error('adaptive current target is stale or different from selected scope');
  const prior = readSchema3Round(context.state_file);
  if (prior.repo_root !== repo || prior.base_commit !== current.scope.review_base || prior.decision_sha256 !== context.decision_sha256
      || !same(context.pending_finding_ids, prior.pending_findings.map(f => f.finding_id))
      || context.observation_status !== prior.observations.status || context.risk !== prior.risk)
    throw new Error('adaptive state binding mismatch');
  // Full-scope reviews still need the bound pending work. Only reducing the
  // slate requires a verified Respond and identical reviewed/current scope.
  const pendingConfirmation = prior.artifact_phase === 'implementation'
    && prior.observations.status === 'complete' && prior.pending_findings.length > 0;
  const confirmation = pendingConfirmation && prior.response.status === 'verified'
    && sameReviewTarget(current, prior.post_response_target)
    && prior.reviewed_target.scope_digest === current.scope_digest;
  let regression = false;
  if (context.regression_evidence) {
    const evidence = context.regression_evidence;
    const { decision } = historyDecision(repo, prior.decision_file);
    const refs = decision.adjudication?.source_findings || [];
    if (!evidence.source_ref || !refs.some(ref => ['reviewer_id', 'report_sha256', 'severity', 'ordinal'].every(key => ref[key] === evidence.source_ref[key]))
        || typeof evidence.location !== 'string' || !evidence.location.trim() || typeof evidence.observation !== 'string' || !evidence.observation.trim()
        || evidence.prior_target_digest !== prior.reviewed_target.target_digest || evidence.current_target_digest !== current.target_digest)
      throw new Error('regression evidence lacks source and target bindings');
    regression = true;
  }
  const result = { state: regression ? 'regression' : confirmation ? 'confirmation' : 'changed', risk: prior.risk,
    used_reviewers: prior.dispatched_attempts.map(row => row.reviewer_id),
    confirmation_request: pendingConfirmation ? { schema_version: 1, target_digest: current.target_digest, finding_ids: prior.pending_findings.map(f => f.finding_id) } : null,
    pending_findings: prior.pending_findings };
  progressAuthority.add(result);
  return result;
}

export function adaptiveCarrier({ stateFile, currentTargetFile, regressionEvidence }) {
  const state = readSchema3Round(stateFile);
  return { schema_version: 3, state_file: resolve(stateFile), current_target_file: resolve(currentTargetFile),
    decision_sha256: state.decision_sha256, risk: state.risk, observation_status: state.observations.status,
    pending_finding_ids: state.pending_findings.map(f => f.finding_id),
    ...(regressionEvidence ? { regression_evidence: regressionEvidence } : {}) };
}
