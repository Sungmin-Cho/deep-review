const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const report = (bullet = '') => `# Deep Review Report — 2026-09-06\n\n## Summary\n- **Verdict**: ${bullet ? 'CONCERN' : 'APPROVE'}\n- **Issues**: 🔴 0건, 🟡 ${bullet ? 1 : 0}건, ℹ️ 0건\n\n## Code Review\n### 🔴 Critical\nNone.\n### 🟡 Warning\n${bullet ? '- ' + bullet : 'None.'}\n### ℹ️ Info\nNone.\n### 🟢 Passed\n- Examined selected behavior.\n`;
async function runGroup(f, severity, content, commit = true) {
  const p = await import('../hooks/scripts/phase6-protocol.mjs');
  const snapshot = p.snapshotPhase6({ repo: f.repo, severity, targetScope: f.scope, acceptedItems: [{ item_id: 'ITEM-1', target_location: 'a.js' }] });
  f.write('a.js', content);
  await p.runLoggedTest({ repo: f.repo, itemId: 'ITEM-1', command: process.execPath, args: ['-e', `require('node:assert/strict').equal(require('node:fs').readFileSync('a.js','utf8'),${JSON.stringify(content)})`], logPath: snapshot.log_path });
  const text = '## Group Result\n- execution_status: completed\n- items_total: 1\n- items_passed: 1\n- items_failed: 0\n- items_skipped: 0\n\n## Items\n### ITEM-1\n- status: passed\n- files_changed:\n  - "a.js"\n- test_command: node fixture\n- test_exit_code: 0\n- log_range: ITEM-1\n- action_summary: applied\n';
  const verified = p.verifyPhase6({ repo: f.repo, snapshotPath: snapshot.snapshot_path, groupResult: text });
  const result = { snapshot_file: snapshot.snapshot_path, group_result_file: f.write(`.deep-review/tmp/${severity}-group.md`, text), verification_result_file: f.write(`.deep-review/tmp/${severity}-verify.json`, verified) };
  if (commit) result.commit_result_file = f.write(`.deep-review/tmp/${severity}-commit.json`, p.commitPhase6({ repo: f.repo, snapshotPath: snapshot.snapshot_path, severity }));
  return result;
}
async function fixture(t, { git = false, view } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-decision-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const write = (file, value) => { const p = path.join(repo, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); return p; };
  write('a.js', 'export const a = 1;\n');
  const gitRun = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  if (git) { gitRun('init', '-q'); gitRun('config', 'user.email', 'test@example.invalid'); gitRun('config', 'user.name', 'Test'); write('.gitignore', '.deep-review/\n'); gitRun('add', '.'); if (view !== 'initial') gitRun('commit', '-qm', 'base'); }
  if (view === 'staged') { write('a.js', 'export const a = 2;\n'); gitRun('add', 'a.js'); }
  const e = await import('../hooks/scripts/review-evidence.mjs');
  const targetApi = await import('../hooks/scripts/lib/review-target-snapshot.mjs');
  const loop = await import('../hooks/scripts/loop-state.mjs');
  const builder = await import('../hooks/scripts/build-reviewer-payload.mjs');
  const changeState = view ?? (git ? 'unstaged' : 'non-git');
  const base = git && view !== 'initial' ? gitRun('rev-parse', 'HEAD') : null;
  const records = (await import('../hooks/scripts/lib/review-target.mjs')).buildChangeFiles({ repo, changeState, reviewBase: base, filesFromZ: Buffer.from('a.js\0'), includeBinary: true });
  const scope = await targetApi.createTargetScope({ repo, changeState, reviewBase: base, records });
  const capture = async () => { const target = await targetApi.captureReviewTarget({ scope }); return { target, file: write('.deep-review/tmp/current-target.json', target) }; };
  let round = 0;
  const decision = async ({ bullet = '', confirmation = null, request = null, usage, retryAttempts, disposition = 'confirmed_blocker' } = {}) => {
    round += 1;
    const { target, file } = await capture();
    const route = { reviewer_id: 'codex-review', provider: 'codex', adapter_id: 'codex-native-generic', assignment_role: request ? 'confirmation' : 'standard', rubric_id: request ? 'confirmation-v1' : 'standard-v1', wave: 1, required: true, selection_reason: 'fixture', resolved: { model: null, effort: 'high' }, artifact_phase: 'implementation', risk: 'low', document_review_mode: 'full-readiness' };
    const evidenceInputs = { context: 'export returns one', diff: 'selected a.js', changeFiles: 'a.js', priorRounds: '', readinessReceipt: '' };
    const { plan } = e.prepareReviewRound({ routingPlan: { protocol_version: '3.0', artifact_phase: 'implementation', risk: 'low', document_review_mode: 'full-readiness', reviewer_strategy: 'adaptive', shadow_mode: false, progress: 'initial', minimum_reviewers: 1, planned_reviewers: 1, provider_family_minimum: 1, maximum_reviewers: 2, max_expansion_waves: 0, initial_reviewer_ids: ['codex-review'], required_reviewer_ids: ['codex-review'], candidate_reviewers: [{ reviewer_id: 'codex-review', provider: 'codex', adapter_id: route.adapter_id, assignment_roles: [route.assignment_role], last_status: 'success' }], routes: [route] }, target, evidenceInputs, roundId: `round-${round}`, confirmationRequest: request ? { schema_version: 1, target_digest: target.target_digest, finding_ids: request } : null });
    const raw = { reviewer_id: 'codex-review', role: 'codex-review', output: report(bullet) + (confirmation ? `\n## Confirmation\n\n\x60\x60\x60json\n${JSON.stringify({ schema_version: 1, target_digest: target.target_digest, items: confirmation })}\n\x60\x60\x60\n` : ''), beforeFingerprint: { mode: 'git', digest: 'a' }, afterFingerprint: { mode: 'git', digest: 'a' }, target_before: target, target_after: target, evidence_digest: plan.evidence_digest, ...(usage !== undefined ? { usage } : {}) };
    const execution_route = { protocol_version: '3.0', ...plan.routes[0] };
    const launches = [{ reviewer_id: raw.reviewer_id, attempt_id: `attempt-${round}`, invocation_id: `invocation-${round}`, execution_route, payload: builder.buildPreparedReviewerPayload({ executionRoute: execution_route, evidenceInputs }), payload_provenance: 'native-argument', ...(retryAttempts ? { retry_attempts: retryAttempts } : {}) }];
    const sources = (await import('../hooks/scripts/lib/review-adjudication.mjs')).extractSourceFindings(raw.output, raw.reviewer_id);
    const adjudication = { schema_version: '1.0', groups: sources.map(({ bullet: ignored, ...source }) => ({ source_refs: [source], disposition, severity: 'warning', category: 'error-handling', rationale: bullet, evidence: [{ location: 'a.js:1', observation: 'contract mismatch' }], ...(disposition === 'unresolved' ? { missing_evidence: 'Needs a concrete reachable trace.' } : {}) })) };
    const input = { routing_plan: plan, evidence_inputs: evidenceInputs, attempts: [raw], launches, dispatch: e.buildDispatchEvidence({ routingPlan: plan, attempts: [raw], launches, roundId: plan.round_id }), adjudication };
    const result = await e.finalizeReviewDecision({ repo, input });
    return { ...result, target, targetFile: file, input };
  };
  const record = (d, options = {}) => loop.recordRound({ repoRoot: repo, stateDir: path.join(repo, '.deep-review/tmp'), baseCommit: scope.review_base, roundNumber: round, roundLimit: 5, reviewReport: d.report_path, decisionFile: d.decision_path, postResponseTargetFile: d.targetFile, ...options });
  return { repo, write, gitRun, e, loop, scope, capture, decision, record };
}
test('schema 3 decision joins, complete observations, sync history, and last-slot review-only CLI', async t => {
  const f = await fixture(t);
  const d = await f.decision();
  assert.equal(typeof f.e.verifyReviewDecisionSync, 'function');
  assert.deepEqual(f.e.verifyReviewDecisionSync({ repo: f.repo, decisionFile: d.decision_path }), await f.e.verifyReviewDecision({ repo: f.repo, decisionFile: d.decision_path }));
  const r = f.record(d, { roundLimit: 1 });
  const state = f.loop.readRoundState(r.state_file);
  assert.equal(state.schema_version, 3);
  assert.equal(state.observations.status, 'complete');
  const before = await f.loop.decideRound({ decisionFile: d.decision_path, roundNumber: 1, roundLimit: 1, currentTargetFile: d.targetFile, phase: 'before-respond' });
  assert.equal(before.action, 'stop');
  assert.equal(before.final_tree_verified, true);
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(root, 'hooks/scripts/loop-state.mjs'), 'decide-round', '--state-file', r.state_file, '--round-limit', '1', '--current-target-file', d.targetFile, '--phase', 'after-respond'], { encoding: 'utf8' }));
  assert.equal(cli.completion_status, 'verified');
  fs.appendFileSync(d.report_path, 'tampered');
  assert.throws(() => f.loop.readRoundState(r.state_file), /report|decision/);
});
test('omitted pending IDs remain open until exact positive closure, with unforgeable lineage', async t => {
  const f = await fixture(t);
  const d1 = await f.decision({ bullet: '`a.js:1` — Incorrect return violates the contract.' });
  const r1 = f.record(d1);
  const id = d1.decision.material_findings.findings[0].finding_id;
  const d2 = await f.decision();
  const r2 = f.record(d2, { previousState: r1.state_file, loopId: r1.loop_id });
  assert.deepEqual(f.loop.readRoundState(r2.state_file).pending_findings.map(x => x.finding_id), [id]);
  const omitted = await f.loop.decideRound({ stateFile: r2.state_file, currentTargetFile: d2.targetFile, roundLimit: 5, phase: 'after-respond' });
  assert.equal(omitted.completion_status, 'unresolved');
  assert.equal(omitted.final_tree_verified, true);
  const doc = f.write('.deep-review/reports/session.md', '');
  f.loop.renderSessionDoc({ loopId: r1.loop_id, tmpDir: path.dirname(r1.state_file), reportsDir: path.dirname(doc), output: doc });
  assert.match(fs.readFileSync(doc, 'utf8'), /not re-observed/i);
  assert.doesNotMatch(fs.readFileSync(doc, 'utf8'), /Resolved \(cumulative\) — 1/);
  assert.throws(() => f.record(d2, { previousState: r1.state_file, loopId: 'foreign' }), /loop|lineage/);
  assert.throws(() => f.record(d2, { previousState: r1.state_file, roundNumber: 3 }), /round|adjacen/);
  assert.throws(() => f.record(d2, { previousState: r1.state_file, roundLimit: 2 }), /limit/);
  const d3 = await f.decision({ request: [id], confirmation: [{ finding_id: id, status: 'verified_closed', evidence: [{ location: 'a.js:1', observation: 'Now returns correct value.' }] }] });
  const r3 = f.record(d3, { previousState: r2.state_file, loopId: r1.loop_id });
  assert.deepEqual(f.loop.readRoundState(r3.state_file).pending_findings, []);
  assert.equal((await f.loop.decideRound({ stateFile: r3.state_file, currentTargetFile: d3.targetFile, roundLimit: 5, phase: 'after-respond' })).completion_status, 'verified');
  const forged = JSON.parse(fs.readFileSync(r2.state_file)); forged.pending_findings = [];
  fs.writeFileSync(r2.state_file, JSON.stringify(forged));
  assert.throws(() => f.loop.readRoundState(r2.state_file), /state|ledger/);
});
test('fresh recapture is unconditional; external edits and forged snapshots never finish clean', async t => {
  const f = await fixture(t);
  const d = await f.decision(); const r = f.record(d, { roundLimit: 1 });
  f.write('a.js', 'external change');
  await assert.rejects(f.loop.decideRound({ stateFile: r.state_file, currentTargetFile: d.targetFile, roundLimit: 1, phase: 'after-respond' }), /stale|snapshot|current/);
  const changed = await f.capture();
  const result = await f.loop.decideRound({ stateFile: r.state_file, currentTargetFile: changed.file, roundLimit: 1, phase: 'after-respond' });
  assert.equal(result.action, 'stop'); assert.equal(result.completion_status, 'UNVERIFIED_FINAL_TREE');
  assert.equal(result.stop_reason, 'OPERATIONAL_FAILURE');
  const before = await f.loop.decideRound({ decisionFile: d.decision_path, roundNumber: 1, roundLimit: 1, currentTargetFile: changed.file, phase: 'before-respond' });
  assert.equal(before.stop_reason, 'OPERATIONAL_FAILURE');
  await assert.rejects(f.loop.decideRound({ decisionFile: d.decision_path, stateFile: r.state_file, currentTargetFile: changed.file, roundLimit: 1, phase: 'after-respond' }), /exclusive|mode/);
});
test('usage rejects coerced and unknown provenance values; retry calls count as real attempts', async t => {
  const f = await fixture(t);
  await assert.rejects(f.decision({ usage: { input_tokens: '1', provenance: 'adapter' } }), /usage/);
  await assert.rejects(f.decision({ usage: { cost: 0.01 } }), /usage|provenance/);
  const d = await f.decision({ usage: { input_tokens: 20, output_tokens: 3, provenance: 'adapter:test' }, retryAttempts: [{ attempt_id: 'retry-1', invocation_id: 'retry-invocation-1', status: 'timeout' }] });
  const r = f.record(d, { roundNumber: 1 });
  const s = f.loop.readRoundState(r.state_file);
  assert.equal(s.accounting.executed_reviewer_calls, 2);
  assert.equal(s.accounting.admitted_reviewer_calls, 1);
  assert.equal(s.observed_usage[0].usage.cost, null);
});

