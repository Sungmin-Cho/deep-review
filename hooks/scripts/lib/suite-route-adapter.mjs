import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { locateDeepModelRouter } from './locate-deep-model-router.mjs';

const VALID_BANDS = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const EFFORT_NATIVE = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeRiskBand(value) {
  if (typeof value !== 'string') return null;
  const band = value.trim().toUpperCase();
  return VALID_BANDS.has(band) ? band : null;
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseDecision(stdout) {
  const trimmed = String(stdout ?? '').trim();
  if (!trimmed) return { error: 'empty-stdout' };
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return { error: 'non-json' }; }
  const decision = asObject(parsed);
  if (!decision) return { error: 'non-json' };
  if (decision.route_schema_version !== 1) return { error: 'unsupported-schema', decision };
  return { decision };
}

function baseOutcome({
  status, degrade_reason, localBand, decision = null,
  dispatch_authorized = false, routing_provenance = 'local-fallback', degrade_forbidden = false,
}) {
  return {
    dispatch_authorized,
    status,
    degrade_reason,
    risk_band: normalizeRiskBand(decision?.risk_band) ?? normalizeRiskBand(localBand),
    routing_provenance,
    degrade_forbidden,
    decision,
  };
}

export function translateRouteOutcome({
  exit, stdout, stderr, processState,
  localBand = null,
  python3Available = true,
  cliPath = true,
} = {}) {
  if (processState === 'TERMINATION_UNCONFIRMED' || /TERMINATION_UNCONFIRMED/.test(String(stderr || ''))) {
    return baseOutcome({ status: 'internal', degrade_reason: 'termination_unconfirmed', localBand });
  }
  if (python3Available === false) {
    return baseOutcome({ status: 'unavailable', degrade_reason: 'python3-unavailable', localBand });
  }
  if (!cliPath) {
    return baseOutcome({ status: 'unavailable', degrade_reason: 'router-missing', localBand });
  }
  if (['spawn_failed', 'permission_denied', 'timeout', 'signaled'].includes(processState)) {
    const status = processState === 'timeout' || processState === 'signaled' ? 'internal' : 'unavailable';
    return baseOutcome({ status, degrade_reason: processState, localBand });
  }
  if (exit == null || !Number.isInteger(exit) || exit < 0 || exit > 5) {
    return baseOutcome({ status: 'internal', degrade_reason: 'exit-out-of-range', localBand });
  }
  if (exit === 3 || exit === 4) {
    const parsed = parseDecision(stdout);
    if (parsed.error) {
      return baseOutcome({
        status: exit === 3 ? 'human_gate' : 'deferred_confirm',
        degrade_reason: parsed.error,
        localBand,
        routing_provenance: 'router',
        degrade_forbidden: true,
      });
    }
    return baseOutcome({
      status: exit === 3 ? 'human_gate' : 'deferred_confirm',
      degrade_reason: exit === 3 ? 'human_gate' : null,
      localBand,
      decision: parsed.decision,
      dispatch_authorized: exit === 4,
      routing_provenance: 'router',
      degrade_forbidden: true,
    });
  }
  const parsed = parseDecision(stdout);
  if (parsed.error) {
    return baseOutcome({
      status: parsed.error === 'empty-stdout' ? 'internal' : 'invalid',
      degrade_reason: parsed.error,
      localBand,
      decision: parsed.decision || null,
    });
  }
  const decision = parsed.decision;
  if (exit === 0) {
    return baseOutcome({
      status: 'ok', degrade_reason: null, localBand, decision,
      dispatch_authorized: true, routing_provenance: 'router',
    });
  }
  if (exit === 1) return baseOutcome({ status: 'terminal', degrade_reason: 'terminal', localBand, decision });
  if (exit === 2) return baseOutcome({ status: 'invalid', degrade_reason: 'invalid-input', localBand, decision });
  return baseOutcome({ status: 'internal', degrade_reason: 'internal', localBand, decision });
}

const PROVIDER_FAMILY = Object.freeze({
  claude: 'claude',
  openai: 'openai',
  codex: 'openai',
  agy: 'agy',
  gemini: 'gemini',
});

export function familyOfProvider(provider) {
  return PROVIDER_FAMILY[String(provider || '').toLowerCase()] || null;
}

