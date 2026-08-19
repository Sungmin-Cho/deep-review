'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const planUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/execution-plan.mjs')).href;

const REQUIRED_FLAGS = Object.freeze([
  '--cwd',
  '--max-turns',
  '--model',
  '--no-memory',
  '--no-subagents',
  '--output-format',
  '--permission-mode',
  '--prompt-file',
  '--reasoning-effort',
  '--sandbox',
  '--session-id',
  '--single',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`,
  ).join(',')}}`;
}

function identity() {
  return {
    kind: 'posix-dev-ino-v1',
    fields: {
      dev: '1', ino: '2', type: 'regular-file', uid: '0',
    },
  };
}

function member(memberPath, purpose) {
  return {
    path: memberPath,
    real_path: memberPath,
    platform_identity: identity(),
    sha256: 'a'.repeat(64),
    size: 12,
    classification_purpose: purpose,
  };
}

function grokCompatibilityEvidence() {
  const chain = {
    schema_version: '1.0',
    prepared_kind: 'direct',
    launcher: member('/opt/grok', 'effective-executable'),
    shim: null,
    interpreter: null,
    shebang: null,
    posix_executable_type: 'native-elf',
    native_loader: member('/lib64/ld-linux-x86-64.so.2', 'native-loader'),
  };
  const evidence = {
    schema_version: '1.0',
    launcher_path: '/opt/grok',
    real_path: '/opt/grok',
    platform_identity: identity(),
    executable_sha256: 'a'.repeat(64),
    executable_size: 12,
    prepared_spawn_chain: {
      ...chain,
      chain_sha256: sha256(Buffer.from(canonicalStringify(chain), 'utf8')),
    },
    version: '1.0.4',
    version_build: 'd846eb93d94d',
    version_banner_sha256: 'b'.repeat(64),
    help_sha256: 'c'.repeat(64),
    help_size: 1024,
    required_help_flags: [...REQUIRED_FLAGS],
  };
  return {
    ...evidence,
    evidence_sha256: sha256(Buffer.from(canonicalStringify(evidence), 'utf8')),
  };
}

function protocol3Plan(maximumReviewers, { evidence = grokCompatibilityEvidence() } = {}) {
  const route = {
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
  };
  if (evidence !== null) route.grok_compatibility_evidence = evidence;
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
    routes: [route],
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

test('a protocol-3 Grok route is admitted only with sealed compatibility evidence', async () => {
  const { parseExecutionPlanDocument } = await import(planUrl);
  const evidence = grokCompatibilityEvidence();
  const parsed = parseExecutionPlanDocument(protocol3Plan(5, { evidence }), 'grok');
  assert.deepEqual(parsed.grokCompatibilityEvidence, evidence);

  assert.throws(
    () => parseExecutionPlanDocument(protocol3Plan(5, { evidence: null }), 'grok'),
    /compatibility evidence/u,
    'a Grok route with no carrier must not parse',
  );
  for (const [name, mutate] of [
    ['forged evidence seal', (carrier) => { carrier.evidence_sha256 = 'd'.repeat(64); }],
    ['forged chain seal', (carrier) => {
      carrier.prepared_spawn_chain.chain_sha256 = 'd'.repeat(64);
    }],
    ['unsupported CLI version', (carrier) => { carrier.version = '1.0.5'; }],
    ['incomplete required help flags', (carrier) => {
      carrier.required_help_flags = carrier.required_help_flags.slice(1);
    }],
    ['not an object', () => {}],
  ]) {
    const carrier = name === 'not an object' ? 'sealed' : structuredClone(evidence);
    mutate(carrier);
    assert.throws(
      () => parseExecutionPlanDocument(protocol3Plan(5, { evidence: carrier }), 'grok'),
      /compatibility evidence/u,
      name,
    );
  }

  assert.throws(
    () => parseExecutionPlanDocument({
      protocol_version: '2.0',
      routes: [{ reviewer_id: 'grok', model: 'grok', effort: 'medium' }],
    }, 'grok'),
    /compatibility evidence/u,
    'declaring protocol 2.0 must not bypass the carrier requirement',
  );
});

test('a non-Grok protocol-3 route may not smuggle Grok compatibility evidence', async () => {
  const { parseExecutionPlanDocument } = await import(planUrl);
  const document = protocol3Plan(5, { evidence: null });
  document.initial_reviewer_ids = ['claude-opus'];
  document.required_reviewer_ids = ['claude-opus'];
  document.candidate_reviewers[0].reviewer_id = 'claude-opus';
  document.candidate_reviewers[0].provider = 'claude';
  document.routes[0].reviewer_id = 'claude-opus';
  document.routes[0].provider = 'claude';
  assert.equal(
    parseExecutionPlanDocument(document, 'claude-opus').grokCompatibilityEvidence,
    null,
  );

  document.routes[0].grok_compatibility_evidence = grokCompatibilityEvidence();
  assert.throws(
    () => parseExecutionPlanDocument(document, 'claude-opus'),
    /compatibility evidence/u,
  );
});

test('an inline protocol-3 Grok execution route is admitted only with sealed evidence', async () => {
  const { parseExecutionRoute } = await import(planUrl);
  const evidence = grokCompatibilityEvidence();
  const route = { ...protocol3Plan(5, { evidence }).routes[0], protocol_version: '3.0' };
  assert.deepEqual(parseExecutionRoute(route, 'grok').grokCompatibilityEvidence, evidence);

  const bare = { ...route };
  delete bare.grok_compatibility_evidence;
  assert.throws(() => parseExecutionRoute(bare, 'grok'), /compatibility evidence/u);
});