module.exports = { fixture };

test('real Phase6 change and commit require another review; archived proof survives runtime rotation', async t => {
  const f = await fixture(t, { git: true });
  const p = await import('../hooks/scripts/phase6-protocol.mjs');
  const d = await f.decision({ bullet: '`a.js:1` — Incorrect return violates the contract.' });
  const snapshot = p.snapshotPhase6({ repo: f.repo, severity: 'warning', acceptedItems: [{ item_id: 'ITEM-1', target_location: 'a.js' }], targetScope: f.scope });
  f.write('a.js', 'export const a = 2;\n');
  await p.runLoggedTest({ repo: f.repo, itemId: 'ITEM-1', command: process.execPath, args: ['-e', "if (!require('fs').readFileSync('a.js','utf8').includes('= 2')) process.exit(1)"], logPath: snapshot.log_path });
  const group = '## Group Result\n- execution_status: completed\n- items_total: 1\n- items_passed: 1\n- items_failed: 0\n- items_skipped: 0\n\n## Items\n### ITEM-1\n- status: passed\n- files_changed:\n  - "a.js"\n- test_command: node fixture\n- test_exit_code: 0\n- log_range: ITEM-1\n- action_summary: applied\n';
  const verified = p.verifyPhase6({ repo: f.repo, snapshotPath: snapshot.snapshot_path, groupResult: group });
  const committed = p.commitPhase6({ repo: f.repo, snapshotPath: snapshot.snapshot_path, severity: 'warning' });
  const post = await f.capture();
  assert.equal(typeof f.loop.buildResponseEvidence, 'function');
  const proof = await f.loop.buildResponseEvidence({ repo: f.repo, decisionFile: d.decision_path, postResponseTargetFile: post.file,
    groups: [{ snapshot_file: snapshot.snapshot_path, group_result_file: f.write('.deep-review/tmp/group.md', group), verification_result_file: f.write('.deep-review/tmp/verify.json', verified), commit_result_file: f.write('.deep-review/tmp/commit.json', committed) }], status: 'completed', halted: false });
  const r = f.record(d, { responseEvidenceFile: proof.evidence_file, postResponseTargetFile: post.file });
  const next = await f.loop.decideRound({ stateFile: r.state_file, currentTargetFile: post.file, roundLimit: 5, phase: 'after-respond' });
  assert.equal(next.action, 'review'); assert.equal(next.completion_status, 'verification_pending');
  assert.equal(f.loop.readRoundState(r.state_file).response.status, 'verified');
  const decisionApi = await import('../hooks/scripts/lib/review-loop-decision.mjs');
  const { planReviewerAssignments } = await import('../hooks/scripts/lib/adaptive-review-routing.mjs');
  const context = f.loop.adaptiveCarrier({ stateFile: r.state_file, currentTargetFile: post.file });
  const progress = await decisionApi.verifyAdaptiveContext({ repo: f.repo, context });
  const candidates = [{ id: 'codex-review', provider: 'codex', assignment_roles: ['standard', 'adversarial', 'confirmation'] }, { id: 'claude-opus', provider: 'claude', assignment_roles: ['standard', 'adversarial', 'confirmation'] }];
  const routeOptions = { artifacts: [{ path: 'a.js', target_kind: 'code-change' }], risk: 'low', candidates };
  assert.equal(planReviewerAssignments({ ...routeOptions, progress }).assignments.length, 1);
  assert.equal(planReviewerAssignments({ ...routeOptions, progress: structuredClone(progress) }).assignments.length, 2);
  const fullCandidates = [...candidates.map(candidate => ({ ...candidate, assignment_roles: ['standard', 'adversarial', 'security', 'confirmation'] })),
    { id: 'codex-adversarial', provider: 'codex', assignment_roles: ['adversarial', 'security'] }];
  for (const risk of ['high', 'critical']) {
    const full = planReviewerAssignments({ ...routeOptions, candidates: fullCandidates, progress, risk });
    assert.deepEqual(full.assignments.map(row => row.assignment_role), ['standard', 'adversarial', 'security']);
    assert.equal(full.assignments.length, 3);
    assert.deepEqual(full.pending_confirmation.finding_ids, context.pending_finding_ids);
  }
  const { bullet: ignored, ...sourceRef } = d.decision.adjudication.source_findings[0];
  const regressionEvidence = { source_ref: sourceRef, location: 'a.js:1', observation: 'The changed return introduces a different violated branch.',
    prior_target_digest: d.target.target_digest, current_target_digest: post.target.target_digest };
  const regressed = await decisionApi.verifyAdaptiveContext({ repo: f.repo, context: { ...context, regression_evidence: regressionEvidence } });
  const expanded = planReviewerAssignments({ ...routeOptions, candidates: fullCandidates, progress: regressed });
  assert.equal(expanded.assignments.length, 3);
  assert.ok(expanded.assignments.every(row => row.tier_adjustment === 1));
  await assert.rejects(decisionApi.verifyAdaptiveContext({ repo: f.repo, context: { ...context, regression_evidence: { ...regressionEvidence, current_target_digest: '0'.repeat(64) } } }), /regression evidence/);
  await assert.rejects(decisionApi.verifyAdaptiveContext({ repo: f.repo, context: { ...context, pending_finding_ids: [] } }), /binding/);
  const { runClassifyArtifactsCli } = await import('../hooks/scripts/classify-artifacts.mjs');
  const runtime = { capabilities: ['claude', 'codex'].map(provider => ({ protocol_version: '2.0', adapter_id: provider === 'claude' ? 'claude-native-agent' : 'codex-native-generic', provider, available: true, roles: ['standard', 'adversarial'], model_selection: { supported: false, aliases: [] }, effort_selection: { supported: false, levels: [] }, read_only_enforcement: 'instruction-only' })) };
  const targetList = f.write('.deep-review/tmp/targets.z', 'a.js\0');
  const argv = ['--repo', f.repo, '--change-state', f.scope.change_state, '--review-base', f.scope.review_base,
    '--files-from0', targetList, '--adaptive-context-json', JSON.stringify(context)];
  const unavailable = await runClassifyArtifactsCli(argv, {}, runtime);
  assert.equal(unavailable.routing_plan.routes.length, 2, 'no contraction without an eligible confirmation role');
  runtime.capabilities.forEach(cap => { cap.assignment_roles = ['standard', 'adversarial', 'confirmation']; });
  const classified = await runClassifyArtifactsCli(argv, {}, runtime);
  assert.equal(classified.routing_plan.routes.length, 1);
  assert.equal(classified.routing_plan.routes[0].assignment_role, 'confirmation');
  assert.deepEqual(classified.routing_plan.pending_confirmation.finding_ids, context.pending_finding_ids);
  p.rotatePhase6Artifacts({ repo: f.repo });
  assert.equal(f.loop.readRoundState(r.state_file).response.status, 'verified');
  const id = d.decision.material_findings.findings[0].finding_id;
  const d2 = await f.decision({ request: [id], confirmation: [{ finding_id: id, status: 'verified_closed', evidence: [{ location: 'a.js:1', observation: 'Returns two as specified.' }] }] });
  const r2 = f.record(d2, { previousState: r.state_file, loopId: r.loop_id });
  assert.equal((await f.loop.decideRound({ stateFile: r2.state_file, currentTargetFile: d2.targetFile, roundLimit: 5, phase: 'after-respond' })).completion_status, 'verified');
});

