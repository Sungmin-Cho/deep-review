#!/usr/bin/env node
// Artifact-aware routing — Phase 1 dry-run / explain executor.
//
// Discovers the current git change scope, classifies each artifact with the
// deterministic classifier, prints the §15.7 dry-run listing (or the §19.3
// explain view), and writes classification provenance JSON under
// `.deep-review/tmp/` for later phases to consume.
//
// This module NEVER executes a reviewer. It imports only discovery,
// classification, and environment detection — deliberately not any
// `run-*-reviewer` runner. That structural boundary is what makes `--dry-run`
// safe: there is no reviewer code path to reach.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyArtifact, classifyScope } from './lib/artifact-classify.mjs';
import { discoverArtifacts } from './lib/artifact-discover.mjs';
import { readArtifactWindows } from './lib/artifact-discover.mjs';
import { gitSync } from './lib/git.mjs';
import {
  classifyWithSemantic,
  createClaudeCliSemanticAdapter,
  createSemanticCache,
  selectSemanticAdapter,
} from './lib/semantic-classify.mjs';
import { detectEnvironment } from './detect-environment.mjs';
import { CLASSIFICATION_VERSION } from './lib/target-taxonomy.mjs';
import {
  buildCapabilities,
  capabilityCacheKeys,
  loadCapabilityCache,
  probeCapabilities,
  saveCapabilityCache,
} from './lib/capability-registry.mjs';
import { assessRisk, buildRoutingPlan, renderRoutingExplanation } from './lib/model-router.mjs';
import {
  loadReviewPolicy,
  loadUserConfig,
  mergeRoutingConfig,
} from './lib/review-policy.mjs';
import { writeContainedFile } from './lib/runtime-context.mjs';
import { isReviewerId } from './lib/reviewer-ids.mjs';
import { verifyReadinessReceipt } from './document-readiness.mjs';

const SIGNAL_LABELS = {
  frontmatter: 'frontmatter',
  filename: 'filename',
  path: 'path',
  title: 'title',
  heading: 'headings',
  keyword: 'keywords',
  'code-extension': 'code extension',
  'git-diff': 'git diff',
};

function signalSummary(classification) {
  // Code/binary carry a ready-made human source phrase.
  if (/^(?:code extension|binary)/.test(classification.source)) return classification.source;
  const labels = [];
  for (const signal of classification.signals) {
    if (signal.weight <= 0) continue; // skip contradiction/negative markers
    const label = SIGNAL_LABELS[signal.type];
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.length > 0 ? labels.join(' + ') : classification.source;
}

function formatConfidence(value) {
  return value.toFixed(2);
}

function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob.length === 0 || glob.length > 1024) return null;
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
  }
  return new RegExp(`${source}$`, 'u');
}

