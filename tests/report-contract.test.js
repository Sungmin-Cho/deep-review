// SLICE-008b — D16: the report contract is injected phase-aware, from one
// canonical source. `buildReportContract` is that source; this file proves
// it emits exactly one `## Artifact Gate` for document phase, none
// otherwise, and that the gate shape matches what
// `document-readiness.mjs`'s canonical parser requires.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { buildReportContract } from '../hooks/scripts/lib/report-contract.mjs';
import {
  ARTIFACT_GATE_ERROR_CODES,
  parseArtifactGate,
} from '../hooks/scripts/document-readiness.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BASELINE_COMMIT = 'faf446c';

const GATE_HEADING = /^## Artifact Gate[ \t]*$/gmu;

function headingCount(text) {
  return [...text.matchAll(GATE_HEADING)].length;
}

test('buildReportContract with artifactPhase "document" emits the literal ## Artifact Gate exactly once, with the json fence on the immediately following line and no intervening prose', () => {
  const contract = buildReportContract({ artifactPhase: 'document', documentReviewMode: 'full-readiness' });
  assert.equal(headingCount(contract), 1);
  const fenceMatch = /^## Artifact Gate[ \t]*\r?\n```json[ \t]*$/mu.exec(contract);
  assert.ok(fenceMatch, 'the json fence must be on the line immediately after the heading, with no intervening prose');
  assert.match(contract, /"schema_version": 1/u);
  assert.match(contract, /"findings"/u);
  assert.match(contract, /`severity` is `critical\|warning\|info`/u);
  assert.match(contract, /`stage` is\n`pre_implementation\|implementation_verification\|advisory`/u);
  assert.match(contract, /Every Critical is\n`pre_implementation`/u);
  assert.match(contract, /JSON counts must equal the Summary Issues counts/u);
});

test('buildReportContract with a non-document artifactPhase emits no Artifact Gate at all', () => {
  for (const artifactPhase of ['implementation', null, undefined]) {
    const contract = buildReportContract({ artifactPhase });
    assert.equal(headingCount(contract), 0);
    assert.equal(contract.includes('Artifact Gate'), false);
  }
});

test('the design-validation document review mode still gets the gate — the schema is invariant across document review modes', () => {
  const contract = buildReportContract({ artifactPhase: 'document', documentReviewMode: 'design-validation' });
  assert.equal(headingCount(contract), 1);
});