test('report-only adaptive signals stay at baseline and purely negated prose cannot manufacture risk', async () => {
  const { planReviewerAssignments } = await import('../hooks/scripts/lib/adaptive-review-routing.mjs');
  const { assessRisk } = await import('../hooks/scripts/lib/model-router.mjs');
  const options = { artifacts: [{ path: 'a.js', target_kind: 'code-change' }], candidates: [
    { id: 'claude-opus', provider: 'claude' }, { id: 'codex-review', provider: 'codex' }, { id: 'codex-adversarial', provider: 'codex' }], risk: 'low' };
  for (const state of ['confirmation', 'regression', 'stalled', 'indeterminate']) {
    const plan = planReviewerAssignments({ ...options, progress: { state } });
    assert.equal(plan.assignments.length, 2, state);
    assert.ok(plan.assignments.every(row => row.tier_adjustment === 0), state);
  }
  assert.equal(assessRisk([{ path: 'docs/notes.md', content: 'No authentication or payments changes.\nNo destructive changes.' }]), 'low');
  assert.equal(assessRisk([{ path: 'src/auth/login.js', content: 'No authentication changes.' }]), 'high');
  assert.equal(assessRisk([{ path: 'a.js', diff: '-const authentication = enabled;\n+const authentication = false;' }]), 'high');
  assert.equal(assessRisk([{ content: 'No authentication changes, but billing behavior changes.' }]), 'high');
  assert.equal(assessRisk([{ content: 'No authentication changes.' }], { policyRisk: 'critical' }), 'critical');
});

