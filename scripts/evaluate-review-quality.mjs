#!/usr/bin/env node

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MAX_INPUT_BYTES = 1024 * 1024;
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cost_usd'];

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function normalizeCases(cases) {
  if (!Array.isArray(cases)) throw new Error('cases must be an array');
  const ids = new Set();
  const defectKeys = new Set();
  return cases.map((entry) => {
    if (!plainObject(entry)) throw new Error('invalid case record');
    const id = identifier(entry.id, 'case id');
    if (ids.has(id)) throw new Error(`duplicate case id: ${id}`);
    ids.add(id);
    if (!Array.isArray(entry.defects)) throw new Error(`case ${id} must declare defects`);
    const defects = entry.defects.map((defect) => {
      if (!plainObject(defect)) throw new Error(`invalid defect in case ${id}`);
      const defectId = identifier(defect.id, 'defect id');
      const key = `${id}\0${defectId}`;
      if (defectKeys.has(key)) throw new Error(`duplicate defect id in case ${id}: ${defectId}`);
      defectKeys.add(key);
      if (!['critical', 'warning'].includes(defect.severity)) {
        throw new Error(`invalid defect severity in case ${id}: ${defectId}`);
      }
      return { case_id: id, defect_id: defectId, severity: defect.severity };
    });
    return { id, defects };
  });
}

function normalizePredictions(predictions, casesById) {
  if (!Array.isArray(predictions)) throw new Error('predictions must be an array');
  const caseIds = new Set();
  const findingKeys = new Set();
  const findingByKey = new Map();
  const records = predictions.map((entry) => {
    if (!plainObject(entry)) throw new Error('invalid execution record');
    const caseId = identifier(entry.case_id, 'prediction case id');
    if (!casesById.has(caseId)) throw new Error(`prediction references unknown case: ${caseId}`);
    if (caseIds.has(caseId)) throw new Error(`duplicate prediction case record: ${caseId}`);
    caseIds.add(caseId);
    if (entry.status !== 'completed') throw new Error(`incomplete execution record for case ${caseId}`);
    if (!Array.isArray(entry.findings)) throw new Error(`findings must be an array for case ${caseId}`);
    const findings = entry.findings.map((finding) => {
      if (!plainObject(finding)) throw new Error(`invalid finding for case ${caseId}`);
      const findingId = identifier(finding.finding_id, 'finding id');
      if (typeof finding.blocking !== 'boolean') throw new Error(`finding ${findingId} must declare blocking`);
      const key = `${caseId}\0${findingId}`;
      if (findingKeys.has(key)) throw new Error(`duplicate finding id in case ${caseId}: ${findingId}`);
      findingKeys.add(key);
      const normalized = { case_id: caseId, finding_id: findingId, blocking: finding.blocking };
      findingByKey.set(key, normalized);
      return normalized;
    });
    return { case_id: caseId, findings };
  });
  return { records, caseIds, findingByKey };
}

function normalizeLabels(labels, findingByKey, casesById) {
  if (!Array.isArray(labels)) throw new Error('adjudicated labels must be an array');
  const labelKeys = new Set();
  return labels.map((entry) => {
    if (!plainObject(entry)) throw new Error('invalid adjudicated label');
    const caseId = identifier(entry.case_id, 'label case id');
    const findingId = identifier(entry.finding_id, 'label finding id');
    const key = `${caseId}\0${findingId}`;
    if (labelKeys.has(key)) throw new Error(`duplicate or conflicting adjudicated label: ${caseId}/${findingId}`);
    labelKeys.add(key);
    if (!findingByKey.has(key)) throw new Error(`adjudicated label references unknown prediction: ${caseId}/${findingId}`);
    if (!['true_positive', 'false_positive'].includes(entry.label)) throw new Error(`invalid adjudicated label: ${entry.label}`);
    if (entry.label === 'true_positive') {
      const defectId = identifier(entry.defect_id, 'true-positive defect id');
      if (!casesById.get(caseId).defects.some((defect) => defect.defect_id === defectId)) {
        throw new Error(`true-positive label references unknown defect: ${caseId}/${defectId}`);
      }
      return { case_id: caseId, finding_id: findingId, label: entry.label, defect_id: defectId };
    }
    if (entry.defect_id !== undefined) throw new Error('false-positive label cannot declare a defect id');
    return { case_id: caseId, finding_id: findingId, label: entry.label };
  });
}

function normalizeUsage(usage) {
  if (usage === null || usage === undefined) return null;
  if (!plainObject(usage)) throw new Error('invalid usage evidence');
  const allowed = new Set([...USAGE_FIELDS, 'provenance']);
  if (Object.keys(usage).some((key) => !allowed.has(key))) throw new Error('invalid usage field');
  if (typeof usage.provenance !== 'string' || usage.provenance.trim().length === 0) {
    throw new Error('usage provenance is required');
  }
  const normalized = { provenance: usage.provenance };
  for (const field of USAGE_FIELDS) {
    const value = usage[field] ?? null;
    const integer = field !== 'cost_usd';
    if (value !== null && (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value)))) {
      throw new Error(`invalid usage value: ${field}`);
    }
    normalized[field] = value;
  }
  return {
    input_tokens: normalized.input_tokens,
    output_tokens: normalized.output_tokens,
    cached_input_tokens: normalized.cached_input_tokens,
    cost_usd: normalized.cost_usd,
    provenance: normalized.provenance,
  };
}

