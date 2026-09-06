#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChangeFiles,
  escapeDisplayControls,
  serializeChangeFilesDetailed,
} from './lib/review-target.mjs';
import {
  atomicWriteFile,
  makeSecureTempPath,
  resolvePluginRoot,
} from './lib/runtime-context.mjs';
import { loadExecutionPlan, parseExecutionRouteJson } from './lib/execution-plan.mjs';
import {
  documentReviewPolicyText,
  rubricTextForRole,
} from './lib/assignment-rubrics.mjs';
import { canonicalStringify, verifyReadinessReceipt } from './document-readiness.mjs';
import { validateEvidenceInputs } from './review-evidence.mjs';
import { evidenceHash, readControlFile } from './lib/review-target-snapshot.mjs';
import { buildReportContract } from './lib/report-contract.mjs';

const DOCTRINE_WARNING = 'fp-doctrine extraction failed (injection skipped)';
const PRIOR_ROUNDS_TITLE = 'PRIOR ROUND CONTEXT (advisory — re-verify, never suppress)';
const PRIOR_ROUNDS_MAX_BYTES = 32 * 1024;
const PRIOR_CONTEXT_HEADER_PATTERN = /^<!-- PRIOR-CONTEXT v1 loop_id=(\S+) base_commit=(\S+) round=(\d+) -->\s*$/u;
const SECTION_ORDER = [
  ['TRUSTED REVIEW ASSIGNMENT', 'assignment'],
  ['TRUSTED REVIEW TARGET', 'reviewTarget'],
  ['VERIFIED DOCUMENT READINESS RECEIPT', 'readinessReceipt'],
  ['REVIEW SUPPRESSION DOCTRINE', 'doctrine'],
  ['CHANGED FILES (cross-file context)', 'changeFiles'],
  ['PROJECT RULES / CONTRACT / HEALTH', 'context'],
  [PRIOR_ROUNDS_TITLE, 'priorRounds'],
  ['DIFF UNDER REVIEW', 'diff'],
  ['OUTPUT CONTRACT', 'reportContract'],
];
const CONTRACT_PAYLOAD_REVIEWERS = new Set([
  'claude-opus',
  'codex-review',
  'codex-adversarial',
]);

function trustedAssignmentSection(options) {
  const source = options.executionRouteJson ?? options.routingPlan;
  if (Boolean(source) !== Boolean(options.reviewerId)) {
    throw new Error('an execution route and reviewerId must be provided together');
  }
  if (!source) return { content: '', executionPlan: null };
  // Inline route is the supported transport; the plan-file path is retained
  // only for callers that have not migrated yet.
  const executionPlan = options.executionRouteJson
    ? parseExecutionRouteJson(options.executionRouteJson, options.reviewerId)
    : loadExecutionPlan(options.routingPlan, options.reviewerId);
  const lines = [
    `reviewer_id: ${options.reviewerId}`,
    `assignment_role: ${executionPlan.assignmentRole}`,
    `rubric_id: ${executionPlan.rubricId}`,
    `wave: ${executionPlan.wave}`,
    `required: ${executionPlan.required}`,
    ...(executionPlan.artifactPhase
      ? [
          `artifact_phase: ${executionPlan.artifactPhase}`,
          `risk: ${executionPlan.risk}`,
          ...(executionPlan.artifactPhase === 'document'
            ? [`document_review_mode: ${executionPlan.documentReviewMode}`]
            : []),
        ]
      : []),
    '',
    rubricTextForRole(executionPlan.assignmentRole, { preparedReview: executionPlan.preparedReview, reviewerId: options.reviewerId }),
    ...(executionPlan.artifactPhase === 'document'
      ? ['', documentReviewPolicyText(executionPlan.documentReviewMode || 'full-readiness')]
      : []),
  ];
  return { content: lines.join('\n'), executionPlan };
}

