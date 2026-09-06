const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function plan() {
  const route = {
    reviewer_id: 'codex-review',
    provider: 'codex',
    adapter_id: 'codex-native-generic',
    assignment_role: 'standard',
    rubric_id: 'standard-v1',
    wave: 1,
    required: true,
    selection_reason: 'selected',
    resolved: { model: null, effort: 'high' },
    artifact_phase: 'implementation',
    risk: 'low',
    document_review_mode: 'full-readiness',
  };
  return {
    protocol_version: '3.0',
    artifact_phase: 'implementation',
    risk: 'low',
    document_review_mode: 'full-readiness',
    reviewer_strategy: 'adaptive',
    shadow_mode: false,
    progress: 'initial',
    minimum_reviewers: 1,
    planned_reviewers: 1,
    provider_family_minimum: 1,
    maximum_reviewers: 2,
    max_expansion_waves: 0,
    initial_reviewer_ids: ['codex-review'],
    required_reviewer_ids: ['codex-review'],
    candidate_reviewers: [
      {
        reviewer_id: 'codex-review',
        provider: 'codex',
        adapter_id: 'codex-native-generic',
        assignment_roles: ['standard'],
        last_status: 'success',
      },
    ],
    routes: [route],
  };
}
const cleanReport = `# Deep Review Report — 2026-09-06\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n\n## Code Review\n\n### 🔴 Critical\nNone.\n### 🟡 Warning\nNone.\n### ℹ️ Info\nNone.\n### 🟢 Passed\n- The selected change is covered.\n`;
async function fixture(t) {
  const e = await import('../hooks/scripts/review-evidence.mjs');
  const { buildPreparedReviewerPayload } =
    await import('../hooks/scripts/build-reviewer-payload.mjs');
  const targets = await import('../hooks/scripts/lib/review-target-snapshot.mjs');
  const s = await import('../hooks/scripts/review-synthesis.mjs');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'a.js'), 'const a = 1;\n');
  const scope = await targets.createTargetScope({
    repo,
    changeState: 'non-git',
    records: [{ path: 'a.js', status: 'non-git' }],
  });
  const target = await targets.captureReviewTarget({ scope });
  const evidenceInputs = {
    context: 'contract',
    diff: 'diff',
    changeFiles: 'a.js',
    priorRounds: '',
    readinessReceipt: '',
  };
  const prepared = e.prepareReviewRound({
    routingPlan: plan(),
    target,
    evidenceInputs,
    roundId: 'round-1',
  });
  const raw = {
    reviewer_id: 'codex-review',
    role: 'codex-review',
    output: cleanReport,
    beforeFingerprint: { mode: 'git', digest: 'a' },
    afterFingerprint: { mode: 'git', digest: 'a' },
    target_before: target,
    target_after: target,
    evidence_digest: prepared.plan.evidence_digest,
  };
  const launches = [
    {
      reviewer_id: 'codex-review',
      attempt_id: 'attempt-1',
      invocation_id: 'invocation-1',
      execution_route: { protocol_version: '3.0', ...prepared.plan.routes[0] },
    },
  ];
  for (const launch of launches)
    Object.assign(launch, {
      payload: buildPreparedReviewerPayload({
        executionRoute: launch.execution_route,
        evidenceInputs,
      }),
      payload_provenance: 'native-argument',
    });
  const dispatch = e.buildDispatchEvidence({
    routingPlan: prepared.plan,
    attempts: [raw],
    launches,
    roundId: 'round-1',
  });
  const input = {
    routing_plan: prepared.plan,
    evidence_inputs: evidenceInputs,
    attempts: [raw],
    launches,
    dispatch,
    adjudication: { schema_version: '1.0', groups: [] },
  };
  return {
    ...e,
    ...targets,
    ...s,
    buildPreparedReviewerPayload,
    repo,
    target,
    evidenceInputs,
    prepared,
    raw,
    launches,
    input,
  };
}
test('prepare binds source, scope and routes; mixed target, missing evidence and both authorities fail closed', async (t) => {
  const f = await fixture(t);
  assert.equal(f.prepared.plan.decision_mode, 'adjudication-v1');
  assert.equal(f.prepared.plan.routes[0].evidence_digest, f.prepared.plan.evidence_digest);
  const request = {
    attempts: [f.evaluateReviewerAttempt(f.raw)],
    routingPlan: f.prepared.plan,
    adjudication: f.input.adjudication,
    dispatch: f.input.dispatch,
  };
  assert.equal(f.synthesizeReviewRound(request).verdict, 'APPROVE');
  for (const mutation of [
    (r) => delete r.adjudication,
    (r) => (r.consensus = { findings: [] }),
    (r) => (r.routingPlan = { ...r.routingPlan, decision_mode: 'artifact-gate-v1' }),
    (r) =>
      (r.attempts = [f.evaluateReviewerAttempt({ ...f.raw, evidence_digest: 'a'.repeat(64) })]),
    (r) =>
      (r.attempts = [
        f.evaluateReviewerAttempt({
          ...f.raw,
          target_after: { ...f.target, target_digest: 'a'.repeat(64) },
        }),
      ]),
  ]) {
    const r = { ...request };
    mutation(r);
    assert.equal(f.synthesizeReviewRound(r).status, 'operational_failure');
  }
});
test('finalize/verify binds raw input and canonical report; drift and tampering fail', async (t) => {
  const f = await fixture(t);
  const result = await f.finalizeReviewDecision({
    repo: f.repo,
    input: f.input,
    reportDir: '.deep-review/reports',
    date: '2026-09-06',
  });
  assert.equal(result.decision.verdict, 'APPROVE');
  assert.equal(
    (await f.verifyReviewDecision({ decisionFile: result.decision_path, repo: f.repo })).verdict,
    'APPROVE',
  );
  assert.equal(
    fs
      .readdirSync(path.join(f.repo, '.deep-review/reports'))
      .filter((p) => p.endsWith('-review.md')).length,
    1,
  );
  fs.appendFileSync(result.report_path, '\n- forged finding');
  await assert.rejects(
    f.verifyReviewDecision({ decisionFile: result.decision_path, repo: f.repo }),
  );
  fs.writeFileSync(path.join(f.repo, 'a.js'), 'edited');
  await assert.rejects(
    f.finalizeReviewDecision({
      repo: f.repo,
      input: f.input,
      reportDir: '.deep-review/reports',
      date: '2026-09-06',
    }),
  );
});
test('prepared payload builder verifies evidence input digest and injects exact trusted scope', async (t) => {
  const f = await fixture(t);
  const { buildReviewerPayload } = await import('../hooks/scripts/build-reviewer-payload.mjs');
  const file = path.join(f.repo, 'inputs.json');
  fs.writeFileSync(file, JSON.stringify(f.evidenceInputs));
  const opts = {
    pluginRoot: root,
    repo: f.repo,
    reviewerId: 'codex-review',
    executionRouteJson: JSON.stringify({ protocol_version: '3.0', ...f.prepared.plan.routes[0] }),
    evidenceInputsFile: file,
  };
  const built = buildReviewerPayload(opts);
  t.after(() => fs.rmSync(built.promptFile, { force: true }));
  const payload = fs.readFileSync(built.promptFile, 'utf8');
  assert.match(payload, /TRUSTED REVIEW TARGET/);
  assert.match(payload, /a.js/);
  fs.writeFileSync(file, JSON.stringify({ ...f.evidenceInputs, diff: 'tampered' }));
  assert.throws(() => buildReviewerPayload(opts));
});
test('CLI synthesis forwards dispatch and adjudication; evidence CLI prepare/finalize/verify round trip', async (t) => {
  const f = await fixture(t);
  const inputFile = path.join(f.repo, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify(f.input));
  const run = (file, ...args) =>
    JSON.parse(
      execFileSync(process.execPath, [path.join(root, 'hooks/scripts', file), ...args], {
        encoding: 'utf8',
      }),
    );
  assert.equal(run('review-synthesis.mjs', '--prepared-input', inputFile).verdict, 'APPROVE');
  const result = run(
    'review-evidence.mjs',
    'finalize',
    '--repo',
    f.repo,
    '--input',
    inputFile,
    '--report-dir',
    '.deep-review/reports',
    '--date',
    '2026-09-06',
  );
  assert.equal(
    run('review-evidence.mjs', 'verify', '--repo', f.repo, '--decision', result.decision_path)
      .verdict,
    'APPROVE',
  );
});
test('zero-material coverage/deferred floors publish without inventing findings', async (t) => {
  const f = await fixture(t);
  f.input.deferred_acceptance = {
    complete: false,
    pending_finding_refs: [{ reviewer_id: 'codex-review', finding_id: 'DOC-1' }],
  };
  const result = await f.finalizeReviewDecision({ repo: f.repo, input: f.input });
  assert.equal(result.decision.verdict, 'CONCERN');
  assert.equal(result.decision.counts.warning, 0);
  assert.equal(result.decision.material_findings.expected_count, 0);
  assert.match(fs.readFileSync(result.report_path, 'utf8'), /deferred_acceptance_floor/);
  assert.equal(
    (await f.verifyReviewDecision({ repo: f.repo, decisionFile: result.decision_path })).verdict,
    'CONCERN',
  );
});
test('source input, decision seal, dispatch route and output swaps are rejected', async (t) => {
  const f = await fixture(t);
  const result = await f.finalizeReviewDecision({ repo: f.repo, input: f.input });
  const bytes = fs.readFileSync(result.decision_path);
  const decision = JSON.parse(bytes);
  decision.verdict = 'REQUEST_CHANGES';
  fs.writeFileSync(result.decision_path, JSON.stringify(decision));
  await assert.rejects(
    f.verifyReviewDecision({ repo: f.repo, decisionFile: result.decision_path }),
  );
  fs.writeFileSync(result.decision_path, bytes);
  fs.appendFileSync(result.decision.source_input_path, ' ');
  await assert.rejects(
    f.verifyReviewDecision({ repo: f.repo, decisionFile: result.decision_path }),
  );
  for (const mutate of [
    (i) => (i.dispatch.records[0].output_sha256 = 'a'.repeat(64)),
    (i) => (i.dispatch.records[0].execution_route.resolved.effort = 'low'),
    (i) => (i.evidence_inputs.diff = 'swapped'),
  ]) {
    const input = structuredClone(f.input);
    mutate(input);
    await assert.rejects(f.finalizeReviewDecision({ repo: f.repo, input }));
  }
  fs.unlinkSync(result.decision_path);
  await assert.rejects(
    f.verifyReviewDecision({ repo: f.repo, decisionFile: result.decision_path }),
  );
});
test('document READY with deferred evidence uses unchanged receipt 2.0 and raw gate authority', async (t) => {
  const f = await fixture(t);
  const readiness = await import('../hooks/scripts/document-readiness.mjs');
  fs.writeFileSync(path.join(f.repo, 'plan.md'), '# Plan\n');
  const scope = await f.createTargetScope({
    repo: f.repo,
    changeState: 'non-git',
    records: [{ path: 'plan.md', status: 'non-git' }],
  });
  const target = await f.captureReviewTarget({ scope });
  const documentPlan = plan();
  documentPlan.artifact_phase = 'document';
  documentPlan.routes[0].artifact_phase = 'document';
  const prepared = f.prepareReviewRound({
    routingPlan: documentPlan,
    target,
    evidenceInputs: f.evidenceInputs,
    roundId: 'doc-round',
  });
  const output =
    cleanReport
      .replace('- **Verdict**: APPROVE', '- **Verdict**: CONCERN')
      .replace('🟡 0건', '🟡 1건')
      .replace(
        '### 🟡 Warning\nNone.',
        '### 🟡 Warning\n- `plan.md:1` Verify rollback after implementation.',
      ) +
    '\n## Artifact Gate\n```json\n' +
    JSON.stringify({
      schema_version: 1,
      findings: [
        {
          id: 'DOC-1',
          severity: 'warning',
          stage: 'implementation_verification',
          acceptance_evidence: ['The rollback integration test passes.'],
        },
      ],
    }) +
    '\n```\n';
  const raw = {
    ...f.raw,
    output,
    target_before: target,
    target_after: target,
    evidence_digest: prepared.plan.evidence_digest,
  };
  const launches = [
    {
      reviewer_id: 'codex-review',
      attempt_id: 'doc-attempt',
      invocation_id: 'doc-invocation',
      execution_route: { protocol_version: '3.0', ...prepared.plan.routes[0] },
      payload_provenance: 'native-argument',
    },
  ];
  launches[0].payload = f.buildPreparedReviewerPayload({
    executionRoute: launches[0].execution_route,
    evidenceInputs: f.evidenceInputs,
  });
  const dispatch = f.buildDispatchEvidence({
    routingPlan: prepared.plan,
    attempts: [raw],
    launches,
    roundId: 'doc-round',
  });
  const synthesis = f.synthesizeReviewRound({
    attempts: [f.evaluateReviewerAttempt(raw)],
    routingPlan: prepared.plan,
    dispatch,
  });
  assert.equal(synthesis.status, 'reviewed');
  const rawPath = '.deep-review/tmp/reviewer-reports/doc-reviewer.md';
  fs.mkdirSync(path.dirname(path.join(f.repo, rawPath)), { recursive: true });
  fs.writeFileSync(path.join(f.repo, rawPath), output);
  const created = readiness.createDocumentReadinessReceipt({
    repo: target.scope.repo_root,
    risk: 'low',
    artifacts: [{ path: 'plan.md', target_kind: 'implementation-plan' }],
    reports: [
      {
        path: rawPath,
        reviewer_id: 'codex-review',
        provider_family: 'codex',
        attempt_id: 'doc-attempt',
      },
    ],
    readinessAdmission: synthesis.readiness_admission,
  });
  assert.equal(created.status, 'READY_FOR_IMPLEMENTATION');
  const input = {
    routing_plan: prepared.plan,
    evidence_inputs: f.evidenceInputs,
    attempts: [{ ...raw, output_file: rawPath }],
    launches,
    dispatch,
    readiness_receipt: created.receipt_path,
  };
  const result = await f.finalizeReviewDecision({ repo: f.repo, input });
  assert.equal(result.decision.verdict, 'CONCERN');
  assert.equal(result.decision.readiness.status, 'READY_FOR_IMPLEMENTATION');
  assert.equal(JSON.parse(fs.readFileSync(created.receipt_path)).schema_version, '2.0');
  assert.equal(
    (await f.verifyReviewDecision({ repo: f.repo, decisionFile: result.decision_path })).readiness
      .deferred_findings.length,
    1,
  );
  await assert.rejects(
    f.finalizeReviewDecision({
      repo: f.repo,
      input: { ...input, adjudication: { schema_version: '1.0', groups: [] } },
    }),
  );
  fs.writeFileSync(path.join(f.repo, 'plan.md'), '# Plan after authorized Respond\n');
  await assert.rejects(
    f.verifyReviewDecision({ repo: f.repo, decisionFile: result.decision_path }),
  );
  const history = await f.verifyReviewDecisionHistory({
    repo: f.repo,
    decisionFile: result.decision_path,
  });
  assert.equal(history.status, 'history_only');
  assert.equal(history.phase6_allowed, false);
  assert.equal(history.recorded_verdict, 'CONCERN');
  assert.equal(Object.hasOwn(history, 'readiness'), false);
  assert.equal(Object.hasOwn(history, 'verdict'), false);
  fs.appendFileSync(result.report_path, 'tampered');
  await assert.rejects(
    f.verifyReviewDecisionHistory({ repo: f.repo, decisionFile: result.decision_path }),
  );
});
test('unanimous raw warnings can be refuted without expansion; expanded adjudication must cover all sources', async (t) => {
  const f = await fixture(t);
  const { extractSourceFindings } = await import('../hooks/scripts/lib/review-adjudication.mjs');
  const base = plan();
  base.maximum_reviewers = 3;
  base.max_expansion_waves = 1;
  base.required_reviewer_ids = [];
  base.routes[0].required = false;
  const second = {
    ...base.routes[0],
    reviewer_id: 'claude-opus',
    provider: 'claude',
    adapter_id: 'claude-cli',
  };
  base.routes.push(second);
  base.initial_reviewer_ids.push(second.reviewer_id);
  base.candidate_reviewers.push({
    reviewer_id: second.reviewer_id,
    provider: 'claude',
    adapter_id: 'claude-cli',
    assignment_roles: ['standard'],
    last_status: 'success',
  });
  base.minimum_reviewers = 2;
  base.planned_reviewers = 2;
  base.provider_family_minimum = 2;
  const prepared = f.prepareReviewRound({
    routingPlan: base,
    target: f.target,
    evidenceInputs: f.evidenceInputs,
    roundId: 'both',
  });
  const output = cleanReport
    .replace('Verdict**: APPROVE', 'Verdict**: CONCERN')
    .replace('🟡 0건', '🟡 1건')
    .replace('### 🟡 Warning\nNone.', '### 🟡 Warning\n- `a.js:1` write errors lack tests.');
  const raws = prepared.plan.routes.map((route) => ({
    ...f.raw,
    reviewer_id: route.reviewer_id,
    role: route.reviewer_id,
    output,
    evidence_digest: prepared.plan.evidence_digest,
  }));
  const launches = prepared.plan.routes.map((route, i) => ({
    reviewer_id: route.reviewer_id,
    attempt_id: `a-${i}`,
    invocation_id: `i-${i}`,
    execution_route: { protocol_version: '3.0', ...route },
  }));
  for (const launch of launches)
    Object.assign(launch, {
      payload: f.buildPreparedReviewerPayload({
        executionRoute: launch.execution_route,
        evidenceInputs: f.evidenceInputs,
      }),
      payload_provenance: 'native-argument',
    });
  const dispatch = f.buildDispatchEvidence({
    routingPlan: prepared.plan,
    attempts: raws,
    launches,
    roundId: 'both',
  });
  const refs = raws.flatMap((raw) =>
    extractSourceFindings(raw.output, raw.reviewer_id).map(({ bullet, ...ref }) => ref),
  );
  const group = {
    source_refs: refs,
    disposition: 'refuted',
    severity: 'warning',
    category: 'test-coverage',
    rationale: 'The test already checks rejected writes.',
    evidence: [
      {
        location: 'tests/write.test.js:14',
        observation: 'The error assertion covers the named path.',
      },
    ],
  };
  const request = {
    routingPlan: prepared.plan,
    attempts: raws.map(f.evaluateReviewerAttempt),
    dispatch,
    adjudication: { schema_version: '1.0', groups: [group] },
  };
  assert.equal(f.synthesizeReviewRound(request).verdict, 'APPROVE');
  assert.equal(f.synthesizeReviewRound(request).needs_expansion, false);
  for (const [disposition, category, expected] of [
    ['advisory', 'test-coverage', 'APPROVE'],
    ['confirmed_blocker', 'test-coverage', 'REQUEST_CHANGES'],
    ['unresolved', 'test-coverage', 'CONCERN'],
    ['unresolved', 'security', 'REQUEST_CHANGES'],
  ]) {
    const result = f.synthesizeReviewRound({
      ...request,
      adjudication: {
        schema_version: '1.0',
        groups: [
          {
            ...group,
            disposition,
            category,
            missing_evidence: 'A real failing write is unavailable.',
          },
        ],
      },
    });
    assert.equal(result.verdict, expected);
    assert.equal(result.needs_expansion, false);
  }
  const expanded = structuredClone(prepared.plan);
  expanded.routes[1].wave = 2;
  expanded.routes[1].required = true;
  expanded.initial_reviewer_ids = ['codex-review'];
  const expandedLaunches = expanded.routes.map((route, i) => ({
    ...launches[i],
    execution_route: { protocol_version: '3.0', ...route },
  }));
  for (const launch of expandedLaunches)
    launch.payload = f.buildPreparedReviewerPayload({
      executionRoute: launch.execution_route,
      evidenceInputs: f.evidenceInputs,
    });
  const expandedDispatch = f.buildDispatchEvidence({
    routingPlan: expanded,
    attempts: raws,
    launches: expandedLaunches,
    roundId: 'both',
  });
  assert.equal(
    f.synthesizeReviewRound({
      ...request,
      routingPlan: expanded,
      dispatch: expandedDispatch,
      expansionWavesUsed: 1,
      adjudication: { schema_version: '1.0', groups: [{ ...group, source_refs: [refs[0]] }] },
    }).error,
    'invalid_adjudication',
  );
  const mixed = raws.map((raw) => structuredClone(raw));
  mixed[1].target_before.target_digest = 'f'.repeat(64);
  assert.equal(
    f.synthesizeReviewRound({ ...request, attempts: mixed.map(f.evaluateReviewerAttempt) }).error,
    'review_target_mismatch',
  );
});
test('CLI capture, prepare and build-dispatch compute joins and reject tampered dispatch', async (t) => {
  const f = await fixture(t);
  const run = (command, input, extra = []) => {
    const file = path.join(f.repo, command + '.json');
    fs.writeFileSync(file, JSON.stringify(input));
    return JSON.parse(
      execFileSync(
        process.execPath,
        [
          path.join(root, 'hooks/scripts/review-evidence.mjs'),
          command,
          '--repo',
          f.repo,
          '--input',
          file,
          ...extra,
        ],
        { encoding: 'utf8' },
      ),
    );
  };
  const target = run('capture', {
    repo: f.repo,
    changeState: 'non-git',
    records: [{ path: 'a.js', status: 'non-git' }],
  });
  assert.equal(target.target_digest, f.target.target_digest);
  const evidenceFile = path.join(f.repo, 'evidence.json');
  fs.writeFileSync(evidenceFile, JSON.stringify(f.evidenceInputs));
  const prepared = run('prepare', { routingPlan: plan(), target, roundId: 'round-1' }, [
    '--evidence-inputs-file',
    evidenceFile,
  ]);
  assert.deepEqual(prepared, f.prepared);
  const dispatch = run('build-dispatch', {
    routingPlan: prepared.plan,
    attempts: [f.raw],
    launches: f.launches,
    roundId: 'round-1',
  });
  assert.deepEqual(dispatch, f.input.dispatch);
  const bad = { ...f.input, dispatch: structuredClone(dispatch) };
  bad.dispatch.records[0].session_id = '';
  const file = path.join(f.repo, 'bad-input.json');
  fs.writeFileSync(file, JSON.stringify(bad));
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(root, 'hooks/scripts/review-synthesis.mjs'), '--prepared-input', file],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(result.error, 'invalid_readiness_admission');
});
test('bridge observes the payload it actually reads and rejects a swapped file before spawn', async (t) => {
  const f = await fixture(t);
  const { runClaudeReviewer } = await import('../hooks/scripts/run-claude-reviewer.mjs');
  const { parseExecutionRoute } = await import('../hooks/scripts/lib/execution-plan.mjs');
  const payload = f.buildPreparedReviewerPayload({
    executionRoute: f.launches[0].execution_route,
    evidenceInputs: f.evidenceInputs,
  });
  const promptFile = path.join(f.repo, 'prompt.md');
  fs.writeFileSync(promptFile, payload);
  const route = {
    ...f.launches[0].execution_route,
    reviewer_id: 'claude-opus',
    provider: 'claude',
    adapter_id: 'claude-cli',
  };
  const executionPlan = parseExecutionRoute(route, 'claude-opus');
  let spawned = 0;
  const options = {
    projectRoot: f.repo,
    pluginRoot: root,
    promptFile,
    outputFile: path.join(f.repo, 'out.md'),
    executionPlan,
    expectedPayloadSha256: f.evidenceHash(payload),
    processRunner: async (binary, args, opts) => {
      spawned++;
      assert.equal(opts.input.toString(), payload);
      return {
        code: 0,
        timedOut: false,
        stdout: Buffer.from(cleanReport),
        stderr: Buffer.alloc(0),
      };
    },
  };
  const result = await runClaudeReviewer(options);
  assert.equal(result.route_payload_sha256, f.evidenceHash(payload));
  assert.equal(result.route_payload_bytes, Buffer.byteLength(payload));
  fs.appendFileSync(promptFile, 'swapped');
  await assert.rejects(runClaudeReviewer(options));
  assert.equal(spawned, 1);
});
test('prepared dispatch refuses missing or swapped captured payload and fake bridge observation', async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (l) => delete l.payload,
    (l) =>
      (l.payload = l.payload.replace(
        'DIFF UNDER REVIEW =====\ndiff',
        'DIFF UNDER REVIEW =====\nswapped',
      )),
    (l) => {
      l.payload_provenance = 'bridge-read';
      l.bridge_observation = { route_payload_sha256: 'a'.repeat(64), route_payload_bytes: 1 };
    },
  ]) {
    const launches = structuredClone(f.launches);
    mutate(launches[0]);
    assert.throws(() =>
      f.buildDispatchEvidence({
        routingPlan: f.prepared.plan,
        attempts: [f.raw],
        launches,
        roundId: 'round-1',
      }),
    );
  }
});

