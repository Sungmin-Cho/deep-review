#!/usr/bin/env node
'use strict';

/**
 * wrap-recurring-findings-envelope.js — CLI to wrap deep-review's
 * recurring-findings payload in the M3 cross-plugin envelope (cf.
 * deep-suite/docs/envelope-migration.md §1).
 *
 * Designed to be called from review-execution.md Stage 5.5 precheck / recurring-findings-export.md ("Recurring
 * Findings Export") through Node. The agent synthesises the taxonomy
 * payload (classification aggregation over `.deep-review/reports/*.md`) into a temp file,
 * then invokes this helper to produce the final envelope-wrapped artifact at
 * the canonical path `.deep-review/recurring-findings.json`.
 *
 * Usage:
 *   node wrap-recurring-findings-envelope.js \
 *     --payload-file <path-to-payload.json> \
 *     --output <path-to-final-artifact.json> \
 *     [--artifact-kind recurring-findings]    (default; reserved for sidecar kinds)
 *     [--parent-run-id <ULID>] \
 *     [--session-id <id>] \
 *     [--discover-sources-from <project-root>] \
 *     [--source-session-receipt <path>] (chains parent_run_id from deep-work)
 *     [--source-artifact <path[:run_id]>]   (repeatable — generic source ref;
 *                                            typically review report markdown paths)
 *
 * Cross-plugin chain semantics (handoff §3.3):
 *   - recurring-findings: parent_run_id := <session-receipt envelope.run_id>
 *     when --source-session-receipt points at an envelope-wrapped deep-work
 *     session-receipt file. The session-receipt path is also added to
 *     provenance.source_artifacts[] with its run_id.
 *
 *     If session-receipt is legacy (non-envelope) or identity mismatch, the
 *     path lands in source_artifacts WITHOUT run_id and parent_run_id stays
 *     unset (downstream consumers fall through to legacy semantics).
 *
 *   - --source-artifact entries are recorded path-only by default; if the
 *     path points at a self-consistent envelope (producer === schema.name ===
 *     artifact_kind, valid ULID), run_id is auto-harvested. Caller can
 *     override by passing `path:run_id` explicitly.
 *
 * Exit codes:
 *   0 — wrote envelope-wrapped artifact
 *   2 — usage / IO / argv error
 *
 * Self-contained: no external deps. The envelope shape is enforced by the
 * companion validator (scripts/validate-envelope-emit.js).
 */

const fs = require('node:fs');
const path = require('node:path');

const env = require('./envelope');
const { isSessionDocReportName } = require('./lib/session-doc');

function usage(extra) {
  if (extra) process.stderr.write(`error: ${extra}\n`);
  process.stderr.write(
    'usage: wrap-recurring-findings-envelope.js \n' +
      '         --payload-file <payload.json>\n' +
      '         --output <artifact.json>\n' +
      '         [--artifact-kind recurring-findings]\n' +
      '         [--parent-run-id <ULID>]\n' +
      '         [--session-id <id>]\n' +
      '         [--discover-sources-from <project-root>]\n' +
      '         [--source-session-receipt <path>]\n' +
      '         [--source-artifact <path[:run_id]>] (repeatable)\n',
  );
  process.exit(2);
}

const SINGLE_VALUE_FLAGS = new Set([
  'artifact-kind',
  'payload-file',
  'output',
  'parent-run-id',
  'session-id',
  'discover-sources-from',
  'source-session-receipt',
]);
const REPEATABLE_FLAGS = new Set(['source-artifact']);
const KNOWN_FLAGS = new Set([...SINGLE_VALUE_FLAGS, ...REPEATABLE_FLAGS]);

