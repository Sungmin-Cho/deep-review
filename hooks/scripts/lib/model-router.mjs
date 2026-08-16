import { EFFORT_ALIASES, EFFORT_LEVELS, MODEL_TIERS } from './target-taxonomy.mjs';
import {
  maximumRisk,
  planReviewerAssignments,
} from './adaptive-review-routing.mjs';
import { isAssignmentRole, rubricIdForRole } from './assignment-rubrics.mjs';
import {
  applySuiteResolution,
  buildReviewRouteRequest,
  resolveSuiteOverlay,
} from './suite-route-adapter.mjs';

export const ROUTING_PROTOCOL_VERSION = '3.0';

const HIGH_RISK = Object.freeze([
  /\bauthentication\b/iu, /\bauthori[sz]ation\b/iu, /\bpayments?\b/iu, /\bbilling\b/iu,
  /\bsecrets?\b/iu, /\bcryptograph/iu, /\b(?:schema\s+)?migration\b/iu,
  /\bconcurrenc/iu, /\brace condition\b/iu,
  /\b(?:retry|idempotenc)/iu, /\bdistributed lock\b/iu, /\bdeploy/iu,
  /\binfrastructure\b/iu, /\bpublic api\b/iu, /\bbackward incompat/iu,
  /\b(?:rollback|recovery)\b/iu, /(?:^|[/\\])auth(?:[/\\]|$)/iu,
]);
const CRITICAL_RISK = Object.freeze([
  /\bdestructive\b/iu,
  /\birreversible\b/iu,
  /\buser data\b/iu,
  /\bsecurity boundary\b/iu,
  /\bpermission boundary\b/iu,
]);
const SIZE_NAMES = Object.freeze(['tiny', 'small', 'medium', 'large']);
const EFFORT_ORDER = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_SIZE_THRESHOLDS = Object.freeze({
  code: Object.freeze([100, 400, 1500]),
  document: Object.freeze([10 * 1024, 30 * 1024, 100 * 1024]),
});

export function assessRisk(artifacts = [], options = {}) {
  if (!Array.isArray(artifacts)) throw new TypeError('artifacts must be an array');
  const text = artifacts.map((artifact) => [
    artifact.path, artifact.diff, artifact.content, artifact.signal_summary,
  ].filter(Boolean).join('\n')).join('\n');
  const highSignal = artifacts.some((artifact) => ['high', 'critical'].includes(artifact.content_risk))
    || HIGH_RISK.some((pattern) => pattern.test(text));
  const criticalSignal = artifacts.some((artifact) => artifact.content_risk === 'critical')
    || CRITICAL_RISK.some((pattern) => pattern.test(text));
  const uncertain = artifacts.some((artifact) => (
    (Number.isFinite(artifact?.confidence) && artifact.confidence < 0.55)
    || artifact?.semantic_status === 'failed'
    || (artifact?.needs_semantic === true && artifact?.semantic_status === 'deferred')
  ));
  const targetKinds = new Set(artifacts.map((artifact) => artifact?.target_kind).filter(Boolean));
  const mixed = targetKinds.has('mixed') || targetKinds.size > 1;
  let assessed = highSignal && criticalSignal
    ? 'critical'
    : highSignal || criticalSignal ? 'high'
      : uncertain || mixed ? 'medium' : 'low';
  assessed = maximumRisk(
    assessed,
    options.riskFloor,
    options.priorRisk,
    options.receiptRisk,
    options.policyRisk,
  );
  return assessed;
}

function sizeThresholds(value, name) {
  const supplied = value !== undefined;
  const thresholds = supplied ? value : DEFAULT_SIZE_THRESHOLDS[name];
  const valid = Array.isArray(thresholds)
    && thresholds.length === 3
    && thresholds.every((entry) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0)
    && thresholds[0] < thresholds[1]
    && thresholds[1] < thresholds[2];
  if (!valid) {
    throw Object.assign(
      new Error(`ERROR_POLICY_INVALID: classification.size_thresholds.${name} must be three finite non-negative strictly increasing numbers`),
      { code: 'ERROR_POLICY_INVALID' },
    );
  }
  return thresholds;
}