function matchingClassificationOverride(path, overrides) {
  if (!Array.isArray(overrides)) return null;
  const normalizedPath = String(path || '').replaceAll('\\', '/').replace(/^\.\//u, '');
  if (normalizedPath.length > 8192) return null;
  return overrides.find((override) => {
    const matcher = globToRegExp(override?.glob);
    return matcher?.test(normalizedPath);
  }) || null;
}

/**
 * Classify every artifact in the given change scope.
 * Synchronous: the caller supplies `changeState` (and `reviewBase` for `clean`).
 */
export function classifyArtifactsScope(options = {}) {
  const {
    repo, changeState, reviewBase = '', filesFromZ, thresholds, generatedAt,
    classificationOverrides,
  } = options;
  const descriptors = discoverArtifacts({ repo, changeState, reviewBase, filesFromZ });

  const artifacts = descriptors.map((descriptor) => {
    const deterministic = classifyArtifact({
      path: descriptor.path,
      extension: descriptor.extension,
      content: descriptor.content,
      isBinary: descriptor.is_binary,
      gitStatus: descriptor.git_status,
      thresholds,
    });
    const policyOverride = matchingClassificationOverride(descriptor.path, classificationOverrides);
    const classification = policyOverride ? {
      ...deterministic,
      target_kind: policyOverride.kind,
      confidence: 1,
      source: `policy override: ${policyOverride.glob}`,
      needs_semantic: false,
      alternatives: deterministic.target_kind === policyOverride.kind
        ? deterministic.alternatives
        : [deterministic.target_kind, ...deterministic.alternatives].filter((kind, index, values) => values.indexOf(kind) === index),
    } : deterministic;
    const summary = policyOverride ? classification.source : signalSummary(classification);
    return {
      artifact_id: descriptor.artifact_id,
      path: descriptor.path,
      target_kind: classification.target_kind,
      confidence: classification.confidence,
      source: classification.source,
      needs_semantic: classification.needs_semantic,
      signal_summary: summary,
      signals: classification.signals,
      alternatives: classification.alternatives,
      byte_size: descriptor.byte_size,
      line_count: descriptor.line_count,
      content_risk: assessRisk([{ path: descriptor.path, content: descriptor.content, signal_summary: summary }]),
    };
  });

  return {
    classification_version: CLASSIFICATION_VERSION,
    generated_at: generatedAt ?? new Date().toISOString(),
    scope: classifyScope(artifacts),
    artifacts,
  };
}

/** Async additive orchestration. The synchronous Phase 1 export above remains unchanged. */
export async function classifyArtifactsScopeWithSemantic(options = {}) {
  const deterministic = classifyArtifactsScope(options);
  const descriptors = discoverArtifacts(options);
  const descriptorByPath = new Map(descriptors.map((descriptor) => [descriptor.path, descriptor]));
  const cache = options.semanticCache || createSemanticCache();
  const semanticAdapter = options.semanticAdapter
    || selectSemanticAdapter(options.capabilities, options.semanticAdapters);
  const artifacts = [];
  for (const artifact of deterministic.artifacts) {
    const descriptor = descriptorByPath.get(artifact.path);
    if (!artifact.needs_semantic) {
      artifacts.push({ ...artifact, semantic_status: 'not-needed' });
      continue;
    }
    let semanticDescriptor = descriptor;
    try {
      semanticDescriptor = {
        ...descriptor,
        semantic_windows: readArtifactWindows(descriptor, {
          repoRoot: resolve(options.repo),
          maxBytes: options.maxClassifierBytes || 24_576,
        }),
        sibling_paths: descriptors.filter((item) => item.path !== descriptor.path).map((item) => item.path),
      };
    } catch {
      artifacts.push({
        ...artifact,
        semantic_status: 'failed',
        semantic_error: 'artifact containment revalidation failed during bounded window read',
      });
      continue;
    }
    artifacts.push(await classifyWithSemantic({
      descriptor: semanticDescriptor,
      classification: artifact,
      pluginRoot: options.pluginRoot,
      adapter: semanticAdapter,
      timeoutMs: options.semanticTimeoutMs,
      maxBytes: options.maxClassifierBytes,
      thresholds: options.thresholds,
      cache,
    }));
  }
  return { ...deterministic, scope: classifyScope(artifacts), artifacts };
}

/**
 * §15.7 dry-run listing. Routing itself is Phase 2, so the "routing" section is
 * an honest deferral rather than a fabricated plan.
 */
export function formatDryRun(result) {
  const lines = [`Detected scope: ${result.scope}`, '', 'Artifacts:'];
  result.artifacts.forEach((artifact, index) => {
    lines.push(`${index + 1}. ${artifact.path}`);
    lines.push(`   kind: ${artifact.target_kind}`);
    lines.push(`   confidence: ${formatConfidence(artifact.confidence)}`);
    lines.push(`   source: ${artifact.signal_summary}`);
    if (artifact.semantic_status) lines.push(`   semantic: ${artifact.semantic_status}`);
    else if (artifact.needs_semantic) lines.push('   semantic: deferred (use --allow-classifier to opt in)');
  });
  lines.push('');
  lines.push(renderRoutingExplanation(result.routing_plan || {
    routing_policy: 'auto', shadow_mode: true, routes: [],
  }).trimEnd());
  return `${lines.join('\n')}\n`;
}

/**
 * §19.3 explain view. Same classification, with an explicit statement that
 * routing is not yet wired.
 */
export function formatExplainRouting(result) {
  const lines = [`Detected scope: ${result.scope}`, ''];
  for (const artifact of result.artifacts) {
    lines.push(`${artifact.path} → ${artifact.target_kind} (confidence ${formatConfidence(artifact.confidence)})`);
    lines.push(`  signals: ${artifact.signal_summary}`);
    lines.push(`  semantic: ${artifact.semantic_status || (artifact.needs_semantic ? 'deferred' : 'not-needed')}`);
  }
  lines.push('');
  lines.push(renderRoutingExplanation(result.routing_plan || {
    routing_policy: 'auto', shadow_mode: true, routes: [],
  }).trimEnd());
  return `${lines.join('\n')}\n`;
}

function defaultProvenancePath(repo) {
  return resolve(repo, '.deep-review', 'tmp', 'artifact-classification.json');
}

// J2: repo is the containment root — writeContainedFile refuses a symlinked
// destination file and a symlinked ancestor directory (e.g. a committed
// `.deep-review/tmp` symlink) that would otherwise silently redirect this
// write outside the repository.
export function writeProvenance(repo, result, outPath) {
  writeContainedFile(repo, outPath, `${JSON.stringify(result, null, 2)}\n`);
  return outPath;
}

const VALUE_FLAGS = {
  '--repo': 'repo',
  '--change-state': 'changeState',
  '--review-base': 'reviewBase',
  '--out': 'out',
  '--format': 'format',
  '--files-from0': 'filesFrom',
  '--routing-plan-out': 'routingPlanOut',
  '--host-assertions-json': 'hostAssertionsJson',
  '--adaptive-context-json': 'adaptiveContextJson',
};

// I4: the internal preflight argv-only transport for native host tool
// assertions (named Claude agent / native Codex generic subagent
// availability) that the JS runtime object cannot carry across the
// classify-artifacts.mjs subprocess boundary. Not part of the public review
// grammar; the workflow composes this flag itself.
const HOST_ASSERTION_KEYS = ['claudeNativeAgent', 'codexExecReviewer', 'codexNativeGeneric'];

function validateHostAssertions(value) {
  const invalid = !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !HOST_ASSERTION_KEYS.includes(key))
    || Object.values(value).some((entry) => typeof entry !== 'boolean');
  if (invalid) {
    throw new Error('--host-assertions-json keys must be claudeNativeAgent/codexExecReviewer/codexNativeGeneric with boolean values');
  }
  return value;
}