function parseArgs(argv) {
  const args = {};
  const repeats = {};
  for (const f of REPEATABLE_FLAGS) repeats[f] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      usage(`unexpected positional argument: ${a}`);
    }
    let key;
    let value;
    if (a.includes('=')) {
      const eq = a.indexOf('=');
      key = a.slice(2, eq);
      value = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        usage(`flag --${key} expects a value`);
      }
      value = next;
      i++;
    }
    if (!KNOWN_FLAGS.has(key)) {
      usage(`unknown flag --${key}`);
    }

    // Boundary validation (deep-evolve round-1 W3 + C3 lessons):
    // reject malformed values at CLI layer rather than deferring to
    // downstream consumers. Required-value flags must be non-empty;
    // ULID flags must match the regex.
    if (key === 'parent-run-id' && !env.ULID_RE.test(value)) {
      usage(
        `--parent-run-id must be 26-char Crockford Base32 ULID, got "${value}"`,
      );
    }
    if (
      (key === 'session-id' ||
        key === 'source-session-receipt' ||
        key === 'discover-sources-from' ||
        key === 'source-artifact' ||
        key === 'payload-file' ||
        key === 'output' ||
        key === 'artifact-kind') &&
      value.length === 0
    ) {
      // Codex Round-1 Q6 lesson: empty repeatable flag value
      // (`--source-artifact=`) was previously accepted then silently
      // dropped by parseSourceArtifactSpec returning null — losing the
      // user's intent without error. Reject at boundary, consistent with
      // scalar flags.
      usage(`--${key} value must be non-empty`);
    }

    if (REPEATABLE_FLAGS.has(key)) {
      repeats[key].push(value);
    } else {
      args[key] = value;
    }
  }
  for (const f of REPEATABLE_FLAGS) {
    if (repeats[f].length > 0) args[f] = repeats[f];
  }
  return args;
}