test('Respond consumes only confirmed bound findings and refuses stale authority', async t => {
  const f = await fixture(t);
  const unresolved = await f.decision({ bullet: '`a.js:1` — Return may be incorrect.', disposition: 'unresolved' });
  assert.equal(typeof f.e.prepareResponseItems, 'function');
  assert.deepEqual((await f.e.prepareResponseItems({ repo: f.repo, decisionFile: unresolved.decision_path })).confirmed_findings, []);
  const confirmed = await f.decision({ bullet: '`a.js:1` — Return violates the contract.' });
  const items = await f.e.prepareResponseItems({ repo: f.repo, decisionFile: confirmed.decision_path });
  assert.equal(items.confirmed_findings.length, 1);
  assert.equal(items.confirmed_findings[0].finding_id, confirmed.decision.material_findings.findings[0].finding_id);
  f.write('a.js', 'external change');
  await assert.rejects(f.e.prepareResponseItems({ repo: f.repo, decisionFile: confirmed.decision_path }), /target/);
});

test('indeterminate observations and schema-2 history cannot establish completion', async t => {
  const f = await fixture(t);
  const d = await f.decision({ bullet: 'Unlocated return claim.' });
  const r = f.record(d);
  const value = await f.loop.decideRound({ stateFile: r.state_file, roundLimit: 5, currentTargetFile: d.targetFile, phase: 'after-respond' });
  assert.equal(value.completion_status, 'unresolved');
  assert.equal(value.final_tree_verified, false);
  const legacy = f.loop.recordRound({ reviewReport: d.report_path, roundNumber: 1, baseCommit: 'legacy', stateDir: path.join(f.repo, '.deep-review/tmp') });
  assert.equal(f.loop.readRoundState(legacy.state_file).schema_version, 2);
  await assert.rejects(f.loop.decideRound({ stateFile: legacy.state_file, currentTargetFile: d.targetFile, roundLimit: 5, phase: 'after-respond' }), /schema-3/);
});

test('launch builder creates local invocation identities and binds actual payload bytes', async t => {
  const f = await fixture(t); const d = await f.decision();
  assert.equal(typeof f.e.buildReviewerLaunch, 'function');
  const input = { executionRoute: d.input.launches[0].execution_route, evidenceInputs: d.input.evidence_inputs };
  const a = f.e.buildReviewerLaunch(input), b = f.e.buildReviewerLaunch(input);
  assert.notEqual(a.invocation_id, b.invocation_id);
  assert.notEqual(a.attempt_id, b.attempt_id);
  assert.equal(a.payload, d.input.launches[0].payload);
  assert.equal(a.payload_sha256, (await import('../hooks/scripts/lib/review-target-snapshot.mjs')).evidenceHash(a.payload));
});

test('every response group is required; noncommit proof works and tampering or halt cannot contract', async t => {
  const f = await fixture(t, { git: true });
  const d = await f.decision({ bullet: '`a.js:1` — Incorrect return violates the contract.' });
  const first = await runGroup(f, 'critical', 'export const a = 2;\n');
  const second = await runGroup(f, 'warning', 'export const a = 3;\n', false);
  const post = await f.capture();
  const options = { repo: f.repo, decisionFile: d.decision_path, postResponseTargetFile: post.file, groups: [first, second], status: 'completed', halted: false };
  const proof = await f.loop.buildResponseEvidence(options);
  assert.equal(proof.response.status, 'verified'); assert.equal(proof.response.group_count, 2);
  const omitted = await f.loop.buildResponseEvidence({ ...options, groups: [second] });
  assert.equal(omitted.response.status, 'unknown');
  const halted = await f.loop.buildResponseEvidence({ ...options, status: 'halted', halted: true });
  assert.equal(halted.response.status, 'unknown');
  const r = f.record(d, { responseEvidenceFile: proof.evidence_file, postResponseTargetFile: post.file });
  const stop = await f.loop.decideRound({ stateFile: r.state_file, currentTargetFile: post.file, roundLimit: 5, phase: 'after-respond', userStop: true });
  assert.equal(stop.stop_reason, 'USER_STOP'); assert.equal(stop.completion_status, 'UNVERIFIED_FINAL_TREE');
  const evidence = JSON.parse(fs.readFileSync(proof.evidence_file));
  fs.appendFileSync(evidence.groups[0].groupResultFile, 'tampered');
  assert.throws(() => f.loop.readRoundState(r.state_file), /state|evidence/);
});

test('schema-3 lineage rejects missing companions, wrong base, reused decisions and bad overrides', async t => {
  const f = await fixture(t); const d = await f.decision(); const r = f.record(d);
  assert.throws(() => f.record(d, { baseCommit: 'deadbeef' }), /base/);
  assert.throws(() => f.record(d, { roundNumber: 2, previousState: r.state_file }), /reused/);
  const d2 = await f.decision();
  assert.throws(() => f.record(d2, { decisionFile: f.write('.deep-review/reports/fake-decision.json', {}) }), /decision/);
  const override = f.write('.deep-review/tmp/limit-override.json', { source: 'user', prior_limit: 5, new_limit: 6, reason: 'Explicit user request.' });
  const r2 = f.record(d2, { previousState: r.state_file, roundLimit: 6, roundLimitOverrideFile: override });
  assert.equal(f.loop.readRoundState(r2.state_file).round_limit, 6);
  await assert.rejects(f.loop.decideRound({ stateFile: r2.state_file, currentTargetFile: d2.targetFile, roundLimit: 5, phase: 'after-respond' }), /limit/);
});

test('terminal failures have count-only receipts and an operational stop without a fabricated verdict', async t => {
  const f = await fixture(t); const d = await f.decision();
  assert.equal(typeof f.e.recordReviewOperations, 'function');
  const { spawnSync } = require('node:child_process');
  const failed = spawnSync(process.execPath, ['-e', 'process.exit(7)'], { encoding: 'utf8' });
  const input = structuredClone(d.input);
  input.attempts[0].output = '';
  input.launches[0].result_file = f.write('.deep-review/tmp/failed-result.json', { launched: true, status: 'failed', provenance: 'node:spawnSync', exit_code: failed.status, stderr: failed.stderr });
  const receipt = f.e.recordReviewOperations({ repo: f.repo, input, reason: 'NO_TRUSTED_REVIEWER' });
  const verified = f.e.verifyReviewOperations({ repo: f.repo, operationsFile: receipt.operations_file });
  assert.equal(verified.phase6_allowed, false); assert.equal(verified.verdict, undefined);
  assert.equal(verified.accounting.executed_reviewer_calls, 1);
  const stop = await f.loop.decideOperationalStop({ operationsFile: receipt.operations_file, currentTargetFile: d.targetFile });
  assert.equal(stop.action, 'stop'); assert.equal(stop.stop_reason, 'NO_TRUSTED_REVIEWER');
  assert.equal(stop.final_tree_verified, false); assert.equal(stop.last_trusted_verdict, null);
  const requiredFailure = f.e.recordReviewOperations({ repo: f.repo, input, reason: 'REQUIRED_REVIEWER_FAILED' });
  const requiredStop = await f.loop.decideOperationalStop({ operationsFile: requiredFailure.operations_file, currentTargetFile: d.targetFile, decisionFile: d.decision_path, roundLimit: 5 });
  assert.equal(requiredStop.stop_reason, 'REQUIRED_REVIEWER_FAILED');
  assert.equal(requiredStop.last_trusted_verdict, 'APPROVE');
  assert.equal(requiredStop.final_tree_verified, false);
  assert.equal(requiredStop.verdict, undefined);
  const unknownInput = structuredClone(input); delete unknownInput.launches[0].result_file;
  const unknown = f.e.recordReviewOperations({ repo: f.repo, input: unknownInput });
  assert.equal(unknown.receipt.accounting.executed_reviewer_calls, null);
  assert.equal(unknown.receipt.accounting.not_run_reviewer_calls, null);
  f.write('a.js', 'unaccounted edit');
  await assert.rejects(f.loop.decideOperationalStop({ operationsFile: receipt.operations_file, currentTargetFile: (await f.capture()).file }), /stale operational/);
  const source = JSON.parse(fs.readFileSync(receipt.operations_file));
  fs.appendFileSync(source.source_input_path, 'tampered');
  assert.throws(() => f.e.verifyReviewOperations({ repo: f.repo, operationsFile: receipt.operations_file }), /source|digest/);
});

