#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isReviewerId, REVIEWER_PROVIDERS } from './lib/reviewer-ids.mjs';
import { loadReviewPolicy, loadUserConfig, mergeRoutingConfig } from './lib/review-policy.mjs';

const REVIEW_FLAGS = new Set([
  '--entropy',
  '--ultracode',
  '--codex',
  '--no-codex',
  '--no-opus',
  '--no-agy',
  '--agy',
  '--no-grok',
  '--grok',
]);

const ROUTING_POLICIES = new Set(['auto', 'fast', 'balanced', 'quality']);
const REVIEWER_STRATEGIES = new Set(['adaptive', 'static']);
const PROVIDERS = new Set(['claude', 'codex', 'agy', 'grok']);

function routeError(message) {
  return { ok: false, route: 'error', error: message };
}

function normalizeHost(host) {
  if (host !== 'claude' && host !== 'codex') {
    throw new TypeError('host must be claude or codex');
  }
  return host;
}

// D5: --codex-only must remain literally true, so the expansion disables grok
// too. Without --no-grok, `--grok --codex-only` would dispatch a non-Codex
// reviewer under a flag that promises otherwise.
function expandCodexOnly(argv) {
  const expanded = [];
  for (const token of argv) {
    if (token === '--codex-only') expanded.push('--codex', '--no-opus', '--no-agy', '--no-grok');
    else expanded.push(token);
  }
  return expanded;
}

// D13: the one normalized effective-candidacy predicate. Policy denial (D23)
// applies to this, not to any single flag — `--grok` is only one of the sources
// that make Grok a candidate.
export function effectiveGrokCandidacy(expanded = [], overrides = {}) {
  const providers = overrides.providers || {};
  const reviewers = overrides.reviewers || {};
  const targeted = Object.hasOwn(providers, 'grok') || Object.hasOwn(reviewers, 'grok');
  // `--no-grok` without a Grok-targeting override is successful silent negative
  // selection. The combination *with* one never reaches here: parseReview
  // rejects it as ERROR_CONFLICTING_REVIEWER_SELECTION first.
  if (expanded.includes('--no-grok') && !targeted) return false;
  if (expanded.includes('--grok') || targeted) return true;
  const contains = (list) => Array.isArray(list) && list.includes('grok');
  return contains(overrides.enabled_providers) || contains(overrides.required_providers);
}

// I43: both denial representations. Production validateConstraints
// (model-router.mjs:234-238) returns the same code for an allowed_providers
// exclusion as for denied_providers membership; this pre-coordinator owner
// mirrors that polarity exactly.
function grokDeniedByConstraints(constraints) {
  if (constraints.allowed_providers && !constraints.allowed_providers.includes('grok')) return 'allowed_providers';
  if (constraints.denied_providers?.includes('grok')) return 'denied_providers';
  return null;
}

// The documented user/project precedence merge: defaults <- user <- project.
// mergeRoutingConfig wholesale-replaces merged constraints with
// structuredClone(project.constraints) whenever project.constraints is defined,
// so a user allowed_providers that excludes grok does not survive a defined
// project constraints object.
function effectiveConstraints(cwd, env) {
  const user = loadUserConfig(env)?.policy ?? {};
  const project = loadReviewPolicy(cwd)?.policy ?? {};
  return mergeRoutingConfig({ defaults: { constraints: {} }, user, project }).constraints ?? {};
}

// D23/I43: an invocation-level zero-side-effect gate. It is resolved before
// coordinator creation, executable lookup, carrier creation, or compatibility
// probes, and it reads policy only for a positive candidate — so a no-flag or
// `--no-grok` review still touches nothing it did not touch before.
export function grokDenialGate(expanded = [], overrides = {}, cwd = process.cwd(), env = process.env) {
  if (!effectiveGrokCandidacy(expanded, overrides)) return null;
  let constraints;
  try {
    constraints = effectiveConstraints(cwd, env);
  } catch (error) {
    return `ERROR_POLICY_INVALID: ${error.message}`;
  }
  const reason = grokDeniedByConstraints(constraints);
  return reason === null
    ? null
    : `ERROR_PROVIDER_DENIED: grok is denied by the effective review policy (${reason})`;
}