export function familyOfModel(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return null;
  if (/(?:^|[-_])(?:claude|haiku|sonnet|opus|fable|terra|luna)/.test(id)) return 'claude';
  if (/^(?:gpt-|o[0-9])|sol|codex/.test(id)) return 'openai';
  if (/gemini/.test(id)) return 'gemini';
  if (/agy/.test(id)) return 'agy';
  return null;
}

export function sameProviderFamily(provider, selectedModel) {
  const left = familyOfProvider(provider);
  const right = familyOfModel(selectedModel);
  return Boolean(left && right && left === right);
}

export function applySuiteResolution(route, outcome, { provider } = {}) {
  const base = {
    ...route,
    suite_route: {
      applied: false,
      reason: outcome?.degrade_reason || outcome?.status || 'unused',
      status: outcome?.status ?? null,
      risk_band: outcome?.risk_band ?? null,
    },
  };
  if (!outcome?.dispatch_authorized || !outcome.decision) {
    return base;
  }
  const selectedModel = outcome.decision.selected_model;
  const selectedEffort = outcome.decision.selected_effort_native;
  if (!sameProviderFamily(provider || route.provider, selectedModel)) {
    return {
      ...base,
      suite_route: { ...base.suite_route, reason: 'family-mismatch', status: outcome.status },
    };
  }
  if (typeof selectedEffort === 'string' && selectedEffort && !EFFORT_NATIVE.has(selectedEffort)) {
    return {
      ...base,
      suite_route: { ...base.suite_route, reason: 'effort-token-unsupported', status: outcome.status },
    };
  }
  const resolved = {
    ...route.resolved,
    model: typeof selectedModel === 'string' ? selectedModel : route.resolved.model,
    effort: EFFORT_NATIVE.has(selectedEffort) ? selectedEffort : route.resolved.effort,
  };
  return {
    ...route,
    resolved,
    suite_route: {
      applied: true,
      reason: null,
      status: outcome.status,
      risk_band: outcome.risk_band,
      provenance: 'router',
      identity: {
        route_schema_version: outcome.decision.route_schema_version ?? 1,
        router_plugin_version: outcome.decision.router_plugin_version ?? null,
        policy_sha256: outcome.decision.policy_sha256 ?? null,
        decision_fingerprint: outcome.decision.decision_fingerprint ?? null,
        request_sha256: outcome.decision.request_sha256 ?? null,
      },
    },
  };
}

export function buildReviewRouteRequest({ risk, provider } = {}) {
  const band = String(risk || 'low').toLowerCase();
  const dims = band === 'critical' ? [3, 3, 3, 2]
    : band === 'high' ? [2, 2, 2, 1]
      : band === 'medium' ? [1, 1, 1, 1]
        : [0, 0, 0, 0];
  return {
    route_schema_version: 1,
    task_class: 'REVIEW',
    complexity: dims[0],
    uncertainty: dims[1],
    blast_radius: dims[2],
    reversibility: dims[3],
    reasoning_centric: true,
    flags: [],
    runtime: provider === 'codex' || provider === 'openai' ? 'codex' : 'claude_code',
    prior_failures: [],
  };
}

export function resolveSuiteOverlay({
  localBand,
  env = process.env,
  home,
  invoke,
  locate = locateDeepModelRouter,
  request,
} = {}) {
  if (typeof invoke === 'function') {
    return translateRouteOutcome({ ...invoke({ request, env, home }), localBand });
  }
  const cliPath = locate({ env, home });
  if (!cliPath) {
    return translateRouteOutcome({ localBand, cliPath: false });
  }
  const probe = spawnSync('python3', ['-c', 'import sys'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  if (probe.error || probe.status !== 0) {
    return translateRouteOutcome({ localBand, cliPath, python3Available: false });
  }
  const dir = mkdtempSync(join(tmpdir(), 'dr-suite-route-'));
  const reqPath = join(dir, 'request.json');
  writeFileSync(reqPath, JSON.stringify(request || buildReviewRouteRequest({})));
  try {
    const result = spawnSync('python3', [cliPath, '--request-json', reqPath, '--format', 'json'], {
      encoding: 'utf8',
      timeout: 15_000,
      env,
      maxBuffer: 2 * 1024 * 1024,
    });
    return translateRouteOutcome({
      exit: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      localBand,
      cliPath,
      processState: result.error?.code === 'ENOENT' ? 'spawn_failed' : undefined,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