test('220 KiB common diff across four reviewers stays file-backed under control limits', async (t) => {
  const f = await fixture(t);
  const base = plan();
  base.maximum_reviewers = 4;
  base.minimum_reviewers = 4;
  base.planned_reviewers = 4;
  base.provider_family_minimum = 2;
  for (const [reviewer_id, provider, adapter_id] of [
    ['claude-opus', 'claude', 'claude-cli'],
    ['codex-adversarial', 'codex', 'codex-native-generic'],
    ['agy', 'agy', 'agy-cli'],
  ]) {
    base.routes.push({ ...base.routes[0], reviewer_id, provider, adapter_id });
    base.initial_reviewer_ids.push(reviewer_id);
    base.required_reviewer_ids.push(reviewer_id);
    base.candidate_reviewers.push({
      reviewer_id,
      provider,
      adapter_id,
      assignment_roles: ['standard'],
      last_status: 'success',
    });
  }
  const evidenceInputs = { ...f.evidenceInputs, diff: 'x'.repeat(220 * 1024) };
  const prepared = f.prepareReviewRound({
    routingPlan: base,
    target: f.target,
    evidenceInputs,
    roundId: 'large',
  });
  const attempts = prepared.plan.routes.map((route) => ({
    ...f.raw,
    reviewer_id: route.reviewer_id,
    role: route.reviewer_id,
    evidence_digest: prepared.plan.evidence_digest,
  }));
  const launches = prepared.plan.routes.map((route, index) => ({
    reviewer_id: route.reviewer_id,
    attempt_id: `large-${index}`,
    invocation_id: `large-invoke-${index}`,
    execution_route: { protocol_version: '3.0', ...route },
    payload: f.buildPreparedReviewerPayload({
      executionRoute: { protocol_version: '3.0', ...route },
      evidenceInputs,
    }),
    payload_provenance: 'native-argument',
  }));
  const dispatch = f.buildDispatchEvidence({
    routingPlan: prepared.plan,
    attempts,
    launches,
    roundId: 'large',
  });
  const input = {
    routing_plan: prepared.plan,
    evidence_inputs: evidenceInputs,
    attempts,
    launches,
    dispatch,
    adjudication: { schema_version: '1.0', groups: [] },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024);
  const result = await f.finalizeReviewDecision({ repo: f.repo, input });
  assert.ok(fs.statSync(result.decision.source_input_path).size < 1024 * 1024);
  t.diagnostic(
    `compound bytes=${Buffer.byteLength(JSON.stringify(input))}; persisted manifest bytes=${fs.statSync(result.decision.source_input_path).size}`,
  );
  const source = JSON.parse(fs.readFileSync(result.decision.source_input_path));
  assert.equal(
    source.launches.every((row) => !Object.hasOwn(row, 'payload') && row.payload_file),
    true,
  );
  assert.equal(
    (await f.verifyReviewDecision({ repo: f.repo, decisionFile: result.decision_path })).verdict,
    'APPROVE',
  );
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(root, 'hooks/scripts/review-evidence.mjs'),
        'finalize',
        '--repo',
        f.repo,
        '--input',
        result.decision.source_input_path,
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(cli.decision.verdict, 'APPROVE');
});