function validateReviewerFlags(argv) {
  if (argv.includes('--ultracode') && argv.includes('--no-opus')) {
    return '--ultracode cannot be combined with --no-opus';
  }
  if (argv.includes('--codex') && argv.includes('--no-codex')) {
    return '--codex cannot be combined with --no-codex';
  }
  // --codex-only expands to --no-agy before this runs, so that combination is
  // rejected here too.
  if (argv.includes('--agy') && argv.includes('--no-agy')) {
    return '--agy cannot be combined with --no-agy/--codex-only';
  }
  // D23: `--grok` plus either invocation-disable is a selection conflict, not a
  // policy denial. --codex-only expands to --no-grok before this runs.
  if (argv.includes('--grok') && argv.includes('--no-grok')) {
    return '--grok cannot be combined with --no-grok/--codex-only';
  }
  return null;
}

function existingFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function parseReview(argv, host, cwd, provenance = {}) {
  const codexOnly = provenance.codexOnly === true || argv.includes('--codex-only');
  const expanded = expandCodexOnly(argv);
  if (expanded[0] === 'init') {
    return expanded.length === 1
      ? { ok: true, route: 'init', host, argv: expanded }
      : { ...routeError('init does not accept additional arguments'), host, argv: expanded };
  }
  if (expanded.includes('--qa')) {
    return expanded.length === 1
      ? { ok: true, route: 'qa', host, argv: expanded }
      : { ...routeError('--qa does not accept additional arguments'), host, argv: expanded };
  }
  const respondIndex = expanded.indexOf('--respond');
  if (respondIndex >= 0) {
    if (respondIndex !== 0) return { ...routeError('--respond must be the first argument'), host, argv: expanded };
    const ignoredReviewerFlags = expanded.filter((token) => REVIEW_FLAGS.has(token));
    let reportPath = null;
    let sourcePr = false;
    let prNumber = false;
    for (let index = 1; index < expanded.length; index += 1) {
      const token = expanded[index];
      if (REVIEW_FLAGS.has(token)) continue;
      if (token === '--source=pr') {
        sourcePr = true;
        continue;
      }
      if (/^--pr=[1-9][0-9]*$/u.test(token)) {
        prNumber = true;
        continue;
      }
      if (!token.startsWith('-') && reportPath === null) {
        const candidate = resolve(cwd, token);
        if (!existingFile(candidate)) {
          return { ...routeError(`respond report path must name an existing file: ${token}`), host, argv: expanded };
        }
        reportPath = candidate;
        continue;
      }
      return { ...routeError(`unknown respond argument: ${token}`), host, argv: expanded };
    }
    if (prNumber && !sourcePr) {
      return { ...routeError('--pr=NNN requires --source=pr'), host, argv: expanded };
    }
    if (reportPath !== null && (sourcePr || prNumber)) {
      return { ...routeError('respond accepts a report path or PR source options, not both'), host, argv: expanded };
    }
    return {
      ok: true,
      route: 'respond',
      host,
      argv: expanded,
      ignoredReviewerFlags,
      reportPath,
    };
  }

  const conflict = validateReviewerFlags(expanded);
  if (conflict) return { ...routeError(conflict), host, argv: expanded };
  let dryRun = false;
  let explainRouting = false;
  let hasOverrides = false;
  let reviewerStrategySeen = false;
  let routingPolicySeen = false;
  let fallbackMode = null;
  let readinessReceipt = null;
  // G3: routing_policy and allow_fallback stay absent unless the caller
  // actually passes --routing/--allow-fallback, so an unrelated flag (e.g.
  // --allow-classifier or --model) never serializes an implicit 'auto'/false
  // that would silently overlay a project/user routing.policy or
  // allow_fallback during the downstream policy merge.
  const overrides = {
    protocol_version: '2.0',
    allow_classifier: false,
    providers: {},
    reviewers: {},
  };
  if (codexOnly) {
    overrides.codex_only = true;
    hasOverrides = true;
  }
  function assignment(flag, value, allowed, destination, field, label) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) return `${flag} requires <${label}>=<value>`;
    const key = value.slice(0, separator);
    const setting = value.slice(separator + 1);
    if (!allowed(key)) return `unknown ${label}: ${key}`;
    destination[key] ??= {};
    if (Object.hasOwn(destination[key], field)) return `duplicate ${flag} for ${key}`;
    destination[key][field] = setting;
    return null;
  }
  for (let index = 0; index < expanded.length; index += 1) {
    const token = expanded[index];
    if (REVIEW_FLAGS.has(token)) continue;
    if (token === '--contract') {
      if (/^SLICE-[0-9]+$/u.test(expanded[index + 1] || '')) index += 1;
      continue;
    }
    // Additive-optional grammar extension (research §7-6 / plan v2): a
    // loop-bound prior-round advisory context path. Value validation is the
    // payload builder's job (build-reviewer-payload.mjs ingestPriorRounds);
    // this grammar only accepts the token shape. Review-only — the loop
    // entry's grammar (parseLoop) is intentionally untouched.
    if (/^--prior-rounds-file=.+$/u.test(token)) continue;
    // Artifact-aware routing Phase 1 (§15.7): opt-in, review-only, value-less.
    // Both are dormant — a review invocation without them is byte-identical to
    // today. The dispatcher runs the deterministic classifier (dry-run listing
    // / explain view) and stops before any reviewer when either is set.
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (token === '--explain-routing') {
      explainRouting = true;
      continue;
    }
    if (token === '--allow-fallback') {
      if (fallbackMode !== null) {
        return { ...routeError('--allow-fallback conflicts with or duplicates --no-fallback'), host, argv: expanded };
      }
      overrides.allow_fallback = true;
      fallbackMode = 'allow';
      hasOverrides = true;
      continue;
    }
    if (token === '--no-fallback') {
      if (fallbackMode !== null) {
        return { ...routeError('--no-fallback conflicts with or duplicates --allow-fallback'), host, argv: expanded };
      }
      overrides.allow_fallback = false;
      fallbackMode = 'deny';
      hasOverrides = true;
      continue;
    }
    if (token === '--allow-classifier') {
      overrides.allow_classifier = true;
      hasOverrides = true;
      continue;
    }
    if (token === '--reviewer-strategy') {
      if (reviewerStrategySeen) return { ...routeError('duplicate --reviewer-strategy'), host, argv: expanded };
      const value = expanded[index + 1];
      if (!REVIEWER_STRATEGIES.has(value)) {
        return { ...routeError('--reviewer-strategy must be adaptive or static'), host, argv: expanded };
      }
      overrides.reviewer_strategy = value;
      reviewerStrategySeen = true;
      hasOverrides = true;
      index += 1;
      continue;
    }
    if (token === '--readiness-receipt') {
      if (readinessReceipt !== null) return { ...routeError('duplicate --readiness-receipt'), host, argv: expanded };
      const value = expanded[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ...routeError('--readiness-receipt requires a path'), host, argv: expanded };
      }
      const candidate = resolve(cwd, value);
      if (!existingFile(candidate)) {
        return { ...routeError(`readiness receipt path must name an existing file: ${value}`), host, argv: expanded };
      }
      readinessReceipt = candidate;
      overrides.readiness_receipt = candidate;
      hasOverrides = true;
      index += 1;
      continue;
    }
    if (token === '--routing') {
      if (routingPolicySeen) return { ...routeError('duplicate --routing'), host, argv: expanded };
      const value = expanded[index + 1];
      if (!ROUTING_POLICIES.has(value)) return { ...routeError('--routing must be auto, fast, balanced, or quality'), host, argv: expanded };
      overrides.routing_policy = value;
      routingPolicySeen = true;
      hasOverrides = true;
      index += 1;
      continue;
    }
    const assignmentFlags = {
      '--model': [PROVIDERS.has.bind(PROVIDERS), overrides.providers, 'model', 'provider'],
      '--effort': [PROVIDERS.has.bind(PROVIDERS), overrides.providers, 'effort', 'provider'],
      '--reviewer-model': [isReviewerId, overrides.reviewers, 'model', 'reviewer'],
      '--reviewer-effort': [isReviewerId, overrides.reviewers, 'effort', 'reviewer'],
    };
    if (Object.hasOwn(assignmentFlags, token)) {
      const value = expanded[index + 1];
      if (value === undefined) return { ...routeError(`${token} requires a value`), host, argv: expanded };
      const error = assignment(token, value, ...assignmentFlags[token]);
      if (error) return { ...routeError(error), host, argv: expanded };
      hasOverrides = true;
      index += 1;
      continue;
    }
    return { ...routeError(`unknown review argument: ${token}`), host, argv: expanded };
  }
  if (expanded.includes('--no-opus') && Object.hasOwn(overrides.providers, 'claude')) {
    return { ...routeError('ERROR_CONFLICTING_REVIEWER_SELECTION: Claude override conflicts with --no-opus/--codex-only'), host, argv: expanded };
  }
  if (expanded.includes('--no-codex') && Object.hasOwn(overrides.providers, 'codex')) {
    return { ...routeError('ERROR_CONFLICTING_REVIEWER_SELECTION: Codex override conflicts with --no-codex'), host, argv: expanded };
  }
  if (expanded.includes('--no-agy') && Object.hasOwn(overrides.providers, 'agy')) {
    return { ...routeError('ERROR_CONFLICTING_REVIEWER_SELECTION: agy override conflicts with --no-agy'), host, argv: expanded };
  }
  if (expanded.includes('--no-grok') && Object.hasOwn(overrides.providers, 'grok')) {
    return { ...routeError('ERROR_CONFLICTING_REVIEWER_SELECTION: grok override conflicts with --no-grok/--codex-only'), host, argv: expanded };
  }
  for (const reviewerId of Object.keys(overrides.reviewers)) {
    const provider = REVIEWER_PROVIDERS[reviewerId];
    if (provider === 'claude' && expanded.includes('--no-opus')) {
      return { ...routeError(`ERROR_CONFLICTING_REVIEWER_SELECTION: reviewer override ${reviewerId} conflicts with --no-opus/--codex-only`), host, argv: expanded };
    }
    if (provider === 'codex' && expanded.includes('--no-codex')) {
      return { ...routeError(`ERROR_CONFLICTING_REVIEWER_SELECTION: reviewer override ${reviewerId} conflicts with --no-codex`), host, argv: expanded };
    }
    if (provider === 'agy' && expanded.includes('--no-agy')) {
      return { ...routeError(`ERROR_CONFLICTING_REVIEWER_SELECTION: reviewer override ${reviewerId} conflicts with --no-agy`), host, argv: expanded };
    }
    if (provider === 'grok' && expanded.includes('--no-grok')) {
      return { ...routeError(`ERROR_CONFLICTING_REVIEWER_SELECTION: reviewer override ${reviewerId} conflicts with --no-grok/--codex-only`), host, argv: expanded };
    }
  }
  const requiredReviewers = new Set(Object.keys(overrides.reviewers));
  const requiredProviders = new Set();
  if (expanded.includes('--ultracode')) requiredReviewers.add('claude-opus');
  if (expanded.includes('--codex')) requiredProviders.add('codex');
  // agy is not a default candidate. `--agy` mirrors `--codex`: it both permits
  // candidacy and requires selection, because candidacy alone never wins a
  // planner slot at a small reviewer floor. Pre-existing agy-targeting
  // overrides only restore candidacy, so their required-ness stays as it is
  // today and a privacy decline cannot void the whole verdict.
  if (expanded.includes('--agy')) requiredProviders.add('agy');
  // grok mirrors agy exactly: `--grok` permits candidacy and requires selection,
  // while a Grok-targeting override only restores candidacy (D13).
  if (expanded.includes('--grok')) requiredProviders.add('grok');
  const enabledProviders = new Set();
  if (expanded.includes('--agy')
    || Object.hasOwn(overrides.providers, 'agy')
    || Object.hasOwn(overrides.reviewers, 'agy')) enabledProviders.add('agy');
  if (expanded.includes('--grok')
    || Object.hasOwn(overrides.providers, 'grok')
    || Object.hasOwn(overrides.reviewers, 'grok')) enabledProviders.add('grok');
  if (enabledProviders.size > 0) {
    overrides.enabled_providers = [...enabledProviders].sort();
    hasOverrides = true;
  }
  if (requiredReviewers.size > 0) {
    overrides.required_reviewers = [...requiredReviewers].sort();
    hasOverrides = true;
  }
  if (requiredProviders.size > 0) {
    overrides.required_providers = [...requiredProviders].sort();
    hasOverrides = true;
  }
  // G2: transport the public --no-opus/--no-codex/--no-agy disables (including
  // --codex-only's expansion) to the preflight so disabled providers are
  // excluded from eligibility checks and the emitted routing plan.
  const disabledProviders = [];
  if (expanded.includes('--no-opus')) disabledProviders.push('claude');
  if (expanded.includes('--no-codex')) disabledProviders.push('codex');
  if (expanded.includes('--no-agy')) disabledProviders.push('agy');
  if (expanded.includes('--no-grok')) disabledProviders.push('grok');
  if (disabledProviders.length > 0) {
    overrides.disabled_providers = [...new Set(disabledProviders)].sort();
    hasOverrides = true;
  }
  // D23/I43: the pre-coordinator denial gate. It runs after the selection
  // conflicts above — so an invocation-disable combination is never reported as
  // a denial — and before any route, coordinator, or Grok state exists.
  const denial = grokDenialGate(expanded, overrides, cwd);
  if (denial !== null) return { ...routeError(denial), host, argv: expanded };
  const route = { ok: true, route: 'review', host, argv: expanded };
  if (dryRun) route.dryRun = true;
  if (explainRouting) route.explainRouting = true;
  if (readinessReceipt !== null) route.readinessReceipt = readinessReceipt;
  if (hasOverrides) route.overrides = overrides;
  return route;
}