export function evaluateReviewQuality({ cases, predictions, adjudicatedLabels = [], usage = null }) {
  const normalizedCases = normalizeCases(cases);
  const casesById = new Map(normalizedCases.map((entry) => [entry.id, entry]));
  const normalizedPredictions = normalizePredictions(predictions, casesById);
  const labels = normalizeLabels(adjudicatedLabels, normalizedPredictions.findingByKey, casesById);
  const normalizedUsage = normalizeUsage(usage);
  const labelsByFinding = new Map(labels.map((entry) => [`${entry.case_id}\0${entry.finding_id}`, entry]));
  const detectedDefects = new Set(labels.filter((entry) => entry.label === 'true_positive')
    .map((entry) => `${entry.case_id}\0${entry.defect_id}`));
  const allDefects = normalizedCases.flatMap((entry) => entry.defects);
  const missedDefects = allDefects.filter((defect) => !detectedDefects.has(`${defect.case_id}\0${defect.defect_id}`));
  const allFindings = normalizedPredictions.records.flatMap((entry) => entry.findings);
  const unassessed = allFindings.filter((finding) => !labelsByFinding.has(`${finding.case_id}\0${finding.finding_id}`));
  const truePositives = labels.filter((entry) => entry.label === 'true_positive').length;
  const falsePositives = labels.filter((entry) => entry.label === 'false_positive').length;
  const completedCleanCases = normalizedCases.filter((entry) => entry.defects.length === 0
    && normalizedPredictions.caseIds.has(entry.id));
  const falseBlockedCleanCases = completedCleanCases.filter((entry) => {
    const record = normalizedPredictions.records.find((prediction) => prediction.case_id === entry.id);
    return record.findings.some((finding) => finding.blocking
      && labelsByFinding.get(`${entry.id}\0${finding.finding_id}`)?.label === 'false_positive');
  });
  const missingCaseIds = normalizedCases.filter((entry) => !normalizedPredictions.caseIds.has(entry.id)).map((entry) => entry.id);
  const counts = {
    cases: normalizedCases.length,
    completed_cases: normalizedPredictions.records.length,
    missing_cases: missingCaseIds.length,
    known_defects: allDefects.length,
    detected_defects: detectedDefects.size,
    missed_defects: missedDefects.length,
    critical_misses: missedDefects.filter((defect) => defect.severity === 'critical').length,
    predictions: allFindings.length,
    assessed_predictions: labels.length,
    unassessed_predictions: unassessed.length,
    true_positives: truePositives,
    false_positives: falsePositives,
    completed_clean_cases: completedCleanCases.length,
    false_blocked_clean_cases: falseBlockedCleanCases.length,
  };
  const denominators = {
    precision_assessed_predictions: labels.length,
    recall_known_defects: allDefects.length,
    false_block_rate_completed_clean_cases: completedCleanCases.length,
    coverage_cases: normalizedCases.length,
  };
  return {
    schema_version: 1,
    counts,
    true_positives: truePositives,
    false_positives: falsePositives,
    unassessed_predictions: unassessed.length,
    precision: ratio(truePositives, denominators.precision_assessed_predictions),
    recall: ratio(detectedDefects.size, denominators.recall_known_defects),
    false_block_rate: ratio(falseBlockedCleanCases.length, denominators.false_block_rate_completed_clean_cases),
    coverage: ratio(normalizedPredictions.records.length, denominators.coverage_cases),
    denominators,
    missing_case_ids: missingCaseIds,
    unassessed_prediction_ids: unassessed.map(({ case_id, finding_id }) => ({ case_id, finding_id })),
    missed_defects: missedDefects,
    usage: normalizedUsage,
    limitations: [
      'Precision covers independently adjudicated predictions only; unassessed predictions are reported separately.',
      'Recall deduplicates matches by case and gold defect; missing executions remain missing coverage.',
      'False-block rate is the share of completed clean cases with at least one blocking false positive.',
      'Detection metrics do not establish severity calibration or performance beyond this corpus.',
      'Usage reports observed provider evidence only; null values are unknown and are not estimated.',
    ],
  };
}

function readJson(file, label) {
  const size = statSync(file).size;
  if (size > MAX_INPUT_BYTES) throw new Error(`${label} exceeds ${MAX_INPUT_BYTES} bytes`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid ${label} JSON: ${error.message}`);
  }
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--cases', '--predictions', '--adjudicated-labels'].includes(flag) || value === undefined || values[flag]) {
      throw new Error('usage: evaluate-review-quality.mjs --cases FILE --predictions FILE [--adjudicated-labels FILE]');
    }
    values[flag] = value;
  }
  if (!values['--cases'] || !values['--predictions']) {
    throw new Error('usage: evaluate-review-quality.mjs --cases FILE --predictions FILE [--adjudicated-labels FILE]');
  }
  return values;
}

export function runCli(argv = process.argv.slice(2)) {
  const flags = parseCli(argv);
  const caseInput = readJson(flags['--cases'], 'cases');
  const predictionInput = readJson(flags['--predictions'], 'predictions');
  const labelInput = flags['--adjudicated-labels'] ? readJson(flags['--adjudicated-labels'], 'adjudicated labels') : [];
  const cases = Array.isArray(caseInput) ? caseInput : caseInput?.cases;
  const predictions = Array.isArray(predictionInput) ? predictionInput : predictionInput?.predictions;
  const adjudicatedLabels = Array.isArray(labelInput) ? labelInput : labelInput?.adjudicated_labels;
  const usage = Array.isArray(predictionInput) ? null : predictionInput?.usage ?? null;
  return evaluateReviewQuality({ cases, predictions, adjudicatedLabels, usage });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`review-quality evaluator: ${error.message}\n`);
    process.exitCode = 1;
  }
}