test('soft-floor replacement rebinds confirmation onto the remaining selected routes', async t => {
  const f = await fixture(t);
  const { target } = await f.capture();
  const evidenceInputs = { context: 'export returns one', diff: 'selected a.js', changeFiles: 'a.js', priorRounds: '', readinessReceipt: '' };
  const standard = {
    reviewer_id: 'codex-review', provider: 'codex', adapter_id: 'codex-native-generic',
    assignment_role: 'standard', rubric_id: 'standard-v1', wave: 1, required: false,
    selection_reason: 'soft floor', resolved: { model: null, effort: 'high' },
    artifact_phase: 'implementation', risk: 'low', document_review_mode: 'full-readiness',
  };
  const adversarial = { ...standard, reviewer_id: 'codex-adversarial', assignment_role: 'adversarial', rubric_id: 'adversarial-v1' };
  const prepared = f.e.prepareReviewRound({
    routingPlan: {
      protocol_version: '3.0', artifact_phase: 'implementation', risk: 'low', document_review_mode: 'full-readiness',
      reviewer_strategy: 'adaptive', shadow_mode: false, progress: 'confirmation',
      minimum_reviewers: 2, planned_reviewers: 2, provider_family_minimum: 1, maximum_reviewers: 3, max_expansion_waves: 1,
      initial_reviewer_ids: ['codex-review', 'codex-adversarial'], required_reviewer_ids: [],
      candidate_reviewers: [
        { reviewer_id: 'codex-review', provider: 'codex', adapter_id: 'codex-native-generic', assignment_roles: ['standard', 'confirmation'], last_status: 'success' },
        { reviewer_id: 'codex-adversarial', provider: 'codex', adapter_id: 'codex-native-generic', assignment_roles: ['adversarial'], last_status: 'success' },
        {
          reviewer_id: 'claude-opus', provider: 'claude', adapter_id: 'claude-cli', assignment_roles: ['standard', 'confirmation'], last_status: 'success',
          expansion_route_templates: [{
            reviewer_id: 'claude-opus', provider: 'claude', adapter_id: 'claude-cli', assignment_role: 'standard',
            rubric_id: 'standard-v1', wave: 2, required: false, selection_reason: 'unused replacement',
            resolved: { model: null, effort: 'high' }, artifact_phase: 'implementation', risk: 'low', document_review_mode: 'full-readiness',
          }],
        },
      ],
      routes: [standard, adversarial],
    },
    target,
    evidenceInputs,
    roundId: 'confirm-round',
    confirmationRequest: { schema_version: 1, target_digest: target.target_digest, finding_ids: ['F-pending'] },
  });
  const { synthesizeReviewRound, evaluateReviewerAttempt } = await import('../hooks/scripts/review-synthesis.mjs');
  const { parsePreparedReviewBinding } = await import('../hooks/scripts/lib/execution-plan.mjs');
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  const rawStandard = { reviewer_id: 'codex-review', role: 'codex-review', output: '', beforeFingerprint: fingerprint, afterFingerprint: fingerprint, target_before: target, target_after: target, evidence_digest: prepared.plan.evidence_digest };
  const rawAdversarial = { reviewer_id: 'codex-adversarial', role: 'codex-adversarial', output: report(), beforeFingerprint: fingerprint, afterFingerprint: fingerprint, target_before: target, target_after: target, evidence_digest: prepared.plan.evidence_digest };
  const launches = prepared.plan.routes.map((route) => ({
    ...f.e.buildReviewerLaunch({ executionRoute: { protocol_version: '3.0', ...route }, evidenceInputs }),
    payload_provenance: 'native-argument',
  }));
  const synthesis = synthesizeReviewRound({
    attempts: [evaluateReviewerAttempt(rawStandard), evaluateReviewerAttempt(rawAdversarial)],
    routingPlan: prepared.plan,
    dispatch: f.e.buildDispatchEvidence({ routingPlan: prepared.plan, attempts: [rawStandard, rawAdversarial], launches, roundId: prepared.plan.round_id }),
    adjudication: { schema_version: '1.0', groups: [] },
  });
  assert.equal(synthesis.status, 'needs_expansion');
  assert.ok(!synthesis.expanded_routing_plan.routes.some((route) => route.reviewer_id === 'codex-review'));
  assert.ok(synthesis.expanded_routing_plan.confirmation_reviewer_ids.every(
    (id) => synthesis.expanded_routing_plan.routes.some((route) => route.reviewer_id === id),
  ));
  const retained = prepared.plan.routes.find((route) => route.reviewer_id === 'codex-adversarial');
  const expandedRetained = synthesis.expanded_routing_plan.routes.find((route) => route.reviewer_id === 'codex-adversarial');
  assert.deepEqual(expandedRetained, retained);
  assert.doesNotThrow(() => parsePreparedReviewBinding(synthesis.expanded_routing_plan));
  const replacement = synthesis.expanded_routing_plan.routes.find((route) => route.reviewer_id === 'claude-opus');
  const replacementLaunch = {
    ...f.e.buildReviewerLaunch({ executionRoute: { protocol_version: '3.0', ...replacement }, evidenceInputs }),
    payload_provenance: 'native-argument',
  };
  const confirmation = '\n## Confirmation\n```json\n' + JSON.stringify({
    schema_version: 1, target_digest: target.target_digest,
    items: [{ finding_id: 'F-pending', status: 'verified_closed', evidence: [{ location: 'a.js:1', observation: 'Closed.' }] }],
  }) + '\n```\n';
  const rawClaude = {
    reviewer_id: 'claude-opus', role: 'claude-opus', output: report() + confirmation,
    beforeFingerprint: fingerprint, afterFingerprint: fingerprint,
    target_before: target, target_after: target, evidence_digest: prepared.plan.evidence_digest,
  };
  const wave2Launches = [launches.find((row) => row.reviewer_id === 'codex-adversarial'), replacementLaunch];
  const dispatch = f.e.buildDispatchEvidence({
    routingPlan: synthesis.expanded_routing_plan,
    attempts: [rawAdversarial, rawClaude],
    launches: wave2Launches,
    roundId: prepared.plan.round_id,
  });
  assert.equal(dispatch.records.length, 2);
  const finalized = await f.e.finalizeReviewDecision({
    repo: f.repo,
    input: {
      routing_plan: synthesis.expanded_routing_plan,
      evidence_inputs: evidenceInputs,
      attempts: [rawAdversarial, rawClaude],
      launches: wave2Launches,
      dispatch,
      adjudication: { schema_version: '1.0', groups: [] },
    },
  });
  assert.equal(finalized.decision.confirmation.complete, true);
});

test('unparsable citations do not throw response-items; complete identity still starts Respond', async t => {
  const f = await fixture(t);
  const broken = await f.decision({ bullet: '`src/a.js` line 12 — Return violates the contract.' });
  const stopped = await f.loop.decideRound({
    decisionFile: broken.decision_path, roundNumber: 1, roundLimit: 5,
    currentTargetFile: broken.targetFile, phase: 'before-respond',
  });
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.stop_reason, 'INDETERMINATE_OBSERVATIONS');
  const items = await f.e.prepareResponseItems({ repo: f.repo, decisionFile: broken.decision_path });
  assert.equal(items.confirmed_findings.length, 0);
  assert.equal(items.incomplete_findings.length, 1);
  const ready = await f.decision({ bullet: '`a.js:1` — Return violates the contract.' });
  const next = await f.loop.decideRound({
    decisionFile: ready.decision_path, roundNumber: 1, roundLimit: 5,
    currentTargetFile: ready.targetFile, phase: 'before-respond',
  });
  assert.equal(next.action, 'respond');
  const complete = await f.e.prepareResponseItems({ repo: f.repo, decisionFile: ready.decision_path });
  assert.equal(complete.confirmed_findings.length, 1);
  assert.equal(complete.incomplete_findings.length, 0);
});