function trustedReadinessReceiptSection(options) {
  if (!options.readinessReceipt) return { content: '', verified: null };
  if (!options.repo) throw new Error('repo is required with readinessReceipt');
  const verified = verifyReadinessReceipt({
    repo: options.repo,
    receiptPath: options.readinessReceipt,
  });
  const bounded = {
    status: verified.status,
    scope_sha256: verified.scope_sha256,
    risk: verified.risk,
    deferred_findings: verified.deferred_findings,
  };
  return {
    content: JSON.stringify(bounded, null, 2),
    verified,
  };
}

function markerLine(name, side) {
  return `<!-- ${name}:${side} -->`;
}

export function extractAnchoredBlock(text, name) {
  if (typeof text !== 'string') throw new TypeError('anchor source must be a string');
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('anchor name must be a non-empty string');
  }
  const lines = text.split(/\r\n|\n|\r/);
  const startMarker = markerLine(name, 'start');
  const endMarker = markerLine(name, 'end');
  const starts = [];
  const ends = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === startMarker) starts.push(index);
    if (lines[index].trim() === endMarker) ends.push(index);
  }
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(`${name} marker count must be exactly one pair`);
  }
  if (starts[0] >= ends[0]) throw new Error(`${name} markers are reversed`);
  const body = lines.slice(starts[0] + 1, ends[0]).join('\n').replace(/\n+$/g, '');
  if (body.replace(/\s/g, '') === '') throw new Error(`${name} anchor body is empty`);
  return body;
}

export function extractFalsePositiveDoctrine(criteriaText) {
  const doctrine = extractAnchoredBlock(criteriaText, 'fp-doctrine');
  const conservative = extractAnchoredBlock(criteriaText, 'fp-conservative');
  const bulletCount = doctrine.split('\n').filter((line) => /^\s*-/.test(line)).length;
  if (bulletCount < 6) throw new Error(`fp-doctrine requires at least six bullets, got ${bulletCount}`);
  for (const keyword of ['pre-existing', '린터', '추측', '취향', 'named important failure', 'concrete attack path']) {
    if (!doctrine.includes(keyword)) throw new Error(`fp-doctrine missing canonical keyword ${keyword}`);
  }
  for (const keyword of ['impact', 'reachability', 'uncertainty', 'separately']) {
    if (!conservative.includes(keyword)) {
      throw new Error(`fp-conservative missing canonical keyword ${keyword}`);
    }
  }
  if (/VOICE-6|confidence/.test(`${conservative}\n${doctrine}`)) {
    throw new Error('VOICE-6/confidence text must remain outside doctrine anchors');
  }
  return [
    '### Severity — conservative default',
    conservative,
    '',
    '### Findings to suppress / downgrade',
    doctrine,
    '',
  ].join('\n');
}

export function assembleReviewerPayload(sections = {}) {
  let payload = '';
  for (const [title, key] of SECTION_ORDER) {
    const content = sections[key] ?? '';
    if (typeof content !== 'string') throw new TypeError(`${key} must be a string`);
    if (content.length === 0) continue;
    payload += `\n===== ${title} =====\n${content}\n`;
  }
  return payload;
}

function escapePriorRoundsFences(text) {
  // A forged `=====` line inside untrusted prior-round content must never be
  // mistaken for a real `assembleReviewerPayload` section boundary.
  return text.replace(/^=====/gmu, '\\=====');
}

/**
 * Validated ingest for the optional `--prior-rounds-file` advisory context
 * (research §7-6 / plan v2 — explicit flag + verified ingest replaces fixed-
 * path-existence keying). Every rejection reason is pushed to `warnings` and
 * the section is omitted (never truncated, never silently substituted).
 */