export function assessSize(artifact = {}, thresholds = {}) {
  const values = thresholds && typeof thresholds === 'object' && !Array.isArray(thresholds)
    ? thresholds
    : { code: thresholds, document: thresholds };
  const codeThresholds = sizeThresholds(values.code, 'code');
  const documentThresholds = sizeThresholds(values.document, 'document');
  const isCode = artifact.target_kind === 'code-change' || Number.isFinite(artifact.changed_lines);
  const value = isCode
    ? Number(Number.isFinite(artifact.changed_lines) ? artifact.changed_lines : (artifact.line_count ?? 0))
    : Number(artifact.byte_size || 0);
  const limits = isCode ? codeThresholds : documentThresholds;
  const index = limits.findIndex((limit) => value <= limit);
  return SIZE_NAMES[index < 0 ? 3 : index];
}

function baseMatrixProfile(targetKind, risk, role) {
  if (role === 'classifier') return { model_tier: 'fast', effort: 'low', reviewer_plan: 'semantic classifier' };
  if (targetKind === 'code-change') {
    if (risk === 'high' || risk === 'critical') return { model_tier: 'quality', effort: 'xhigh', reviewer_plan: 'standard + adversarial + independent provider' };
    if (risk === 'medium') return { model_tier: 'quality', effort: 'high', reviewer_plan: 'standard + optional adversarial' };
    return { model_tier: 'balanced', effort: 'high', reviewer_plan: 'standard + cross-provider' };
  }
  if (targetKind === 'design-document' || targetKind === 'architecture-decision-record') {
    return risk === 'high' || risk === 'critical'
      ? { model_tier: 'maximum', effort: 'xhigh', reviewer_plan: 'standard + adversarial + security/ops lens' }
      : { model_tier: 'quality', effort: 'high', reviewer_plan: 'standard + adversarial' };
  }
  if (targetKind === 'implementation-plan') {
    return risk === 'high' || risk === 'critical'
      ? { model_tier: 'quality', effort: 'xhigh', reviewer_plan: 'plan + adversarial + traceability' }
      : { model_tier: 'quality', effort: 'high', reviewer_plan: 'plan + feasibility' };
  }
  if (targetKind === 'requirements-specification' || targetKind === 'test-plan') {
    return { model_tier: 'quality', effort: 'high', reviewer_plan: 'completeness + testability' };
  }
  if (targetKind === 'configuration-infrastructure' || targetKind === 'runbook-operations') {
    return { model_tier: 'quality', effort: (risk === 'high' || risk === 'critical') ? 'xhigh' : 'high', reviewer_plan: 'infra + adversarial' };
  }
  if (targetKind === 'mixed') return { model_tier: 'quality', effort: 'high', reviewer_plan: 'per-unit reviewers + traceability' };
  return { model_tier: 'balanced', effort: 'medium', reviewer_plan: 'generic standard' };
}

function floorOrdered(value, floor, order) {
  const valueIndex = order.indexOf(value);
  const floorIndex = order.indexOf(floor);
  return valueIndex >= floorIndex ? value : floor;
}

function matrixProfile(targetKind, risk, size, role) {
  const profile = baseMatrixProfile(targetKind, risk, role);
  if (role === 'classifier' || size === 'tiny' || size === 'small') return profile;
  if (size === 'medium') {
    return { ...profile, effort: floorOrdered(profile.effort, 'high', EFFORT_ORDER) };
  }
  if (size === 'large') {
    return {
      ...profile,
      model_tier: floorOrdered(profile.model_tier, 'quality', MODEL_TIERS),
      effort: floorOrdered(profile.effort, 'high', EFFORT_ORDER),
    };
  }
  return profile;
}

function applyRoutingPolicy(profile, routingPolicy, risk) {
  if (routingPolicy === 'fast') return { ...profile, model_tier: risk === 'critical' ? 'balanced' : 'fast', effort: risk === 'critical' ? 'medium' : 'low' };
  if (routingPolicy === 'balanced') return { ...profile, model_tier: 'balanced', effort: profile.effort === 'low' ? 'medium' : 'high' };
  if (routingPolicy === 'quality') return { ...profile, model_tier: risk === 'high' || risk === 'critical' ? 'maximum' : 'quality', effort: risk === 'high' || risk === 'critical' ? 'xhigh' : 'high' };
  return profile;
}

