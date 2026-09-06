#!/usr/bin/env node
import { mkdirSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { relative, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  canonicalStringify,
  verifyReadinessReceipt,
  evaluateDocumentReadiness,
  parseArtifactGate,
  evaluateDeferredAcceptance,
} from './document-readiness.mjs';
import { verifyPreparedReviewerPayload } from './build-reviewer-payload.mjs';
import { evaluateReviewerAttempt, synthesizeReviewRound } from './review-synthesis.mjs';
import {
  parseExecutionPlanDocument,
  parseExecutionRoute,
  parsePreparedReviewBinding,
} from './lib/execution-plan.mjs';
import { REVIEWER_PROVIDERS } from './lib/reviewer-ids.mjs';
import { extractSourceFindings } from './lib/review-adjudication.mjs';
import { extractFindingState } from './lib/finding-identity.mjs';
import { renderAdjudicatedReport } from './lib/report-contract.mjs';
import {
  captureReviewTarget,
  createTargetScope,
  sameReviewTarget,
  evidenceHash,
  readControlFile,
  readBoundedFile,
  containedPath,
  CONTROL_LIMIT,
  SOURCE_LIMIT,
} from './lib/review-target-snapshot.mjs';

export function validateEvidenceInputs(value) {
  const keys = ['context', 'diff', 'changeFiles', 'priorRounds', 'readinessReceipt'];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',') ||
    keys.some((key) => typeof value[key] !== 'string') ||
    Buffer.byteLength(canonicalStringify(value)) > CONTROL_LIMIT
  )
    throw new Error('invalid evidence inputs');
  return value;
}
export function prepareReviewRound({
  routingPlan,
  target,
  evidenceInputs,
  roundId,
  confirmationRequest = null,
}) {
  if (!sameReviewTarget(target, target)) throw new Error('captured review target required');
  validateEvidenceInputs(evidenceInputs);
  const plan = structuredClone(routingPlan);
  if (
    plan.protocol_version !== '3.0' ||
    !Array.isArray(plan.routes) ||
    !plan.routes.length ||
    plan.shadow_mode
  )
    throw new Error('production protocol 3 plan required');
  for (const route of plan.routes) parseExecutionPlanDocument(plan, route.reviewer_id);
  const binding = {
    decision_mode: plan.artifact_phase === 'document' ? 'artifact-gate-v1' : 'adjudication-v1',
    review_target: structuredClone(target),
    round_id: roundId,
    evidence_digest: evidenceHash(evidenceInputs),
    confirmation_request: structuredClone(confirmationRequest),
  };
  Object.assign(plan, binding);
  plan.routes = plan.routes.map((route) => ({ ...route, ...binding }));
  plan.candidate_reviewers = plan.candidate_reviewers.map((candidate) => ({
    ...candidate,
    ...(candidate.expansion_route_templates
      ? {
          expansion_route_templates: candidate.expansion_route_templates.map((route) => ({
            ...route,
            ...binding,
          })),
        }
      : {}),
  }));
  for (const route of plan.routes) parseExecutionPlanDocument(plan, route.reviewer_id);
  return { plan, target: structuredClone(target) };
}
export function buildDispatchEvidence({ routingPlan, attempts, launches, roundId }) {
  if (
    !Array.isArray(attempts) ||
    !Array.isArray(launches) ||
    typeof roundId !== 'string' ||
    !roundId.trim() ||
    (routingPlan.round_id && roundId !== routingPlan.round_id)
  )
    throw new Error('invalid dispatch input');
  const ids = new Set();
  const invocationIds = new Set();
  const attemptIds = new Set();
  for (const launch of launches) {
    if (
      !launch ||
      typeof launch.invocation_id !== 'string' ||
      !launch.invocation_id.trim() ||
      typeof launch.attempt_id !== 'string' ||
      !launch.attempt_id.trim() ||
      ids.has(launch.reviewer_id) ||
      invocationIds.has(launch.invocation_id) ||
      attemptIds.has(launch.attempt_id)
    )
      throw new Error('invalid or duplicate launch identity');
    const raw = attempts.find((attempt) => attempt?.reviewer_id === launch.reviewer_id);
    const selected = routingPlan.routes?.find((route) => route.reviewer_id === launch.reviewer_id);
    if (!raw || !selected) throw new Error('launch has no selected attempt');
    const route = { protocol_version: '3.0', ...selected };
    if (evidenceHash(route) !== evidenceHash(launch.execution_route))
      throw new Error('launch route mismatch');
    const parsed = parseExecutionRoute(route, launch.reviewer_id);
    if (parsed.preparedReview) {
      const observed = verifyPreparedReviewerPayload(launch.payload, route);
      if (
        !sameReviewTarget(raw.target_before, routingPlan.review_target) ||
        !sameReviewTarget(raw.target_after, routingPlan.review_target) ||
        raw.evidence_digest !== observed.evidence_digest
      )
        throw new Error('launch target/source mismatch');
      if (!['native-argument', 'bridge-read'].includes(launch.payload_provenance))
        throw new Error('actual payload observation required');
      if (
        launch.payload_provenance === 'bridge-read' &&
        (launch.bridge_observation?.route_payload_sha256 !== observed.payload_sha256 ||
          launch.bridge_observation?.route_payload_bytes !== observed.payload_bytes)
      )
        throw new Error('bridge payload observation mismatch');
    }
    ids.add(launch.reviewer_id);
    invocationIds.add(launch.invocation_id);
    attemptIds.add(launch.attempt_id);
  }
  if (attempts.some((attempt) => !ids.has(attempt?.reviewer_id)))
    throw new Error('attempt has no launch');
  const admitted = attempts
    .map((raw) => {
      if (typeof raw?.output !== 'string') throw new Error('dispatch requires raw reports');
      return { raw, evaluated: evaluateReviewerAttempt(raw) };
    })
    .filter((row) => row.evaluated.included);
  const reviewers = new Set();
  const records = admitted.map(({ raw, evaluated }) => {
    const id = evaluated.reviewer_id;
    if (reviewers.has(id)) throw new Error('duplicate admitted reviewer');
    reviewers.add(id);
    parseExecutionPlanDocument(routingPlan, id);
    const planned = routingPlan.routes.find((route) => route.reviewer_id === id);
    const launch = launches.find((row) => row.reviewer_id === id);
    const route = { protocol_version: '3.0', ...planned };
    if (!launch || evidenceHash(launch.execution_route) !== evidenceHash(route))
      throw new Error('launch route mismatch');
    const parsed = parseExecutionRoute(route, id);
    if (Object.hasOwn(launch, 'model') && launch.model !== parsed.model)
      throw new Error('launch model mismatch');
    if (launch.output_sha256 && launch.output_sha256 !== evaluated.output_digest)
      throw new Error('launch output mismatch');
    if (
      parsed.preparedReview &&
      (raw.evidence_digest !== routingPlan.evidence_digest ||
        !sameReviewTarget(raw.target_before, routingPlan.review_target) ||
        !sameReviewTarget(raw.target_after, routingPlan.review_target))
    )
      throw new Error('dispatch target/source mismatch');
    let payloadEvidence = {};
    if (parsed.preparedReview) {
      const verified = verifyPreparedReviewerPayload(launch.payload, route);
      if (!['native-argument', 'bridge-read'].includes(launch.payload_provenance))
        throw new Error('actual payload observation required');
      if (
        launch.payload_provenance === 'bridge-read' &&
        (launch.bridge_observation?.route_payload_sha256 !== verified.payload_sha256 ||
          launch.bridge_observation?.route_payload_bytes !== verified.payload_bytes)
      )
        throw new Error('bridge payload observation mismatch');
      payloadEvidence = { ...verified, payload_provenance: launch.payload_provenance };
    }
    return {
      ...payloadEvidence,
      attempt_id: launch.attempt_id,
      reviewer_id: id,
      provider_family: REVIEWER_PROVIDERS[id],
      model: parsed.model,
      execution_route: route,
      route_sha256: evidenceHash(route),
      output_sha256: evaluated.output_digest,
      compatibility_evidence_sha256: parsed.grokCompatibilityEvidence?.evidence_sha256 ?? null,
      session_id: launch.invocation_id,
      session_identity_kind: 'isolated-invocation',
      ...(launch.native_handle ? { native_handle: launch.native_handle } : {}),
      ...(launch.provider_session_id ? { provider_session_id: launch.provider_session_id } : {}),
    };
  });
  return { round_id: roundId, routing_plan_sha256: evidenceHash(routingPlan), records };
}
function readSourceReports(repo, input) {
  for (const raw of input.attempts) {
    if (typeof raw?.output !== 'string' || Buffer.byteLength(raw.output) > SOURCE_LIMIT)
      throw new Error('bounded raw attempt output required');
    if (
      raw.output_file &&
      new TextDecoder('utf-8', { fatal: true }).decode(
        readBoundedFile(repo, raw.output_file, SOURCE_LIMIT),
      ) !== raw.output
    )
      throw new Error('raw report file mismatch');
  }
}
// Small manifests remain <=1 MiB. Large payload/report bytes are separate,
// bounded regular files; the in-memory API accepts the same compound evidence.
export function loadReviewEvidenceInput({ repo, input: source }) {
  if (
    !source ||
    !Array.isArray(source.attempts) ||
    source.attempts.length > 5 ||
    !Array.isArray(source.launches) ||
    source.launches.length > 5
  )
    throw new Error('invalid bounded evidence manifest');
  const input = structuredClone(source);
  if (input.evidence_inputs_file) {
    const inputs = readControlFile(repo, input.evidence_inputs_file);
    if (input.evidence_inputs && evidenceHash(inputs) !== evidenceHash(input.evidence_inputs))
      throw new Error('evidence inputs file mismatch');
    input.evidence_inputs = inputs;
  }
  for (const [rows, key, fileKey] of [
    [input.attempts, 'output', 'output_file'],
    [input.launches, 'payload', 'payload_file'],
  ]) {
    for (const row of rows) {
      if (row[fileKey]) {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
          readBoundedFile(repo, row[fileKey], SOURCE_LIMIT),
        );
        if (row[key] !== undefined && row[key] !== text)
          throw new Error('captured artifact file mismatch');
        row[key] = text;
      }
      if (
        typeof row[key] !== 'string' ||
        !row[key].isWellFormed() ||
        Buffer.byteLength(row[key]) > SOURCE_LIMIT
      )
        throw new Error('artifact byte limit or encoding unsupported');
      const original = row['original_' + fileKey];
      if (
        original &&
        new TextDecoder('utf-8', { fatal: true }).decode(
          readBoundedFile(repo, original, SOURCE_LIMIT),
        ) !== row[key]
      )
        throw new Error('original source artifact changed');
    }
  }
  return input;
}
function captureEvidenceSource(repo, input, nonce) {
  const source = structuredClone(input);
  const artifacts = [];
  for (const [rows, key, fileKey] of [
    [source.attempts, 'output', 'output_file'],
    [source.launches, 'payload', 'payload_file'],
  ]) {
    rows.forEach((row, index) => {
      const file = resolve(repo, '.deep-review/receipts/decisions', nonce, `${key}-${index}.md`);
      artifacts.push({ file, bytes: row[key] });
      delete row[key];
      if (row[fileKey]) row['original_' + fileKey] = row['original_' + fileKey] || row[fileKey];
      row[fileKey] = file;
    });
  }
  const bytes = canonicalStringify(source) + '\n';
  if (Buffer.byteLength(bytes) > CONTROL_LIMIT)
    throw new Error('thin evidence manifest exceeds control byte limit');
  return { bytes, artifacts };
}

