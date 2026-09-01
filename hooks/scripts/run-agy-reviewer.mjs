#!/usr/bin/env node

import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { prepareAgyPrivacy } from './lib/agy-privacy.mjs';
import { captureFingerprint } from './lib/fingerprint.mjs';
import { resolveExecutable, runProcess } from './lib/process.mjs';
// D8: the host command-budget estimators are shared, not agy's own. agy
// re-exports them unchanged and keeps its truncating policy below.
import {
  POSIX_PROMPT_ARGUMENT_LIMIT,
  WINDOWS_COMMAND_HEADROOM,
  estimateWindowsCommandUnits,
  windowsCommandLimit,
} from './lib/prompt-transport.mjs';
import { atomicWriteFile, resolvePluginRoot } from './lib/runtime-context.mjs';
import { loadExecutionPlan, parseExecutionRouteJson } from './lib/execution-plan.mjs';
import { parseReviewerReport } from './review-synthesis.mjs';

const BODY_LIMIT = 198_000;
const READONLY_PREAMBLE = `READ-ONLY REVIEW MODE - ABSOLUTE, NON-NEGOTIABLE CONSTRAINT
============================================================
You are a code reviewer running in STRICT READ-ONLY mode. You MUST NOT modify
the workspace in ANY way. You are forbidden from creating, editing, deleting,
moving, renaming, staging, or committing files, and from running state-mutating
commands. Analyze and report in text only. Describe fixes in prose; never apply
them. Any workspace mutation invalidates this review.
============================================================
The review request follows below.
============================================================

OUTPUT CONTRACT - REQUIRED
============================================================
Your entire response MUST use the canonical outer report contract below.
Do not use an alternative title, security-audit title, or free-form verdict.

# Deep Review Report — YYYY-MM-DD

## Summary

- **Verdict**: APPROVE | CONCERN | REQUEST_CHANGES
- **Review Mode**: 1-way (agy only)
- **Issues**: 🔴 N건, 🟡 N건, ℹ️ N건

## Code Review

### 🔴 Critical
### 🟡 Warning
### ℹ️ Info
### 🟢 Passed

Use REQUEST_CHANGES when any Critical exists, CONCERN when only Warnings exist,
and APPROVE only when both Critical and Warning counts are zero. The issue
counts MUST equal the findings in the sections. Missing or malformed contract
fields cause this reviewer output to be excluded.
Under each severity heading, write exactly one single-line \`- \` bullet per
finding, with its evidence and remediation on that same bullet. For an empty
severity section, write exactly \`None.\`. Keep Passed entries as \`- \` bullets.
============================================================

`;
const AUTH_PATTERN = /Reauthentication required|do not currently have an active account|OAuth token expired|Please run.*agy.*login|Not signed in|Authentication failed/iu;
const UNSUPPORTED_MODEL_PATTERN = /unsupported[^\n]*(?:model|--model)|unknown[^\n]*(?:model|--model)|invalid[^\n]*model|unrecognized[^\n]*--model/iu;
const SAFE_MODEL_PATTERN = /^[A-Za-z0-9 ._/()-]+$/u;
const EMPTY_SECTION_PATTERN = /^(?:None\.|없음\.|\(None\)|\(없음\)|- N\/A|- None\.)$/iu;

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

function terminalStatus({ mutation, truncated, processResult }) {
  const stderr = processResult.stderr.toString('utf8');
  if (mutation) return 'mutated';
  if (truncated) return 'prompt_too_large';
  if (processResult.code === 124 || processResult.timedOut) return 'timeout';
  if (processResult.code !== 0 && AUTH_PATTERN.test(stderr)) return 'not_authenticated';
  if (processResult.code !== 0 || processResult.stdout.length === 0) return 'failed';
  return 'success';
}