function validateAdaptiveContext(value) {
  const states = new Set(['regression', 'confirmation', 'stalled', 'changed']);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema_version !== 2
      || !['low', 'medium', 'high', 'critical'].includes(value.risk)
      || !states.has(value.progress)
      || !Array.isArray(value.used_reviewers)
      || value.used_reviewers.some((id) => !isReviewerId(id))
      || new Set(value.used_reviewers).size !== value.used_reviewers.length
      || Object.keys(value).some((key) => ![
        'schema_version', 'risk', 'progress', 'used_reviewers',
      ].includes(key))) {
    throw new Error('--adaptive-context-json must be a schema-2 risk/progress/used_reviewers object');
  }
  return value;
}

// I3: allow provenance to be byte-identical across runs when a caller pins the
// timestamp via SOURCE_DATE_EPOCH (reproducible-builds convention). Unset ⇒
// wall-clock time as before.
function deterministicTimestamp(env) {
  const raw = env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw === '') return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function validateOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('--overrides-json must decode to an object');
  if (value.protocol_version !== '2.0') throw new Error('--overrides-json protocol_version must be "2.0"');
  if (typeof value.allow_classifier !== 'boolean') throw new Error('--overrides-json allow_classifier must be boolean');
  // G3: routing_policy and allow_fallback are only serialized by public-route
  // when the corresponding flag was actually passed, so they must stay
  // optional here too — validate their shape only when present, and never
  // require a value that would silently overlay a project/user policy field
  // the caller never asked to change.
  if (value.allow_fallback !== undefined && typeof value.allow_fallback !== 'boolean') {
    throw new Error('--overrides-json allow_fallback must be boolean');
  }
  if (value.routing_policy !== undefined && !['auto', 'fast', 'balanced', 'quality'].includes(value.routing_policy)) {
    throw new Error('--overrides-json routing_policy is invalid');
  }
  if (value.reviewer_strategy !== undefined && !['adaptive', 'static'].includes(value.reviewer_strategy)) {
    throw new Error('--overrides-json reviewer_strategy is invalid');
  }
  if (value.codex_only !== undefined && typeof value.codex_only !== 'boolean') {
    throw new Error('--overrides-json codex_only must be boolean');
  }
  if (value.readiness_receipt !== undefined && typeof value.readiness_receipt !== 'string') {
    throw new Error('--overrides-json readiness_receipt must be a string');
  }
  if (!value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)
      || !value.reviewers || typeof value.reviewers !== 'object' || Array.isArray(value.reviewers)) {
    throw new Error('--overrides-json providers and reviewers must be objects');
  }
  // G2: disabled_providers is optional transport for the public
  // --no-opus/--no-codex/--no-agy disables. When present it must be an array
  // of unique values drawn from the known provider set.
  if (value.disabled_providers !== undefined) {
    const providers = value.disabled_providers;
    const known = new Set(['claude', 'codex', 'agy', 'grok']);
    if (!Array.isArray(providers) || providers.some((provider) => !known.has(provider))
        || new Set(providers).size !== providers.length) {
      throw new Error('--overrides-json disabled_providers must be a unique array of claude, codex, agy, or grok');
    }
  }
  // enabled_providers is the permissive counterpart: it restores candidacy for
  // a provider that is not a default candidate (agy and grok). It never
  // forces selection — `--agy`/`--grok` transport that through
  // required_providers.
  if (value.enabled_providers !== undefined) {
    const providers = value.enabled_providers;
    const known = new Set(['claude', 'codex', 'agy', 'grok']);
    if (!Array.isArray(providers) || providers.some((provider) => !known.has(provider))
        || new Set(providers).size !== providers.length) {
      throw new Error('--overrides-json enabled_providers must be a unique array of claude, codex, agy, or grok');
    }
  }
  if (value.required_providers !== undefined) {
    const providers = value.required_providers;
    const known = new Set(['claude', 'codex', 'agy', 'grok']);
    if (!Array.isArray(providers) || providers.some((provider) => !known.has(provider))
        || new Set(providers).size !== providers.length) {
      throw new Error('--overrides-json required_providers must be a unique array of claude, codex, agy, or grok');
    }
  }
  if (value.required_reviewers !== undefined) {
    const reviewers = value.required_reviewers;
    const known = new Set(['claude-opus', 'codex-review', 'codex-adversarial', 'agy']);
    if (!Array.isArray(reviewers) || reviewers.some((reviewer) => !known.has(reviewer))
        || new Set(reviewers).size !== reviewers.length) {
      throw new Error('--overrides-json required_reviewers must contain unique canonical reviewer ids');
    }
  }
  return value;
}

