import { rubricIdForRole, isDocumentReviewMode } from './assignment-rubrics.mjs';
import { REVIEWER_IDS, REVIEWER_PROVIDERS } from './reviewer-ids.mjs';
import { UNSUPPORTED_GROK_CONTAINMENT } from './grok-process-supervisor.mjs';

const DOCUMENT_TARGETS = new Set([
  'design-document',
  'implementation-plan',
  'requirements-specification',
  'architecture-decision-record',
  'test-plan',
]);
const DESIGN_REVIEW_TARGETS = new Set([
  'design-document',
  'architecture-decision-record',
]);
const RISK_ORDER = Object.freeze(['low', 'medium', 'high', 'critical']);
const STATUS_ORDER = Object.freeze(['success', 'unknown', 'failed']);

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function canonicalReviewerIndex(reviewerId) {
  const index = REVIEWER_IDS.indexOf(reviewerId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function validateRisk(risk) {
  if (!RISK_ORDER.includes(risk)) throw new Error(`unsupported risk: ${String(risk)}`);
  return risk;
}

function normalizedRoles(candidate) {
  const source = candidate.assignment_roles || candidate.roles || [candidate.role || 'standard'];
  return [...new Set(source)].sort(utf8Compare);
}

function normalizeCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  const seen = new Set();
  return candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError('candidate must be an object');
    }
    if (!REVIEWER_IDS.includes(candidate.id)) {
      throw new Error(`candidate reviewer id is not canonical: ${String(candidate.id)}`);
    }
    if (seen.has(candidate.id)) throw new Error(`duplicate candidate reviewer: ${candidate.id}`);
    seen.add(candidate.id);
    if (typeof candidate.provider !== 'string' || candidate.provider.length === 0) {
      throw new Error(`candidate provider is missing: ${candidate.id}`);
    }
    if (candidate.provider !== REVIEWER_PROVIDERS[candidate.id]) {
      throw new Error(`candidate provider is not canonical: ${candidate.id}`);
    }
    const roles = normalizedRoles(candidate);
    if (roles.length === 0) throw new Error(`candidate has no assignment roles: ${candidate.id}`);
    return {
      reviewer_id: candidate.id,
      provider: candidate.provider,
      adapter_id: candidate.adapter_id ?? null,
      assignment_roles: roles,
      default_role: candidate.role || (candidate.id === 'codex-adversarial' ? 'adversarial' : 'standard'),
      last_status: STATUS_ORDER.includes(candidate.last_status) ? candidate.last_status : 'unknown',
    };
  }).sort((left, right) => (
    canonicalReviewerIndex(left.reviewer_id) - canonicalReviewerIndex(right.reviewer_id)
    || utf8Compare(left.reviewer_id, right.reviewer_id)
  ));
}

export function classifyArtifactPhase(artifacts = []) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return 'implementation';
  return artifacts.every((artifact) => DOCUMENT_TARGETS.has(artifact?.target_kind))
    ? 'document'
    : 'implementation';
}

export function classifyDocumentReviewMode(artifacts = []) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return 'full-readiness';
  const mode = Array.from(artifacts).every((artifact) => DESIGN_REVIEW_TARGETS.has(artifact?.target_kind))
    ? 'design-validation'
    : 'full-readiness';
  if (!isDocumentReviewMode(mode)) throw new Error(`unsupported document review mode: ${String(mode)}`);
  return mode;
}

function documentPrimaryRole(artifacts) {
  const kinds = new Set(artifacts.map((artifact) => artifact?.target_kind));
  if (kinds.has('implementation-plan')) return 'feasibility';
  if (kinds.has('requirements-specification') || kinds.has('test-plan')) return 'traceability';
  return 'feasibility';
}