function adjustedProfile(profile, adjustment = 0) {
  if (!Number.isInteger(adjustment) || adjustment === 0) return profile;
  const move = (value, order) => {
    const index = order.indexOf(value);
    if (index < 0) return value;
    return order[Math.max(0, Math.min(order.length - 1, index + adjustment))];
  };
  return {
    ...profile,
    model_tier: move(profile.model_tier, MODEL_TIERS),
    effort: move(profile.effort, EFFORT_ORDER),
  };
}

function capabilityFor(reviewer, capabilities) {
  return capabilities.find((item) => item.adapter_id === reviewer.adapter_id)
    || capabilities.find((item) => item.provider === reviewer.provider && item.roles?.includes(reviewer.role));
}

function policyValue(layer, reviewer, field) {
  return layer?.routing?.reviewers?.[reviewer.id]?.[field]
    ?? layer?.reviewers?.[reviewer.id]?.[field]
    ?? layer?.providers?.[reviewer.provider]?.[field];
}

function sourceSelection({ profile, reviewer, policy, overrides }) {
  const project = policy.project || policy;
  const user = policy.user || {};
  const reviewerCli = overrides.reviewers?.[reviewer.id] || {};
  const providerCli = overrides.providers?.[reviewer.provider] || {};

  let model;
  let effort = profile.effort;
  let modelSource = 'auto';
  let effortSource = 'auto';
  const userModel = policyValue(user, reviewer, 'model');
  const projectModel = policyValue(project, reviewer, 'model');
  const userEffort = policyValue(user, reviewer, 'effort');
  const projectEffort = policyValue(project, reviewer, 'effort');
  if (userModel !== undefined) { model = userModel; modelSource = 'user-policy'; }
  if (projectModel !== undefined) { model = projectModel; modelSource = 'project-policy'; }
  if (userEffort !== undefined) { effort = userEffort; effortSource = 'user-policy'; }
  if (projectEffort !== undefined) { effort = projectEffort; effortSource = 'project-policy'; }
  if (providerCli.model !== undefined) { model = providerCli.model; modelSource = 'cli-provider'; }
  if (providerCli.effort !== undefined) { effort = providerCli.effort; effortSource = 'cli-provider'; }
  if (reviewerCli.model !== undefined) { model = reviewerCli.model; modelSource = 'cli-reviewer'; }
  if (reviewerCli.effort !== undefined) { effort = reviewerCli.effort; effortSource = 'cli-reviewer'; }
  const source = modelSource === 'cli-reviewer' || effortSource === 'cli-reviewer'
    ? 'cli-reviewer'
    : modelSource === 'cli-provider' || effortSource === 'cli-provider'
      ? 'cli-provider'
      : modelSource !== 'auto' ? modelSource : effortSource;
  return { model, effort: EFFORT_ALIASES[effort] || effort, source, model_source: modelSource, effort_source: effortSource };
}

function resolveTier(tier, reviewer, policy, capability) {
  const project = policy.project || policy;
  const fromProject = project?.providers?.[reviewer.provider]?.model_tiers?.[tier];
  const fromUser = policy.user?.providers?.[reviewer.provider]?.model_tiers?.[tier];
  if (fromProject) return { model: fromProject, source: 'project-tier-map' };
  if (fromUser) return { model: fromUser, source: 'user-tier-map' };
  const tierIndex = MODEL_TIERS.indexOf(tier);
  const alias = capability?.model_selection?.aliases?.[tierIndex];
  if (alias) return { model: alias, source: 'adapter-alias' };
  return { model: null, source: 'provider-default' };
}

function isExplicit(source) {
  return typeof source === 'string' && source.startsWith('cli-');
}

function previousSupportedEffort(requested, supported) {
  const start = EFFORT_ORDER.indexOf(requested);
  for (let index = start - 1; index >= 0; index -= 1) {
    if (supported.includes(EFFORT_ORDER[index])) return EFFORT_ORDER[index];
  }
  return null;
}

function validateConstraints(requested, reviewer, policy, capability) {
  const constraints = (policy.project || policy).constraints || policy.constraints || {};
  if (constraints.allowed_providers && !constraints.allowed_providers.includes(reviewer.provider)) throw new Error('ERROR_PROVIDER_DENIED');
  if (constraints.denied_providers?.includes(reviewer.provider)) throw new Error('ERROR_PROVIDER_DENIED');
  if (requested.model && constraints.deny_models?.includes(requested.model)) throw new Error('ERROR_MODEL_DENIED');
  if (constraints.allow_models && requested.model && !constraints.allow_models.includes(requested.model)) throw new Error('ERROR_MODEL_DENIED');
  if ((policy.routing?.require_read_only || constraints.require_read_only)
      && (!capability.read_only_enforcement || capability.read_only_enforcement === 'none')) {
    throw new Error('ERROR_READ_ONLY_UNAVAILABLE');
  }
}