export function parseArguments(argv) {
  const options = { repo: '.', explainRouting: false, emitRoutingPlan: false, format: 'text' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--explain-routing') {
      options.explainRouting = true;
      continue;
    }
    if (argument === '--emit-routing-plan') {
      options.emitRoutingPlan = true;
      continue;
    }
    if (argument === '--overrides-json') {
      const raw = argv[index + 1];
      if (raw === undefined) throw new Error('--overrides-json requires a value');
      try {
        options.overrides = validateOverrides(JSON.parse(raw));
      } catch (error) {
        if (error.message.startsWith('--overrides-json')) throw error;
        throw new Error(`--overrides-json must contain valid JSON: ${error.message}`);
      }
      index += 1;
      continue;
    }
    const key = VALUE_FLAGS[argument];
    if (!key) throw new Error(`unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${argument} requires a value`);
    options[key] = value;
    index += 1;
  }
  if (!['text', 'json'].includes(options.format)) throw new Error('--format must be text or json');
  return options;
}

function defaultRoutingPlanPath(repo) {
  return resolve(repo, '.deep-review', 'tmp', 'routing-plan.json');
}

function capabilityCacheFilePath(repo) {
  return resolve(repo, '.deep-review', 'tmp', 'capability-cache.json');
}

// J3: an explicit effort override that targets the claude provider (or the
// claude-opus reviewer directly) cannot be transported by claude-native-agent
// (its effort_selection.supported is always false). Absent this check,
// defaultReviewers unconditionally prefers the native agent whenever it is
// available, so an advertised explicit --effort claude=high would fail
// ERROR_UNSUPPORTED_EFFORT even when the detected Claude CLI could transport
// it.
function wantsClaudeEffort(overrides) {
  return Boolean(
    overrides?.providers?.claude?.effort !== undefined
    || overrides?.reviewers?.['claude-opus']?.effort !== undefined,
  );
}