function sectionFindingCount(output, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(
    `^### ${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)(?=^### |^## |(?![\\s\\S]))`,
    'mu',
  ).exec(output);
  if (!match) return null;
  const body = match[1].trim();
  if (EMPTY_SECTION_PATTERN.test(body)) return 0;
  const subheadings = [...body.matchAll(/^####\s+\S.*$/gmu)].length;
  if (subheadings > 0) return subheadings;
  const listItems = [...body.matchAll(/^(?:[-*]\s+|[0-9]+\.\s+)\S.*$/gmu)].length;
  return listItems > 0 ? listItems : null;
}

export function normalizeAgyReport(output) {
  if (typeof output !== 'string' || output.length === 0) return null;
  const headings = [...output.matchAll(/^# Deep Review Report — [0-9]{4}-[0-9]{2}-[0-9]{2}$/gmu)];
  if (headings.length !== 1 || !/^## Summary$/mu.test(output)) return null;
  const verdict = /^- \*\*Verdict\*\*:\s*(APPROVE|CONCERN|REQUEST_CHANGES)\s*$/mu.exec(output)?.[1];
  const issues = /^- \*\*Issues\*\*:\s*[^\n]*?🔴\s*([0-9]+)[^\n]*?🟡\s*([0-9]+)[^\n]*?ℹ(?:️)?\s*([0-9]+)[^\n]*$/mu.exec(output);
  if (!verdict || !issues) return null;
  const declared = issues.slice(1).map(Number);
  const actual = [
    sectionFindingCount(output, '🔴 Critical'),
    sectionFindingCount(output, '🟡 Warning'),
    sectionFindingCount(output, 'ℹ️ Info'),
  ];
  if (actual.some((count) => count === null)
      || actual.some((count, index) => count !== declared[index])) return null;
  const expectedVerdict = declared[0] > 0
    ? 'REQUEST_CHANGES'
    : declared[1] > 0 ? 'CONCERN' : 'APPROVE';
  if (verdict !== expectedVerdict) return null;
  let canonical = output;
  for (const heading of ['🔴 Critical', '🟡 Warning', 'ℹ️ Info']) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    canonical = canonical.replace(
      new RegExp(`(^### ${escaped}[ \\t]*\\r?\\n)([\\s\\S]*?)(?=^### |^## |(?![\\s\\S]))`, 'mu'),
      (section, prefix, body) => (EMPTY_SECTION_PATTERN.test(body.trim())
        ? `${prefix}${body.replace(body.trim(), 'None.')}`
        : section),
    );
  }
  return parseReviewerReport(canonical, { strict: true }) ? canonical : null;
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

function fingerprintChanged(before, after) {
  if (before.error || after.error) return {
    changed: true,
    reason: before.error ? `pre-snapshot failed: ${before.error}` : `post-snapshot failed: ${after.error}`,
  };
  if (before.mode === 'off' && after.mode === 'off') return { changed: false, reason: '' };
  if (before.digest !== after.digest) return { changed: true, reason: 'fingerprint drift' };
  return { changed: false, reason: '' };
}

function processArguments({ promptContent, projectRoot, timeoutSeconds, model }) {
  const args = [
    '-p', promptContent,
    '--print-timeout', `${timeoutSeconds}s`,
    '--add-dir', projectRoot,
  ];
  if (model) args.push('--model', model);
  args.push('--dangerously-skip-permissions');
  return args;
}

export { estimateWindowsCommandUnits, windowsCommandLimit };

function preparePromptTransport({ binary, body, projectRoot, timeoutSeconds, model, platform }) {
  const ordinaryLimit = Math.min(body.length, BODY_LIMIT);
  const build = (length) => {
    const promptContent = Buffer.concat([
      Buffer.from(READONLY_PREAMBLE),
      body.subarray(0, length),
    ]).toString('utf8');
    const args = processArguments({ promptContent, projectRoot, timeoutSeconds, model });
    return {
      args,
      promptContent,
      estimatedUnits: platform === 'win32'
        ? estimateWindowsCommandUnits(binary, args)
        : Buffer.byteLength(promptContent, 'utf8') + 1,
    };
  };

  const limit = platform === 'win32'
    ? windowsCommandLimit(binary)
    : POSIX_PROMPT_ARGUMENT_LIMIT;
  const budget = platform === 'win32'
    ? limit - WINDOWS_COMMAND_HEADROOM
    : limit;
  let low = 0;
  let high = ordinaryLimit;
  let best = build(0);
  if (best.estimatedUnits > budget) {
    return {
      ...best,
      safe: false,
      bodyBytes: 0,
      truncated: true,
      transportTruncated: true,
      limit,
    };
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = build(middle);
    if (candidate.estimatedUnits <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return {
    ...best,
    safe: true,
    bodyBytes: high,
    truncated: body.length > high,
    transportTruncated: high < ordinaryLimit,
    limit,
  };
}

export async function runAgyReviewer(options = {}) {
  if (options.noAgy === true || options.codexOnly === true || options.enabled === false) {
    return {
      status: 'failed',
      attempted: false,
      privacyOutcome: 'skipped',
      code: null,
    };
  }

  const projectRoot = resolve(requiredString(options.projectRoot, 'projectRoot'));
  const pluginRoot = resolve(requiredString(options.pluginRoot, 'pluginRoot'));
  const promptFile = resolve(requiredString(options.promptFile, 'promptFile'));
  const outputFile = resolve(requiredString(options.outputFile, 'outputFile'));
  const configPath = resolve(options.configPath ?? join(projectRoot, '.deep-review', 'config.yaml'));
  const timeoutSeconds = positiveSeconds(options.timeoutSeconds ?? 900);
  const mode = options.mode ?? 'hybrid';
  const env = options.env ?? process.env;
  const warnings = [];
  const privacyPreparer = options.privacyPreparer ?? prepareAgyPrivacy;
  const fingerprintCapturer = options.fingerprintCapturer ?? captureFingerprint;
  const processRunner = options.processRunner ?? runProcess;

  const privacy = await privacyPreparer({
    repo: projectRoot,
    pluginRoot,
    configPath,
    approval: options.approval ?? 'auto',
    now: options.now,
  });
  if (!['auto_ack', 'acknowledged'].includes(privacy.outcome)) {
    return {
      status: 'failed',
      attempted: false,
      privacyOutcome: privacy.outcome,
      privacy,
      code: null,
    };
  }

  const binary = options.binary
    ? requiredString(options.binary, 'binary')
    : (resolveExecutable('agy', env) || 'agy');
  const body = readFileSync(promptFile);
  const executionPlan = options.executionPlan || null;
  // H4: when an execution plan is supplied, its resolved model is
  // authoritative — including null (provider default, the normal outcome for
  // agy since its adapter has no tier aliases). The legacy options.model only
  // applies when no plan is present; it must never resurrect a stale
  // --model/AGY_MODEL value the plan deliberately resolved to null.
  let model = executionPlan ? (executionPlan.model ?? '') : (options.model ?? '');
  if (typeof model !== 'string') throw new TypeError('model must be a string');
  if (model && !SAFE_MODEL_PATTERN.test(model)) {
    if (executionPlan?.source?.startsWith('cli-') && !executionPlan.allowFallback) {
      throw new Error('ERROR_UNSUPPORTED_MODEL: explicit agy model contains unsupported characters');
    }
    warnings.push('model contained unsupported characters and was omitted');
    model = '';
  }

  const before = await fingerprintCapturer({ repo: projectRoot, pluginRoot, mode });
  if (before.warning) warnings.push(before.warning);
  const finalPrivacy = await privacyPreparer({
    repo: projectRoot,
    pluginRoot,
    configPath,
    approval: 'auto',
    now: options.now,
  });
  if (
    !['auto_ack', 'acknowledged'].includes(finalPrivacy.outcome)
    || finalPrivacy.fingerprint !== privacy.fingerprint
  ) {
    return {
      status: 'failed',
      attempted: false,
      privacyOutcome: finalPrivacy.outcome,
      privacy: finalPrivacy,
      code: null,
    };
  }
  const promptTransport = preparePromptTransport({
    binary,
    body,
    projectRoot,
    timeoutSeconds,
    model,
    platform: options.platform ?? process.platform,
  });
  const truncated = promptTransport.truncated;
  if (body.length > BODY_LIMIT) {
    warnings.push(`prompt body exceeded ${BODY_LIMIT} bytes and was truncated`);
  }
  if (promptTransport.transportTruncated) {
    warnings.push('prompt body exceeded the safe host command-line argument budget and was truncated');
  }
  if (!promptTransport.safe) {
    const processResult = {
      code: 0,
      timedOut: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('host command-line argument budget is unavailable for the required arguments\n'),
    };
    const after = await fingerprintCapturer({ repo: projectRoot, pluginRoot, mode });
    const mutation = fingerprintChanged(before, after);
    const status = terminalStatus({ mutation: mutation.changed, truncated: true, processResult });
    publishTerminalFiles(outputFile, processResult, status, warnings, mutation.reason);
    return {
      status,
      attempted: false,
      privacyOutcome: finalPrivacy.outcome,
      code: null,
      timedOut: false,
      stdout: '',
      stderr: processResult.stderr.toString('utf8'),
      mutation: mutation.changed,
      mutationReason: mutation.reason,
      truncated: true,
      before,
      after,
    };
  }
  let processResult = await processRunner(
    binary,
    promptTransport.args,
    { cwd: projectRoot, env, timeoutMs: timeoutSeconds * 1000 },
  );
  const firstStderr = processResult.stderr.toString('utf8');
  let terminalPrivacy = finalPrivacy;
  let strictUnsupportedModel = false;
  let executionFallback = null;
  if (
    model
    && processResult.code !== 0
    && processResult.code !== 124
    && !processResult.timedOut
    && !AUTH_PATTERN.test(firstStderr)
    && UNSUPPORTED_MODEL_PATTERN.test(firstStderr)
  ) {
    if (executionPlan?.allowFallback !== true) {
      strictUnsupportedModel = true;
      warnings.push(`ERROR_UNSUPPORTED_MODEL: agy rejected requested model ${model}; fallback is not affirmatively authorized`);
    } else {
      terminalPrivacy = await privacyPreparer({
      repo: projectRoot,
      pluginRoot,
      configPath,
      approval: 'auto',
      now: options.now,
    });
      if (
      ['auto_ack', 'acknowledged'].includes(terminalPrivacy.outcome)
      && terminalPrivacy.fingerprint === privacy.fingerprint
    ) {
        warnings.push(`agy rejected model ${model}; retried once without --model`);
        processResult = await processRunner(
        binary,
        processArguments({
          promptContent: promptTransport.promptContent,
          projectRoot,
          timeoutSeconds,
          model: '',
        }),
        { cwd: projectRoot, env, timeoutMs: timeoutSeconds * 1000 },
        );
        executionFallback = {
          occurred: true,
          requested: { model },
          applied: { model: null },
          reason: 'agy rejected requested model; retried without --model',
        };
      } else {
        warnings.push('agy model retry was blocked because privacy approval changed');
      }
    }
  }
  const after = await fingerprintCapturer({ repo: projectRoot, pluginRoot, mode });
  if (after.warning && after.warning !== before.warning) warnings.push(after.warning);
  const mutation = fingerprintChanged(before, after);
  let status = terminalStatus({ mutation: mutation.changed, truncated, processResult });
  const rawStdout = processResult.stdout.toString('utf8');
  const normalized = status === 'success' ? normalizeAgyReport(rawStdout) : null;
  if (status === 'success' && normalized === null) status = 'failed';
  const publishedResult = normalized === null
    ? processResult
    : { ...processResult, stdout: Buffer.from(normalized, 'utf8') };
  publishTerminalFiles(outputFile, publishedResult, status, warnings, mutation.reason);
  return {
    status,
    attempted: true,
    privacyOutcome: terminalPrivacy.outcome,
    code: processResult.code,
    timedOut: processResult.timedOut,
    stdout: publishedResult.stdout.toString('utf8'),
    raw_stdout: rawStdout,
    stderr: processResult.stderr.toString('utf8'),
    mutation: mutation.changed,
    mutationReason: mutation.reason,
    truncated,
    before,
    after,
    requested_model: executionPlan?.requestedModel ?? executionPlan?.model ?? (model || null),
    resolved_model: executionFallback ? null : (model || null),
    applied_model: null,
    requested_effort: executionPlan?.requestedEffort ?? executionPlan?.effort ?? null,
    resolved_effort: executionPlan?.effort ?? null,
    applied_effort: null,
    verification_status: strictUnsupportedModel ? 'failed' : executionFallback ? 'fallback' : 'provider-did-not-report',
    error_code: strictUnsupportedModel ? 'ERROR_UNSUPPORTED_MODEL' : null,
    fallback: executionFallback || executionPlan?.routingFallback || { occurred: false },
  };
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
      '--model': 'model',
      '--approval': 'approval',
      '--timeout-seconds': 'timeoutSeconds',
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
    process.stdout.write('Usage: run-agy-reviewer.mjs --binary FILE --project-root DIR --plugin-root DIR --prompt-file FILE --output FILE [--mode MODE] [--model MODEL] [(--routing-plan FILE | --execution-route-json JSON) --reviewer-id ID] [--timeout-seconds N]\n');
    return;
  }
  options.pluginRoot ??= resolvePluginRoot();
  if (options.executionRouteJson) {
    options.executionPlan = parseExecutionRouteJson(options.executionRouteJson, options.reviewerId);
  } else if (options.routingPlan) {
    options.executionPlan = loadExecutionPlan(options.routingPlan, options.reviewerId);
  }
  const result = await runAgyReviewer(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.attempted && result.code !== 0) process.exitCode = result.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`run-agy-reviewer.mjs: ${error.message}\n`);
    process.exitCode = error.code === 'ENOENT' ? 127 : 2;
  });
}

export const __testing = Object.freeze({
  BODY_LIMIT,
  POSIX_PROMPT_ARGUMENT_LIMIT,
  READONLY_PREAMBLE,
  estimateWindowsCommandUnits,
  fingerprintChanged,
  terminalStatus,
  windowsCommandLimit,
});