test('Summary severity-heading collision cannot finalize a Critical as empty APPROVE', async t => {
  const f=await fixture(t);
  const output=cleanReport.replace('Verdict**: APPROVE','Verdict**: REQUEST_CHANGES')
    .replace('🔴 0건','🔴 1건')
    .replace('### 🔴 Critical\nNone.','### 🔴 Critical\n- `a.js:1` a failed write drops persisted records.')
    .replace('\n\n## Code Review','\nMetadata mentions ### 🔴 Critical\nNone.\n\n## Code Review');
  assert.equal(f.parseReviewerReport(output,{strict:true}).issues.critical,1);
  const raw={...f.raw,output};
  const dispatch=f.buildDispatchEvidence({routingPlan:f.prepared.plan,attempts:[raw],launches:f.launches,roundId:'round-1'});
  const input={...f.input,attempts:[raw],dispatch};
  await assert.rejects(f.finalizeReviewDecision({repo:f.repo,input}),/invalid_adjudication/);
  const {extractSourceFindings}=await import('../hooks/scripts/lib/review-adjudication.mjs');
  const refs=extractSourceFindings(output,'codex-review').map(({bullet,...ref})=>ref);
  input.adjudication={schema_version:'1.0',groups:[{source_refs:refs,disposition:'unresolved',severity:'critical',category:'error-handling',rationale:'The interrupted write may discard the stored record.',evidence:[{location:'a.js:1',observation:'The reported write failure path remains unresolved.'}],missing_evidence:'A storage interruption reproduction is not available.'}]};
  const result=await f.finalizeReviewDecision({repo:f.repo,input});
  assert.equal(result.decision.verdict,'REQUEST_CHANGES');assert.equal(result.decision.counts.critical,1);
  assert.equal((await f.verifyReviewDecision({repo:f.repo,decisionFile:result.decision_path})).counts.critical,1);
});