test('verified respond with remaining budget reviews even if observations were incomplete', async t => {
  const { transitionRound } = await import('../hooks/scripts/lib/review-loop-decision.mjs');
  const f = await fixture(t, { git: true });
  const first = await f.capture();
  f.write('a.js', 'export const a = 2;\n');
  const second = await f.capture();
  const result = transitionRound({
    phase: 'after-respond', round: 1, limit: 5, artifactPhase: 'implementation',
    verdict: 'REQUEST_CHANGES', observations: { status: 'indeterminate', findings: [] },
    pending: [], reviewed: first.target, current: second.target,
    response: { status: 'verified' }, currentAuthority: false, actionableCount: 1,
  });
  assert.equal(result.action, 'review');
  assert.equal(result.completion_status, 'verification_pending');
});

test('bridge retry_attempts join executed-call accounting', async t => {
  const f = await fixture(t);
  const retry = { attempt_id: 'retry-1', invocation_id: 'inv-retry-1', status: 'failed' };
  const d = await f.decision({ retryAttempts: [retry] });
  const r = f.record(d);
  assert.equal(f.loop.readRoundState(r.state_file).accounting.executed_reviewer_calls, 2);
  const attached = f.e.attachBridgeObservation(d.input.launches[0], { retry_attempts: [retry] });
  assert.equal(attached.retry_attempts.length, 1);
  assert.equal(attached.retry_attempts[0].status, 'failed');
});

test('max=1 with a confirmed defect is review-only and never permits automatic Respond', async t => {
  const f = await fixture(t); const d = await f.decision({ bullet: '`a.js:1` — Return violates the contract.' });
  const before = fs.readFileSync(path.join(f.repo, 'a.js'));
  const result = await f.loop.decideRound({ decisionFile: d.decision_path, currentTargetFile: d.targetFile, roundNumber: 1, roundLimit: 1, phase: 'before-respond' });
  assert.equal(result.action, 'stop'); assert.equal(result.stop_reason, 'MAX_ROUNDS');
  assert.equal(result.completion_status, 'unresolved');
  assert.deepEqual(fs.readFileSync(path.join(f.repo, 'a.js')), before);
});

test('retired soft-floor calls count once with their original plan; duplicates cannot launder accounting', async t => {
  const f = await fixture(t); const d = await f.decision();
  const input = structuredClone(d.input);
  const route = input.routing_plan.routes[0];
  Object.assign(route, { reviewer_id: 'claude-opus', provider: 'claude', adapter_id: 'claude-native-agent' });
  input.routing_plan.initial_reviewer_ids = ['claude-opus'];
  input.routing_plan.required_reviewer_ids = ['claude-opus'];
  input.routing_plan.candidate_reviewers = [{ reviewer_id: 'claude-opus', provider: 'claude', adapter_id: 'claude-native-agent', assignment_roles: ['standard'], last_status: 'success' }];
  const launch = f.e.buildReviewerLaunch({ executionRoute: { protocol_version: '3.0', ...route }, evidenceInputs: input.evidence_inputs });
  launch.payload_provenance = 'native-argument';
  launch.result_file = f.write('.deep-review/tmp/retired-result.json', { launched: true, status: 'timeout', provenance: 'native-result', stderr: 'deadline observed' });
  input.launches = [launch];
  input.attempts = [{ ...input.attempts[0], reviewer_id: 'claude-opus', role: 'claude-opus', output: '' }];
  const receipt = f.e.recordReviewOperations({ repo: f.repo, input, reason: 'SOFT_FLOOR_REPLACED' });
  const files = f.write('.deep-review/tmp/retired-operations.json', [receipt.operations_file]);
  const r = f.record(d, { operationReceiptsFile: files });
  const state = f.loop.readRoundState(r.state_file);
  assert.equal(state.accounting.executed_reviewer_calls, 2); assert.equal(state.accounting.planned_reviewer_calls, 2);
  assert.equal(state.accounting.admitted_reviewer_calls, 1); assert.deepEqual(state.admitted_reviewers, ['codex-review']);
  fs.writeFileSync(files, JSON.stringify([receipt.operations_file, receipt.operations_file]));
  assert.throws(() => f.loop.readRoundState(r.state_file), /receipt list/);
});

test('initial and staged views flow through schema-3 recording and fresh completion checks', async t => {
  for (const view of ['initial', 'staged']) {
    const f = await fixture(t, { git: true, view }); const d = await f.decision(); const r = f.record(d, { roundLimit: 1 });
    assert.equal(f.loop.readRoundState(r.state_file).reviewed_target.scope.change_state, view);
    const result = await f.loop.decideRound({ stateFile: r.state_file, currentTargetFile: d.targetFile, roundLimit: 1, phase: 'after-respond' });
    assert.equal(result.completion_status, 'verified');
    if (view === 'initial') assert.equal(f.scope.review_base, null);
  }
});

