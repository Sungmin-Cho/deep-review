#!/usr/bin/env node

// The Grok bridge core (SLICE-008a).
//
// Four decisions become executable here and nowhere else:
//
//   D11/E3  exactly one authorized model and one declared effort, as adjacent
//           literal token pairs, source-independently, with no retry and no
//           fallback that could substitute either.
//   D12     preventive read-only argv: a closed flag grammar, a forbidden-token
//           set rejected at construction, and a scrubbed `GROK_SANDBOX`.
//   I26     conversation isolation: one bridge-generated fresh UUID per
//           attempt, memory and subagents structurally disabled, every
//           resume/reuse/continue/fork escape hatch refused.
//   D8/D18  lossless prompt transport through the shared module, over a sealed
//           protocol-3 compatibility carrier that is consumed, never re-probed.
//
// D16 (SLICE-008b): the Artifact Gate is injected by exactly one layer, here,
// through `buildReportContract` — the canonical source in
// `lib/report-contract.mjs`. Returned document-phase reports are validated
// against the canonical `parseArtifactGate` imported from
// `document-readiness.mjs`; the bridge never reimplements a heading counter
// or a partial schema. Containment/process-tree lifecycle (SLICE-008c)
// remains a separate seam, entering through `containmentToken` and the
// injectable `processRunner`.

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { prepareExternalPrivacy } from './lib/agy-privacy.mjs';
import { ARTIFACT_GATE_ERROR_CODES, parseArtifactGate } from './document-readiness.mjs';
import { loadExecutionPlan, parseExecutionRouteJson } from './lib/execution-plan.mjs';
import { captureFingerprint } from './lib/fingerprint.mjs';
import { validateGrokCompatibilityCarrier } from './lib/grok-compatibility-carrier.mjs';
import { runProcess } from './lib/process.mjs';
// D8: the host argument budget lives in one place. The bridge never restates
// a platform limit, so a Windows ceiling can never drift between the two.
import {
  cleanupPromptFile,
  createPromptFile,
  selectPromptTransport,
  verifyPromptIdentity,
} from './lib/prompt-transport.mjs';
import { buildReportContract } from './lib/report-contract.mjs';
import { atomicWriteFile, resolvePluginRoot } from './lib/runtime-context.mjs';
import { parseReviewerReport } from './review-synthesis.mjs';

export const GROK_AUTHORIZED_MODEL = 'grok-4.6';
export const GROK_SUPPORTED_EFFORTS = Object.freeze(['low', 'medium', 'high']);

const DEFAULT_MAX_TURNS = 6;
const DEFAULT_TIMEOUT_SECONDS = 900;
const PENDING_PROMPT_FILE = '<pending-derived-prompt-file>';
const ACCEPTED_PRIVACY_OUTCOMES = new Set(['auto_ack', 'acknowledged']);
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const AUTH_PATTERN = /Reauthentication required|do not currently have an active account|OAuth token expired|Please run.*grok.*login|Not signed in|Authentication failed/iu;
const UNSUPPORTED_MODEL_PATTERN = /unsupported[^\n]*(?:model|--model)|unknown[^\n]*(?:model|--model)|invalid[^\n]*model|unrecognized[^\n]*--model/iu;

// D12's closed argv grammar. Anything in flag position that is not here is
// refused, which is what makes the forbidden-token list a diagnostic rather
// than the only barrier — and what keeps a prompt *value* containing the text
// `--dangerously-skip-permissions` from being read as a flag.
const VALUE_FLAGS = Object.freeze([
  '--single',
  '--prompt-file',
  '--model',
  '--reasoning-effort',
  '--permission-mode',
  '--sandbox',
  '--cwd',
  '--output-format',
  '--max-turns',
  '--session-id',
]);
const BOOLEAN_FLAGS = Object.freeze(['--no-memory', '--no-subagents']);
const FORBIDDEN_ARGV_TOKENS = Object.freeze([
  // Permission and sandbox escapes.
  '--dangerously-skip-permissions',
  '--always-approve',
  '--allow',
  '--allowedTools',
  '--no-plan',
  '--restore-code',
  '-w',
  '--worktree',
  // Session and history escapes (I26).
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  '--experimental-memory',
  '--agents',
  '--agent',
  // D11's flag-spelling rule: the short model alias never appears.
  '-m',
]);

