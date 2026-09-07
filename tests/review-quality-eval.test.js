'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const evaluatorPath = path.join(root, 'scripts', 'evaluate-review-quality.mjs');

async function evaluator() {
  return import('../scripts/evaluate-review-quality.mjs');
}

test('computes independently adjudicated precision, recall, false-block rate, and unknown usage', async () => {
  const { evaluateReviewQuality } = await evaluator();
  const result = evaluateReviewQuality({
    cases: [{ id: 'A', defects: [{ id: 'A1' }] }, { id: 'B', defects: [] }],
    predictions: [
      { case_id: 'A', status: 'completed', findings: [{ finding_id: 'p1', blocking: true }] },
      { case_id: 'B', status: 'completed', findings: [{ finding_id: 'p2', blocking: true }] },
    ],
    adjudicatedLabels: [
      { case_id: 'A', finding_id: 'p1', label: 'true_positive', defect_id: 'A1' },
      { case_id: 'B', finding_id: 'p2', label: 'false_positive' },
    ],
    usage: null,
  });

  assert.equal(result.true_positives, 1);
  assert.equal(result.false_positives, 1);
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 1);
  assert.equal(result.false_block_rate, 1);
  assert.equal(result.coverage, 1);
  assert.equal(result.usage, null);
});

test('keeps duplicate recall, missing coverage, severe misses, and unassessed findings distinct', async () => {
  const { evaluateReviewQuality } = await evaluator();
  const result = evaluateReviewQuality({
    cases: [
      { id: 'A', defects: [{ id: 'A1', severity: 'warning' }] },
      { id: 'B', defects: [] },
      { id: 'C', defects: [{ id: 'C1', severity: 'critical' }] },
      { id: 'D', defects: [] },
    ],
    predictions: [
      { case_id: 'A', status: 'completed', findings: [
        { finding_id: 'p1', blocking: true },
        { finding_id: 'p2', blocking: true },
      ] },
      { case_id: 'B', status: 'completed', findings: [
        { finding_id: 'p3', blocking: true },
        { finding_id: 'p4', blocking: false },
      ] },
    ],
    adjudicatedLabels: [
      { case_id: 'A', finding_id: 'p1', label: 'true_positive', defect_id: 'A1' },
      { case_id: 'A', finding_id: 'p2', label: 'true_positive', defect_id: 'A1' },
      { case_id: 'B', finding_id: 'p3', label: 'false_positive' },
    ],
    usage: { input_tokens: 12, output_tokens: null, cached_input_tokens: 0, cost_usd: null, provenance: 'fixture counter' },
  });

  assert.deepEqual(result.counts, {
    cases: 4,
    completed_cases: 2,
    missing_cases: 2,
    known_defects: 2,
    detected_defects: 1,
    missed_defects: 1,
    critical_misses: 1,
    predictions: 4,
    assessed_predictions: 3,
    unassessed_predictions: 1,
    true_positives: 2,
    false_positives: 1,
    completed_clean_cases: 1,
    false_blocked_clean_cases: 1,
  });
  assert.deepEqual(result.missing_case_ids, ['C', 'D']);
  assert.deepEqual(result.missed_defects, [{ case_id: 'C', defect_id: 'C1', severity: 'critical' }]);
  assert.equal(result.precision, 2 / 3);
  assert.equal(result.recall, 0.5);
  assert.equal(result.false_block_rate, 1);
  assert.equal(result.coverage, 0.5);
  assert.deepEqual(result.denominators, {
    precision_assessed_predictions: 3,
    recall_known_defects: 2,
    false_block_rate_completed_clean_cases: 1,
    coverage_cases: 4,
  });
  assert.deepEqual(result.usage, {
    input_tokens: 12,
    output_tokens: null,
    cached_input_tokens: 0,
    cost_usd: null,
    provenance: 'fixture counter',
  });
  assert.match(result.limitations.join(' '), /severity calibration/i);
});