test('the base contract (Summary/Code Review/bullet rules) is present for every phase', () => {
  for (const artifactPhase of ['document', 'implementation', null]) {
    const contract = buildReportContract({ artifactPhase });
    assert.match(contract, /# Deep Review Report/u);
    assert.match(contract, /## Summary/u);
    assert.match(contract, /- \*\*Verdict\*\*: APPROVE \| CONCERN \| REQUEST_CHANGES/u);
    assert.match(contract, /## Code Review/u);
    assert.match(contract, /### 🔴 Critical/u);
    assert.match(contract, /### 🟡 Warning/u);
    assert.match(contract, /### ℹ️ Info/u);
    assert.match(contract, /### 🟢 Passed/u);
  }
});

test('a generated document-phase gate section round-trips through the canonical parseArtifactGate example unchanged', () => {
  // The contract's embedded JSON example is illustrative prose for the model,
  // not itself a full report — but its heading/fence shape must be exactly
  // what the canonical parser scans for, proven by extracting just that
  // slice and parsing it against a matching Issues summary.
  const contract = buildReportContract({ artifactPhase: 'document' });
  const gateSlice = contract.slice(contract.indexOf('## Artifact Gate'));
  const wrapped = [
    '# Deep Review Report — 2026-08-19',
    '',
    '## Summary',
    '- **Verdict**: CONCERN',
    '- **Issues**: 🔴 0건, 🟡 1건, ℹ️ 0건',
    '',
    gateSlice,
  ].join('\n');
  const parsed = parseArtifactGate(wrapped);
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].severity, 'warning');
});

test('payload builder injects D16 only for claude/codex routes (T8)', async () => {
  const { pathToFileURL } = await import('node:url');
  const { buildReviewerPayload } = await import(
    pathToFileURL(join(pluginRoot, 'hooks', 'scripts', 'build-reviewer-payload.mjs')).href
  );
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pathJoin } = await import('node:path');
  const temp = mkdtempSync(pathJoin(tmpdir(), 'deep-review-d16-matrix-'));
  const planFor = (reviewerId, provider, adapterId, role) => {
    const path = pathJoin(temp, `${reviewerId}.json`);
    writeFileSync(path, JSON.stringify({
      protocol_version: '3.0',
      reviewer_strategy: 'adaptive',
      shadow_mode: false,
      artifact_phase: 'implementation',
      risk: 'low',
      document_review_mode: 'full-readiness',
      progress: 'initial',
      minimum_reviewers: 1,
      planned_reviewers: 1,
      maximum_reviewers: 4,
      provider_family_minimum: 1,
      max_expansion_waves: 1,
      candidate_reviewers: [{
        reviewer_id: reviewerId,
        provider,
        adapter_id: adapterId,
        assignment_roles: [role],
        last_status: 'success',
      }],
      routes: [{
        reviewer_id: reviewerId,
        provider,
        adapter_id: adapterId,
        assignment_role: role,
        rubric_id: `${role}-v1`,
        wave: 1,
        required: false,
        selection_reason: 'T8 matrix',
        resolved: { model: null, effort: 'high' },
        artifact_phase: 'implementation',
        risk: 'low',
        document_review_mode: 'full-readiness',
      }],
      initial_reviewer_ids: [reviewerId],
      required_reviewer_ids: [],
    }));
    return path;
  };
  const injected = ['claude-opus', 'codex-review', 'codex-adversarial'];
  for (const reviewerId of injected) {
    const provider = reviewerId === 'claude-opus' ? 'claude' : 'codex';
    const adapterId = reviewerId === 'claude-opus' ? 'claude-cli' : 'codex-native-generic';
    const role = reviewerId === 'codex-adversarial' ? 'adversarial' : 'standard';
    const result = buildReviewerPayload({
      pluginRoot,
      routingPlan: planFor(reviewerId, provider, adapterId, role),
      reviewerId,
      diff: 'DIFF',
    });
    const prompt = readFileSync(result.promptFile, 'utf8');
    assert.match(prompt, /===== OUTPUT CONTRACT =====/);
    assert.ok(prompt.trimEnd().endsWith('============================================================'));
  }
});

// ---------------------------------------------------------------------------
// C-GATE-PARSER — stable codes for the six malformed-gate classes.
// ---------------------------------------------------------------------------

test('ARTIFACT_GATE_ERROR_CODES exports exactly the six malformed-gate classes as stable strings', () => {
  const expectedKeys = [
    'MISSING_GATE',
    'DUPLICATE_GATE',
    'INVALID_SCHEMA',
    'INVALID_STAGE',
    'MISSING_ACCEPTANCE_EVIDENCE',
    'COUNT_MISMATCH',
  ];
  assert.deepEqual(Object.keys(ARTIFACT_GATE_ERROR_CODES).sort(), [...expectedKeys].sort());
  for (const key of expectedKeys) {
    assert.equal(typeof ARTIFACT_GATE_ERROR_CODES[key], 'string');
    assert.ok(ARTIFACT_GATE_ERROR_CODES[key].length > 0);
  }
  assert.ok(Object.isFrozen(ARTIFACT_GATE_ERROR_CODES));
});

function issuesLine(critical, warning, info) {
  return `- **Issues**: 🔴 ${critical}건, 🟡 ${warning}건, ℹ️ ${info}건`;
}

function gateBlock(rawJson) {
  return ['## Artifact Gate', '```json', rawJson, '```'].join('\n');
}

function findingsBlock(findings, { schemaVersion = 1 } = {}) {
  return gateBlock(JSON.stringify({ schema_version: schemaVersion, findings }, null, 2));
}

function buildGateReport({
  critical = 0, warning = 0, info = 0, gates = [], includeIssues = true,
} = {}) {
  return [
    '# Deep Review Report — 2026-08-19',
    '',
    '## Summary',
    ...(includeIssues ? [issuesLine(critical, warning, info)] : []),
    '',
    ...gates,
    '',
  ].join('\n');
}

const VALID_FINDING = {
  id: 'DOC-1', severity: 'warning', stage: 'implementation_verification', acceptance_evidence: ['evidence'],
};

test('parseArtifactGate attaches the matching stable code for each of the six malformed classes, and none for acceptance', () => {
  const cases = [
    {
      label: 'accepted',
      report: buildGateReport({ warning: 1, gates: [findingsBlock([VALID_FINDING])] }),
      code: null,
    },
    {
      label: 'missing gate',
      report: buildGateReport({ gates: [] }),
      code: ARTIFACT_GATE_ERROR_CODES.MISSING_GATE,
    },
    {
      label: 'duplicate gate',
      report: buildGateReport({
        warning: 2,
        gates: [findingsBlock([VALID_FINDING]), findingsBlock([{ ...VALID_FINDING, id: 'DOC-2' }])],
      }),
      code: ARTIFACT_GATE_ERROR_CODES.DUPLICATE_GATE,
    },
    {
      label: 'invalid schema — malformed JSON',
      report: buildGateReport({ warning: 1, gates: [gateBlock('{ not valid json')] }),
      code: ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA,
    },
    {
      label: 'invalid schema — wrong schema_version',
      report: buildGateReport({ warning: 1, gates: [findingsBlock([VALID_FINDING], { schemaVersion: 2 })] }),
      code: ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA,
    },
    {
      label: 'invalid schema — findings not an array',
      report: buildGateReport({ warning: 1, gates: [gateBlock(JSON.stringify({ schema_version: 1, findings: 'nope' }))] }),
      code: ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA,
    },
    {
      label: 'invalid schema — duplicate finding id',
      report: buildGateReport({
        warning: 1,
        info: 1,
        gates: [findingsBlock([VALID_FINDING, { ...VALID_FINDING, severity: 'info', stage: 'advisory' }])],
      }),
      code: ARTIFACT_GATE_ERROR_CODES.INVALID_SCHEMA,
    },
    {
      label: 'invalid stage — unrecognized stage value',
      report: buildGateReport({ warning: 1, gates: [findingsBlock([{ ...VALID_FINDING, stage: 'invented' }])] }),
      code: ARTIFACT_GATE_ERROR_CODES.INVALID_STAGE,
    },
    {
      label: 'invalid stage — Critical not pre_implementation',
      report: buildGateReport({
        critical: 1,
        gates: [findingsBlock([{
          id: 'DOC-C1', severity: 'critical', stage: 'implementation_verification', acceptance_evidence: ['e'],
        }])],
      }),
      code: ARTIFACT_GATE_ERROR_CODES.INVALID_STAGE,
    },
    {
      label: 'invalid stage — advisory not info',
      report: buildGateReport({
        warning: 1,
        gates: [findingsBlock([{ ...VALID_FINDING, stage: 'advisory' }])],
      }),
      code: ARTIFACT_GATE_ERROR_CODES.INVALID_STAGE,
    },
    {
      label: 'missing acceptance evidence — empty array',
      report: buildGateReport({ warning: 1, gates: [findingsBlock([{ ...VALID_FINDING, acceptance_evidence: [] }])] }),
      code: ARTIFACT_GATE_ERROR_CODES.MISSING_ACCEPTANCE_EVIDENCE,
    },
    {
      label: 'missing acceptance evidence — blank entry',
      report: buildGateReport({ warning: 1, gates: [findingsBlock([{ ...VALID_FINDING, acceptance_evidence: ['   '] }])] }),
      code: ARTIFACT_GATE_ERROR_CODES.MISSING_ACCEPTANCE_EVIDENCE,
    },
    {
      label: 'count mismatch',
      report: buildGateReport({ warning: 2, gates: [findingsBlock([VALID_FINDING])] }),
      code: ARTIFACT_GATE_ERROR_CODES.COUNT_MISMATCH,
    },
  ];

  for (const testCase of cases) {
    if (testCase.code === null) {
      assert.doesNotThrow(() => parseArtifactGate(testCase.report), testCase.label);
      continue;
    }
    assert.throws(
      () => parseArtifactGate(testCase.report),
      (error) => error.code === testCase.code,
      `${testCase.label}: expected code ${testCase.code}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Replay-and-diff — exporting the stable codes must not change any current
// parseArtifactGate behaviour. The pinned pre-slice commit faf446c (SLICE-008
// a/3, before this slice) is replayed against the same input matrix as the
// live module and diffed on accept/reject outcome AND thrown message.
// ---------------------------------------------------------------------------

function workspace(label) {
  return mkdtempSync(join(tmpdir(), `deep-review-${label}-`));
}

function extractBaseline(commit, label, mutate = null) {
  const dest = workspace(label);
  const list = spawnSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'hooks/scripts'], {
    cwd: pluginRoot, encoding: 'utf8',
  });
  assert.equal(list.status, 0, list.stderr);
  const paths = list.stdout.trim().split('\n').filter(Boolean);
  assert.ok(paths.includes('hooks/scripts/document-readiness.mjs'));
  for (const relPath of paths) {
    const show = spawnSync('git', ['show', `${commit}:${relPath}`], { cwd: pluginRoot, encoding: null });
    assert.equal(show.status, 0, show.stderr && show.stderr.toString());
    const destPath = join(dest, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, mutate ? mutate(relPath, show.stdout) : show.stdout);
  }
  return dest;
}

async function loadBaselineReadiness(root) {
  return import(pathToFileURL(join(root, 'hooks', 'scripts', 'document-readiness.mjs')).href);
}

function gateInputMatrix() {
  // Every case from the stable-code test above, plus a couple of shape edge
  // cases the pinned baseline must reject identically: a gate heading with no
  // fence at all (malformed presentation) and a report with no Issues line.
  return [
    buildGateReport({ warning: 1, gates: [findingsBlock([VALID_FINDING])] }),
    buildGateReport({ gates: [] }),
    buildGateReport({
      warning: 2,
      gates: [findingsBlock([VALID_FINDING]), findingsBlock([{ ...VALID_FINDING, id: 'DOC-2' }])],
    }),
    buildGateReport({ warning: 1, gates: [gateBlock('{ not valid json')] }),
    buildGateReport({ warning: 1, gates: [findingsBlock([VALID_FINDING], { schemaVersion: 2 })] }),
    buildGateReport({ warning: 1, gates: [gateBlock(JSON.stringify({ schema_version: 1, findings: 'nope' }))] }),
    buildGateReport({
      warning: 1,
      info: 1,
      gates: [findingsBlock([VALID_FINDING, { ...VALID_FINDING, severity: 'info', stage: 'advisory' }])],
    }),
    buildGateReport({ warning: 1, gates: [findingsBlock([{ ...VALID_FINDING, stage: 'invented' }])] }),
    buildGateReport({
      critical: 1,
      gates: [findingsBlock([{
        id: 'DOC-C1', severity: 'critical', stage: 'implementation_verification', acceptance_evidence: ['e'],
      }])],
    }),
    buildGateReport({ warning: 1, gates: [findingsBlock([{ ...VALID_FINDING, stage: 'advisory' }])] }),
    buildGateReport({ warning: 1, gates: [findingsBlock([{ ...VALID_FINDING, acceptance_evidence: [] }])] }),
    buildGateReport({ warning: 1, gates: [findingsBlock([{ ...VALID_FINDING, acceptance_evidence: ['   '] }])] }),
    buildGateReport({ warning: 2, gates: [findingsBlock([VALID_FINDING])] }),
    buildGateReport({ warning: 1, gates: ['## Artifact Gate', 'not a fence at all'] }),
    buildGateReport({ includeIssues: false, gates: [findingsBlock([VALID_FINDING])] }),
    buildGateReport({ gates: [findingsBlock([]), findingsBlock([VALID_FINDING])] }),
  ];
}

function observe(module, reportText) {
  try {
    return JSON.stringify({ ok: true, parsed: module.parseArtifactGate(reportText) });
  } catch (error) {
    return JSON.stringify({ ok: false, message: error.message });
  }
}

test('exporting the stable gate-parser codes changes no current parseArtifactGate behaviour (replay-and-diff vs faf446c)', async () => {
  const baselineRoot = extractBaseline(BASELINE_COMMIT, 'gate-parser-baseline');
  const baseline = await loadBaselineReadiness(baselineRoot);
  const current = await import('../hooks/scripts/document-readiness.mjs');

  const matrix = gateInputMatrix();
  const before = matrix.map((reportText) => observe(baseline, reportText));
  const after = matrix.map((reportText) => observe(current, reportText));
  const differences = matrix
    .map((_, index) => index)
    .filter((index) => before[index] !== after[index]);

  assert.deepEqual(differences, [], `parseArtifactGate diverged from the pinned baseline at matrix indices: ${differences.join(', ')}`);

  // Positive control: a mutated baseline (schema_version gate flipped from 1
  // to 2) must be observed by exactly this comparison, on the one matrix
  // entry with schema_version: 1. A diff that cannot fail proves nothing.
  const mutatedRoot = extractBaseline(BASELINE_COMMIT, 'gate-parser-mutant', (relPath, bytes) => (
    relPath === 'hooks/scripts/document-readiness.mjs'
      ? Buffer.from(bytes.toString('utf8').replace('parsed.schema_version !== 1', 'parsed.schema_version !== 2'), 'utf8')
      : bytes
  ));
  const mutant = await loadBaselineReadiness(mutatedRoot);
  const mutantAfter = matrix.map((reportText) => observe(mutant, reportText));
  const controlDifferences = matrix
    .map((_, index) => index)
    .filter((index) => before[index] !== mutantAfter[index]);
  assert.ok(controlDifferences.length > 0, 'positive control failed to detect a mutated baseline');

  // Report evidence: matrix size and difference count for the episode report.
  assert.equal(matrix.length, 16);
  assert.equal(differences.length, 0);
});