// Session control is the bridge's, not the caller's. Naming the refused option
// keys makes "resume, reuse, continue, fork, memory and subagent flags are
// rejected" enforceable one level above argv, where a caller would reach first.
const FORBIDDEN_SESSION_OPTIONS = Object.freeze([
  'sessionId',
  'session_id',
  'resume',
  'resumeSessionId',
  'continue',
  'continueSession',
  'forkSession',
  'reuseSession',
  'memory',
  'experimentalMemory',
  'agents',
  'agent',
  'noMemory',
  'noSubagents',
  'extraArgs',
  'args',
  'argv',
]);

const GROK_READONLY_PREAMBLE = `READ-ONLY REVIEW MODE - ABSOLUTE, NON-NEGOTIABLE CONSTRAINT
============================================================
You are a code reviewer running in STRICT READ-ONLY mode. You MUST NOT modify
the workspace in ANY way. You are forbidden from creating, editing, deleting,
moving, renaming, staging, or committing files, and from running state-mutating
commands. Analyze and report in text only. Describe fixes in prose; never apply
them. Any workspace mutation invalidates this review.
============================================================
The review request follows below.
============================================================

`;

// I16: any gate in a code-phase result is invalid because the document
// parser is not applicable there — that phase-only rule stays at the bridge.
const GATE_HEADING_PATTERN = /^## Artifact Gate[ \t]*$/mu;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty NUL-free string`);
  }
  return value;
}

function positiveSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new TypeError('timeoutSeconds must be positive');
  return seconds;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

// ---------------------------------------------------------------------------
// D11 / E3 — authorization, evaluated before argv exists and again as the
// terminal assertion, so a regression upstream still fails closed here.
// ---------------------------------------------------------------------------

export function assertAuthorizedGrokModel(model) {
  if (model !== GROK_AUTHORIZED_MODEL) {
    throw new Error(
      `ERROR_UNSUPPORTED_MODEL: grok authorizes exactly ${GROK_AUTHORIZED_MODEL}; refusing ${JSON.stringify(model ?? null)}`,
    );
  }
  return model;
}

export function assertAuthorizedGrokEffort(effort) {
  if (typeof effort !== 'string' || !GROK_SUPPORTED_EFFORTS.includes(effort)) {
    throw new Error(
      `ERROR_UNSUPPORTED_EFFORT: grok --reasoning-effort must be one of ${GROK_SUPPORTED_EFFORTS.join('|')}; refusing ${JSON.stringify(effort ?? null)}`,
    );
  }
  return effort;
}

function forbidden(token, detail) {
  return new Error(`ERROR_FORBIDDEN_GROK_ARGV: ${token}${detail ? ` — ${detail}` : ''}`);
}