test('uses null for undefined denominators instead of manufacturing zero evidence', async () => {
  const { evaluateReviewQuality } = await evaluator();
  const result = evaluateReviewQuality({
    cases: [{ id: 'A', defects: [{ id: 'A1', severity: 'warning' }] }],
    predictions: [{ case_id: 'A', status: 'completed', findings: [] }],
    adjudicatedLabels: [],
    usage: null,
  });
  assert.equal(result.precision, null);
  assert.equal(result.recall, 0);
  assert.equal(result.false_block_rate, null);
  assert.equal(result.coverage, 1);
});

test('rejects duplicate or impossible evidence instead of coercing it', async () => {
  const { evaluateReviewQuality } = await evaluator();
  const base = {
    cases: [{ id: 'A', defects: [{ id: 'A1', severity: 'warning' }] }],
    predictions: [{ case_id: 'A', status: 'completed', findings: [{ finding_id: 'p1', blocking: true }] }],
    adjudicatedLabels: [{ case_id: 'A', finding_id: 'p1', label: 'true_positive', defect_id: 'A1' }],
    usage: null,
  };
  assert.throws(() => evaluateReviewQuality({ ...base, adjudicatedLabels: [...base.adjudicatedLabels, ...base.adjudicatedLabels] }), /duplicate.*label/i);
  assert.throws(() => evaluateReviewQuality({ ...base, adjudicatedLabels: [...base.adjudicatedLabels, { case_id: 'A', finding_id: 'p1', label: 'false_positive' }] }), /duplicate|conflict/i);
  assert.throws(() => evaluateReviewQuality({ ...base, predictions: [{ case_id: 'A', status: 'indeterminate', findings: [] }] }), /incomplete.*execution/i);
  assert.throws(() => evaluateReviewQuality({ ...base, usage: { input_tokens: -1, provenance: 'fixture' } }), /usage/i);
  assert.throws(() => evaluateReviewQuality({ ...base, adjudicatedLabels: [{ case_id: 'A', finding_id: 'missing', label: 'false_positive' }] }), /unknown.*prediction/i);
});

test('CLI accepts an execution envelope, reports missing coverage, and rejects incomplete records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-quality-'));
  try {
    const write = (name, value) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };
    const cases = write('cases.json', [{ id: 'A', defects: [] }, { id: 'B', defects: [] }]);
    const predictions = write('predictions.json', {
      schema_version: 1,
      predictions: [{ case_id: 'A', status: 'completed', findings: [] }],
      usage: null,
    });
    const valid = spawnSync(process.execPath, [evaluatorPath, '--cases', cases, '--predictions', predictions], { encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).coverage, 0.5);

    const incomplete = write('incomplete.json', [{ case_id: 'A', status: 'indeterminate', findings: [] }]);
    const invalid = spawnSync(process.execPath, [evaluatorPath, '--cases', cases, '--predictions', incomplete], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /incomplete.*execution/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped corpus keeps six opaque candidate cases separate from gold and includes transition fixtures', () => {
  const fixture = (name) => JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'review-quality', name)));
  const candidates = fixture('cases.json');
  const gold = fixture('gold-cases.json');
  const transitions = fixture('transitions.json');
  assert.equal(candidates.schema_version, 1);
  assert.equal(candidates.cases.length, 6);
  assert.ok(candidates.cases.every((entry) => /^C\d+$/u.test(entry.id) && !Object.hasOwn(entry, 'defects')));
  assert.deepEqual(gold.cases.map((entry) => entry.id), candidates.cases.map((entry) => entry.id));
  assert.equal(gold.cases.flatMap((entry) => entry.defects).length, 3);
  assert.ok(transitions.cases.some((entry) => entry.id === 'implementation-unresolved-only'));
  assert.ok(transitions.cases.some((entry) => entry.id === 'final-slot-review-only'));
  assert.ok(transitions.cases.some((entry) => entry.id === 'unknown-completion'));
});
