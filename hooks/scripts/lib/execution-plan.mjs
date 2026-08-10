import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isAssignmentRole,
  rubricIdForRole,
  validateRubricAssignment,
} from './assignment-rubrics.mjs';
import { isReviewerId, REVIEWER_PROVIDERS } from './reviewer-ids.mjs';

function requiredReviewerId(reviewerId) {
  if (!isReviewerId(reviewerId)) throw new Error(`routing plan reviewer-id is not canonical: ${reviewerId}`);
  return reviewerId;
}

function requiredNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`routing plan ${field} must be a non-empty string`);
  }
  return value;
}

function requiredBoundedInteger(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`routing plan ${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function fallbackAuthority(route) {
  let nestedPresent = false;
  let nestedValue;
  if (Object.hasOwn(route, 'fallback') && route.fallback !== null) {
    if (typeof route.fallback !== 'object' || Array.isArray(route.fallback)) {
      throw new Error('routing plan fallback must be an object or null');
    }
    nestedPresent = Object.hasOwn(route.fallback, 'allowed');
    if (nestedPresent) nestedValue = route.fallback.allowed;
  }
  const legacyPresent = Object.hasOwn(route, 'allow_fallback');
  const legacyValue = route.allow_fallback;
  for (const [present, value, field] of [
    [nestedPresent, nestedValue, 'fallback.allowed'],
    [legacyPresent, legacyValue, 'allow_fallback'],
  ]) {
    if (present && value !== null && typeof value !== 'boolean') {
      throw new Error(`routing plan fallback authority ${field} must be boolean or null`);
    }
  }
  return (nestedPresent ? nestedValue : legacyPresent ? legacyValue : false) === true;
}

function validateProtocol3Metadata(document) {
  if (!['document', 'implementation'].includes(document.artifact_phase)) {
    throw new Error('routing plan artifact_phase must be "document" or "implementation"');
  }
  if (!['low', 'medium', 'high', 'critical'].includes(document.risk)) {
    throw new Error('routing plan risk must be low, medium, high, or critical');
  }
  if (!['adaptive', 'static'].includes(document.reviewer_strategy)) {
    throw new Error('routing plan reviewer_strategy must be "adaptive" or "static"');
  }
  if (typeof document.shadow_mode !== 'boolean') {
    throw new Error('routing plan shadow_mode must be boolean');
  }
  if (!['initial', 'regression', 'confirmation', 'stalled', 'changed'].includes(document.progress)) {
    throw new Error('routing plan progress is invalid');
  }
  const maximumReviewers = requiredBoundedInteger(document.maximum_reviewers, 'maximum_reviewers', 1, 4);
  const minimumReviewers = requiredBoundedInteger(
    document.minimum_reviewers,
    'minimum_reviewers',
    1,
    maximumReviewers,
  );
  requiredBoundedInteger(document.planned_reviewers, 'planned_reviewers', minimumReviewers, maximumReviewers);
  requiredBoundedInteger(
    document.provider_family_minimum,
    'provider_family_minimum',
    1,
    minimumReviewers,
  );
  requiredBoundedInteger(document.max_expansion_waves, 'max_expansion_waves', 0, 1);
  for (const field of ['initial_reviewer_ids', 'required_reviewer_ids']) {
    if (!Array.isArray(document[field])
        || document[field].some((reviewerId) => !isReviewerId(reviewerId))
        || new Set(document[field]).size !== document[field].length) {
      throw new Error(`routing plan ${field} must contain unique canonical reviewer ids`);
    }
  }
  if (document.required_reviewer_ids.some((reviewerId) => (
    !document.initial_reviewer_ids.includes(reviewerId)
  ))) {
    throw new Error('routing plan required_reviewer_ids must be a subset of initial_reviewer_ids');
  }
}

export function parseExecutionPlanDocument(document, reviewerId) {
  requiredReviewerId(reviewerId);
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('routing plan must be a JSON object');
  if (!['2.0', '3.0'].includes(document.protocol_version)) {
    throw new Error('routing plan protocol_version must be "2.0" or "3.0"');
  }
  const routes = Array.isArray(document.routes)
    ? document.routes
    : Array.isArray(document.reviewers) ? document.reviewers : null;
  if (!routes) throw new Error('routing plan must contain routes or reviewers');
  let candidateById = null;
  if (document.protocol_version === '3.0') {
    validateProtocol3Metadata(document);
    if (!Array.isArray(document.candidate_reviewers)) {
      throw new Error('routing plan protocol 3.0 must contain candidate_reviewers');
    }
    candidateById = new Map();
    for (const candidate of document.candidate_reviewers) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('routing plan candidate_reviewers must contain objects');
      }
      requiredReviewerId(candidate.reviewer_id);
      if (candidateById.has(candidate.reviewer_id)) {
        throw new Error(`routing plan contains duplicate candidate reviewer: ${candidate.reviewer_id}`);
      }
      requiredNonEmptyString(candidate.provider, `candidate provider for ${candidate.reviewer_id}`);
      if (candidate.provider !== REVIEWER_PROVIDERS[candidate.reviewer_id]) {
        throw new Error(`routing plan candidate provider is not canonical: ${candidate.reviewer_id}`);
      }
      requiredNonEmptyString(candidate.adapter_id, `candidate adapter_id for ${candidate.reviewer_id}`);
      if (!Array.isArray(candidate.assignment_roles) || candidate.assignment_roles.length === 0
          || candidate.assignment_roles.some((role) => !isAssignmentRole(role))) {
        throw new Error(`routing plan candidate has invalid assignment roles: ${candidate.reviewer_id}`);
      }
      if (new Set(candidate.assignment_roles).size !== candidate.assignment_roles.length) {
        throw new Error(`routing plan candidate has duplicate assignment roles: ${candidate.reviewer_id}`);
      }
      if (!['success', 'unknown', 'failed'].includes(candidate.last_status)) {
        throw new Error(`routing plan candidate has invalid last_status: ${candidate.reviewer_id}`);
      }
      candidateById.set(candidate.reviewer_id, candidate);
    }
  }
  const seen = new Set();
  const initialReviewerIds = new Set(document.initial_reviewer_ids || []);
  const requiredReviewerIds = new Set(document.required_reviewer_ids || []);
  for (const candidate of routes) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('routing plan routes must be objects');
    }
    requiredReviewerId(candidate.reviewer_id);
    if (seen.has(candidate.reviewer_id)) {
      throw new Error(`routing plan contains duplicate reviewer route: ${candidate.reviewer_id}`);
    }
    seen.add(candidate.reviewer_id);
    if (document.protocol_version === '3.0') {
      validateRubricAssignment(candidate.assignment_role, candidate.rubric_id);
      const declared = candidateById.get(candidate.reviewer_id);
      if (!declared) {
        throw new Error(`routing plan route is absent from candidate_reviewers: ${candidate.reviewer_id}`);
      }
      if (!declared.assignment_roles.includes(candidate.assignment_role)) {
        throw new Error(
          `routing plan candidate ${candidate.reviewer_id} does not support assignment role ${candidate.assignment_role}`,
        );
      }
      if (candidate.provider !== declared.provider) {
        throw new Error(`routing plan provider mismatch for ${candidate.reviewer_id}`);
      }
      if (candidate.adapter_id !== declared.adapter_id) {
        throw new Error(`routing plan adapter mismatch for ${candidate.reviewer_id}`);
      }
      if (!Number.isInteger(candidate.wave) || candidate.wave < 1 || candidate.wave > 2) {
        throw new Error(`routing plan wave is invalid for ${candidate.reviewer_id}`);
      }
      if (candidate.wave > 1 && document.max_expansion_waves === 0) {
        throw new Error(`routing plan expansion wave is disabled for ${candidate.reviewer_id}`);
      }
      if (typeof candidate.required !== 'boolean') {
        throw new Error(`routing plan required flag is invalid for ${candidate.reviewer_id}`);
      }
      if ((candidate.wave === 1) !== initialReviewerIds.has(candidate.reviewer_id)) {
        throw new Error(`routing plan wave conflicts with initial reviewer set: ${candidate.reviewer_id}`);
      }
      if (candidate.wave === 1
          && candidate.required !== requiredReviewerIds.has(candidate.reviewer_id)) {
        throw new Error(`routing plan required flag conflicts with hard-required reviewer set: ${candidate.reviewer_id}`);
      }
      requiredNonEmptyString(candidate.selection_reason, `selection_reason for ${candidate.reviewer_id}`);
      if (!candidate.resolved || typeof candidate.resolved !== 'object' || Array.isArray(candidate.resolved)
          || !Object.hasOwn(candidate.resolved, 'model') || !Object.hasOwn(candidate.resolved, 'effort')) {
        throw new Error(`routing plan resolved model/effort is invalid for ${candidate.reviewer_id}`);
      }
    }
  }
  if ([...initialReviewerIds].some((reviewerId) => !seen.has(reviewerId))) {
    throw new Error('routing plan initial reviewer set contains a reviewer without a route');
  }
  if (document.protocol_version === '3.0' && routes.length > document.maximum_reviewers) {
    throw new Error('routing plan route count exceeds maximum_reviewers');
  }
  const route = routes.find((item) => item.reviewer_id === reviewerId);
  if (!route) throw new Error(`routing plan has no reviewer route for ${reviewerId}`);
  const requested = route.requested || route;
  const resolved = route.resolved || route;
  const source = requested.source || route.source || 'auto';
  const assignmentRole = document.protocol_version === '3.0' ? route.assignment_role : 'standard';
  const rubricId = document.protocol_version === '3.0' ? route.rubric_id : rubricIdForRole(assignmentRole);
  return {
    model: resolved.model ?? null,
    effort: resolved.effort ?? null,
    requestedModel: requested.model ?? null,
    requestedEffort: requested.effort ?? null,
    source,
    modelSource: requested.model_source || source,
    effortSource: requested.effort_source || source,
    allowFallback: fallbackAuthority(route),
    modelTransport: route.transports?.model || route.model_transport,
    effortTransport: route.transports?.effort || route.effort_transport,
    routingFallback: route.fallback || null,
    assignmentRole,
    rubricId,
    wave: document.protocol_version === '3.0' ? route.wave : 1,
    required: document.protocol_version === '3.0' ? route.required : false,
    artifactPhase: document.protocol_version === '3.0' ? document.artifact_phase ?? null : null,
    risk: document.protocol_version === '3.0' ? document.risk ?? null : null,
  };
}

// Consumers never need the whole plan — each one reduces it to its own route.
// Carrying that route inline through argv removes the plan file from the
// consumer path entirely, so a repository-placed plan has nothing to hijack.
//
// Only the route-level checks can run here. The document-coupled ones
// (candidate-set membership, provider/adapter agreement, the max_expansion_waves
// gate, the wave/required cross-checks against the initial and hard-required
// sets, and the maximum_reviewers cap) have no single-route analogue; those
// invariants stay enforced at the synthesis boundary, which still receives the
// whole plan.
export function parseExecutionRoute(route, reviewerId) {
  requiredReviewerId(reviewerId);
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw new Error('execution route must be a JSON object');
  }
  // Pinned, not branched. A route arriving as "2.0" would otherwise derive
  // assignment_role 'standard' and rubric_id 'standard-v1' with no error and
  // skip validateRubricAssignment entirely, putting the wrong rubric text into
  // the trusted assignment header.
  if (route.protocol_version !== '3.0') {
    throw new Error('execution route protocol_version must be "3.0"');
  }
  requiredReviewerId(route.reviewer_id);
  if (route.reviewer_id !== reviewerId) {
    throw new Error(`execution route reviewer_id ${route.reviewer_id} does not match requested ${reviewerId}`);
  }
  if (route.provider !== REVIEWER_PROVIDERS[route.reviewer_id]) {
    throw new Error(`execution route provider mismatch for ${route.reviewer_id}`);
  }
  requiredNonEmptyString(route.adapter_id, `adapter_id for ${route.reviewer_id}`);
  validateRubricAssignment(route.assignment_role, route.rubric_id);
  if (!Number.isInteger(route.wave) || route.wave < 1 || route.wave > 2) {
    throw new Error(`execution route wave is invalid for ${route.reviewer_id}`);
  }
  if (typeof route.required !== 'boolean') {
    throw new Error(`execution route required flag is invalid for ${route.reviewer_id}`);
  }
  requiredNonEmptyString(route.selection_reason, `selection_reason for ${route.reviewer_id}`);
  if (!route.resolved || typeof route.resolved !== 'object' || Array.isArray(route.resolved)
      || !Object.hasOwn(route.resolved, 'model') || !Object.hasOwn(route.resolved, 'effort')) {
    throw new Error(`execution route resolved model/effort is invalid for ${route.reviewer_id}`);
  }
  const requested = route.requested || route;
  const resolved = route.resolved;
  const source = requested.source || route.source || 'auto';
  return {
    model: resolved.model ?? null,
    effort: resolved.effort ?? null,
    requestedModel: requested.model ?? null,
    requestedEffort: requested.effort ?? null,
    source,
    modelSource: requested.model_source || source,
    effortSource: requested.effort_source || source,
    allowFallback: fallbackAuthority(route),
    modelTransport: route.transports?.model || route.model_transport,
    effortTransport: route.transports?.effort || route.effort_transport,
    routingFallback: route.fallback || null,
    assignmentRole: route.assignment_role,
    rubricId: route.rubric_id,
    wave: route.wave,
    required: route.required,
    // Document-level context by definition: an inline route carries neither.
    artifactPhase: null,
    risk: null,
  };
}

export function parseExecutionRouteJson(value, reviewerId) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`--execution-route-json must be valid JSON: ${error.message}`);
  }
  return parseExecutionRoute(parsed, reviewerId);
}

export function loadExecutionPlan(filePath, reviewerId) {
  let document;
  try { document = JSON.parse(readFileSync(resolve(filePath), 'utf8')); }
  catch (error) { throw new Error(`failed to read routing plan ${filePath}: ${error.message}`); }
  return parseExecutionPlanDocument(document, reviewerId);
}