// The terminal argv assertion. It parses rather than scans: every token is
// either a known flag or the value of the flag immediately before it, so
// occurrence counting and adjacency are both exact.
export function validateGrokArgv(args) {
  if (!Array.isArray(args) || args.some((token) => typeof token !== 'string')) {
    throw new TypeError('grok argv must be an array of strings');
  }
  const counts = new Map();
  const values = new Map();
  const bump = (flag) => counts.set(flag, (counts.get(flag) ?? 0) + 1);

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (FORBIDDEN_ARGV_TOKENS.includes(token)) {
      throw forbidden(token, 'this token is forbidden in every constructed Grok argv');
    }
    if (BOOLEAN_FLAGS.includes(token)) {
      bump(token);
      continue;
    }
    if (!VALUE_FLAGS.includes(token)) {
      throw forbidden(token, 'unknown token in flag position');
    }
    if (index + 1 >= args.length) {
      throw forbidden(token, 'flag has no adjacent value');
    }
    bump(token);
    values.set(token, args[index + 1]);
    index += 1;
  }

  const exactlyOnce = (flag) => {
    const count = counts.get(flag) ?? 0;
    if (count !== 1) {
      throw forbidden(flag, `must appear exactly once, saw ${count}`);
    }
  };
  const pinned = (flag, expected) => {
    exactlyOnce(flag);
    if (values.get(flag) !== expected) {
      throw forbidden(flag, `must be immediately followed by ${expected}, saw ${JSON.stringify(values.get(flag))}`);
    }
  };

  pinned('--model', GROK_AUTHORIZED_MODEL);
  exactlyOnce('--reasoning-effort');
  const effort = values.get('--reasoning-effort');
  if (!GROK_SUPPORTED_EFFORTS.includes(effort)) {
    throw forbidden('--reasoning-effort', `must be one of ${GROK_SUPPORTED_EFFORTS.join('|')}, saw ${JSON.stringify(effort)}`);
  }
  pinned('--permission-mode', 'plan');
  pinned('--sandbox', 'read-only');
  pinned('--output-format', 'plain');
  exactlyOnce('--cwd');
  const cwd = values.get('--cwd');
  if (typeof cwd !== 'string' || cwd.length === 0) throw forbidden('--cwd', 'must carry a non-empty path');
  exactlyOnce('--max-turns');
  if (!/^[1-9][0-9]*$/u.test(values.get('--max-turns'))) {
    throw forbidden('--max-turns', 'must be a positive integer');
  }
  exactlyOnce('--session-id');
  const sessionId = values.get('--session-id');
  if (!CANONICAL_UUID.test(sessionId)) {
    throw forbidden('--session-id', `must be a canonical UUID, saw ${JSON.stringify(sessionId)}`);
  }
  exactlyOnce('--no-memory');
  exactlyOnce('--no-subagents');

  const transports = (counts.get('--single') ?? 0) + (counts.get('--prompt-file') ?? 0);
  if (transports !== 1) {
    throw forbidden('--single/--prompt-file', `exactly one prompt transport is required, saw ${transports}`);
  }

  return {
    model: values.get('--model'),
    effort,
    cwd,
    maxTurns: Number(values.get('--max-turns')),
    sessionId,
    transport: counts.get('--single') ? 'inline' : 'prompt-file',
  };
}

// ---------------------------------------------------------------------------
// D12 — the one argv shape, selected losslessly between the two transports.
// ---------------------------------------------------------------------------

export function buildGrokArgv({
  model,
  effort,
  projectRoot,
  sessionId,
  maxTurns = DEFAULT_MAX_TURNS,
  binary,
  platform = process.platform,
  promptBytes,
  promptFilePath,
} = {}) {
  assertAuthorizedGrokModel(model);
  assertAuthorizedGrokEffort(effort);
  requiredString(projectRoot, 'projectRoot');
  requiredString(binary, 'binary');
  positiveInteger(maxTurns, 'maxTurns');
  if (!CANONICAL_UUID.test(String(sessionId))) {
    throw new Error(`ERROR_INVALID_GROK_SESSION_ID: ${JSON.stringify(sessionId ?? null)} is not a bridge-generated canonical UUID`);
  }

  const fixedArgs = [
    '--model', model,
    '--reasoning-effort', effort,
    '--permission-mode', 'plan',
    '--sandbox', 'read-only',
    '--cwd', projectRoot,
    '--output-format', 'plain',
    '--max-turns', String(maxTurns),
    '--session-id', sessionId,
    '--no-memory',
    '--no-subagents',
  ];

  const selection = selectPromptTransport({
    binary,
    platform,
    promptBytes,
    promptFilePath,
    fixedArgs,
  });
  const summary = validateGrokArgv(selection.args);
  return {
    ...selection,
    summary,
    argvSha256: sha256(Buffer.from(JSON.stringify(selection.args), 'utf8')),
  };
}

// ---------------------------------------------------------------------------
// D18 — the sealed carrier is consumed, and its failure precedes everything.
// ---------------------------------------------------------------------------

function consumeCompatibilityEvidence(plan) {
  const evidence = plan && typeof plan === 'object' ? plan.grokCompatibilityEvidence : undefined;
  if (evidence === null || evidence === undefined) {
    throw new Error('ERROR_INCOMPATIBLE_GROK_CLI: the execution route carries no sealed Grok compatibility evidence');
  }
  try {
    return validateGrokCompatibilityCarrier(evidence);
  } catch (error) {
    throw new Error(`ERROR_INCOMPATIBLE_GROK_CLI: ${error.message}`);
  }
}

function sealedLauncher(carrier, supplied) {
  if (supplied === undefined || supplied === null) return carrier.launcher_path;
  const requested = resolve(requiredString(supplied, 'binary'));
  if (requested !== carrier.launcher_path) {
    throw new Error(
      `ERROR_INCOMPATIBLE_GROK_CLI: requested launcher ${requested} is not the sealed ${carrier.launcher_path}`,
    );
  }
  return carrier.launcher_path;
}