export function ingestPriorRounds(options, warnings) {
  if (!options.priorRoundsFile) return '';
  const filePath = options.priorRoundsFile;
  let stat;
  try {
    // lstat (not stat): a symlink must never be trusted regardless of its
    // target — only a genuine regular file is a valid prior-rounds source.
    stat = lstatSync(filePath);
  } catch {
    warnings.push(`prior-rounds-file unreadable (section skipped): ${filePath}`);
    return '';
  }
  if (!stat.isFile()) {
    warnings.push(`prior-rounds-file is not a regular file (section skipped): ${filePath}`);
    return '';
  }
  if (stat.size > PRIOR_ROUNDS_MAX_BYTES) {
    warnings.push(
      `prior-rounds-file exceeds ${PRIOR_ROUNDS_MAX_BYTES} bytes (section skipped, not truncated): ${filePath}`,
    );
    return '';
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    warnings.push(`prior-rounds-file became unreadable (section skipped): ${filePath}`);
    return '';
  }
  const firstLine = raw.split(/\r?\n/u)[0] ?? '';
  const headerMatch = PRIOR_CONTEXT_HEADER_PATTERN.exec(firstLine);
  if (!headerMatch) {
    warnings.push(`prior-rounds-file missing PRIOR-CONTEXT v1 header (section skipped): ${filePath}`);
    return '';
  }
  const headerBaseCommit = headerMatch[2];
  if (options.priorBase && options.priorBase !== headerBaseCommit) {
    warnings.push(
      `prior-rounds-file base_commit mismatch (section skipped): expected ${options.priorBase}, got ${headerBaseCommit}`,
    );
    return '';
  }

  return escapePriorRoundsFences(raw);
}

function contentFromOption(options, valueKey, fileKey) {
  if (options[valueKey] !== undefined) {
    if (typeof options[valueKey] !== 'string') throw new TypeError(`${valueKey} must be a string`);
    return options[valueKey];
  }
  if (!options[fileKey]) return '';
  return readFileSync(options[fileKey], 'utf8');
}

const PREPARED_PLUGIN_ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const escapePrepared = text => text.replace(/^(\\*)=====/gmu, '$1\\=====');
const unescapePrepared = text => text.replace(/^\\(\\*)=====/gmu, '$1=====');
const confirmationFor = (prepared, reviewerId, role) => (prepared?.confirmation_reviewer_ids
  ? prepared.confirmation_reviewer_ids.includes(reviewerId) : role === 'confirmation') ? prepared.confirmation_request : null;

export function buildPreparedReviewerPayload({ executionRoute, evidenceInputs, pluginRoot = PREPARED_PLUGIN_ROOT }) {
  pluginRoot = realpathSync(resolve(pluginRoot));
  if (pluginRoot !== PREPARED_PLUGIN_ROOT) throw new Error('prepared plugin root must resolve to the installed module root');
  validateEvidenceInputs(evidenceInputs);
  const assignment = trustedAssignmentSection({executionRouteJson:JSON.stringify(executionRoute), reviewerId:executionRoute.reviewer_id});
  const prepared = assignment.executionPlan.preparedReview;
  if (!prepared || evidenceHash(evidenceInputs) !== prepared.evidence_digest) throw new Error('prepared payload source mismatch');
  const doctrine = extractFalsePositiveDoctrine(readFileSync(join(pluginRoot,'skills/deep-review-workflow/references/review-criteria.md'),'utf8'));
  return assembleReviewerPayload({assignment:`First read ${join(pluginRoot, 'agents/code-reviewer.md')}. Stay read-only and return the report contract below.\n${assignment.content}`, reviewTarget:canonicalStringify(prepared), doctrine,
    ...Object.fromEntries(Object.entries(evidenceInputs).map(([key,value])=>[key,escapePrepared(value)])),
    reportContract:buildReportContract({artifactPhase:assignment.executionPlan.artifactPhase,
      documentReviewMode:assignment.executionPlan.documentReviewMode, confirmationRequest:confirmationFor(prepared,executionRoute.reviewer_id,assignment.executionPlan.assignmentRole)})});
}

