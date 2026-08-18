'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const planUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/execution-plan.mjs')).href;

function protocol3Plan(maximumReviewers) {
  return {
    protocol_version: '3.0',
    reviewer_strategy: 'adaptive',
    shadow_mode: false,
    artifact_phase: 'implementation',
    risk: 'low',
    progress: 'initial',
    minimum_reviewers: 1,
    maximum_reviewers: maximumReviewers,
    provider_family_minimum: 1,
    planned_reviewers: 1,
    max_expansion_waves: 1,
    initial_reviewer_ids: ['grok'],
    required_reviewer_ids: ['grok'],
    candidate_reviewers: [{
      reviewer_id: 'grok',
      provider: 'grok',
      adapter_id: 'grok-cli',
      assignment_roles: ['feasibility'],
      last_status: 'unknown',
    }],
    routes: [{
      reviewer_id: 'grok',
      provider: 'grok',
      adapter_id: 'grok-cli',
      assignment_role: 'feasibility',
      rubric_id: 'feasibility-v1',
      wave: 1,
      required: true,
      selection_reason: 'canonical reviewer bound',
      resolved: { model: 'grok', effort: 'medium' },
      artifact_phase: 'implementation',
      risk: 'low',
      document_review_mode: 'full-readiness',
    }],
  };
}

test('a protocol-3 plan with maximum_reviewers: 5 parses, and 6 is rejected', async () => {
  const { parseExecutionPlanDocument } = await import(planUrl);
  const parsed = parseExecutionPlanDocument(protocol3Plan(5), 'grok');
  assert.equal(parsed.assignmentRole, 'feasibility');
  assert.throws(
    () => parseExecutionPlanDocument(protocol3Plan(6), 'grok'),
    /maximum_reviewers must be an integer from 1 through 5/,
  );
});