test('prepared thin synthesis CLI completes and malformed controls return structured exit 2', async t => {
  const f=await fixture(t);const {spawnSync}=require('node:child_process');
  const result=await f.finalizeReviewDecision({repo:f.repo,input:f.input});
  const run=file=>spawnSync(process.execPath,[path.join(root,'hooks/scripts/review-synthesis.mjs'),'--prepared-input',file],{encoding:'utf8',timeout:10000});
  const valid=run(result.decision.source_input_path);assert.equal(valid.status,0,valid.stderr);assert.equal(JSON.parse(valid.stdout).verdict,'APPROVE');
  const malformed=path.join(f.repo,'malformed.json');fs.writeFileSync(malformed,JSON.stringify({routing_plan:{decision_mode:'adjudication-v1'},attempts:[{}]}));
  const invalid=run(malformed);assert.equal(invalid.status,2,invalid.stderr);assert.equal(JSON.parse(invalid.stderr).status,'error');assert.doesNotMatch(invalid.stderr,/unsettled top-level await/);
});

test('prepared synthesis confirms exact pending IDs and floors missing closure', async t => {
  const f=await fixture(t);const id='prior-pending-1';
  const prepared=f.prepareReviewRound({routingPlan:plan(),target:f.target,evidenceInputs:f.evidenceInputs,roundId:'confirmation-1',confirmationRequest:{schema_version:1,target_digest:f.target.target_digest,finding_ids:[id]}});
  const route={protocol_version:'3.0',...prepared.plan.routes[0]};
  const launches=[{...f.launches[0],execution_route:route,payload:f.buildPreparedReviewerPayload({executionRoute:route,evidenceInputs:f.evidenceInputs})}];
  assert.match(launches[0].payload,/## Confirmation/);assert.match(launches[0].payload,/prior-pending-1/);
  const section={schema_version:1,target_digest:f.target.target_digest,items:[{finding_id:id,status:'verified_closed',evidence:[{location:'a.js:1',observation:'The persisted record survives the named write failure.'}]}]};
  const synthesize=confirmation=>{
    const output=cleanReport+(confirmation===null?'':`\n## Confirmation\n\`\`\`json\n${JSON.stringify(confirmation)}\n\`\`\`\n`);
    const raw={...f.raw,output,evidence_digest:prepared.plan.evidence_digest};
    const dispatch=f.buildDispatchEvidence({routingPlan:prepared.plan,attempts:[raw],launches,roundId:'confirmation-1'});
    return f.synthesizeReviewRound({routingPlan:prepared.plan,attempts:[f.evaluateReviewerAttempt(raw)],dispatch,adjudication:{schema_version:'1.0',groups:[]}});
  };
  const valid=synthesize(section);assert.equal(valid.verdict,'APPROVE');assert.equal(valid.confirmation.complete,true);
  const missing=synthesize(null);assert.equal(missing.verdict,'CONCERN');assert.equal(missing.confirmation_floor_applied,true);assert.equal(missing.confirmation.items[0].status,'not_reobserved');
  for(const broken of [{...section,target_digest:'f'.repeat(64)},{...section,items:[{...section.items[0],finding_id:'foreign-id'}]}]){
    const invalid=synthesize(broken);assert.equal(invalid.status,'operational_failure');assert.equal(invalid.error,'invalid_confirmation');assert.equal(invalid.verdict,null);
  }
});