export function verifyPreparedReviewerPayload(payload, executionRoute) {
  if (typeof payload !== 'string') throw new Error('captured payload required');
  const markers = [...payload.matchAll(/^===== (.+) =====\n/gmu)];
  const sections = {};
  for (let index=0;index<markers.length;index+=1) {
    const marker=markers[index];const key=SECTION_ORDER.find(([title])=>title===marker[1])?.[1];
    if (!key || Object.hasOwn(sections,key)) throw new Error('invalid prepared payload boundary');
    const end=markers[index+1] ? markers[index+1].index-1 : payload.length;
    sections[key]=payload.slice(marker.index+marker[0].length,end).replace(/\n$/u,'');
  }
  const evidenceInputs=Object.fromEntries(['context','diff','changeFiles','priorRounds','readinessReceipt'].map(key=>[key,unescapePrepared(sections[key]||'')]));
  if (buildPreparedReviewerPayload({executionRoute,evidenceInputs})!==payload) throw new Error('prepared payload bytes mismatch');
  return {payload_sha256:evidenceHash(payload),payload_bytes:Buffer.byteLength(payload),evidence_digest:evidenceHash(evidenceInputs)};
}

export function buildReviewerPayload(options = {}) {
  const root = resolve(options.pluginRoot ?? resolvePluginRoot());
  const warnings = [];
  const assignment = trustedAssignmentSection(options);
  const readinessReceipt = trustedReadinessReceiptSection(options);
  const prepared = assignment.executionPlan?.preparedReview;
  let evidenceInputs = null;
  if (prepared) {
    if (!options.repo || !options.evidenceInputsFile) throw new Error('prepared route requires repo and evidence-inputs-file');
    evidenceInputs = validateEvidenceInputs(readControlFile(options.repo, options.evidenceInputsFile));
    if (evidenceHash(evidenceInputs) !== prepared.evidence_digest) throw new Error('prepared evidence digest mismatch');
    if (evidenceInputs.readinessReceipt !== readinessReceipt.content) throw new Error('readiness evidence requires matching verified receipt');
  } else if (options.evidenceInputsFile) {
    throw new Error('evidence-inputs-file requires a prepared route');
  }
  let doctrine = '';
  try {
    const criteriaPath = join(
      root,
      'skills',
      'deep-review-workflow',
      'references',
      'review-criteria.md',
    );
    doctrine = extractFalsePositiveDoctrine(readFileSync(criteriaPath, 'utf8'));
  } catch {
    warnings.push(DOCTRINE_WARNING);
  }

  let changeFiles = '';
  let changeFilesCount = 0;
  let changeFilesStatus = 'not-requested';
  let binaryOmitted = null;
  if (options.changeState) {
    try {
      const records = buildChangeFiles({
        repo: options.repo ?? '.',
        changeState: options.changeState,
        reviewBase: options.reviewBase,
        filesFromZ: options.filesFromZ,
        maxEntries: options.maxEntries,
        maxBytes: options.maxBytes,
      });
      const detailed = serializeChangeFilesDetailed(records);
      changeFiles = detailed.text;
      changeFilesCount = records.length;
      changeFilesStatus = 'ok';
      const diagnostics = detailed.binaryDiagnostics;
      binaryOmitted = {
        count: diagnostics.total,
        classifiedBy: diagnostics.classifiedBy,
        omittedAt: diagnostics.omittedAt,
        records: diagnostics.records,
        listed: diagnostics.listed,
        unlisted: diagnostics.unlisted,
        digest: diagnostics.digest,
      };
      if (diagnostics.total > 0) {
        const shown = diagnostics.records
          .map((entry) => escapeDisplayControls(JSON.stringify(entry.path)))
          .join(', ');
        warnings.push(
          `change-files: ${diagnostics.total} binary-classified path(s) withheld from the manifest rows `
          + `(git-numstat\u00d7${diagnostics.classifiedBy['git-numstat']}, `
          + `untracked-nul-sniff\u00d7${diagnostics.classifiedBy['untracked-nul-sniff']}; `
          + `builder\u00d7${diagnostics.omittedAt.builder}, serializer\u00d7${diagnostics.omittedAt.serializer}): ${shown}`,
        );
      }
    } catch (error) {
      changeFilesStatus = 'failed';
      binaryOmitted = null;
      warnings.push(`change-files construction failed (section skipped): ${error.message}`);
    }
  }

  const context = evidenceInputs?.context ?? contentFromOption(options, 'context', 'contextFile');
  const diff = evidenceInputs?.diff ?? contentFromOption(options, 'diff', 'diffFile');
  const priorRounds = evidenceInputs ? escapePriorRoundsFences(evidenceInputs.priorRounds) : ingestPriorRounds(options, warnings);
  if (evidenceInputs) changeFiles = evidenceInputs.changeFiles;
  const reportContract = (prepared?.confirmation_request || CONTRACT_PAYLOAD_REVIEWERS.has(options.reviewerId))
    ? buildReportContract({
      artifactPhase: assignment.executionPlan?.artifactPhase ?? null,
      documentReviewMode: assignment.executionPlan?.documentReviewMode ?? null,
      confirmationRequest: confirmationFor(prepared,options.reviewerId,assignment.executionPlan?.assignmentRole),
    })
    : '';
  const legacyPayload = assembleReviewerPayload({
    assignment: assignment.content,
    reviewTarget: prepared ? JSON.stringify(prepared) : '',
    readinessReceipt: readinessReceipt.content,
    doctrine,
    changeFiles,
    context,
    priorRounds,
    diff,
    reportContract,
  });
  const executionRoute = prepared ? (options.executionRouteJson ? JSON.parse(options.executionRouteJson) : JSON.parse(readFileSync(options.routingPlan,'utf8')).routes.find(route=>route.reviewer_id===options.reviewerId)) : null;
  const payload = prepared ? buildPreparedReviewerPayload({executionRoute:{protocol_version:'3.0',...executionRoute},evidenceInputs,pluginRoot:root}) : legacyPayload;
  const promptFile = makeSecureTempPath('deep-review-prompt', '.md');
  atomicWriteFile(promptFile, payload, { encoding: 'utf8', mode: 0o600 });
  return {
    promptFile: resolve(promptFile),
    ...(prepared ? {payload_sha256:evidenceHash(payload),payload_bytes:Buffer.byteLength(payload),evidence_digest:prepared.evidence_digest} : {}),
    warnings,
    changeFilesCount,
    changeFilesStatus,
    binaryOmitted,
    ...(assignment.executionPlan ? {
      assignmentRole: assignment.executionPlan.assignmentRole,
      rubricId: assignment.executionPlan.rubricId,
      wave: assignment.executionPlan.wave,
    } : {}),
    ...(readinessReceipt.verified ? {
      readinessScopeSha256: readinessReceipt.verified.scope_sha256,
      readinessRisk: readinessReceipt.verified.risk,
    } : {}),
  };
}

