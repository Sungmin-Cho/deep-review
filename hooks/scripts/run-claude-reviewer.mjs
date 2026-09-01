#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveExecutable, runProcess } from './lib/process.mjs';
import { atomicWriteFile, resolvePluginRoot } from './lib/runtime-context.mjs';
import { loadExecutionPlan, parseExecutionRouteJson } from './lib/execution-plan.mjs';

const AUTH_PATTERN = /Reauthentication required|do not currently have an active account|OAuth token expired|Please run.*claude.*login|Not signed in|Authentication failed/iu;
// J4: mirrors run-agy-reviewer.mjs's UNSUPPORTED_MODEL_PATTERN so an explicit
// catalog-incomplete Claude model that passes preflight but is rejected by
// the CLI at execution time can be retried once without --model when the
// execution plan authorizes fallback.
const UNSUPPORTED_MODEL_PATTERN = /unsupported[^\n]*(?:model|--model)|unknown[^\n]*(?:model|--model)|invalid[^\n]*model|unrecognized[^\n]*--model/iu;

// J6: parity with run-agy-reviewer.mjs's SAFE_MODEL_PATTERN defense-in-depth
// guard - a plan-supplied model must never reach argv carrying NUL, newline,
// or other control characters. Deliberately more permissive than agy's
// allowlist pattern: existing Claude routing plans legitimately carry '=',
// backslashes, spaces, and non-ASCII model labels (see
// tests/adapter-boundary.test.js and tests/routing-integration.test.js), so
// only C0 control bytes and DEL are treated as unsafe.
function hasUnsafeModelCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty NUL-free string`);
  }
  return value;
}

function positiveSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new TypeError('timeoutSeconds must be positive');
  }
  return seconds;
}

// J4: remove a --model FLAG_VALUE pair from an already-built argv array so
// the retry invocation falls through to the provider default.
function stripModelFlag(args) {
  const index = args.indexOf('--model');
  if (index === -1) return args;
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function classify(result) {
  const stderr = result.stderr.toString('utf8');
  if (result.code === 124 || result.timedOut) return 'timeout';
  if (result.code !== 0 && AUTH_PATTERN.test(stderr)) return 'not_authenticated';
  if (result.code !== 0 || result.stdout.length === 0) return 'failed';
  return 'success';
}

// J6: warnings (e.g. an omitted unsafe-character model) are surfaced ahead of
// the process stderr tail so they remain visible even when the stderr tail
// is later truncated to the last 5 lines.
function publishResult(outputFile, result, status, warnings = []) {
  atomicWriteFile(outputFile, result.stdout, { mode: 0o600 });
  atomicWriteFile(`${outputFile}.status`, `${status}\n`, { encoding: 'utf8', mode: 0o600 });
  const stderrLines = result.stderr.toString('utf8').split(/\r?\n/u).filter(Boolean);
  const tail = [...warnings, ...stderrLines].slice(-5);
  atomicWriteFile(
    `${outputFile}.stderr-tail`,
    tail.length ? `${tail.join('\n')}\n` : '',
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function runClaudeReviewer(options = {}) {
  const projectRoot = resolve(requiredString(options.projectRoot, 'projectRoot'));
  const pluginRoot = resolve(requiredString(options.pluginRoot, 'pluginRoot'));
  const promptFile = resolve(requiredString(options.promptFile, 'promptFile'));
  const outputFile = resolve(requiredString(options.outputFile, 'outputFile'));
  const executionPlan = options.executionPlan || null;
  // H4B: when an execution plan is supplied, its resolved model is
  // authoritative — including null (provider default). The legacy
  // options.model ?? 'opus' only applies when no plan is present; it must
  // never resurrect a stale model once a plan deliberately resolved to null.
  // Mirrors the agy fix (d0459e9) in run-agy-reviewer.mjs.
  let model = executionPlan
    ? (executionPlan.model ?? '')
    : requiredString(options.model ?? 'opus', 'model');
  if (typeof model !== 'string') throw new TypeError('model must be a string');
  const warnings = [];
  // J6: a plan-supplied model carrying NUL/newline/control characters must
  // never be pushed as an argv token. A strict cli- source without
  // allowFallback fails closed (parity with agy's ERROR_UNSUPPORTED_MODEL);
  // any other source omits --model with a visible warning instead. This runs
  // before the --model push below and before any process spawn, and does not
  // touch the J4 execution-time retry logic further down.
  if (model && hasUnsafeModelCharacters(model)) {
    if (executionPlan?.source?.startsWith('cli-') && !executionPlan.allowFallback) {
      throw new Error('ERROR_UNSUPPORTED_MODEL: explicit claude model contains unsupported characters');
    }
    warnings.push('model contained unsupported characters and was omitted');
    model = '';
  }
  const agent = requiredString(options.agent ?? 'code-reviewer', 'agent');
  const timeoutSeconds = positiveSeconds(options.timeoutSeconds ?? 1200);
  const env = { ...(options.env ?? process.env) };
  const processRunner = options.processRunner ?? runProcess;
  const binary = options.binary
    ? requiredString(options.binary, 'binary')
    : (resolveExecutable('claude', env) || 'claude');
  const prompt = readFileSync(promptFile);

  const args = [
    '-p',
    '--plugin-dir', pluginRoot,
    '--agent', agent,
  ];
  if (model) args.push('--model', model);
  let resolvedEffort = executionPlan?.effort ?? null;
  let executionFallback = null;
  if (resolvedEffort) {
    const effortTransport = executionPlan.effortTransport || 'unknown';
    if (effortTransport.startsWith('flag:')) {
      args.push(effortTransport.slice('flag:'.length), resolvedEffort);
    } else if (effortTransport.startsWith('env:')) {
      env[effortTransport.slice('env:'.length)] = resolvedEffort;
    } else if (executionPlan.source?.startsWith('cli-') && !executionPlan.allowFallback) {
      throw new Error('ERROR_EFFORT_TRANSPORT_UNAVAILABLE: explicit effort cannot be sent to Claude CLI');
    } else {
      executionFallback = {
        occurred: true,
        requested: { effort: resolvedEffort },
        applied: { effort: null },
        reason: 'effort transport unavailable; effort omitted',
      };
      resolvedEffort = null;
    }
  }
  args.push(
    '--permission-mode', 'dontAsk',
    '--add-dir', projectRoot,
    '--tools', 'Read,Glob,Grep,Bash',
    '--output-format', 'text',
  );
  let processResult = await processRunner(binary, args, {
    cwd: projectRoot,
    env,
    input: prompt,
    timeoutMs: timeoutSeconds * 1000,
  });
  // J4: when the CLI rejects an explicit model at execution time (not a
  // preflight rejection), retry exactly once without --model — but only when
  // the execution plan authorizes fallback. A strict cli- source without
  // allow_fallback keeps the single-run failure; auth/timeout/empty-output
  // failures are never retried.
  let modelFallback = null;
  const firstStderr = processResult.stderr.toString('utf8');
  if (
    model
    && processResult.code !== 0
    && processResult.code !== 124
    && !processResult.timedOut
    && !AUTH_PATTERN.test(firstStderr)
    && UNSUPPORTED_MODEL_PATTERN.test(firstStderr)
    && executionPlan?.allowFallback === true
  ) {
    processResult = await processRunner(binary, stripModelFlag(args), {
      cwd: projectRoot,
      env,
      input: prompt,
      timeoutMs: timeoutSeconds * 1000,
    });
    modelFallback = {
      occurred: true,
      requested: { model },
      applied: { model: null },
      reason: 'claude rejected requested model; retried without --model',
    };
  }
  const status = classify(processResult);
  publishResult(outputFile, processResult, status, warnings);
  return {
    status,
    code: processResult.code,
    timedOut: processResult.timedOut,
    stdout: processResult.stdout.toString('utf8'),
    stderr: processResult.stderr.toString('utf8'),
    outputFile,
    requested_model: executionPlan?.requestedModel ?? executionPlan?.model ?? (model || null),
    resolved_model: modelFallback ? null : (model || null),
    applied_model: null,
    requested_effort: executionPlan?.requestedEffort ?? executionPlan?.effort ?? null,
    resolved_effort: resolvedEffort,
    applied_effort: null,
    verification_status: (executionFallback || modelFallback) ? 'fallback' : 'provider-did-not-report',
    fallback: modelFallback || executionFallback || executionPlan?.routingFallback || { occurred: false },
  };
}

export function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const key = {
      '--project-root': 'projectRoot',
      '--plugin-root': 'pluginRoot',
      '--prompt-file': 'promptFile',
      '--output': 'outputFile',
      '--model': 'model',
      '--agent': 'agent',
      '--timeout-seconds': 'timeoutSeconds',
      '--timeout': 'timeoutSeconds',
      '--binary': 'binary',
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
  if (executionSourceCount > 1
      || (executionSourceCount === 1) !== hasReviewerId) {
    throw new Error('exactly one execution source (--routing-plan or --execution-route-json) and --reviewer-id must be provided together');
  }
  return values;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: run-claude-reviewer.mjs --project-root DIR --plugin-root DIR --prompt-file FILE --output FILE [--model MODEL] [(--routing-plan FILE | --execution-route-json JSON) --reviewer-id ID] [--agent NAME] [--timeout-seconds N]\n');
    return;
  }
  options.pluginRoot ??= resolvePluginRoot();
  if (options.executionRouteJson) {
    options.executionPlan = parseExecutionRouteJson(options.executionRouteJson, options.reviewerId);
  } else if (options.routingPlan) {
    options.executionPlan = loadExecutionPlan(options.routingPlan, options.reviewerId);
  }
  const result = await runClaudeReviewer(options);
  process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`run-claude-reviewer.mjs: ${error.message}\n`);
    process.exitCode = error.code === 'ENOENT' ? 127 : 2;
  });
}