function recompute(repo, input, date) {
  if (!input || !Array.isArray(input.attempts)) throw new Error('raw synthesis input required');
  const binding = parsePreparedReviewBinding(input.routing_plan || {});
  if (!binding) throw new Error('prepared decision mode required');
  validateEvidenceInputs(input.evidence_inputs);
  if (evidenceHash(input.evidence_inputs) !== binding.evidence_digest)
    throw new Error('source evidence input mismatch');
  readSourceReports(repo, input);
  if (!Array.isArray(input.launches)) throw new Error('captured launch payloads required');
  const rebuiltDispatch = buildDispatchEvidence({
    routingPlan: input.routing_plan,
    attempts: input.attempts,
    launches: input.launches,
    roundId: binding.round_id,
  });
  if (evidenceHash(rebuiltDispatch) !== evidenceHash(input.dispatch))
    throw new Error('dispatch source/launch mismatch');
  let deferredAcceptance = input.deferred_acceptance ?? null;
  if (input.evidence_inputs.readinessReceipt) {
    if (!input.readiness_receipt)
      throw new Error('source receipt projection requires actual verified receipt');
    const verified = verifyReadinessReceipt({ repo, receiptPath: input.readiness_receipt });
    const projection = JSON.stringify(
      {
        status: verified.status,
        scope_sha256: verified.scope_sha256,
        risk: verified.risk,
        deferred_findings: verified.deferred_findings,
      },
      null,
      2,
    );
    if (projection !== input.evidence_inputs.readinessReceipt)
      throw new Error('source receipt projection mismatch');
    if (binding.decision_mode === 'adjudication-v1') {
      deferredAcceptance = evaluateDeferredAcceptance({
        receipt: verified,
        repo,
        implementationArtifacts: binding.review_target.scope.files.map((row) => ({
          path: row.path,
        })),
        verifiedItems: input.deferred_verified_items ?? [],
      });
      if (
        input.deferred_acceptance &&
        canonicalStringify(input.deferred_acceptance) !== canonicalStringify(deferredAcceptance)
      )
        throw new Error('unverified deferred acceptance override');
    }
  }
  const attempts = input.attempts.map(evaluateReviewerAttempt);
  const synthesis = synthesizeReviewRound({
    attempts,
    routingPlan: input.routing_plan,
    consensus: input.consensus,
    adjudication: input.adjudication,
    dispatch: input.dispatch,
    expansionWavesUsed: input.expansion_waves_used ?? 0,
    readinessMismatch: input.readiness_mismatch === true,
    deferredAcceptance,
  });
  if (synthesis.status !== 'reviewed' || synthesis.needs_expansion || !synthesis.phase6_allowed)
    throw new Error(`nonterminal review decision: ${synthesis.error || synthesis.status}`);
  let groups = synthesis.adjudication?.groups ?? [];
  let readiness = null;
  let verdict = synthesis.verdict;
  if (binding.decision_mode === 'artifact-gate-v1') {
    const reportEvidence = attempts
      .filter((a) => a.included)
      .map((a) => {
        const raw = input.attempts.find((row) => row.reviewer_id === a.reviewer_id);
        const gate = parseArtifactGate(raw.output);
        if (!gate) throw new Error('invalid document Artifact Gate');
        return {
          reviewer_id: a.reviewer_id,
          provider_family: REVIEWER_PROVIDERS[a.reviewer_id],
          artifact_gate: gate,
        };
      });
    readiness = evaluateDocumentReadiness({
      reportEvidence,
      risk: input.routing_plan.risk,
      requiredReviewers: input.routing_plan.minimum_reviewers,
      providerFamilyMinimum: input.routing_plan.provider_family_minimum,
    });
    if (readiness.status === 'READY_FOR_IMPLEMENTATION') {
      if (!input.readiness_receipt) throw new Error('verified document readiness receipt required');
      const verified = verifyReadinessReceipt({ repo, receiptPath: input.readiness_receipt });
      if (
        verified.receipt.schema_version !== '2.0' ||
        verified.receipt.readiness_admission?.carrier_sha256 !==
          synthesis.readiness_admission?.carrier_sha256 ||
        verified.risk !== input.routing_plan.risk
      )
        throw new Error('document receipt admission mismatch');
      const targetPaths = binding.review_target.scope.files.map((row) => row.path).sort();
      const receiptPaths = verified.receipt.documents.map((row) => row.path).sort();
      if (canonicalStringify(targetPaths) !== canonicalStringify(receiptPaths))
        throw new Error('document receipt scope mismatch');
      readiness = {
        ...readiness,
        receipt_path: verified.receipt_path,
        receipt_sha256: verified.receipt.receipt_sha256,
      };
    }
    verdict = readiness.document_verdict;
    groups = input.attempts
      .filter((raw) => attempts.find((a) => a.reviewer_id === raw.reviewer_id)?.included)
      .flatMap((raw) =>
        extractSourceFindings(raw.output, raw.reviewer_id).map((source) => ({
          disposition: 'unresolved',
          severity: source.severity,
          rationale: source.bullet,
          source_findings: [source],
        })),
      );
  }
  const report = renderAdjudicatedReport({
    date,
    verdict,
    groups,
    annotations: {
      decision_mode: binding.decision_mode,
      readiness,
      confirmation: synthesis.confirmation ?? null,
      coverage: {
        confidence_floor_applied: synthesis.confidence_floor_applied,
        deferred_acceptance_floor: synthesis.deferred_acceptance_floor,
        confirmation_floor_applied: synthesis.confirmation_floor_applied ?? false,
        provider_families: synthesis.provider_families,
      },
    },
  });
  const findingState = extractFindingState(report, { repoRoot: repo });
  return {
    report,
    result: {
      decision_mode: binding.decision_mode,
      round_id: binding.round_id,
      routing_plan_sha256: evidenceHash(input.routing_plan),
      review_target: binding.review_target,
      verdict,
      counts: {
        critical: groups.filter(
          (g) =>
            ['confirmed_blocker', 'unresolved'].includes(g.disposition) &&
            g.severity === 'critical',
        ).length,
        warning: groups.filter(
          (g) =>
            ['confirmed_blocker', 'unresolved'].includes(g.disposition) && g.severity === 'warning',
        ).length,
        info: 0,
      },
      material_findings: findingState,
      pending_findings: [
        ...findingState.findings,
        ...(synthesis.confirmation?.items || []).filter(
          (row) =>
            row.status !== 'verified_closed' &&
            !findingState.findings.some((f) => f.finding_id === row.finding_id),
        ),
      ],
      adjudication: synthesis.adjudication ?? null,
      confirmation: synthesis.confirmation ?? null,
      readiness,
      synthesis,
      dispatch: input.dispatch,
      admitted_attempts: attempts.map((a) => ({ ...a })),
      observed_usage: input.attempts.map((raw) => ({
        reviewer_id: raw.reviewer_id,
        usage: raw.usage ?? null,
      })),
    },
  };
}
function publish(repo, file, contents) {
  const absolute = containedPath(repo, file);
  mkdirSync(dirname(absolute), { recursive: true });
  containedPath(repo, file);
  const tmp = `${absolute}.${randomUUID()}.tmp`;
  writeFileSync(tmp, contents, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(tmp, absolute);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
  return absolute;
}
export async function finalizeReviewDecision({
  repo,
  input,
  reportDir = '.deep-review/reports',
  date = new Date().toISOString().slice(0, 10),
}) {
  repo = realpathSync(repo);
  input = loadReviewEvidenceInput({ repo, input });
  const { report, result } = recompute(repo, input, date);
  if (
    result.review_target.scope.repo_root !== repo ||
    !sameReviewTarget(
      result.review_target,
      await captureReviewTarget({ scope: result.review_target.scope }),
    )
  )
    throw new Error('review target changed before finalization');
  const outputDir = containedPath(repo, reportDir);
  if (relative(repo, outputDir).split(/[/\\]/).slice(0, 2).join('/') !== '.deep-review/reports')
    throw new Error('report directory must be under .deep-review/reports');
  const nonce = randomUUID();
  const sourcePath = resolve(repo, '.deep-review/receipts/decisions', `${nonce}-source.json`);
  const reportPath = resolve(outputDir, `${date}-${nonce}-review.md`);
  const decisionPath = resolve(outputDir, `${date}-${nonce}-decision.json`);
  const capture = captureEvidenceSource(repo, input, nonce);
  const sourceBytes = capture.bytes;
  const body = {
    schema_version: 1,
    ...result,
    date,
    source_input_path: sourcePath,
    source_input_sha256: evidenceHash(sourceBytes),
    canonical_report_path: reportPath,
    canonical_report_sha256: evidenceHash(report),
  };
  const decision = { ...body, decision_sha256: evidenceHash(body) };
  if (Buffer.byteLength(canonicalStringify(decision)) > CONTROL_LIMIT)
    throw new Error('decision control record exceeds byte limit');
  for (const artifact of capture.artifacts) publish(repo, artifact.file, artifact.bytes);
  publish(repo, sourcePath, sourceBytes);
  // Publish the companion first. Neither file alone is authority; verification
  // requires the complete pair and replays the captured source input.
  publish(repo, decisionPath, canonicalStringify(decision) + '\n');
  publish(repo, reportPath, report);
  return { report_path: reportPath, decision_path: decisionPath, decision };
}
export async function verifyReviewDecision({ decisionFile, repo }) {
  repo = realpathSync(repo);
  const decision = readControlFile(repo, decisionFile);
  const { decision_sha256: seal, ...body } = decision;
  if (
    decision.schema_version !== 1 ||
    evidenceHash(body) !== seal ||
    decision.review_target?.scope?.repo_root !== repo
  )
    throw new Error('invalid decision seal or repository');
  const reportPath = containedPath(repo, decision.canonical_report_path);
  const sourcePath = containedPath(repo, decision.source_input_path);
  if (
    !relative(repo, reportPath).replaceAll('\\', '/').startsWith('.deep-review/reports/') ||
    !reportPath.endsWith('-review.md') ||
    containedPath(repo, decisionFile) !==
      reportPath.slice(0, -'-review.md'.length) + '-decision.json' ||
    !relative(repo, sourcePath).replaceAll('\\', '/').startsWith('.deep-review/receipts/decisions/')
  )
    throw new Error('invalid decision companion paths');
  const source = readBoundedFile(repo, decision.source_input_path);
  if (evidenceHash(source) !== decision.source_input_sha256)
    throw new Error('source input digest mismatch');
  const input = loadReviewEvidenceInput({
    repo,
    input: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source)),
  });
  const { report, result } = recompute(repo, input, decision.date);
  const actualReport = readBoundedFile(repo, decision.canonical_report_path, SOURCE_LIMIT);
  if (
    evidenceHash(actualReport) !== decision.canonical_report_sha256 ||
    actualReport.toString('utf8') !== report
  )
    throw new Error('canonical report mismatch');
  const expected = {
    schema_version: 1,
    ...result,
    date: decision.date,
    source_input_path: decision.source_input_path,
    source_input_sha256: decision.source_input_sha256,
    canonical_report_path: decision.canonical_report_path,
    canonical_report_sha256: decision.canonical_report_sha256,
  };
  if (evidenceHash(expected) !== seal) throw new Error('recomputed decision mismatch');
  return decision;
}
async function cli(argv) {
  const command = argv.shift();
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('expected --key value');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const repo = realpathSync(options.repo || process.cwd());
  const input = options.input ? readControlFile(repo, options.input) : null;
  if (command === 'capture') return captureReviewTarget({ scope: await createTargetScope(input) });
  if (command === 'prepare')
    return prepareReviewRound({
      ...input,
      evidenceInputs: options['evidence-inputs-file']
        ? readControlFile(repo, options['evidence-inputs-file'])
        : input?.evidenceInputs,
    });
  if (command === 'build-dispatch')
    return buildDispatchEvidence(loadReviewEvidenceInput({ repo, input }));
  if (command === 'finalize')
    return finalizeReviewDecision({
      repo,
      input,
      reportDir: options['report-dir'],
      date: options.date,
    });
  if (command === 'verify') return verifyReviewDecision({ repo, decisionFile: options.decision });
  throw new Error('expected capture, prepare, build-dispatch, finalize or verify');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(JSON.stringify(await cli(process.argv.slice(2))) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ status: 'error', error: error.message }) + '\n');
    process.exitCode = 2;
  }
}