function routingFloor({ artifactPhase, risk, progressState, artifacts }) {
  if (progressState === 'confirmation' && ['low', 'medium'].includes(risk)) {
    return {
      roles: ['confirmation'],
      minimumReviewers: 1,
      plannedReviewers: 1,
      providerFamilyMinimum: 1,
      tierAdjustment: -1,
    };
  }
  if (artifactPhase === 'document') {
    const primary = documentPrimaryRole(artifacts);
    if (['high', 'critical'].includes(risk)) {
      return {
        roles: [primary, primary === 'traceability' ? 'adversarial' : 'traceability'],
        minimumReviewers: 2,
        plannedReviewers: 2,
        providerFamilyMinimum: 2,
        tierAdjustment: 0,
      };
    }
    return {
      roles: [primary],
      minimumReviewers: 1,
      plannedReviewers: 1,
      providerFamilyMinimum: 1,
      tierAdjustment: 0,
    };
  }
  if (['high', 'critical'].includes(risk)) {
    return {
      roles: ['standard', 'adversarial', 'security'],
      minimumReviewers: risk === 'critical' ? 3 : 2,
      plannedReviewers: 3,
      providerFamilyMinimum: 2,
      tierAdjustment: 0,
    };
  }
  return {
    roles: ['standard', 'adversarial'],
    minimumReviewers: 2,
    plannedReviewers: 2,
    providerFamilyMinimum: 2,
    tierAdjustment: 0,
  };
}

function supports(candidate, role) {
  return candidate.assignment_roles.includes(role);
}

function candidateComparator({ role, selectedProviders, usedReviewers, requiredProviders }) {
  return (left, right) => {
    const leftRequiredProvider = requiredProviders.has(left.provider) ? 0 : 1;
    const rightRequiredProvider = requiredProviders.has(right.provider) ? 0 : 1;
    const leftDiversity = selectedProviders.has(left.provider) ? 1 : 0;
    const rightDiversity = selectedProviders.has(right.provider) ? 1 : 0;
    const leftUsed = usedReviewers.has(left.reviewer_id) ? 1 : 0;
    const rightUsed = usedReviewers.has(right.reviewer_id) ? 1 : 0;
    const leftStatus = STATUS_ORDER.indexOf(left.last_status);
    const rightStatus = STATUS_ORDER.indexOf(right.last_status);
    return leftRequiredProvider - rightRequiredProvider
      || leftDiversity - rightDiversity
      || leftUsed - rightUsed
      || leftStatus - rightStatus
      || canonicalReviewerIndex(left.reviewer_id) - canonicalReviewerIndex(right.reviewer_id)
      || utf8Compare(left.reviewer_id, right.reviewer_id);
  };
}

function firstSupportedRole(candidate, preferredRoles) {
  return preferredRoles.find((role) => supports(candidate, role))
    || candidate.assignment_roles[0];
}

function makeAssignment(candidate, role, { required, tierAdjustment, reason }) {
  return {
    reviewer_id: candidate.reviewer_id,
    provider: candidate.provider,
    adapter_id: candidate.adapter_id,
    assignment_role: role,
    rubric_id: rubricIdForRole(role),
    wave: 1,
    required,
    tier_adjustment: tierAdjustment,
    selection_reason: reason,
  };
}

function staticAssignments(candidates, maximumReviewers, requiredReviewers, requiredProviders) {
  const ordered = [...candidates].sort((left, right) => {
    const leftRequired = requiredReviewers.has(left.reviewer_id) ? 0 : 1;
    const rightRequired = requiredReviewers.has(right.reviewer_id) ? 0 : 1;
    const leftProvider = requiredProviders.has(left.provider) ? 0 : 1;
    const rightProvider = requiredProviders.has(right.provider) ? 0 : 1;
    return leftRequired - rightRequired
      || leftProvider - rightProvider
      || canonicalReviewerIndex(left.reviewer_id) - canonicalReviewerIndex(right.reviewer_id);
  });
  return ordered.slice(0, maximumReviewers).map((candidate) => {
    const preferred = candidate.default_role;
    const role = supports(candidate, preferred) ? preferred : candidate.assignment_roles[0];
    return makeAssignment(candidate, role, {
      required: requiredReviewers.has(candidate.reviewer_id) || requiredProviders.has(candidate.provider),
      tierAdjustment: 0,
      reason: 'static strategy preserves the eligible reviewer set',
    });
  });
}