function defaultReviewers(capabilities, overrides) {
  const reviewers = [];
  const has = (adapterId) => capabilities.some((item) => item.adapter_id === adapterId && item.available === true);
  const capabilityFor = (adapterId) => capabilities.find((item) => item.adapter_id === adapterId);
  if (has('claude-native-agent')) {
    const claudeCliCapability = capabilityFor('claude-cli');
    if (wantsClaudeEffort(overrides) && has('claude-cli') && claudeCliCapability?.effort_selection?.supported === true) {
      // The native agent cannot transport effort at all; bind claude-opus to
      // the CLI adapter instead so the explicit, supported effort is honored.
      reviewers.push({ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' });
    } else {
      reviewers.push({ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-native-agent' });
    }
  } else if (has('claude-cli')) reviewers.push({ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' });
  const codexAdapter = has('codex-native-generic')
    ? 'codex-native-generic'
    : has('codex-exec') ? 'codex-exec' : null;
  if (codexAdapter) {
    reviewers.push({ id: 'codex-review', provider: 'codex', role: 'standard', adapter_id: codexAdapter });
    reviewers.push({ id: 'codex-adversarial', provider: 'codex', role: 'adversarial', adapter_id: codexAdapter });
  }
  // agy is opt-in: capability detection alone never elects it. Candidacy is
  // restored only by an explicit argv signal transported as enabled_providers
  // (`--agy`, or a pre-existing agy-targeting model/effort override).
  if (has('agy-cli') && (overrides?.enabled_providers || []).includes('agy')) {
    reviewers.push({ id: 'agy', provider: 'agy', role: 'standard', adapter_id: 'agy-cli' });
  }
  // D13: grok is opt-in on the same terms. Capability detection alone never
  // elects it, so a no-flag review's plan is unchanged even where a verified
  // grok-cli capability is available.
  if (has('grok-cli') && (overrides?.enabled_providers || []).includes('grok')) {
    reviewers.push({ id: 'grok', provider: 'grok', role: 'standard', adapter_id: 'grok-cli' });
  }
  return reviewers;
}

function hasExecutionOverride(overrides) {
  return Boolean(overrides && (
    overrides.codex_only === true
    || Object.hasOwn(overrides, 'allow_fallback')
    || Object.values(overrides.providers || {}).some((value) => value.model !== undefined || value.effort !== undefined)
    || Object.values(overrides.reviewers || {}).some((value) => value.model !== undefined || value.effort !== undefined)
    || (overrides.routing_policy !== undefined && overrides.routing_policy !== 'auto')
  ));
}

// J1: a preflight error caused by policy enforcement (a denied/unavailable
// provider, a denied model, read-only unavailable, or an unparseable/type-
// invalid EXISTING policy file) is TERMINAL for the whole review even when the
// plan is not explicit — legacy dispatch must never proceed past a policy the
// project/user deliberately configured. Only environment/probe failures
// unrelated to policy enforcement keep the existing explicit-gated
// warn-and-continue behavior for non-explicit plans.
const POLICY_ENFORCEMENT_ERROR_PREFIXES = Object.freeze([
  'ERROR_PROVIDER_DENIED',
  'ERROR_MODEL_DENIED',
  'ERROR_READ_ONLY_UNAVAILABLE',
  'ERROR_PROVIDER_UNAVAILABLE',
]);

function isPolicyEnforcementError(error) {
  if (!error) return false;
  if (error.code === 'ERROR_POLICY_INVALID') return true;
  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message : '';
  return POLICY_ENFORCEMENT_ERROR_PREFIXES.some((prefix) => code.startsWith(prefix) || message.startsWith(prefix));
}

export function routingPreflightDecision({ explicit, shadowMode = false, error } = {}) {
  if (error) {
    if (explicit || !shadowMode || isPolicyEnforcementError(error)) {
      return { action: 'stop', error: error.message };
    }
    return { action: 'continue', warning: error.message };
  }
  return shadowMode
    ? { action: 'shadow', error: null }
    : { action: 'apply', error: null };
}

async function routingInputs(repo, env, runtime, knownEnvironment, overrides) {
  if (runtime.capabilities) return {
    capabilities: runtime.capabilities,
    reviewers: runtime.reviewers || defaultReviewers(runtime.capabilities, overrides),
    detected: runtime.detected,
  };
  const detected = knownEnvironment || await detectEnvironment({ cwd: repo, env });
  if (runtime.probes) {
    const capabilities = buildCapabilities({ detected, probes: runtime.probes, hostAssertions: runtime.hostAssertions });
    return { capabilities, reviewers: runtime.reviewers || defaultReviewers(capabilities, overrides), detected };
  }

  // R2I1: consult the on-disk capability cache before spawning fresh probes.
  // The cache is keyed by the detected environment (path/mtime/known
  // version) only — never by probe output, so the same key can be recomputed
  // before probing (to check the cache) and after probing (to save it).
  // Any cache IO failure must fail OPEN to a fresh probe, never a hard error.
  const invalidationKeys = capabilityCacheKeys(detected, {});
  try {
    // Repository-owned cache data is non-authoritative. Parsing it validates
    // containment/schema for diagnostics, but never skips the current probe
    // or supplies capability/availability/transport fields.
    loadCapabilityCache(repo, capabilityCacheFilePath(repo), invalidationKeys);
  } catch {
    // Cache IO never blocks a fresh authoritative probe.
  }

  const probes = await probeCapabilities({ detected, cwd: repo, env });
  const capabilities = buildCapabilities({
    detected,
    probes,
    hostAssertions: runtime.hostAssertions,
  });
  // H7: a transient probe failure (timeout/non-zero) must never be persisted —
  // with no TTL or success-only rule, an unavailable capability saved here
  // would keep the reviewer disabled on later runs even after the transient
  // clears. Only save when every executed probe for a detected binary
  // actually succeeded; cache hits and the fail-open behavior above are
  // unaffected.
  const probeFailed = (detected.claude_cli && probes.claude?.ok !== true)
    || (detected.codex_cli && probes.codex?.ok !== true);
  if (!probeFailed) {
    try {
      saveCapabilityCache(repo, capabilityCacheFilePath(repo), probes, invalidationKeys);
    } catch {
      // Best-effort persistence: a cache write failure must never affect this run's result.
    }
  }
  return { capabilities, reviewers: runtime.reviewers || defaultReviewers(capabilities, overrides), detected };
}

function routingPolicy(repo, env, overrides, runtime) {
  const defaults = {
    features: {
      semantic_classifier: true,
      adaptive_reviewer_routing: true,
      automatic_model_routing: true,
      routing_shadow_mode: false,
    },
    routing: {
      policy: 'auto',
      reviewer_strategy: 'adaptive',
      allow_fallback: false,
      require_read_only: true,
      document_round_limit: 2,
      high_risk_document_round_limit: 3,
      maximum_reviewers: 4,
      max_expansion_waves: 1,
    },
    providers: {}, constraints: {}, classification: {},
  };
  // J1: loadUserConfig/loadReviewPolicy already return null (never throw) for
  // a missing file — they only throw while parsing an EXISTING malformed or
  // schema-invalid file. Rethrow that case with a stable ERROR_POLICY_INVALID
  // code so routingPreflightDecision can classify it as policy-enforcement
  // (terminal) regardless of whether the plan is explicit.
  let user;
  try {
    user = runtime.userPolicy ?? loadUserConfig(env)?.policy ?? {};
  } catch (error) {
    throw Object.assign(new Error(`ERROR_POLICY_INVALID: user config: ${error.message}`), { code: 'ERROR_POLICY_INVALID' });
  }
  let project;
  try {
    project = runtime.projectPolicy ?? loadReviewPolicy(repo)?.policy ?? {};
  } catch (error) {
    throw Object.assign(new Error(`ERROR_POLICY_INVALID: project review-policy.yaml: ${error.message}`), { code: 'ERROR_POLICY_INVALID' });
  }
  const merged = mergeRoutingConfig({ defaults, user, project, cli: overrides });
  return { ...merged, user, project };
}

// H3: per-artifact content_risk is derived from path + current working-tree
// content only, so a change that removes high-risk terms (or deletes a
// high-risk file entirely) erases the evidence before assessment. Deriving
// one bounded risk-floor scalar from the actual patch — removed lines and
// deleted-file content included — closes that gap without persisting any
// raw diff text: only the resulting 'high'/undefined outcome is ever kept,
// and it feeds buildRoutingPlan as an additive floor alongside the existing
// per-artifact assessment. Any git failure (unexpected states, no HEAD, a
// hostile/corrupt repo) fails open to undefined — i.e. today's behavior.
function changeStateDiffArgs(changeState, reviewBase) {
  if (changeState === 'clean') return ['diff', `${reviewBase}..HEAD`];
  if (changeState === 'staged') return ['diff', '--cached'];
  return ['diff', 'HEAD'];
}

function computeChangeRiskFloor(repo, changeState, reviewBase) {
  if (changeState === 'non-git') return undefined;
  try {
    const args = changeStateDiffArgs(changeState, reviewBase);
    let result = gitSync(repo, args, { maxBuffer: 4 * 1024 * 1024 });
    // Only the HEAD-based bucket (unstaged/mixed/initial/untracked-only) has a
    // defined fallback: a repository with no HEAD yet (no commits) cannot
    // diff against it, so retry against the bare working tree diff.
    if (result.code !== 0 && args[1] === 'HEAD') {
      result = gitSync(repo, ['diff'], { maxBuffer: 4 * 1024 * 1024 });
    }
    if (result.code !== 0) return undefined;
    // Bound the scanned text well below the maxBuffer capture ceiling — the
    // patch itself is discarded immediately after this local scan.
    const patchText = result.stdout.toString('utf8').slice(0, 512 * 1024);
    const assessed = assessRisk([{ diff: patchText }]);
    return ['high', 'critical'].includes(assessed) ? assessed : undefined;
  } catch {
    return undefined;
  }
}

export async function runClassifyArtifactsCli(argv = process.argv.slice(2), env = process.env, runtime = {}) {
  const options = parseArguments(argv);
  const repo = resolve(options.repo);

  let { changeState, reviewBase } = options;
  let environment;
  if (!changeState) {
    environment = await detectEnvironment({ cwd: repo, env });
    changeState = environment.change_state;
    reviewBase = reviewBase ?? environment.review_base;
  }

  // Explicit NUL-delimited target list (git `--pathspec-file-nul` convention).
  const filesFromZ = options.filesFrom === undefined
    ? undefined
    : readFileSync(resolve(options.filesFrom));
  const hasExplicitTargets = filesFromZ !== undefined && filesFromZ.length > 0;

  // W2: a non-git workspace has no diff to derive a scope from. Refuse to
  // materialize an empty `mixed` provenance file — require an explicit target
  // list and fail closed otherwise.
  if (changeState === 'non-git' && !hasExplicitTargets) {
    throw new Error(
      'non-git workspace has no git change scope to classify. '
      + 'Provide an explicit NUL-delimited target list via --files-from0 <file>.',
    );
  }

  const classificationOptions = {
    repo, changeState, reviewBase, filesFromZ, generatedAt: deterministicTimestamp(env),
  };
  // I4: an orchestrator-supplied --host-assertions-json argv value is the only
  // transport for native host tool assertions into this subprocess. A runtime
  // object supplied by an in-process JS caller (tests, future embedders) keeps
  // full precedence over the parsed argv value.
  let hostAssertionsFromArgv;
  if (options.hostAssertionsJson !== undefined) {
    let parsedHostAssertions;
    try {
      parsedHostAssertions = JSON.parse(options.hostAssertionsJson);
    } catch (error) {
      throw new Error(`--host-assertions-json must contain valid JSON: ${error.message}`);
    }
    hostAssertionsFromArgv = validateHostAssertions(parsedHostAssertions);
  }
  const routingRuntime = hostAssertionsFromArgv === undefined
    ? runtime
    : { ...runtime, hostAssertions: runtime.hostAssertions ?? hostAssertionsFromArgv };
  // J3: options.overrides is the raw (pre-merge) CLI/override object — the
  // only source that distinguishes an explicit effort request from a
  // policy-file-only effort, so the native/CLI claude-opus adapter decision
  // must see this, not the later effective/merged overrides.
  const { capabilities, reviewers, detected } = await routingInputs(repo, env, routingRuntime, environment, options.overrides);
  const policy = routingPolicy(repo, env, options.overrides, runtime);
  const semanticAdapters = { ...(runtime.semanticAdapters || {}) };
  const claudeCapability = capabilities.find((item) => item.adapter_id === 'claude-cli' && item.available === true);
  if (!semanticAdapters['claude-cli'] && detected?.claude_cli_path && claudeCapability) {
    semanticAdapters['claude-cli'] = createClaudeCliSemanticAdapter({
      binary: detected.claude_cli_path,
      cwd: repo,
      env,
      model: claudeCapability.model_selection?.aliases?.[0],
      effort: 'low',
      effortTransport: claudeCapability.effort_selection?.transport,
    });
  }
  const semanticEnabled = policy.features?.semantic_classifier !== false
    && policy.classification?.mode !== 'deterministic'
    && (options.overrides?.allow_classifier === true
      || policy.user?.features?.semantic_classifier === true
      || policy.project?.features?.semantic_classifier === true);
  // I1: honor classification.max_classifier_bytes_per_artifact from the merged
  // policy for the semantic byte budget; any absent or invalid value keeps the
  // classifyArtifactsScopeWithSemantic / semantic-classify 24_576 default.
  const policyMaxBytes = policy.classification?.max_classifier_bytes_per_artifact;
  const maxClassifierBytes = Number.isSafeInteger(policyMaxBytes) && policyMaxBytes > 0
    ? policyMaxBytes
    : undefined;
  // H6: classification.thresholds from review-policy.yaml must reach both the
  // deterministic classifyArtifact() confidence bands and the semantic cache
  // fingerprint context — an absent or non-object policy value keeps the
  // classifyArtifact/DEFAULT_THRESHOLDS defaults untouched.
  classificationOptions.thresholds = (
    policy.classification?.thresholds
    && typeof policy.classification.thresholds === 'object'
    && !Array.isArray(policy.classification.thresholds)
  ) ? policy.classification.thresholds : undefined;
  classificationOptions.classificationOverrides = policy.classification?.overrides;
  let result = semanticEnabled
    ? await classifyArtifactsScopeWithSemantic({
      ...classificationOptions,
      pluginRoot: runtime.pluginRoot,
      capabilities,
      semanticAdapters,
      semanticAdapter: runtime.semanticAdapter,
      maxClassifierBytes,
    })
    : classifyArtifactsScope(classificationOptions);

  // Never persist an unresolved empty non-git scope, even if the target list
  // resolved to nothing (all excluded / out-of-repo / binary-only-dropped).
  if (changeState === 'non-git' && result.artifacts.length === 0) {
    throw new Error('non-git target list resolved to zero classifiable artifacts; nothing to write.');
  }

  result = {
    ...result,
    artifacts: result.artifacts.map((artifact) => ({
      ...artifact,
      semantic_status: artifact.semantic_status || (artifact.needs_semantic ? 'deferred' : 'not-needed'),
    })),
  };

  // G3: options.overrides only carries routing_policy/allow_fallback when the
  // caller actually passed --routing/--allow-fallback (public-route.mjs no
  // longer serializes 'auto'/false defaults). The *effective* overrides used
  // downstream (eligibility checks, buildRoutingPlan) must still resolve a
  // concrete routing_policy/allow_fallback, falling back to the already
  // policy-merged values so an unrelated flag (e.g. --allow-classifier) never
  // silently downgrades a project/user routing.policy or allow_fallback.
  // explicit_overrides continues to be computed from the RAW options.overrides
  // below (hasExecutionOverride), not from this effective object.
  const overrides = options.overrides
    ? {
      ...options.overrides,
      routing_policy: options.overrides.routing_policy ?? policy.routing?.policy ?? 'auto',
      allow_fallback: options.overrides.allow_fallback ?? Boolean(policy.routing?.allow_fallback),
    }
    : {
      protocol_version: '2.0', routing_policy: policy.routing?.policy || 'auto',
      allow_fallback: Boolean(policy.routing?.allow_fallback), allow_classifier: false,
      providers: {}, reviewers: {},
    };
  // G2: a disabled provider (--no-opus/--no-codex/--no-agy, including
  // --codex-only's expansion) must be excluded from eligibility checks and
  // the emitted routing plan, not just from provenance.
  const disabledProviders = new Set(overrides.disabled_providers || []);
  const eligibleReviewers = reviewers.filter((reviewer) => !disabledProviders.has(reviewer.provider));
  const explicit = hasExecutionOverride(options.overrides);
  for (const provider of Object.keys(overrides.providers || {})) {
    if (explicit && !eligibleReviewers.some((reviewer) => reviewer.provider === provider)) {
      throw new Error(`ERROR_PROVIDER_UNAVAILABLE: no eligible reviewer for explicit ${provider} override`);
    }
  }
  for (const reviewerId of Object.keys(overrides.reviewers || {})) {
    if (!eligibleReviewers.some((reviewer) => reviewer.id === reviewerId)) {
      throw new Error(`ERROR_PROVIDER_UNAVAILABLE: explicit reviewer ${reviewerId} is not eligible`);
    }
  }
  const riskFloor = computeChangeRiskFloor(repo, changeState, reviewBase);
  let adaptiveContext = null;
  if (options.adaptiveContextJson !== undefined) {
    try {
      adaptiveContext = validateAdaptiveContext(JSON.parse(options.adaptiveContextJson));
    } catch (error) {
      if (error.message.startsWith('--adaptive-context-json')) throw error;
      throw new Error(`--adaptive-context-json must contain valid JSON: ${error.message}`);
    }
  }
  const verifiedReadiness = overrides.readiness_receipt
    ? verifyReadinessReceipt({ repo, receiptPath: overrides.readiness_receipt })
    : null;
  const routingPlan = buildRoutingPlan({
    artifacts: result.artifacts,
    reviewers: eligibleReviewers,
    policy,
    overrides,
    capabilities,
    riskFloor,
    priorRisk: adaptiveContext?.risk,
    receiptRisk: verifiedReadiness?.risk,
    progress: adaptiveContext ? {
      state: adaptiveContext.progress,
      used_reviewers: adaptiveContext.used_reviewers,
    } : undefined,
  });
  routingPlan.explicit_overrides = explicit;
  routingPlan.apply_automatic = policy.features?.automatic_model_routing !== false
    && policy.features?.routing_shadow_mode !== true;
  result = {
    ...result,
    routing_plan: routingPlan,
    ...(verifiedReadiness ? {
      readiness_receipt: {
        status: verifiedReadiness.status,
        scope_sha256: verifiedReadiness.scope_sha256,
        risk: verifiedReadiness.risk,
        deferred_finding_count: verifiedReadiness.deferred_findings.length,
      },
    } : {}),
  };

  const outPath = options.out ? resolve(options.out) : defaultProvenancePath(repo);
  writeProvenance(repo, result, outPath);

  if (options.emitRoutingPlan) {
    const routingPlanPath = options.routingPlanOut ? resolve(options.routingPlanOut) : defaultRoutingPlanPath(repo);
    writeContainedFile(repo, routingPlanPath, `${JSON.stringify(routingPlan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(options.explainRouting ? formatExplainRouting(result) : formatDryRun(result));
  }
  return result;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  runClassifyArtifactsCli().catch((error) => {
    process.stderr.write(`classify-artifacts: ${error.message}\n`);
    process.exitCode = 2;
  });
}