test('only selected confirmation roles supply closure; ordinary full-scope roles keep their original contract', async t => {
  const f = await fixture(t); const id = 'prior-pending';
  const d = await f.decision({ request: [id], confirmation: [{ finding_id: id, status: 'verified_closed', evidence: [{ location: 'a.js:1', observation: 'Correct now.' }] }] });
  const input = structuredClone(d.input);
  const route = { ...input.routing_plan.routes[0], reviewer_id: 'codex-adversarial', assignment_role: 'adversarial', rubric_id: 'adversarial-v1', required: false };
  input.routing_plan.routes.push(route); input.routing_plan.planned_reviewers = 2; input.routing_plan.initial_reviewer_ids.push(route.reviewer_id);
  input.routing_plan.candidate_reviewers.push({ reviewer_id: route.reviewer_id, provider: 'codex', adapter_id: route.adapter_id, assignment_roles: ['adversarial'], last_status: 'success' });
  input.attempts.push({ ...input.attempts[0], reviewer_id: route.reviewer_id, role: route.reviewer_id, output: report() });
  const launch = f.e.buildReviewerLaunch({ executionRoute: { protocol_version: '3.0', ...route }, evidenceInputs: input.evidence_inputs });
  assert.doesNotMatch(launch.payload, /## Confirmation/);
  input.launches.push({ ...launch, payload_provenance: 'native-argument' });
  input.dispatch = f.e.buildDispatchEvidence({ routingPlan: input.routing_plan, attempts: input.attempts, launches: input.launches, roundId: input.routing_plan.round_id });
  const finalized = await f.e.finalizeReviewDecision({ repo: f.repo, input });
  assert.equal(finalized.decision.confirmation.complete, true);
  const originalConfirmation = input.attempts[0].output;
  input.attempts[1].output = originalConfirmation.replace('verified_closed', 'still_open');
  input.dispatch = f.e.buildDispatchEvidence({ routingPlan: input.routing_plan, attempts: input.attempts, launches: input.launches, roundId: input.routing_plan.round_id });
  const contradiction = await f.e.finalizeReviewDecision({ repo: f.repo, input });
  assert.equal(contradiction.decision.confirmation.complete, false);
  assert.equal(contradiction.decision.confirmation.items[0].status, 'indeterminate');
  input.attempts[1].output = input.attempts[0].output; input.attempts[0].output = report();
  input.dispatch = f.e.buildDispatchEvidence({ routingPlan: input.routing_plan, attempts: input.attempts, launches: input.launches, roundId: input.routing_plan.round_id });
  const forgedRole = await f.e.finalizeReviewDecision({ repo: f.repo, input });
  assert.equal(forgedRole.decision.confirmation.complete, false);
});

test('critical full-slate confirmation preserves all roles and provider floors through finalization', async t => {
  const f = await fixture(t); const d1 = await f.decision({ bullet: '`a.js:1` — Return violates the contract.' });
  const r1 = f.record(d1); const id = d1.decision.material_findings.findings[0].finding_id;
  f.write('a.js', 'export const a = 2;\n');
  const target = (await f.capture()).target;
  const plan = structuredClone(d1.input.routing_plan);
  plan.risk = 'critical'; plan.minimum_reviewers = 3; plan.planned_reviewers = 3; plan.maximum_reviewers = 3; plan.provider_family_minimum = 2;
  plan.routes = [['codex-review', 'codex', 'standard'], ['codex-adversarial', 'codex', 'adversarial'], ['claude-opus', 'claude', 'security']].map(([reviewer_id, provider, assignment_role]) => ({ ...plan.routes[0], reviewer_id, provider, assignment_role, rubric_id: assignment_role + '-v1', adapter_id: provider === 'claude' ? 'claude-native-agent' : 'codex-native-generic', risk: 'critical', required: true }));
  plan.initial_reviewer_ids = plan.routes.map(route => route.reviewer_id); plan.required_reviewer_ids = [...plan.initial_reviewer_ids];
  plan.candidate_reviewers = plan.routes.map(route => ({ reviewer_id: route.reviewer_id, provider: route.provider, adapter_id: route.adapter_id, assignment_roles: [route.assignment_role], last_status: 'success' }));
  const prepared = f.e.prepareReviewRound({ routingPlan: plan, target, evidenceInputs: d1.input.evidence_inputs, roundId: 'critical-round-2', confirmationRequest: { schema_version: 1, target_digest: target.target_digest, finding_ids: [id] } });
  assert.deepEqual(prepared.plan.confirmation_reviewer_ids, ['codex-review']);
  assert.deepEqual(prepared.plan.routes.map(route => route.assignment_role), ['standard', 'adversarial', 'security']);
  const launches = prepared.plan.routes.map(route => ({ ...f.e.buildReviewerLaunch({ executionRoute: { protocol_version: '3.0', ...route }, evidenceInputs: d1.input.evidence_inputs }), payload_provenance: 'native-argument' }));
  assert.match(launches[0].payload, /## Confirmation/); assert.doesNotMatch(launches[1].payload, /## Confirmation/);
  const attempts = prepared.plan.routes.map(route => ({ ...d1.input.attempts[0], reviewer_id: route.reviewer_id, role: route.reviewer_id, target_before: target, target_after: target, output: report() + (route.reviewer_id === 'codex-review' ? '\n## Confirmation\n```json\n' + JSON.stringify({ schema_version: 1, target_digest: target.target_digest, items: [{ finding_id: id, status: 'verified_closed', evidence: [{ location: 'a.js:1', observation: 'The new return satisfies the contract.' }] }] }) + '\n```\n' : '') }));
  const input = { routing_plan: prepared.plan, evidence_inputs: d1.input.evidence_inputs, attempts, launches, adjudication: { schema_version: '1.0', groups: [] }, dispatch: f.e.buildDispatchEvidence({ routingPlan: prepared.plan, attempts, launches, roundId: prepared.plan.round_id }) };
  const d2 = await f.e.finalizeReviewDecision({ repo: f.repo, input });
  const r2 = f.record({ ...d2, targetFile: (await f.capture()).file }, { roundNumber: 2, previousState: r1.state_file });
  assert.equal(f.loop.readRoundState(r2.state_file).pending_findings.length, 0);
  assert.equal((await f.loop.decideRound({ stateFile: r2.state_file, currentTargetFile: (await f.capture()).file, roundLimit: 5, phase: 'after-respond' })).completion_status, 'verified');
});

test('recomputed clean and expanded scopes carry pending closure through classifier and prepared CLI flow', async t => {
  for (const expanded of [false, true]) await t.test(expanded ? 'expanded scope' : 'unstaged to clean', async t => {
    const f = await fixture(t, { git: true });
    const d1 = await f.decision({ bullet: '`a.js:1` — Return violates the contract.' });
    const p = await import('../hooks/scripts/phase6-protocol.mjs');
    let group;
    if (!expanded) group = await runGroup(f, 'warning', 'export const a = 2;\n');
    else {
      const snapshot = p.snapshotPhase6({ repo: f.repo, severity: 'warning', targetScope: f.scope,
        acceptedItems: [{ item_id: 'ITEM-1', target_location: 'a.js', modifiable_paths: ['b.js'] }] });
      f.write('a.js', 'export const a = 2;\n'); f.write('b.js', 'export const b = 3;\n');
      await p.runLoggedTest({ repo: f.repo, itemId: 'ITEM-1', command: process.execPath,
        args: ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('b.js','utf8'),'export const b = 3;\\n')"], logPath: snapshot.log_path });
      const text = '## Group Result\n- execution_status: completed\n- items_total: 1\n- items_passed: 1\n- items_failed: 0\n- items_skipped: 0\n\n## Items\n### ITEM-1\n- status: passed\n- files_changed:\n  - "a.js"\n  - "b.js"\n- test_command: node fixture\n- test_exit_code: 0\n- log_range: ITEM-1\n- action_summary: applied\n';
      const verified = p.verifyPhase6({ repo: f.repo, snapshotPath: snapshot.snapshot_path, groupResult: text });
      const committed = p.commitPhase6({ repo: f.repo, snapshotPath: snapshot.snapshot_path, severity: 'warning' });
      group = { snapshot_file: snapshot.snapshot_path, group_result_file: f.write('.deep-review/tmp/expanded-group.md', text),
        verification_result_file: f.write('.deep-review/tmp/expanded-verify.json', verified), commit_result_file: f.write('.deep-review/tmp/expanded-commit.json', committed) };
    }
    const targetApi = await import('../hooks/scripts/lib/review-target-snapshot.mjs');
    const filesFromZ = Buffer.from(expanded ? 'a.js\0b.js\0' : 'a.js\0');
    const records = (await import('../hooks/scripts/lib/review-target.mjs')).buildChangeFiles({ repo: f.repo, changeState: 'clean', reviewBase: f.scope.review_base, filesFromZ, includeBinary: true });
    const scope = await targetApi.createTargetScope({ repo: f.repo, changeState: 'clean', reviewBase: f.scope.review_base, records });
    const target = await targetApi.captureReviewTarget({ scope });
    const targetFile = f.write('.deep-review/tmp/recomputed-target.json', target);
    const proof = await f.loop.buildResponseEvidence({ repo: f.repo, decisionFile: d1.decision_path, postResponseTargetFile: targetFile, groups: [group], status: 'completed', halted: false });
    assert.equal(proof.response.status, 'verified');
    const r1 = f.record(d1, { responseEvidenceFile: proof.evidence_file, postResponseTargetFile: targetFile });
    const cli = (script, args) => JSON.parse(execFileSync(process.execPath, [path.join(root, 'hooks/scripts', script), ...args], { encoding: 'utf8' }));
    const context = cli('loop-state.mjs', ['adaptive-context', '--state-file', r1.state_file, '--current-target-file', targetFile]);
    assert.equal(context.ok, true);
    delete context.ok; // Strip only the loop CLI transport envelope for the strict carrier.
    const { runClassifyArtifactsCli } = await import('../hooks/scripts/classify-artifacts.mjs');
    const runtime = { capabilities: ['claude', 'codex'].map(provider => ({ protocol_version: '2.0', adapter_id: provider === 'claude' ? 'claude-native-agent' : 'codex-native-generic', provider, available: true,
      roles: ['standard', 'adversarial'], assignment_roles: ['standard', 'adversarial', 'security', 'confirmation'], model_selection: { supported: false, aliases: [] }, effort_selection: { supported: false, levels: [] }, read_only_enforcement: 'instruction-only' })) };
    const targetList = f.write('.deep-review/tmp/recomputed-targets.z', filesFromZ.toString());
    const classified = await runClassifyArtifactsCli(['--repo', f.repo, '--change-state', 'clean', '--review-base', f.scope.review_base,
      '--files-from0', targetList, '--adaptive-context-json', JSON.stringify(context)], {}, runtime);
    const pendingId = d1.decision.material_findings.findings[0].finding_id;
    assert.ok(classified.routing_plan.routes.length >= 2, 'changed scopes keep the full slate');
    assert.notEqual(classified.routing_plan.progress, 'confirmation');
    assert.deepEqual(classified.routing_plan.pending_confirmation?.finding_ids, [pendingId]);
    const evidenceInputs = { ...d1.input.evidence_inputs, changeFiles: records.map(row => row.path).join('\n'), priorRounds: f.loop.readRoundState(r1.state_file).pending_findings.map(row => row.claim).join('\n') };
    const prepared = cli('review-evidence.mjs', ['prepare', '--repo', f.repo, '--input', f.write('.deep-review/tmp/recomputed-prepare.json', { routingPlan: classified.routing_plan, target, evidenceInputs, roundId: 'recomputed-round-2' })]);
    assert.deepEqual(prepared.plan.confirmation_request.finding_ids, [pendingId]);
    assert.ok(prepared.plan.confirmation_reviewer_ids.length > 0);
    const launches = prepared.plan.routes.map(route => ({ ...cli('review-evidence.mjs', ['build-launch', '--repo', f.repo, '--input', f.write(`.deep-review/tmp/${route.reviewer_id}-launch-input.json`, { executionRoute: { protocol_version: '3.0', ...route }, evidenceInputs })]), payload_provenance: 'native-argument' }));
    const attempts = prepared.plan.routes.map(route => {
      const designated = prepared.plan.confirmation_reviewer_ids.includes(route.reviewer_id);
      const confirmation = '\n## Confirmation\n```json\n' + JSON.stringify({ schema_version: 1, target_digest: target.target_digest, items: [{ finding_id: pendingId, status: 'verified_closed', evidence: [{ location: 'a.js:1', observation: 'The committed return meets the contract.' }] }] }) + '\n```\n';
      return { ...d1.input.attempts[0], reviewer_id: route.reviewer_id, role: route.reviewer_id, output: report() + (designated ? confirmation : ''), target_before: target, target_after: target, evidence_digest: prepared.plan.evidence_digest };
    });
    const input = { routing_plan: prepared.plan, evidence_inputs: evidenceInputs, attempts, launches, adjudication: { schema_version: '1.0', groups: [] } };
    input.dispatch = cli('review-evidence.mjs', ['build-dispatch', '--repo', f.repo, '--input', f.write('.deep-review/tmp/recomputed-dispatch.json', { routingPlan: prepared.plan, attempts, launches, roundId: prepared.plan.round_id })]);
    const d2 = cli('review-evidence.mjs', ['finalize', '--repo', f.repo, '--input', f.write('.deep-review/tmp/recomputed-finalize.json', input)]);
    assert.equal(d2.decision.confirmation.complete, true);
    const r2 = cli('loop-state.mjs', ['record-round', '--repo-root', f.repo, '--state-dir', path.join(f.repo, '.deep-review/tmp'), '--round-number', '2', '--round-limit', '5', '--base-commit', f.scope.review_base,
      '--decision-file', d2.decision_path, '--previous-state', r1.state_file, '--post-response-target-file', targetFile]);
    const completed = cli('loop-state.mjs', ['decide-round', '--state-file', r2.state_file, '--round-limit', '5', '--current-target-file', targetFile, '--phase', 'after-respond']);
    assert.equal(completed.completion_status, 'verified');
    assert.equal(f.loop.readRoundState(r2.state_file).pending_findings.length, 0);
  });
});

test('unresolved-only implementation decisions stop before an empty Respond', async t => {
  const f = await fixture(t);
  const d = await f.decision({ bullet: '`a.js:1` — Return may violate the contract.', disposition: 'unresolved' });
  const items = await f.e.prepareResponseItems({ repo: f.repo, decisionFile: d.decision_path });
  assert.deepEqual(items.confirmed_findings, []);
  const result = JSON.parse(execFileSync(process.execPath, [path.join(root, 'hooks/scripts/loop-state.mjs'), 'decide-round', '--decision-file', d.decision_path,
    '--round-number', '1', '--round-limit', '5', '--current-target-file', d.targetFile, '--phase', 'before-respond'], { encoding: 'utf8' }));
  assert.equal(result.action, 'stop'); assert.equal(result.stop_reason, 'UNRESOLVED_WORK');
  assert.equal(result.completion_status, 'unresolved');
  const decisionApi = await import('../hooks/scripts/lib/review-loop-decision.mjs');
  const document = decisionApi.transitionRound({ phase: 'before-respond', round: 1, limit: 2, artifactPhase: 'document', readiness: { status: 'DOCUMENT_BLOCKED' },
    verdict: 'REQUEST_CHANGES', observations: d.decision.material_findings, pending: d.decision.pending_findings, reviewed: d.target, current: d.target, currentAuthority: true, actionableCount: 0 });
  assert.equal(document.action, 'respond');
  const unresolvedCritical = decisionApi.transitionRound({ phase: 'before-respond', round: 1, limit: 2, artifactPhase: 'implementation', readiness: null,
    verdict: 'REQUEST_CHANGES', observations: d.decision.material_findings, pending: d.decision.pending_findings, reviewed: d.target, current: d.target, currentAuthority: true, actionableCount: 0 });
  assert.equal(unresolvedCritical.action, 'stop');
  assert.equal(unresolvedCritical.stop_reason, 'UNRESOLVED_WORK');
});

test('prepared file builder, launch and verifier share the physical plugin root across aliases', async t => {
  const f = await fixture(t); const d = await f.decision();
  const builder = await import('../hooks/scripts/build-reviewer-payload.mjs');
  const alias = path.join(f.repo, 'plugin-alias'); fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const executionRoute = d.input.launches[0].execution_route;
  const built = JSON.parse(execFileSync(process.execPath, [path.join(root, 'hooks/scripts/build-reviewer-payload.mjs'), '--plugin-root', alias, '--repo', f.repo,
    '--execution-route-json', JSON.stringify(executionRoute), '--reviewer-id', executionRoute.reviewer_id, '--evidence-inputs-file', f.write('.deep-review/tmp/alias-inputs.json', d.input.evidence_inputs)], { encoding: 'utf8' }));
  t.after(() => fs.rmSync(built.promptFile, { force: true }));
  const payload = fs.readFileSync(built.promptFile, 'utf8');
  assert.equal(payload, f.e.buildReviewerLaunch({ executionRoute, evidenceInputs: d.input.evidence_inputs }).payload);
  assert.equal(builder.verifyPreparedReviewerPayload(payload, executionRoute).payload_sha256, built.payload_sha256);
  const wrongRoot = path.join(f.repo, 'different-plugin');
  fs.mkdirSync(path.join(wrongRoot, 'skills/deep-review-workflow/references'), { recursive: true });
  fs.copyFileSync(path.join(root, 'skills/deep-review-workflow/references/review-criteria.md'), path.join(wrongRoot, 'skills/deep-review-workflow/references/review-criteria.md'));
  assert.throws(() => builder.buildPreparedReviewerPayload({ executionRoute, evidenceInputs: d.input.evidence_inputs, pluginRoot: wrongRoot }), /plugin root/);
});