function parseLoop(argv, host, cwd) {
  const codexOnly = argv.includes('--codex-only');
  const expanded = expandCodexOnly(argv);
  for (const forbidden of ['init', '--respond', '--qa']) {
    if (expanded.includes(forbidden)) {
      return { ...routeError(`${forbidden} is not valid for the loop entry`), host, argv: expanded };
    }
  }
  const conflict = validateReviewerFlags(expanded);
  if (conflict) return { ...routeError(conflict), host, argv: expanded };
  let max = 5;
  let maxExplicit = false;
  const reviewArgs = [];
  for (let index = 0; index < expanded.length; index += 1) {
    const token = expanded[index];
    if (/^--max=[1-9][0-9]*$/u.test(token)) {
      if (maxExplicit) return { ...routeError('duplicate --max'), host, argv: expanded };
      max = Number(token.slice('--max='.length));
      maxExplicit = true;
      continue;
    }
    // Opt-in per-session single review document. Loop-only (default OFF keeps
    // today's byte-identical behavior); the terminal review/respond routes keep
    // rejecting it. Value-less boolean flag.
    if (token === '--session-doc') continue;
    if (token === '--dry-run' || token === '--explain-routing' || token.startsWith('--prior-rounds-file=')) {
      return { ...routeError(`unknown loop argument: ${token}`), host, argv: expanded };
    }
    reviewArgs.push(token);
    if ([
      '--routing',
      '--reviewer-strategy',
      '--readiness-receipt',
      '--model',
      '--effort',
      '--reviewer-model',
      '--reviewer-effort',
    ].includes(token)) {
      if (expanded[index + 1] !== undefined) {
        reviewArgs.push(expanded[index + 1]);
        index += 1;
      }
    } else if (token === '--contract' && /^SLICE-[0-9]+$/u.test(expanded[index + 1] || '')) {
      reviewArgs.push(expanded[index + 1]);
      index += 1;
    }
  }
  const reviewRoute = parseReview(reviewArgs, host, cwd, { codexOnly });
  if (!reviewRoute.ok || reviewRoute.route !== 'review') {
    return { ...routeError(reviewRoute.error || 'invalid loop review arguments'), host, argv: expanded };
  }
  return {
    ok: true,
    route: 'loop',
    host,
    argv: expanded,
    max,
    maxExplicit,
    ...(reviewRoute.overrides ? { overrides: reviewRoute.overrides } : {}),
    ...(reviewRoute.readinessReceipt ? { readinessReceipt: reviewRoute.readinessReceipt } : {}),
  };
}

export function parsePublicRoute({ entry = 'review', argv = [], host, cwd = process.cwd() }) {
  const normalizedHost = normalizeHost(host);
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== 'string')) {
    throw new TypeError('argv must be an array of strings');
  }
  if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('cwd must be non-empty');
  if (entry === 'review') return parseReview(argv, normalizedHost, cwd);
  if (entry === 'loop') return parseLoop(argv, normalizedHost, cwd);
  throw new TypeError('entry must be review or loop');
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argv[index]} requires a value`);
    if (argv[index] === '--entry') options.entry = value;
    else if (argv[index] === '--host') options.host = value;
    else if (argv[index] === '--args-file') options.argsFile = value;
    else if (argv[index] === '--cwd') options.cwd = value;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const options = cliOptions(process.argv.slice(2));
    const argv = options.argsFile ? JSON.parse(readFileSync(resolve(options.argsFile), 'utf8')) : [];
    const result = parsePublicRoute({ entry: options.entry, host: options.host, argv, cwd: options.cwd });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 2;
  }
}