export function planReviewerAssignments(options = {}) {
  const artifacts = Array.isArray(options.artifacts) ? options.artifacts : [];
  const risk = validateRisk(options.risk || 'low');
  const artifactPhase = classifyArtifactPhase(artifacts);
  const documentReviewMode = classifyDocumentReviewMode(artifacts);
  const reviewerStrategy = options.reviewerStrategy || 'adaptive';
  if (!['adaptive', 'static'].includes(reviewerStrategy)) {
    throw new Error(`unsupported reviewer strategy: ${String(reviewerStrategy)}`);
  }
  const maximumReviewers = options.maximumReviewers ?? 4;
  if (!Number.isInteger(maximumReviewers) || maximumReviewers < 1 || maximumReviewers > REVIEWER_IDS.length) {
    throw new Error(`maximumReviewers must be an integer from 1 through ${REVIEWER_IDS.length}`);
  }
  const candidates = normalizeCandidates(options.candidates || []);
  const requiredReviewers = new Set(options.requiredReviewers || []);
  const requiredProviders = new Set(options.requiredProviders || []);
  // The provider-unavailability map carried in by `model-router.mjs`.
  const providerUnavailability = options.providerUnavailability && typeof options.providerUnavailability === 'object'
    ? options.providerUnavailability
    : {};
  const progressState = options.progress?.state || 'initial';
  const usedReviewers = new Set(options.progress?.used_reviewers || []);
  const baseFloor = routingFloor({
    artifactPhase,
    risk,
    progressState,
    artifacts,
  });
  const criticalRisk = risk === 'critical';
  const criticalImplementation = artifactPhase === 'implementation' && risk === 'critical';
  const providerFamilyMinimum = options.codexOnly === true
    && reviewerStrategy === 'static'
    && !criticalRisk
    ? 1
    : baseFloor.providerFamilyMinimum;
  const shouldExpand = ['regression', 'stalled'].includes(progressState);
  const tierAdjustment = shouldExpand ? 1 : baseFloor.tierAdjustment;

  const missingHardConstraints = [];
  for (const reviewerId of requiredReviewers) {
    if (!REVIEWER_IDS.includes(reviewerId) || !candidates.some((item) => item.reviewer_id === reviewerId)) {
      missingHardConstraints.push(`required_reviewer:${reviewerId}`);
    }
  }
  // D21 / I41 — the translation owner. An absent required provider whose
  // sealed unavailability reason is the containment gate becomes the canonical
  // `unsupported_grok_containment` shortfall rather than the generic one. The
  // generic `required_provider:<p>` form stays correct for every other absence
  // cause, so a provider that is simply not installed still reads that way.
  const sealedContainmentProviders = new Set();
  for (const provider of requiredProviders) {
    if (!candidates.some((item) => item.provider === provider)) {
      if (providerUnavailability[provider] === UNSUPPORTED_GROK_CONTAINMENT) {
        sealedContainmentProviders.add(provider);
        missingHardConstraints.push(UNSUPPORTED_GROK_CONTAINMENT);
      } else {
        missingHardConstraints.push(`required_provider:${provider}`);
      }
    }
  }
  const providersCoveredByRequiredReviewers = new Set(
    candidates
      .filter((candidate) => requiredReviewers.has(candidate.reviewer_id))
      .map((candidate) => candidate.provider),
  );
  const constraintTarget = requiredReviewers.size
    + [...requiredProviders].filter((provider) => !providersCoveredByRequiredReviewers.has(provider)).length;
  if (constraintTarget > maximumReviewers) {
    missingHardConstraints.push('required_assignments_exceed_maximum_reviewers');
  }
  const targetCount = Math.min(
    maximumReviewers,
    Math.max(
      baseFloor.plannedReviewers + (shouldExpand ? 1 : 0),
      constraintTarget,
    ),
  );
  const roles = [...baseFloor.roles];
  while (roles.length < targetCount) {
    roles.push(['security', 'traceability', 'adversarial', 'standard']
      .find((role) => !roles.includes(role)) || 'confirmation');
  }

  let assignments;
  if (reviewerStrategy === 'static') {
    assignments = staticAssignments(candidates, maximumReviewers, requiredReviewers, requiredProviders);
  } else {
    assignments = [];
    const selectedIds = new Set();
    const selectedProviders = new Set();
    const remainingRequiredProviders = new Set(requiredProviders);

    const assignCandidate = (candidate, role, required, reason) => {
      assignments.push(makeAssignment(candidate, role, {
        required,
        tierAdjustment,
        reason,
      }));
      selectedIds.add(candidate.reviewer_id);
      selectedProviders.add(candidate.provider);
      remainingRequiredProviders.delete(candidate.provider);
    };

    for (const reviewerId of [...requiredReviewers].sort((left, right) => (
      canonicalReviewerIndex(left) - canonicalReviewerIndex(right)
    ))) {
      const candidate = candidates.find((item) => item.reviewer_id === reviewerId);
      if (!candidate || selectedIds.has(candidate.reviewer_id) || assignments.length >= targetCount) continue;
      assignCandidate(
        candidate,
        firstSupportedRole(candidate, roles),
        true,
        'explicit reviewer override requires this canonical reviewer',
      );
    }

    for (const provider of [...requiredProviders].sort(utf8Compare)) {
      if (assignments.length >= targetCount || selectedProviders.has(provider)) continue;
      const candidate = candidates
        .filter((item) => item.provider === provider && !selectedIds.has(item.reviewer_id))
        .sort((left, right) => canonicalReviewerIndex(left.reviewer_id) - canonicalReviewerIndex(right.reviewer_id))[0];
      if (candidate) {
        assignCandidate(
          candidate,
          firstSupportedRole(candidate, roles),
          true,
          'explicit reviewer flag requires this provider family',
        );
      }
    }

    for (const role of roles) {
      if (assignments.length >= targetCount) break;
      if (assignments.some((assignment) => assignment.assignment_role === role)) continue;
      const eligible = candidates.filter((candidate) => (
        !selectedIds.has(candidate.reviewer_id) && supports(candidate, role)
      ));
      eligible.sort(candidateComparator({
        role,
        selectedProviders,
        usedReviewers,
        requiredProviders: remainingRequiredProviders,
      }));
      const candidate = eligible[0];
      if (!candidate) continue;
      assignCandidate(
        candidate,
        role,
        false,
        `role fit ${role}; provider diversity; prior-round freshness; last success; canonical id`,
      );
    }

    while (assignments.length < targetCount) {
      const eligible = candidates.filter((candidate) => !selectedIds.has(candidate.reviewer_id));
      if (eligible.length === 0) break;
      const role = firstSupportedRole(eligible[0], roles);
      eligible.sort(candidateComparator({
        role,
        selectedProviders,
        usedReviewers,
        requiredProviders: remainingRequiredProviders,
      }));
      const candidate = eligible[0];
      assignCandidate(
        candidate,
        firstSupportedRole(candidate, roles),
        false,
        'reviewer-count floor fallback using a supported assignment role',
      );
    }
  }

  const providerFamilies = new Set(assignments.map((assignment) => assignment.provider)).size;
  const shortfalls = [];
  if (assignments.length < baseFloor.minimumReviewers) shortfalls.push('minimum_reviewers');
  if (providerFamilies < providerFamilyMinimum) shortfalls.push('provider_families');
  if (assignments.length < targetCount) shortfalls.push('planned_reviewers');
  shortfalls.push(...missingHardConstraints);
  // The sealed containment reason may not be overwritten by, or shadowed
  // alongside, the generic form for the same provider: one absent required
  // provider yields exactly one reason, and when the cause is the containment
  // gate that reason is the containment-specific one.
  const uniqueShortfalls = [...new Set(shortfalls)]
    .filter((shortfall) => !sealedContainmentProviders.has(
      shortfall.startsWith('required_provider:') ? shortfall.slice('required_provider:'.length) : null,
    ));
  const operationalFailure = missingHardConstraints.length > 0
    || (criticalImplementation && (
      assignments.length < 3 || providerFamilies < 2
    ));
  const confidenceFloor = !operationalFailure && uniqueShortfalls.length > 0
    ? 'CONCERN'
    : null;
  const effectiveMinimum = Math.min(baseFloor.minimumReviewers, maximumReviewers);
  const effectiveProviderMinimum = Math.min(
    providerFamilyMinimum,
    effectiveMinimum,
  );

  return {
    artifact_phase: artifactPhase,
    document_review_mode: documentReviewMode,
    risk,
    progress: progressState,
    reviewer_strategy: reviewerStrategy,
    candidate_reviewers: candidates.map((candidate) => ({
      reviewer_id: candidate.reviewer_id,
      provider: candidate.provider,
      adapter_id: candidate.adapter_id,
      assignment_roles: candidate.assignment_roles,
      last_status: candidate.last_status,
    })),
    minimum_reviewers: effectiveMinimum,
    maximum_reviewers: maximumReviewers,
    provider_family_minimum: effectiveProviderMinimum,
    planned_reviewers: reviewerStrategy === 'static' ? assignments.length : targetCount,
    initial_reviewer_ids: assignments.map((assignment) => assignment.reviewer_id),
    required_reviewer_ids: assignments
      .filter((assignment) => assignment.required === true)
      .map((assignment) => assignment.reviewer_id),
    assignments,
    shortfalls: uniqueShortfalls,
    confidence_floor: confidenceFloor,
    operational_failure: operationalFailure,
  };
}