function readJson(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    process.stderr.write(`error: cannot read ${p}: ${err.message}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`error: cannot parse ${p} as JSON: ${err.message}\n`);
    process.exit(2);
  }
}

/**
 * Strict-gated extraction of envelope.run_id with identity verification.
 *
 * Mirror of deep-evolve round-1 C2 fix: the prior loose form would accept
 * any envelope-shaped file's run_id, so a foreign-producer envelope at e.g.
 * `.deep-work/<sid>/session-receipt.json` could silently chain into
 * recurring-findings' parent_run_id, corrupting M4 telemetry.
 *
 * Identity contract:
 *   - With { producer, artifactKind } → strict 3-way check + ULID format.
 *   - With { selfConsistent: true } → producer === schema.name ===
 *     artifact_kind self-consistency + ULID format. Used for generic
 *     auto-harvest from --source-artifact path-only entries: we don't
 *     know which producer to expect, but we require the file to be
 *     internally consistent (no half-formed envelopes contributing
 *     trace data).
 *   - With no opts (or `{}`) → null returned (defense against future
 *     regression where a new code path forgets the identity gate).
 *
 * Returns the envelope.run_id when all gates pass, null otherwise.
 * Builds atop env.isValidEnvelope (loose envelope detection + payload
 * non-null/non-array object — handoff §4 W4 lesson).
 */
function tryReadEnvelopeRunId(filePath, opts) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
  if (!env.isValidEnvelope(obj)) return null;
  const e = obj.envelope;
  if (typeof e.run_id !== 'string' || !env.ULID_RE.test(e.run_id)) return null;
  if (!e.schema || typeof e.schema !== 'object' || Array.isArray(e.schema)) return null;

  if (opts && opts.producer !== undefined) {
    if (
      e.producer !== opts.producer ||
      e.artifact_kind !== opts.artifactKind ||
      e.schema.name !== opts.artifactKind
    ) {
      return null;
    }
  } else if (opts && opts.selfConsistent === true) {
    // Self-consistency: producer/artifact_kind/schema.name must agree.
    // Doesn't bind to a specific producer (unknown for generic
    // --source-artifact auto-harvest), but requires the envelope to be
    // internally well-formed.
    if (
      typeof e.producer !== 'string' ||
      typeof e.artifact_kind !== 'string' ||
      e.artifact_kind !== e.schema.name
    ) {
      return null;
    }
  } else {
    // No identity gate provided — refuse to extract. Forces caller
    // intent. Defense against future regression where a new code path
    // forgets the identity gate.
    return null;
  }

  return e.run_id;
}

/**
 * Parse `--source-artifact path[:run_id]` value. The run_id portion is
 * optional and skipped if not a valid ULID (defense against typos / paths
 * containing colons). Returns { path, run_id? } or null on empty path.
 */
function parseSourceArtifactSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return null;
  // Find LAST colon to allow drive letters / URL-like paths in path portion.
  const lastColon = spec.lastIndexOf(':');
  if (lastColon === -1) {
    return { path: spec };
  }
  const candidate = spec.slice(lastColon + 1);
  if (env.ULID_RE.test(candidate)) {
    return { path: spec.slice(0, lastColon), run_id: candidate };
  }
  return { path: spec };
}

function compareUtf8Descending(left, right) {
  return Buffer.compare(Buffer.from(right, 'utf8'), Buffer.from(left, 'utf8'));
}

function regularFile(filePath) {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch (_error) {
    return false;
  }
}

/**
 * Discover the canonical deep-work receipt and the newest twenty review
 * reports using Node filesystem APIs only. Directory entries are deliberately
 * not followed through symbolic links. Ordering mirrors the old lexical
 * newest-first contract, but is byte-deterministic on every host.
 */
function discoverSources(projectRoot) {
  const root = path.resolve(projectRoot);
  const receipts = [];
  const deepWork = path.join(root, '.deep-work');
  let sessionDirs = [];
  try {
    sessionDirs = fs.readdirSync(deepWork, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch (_error) {
    sessionDirs = [];
  }
  for (const entry of sessionDirs) {
    for (const basename of ['session-receipt.json', 'receipt.json']) {
      const candidate = path.join(deepWork, entry.name, basename);
      if (regularFile(candidate)) receipts.push(candidate);
    }
  }
  receipts.sort(compareUtf8Descending);

  const reports = [];
  const reportsRoot = path.join(root, '.deep-review', 'reports');
  let reportEntries = [];
  try {
    reportEntries = fs.readdirSync(reportsRoot, { withFileTypes: true });
  } catch (_error) {
    reportEntries = [];
  }
  for (const entry of reportEntries) {
    // Skip the opt-in per-session review doc (`loop-<id>-review.md`): it is a
    // derived aggregate of the canonical round reports, so counting it as its
    // own provenance source would double-count round findings and inflate
    // recurrence signatures at rounds >= 2 (shared exclusion predicate).
    if (!entry.isFile() || !entry.name.endsWith('-review.md') || isSessionDocReportName(entry.name)) continue;
    reports.push(path.join(reportsRoot, entry.name));
  }
  reports.sort(compareUtf8Descending);
  return {
    sessionReceipt: receipts[0] || '',
    reports: reports.slice(0, 20),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ['payload-file', 'output'];
  for (const r of required) {
    if (!args[r]) usage(`missing required flag --${r}`);
  }

  // artifact-kind defaults to 'recurring-findings' (only allowed value at
  // present). Reserved for future sidecar JSON additions (e.g.
  // review-report-summary) without churning the helper signature.
  const artifactKind = args['artifact-kind'] || 'recurring-findings';
  if (!env.ALLOWED_ARTIFACT_KINDS.has(artifactKind)) {
    usage(
      `--artifact-kind must be one of ${[...env.ALLOWED_ARTIFACT_KINDS].join(', ')}, got "${artifactKind}"`,
    );
  }

  const payloadPath = path.resolve(process.cwd(), args['payload-file']);
  const outputPath = path.resolve(process.cwd(), args['output']);
  const discovered = args['discover-sources-from']
    ? discoverSources(args['discover-sources-from'])
    : { sessionReceipt: '', reports: [] };

  const payload = readJson(payloadPath);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    process.stderr.write(
      `error: payload at ${payloadPath} must be a non-null, non-array object\n`,
    );
    process.exit(2);
  }

  // Cross-plugin chain harvest.
  const sourceArtifacts = [];
  let parentRunId = args['parent-run-id'] || undefined;

  // deep-work session-receipt → identity-checked extraction (handoff §3.3).
  // Strict 3-way gate: foreign envelope at the session-receipt path is
  // rejected (returns null → path-only source_artifact, no parent_run_id
  // chain). Caller's explicit --parent-run-id always wins (set above).
  const receiptSource = args['source-session-receipt'] || discovered.sessionReceipt;
  if (receiptSource) {
    const recPath = path.resolve(process.cwd(), receiptSource);
    const recRunId = tryReadEnvelopeRunId(recPath, {
      producer: 'deep-work',
      artifactKind: 'session-receipt',
    });
    sourceArtifacts.push({
      path: receiptSource,
      ...(recRunId ? { run_id: recRunId } : {}),
    });
    if (!parentRunId && recRunId) {
      parentRunId = recRunId;
    }
  }

  const explicitSpecs = Array.isArray(args['source-artifact']) ? args['source-artifact'] : [];
  const explicitByPath = new Map();
  const explicitOrder = [];
  for (const spec of explicitSpecs) {
    const parsed = parseSourceArtifactSpec(spec);
    if (!parsed) continue;
    const key = path.resolve(process.cwd(), parsed.path);
    if (!explicitByPath.has(key)) explicitOrder.push(key);
    explicitByPath.set(key, spec);
  }
  const discoveredPaths = new Set(
    discovered.reports.map((report) => path.resolve(process.cwd(), report)),
  );
  const sourceSpecs = discovered.reports.map((report) => (
    explicitByPath.get(path.resolve(process.cwd(), report)) || report
  ));
  for (const key of explicitOrder) {
    if (!discoveredPaths.has(key)) sourceSpecs.push(explicitByPath.get(key));
  }
  const seenSourcePaths = new Set(sourceArtifacts.map((entry) => path.resolve(process.cwd(), entry.path)));

  // Generic --source-artifact entries (repeatable; typically review report
  // markdown paths or other multi-source aggregator inputs).
  // For path-only entries (no `:run_id` suffix), auto-harvest the envelope's
  // run_id IF the file at path is a self-consistent envelope. Caller can
  // override by passing `path:run_id` explicitly.
  if (sourceSpecs.length > 0) {
    for (const spec of sourceSpecs) {
      const parsed = parseSourceArtifactSpec(spec);
      if (!parsed) continue;
      const sourceKey = path.resolve(process.cwd(), parsed.path);
      if (seenSourcePaths.has(sourceKey)) continue;
      if (!parsed.run_id) {
        // Auto-harvest with self-consistency check.
        const abs = path.isAbsolute(parsed.path)
          ? parsed.path
          : path.resolve(process.cwd(), parsed.path);
        const harvested = tryReadEnvelopeRunId(abs, { selfConsistent: true });
        if (harvested) {
          parsed.run_id = harvested;
        }
      }
      sourceArtifacts.push(parsed);
      seenSourcePaths.add(sourceKey);
    }
  }

  let wrapped;
  try {
    wrapped = env.wrapEnvelope({
      artifactKind,
      payload,
      parentRunId,
      sessionId: args['session-id'] || undefined,
      sourceArtifacts,
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (err) {
      process.stderr.write(`error: cannot mkdir ${outDir}: ${err.message}\n`);
      process.exit(2);
    }
  }

  // Atomic write (deep-work round-1 C1 lesson): write to a unique temp path
  // then rename. Mid-write interruption (Ctrl-C, OOM, hook timeout) or two
  // concurrent finishers must not leave a truncated artifact that
  // downstream readers (deep-evolve init.md Stage 3.5, deep-work
  // gather-signals.sh) parse-fail on.
  const tmpPath = `${outputPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(wrapped, null, 2) + '\n', 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    process.stderr.write(`error: cannot write ${tmpPath}: ${err.message}\n`);
    process.exit(2);
  }
  try {
    fs.renameSync(tmpPath, outputPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
    process.stderr.write(`error: cannot rename ${tmpPath} → ${outputPath}: ${err.message}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `wrapped: ${outputPath} (run_id=${wrapped.envelope.run_id}, artifact_kind=${wrapped.envelope.artifact_kind})\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = { discoverSources, parseSourceArtifactSpec, tryReadEnvelopeRunId };