// ---------------------------------------------------------------------------
// I26 — session control belongs to the bridge.
// ---------------------------------------------------------------------------

function rejectForbiddenSessionOptions(options) {
  for (const key of FORBIDDEN_SESSION_OPTIONS) {
    if (Object.hasOwn(options, key)) {
      throw new Error(
        `ERROR_FORBIDDEN_GROK_SESSION_OPTION: ${key} — every attempt is isolated by a bridge-generated fresh session with memory and subagents disabled`,
      );
    }
  }
}

function freshSessionId(uuidGenerator) {
  const sessionId = uuidGenerator();
  if (typeof sessionId !== 'string' || !CANONICAL_UUID.test(sessionId)) {
    throw new Error(`ERROR_INVALID_GROK_SESSION_ID: ${JSON.stringify(sessionId ?? null)} is not a canonical UUID`);
  }
  return sessionId;
}

// `GROK_SANDBOX` would override the explicit `--sandbox read-only` flag, so it
// is removed from the child environment — case-insensitively, because native
// Windows environment names are.
function childEnvironment(parentEnv) {
  const env = { ...parentEnv };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'grok_sandbox') delete env[key];
  }
  return env;
}

// ---------------------------------------------------------------------------
// Prompt composition and terminal bookkeeping.
// ---------------------------------------------------------------------------

function composeGrokPrompt({ body, reportContract }) {
  return Buffer.concat([
    Buffer.from(GROK_READONLY_PREAMBLE, 'utf8'),
    Buffer.from(reportContract, 'utf8'),
    Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'),
  ]);
}

function fingerprintChanged(before, after) {
  if (before.error || after.error) {
    return {
      changed: true,
      reason: before.error ? `pre-snapshot failed: ${before.error}` : `post-snapshot failed: ${after.error}`,
    };
  }
  if (before.mode === 'off' && after.mode === 'off') return { changed: false, reason: '' };
  if (before.digest !== after.digest) return { changed: true, reason: 'fingerprint drift' };
  return { changed: false, reason: '' };
}

function terminalStatus({ mutation, processResult }) {
  if (mutation) return 'mutated';
  if (processResult.code === 124 || processResult.timedOut) return 'timeout';
  const stderr = processResult.stderr.toString('utf8');
  if (processResult.code !== 0 && AUTH_PATTERN.test(stderr)) return 'not_authenticated';
  if (processResult.code !== 0 || processResult.stdout.length === 0) return 'failed';
  return 'success';
}

// `artifactGateValidator` receives the strict-parsed report and the artifact
// phase, and returns whether it passes. Production always supplies
// `makeDefaultArtifactGateValidator` below; a caller-supplied override exists
// only for tests exercising `normalizeGrokReport` in isolation.
function normalizeGrokReport(output, { artifactPhase = null, artifactGateValidator = null } = {}) {
  const parsed = parseReviewerReport(output, { strict: true });
  if (parsed === null) return null;
  if (typeof artifactGateValidator === 'function') {
    return artifactGateValidator({ output, parsed, artifactPhase }) ? parsed : null;
  }
  return parsed;
}

// D16's one canonical validation path. Document-phase reports go through the
// same `parseArtifactGate` that `document-readiness.mjs` uses, so a
// malformed gate is rejected identically wherever it is checked — no local
// heading counter or partial schema. The phase-only rule (I16: a gate is
// document-scope only) is the one thing the canonical parser can't tell us,
// because it isn't applicable outside document phase, so it stays local.
function makeDefaultArtifactGateValidator(warnings) {
  return function defaultArtifactGateValidator({ output, artifactPhase }) {
    if (artifactPhase === 'document') {
      try {
        parseArtifactGate(output);
        return true;
      } catch (error) {
        warnings.push(`${error.code ?? ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA}: ${error.message}`);
        return false;
      }
    }
    if (GATE_HEADING_PATTERN.test(output)) {
      warnings.push('ERROR_GROK_GATE_UNEXPECTED_PHASE: an Artifact Gate is document-scope only');
      return false;
    }
    return true;
  };
}