export function requiresReviewerPreflight(plan, reviewerId) {
  if (!plan || !Array.isArray(plan.assignments) || typeof reviewerId !== 'string') return false;
  return plan.assignments.some((assignment) => assignment.reviewer_id === reviewerId);
}

export function replanAfterSelectedReviewerUnavailable({
  plan,
  unavailableReviewerId,
  replansUsed = 0,
  planningOptions = {},
} = {}) {
  if (!requiresReviewerPreflight(plan, unavailableReviewerId)) {
    return { ...plan, replanned: false, replans_used: replansUsed };
  }
  if (!Number.isInteger(replansUsed) || replansUsed < 0) {
    throw new Error('replansUsed must be a non-negative integer');
  }
  const unavailableAssignment = plan.assignments.find(
    (assignment) => assignment.reviewer_id === unavailableReviewerId,
  );
  if (unavailableAssignment?.required === true) {
    return {
      ...plan,
      replanned: false,
      replans_used: replansUsed,
      operational_failure: true,
      replan_rejected: 'required_reviewer_unavailable',
    };
  }
  if (replansUsed >= 1) {
    return {
      ...plan,
      replanned: false,
      replans_used: replansUsed,
      operational_failure: true,
      replan_rejected: 'maximum_replans_reached',
    };
  }
  const candidates = (planningOptions.candidates || [])
    .filter((candidate) => candidate.id !== unavailableReviewerId);
  return {
    ...planReviewerAssignments({
      ...planningOptions,
      candidates,
    }),
    replanned: true,
    replans_used: 1,
    excluded_reviewer: unavailableReviewerId,
  };
}

export function riskAtLeast(left, right) {
  return RISK_ORDER.indexOf(validateRisk(left)) >= RISK_ORDER.indexOf(validateRisk(right));
}

export function maximumRisk(...values) {
  return values.filter(Boolean).reduce(
    (highest, value) => (riskAtLeast(value, highest) ? value : highest),
    'low',
  );
}