export function routeReviewer({ unit, reviewer, risk = 'low', size = 'small', policy = {}, overrides = {}, capabilities = [], artifactPhase, documentReviewMode, suiteResolve }) {
  const capability = capabilityFor(reviewer, capabilities);
  if (!capability || capability.available === false) throw new Error(`ERROR_PROVIDER_UNAVAILABLE: ${reviewer.provider}`);
  const routingPolicy = overrides.routing_policy || policy.routing?.policy || 'auto';
  const assignmentRole = reviewer.assignment_role || reviewer.role;
  const profile = adjustedProfile(
    applyRoutingPolicy(matrixProfile(unit.target_kind, risk, size, assignmentRole), routingPolicy, risk),
    reviewer.tier_adjustment || 0,
  );
  const selected = sourceSelection({ profile, reviewer, policy, overrides });
  const tierResolution = resolveTier(profile.model_tier, reviewer, policy, capability);
  const requested = {
    model_tier: profile.model_tier,
    model: selected.model ?? tierResolution.model,
    effort: selected.effort,
    source: selected.source,
    model_source: selected.model_source === 'auto' ? tierResolution.source : selected.model_source,
    effort_source: selected.effort_source,
  };
  validateConstraints(requested, reviewer, policy, capability);

  const resolved = { model: requested.model, effort: requested.effort };
  const fallback = { allowed: Boolean(overrides.allow_fallback), occurred: false, requested: { model: requested.model, effort: requested.effort }, applied: null, reason: null };
  const modelCapability = capability.model_selection || {};
  const effortCapability = capability.effort_selection || {};
  const explicitModel = isExplicit(requested.model_source);
  const explicitEffort = isExplicit(requested.effort_source);

  if (explicitModel && modelCapability.supported === 'unknown' && ['none', 'unknown', undefined].includes(modelCapability.transport)) {
    throw new Error('ERROR_MODEL_TRANSPORT_UNAVAILABLE');
  }
  const knownModelUnsupported = requested.model && (modelCapability.supported === false
    || (modelCapability.catalog_complete === true && !modelCapability.aliases?.includes(requested.model)));
  if (knownModelUnsupported) {
    if (explicitModel && !fallback.allowed) throw new Error(`ERROR_UNSUPPORTED_MODEL: ${requested.model}`);
    const replacement = tierResolution.model && tierResolution.model !== requested.model ? tierResolution.model : null;
    if (!replacement) {
      if (explicitModel) throw new Error(`ERROR_UNSUPPORTED_MODEL: ${requested.model}`);
      resolved.model = null;
      fallback.occurred = true;
      fallback.reason = 'automatic model uses provider default because no supported tier mapping is known';
    } else {
      resolved.model = replacement;
      fallback.occurred = true;
      fallback.reason = explicitModel ? 'requested model unsupported by adapter' : 'automatic tier mapped to supported adapter alias';
    }
  }

  if (explicitEffort && effortCapability.supported === 'unknown' && ['none', 'unknown', undefined].includes(effortCapability.transport)) {
    throw new Error('ERROR_EFFORT_TRANSPORT_UNAVAILABLE');
  }
  const effortSupported = effortCapability.supported === true && effortCapability.levels?.includes(requested.effort);
  if (!effortSupported) {
    if (explicitEffort && !fallback.allowed) throw new Error(`ERROR_UNSUPPORTED_EFFORT: ${requested.effort}`);
    const replacement = previousSupportedEffort(requested.effort, effortCapability.levels || []);
    if (replacement) {
      resolved.effort = replacement;
      fallback.occurred = true;
      fallback.reason ||= explicitEffort ? 'requested effort unsupported by adapter' : 'automatic effort mapped to nearest supported level';
    } else if (explicitEffort) {
      resolved.effort = null;
      fallback.occurred = true;
      fallback.reason ||= 'requested effort unsupported by adapter';
    } else if (!explicitEffort) {
      resolved.effort = null;
      fallback.occurred = true;
      fallback.reason ||= 'automatic effort omitted because adapter transport is unsupported or unknown';
    }
  }
  if (fallback.occurred) fallback.applied = { ...resolved };

  const localRoute = {
    protocol_version: ROUTING_PROTOCOL_VERSION,
    reviewer_id: reviewer.id,
    provider: reviewer.provider,
    adapter_id: capability.adapter_id,
    assignment_role: assignmentRole,
    rubric_id: reviewer.rubric_id || `${assignmentRole}-v1`,
    wave: reviewer.wave || 1,
    required: Boolean(reviewer.required),
    selection_reason: reviewer.selection_reason || 'legacy direct route',
    transports: {
      model: capability.model_selection?.transport ?? 'unknown',
      effort: capability.effort_selection?.transport ?? 'unknown',
    },
    requested,
    resolved,
    fallback,
    route_explanation: `${unit.target_kind}/${risk}/${size}/${assignmentRole} -> ${profile.model_tier}/${profile.effort}; reviewer plan: ${profile.reviewer_plan}`,
    ...(artifactPhase ? {
      artifact_phase: artifactPhase,
      risk,
      document_review_mode: documentReviewMode,
    } : {}),
  };
  const explicit = isExplicit(requested.model_source) || isExplicit(requested.effort_source);
  const suiteEnabled = typeof suiteResolve === 'function' || policy.features?.suite_model_resolver === true;
  if (explicit || policy.features?.automatic_model_routing === false || !suiteEnabled) {
    return {
      ...localRoute,
      suite_route: {
        applied: false,
        reason: explicit ? 'explicit-override'
          : policy.features?.automatic_model_routing === false ? 'disabled'
            : 'not-configured',
      },
    };
  }
  const outcome = typeof suiteResolve === 'function'
    ? suiteResolve({ risk, provider: reviewer.provider, localRoute })
    : resolveSuiteOverlay({
      localBand: String(risk || 'low').toUpperCase(),
      request: buildReviewRouteRequest({ risk, provider: reviewer.provider }),
    });
  return applySuiteResolution(localRoute, outcome, { provider: reviewer.provider });
}