function publishTerminalFiles(outputFile, processResult, status, warnings, mutationReason) {
  atomicWriteFile(outputFile, processResult.stdout, { mode: 0o600 });
  atomicWriteFile(`${outputFile}.status`, `${status}\n`, { encoding: 'utf8', mode: 0o600 });
  const stderrLines = processResult.stderr.toString('utf8').split(/\r?\n/u).filter(Boolean);
  const tail = [...warnings, ...stderrLines].slice(-5);
  atomicWriteFile(
    `${outputFile}.stderr-tail`,
    tail.length ? `${tail.join('\n')}\n` : '',
    { encoding: 'utf8', mode: 0o600 },
  );
  if (status === 'mutated') {
    atomicWriteFile(
      `${outputFile}.mutation-warning`,
      `mutated (${mutationReason || 'fingerprint drift'})\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } else {
    rmSync(`${outputFile}.mutation-warning`, { force: true });
  }
}

async function releasePromptFile(derived) {
  if (!derived) return { ok: true, reason: null, detail: null };
  const outcome = await cleanupPromptFile(derived.record, { handle: derived.handle });
  await derived.handle.close();
  return outcome;
}

// ---------------------------------------------------------------------------
// The bridge.
// ---------------------------------------------------------------------------

export async function runGrokReviewer(options = {}) {
  rejectForbiddenSessionOptions(options);

  // D18 first: missing, malformed or seal-mismatched evidence fails before
  // privacy, prompt composition, fingerprinting, session creation and spawn.
  const plan = options.executionPlan ?? null;
  const carrier = consumeCompatibilityEvidence(plan);
  const binary = sealedLauncher(carrier, options.binary);

  // D11 upstream belt. `buildGrokArgv` re-asserts both as the terminal check.
  const model = assertAuthorizedGrokModel(plan.model);
  const effort = assertAuthorizedGrokEffort(plan.effort);

  const projectRoot = resolve(requiredString(options.projectRoot, 'projectRoot'));
  const pluginRoot = resolve(requiredString(options.pluginRoot, 'pluginRoot'));
  const promptFile = resolve(requiredString(options.promptFile, 'promptFile'));
  const outputFile = resolve(requiredString(options.outputFile, 'outputFile'));
  const configPath = resolve(options.configPath ?? join(projectRoot, '.deep-review', 'config.yaml'));
  const timeoutSeconds = positiveSeconds(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  const maxTurns = positiveInteger(options.maxTurns ?? DEFAULT_MAX_TURNS, 'maxTurns');
  const mode = options.mode ?? 'hybrid';
  const platform = options.platform ?? process.platform;
  const parentEnv = options.env ?? process.env;
  const warnings = [];

  const privacyPreparer = options.privacyPreparer
    ?? ((request) => prepareExternalPrivacy({ ...request, provider: 'grok' }));
  const fingerprintCapturer = options.fingerprintCapturer ?? captureFingerprint;
  // SEAM (SLICE-008c): the contained runner replaces this default, and the
  // post-fingerprint below moves behind its confirmed whole-tree termination.
  const processRunner = options.processRunner ?? runProcess;
  const uuidGenerator = options.uuidGenerator ?? randomUUID;

  const compatibility = {
    version: carrier.version,
    version_build: carrier.version_build,
    evidence_sha256: carrier.evidence_sha256,
    chain_sha256: carrier.prepared_spawn_chain.chain_sha256,
  };
  const refusal = (privacy) => ({
    status: 'failed',
    attempted: false,
    contributes_vote: false,
    privacyOutcome: privacy.outcome,
    privacy,
    compatibility,
    code: null,
  });

  const privacy = await privacyPreparer({
    repo: projectRoot,
    pluginRoot,
    configPath,
    approval: options.approval ?? 'auto',
    now: options.now,
  });
  if (!ACCEPTED_PRIVACY_OUTCOMES.has(privacy.outcome)) return refusal(privacy);

  const before = await fingerprintCapturer({ repo: projectRoot, pluginRoot, mode });
  if (before.warning) warnings.push(before.warning);

  const finalPrivacy = await privacyPreparer({
    repo: projectRoot,
    pluginRoot,
    configPath,
    approval: 'auto',
    now: options.now,
  });
  if (!ACCEPTED_PRIVACY_OUTCOMES.has(finalPrivacy.outcome)
      || finalPrivacy.fingerprint !== privacy.fingerprint) {
    return refusal(finalPrivacy);
  }

  // Prompt integrity precedes session creation (D12): one exact Buffer, its
  // byte length and its digest, before `randomUUID` is called at all.
  const promptBytes = composeGrokPrompt({
    body: readFileSync(promptFile),
    reportContract: options.reportContract ?? buildReportContract({
      artifactPhase: plan.artifactPhase ?? null,
      documentReviewMode: plan.documentReviewMode ?? null,
    }),
  });
  const promptSha256 = sha256(promptBytes);
  const sessionId = freshSessionId(uuidGenerator);

  const argvSpec = {
    model, effort, projectRoot, sessionId, maxTurns, binary, platform, promptBytes,
  };
  let construction = buildGrokArgv({ ...argvSpec, promptFilePath: PENDING_PROMPT_FILE });
  let derived = null;
  let result;

  try {
    if (construction.transport === 'prompt-file') {
      derived = await createPromptFile(promptBytes, { prefix: 'deep-review-grok-prompt', platform });
      construction = buildGrokArgv({ ...argvSpec, promptFilePath: derived.record.path });
      if (construction.transport !== 'prompt-file') {
        throw new Error('ERROR_GROK_PROMPT_TRANSPORT: the derived pathname form changed the selected transport');
      }
      const preSpawn = await verifyPromptIdentity(derived.record, { handle: derived.handle });
      if (!preSpawn.ok) {
        throw new Error(`ERROR_GROK_PROMPT_IDENTITY: ${preSpawn.reason}`);
      }
    }

    const processResult = await processRunner(binary, construction.args, {
      cwd: projectRoot,
      env: childEnvironment(parentEnv),
      timeoutMs: timeoutSeconds * 1000,
      // The chain sealed at detection is re-prepared and compared inside the
      // runner, in this same call, before any child is spawned.
      expectedPreparedSpawnChain: carrier.prepared_spawn_chain,
      ...(options.containmentToken === undefined
        ? {}
        : { containmentToken: options.containmentToken }),
    });

    let identityFailure = null;
    if (derived) {
      const postChild = await verifyPromptIdentity(derived.record, { handle: derived.handle });
      if (!postChild.ok) identityFailure = postChild.reason;
    }

    // SEAM (SLICE-008c): the post-fingerprint moves behind confirmed
    // whole-tree termination once the contained runner reports it.
    const after = await fingerprintCapturer({ repo: projectRoot, pluginRoot, mode });
    if (after.warning && after.warning !== before.warning) warnings.push(after.warning);
    const mutation = fingerprintChanged(before, after);

    let status = terminalStatus({ mutation: mutation.changed, processResult });
    const stderr = processResult.stderr.toString('utf8');
    let errorCode = null;
    // D11 P5: an unsupported-model diagnostic is terminal. There is no second
    // spawn, no retry without `--model`, and no resume.
    if (status !== 'success' && processResult.code !== 0 && UNSUPPORTED_MODEL_PATTERN.test(stderr)) {
      errorCode = 'ERROR_UNSUPPORTED_MODEL';
      warnings.push(`ERROR_UNSUPPORTED_MODEL: grok rejected ${model}; the Grok bridge has no retry path`);
    }
    if (identityFailure !== null) {
      status = status === 'mutated' ? status : 'failed';
      errorCode ??= 'ERROR_GROK_PROMPT_IDENTITY';
      warnings.push(`derived prompt identity changed around the child: ${identityFailure}`);
    }

    const rawStdout = processResult.stdout.toString('utf8');
    const report = status === 'success'
      ? normalizeGrokReport(rawStdout, {
        artifactPhase: plan.artifactPhase ?? null,
        artifactGateValidator: options.artifactGateValidator ?? makeDefaultArtifactGateValidator(warnings),
      })
      : null;
    if (status === 'success' && report === null) status = 'failed';

    publishTerminalFiles(outputFile, processResult, status, warnings, mutation.reason);

    result = {
      status,
      attempted: true,
      contributes_vote: status === 'success',
      privacyOutcome: finalPrivacy.outcome,
      code: processResult.code,
      timedOut: processResult.timedOut,
      stdout: rawStdout,
      raw_stdout: rawStdout,
      stderr,
      report,
      mutation: mutation.changed,
      mutationReason: mutation.reason,
      before,
      after,
      argv: construction.args,
      argv_sha256: construction.argvSha256,
      prompt_transport: construction.transport,
      prompt_bytes: promptBytes.length,
      prompt_sha256: promptSha256,
      truncated: construction.truncated,
      session_isolation: {
        session_id: sessionId,
        fresh: true,
        memory: 'disabled',
        subagents: 'disabled',
      },
      compatibility,
      resolved_model: model,
      resolved_effort: effort,
      error_code: errorCode,
      warnings,
    };
  } finally {
    const cleanup = await releasePromptFile(derived);
    if (!cleanup.ok && result) {
      // D8: a cleanup failure invalidates otherwise successful output.
      result.status = result.status === 'mutated' ? result.status : 'failed';
      result.contributes_vote = false;
      result.report = null;
      result.error_code ??= cleanup.reason;
      result.warnings.push(`${cleanup.reason}: ${cleanup.detail}`);
      publishTerminalFiles(
        outputFile,
        { stdout: Buffer.from(result.raw_stdout, 'utf8'), stderr: Buffer.from(result.stderr, 'utf8') },
        result.status,
        result.warnings,
        result.mutationReason,
      );
    }
  }

  return result;
}

export function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const key = {
      '--binary': 'binary',
      '--project-root': 'projectRoot',
      '--plugin-root': 'pluginRoot',
      '--config': 'configPath',
      '--prompt-file': 'promptFile',
      '--output': 'outputFile',
      '--mode': 'mode',
      '--approval': 'approval',
      '--timeout-seconds': 'timeoutSeconds',
      '--max-turns': 'maxTurns',
      '--routing-plan': 'routingPlan',
      '--execution-route-json': 'executionRouteJson',
      '--reviewer-id': 'reviewerId',
    }[flag];
    if (!key || index + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${flag}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  const hasRoutingPlan = Object.hasOwn(values, 'routingPlan');
  const hasExecutionRouteJson = Object.hasOwn(values, 'executionRouteJson');
  const hasReviewerId = Object.hasOwn(values, 'reviewerId');
  for (const [present, key, flag] of [
    [hasRoutingPlan, 'routingPlan', '--routing-plan'],
    [hasExecutionRouteJson, 'executionRouteJson', '--execution-route-json'],
    [hasReviewerId, 'reviewerId', '--reviewer-id'],
  ]) {
    if (present && values[key].length === 0) throw new Error(`${flag} must be non-empty`);
  }
  const executionSourceCount = Number(hasRoutingPlan) + Number(hasExecutionRouteJson);
  if (executionSourceCount !== 1 || !hasReviewerId) {
    throw new Error('exactly one execution source (--routing-plan or --execution-route-json) and --reviewer-id must be provided together');
  }
  return values;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: run-grok-reviewer.mjs --project-root DIR --plugin-root DIR --prompt-file FILE --output FILE (--routing-plan FILE | --execution-route-json JSON) --reviewer-id grok [--mode MODE] [--timeout-seconds N] [--max-turns N]\n');
    return;
  }
  options.pluginRoot ??= resolvePluginRoot();
  options.executionPlan = options.executionRouteJson
    ? parseExecutionRouteJson(options.executionRouteJson, options.reviewerId)
    : loadExecutionPlan(options.routingPlan, options.reviewerId);
  if (options.timeoutSeconds !== undefined) options.timeoutSeconds = Number(options.timeoutSeconds);
  if (options.maxTurns !== undefined) options.maxTurns = Number(options.maxTurns);
  const result = await runGrokReviewer(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.attempted && result.code !== 0) process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`run-grok-reviewer.mjs: ${error.message}\n`);
    process.exitCode = error.code === 'ENOENT' ? 127 : 2;
  });
}

export const __testing = Object.freeze({
  BOOLEAN_FLAGS,
  FORBIDDEN_ARGV_TOKENS,
  FORBIDDEN_SESSION_OPTIONS,
  GROK_READONLY_PREAMBLE,
  VALUE_FLAGS,
  childEnvironment,
  composeGrokPrompt,
  fingerprintChanged,
  makeDefaultArtifactGateValidator,
  normalizeGrokReport,
  terminalStatus,
});