function parseArguments(argv) {
  const options = {};
  const mappings = new Map([
    ['--plugin-root', 'pluginRoot'],
    ['--repo', 'repo'],
    ['--change-state', 'changeState'],
    ['--review-base', 'reviewBase'],
    ['--files-from-z', 'filesFromZ'],
    ['--context-file', 'contextFile'],
    ['--diff-file', 'diffFile'],
    ['--prior-rounds-file', 'priorRoundsFile'],
    ['--prior-base', 'priorBase'],
    ['--routing-plan', 'routingPlan'],
    ['--execution-route-json', 'executionRouteJson'],
    ['--reviewer-id', 'reviewerId'],
    ['--readiness-receipt', 'readinessReceipt'],
    ['--evidence-inputs-file', 'evidenceInputsFile'],
    ['--max-entries', 'maxEntries'],
    ['--max-bytes', 'maxBytes'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = mappings.get(argv[index]);
    if (!key) throw new Error(`unknown argument: ${argv[index]}`);
    if (argv[index + 1] === undefined) throw new Error(`${argv[index]} requires a value`);
    options[key] = argv[index + 1];
    index += 1;
  }
  options.maxEntries ??= process.env.OCR_CHANGE_FILES_MAX_ENTRIES;
  options.maxBytes ??= process.env.OCR_CHANGE_FILES_MAX_BYTES;
  return options;
}

export function runBuildReviewerPayloadCli(argv = process.argv.slice(2)) {
  const result = buildReviewerPayload(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  try {
    runBuildReviewerPayloadCli();
  } catch (error) {
    process.stderr.write(`build-reviewer-payload: ${error.message}\n`);
    process.exitCode = 2;
  }
}