function maxClass(values, order) {
  return values.reduce((highest, value) => order.indexOf(value) > order.indexOf(highest) ? value : highest, order[0]);
}

export function buildRoutingPlan({
  artifacts = [],
  reviewers = [],
  policy = {},
  overrides = {},
  capabilities = [],
  riskFloor,
  priorRisk,
  receiptRisk,
  progress,
  suiteResolve,
} = {}) {
  // H3: riskFloor is an optional additive override — when the caller has
  // independently derived 'high' risk from the actual change patch (removed
  // high-risk content, a deleted high-risk file), it wins over the
  // per-artifact assessment without weakening it. Leaving riskFloor
  // undefined preserves every existing caller's behavior exactly.
  const sizes = artifacts.map((artifact) => assessSize(artifact, policy.classification?.size_thresholds));
  const size = sizes.length ? maxClass(sizes, SIZE_NAMES) : 'tiny';
  const risk = maximumRisk(
    assessRisk(artifacts, {
      riskFloor,
      priorRisk,
      receiptRisk,
    }),
    ['medium', 'large'].includes(size) ? 'medium' : 'low',
  );
  const unit = artifacts.length === 1 ? artifacts[0] : { target_kind: artifacts.length ? 'mixed' : 'unknown' };
  const reviewerStrategy = overrides.reviewer_strategy
    || (policy.features?.adaptive_reviewer_routing === false
      ? 'static'
      : policy.routing?.reviewer_strategy || 'adaptive');
  const candidates = reviewers
    .filter((reviewer) => reviewer.adapter_id !== 'codex-companion')
    .map((reviewer) => {
      const capability = capabilityFor(reviewer, capabilities);
      const assignmentRoles = (
        reviewer.assignment_roles
        || capability?.assignment_roles
        || capability?.roles
        || [reviewer.role]
      )
        .filter(isAssignmentRole);
      return {
        ...reviewer,
        assignment_roles: assignmentRoles.length > 0 ? assignmentRoles : [reviewer.role],
        last_status: reviewer.last_status,
      };
    });
  const requiredReviewers = [
    ...new Set([
      ...(overrides.required_reviewers || []),
      ...Object.keys(overrides.reviewers || {}),
    ]),
  ];
  const assignmentPlan = planReviewerAssignments({
    artifacts,
    risk,
    candidates,
    reviewerStrategy,
    maximumReviewers: policy.routing?.maximum_reviewers ?? 4,
    progress,
    requiredReviewers,
    requiredProviders: overrides.required_providers || [],
    providerOverrides: overrides.providers || {},
    codexOnly: overrides.codex_only === true,
  });
  const reviewerById = new Map(reviewers.map((reviewer) => [reviewer.id, reviewer]));
  const routedAssignment = (assignment) => {
    const reviewer = reviewerById.get(assignment.reviewer_id);
    return routeReviewer({
      unit,
      reviewer: {
        ...reviewer,
        ...assignment,
        role: assignment.assignment_role,
      },
      risk,
      size,
      policy,
      overrides,
      capabilities,
      artifactPhase: assignmentPlan.artifact_phase,
      documentReviewMode: assignmentPlan.document_review_mode,
      suiteResolve,
    });
  };
  const routes = assignmentPlan.assignments.map(routedAssignment);
  const selectedIds = new Set(routes.map((route) => route.reviewer_id));
  const candidateReviewers = assignmentPlan.candidate_reviewers.map((candidate) => {
    if (selectedIds.has(candidate.reviewer_id)) return candidate;
    const expansionRouteTemplates = [];
    const expansionRouteErrors = [];
    for (const assignmentRole of candidate.assignment_roles) {
      try {
        expansionRouteTemplates.push(routedAssignment({
          reviewer_id: candidate.reviewer_id,
          provider: candidate.provider,
          adapter_id: candidate.adapter_id,
          assignment_role: assignmentRole,
          rubric_id: rubricIdForRole(assignmentRole),
          wave: 2,
          required: false,
          tier_adjustment: 1,
          selection_reason: 'same-round expansion route template',
        }));
      } catch (error) {
        expansionRouteErrors.push({
          assignment_role: assignmentRole,
          error: error.message,
        });
      }
    }
    return {
      ...candidate,
      expansion_route_templates: expansionRouteTemplates,
      ...(expansionRouteErrors.length > 0
        ? { expansion_route_errors: expansionRouteErrors }
        : {}),
    };
  });
  return {
    protocol_version: ROUTING_PROTOCOL_VERSION,
    codex_only: overrides.codex_only === true,
    routing_policy: overrides.routing_policy || policy.routing?.policy || 'auto',
    reviewer_strategy: reviewerStrategy,
    shadow_mode: policy.features?.routing_shadow_mode === true,
    artifact_phase: assignmentPlan.artifact_phase,
    document_review_mode: assignmentPlan.document_review_mode,
    risk,
    size,
    progress: assignmentPlan.progress,
    candidate_reviewers: candidateReviewers,
    minimum_reviewers: assignmentPlan.minimum_reviewers,
    maximum_reviewers: assignmentPlan.maximum_reviewers,
    provider_family_minimum: assignmentPlan.provider_family_minimum,
    planned_reviewers: assignmentPlan.planned_reviewers,
    initial_reviewer_ids: assignmentPlan.initial_reviewer_ids,
    required_reviewer_ids: assignmentPlan.required_reviewer_ids,
    shortfalls: assignmentPlan.shortfalls,
    confidence_floor: assignmentPlan.confidence_floor,
    operational_failure: assignmentPlan.operational_failure,
    max_expansion_waves: policy.routing?.max_expansion_waves ?? 1,
    routes,
  };
}

export function renderRoutingExplanation(plan) {
  const lines = [
    `Routing policy: ${plan.routing_policy}${plan.shadow_mode ? ' (shadow)' : ''}`,
    `Reviewer strategy: ${plan.reviewer_strategy || 'static'}; phase=${plan.artifact_phase || 'unknown'}; risk=${plan.risk || 'unknown'}`,
  ];
  for (const route of plan.routes) {
    lines.push(`${route.reviewer_id}: model=${route.resolved.model ?? 'provider-default'}, effort=${route.resolved.effort ?? 'provider-default'}`);
    lines.push(`  ${route.route_explanation}`);
    if (route.fallback.occurred) lines.push(`  fallback: ${route.fallback.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

// Keep imports live and enforce canonical vocabulary ownership at module load.
if (!MODEL_TIERS.length || !EFFORT_LEVELS.length) throw new Error('routing vocabulary unavailable');
