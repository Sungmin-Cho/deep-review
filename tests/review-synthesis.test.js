'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const synthesisUrl = pathToFileURL(path.join(root, 'hooks/scripts/review-synthesis.mjs')).href;

function attempt(role, { critical = 0, warning = 0, included = true, exclusion = null } = {}) {
  return {
    reviewer_id: role,
    role,
    output_digest: createHash('sha256').update(`review:${role}`).digest('hex'),
    included,
    exclusion,
    verdict: !included ? null : critical > 0 ? 'REQUEST_CHANGES' : warning > 0 ? 'CONCERN' : 'APPROVE',
    issues: !included ? null : { critical, warning, info: 0 },
  };
}

function canonicalReviewerReport({
  date = '2026-07-26',
  verdict = 'APPROVE',
  critical = 0,
  warning = 0,
  info = 0,
  bodyCritical = critical,
  bodyWarning = warning,
  bodyInfo = info,
  includeCodeReview = true,
  passed = 'Contract valid.',
} = {}) {
  const findings = (count, label) => (
    count === 0
      ? 'None.'
      : Array.from({ length: count }, (_, index) => `- ${label} ${index + 1}.`).join('\n')
  );
  return [
    `# Deep Review Report — ${date}`,
    '',
    '## Summary',
    '',
    `- **Verdict**: ${verdict}`,
    `- **Issues**: 🔴 ${critical}건, 🟡 ${warning}건, ℹ️ ${info}건`,
    ...(includeCodeReview
      ? [
          '',
          '## Code Review',
          '',
          '### 🔴 Critical',
          '',
          findings(bodyCritical, 'Critical finding'),
          '',
          '### 🟡 Warning',
          '',
          findings(bodyWarning, 'Warning finding'),
          '',
          '### ℹ️ Info',
          '',
          findings(bodyInfo, 'Info finding'),
          '',
          '### 🟢 Passed',
          '',
          `- ${passed}`,
        ]
      : []),
    '',
  ].join('\n');
}

function strictGrammarViolationReports(role) {
  const canonical = canonicalReviewerReport({ passed: role });
  const issues = '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건';
  return [
    [
      'content before Critical',
      canonical.replace(
        '## Code Review\n\n### 🔴 Critical',
        '## Code Review\n\n- Unscoped finding.\n\n### 🔴 Critical',
      ),
    ],
    [
      'same-line contradictory prefix',
      canonical.replace(
        issues,
        '- **Issues**: 🟡 9건, 🔴 0건, 🟡 0건, ℹ️ 0건',
      ),
    ],
    [
      'trailing duplicate severity',
      canonical.replace(
        issues,
        '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건, 🔴 9건',
      ),
    ],
  ];
}

function visuallyEquivalentSummaryLabelReports(role) {
  const canonical = canonicalReviewerReport({ passed: role });
  const verdict = '- **Verdict**: APPROVE';
  const issues = '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건';
  return [
    [
      'space before Verdict colon',
      canonical.replace(verdict, `${verdict}\n- **Verdict** : REQUEST_CHANGES`),
    ],
    [
      'lowercase Verdict alias',
      canonical.replace(verdict, `${verdict}\n- **verdict**: REQUEST_CHANGES`),
    ],
    [
      'spaced Issues alias',
      canonical.replace(
        issues,
        `${issues}\n-  ** Issues ** : 🔴 9건, 🟡 9건, ℹ️ 9건`,
      ),
    ],
  ];
}

const candidates = [
  {
    reviewer_id: 'claude-opus',
    provider: 'claude',
    adapter_id: 'claude-cli',
    assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    reviewer_id: 'codex-review',
    provider: 'codex',
    adapter_id: 'codex-native-generic',
    assignment_roles: ['standard', 'feasibility', 'traceability', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    reviewer_id: 'codex-adversarial',
    provider: 'codex',
    adapter_id: 'codex-companion',
    assignment_roles: ['adversarial', 'security', 'confirmation'],
    last_status: 'success',
  },
  {
    reviewer_id: 'agy',
    provider: 'agy',
    adapter_id: 'agy-cli',
    assignment_roles: ['standard', 'traceability', 'adversarial', 'security', 'confirmation'],
    last_status: 'success',
    expansion_route_templates: ['standard', 'traceability', 'adversarial', 'security', 'confirmation']
      .map((assignmentRole) => ({
        reviewer_id: 'agy',
        provider: 'agy',
        adapter_id: 'agy-cli',
        assignment_role: assignmentRole,
        rubric_id: `${assignmentRole}-v1`,
        wave: 2,
        required: false,
        selection_reason: 'same-round expansion route template',
        resolved: { model: null, effort: 'high' },
      })),
  },
];

// A protocol-3 Grok route is admissible only while carrying the sealed D18
// compatibility evidence, so a synthesis fixture that admits Grok has to seal
// one the same way the production carrier does.
const GROK_REQUIRED_HELP_FLAGS = Object.freeze([
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function grokPlatformIdentity() {
  return {
    kind: 'posix-dev-ino-v1',
    fields: {
      dev: '1', ino: '2', type: 'regular-file', uid: '0',
    },
  };
}

function grokChainMember(memberPath, purpose) {
  return {
    path: memberPath,
    real_path: memberPath,
    platform_identity: grokPlatformIdentity(),
    sha256: 'a'.repeat(64),
    size: 12,
    classification_purpose: purpose,
  };
}

function grokCompatibilityEvidence() {
  const chain = {
    schema_version: '1.0',
    prepared_kind: 'direct',
    launcher: grokChainMember('/opt/grok', 'effective-executable'),
    shim: null,
    interpreter: null,
    shebang: null,
    posix_executable_type: 'native-elf',
    native_loader: grokChainMember('/lib64/ld-linux-x86-64.so.2', 'native-loader'),
  };
  const evidence = {
    schema_version: '1.0',
    launcher_path: '/opt/grok',
    real_path: '/opt/grok',
    platform_identity: grokPlatformIdentity(),
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
    required_help_flags: [...GROK_REQUIRED_HELP_FLAGS],
  };
  return {
    ...evidence,
    evidence_sha256: sha256(Buffer.from(canonicalStringify(evidence), 'utf8')),
  };
}

const grokCandidate = {
  reviewer_id: 'grok',
  provider: 'grok',
  adapter_id: 'grok-cli',
  assignment_roles: ['standard', 'feasibility', 'adversarial'],
  last_status: 'success',
};

function grokRoute() {
  return {
    reviewer_id: 'grok',
    provider: 'grok',
    adapter_id: 'grok-cli',
    assignment_role: 'feasibility',
    rubric_id: 'feasibility-v1',
    wave: 1,
    required: false,
    selection_reason: 'initial feasibility route',
    resolved: { model: 'grok', effort: 'high' },
    grok_compatibility_evidence: grokCompatibilityEvidence(),
  };
}

function agyRoute() {
  return {
    reviewer_id: 'agy',
    provider: 'agy',
    adapter_id: 'agy-cli',
    assignment_role: 'adversarial',
    rubric_id: 'adversarial-v1',
    wave: 1,
    required: false,
    selection_reason: 'initial adversarial route',
    resolved: { model: null, effort: 'high' },
  };
}

// Kept separate from routingPlan() so nested `routingPlan().routes` callers
// (building an override routes array from the two standard routes) get a
// fresh, context-free route pair every time — never a copy that already
// carries a *previous* call's finalized artifact_phase/risk/document_review_mode,
// which would then mismatch against a differently-overridden outer plan.
function baseRoutes() {
  return [
    {
      reviewer_id: 'claude-opus', provider: 'claude', adapter_id: 'claude-cli',
      assignment_role: 'standard', rubric_id: 'standard-v1', wave: 1, required: false,
      selection_reason: 'initial standard route', resolved: { model: null, effort: 'high' },
    },
    {
      reviewer_id: 'codex-review', provider: 'codex', adapter_id: 'codex-native-generic',
      assignment_role: 'traceability', rubric_id: 'traceability-v1', wave: 1, required: false,
      selection_reason: 'initial traceability route', resolved: { model: null, effort: 'high' },
    },
  ];
}

// Protocol 3 now requires every route and expansion route template to carry
// complete artifact_phase/risk/document_review_mode context matching the
// plan (production buildRoutingPlan always emits it). A fixture entry that
// already sets at least one of the three fields is left untouched — that's a
// test deliberately constructing a mismatch/partial-context/forgery case —
// otherwise it is defaulted to the plan's own final context.
function withDefaultDocumentContext(entry, context) {
  const fields = ['artifact_phase', 'risk', 'document_review_mode'];
  if (fields.some((field) => Object.hasOwn(entry, field))) return entry;
  return {
    ...entry,
    artifact_phase: context.artifactPhase,
    risk: context.risk,
    document_review_mode: context.documentReviewMode,
  };
}

function routingPlan(overrides = {}) {
  const plan = {
    protocol_version: '3.0',
    artifact_phase: 'implementation',
    risk: 'low',
    reviewer_strategy: 'adaptive',
    shadow_mode: false,
    progress: 'initial',
    minimum_reviewers: 2,
    planned_reviewers: 2,
    provider_family_minimum: 2,
    maximum_reviewers: 4,
    max_expansion_waves: 1,
    initial_reviewer_ids: ['claude-opus', 'codex-review'],
    required_reviewer_ids: [],
    candidate_reviewers: candidates,
    routes: baseRoutes(),
    ...overrides,
  };
  if (Object.hasOwn(overrides, 'routes')
      && !Object.hasOwn(overrides, 'initial_reviewer_ids')) {
    plan.initial_reviewer_ids = plan.routes
      .filter((route) => route.wave === 1)
      .map((route) => route.reviewer_id);
  }
  if (Object.hasOwn(overrides, 'routes')
      && !Object.hasOwn(overrides, 'required_reviewer_ids')) {
    plan.required_reviewer_ids = plan.routes
      .filter((route) => route.wave === 1 && route.required === true)
      .map((route) => route.reviewer_id);
  }
  const context = {
    artifactPhase: plan.artifact_phase,
    risk: plan.risk,
    documentReviewMode: plan.document_review_mode ?? 'full-readiness',
  };
  plan.routes = (plan.routes || []).map((route) => withDefaultDocumentContext(route, context));
  plan.candidate_reviewers = (plan.candidate_reviewers || []).map((candidate) => (
    Array.isArray(candidate.expansion_route_templates)
      ? {
        ...candidate,
        expansion_route_templates: candidate.expansion_route_templates.map(
          (template) => withDefaultDocumentContext(template, context),
        ),
      }
      : candidate
  ));
  return plan;
}

test('canonical report parser accepts synthesis-supported verdict and count combinations', async (t) => {
  const { parseReviewerReport } = await import(synthesisUrl);
  for (const [name, report, expected] of [
    [
      'clean approval',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 1건\n',
      { verdict: 'APPROVE', issues: { critical: 0, warning: 0, info: 1 } },
    ],
    [
      'warning concern',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: CONCERN\n- **Issues**: 🔴 0건, 🟡 1건, ℹ️ 0건\n',
      { verdict: 'CONCERN', issues: { critical: 0, warning: 1, info: 0 } },
    ],
    [
      'warning request changes',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: REQUEST_CHANGES\n- **Issues**: 🔴 0건, 🟡 1건, ℹ️ 0건\n',
      { verdict: 'REQUEST_CHANGES', issues: { critical: 0, warning: 1, info: 0 } },
    ],
    [
      'critical request changes',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: REQUEST_CHANGES\n- **Issues**: 🔴 1건, 🟡 0건, ℹ️ 0건\n',
      { verdict: 'REQUEST_CHANGES', issues: { critical: 1, warning: 0, info: 0 } },
    ],
    [
      'summary slice ignores similarly labeled body data',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n\n## Appendix\n\n- **Verdict**: REQUEST_CHANGES\n- **Issues**: 🔴 9건, 🟡 9건, ℹ️ 9건\n',
      { verdict: 'APPROVE', issues: { critical: 0, warning: 0, info: 0 } },
    ],
  ]) {
    await t.test(name, () => {
      assert.deepEqual(parseReviewerReport(report), expected);
    });
  }
});

test('canonical report parser rejects duplicate or contradictory summary lines', async (t) => {
  const { parseReviewerReport } = await import(synthesisUrl);
  for (const [name, report] of [
    [
      'duplicate verdict',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Verdict**: REQUEST_CHANGES\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n',
    ],
    [
      'duplicate issues',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n- **Issues**: 🔴 1건, 🟡 0건, ℹ️ 0건\n',
    ],
    [
      'malformed duplicate verdict label',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Verdict**: MAYBE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n',
    ],
    [
      'malformed duplicate issues label',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n- **Issues**: unavailable\n',
    ],
    [
      'warning approval',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 1건, ℹ️ 0건\n',
    ],
    [
      'zero-issue concern',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: CONCERN\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n',
    ],
    [
      'critical concern',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: CONCERN\n- **Issues**: 🔴 1건, 🟡 0건, ℹ️ 0건\n',
    ],
    [
      'duplicate report heading',
      '# Deep Review Report — 2026-07-26\n# Deep Review Report — 2026-07-27\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n',
    ],
    [
      'duplicate Summary heading',
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n- **Verdict**: APPROVE\n- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n\n## Summary\n',
    ],
  ]) {
    await t.test(name, () => {
      assert.equal(parseReviewerReport(report), null);
    });
  }
});

test('canonical report parser rejects canonical content before the sole report heading', async (t) => {
  const { parseReviewerReport } = await import(synthesisUrl);
  const summary = '## Summary\n\n'
    + '- **Verdict**: APPROVE\n'
    + '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n\n';
  const codeReview = '## Code Review\n\n'
    + '### 🔴 Critical\n\nNone.\n\n'
    + '### 🟡 Warning\n\nNone.\n\n'
    + '### ℹ️ Info\n\nNone.\n\n'
    + '### 🟢 Passed\n\n- Contract valid.\n\n';
  const heading = '# Deep Review Report — 2026-07-26\n';

  await t.test('ordinary mode', () => {
    assert.equal(parseReviewerReport(summary + heading), null);
  });
  await t.test('strict mode', () => {
    assert.equal(
      parseReviewerReport(
        summary + codeReview + '## Appendix\n\npreamble boundary\n\n' + heading,
        { strict: true },
      ),
      null,
    );
  });
});

test('canonical report parser rejects out-of-order or duplicate canonical sections', async (t) => {
  const { parseReviewerReport } = await import(synthesisUrl);
  const heading = '# Deep Review Report — 2026-07-26\n\n';
  const summary = '## Summary\n\n'
    + '- **Verdict**: APPROVE\n'
    + '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n\n';
  const codeReview = '## Code Review\n\n'
    + '### 🔴 Critical\n\nNone.\n\n'
    + '### 🟡 Warning\n\nNone.\n\n'
    + '### ℹ️ Info\n\nNone.\n\n'
    + '### 🟢 Passed\n\n- Contract valid.\n';

  for (const [name, report, options] of [
    ['Summary is not the next canonical section', heading + '## Appendix\n\nnoise\n\n' + summary, {}],
    ['Code Review precedes Summary', heading + codeReview + '\n' + summary, {}],
    ['ordinary mode has duplicate Code Review sections', heading + summary + codeReview + '\n' + codeReview, {}],
    ['strict mode has Code Review before Summary', heading + codeReview + '\n' + summary, { strict: true }],
  ]) {
    await t.test(name, () => {
      assert.equal(parseReviewerReport(report, options), null);
    });
  }
});

test('strict canonical parser requires and reconciles the complete Code Review body', async () => {
  const { parseReviewerReport } = await import(synthesisUrl);
  const valid = '# Deep Review Report — 2026-07-26\n\n## Summary\n\n'
    + '- **Verdict**: CONCERN\n'
    + '- **Issues**: 🔴 0건, 🟡 1건, ℹ️ 1건\n\n'
    + '## Code Review\n\n'
    + '### 🔴 Critical\n\nNone.\n\n'
    + '### 🟡 Warning\n\n- Warning finding.\n\n'
    + '### ℹ️ Info\n\n- Informational finding.\n\n'
    + '### 🟢 Passed\n\n- Contract valid.\n';
  assert.deepEqual(
    parseReviewerReport(valid, { strict: true }),
    { verdict: 'CONCERN', issues: { critical: 0, warning: 1, info: 1 } },
  );
  assert.equal(
    parseReviewerReport(
      '# Deep Review Report — 2026-07-26\n\n## Summary\n\n'
      + '- **Verdict**: APPROVE\n'
      + '- **Issues**: 🔴 0건, 🟡 0건, ℹ️ 0건\n',
      { strict: true },
    ),
    null,
  );
  assert.equal(
    parseReviewerReport(
      valid.replace('- **Issues**: 🔴 0건, 🟡 1건, ℹ️ 1건', '- **Issues**: 🔴 0건, 🟡 2건, ℹ️ 1건'),
      { strict: true },
    ),
    null,
  );
});

test('raw canonical reviewer admission excludes missing or count-mismatched Code Review bodies', async (t) => {
  const { evaluateReviewerAttempt } = await import(synthesisUrl);
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  for (const role of ['codex-review', 'codex-adversarial', 'claude-opus', 'agy']) {
    for (const [failure, output] of [
      [
        'missing Code Review',
        canonicalReviewerReport({ includeCodeReview: false, passed: role }),
      ],
      [
        'mismatched warning bullets',
        canonicalReviewerReport({
          verdict: 'CONCERN',
          warning: 1,
          bodyWarning: 0,
          passed: role,
        }),
      ],
    ]) {
      await t.test(`${role}: ${failure}`, () => {
        const evaluated = evaluateReviewerAttempt({
          reviewer_id: role,
          role,
          output,
          beforeFingerprint: fingerprint,
          afterFingerprint: fingerprint,
        });
        assert.equal(evaluated.included, false);
        assert.equal(evaluated.exclusion, 'malformed_or_empty_result');
        assert.equal(
          evaluated.exclusion_detail,
          failure === 'missing Code Review'
            ? 'section_headings_invalid'
            : 'count_mismatch:warning',
        );
        assert.equal(evaluated.verdict, null);
        assert.equal(evaluated.issues, null);
        assert.equal(Object.hasOwn(evaluated, 'tolerances'), false);
      });
    }
  }
});

test('synthesis CLI excludes malformed raw reports from N_actual and Phase 6', async (t) => {
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  for (const role of ['codex-review', 'codex-adversarial', 'claude-opus', 'agy']) {
    for (const [failure, output] of [
      [
        'missing Code Review',
        canonicalReviewerReport({ includeCodeReview: false, passed: role }),
      ],
      [
        'mismatched info bullets',
        canonicalReviewerReport({ info: 1, bodyInfo: 0, passed: role }),
      ],
    ]) {
      await t.test(`${role}: ${failure}`, () => {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'deep-review-strict-admission-'));
        const inputPath = path.join(rootDir, 'attempts.json');
        writeFileSync(inputPath, JSON.stringify({
          attempts: [{
            reviewer_id: role,
            role,
            output,
            beforeFingerprint: fingerprint,
            afterFingerprint: fingerprint,
          }],
        }));
        const cli = spawnSync(process.execPath, [
          path.join(root, 'hooks/scripts/review-synthesis.mjs'),
          '--input',
          inputPath,
        ], { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        const result = JSON.parse(cli.stdout);
        assert.equal(result.status, 'operational_failure');
        assert.equal(result.n_actual, 0);
        assert.equal(result.verdict, null);
        assert.equal(result.phase6_allowed, false);
        assert.deepEqual(result.exclusions, [{
          role,
          reason: 'malformed_or_empty_result',
          detail: failure === 'missing Code Review'
            ? 'section_headings_invalid'
            : 'count_mismatch:info',
        }]);
      });
    }
  }
});

test('strict API admission rejects Code Review preamble and noncanonical Issues lines', async (t) => {
  const { evaluateReviewerAttempt } = await import(synthesisUrl);
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  for (const role of ['codex-review', 'codex-adversarial', 'claude-opus', 'agy']) {
    for (const [failure, output] of strictGrammarViolationReports(role)) {
      await t.test(`${role}: ${failure}`, () => {
        const evaluated = evaluateReviewerAttempt({
          reviewer_id: role,
          role,
          output,
          beforeFingerprint: fingerprint,
          afterFingerprint: fingerprint,
        });
        assert.equal(evaluated.included, false);
        assert.equal(evaluated.exclusion, 'malformed_or_empty_result');
        assert.equal(evaluated.verdict, null);
        assert.equal(evaluated.issues, null);
      });
    }
  }
});

test('raw synthesis CLI keeps strict grammar violations out of N_actual and Phase 6', async (t) => {
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  for (const role of ['codex-review', 'codex-adversarial', 'claude-opus', 'agy']) {
    for (const [failure, output] of strictGrammarViolationReports(role)) {
      await t.test(`${role}: ${failure}`, () => {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'deep-review-strict-grammar-'));
        const inputPath = path.join(rootDir, 'attempts.json');
        writeFileSync(inputPath, JSON.stringify({
          attempts: [{
            reviewer_id: role,
            role,
            output,
            beforeFingerprint: fingerprint,
            afterFingerprint: fingerprint,
          }],
        }));
        const cli = spawnSync(process.execPath, [
          path.join(root, 'hooks/scripts/review-synthesis.mjs'),
          '--input',
          inputPath,
        ], { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        const result = JSON.parse(cli.stdout);
        assert.equal(result.status, 'operational_failure');
        assert.equal(result.n_actual, 0);
        assert.equal(result.verdict, null);
        assert.equal(result.phase6_allowed, false);
      });
    }
  }
});

test('distinct routed reviewers may independently return byte-identical clean reports', async () => {
  const { evaluateReviewerAttempt, synthesizeReviewRound } = await import(synthesisUrl);
  const output = canonicalReviewerReport({ passed: 'Shared clean result.' }).replace(
    '- **Verdict**: APPROVE',
    '- **Verdict**: APPROVE\n'
      + '- **Review Mode**: 2-way Cross-Model\n'
      + '- **Warnings**: None.',
  );
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  const attempts = ['claude-opus', 'codex-review'].map((role) => (
    evaluateReviewerAttempt({
      reviewer_id: role,
      role,
      output,
      beforeFingerprint: fingerprint,
      afterFingerprint: fingerprint,
    })
  ));
  assert.equal(attempts[0].included, true);
  assert.equal(attempts[1].included, true);
  assert.equal(attempts[0].output_digest, attempts[1].output_digest);

  const result = synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: routingPlan(),
  });
  assert.equal(result.status, 'reviewed');
  assert.equal(result.n_actual, 2);
  assert.equal(result.verdict, 'APPROVE');
  assert.equal(result.phase6_allowed, true);
});

test('raw synthesis CLI admits identical clean output from distinct routed reviewers', () => {
  const output = canonicalReviewerReport({ passed: 'Shared CLI clean result.' }).replace(
    '- **Verdict**: APPROVE',
    '- **Verdict**: APPROVE\n'
      + '- **Review Mode**: 2-way Cross-Model\n'
      + '- **Warnings**: None.',
  );
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  const rootDir = mkdtempSync(path.join(tmpdir(), 'deep-review-identical-clean-'));
  const inputPath = path.join(rootDir, 'attempts.json');
  writeFileSync(inputPath, JSON.stringify({
    attempts: ['claude-opus', 'codex-review'].map((role) => ({
      reviewer_id: role,
      role,
      output,
      beforeFingerprint: fingerprint,
      afterFingerprint: fingerprint,
    })),
    consensus: { findings: [] },
    routing_plan: routingPlan(),
  }));
  const cli = spawnSync(process.execPath, [
    path.join(root, 'hooks/scripts/review-synthesis.mjs'),
    '--input',
    inputPath,
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.status, 'reviewed');
  assert.equal(result.n_actual, 2);
  assert.equal(result.verdict, 'APPROVE');
  assert.equal(result.phase6_allowed, true);
});

test('strict API admission rejects malformed equivalents of canonical Summary labels', async (t) => {
  const { evaluateReviewerAttempt } = await import(synthesisUrl);
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  for (const role of ['codex-review', 'codex-adversarial', 'claude-opus', 'agy']) {
    for (const [failure, output] of visuallyEquivalentSummaryLabelReports(role)) {
      await t.test(`${role}: ${failure}`, () => {
        const evaluated = evaluateReviewerAttempt({
          reviewer_id: role,
          role,
          output,
          beforeFingerprint: fingerprint,
          afterFingerprint: fingerprint,
        });
        assert.equal(evaluated.included, false);
        assert.equal(evaluated.exclusion, 'malformed_or_empty_result');
      });
    }
  }
});

test('raw synthesis CLI excludes malformed Summary label equivalents', async (t) => {
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  for (const role of ['codex-review', 'codex-adversarial', 'claude-opus', 'agy']) {
    for (const [failure, output] of visuallyEquivalentSummaryLabelReports(role)) {
      await t.test(`${role}: ${failure}`, () => {
        const rootDir = mkdtempSync(path.join(tmpdir(), 'deep-review-summary-alias-'));
        const inputPath = path.join(rootDir, 'attempts.json');
        writeFileSync(inputPath, JSON.stringify({
          attempts: [{
            reviewer_id: role,
            role,
            output,
            beforeFingerprint: fingerprint,
            afterFingerprint: fingerprint,
          }],
        }));
        const cli = spawnSync(process.execPath, [
          path.join(root, 'hooks/scripts/review-synthesis.mjs'),
          '--input',
          inputPath,
        ], { encoding: 'utf8' });
        assert.equal(cli.status, 0, cli.stderr);
        const result = JSON.parse(cli.stdout);
        assert.equal(result.status, 'operational_failure');
        assert.equal(result.n_actual, 0);
        assert.equal(result.verdict, null);
        assert.equal(result.phase6_allowed, false);
      });
    }
  }
});

test('split warning requests exactly one blind expansion reviewer', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const attempts = [attempt('claude-opus', { warning: 1 }), attempt('codex-review')];
  const result = synthesizeReviewRound({
    attempts,
    consensus: { findings: [{ severity: 'warning', roles: ['claude-opus'] }] },
    routingPlan: routingPlan(),
    expansionWavesUsed: 0,
  });
  assert.equal(result.status, 'needs_expansion');
  assert.equal(result.needs_expansion, true);
  assert.deepEqual(result.expansion_reasons, ['split_concern']);
  assert.equal(result.next_assignment.wave, 2);
  assert.equal(result.next_assignment.reviewer_id, 'agy');
  assert.equal(result.next_assignment.independent, true);
  assert.equal(result.expanded_routing_plan.routes.at(-1).reviewer_id, 'agy');
  assert.equal(result.verdict, null);
});

test('document split findings do not trigger same-round expansion', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus', { warning: 1 }), attempt('codex-review')],
    consensus: { findings: [{ severity: 'warning', roles: ['claude-opus'] }] },
    routingPlan: routingPlan({ artifact_phase: 'document' }),
    expansionWavesUsed: 0,
  });
  assert.equal(result.status, 'reviewed');
  assert.equal(result.needs_expansion, false);
  assert.equal(result.verdict, 'CONCERN');
  assert.equal(Object.hasOwn(result, 'expansion_reasons'), false);
});

test('single critical, readiness mismatch, and reviewer-floor failure trigger one expansion', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const loneCritical = synthesizeReviewRound({
    attempts: [attempt('claude-opus', { critical: 1 }), attempt('codex-review')],
    consensus: { findings: [{ severity: 'critical', roles: ['claude-opus'] }] },
    routingPlan: routingPlan(),
  });
  assert.equal(loneCritical.status, 'needs_expansion');
  assert.ok(loneCritical.expansion_reasons.includes('single_critical_or_security'));

  const readiness = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: routingPlan(),
    readinessMismatch: true,
  });
  assert.equal(readiness.status, 'needs_expansion');
  assert.ok(readiness.expansion_reasons.includes('readiness_mismatch'));

  const timeout = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('codex-review', { included: false, exclusion: 'timeout' }),
    ],
    routingPlan: routingPlan(),
  });
  assert.equal(timeout.status, 'needs_expansion');
  assert.ok(timeout.expansion_reasons.includes('reviewer_minimum_broken'));
});

test('a lone finding from a security assignment requests security confirmation', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan({
    routes: [
      baseRoutes()[0],
      {
        ...baseRoutes()[1],
        assignment_role: 'security',
        rubric_id: 'security-v1',
      },
    ],
  });
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review', { warning: 1 })],
    consensus: { findings: [{ severity: 'warning', roles: ['codex-review'] }] },
    routingPlan: plan,
  });
  assert.equal(result.status, 'needs_expansion');
  assert.ok(result.expansion_reasons.includes('single_critical_or_security'));
  assert.equal(result.next_assignment.assignment_role, 'security');
});

test('expansion skips an earlier candidate without a usable route template', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const unusable = {
    ...candidates[2],
    expansion_route_templates: [],
  };
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus', { warning: 1 }), attempt('codex-review')],
    consensus: { findings: [{ severity: 'warning', roles: ['claude-opus'] }] },
    routingPlan: routingPlan({
      candidate_reviewers: [candidates[0], candidates[1], unusable, candidates[3]],
    }),
  });
  assert.equal(result.status, 'needs_expansion');
  assert.equal(result.next_assignment.reviewer_id, 'agy');
});

test('an unavailable adaptive floor route is atomically replaced by the expansion route', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const result = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('codex-review', { included: false, exclusion: 'privacy_declined' }),
    ],
    routingPlan: routingPlan(),
  });
  assert.equal(result.status, 'needs_expansion');
  assert.equal(result.next_assignment.reviewer_id, 'agy');
  assert.equal(result.next_assignment.required, true);
  assert.equal(
    result.expanded_routing_plan.routes.some((route) => route.reviewer_id === 'codex-review'),
    false,
  );
  assert.equal(result.expanded_routing_plan.initial_reviewer_ids.includes('codex-review'), false);
  assert.equal(result.verdict, null);
});

test('an unavailable explicitly required reviewer fails closed without replacement', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan({
    required_reviewer_ids: ['codex-review'],
    routes: baseRoutes().map((route) => (
      route.reviewer_id === 'codex-review'
        ? {
          ...route,
          required: true,
          selection_reason: 'explicit reviewer override requires this canonical reviewer',
        }
        : route
    )),
  });
  const result = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('codex-review', { included: false, exclusion: 'privacy_declined' }),
    ],
    routingPlan: plan,
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'required_reviewer_unavailable');
  assert.deepEqual(result.missing_required_reviewers, ['codex-review']);
  assert.equal(result.verdict, null);
});

test('an unavailable adaptive route applies the high-risk confidence floor once actual reviewer floors are met', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan({
    risk: 'high',
    minimum_reviewers: 2,
    planned_reviewers: 3,
    provider_family_minimum: 2,
    initial_reviewer_ids: ['claude-opus', 'codex-review', 'agy'],
    routes: [
      ...baseRoutes(),
      {
        reviewer_id: 'agy',
        provider: 'agy',
        adapter_id: 'agy-cli',
        assignment_role: 'security',
        rubric_id: 'security-v1',
        wave: 1,
        required: false,
        selection_reason: 'initial security route',
        resolved: { model: null, effort: 'high' },
      },
    ],
  });
  const result = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus', { included: false, exclusion: 'timeout' }),
      attempt('codex-review'),
      attempt('agy'),
    ],
    consensus: { findings: [] },
    routingPlan: plan,
    expansionWavesUsed: 0,
  });

  assert.equal(result.status, 'reviewed');
  assert.equal(result.n_actual, 2);
  assert.equal(result.verdict, 'CONCERN');
  assert.equal(result.confidence_floor_applied, true);
  assert.equal(result.phase6_allowed, true);
});

test('an unavailable required expansion replacement fails closed after the only wave', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan({
    routes: [
      baseRoutes()[0],
      {
        reviewer_id: 'agy',
        provider: 'agy',
        adapter_id: 'agy-cli',
        assignment_role: 'standard',
        rubric_id: 'standard-v1',
        wave: 2,
        required: true,
        selection_reason: 'opaque human-readable explanation',
        resolved: { model: null, effort: 'high' },
      },
    ],
  });
  const result = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('agy', { included: false, exclusion: 'timeout' }),
    ],
    routingPlan: plan,
    expansionWavesUsed: 1,
  });

  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'required_reviewer_unavailable');
  assert.deepEqual(result.missing_required_reviewers, ['agy']);
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('a missing wave-2 route cannot bypass a broken reviewer floor by clearing required', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan({
    routes: [
      baseRoutes()[0],
      {
        reviewer_id: 'agy',
        provider: 'agy',
        adapter_id: 'agy-cli',
        assignment_role: 'standard',
        rubric_id: 'standard-v1',
        wave: 2,
        required: false,
        selection_reason: 'tampered replacement flag',
        resolved: { model: null, effort: 'high' },
      },
    ],
  });
  const result = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('agy', { included: false, exclusion: 'timeout' }),
    ],
    routingPlan: plan,
    expansionWavesUsed: 1,
  });

  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'required_reviewer_unavailable');
  assert.deepEqual(result.missing_required_reviewers, ['agy']);
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('a missing wave-2 confirmation fails closed even when the base reviewer floor is met', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan({
    routes: [
      ...baseRoutes(),
      {
        reviewer_id: 'agy',
        provider: 'agy',
        adapter_id: 'agy-cli',
        assignment_role: 'traceability',
        rubric_id: 'traceability-v1',
        wave: 2,
        required: false,
        selection_reason: 'readiness confirmation',
        resolved: { model: null, effort: 'high' },
      },
    ],
  });
  const result = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('codex-review'),
      attempt('agy', { included: false, exclusion: 'timeout' }),
    ],
    consensus: { findings: [] },
    routingPlan: plan,
    expansionWavesUsed: 1,
    readinessMismatch: true,
  });

  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'required_reviewer_unavailable');
  assert.deepEqual(result.missing_required_reviewers, ['agy']);
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('a materialized wave-2 route is authoritative when the caller wave counter is stale', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan({
    routes: [
      ...baseRoutes(),
      {
        reviewer_id: 'agy',
        provider: 'agy',
        adapter_id: 'agy-cli',
        assignment_role: 'confirmation',
        rubric_id: 'confirmation-v1',
        wave: 2,
        required: false,
        selection_reason: 'materialized confirmation',
        resolved: { model: null, effort: 'high' },
      },
    ],
  });
  const result = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('codex-review'),
      attempt('agy', { included: false, exclusion: 'timeout' }),
    ],
    consensus: { findings: [] },
    routingPlan: plan,
    expansionWavesUsed: 0,
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'required_reviewer_unavailable');
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('a positive wave counter without a materialized wave-2 route is malformed', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: routingPlan(),
    expansionWavesUsed: 1,
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'invalid_routing_plan_identity');
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('an initial reviewer cannot be relabeled as a materialized wave-2 voice', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan({
    initial_reviewer_ids: ['claude-opus', 'codex-review'],
    routes: baseRoutes().map((route) => (
      route.reviewer_id === 'codex-review'
        ? {
          ...route,
          assignment_role: 'confirmation',
          rubric_id: 'confirmation-v1',
          wave: 2,
          selection_reason: 'forged materialized confirmation',
        }
        : route
    )),
  });
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: plan,
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'invalid_routing_plan_identity');
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('synthesis rejects forged canonical provider identities before counting provider families', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan({
    risk: 'critical',
    minimum_reviewers: 3,
    planned_reviewers: 3,
    provider_family_minimum: 2,
    candidate_reviewers: [
      candidates[0],
      candidates[1],
      { ...candidates[2], provider: 'agy' },
    ],
    routes: [
      baseRoutes()[0],
      baseRoutes()[1],
      {
        reviewer_id: 'codex-adversarial',
        provider: 'agy',
        assignment_role: 'security',
        rubric_id: 'security-v1',
        wave: 1,
        required: true,
      },
    ],
  });
  const result = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('codex-review'),
      attempt('codex-adversarial'),
    ],
    consensus: { findings: [] },
    routingPlan: plan,
    expansionWavesUsed: 1,
  });

  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'invalid_routing_plan_identity');
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('synthesis rejects malformed required and wave types before required-route evaluation', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  for (const malformedRoute of [
    { wave: '2', required: true },
    { wave: 2, required: 'true' },
    { wave: 0, required: true },
  ]) {
    const plan = routingPlan({
      routes: [
        baseRoutes()[0],
        {
          reviewer_id: 'agy',
          provider: 'agy',
          assignment_role: 'standard',
          rubric_id: 'standard-v1',
          selection_reason: 'opaque',
          ...malformedRoute,
        },
      ],
    });
    const result = synthesizeReviewRound({
      attempts: [attempt('claude-opus')],
      routingPlan: plan,
      expansionWavesUsed: 1,
    });
    assert.equal(result.status, 'operational_failure');
    assert.equal(result.error, 'invalid_routing_plan_identity');
    assert.equal(result.verdict, null);
    assert.equal(result.phase6_allowed, false);
  }
});

test('CLI refuses pre-evaluated attempts without raw fingerprint-bound output', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'deep-review-synthesis-'));
  const inputPath = path.join(rootDir, 'attempts.json');
  writeFileSync(inputPath, JSON.stringify({
    attempts: [
      attempt('claude-opus'),
      attempt('codex-review'),
      attempt('agy'),
    ],
    consensus: { findings: [] },
    routing_plan: routingPlan({
      risk: 'critical',
      minimum_reviewers: 3,
      planned_reviewers: 3,
      routes: [
        ...baseRoutes(),
        {
          reviewer_id: 'agy',
          provider: 'agy',
          assignment_role: 'security',
          rubric_id: 'security-v1',
          wave: 1,
          required: false,
        },
      ],
    }),
  }));
  const result = spawnSync(process.execPath, [
    path.join(root, 'hooks/scripts/review-synthesis.mjs'),
    '--input',
    inputPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /require raw output and fingerprint evidence/u);
});

test('a final wave uses every trusted attempt and refuses a second expansion', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const attempts = [
    attempt('claude-opus', { warning: 1 }),
    attempt('codex-review'),
    attempt('agy'),
  ];
  const result = synthesizeReviewRound({
    attempts,
    consensus: { findings: [{ severity: 'warning', roles: ['claude-opus'] }] },
    routingPlan: routingPlan({
      routes: [
        ...baseRoutes(),
        {
          reviewer_id: 'agy',
          provider: 'agy',
          adapter_id: 'agy-cli',
          assignment_role: 'adversarial',
          rubric_id: 'adversarial-v1',
          wave: 2,
          required: false,
          selection_reason: 'materialized adversarial confirmation',
          resolved: { model: null, effort: 'high' },
        },
      ],
    }),
    expansionWavesUsed: 1,
  });
  assert.equal(result.status, 'reviewed');
  assert.equal(result.n_actual, 3);
  assert.equal(result.verdict, 'CONCERN');
  assert.equal(result.expansion_rejected, 'maximum_expansion_waves_reached');
  assert.equal(result.needs_expansion, false);
});

test('expansion candidate exhaustion applies a confidence floor without lowering blocking verdicts', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const noUnused = routingPlan({
    candidate_reviewers: candidates.slice(0, 1),
    routes: [baseRoutes()[0]],
  });
  const approval = synthesizeReviewRound({
    attempts: [attempt('claude-opus')],
    routingPlan: noUnused,
  });
  assert.equal(approval.status, 'reviewed');
  assert.equal(approval.verdict, 'CONCERN');
  assert.equal(approval.confidence_floor_applied, true);
  assert.equal(approval.expansion_rejected, 'no_unused_candidate');

  const blocking = synthesizeReviewRound({
    attempts: [attempt('claude-opus', { critical: 1 })],
    routingPlan: noUnused,
  });
  assert.equal(blocking.verdict, 'REQUEST_CHANGES');
  assert.equal(blocking.confidence_floor_applied, false);
});

test('critical implementation reviewer/family shortfall is an operational failure with no verdict', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: routingPlan({
      risk: 'critical',
      minimum_reviewers: 3,
      planned_reviewers: 3,
      provider_family_minimum: 2,
      candidate_reviewers: candidates.slice(0, 2),
    }),
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.n_actual, 2);
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
  assert.equal(result.error, 'critical_reviewer_floor');
});

test('N_actual=0 remains fail-closed when no expansion candidate exists', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus', { included: false, exclusion: 'timeout' })],
    routingPlan: routingPlan({
      candidate_reviewers: [candidates[0]],
      routes: [baseRoutes()[0]],
    }),
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.n_actual, 0);
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('implementation approval is floored when a verified readiness receipt still has deferred evidence', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  // O20/O21 (D17) — the carrier crossing this seam is the reviewer-scoped ref,
  // so two reviewers who both call their own finding DOC-1 arrive as two
  // obligations. A bare-id carrier would deliver one, and verifying either
  // reviewer would lift the floor for both.
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: routingPlan(),
    deferredAcceptance: {
      complete: false,
      pending_finding_refs: [
        { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
        { finding_id: 'DOC-1', reviewer_id: 'codex-review' },
      ],
    },
  });
  assert.equal(result.status, 'reviewed');
  assert.equal(result.verdict, 'CONCERN');
  assert.equal(result.deferred_acceptance_floor, true);
  assert.deepEqual(result.pending_deferred_finding_refs, [
    { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
    { finding_id: 'DOC-1', reviewer_id: 'codex-review' },
  ]);
  // The bare list is a display projection on the same terms as
  // `blocking_finding_ids`: one entry per authoritative ref, same order, so the
  // shared local id renders twice and no authority can read identity out of it.
  assert.deepEqual(result.pending_deferred_finding_ids, ['DOC-1', 'DOC-1']);
  assert.equal(
    result.pending_deferred_finding_ids.length,
    result.pending_deferred_finding_refs.length,
  );

  // A bare-id carrier is not a deferred-acceptance carrier at all.
  assert.throws(() => synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: routingPlan(),
    deferredAcceptance: { complete: false, pending_finding_ids: ['DOC-1'] },
  }), /deferredAcceptance is malformed/);
  // Nor is a ref whose reviewer identity is missing or meaningless.
  for (const malformed of [
    { finding_id: 'DOC-1' },
    { finding_id: 'DOC-1', reviewer_id: '' },
    { finding_id: 'DOC-1', reviewer_id: null },
    { finding_id: 'DOC-1', reviewer_id: 'claude-opus', scope: 'legacy_global' },
  ]) {
    assert.throws(() => synthesizeReviewRound({
      attempts: [attempt('claude-opus'), attempt('codex-review')],
      consensus: { findings: [] },
      routingPlan: routingPlan(),
      deferredAcceptance: { complete: false, pending_finding_refs: [malformed] },
    }), /deferredAcceptance is malformed/);
  }
});

test('shadow mode records but does not apply adaptive expansion or confidence floors', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus')],
    routingPlan: routingPlan({
      shadow_mode: true,
      routes: [baseRoutes()[0]],
      candidate_reviewers: candidates.slice(0, 1),
    }),
  });
  assert.equal(result.status, 'reviewed');
  assert.equal(result.verdict, 'APPROVE');
  assert.equal(result.needs_expansion, false);
  assert.equal(result.shadow_mode, true);
  assert.equal(result.adaptive_plan_applied, false);
});

test('shadow mode still enforces critical implementation and explicit deferred receipt gates', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const critical = synthesizeReviewRound({
    attempts: [attempt('claude-opus')],
    routingPlan: routingPlan({
      shadow_mode: true,
      risk: 'critical',
      routes: [baseRoutes()[0]],
      candidate_reviewers: candidates.slice(0, 1),
    }),
  });
  assert.equal(critical.status, 'operational_failure');
  assert.equal(critical.verdict, null);
  assert.equal(critical.error, 'critical_reviewer_floor');

  const deferred = synthesizeReviewRound({
    attempts: [attempt('claude-opus')],
    routingPlan: routingPlan({
      shadow_mode: true,
      routes: [baseRoutes()[0]],
      candidate_reviewers: candidates.slice(0, 1),
    }),
    // O22 (D17) — shadow mode consumes the same structured carrier as an active
    // round. A shadow-only bare-id seam is how a shadow run stops predicting the
    // active one, so the fixture that feeds it is deliberately identical.
    deferredAcceptance: {
      complete: false,
      pending_finding_refs: [{ finding_id: 'DOC-1', reviewer_id: 'claude-opus' }],
    },
  });
  assert.equal(deferred.verdict, 'CONCERN');
  assert.equal(deferred.deferred_acceptance_floor, true);
  assert.deepEqual(deferred.pending_deferred_finding_refs, [
    { finding_id: 'DOC-1', reviewer_id: 'claude-opus' },
  ]);
  assert.throws(() => synthesizeReviewRound({
    attempts: [attempt('claude-opus')],
    routingPlan: routingPlan({
      shadow_mode: true,
      routes: [baseRoutes()[0]],
      candidate_reviewers: candidates.slice(0, 1),
    }),
    deferredAcceptance: { complete: false, pending_finding_ids: ['DOC-1'] },
  }), /deferredAcceptance is malformed/);
});

test('protocol-3 synthesis rejects duplicate or non-canonical reviewer voices before N_actual', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const duplicate = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('claude-opus')],
    routingPlan: routingPlan(),
  });
  assert.equal(duplicate.status, 'operational_failure');
  assert.equal(duplicate.verdict, null);
  assert.equal(duplicate.error, 'invalid_reviewer_identity');

  const forged = synthesizeReviewRound({
    attempts: [attempt('security-reviewer')],
    routingPlan: routingPlan(),
  });
  assert.equal(forged.status, 'operational_failure');
  assert.equal(forged.n_actual, 0);
  assert.equal(forged.error, 'invalid_reviewer_identity');
});

test('protocol-3 synthesis rejects a canonical reviewer_id and role identity swap', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const result = synthesizeReviewRound({
    attempts: [
      { ...attempt('claude-opus'), reviewer_id: 'codex-review' },
      { ...attempt('codex-review'), reviewer_id: 'claude-opus' },
    ],
    consensus: { findings: [] },
    routingPlan: routingPlan(),
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'invalid_reviewer_identity');
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('protocol-3 synthesis requires reviewer_id on every included attempt', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const withoutReviewerId = { ...attempt('claude-opus') };
  delete withoutReviewerId.reviewer_id;
  const result = synthesizeReviewRound({
    attempts: [withoutReviewerId, attempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: routingPlan(),
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'invalid_reviewer_identity');
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('protocol-3 synthesis validates excluded attempt identities before expansion bookkeeping', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const swappedExcludedAttempt = {
    ...attempt('codex-review', { included: false, exclusion: 'timeout' }),
    role: 'agy',
  };
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), swappedExcludedAttempt],
    routingPlan: routingPlan(),
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'invalid_reviewer_identity');
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
});

test('protocol-3 synthesis requires a SHA-256 output digest on every included attempt', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  for (const outputDigest of [undefined, 'not-a-sha256']) {
    const withoutTrustedDigest = { ...attempt('claude-opus'), output_digest: outputDigest };
    const result = synthesizeReviewRound({
      attempts: [withoutTrustedDigest, attempt('codex-review')],
      consensus: { findings: [] },
      routingPlan: routingPlan(),
    });
    assert.equal(result.status, 'operational_failure');
    assert.equal(result.error, 'invalid_reviewer_identity');
    assert.equal(result.verdict, null);
    assert.equal(result.phase6_allowed, false);
  }
});

test('protocol-3 synthesis rejects candidate voices without a selected route', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const result = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('codex-review'),
      attempt('agy'),
    ],
    consensus: { findings: [] },
    routingPlan: routingPlan(),
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.error, 'invalid_reviewer_identity');
  assert.equal(result.verdict, null);
});

// A canonical Grok voice is one voice, not a bonus one: it raises N_actual and
// the provider-family count by exactly one each (I2).
test('T-SYN-1 a trusted Grok attempt contributes one canonical voice', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const threeVoicePlan = () => routingPlan({
    candidate_reviewers: [...candidates, grokCandidate],
    routes: [...baseRoutes(), agyRoute()],
  });
  const fourVoicePlan = () => routingPlan({
    candidate_reviewers: [...candidates, grokCandidate],
    routes: [...baseRoutes(), agyRoute(), grokRoute()],
  });
  const withoutGrok = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review'), attempt('agy')],
    consensus: { findings: [] },
    routingPlan: threeVoicePlan(),
  });
  assert.equal(withoutGrok.status, 'reviewed');
  assert.equal(withoutGrok.n_actual, 3);
  assert.equal(withoutGrok.provider_families, 3);

  const withGrok = synthesizeReviewRound({
    attempts: [
      attempt('claude-opus'),
      attempt('codex-review'),
      attempt('agy'),
      attempt('grok'),
    ],
    consensus: { findings: [] },
    routingPlan: fourVoicePlan(),
  });
  assert.equal(withGrok.status, 'reviewed');
  assert.equal(withGrok.verdict, 'APPROVE');
  assert.equal(withGrok.phase6_allowed, true);
  assert.deepEqual(withGrok.exclusions, []);
  assert.equal(withGrok.needs_expansion, false);
  // Exactly one voice and exactly one new provider family, against the same
  // round without it — neither uncounted nor counted twice.
  assert.equal(withGrok.n_actual, withoutGrok.n_actual + 1);
  assert.equal(withGrok.provider_families, withoutGrok.provider_families + 1);
  assert.equal(withGrok.n_actual, 4);
  assert.equal(withGrok.provider_families, 4);
});

test('T-SYN-2 plan-absent or duplicate Grok voice is operational failure with Phase 6 false', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  // Absent from the trusted plan: a Grok voice no route selected.
  const planAbsent = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review'), attempt('grok')],
    consensus: { findings: [] },
    routingPlan: routingPlan(),
  });
  assert.equal(planAbsent.status, 'operational_failure');
  assert.equal(planAbsent.error, 'invalid_reviewer_identity');
  assert.equal(planAbsent.verdict, null);
  assert.equal(planAbsent.phase6_allowed, false);

  // Routed, but speaking twice.
  const duplicate = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('grok'), attempt('grok')],
    consensus: { findings: [] },
    routingPlan: routingPlan({
      candidate_reviewers: [...candidates, grokCandidate],
      routes: [...baseRoutes(), agyRoute(), grokRoute()],
    }),
  });
  assert.equal(duplicate.status, 'operational_failure');
  assert.equal(duplicate.error, 'invalid_reviewer_identity');
  assert.equal(duplicate.verdict, null);
  assert.equal(duplicate.phase6_allowed, false);
  // `n_actual` is deliberately unpinned on this branch: it is diagnostic here,
  // because the shared counter may already have counted one canonical id before
  // the identity failure was raised. The non-canonical `security-reviewer`
  // polarity keeps its own `n_actual: 0` and is not restated through Grok.
});

test('a routing-plan operational failure cannot emit a verdict or allow Phase 6', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const result = synthesizeReviewRound({
    attempts: [attempt('claude-opus')],
    routingPlan: routingPlan({
      operational_failure: true,
      shortfalls: ['required_provider:codex'],
      routes: [baseRoutes()[0]],
    }),
  });
  assert.equal(result.status, 'operational_failure');
  assert.equal(result.n_actual, 0);
  assert.equal(result.verdict, null);
  assert.equal(result.phase6_allowed, false);
  assert.equal(result.error, 'routing_plan_operational_failure');
  assert.deepEqual(result.routing_shortfalls, ['required_provider:codex']);
});

// T-READY-8 (D17) — readiness independence is never something a report can
// claim for itself. Dispatch binds a fresh opaque `attempt_id` to one parsed
// protocol-3 route before the attempt runs; final production synthesis
// re-derives every admitted field from that trusted dispatch record and the
// immutable routing plan, seals the result once, and the coordinator hands the
// carrier to document readiness verbatim. No field is reconstructed from a
// reviewer id, a provider string, a report path, or prose inside the report.
function executionRouteFor(plan, reviewerId) {
  const route = (plan.routes || []).find((item) => item.reviewer_id === reviewerId);
  if (!route) throw new Error(`fixture has no planned route for ${reviewerId}`);
  return { protocol_version: '3.0', ...route };
}

function dispatchRecordFor(plan, reviewerId, overrides = {}) {
  const route = executionRouteFor(plan, reviewerId);
  return {
    attempt_id: `attempt-${reviewerId}`,
    reviewer_id: reviewerId,
    provider_family: route.provider,
    execution_route: route,
    route_sha256: sha256(canonicalStringify(route)),
    output_sha256: sha256(`review:${reviewerId}`),
    model: route.resolved.model ?? null,
    session_id: `session-${reviewerId}`,
    compatibility_evidence_sha256: route.grok_compatibility_evidence?.evidence_sha256 ?? null,
    ...overrides,
  };
}

function trustedDispatch(plan, reviewerIds, overrides = {}) {
  return {
    round_id: 'round-1',
    routing_plan_sha256: sha256(canonicalStringify(plan)),
    records: reviewerIds.map((reviewerId) => dispatchRecordFor(plan, reviewerId)),
    ...overrides,
  };
}

// Rebuilt here from the record's own fields rather than imported, so the seal
// is checked against an independent computation and not against itself.
function admissionRecordDigest(record) {
  return sha256(canonicalStringify({
    attempt_id: record.attempt_id,
    output_sha256: record.output_sha256,
    provider_family: record.provider_family,
    reviewer_id: record.reviewer_id,
    route_sha256: record.route_sha256,
  }));
}

test('T-READY-8 final synthesis seals trusted attempt and route evidence for readiness', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const plan = routingPlan();
  const attempts = [attempt('claude-opus'), attempt('codex-review')];
  const round = synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: plan,
    dispatch: trustedDispatch(plan, ['claude-opus', 'codex-review']),
  });
  assert.equal(round.status, 'reviewed');
  assert.equal(round.verdict, 'APPROVE');
  assert.equal(round.phase6_allowed, true);

  const carrier = round.readiness_admission;
  assert.ok(carrier, 'final production synthesis emits one sealed readiness_admission');
  assert.equal(carrier.schema_version, '1.0');
  assert.equal(carrier.round_id, 'round-1');
  assert.equal(carrier.routing_plan_sha256, sha256(canonicalStringify(plan)));
  assert.deepEqual(
    carrier.records.map((record) => record.attempt_id),
    ['attempt-claude-opus', 'attempt-codex-review'],
  );
  for (const record of carrier.records) {
    const planned = executionRouteFor(plan, record.reviewer_id);
    // Every admitted field is the trusted route's, recomputed here from the
    // plan — not the dispatch record's own assertion echoed back.
    assert.equal(record.provider_family, planned.provider);
    assert.equal(record.route_sha256, sha256(canonicalStringify(planned)));
    assert.equal(record.output_sha256, sha256(`review:${record.reviewer_id}`));
    assert.equal(record.admission_sha256, admissionRecordDigest(record));
    // The carrier is closed: the execution route, model, and session that
    // authorised the record stay in the dispatch record and never leak into
    // the sealed evidence.
    assert.deepEqual(Object.keys(record).sort(), [
      'admission_sha256',
      'attempt_id',
      'output_sha256',
      'provider_family',
      'reviewer_id',
      'route_sha256',
    ]);
  }
  const { carrier_sha256: seal, ...carrierBody } = carrier;
  assert.equal(seal, sha256(canonicalStringify(carrierBody)));

  const refused = (dispatch, roundAttempts = attempts) => synthesizeReviewRound({
    attempts: roundAttempts,
    consensus: { findings: [] },
    routingPlan: plan,
    dispatch,
  });
  const mutatedDispatch = (mutate) => {
    const dispatch = trustedDispatch(plan, ['claude-opus', 'codex-review']);
    mutate(dispatch);
    return dispatch;
  };

  // Every failure mode names itself, so one negative cannot pass for another
  // negative's reason.
  for (const [reason, dispatch] of [
    // Reconstructing the output digest from anything but the admitted attempt.
    ['output_digest_mismatch', mutatedDispatch((dispatch) => {
      dispatch.records[0].output_sha256 = sha256('review:some-other-report');
    })],
    // A provider string the trusted route did not authorise.
    ['provider_mismatch', mutatedDispatch((dispatch) => {
      dispatch.records[0].provider_family = 'codex';
    })],
    ['model_mismatch', mutatedDispatch((dispatch) => {
      dispatch.records[0].model = 'forged-model';
    })],
    ['session_identity_invalid', mutatedDispatch((dispatch) => {
      dispatch.records[0].session_id = '';
    })],
    ['session_identity_invalid', mutatedDispatch((dispatch) => {
      dispatch.records[1].session_id = dispatch.records[0].session_id;
    })],
    ['route_digest_mismatch', mutatedDispatch((dispatch) => {
      dispatch.records[0].route_sha256 = sha256('not this route');
    })],
    // Self-consistent, parseable, and absent from the immutable plan.
    ['unplanned_route', mutatedDispatch((dispatch) => {
      const route = { ...dispatch.records[0].execution_route, selection_reason: 'off-plan route' };
      dispatch.records[0].execution_route = route;
      dispatch.records[0].route_sha256 = sha256(canonicalStringify(route));
    })],
    ['duplicate_attempt_id', mutatedDispatch((dispatch) => {
      dispatch.records[1].attempt_id = dispatch.records[0].attempt_id;
    })],
    ['duplicate_route_identity', mutatedDispatch((dispatch) => {
      dispatch.records[1] = dispatchRecordFor(plan, 'claude-opus', {
        attempt_id: 'attempt-replayed',
        session_id: 'session-replayed',
      });
    })],
    ['routing_plan_seal_mismatch', mutatedDispatch((dispatch) => {
      dispatch.routing_plan_sha256 = sha256('a different routing plan');
    })],
    ['admission_join_not_one_to_one', trustedDispatch(plan, ['claude-opus'])],
    ['dispatch_malformed', mutatedDispatch((dispatch) => {
      dispatch.round_id = '';
    })],
  ]) {
    const result = refused(dispatch);
    assert.equal(result.status, 'operational_failure', reason);
    assert.equal(result.error, 'invalid_readiness_admission', reason);
    assert.equal(result.readiness_admission_error, reason);
    assert.equal(result.verdict, null, reason);
    assert.equal(result.phase6_allowed, false, reason);
    assert.equal(Object.hasOwn(result, 'readiness_admission'), false, reason);
  }

  // An admission record nobody consumed is the same failure from the other
  // side: one attempt, one record, never one-and-a-spare.
  const spare = refused(
    trustedDispatch(plan, ['claude-opus', 'codex-review']),
    [attempt('claude-opus')],
  );
  assert.equal(spare.error, 'invalid_readiness_admission');
  assert.equal(spare.readiness_admission_error, 'admission_join_not_one_to_one');

  // Grok's compatibility evidence is validated for that exact attempt id, and
  // no other reviewer may claim any.
  const grokIds = ['claude-opus', 'codex-review', 'agy', 'grok'];
  const grokPlan = routingPlan({
    candidate_reviewers: [...candidates, grokCandidate],
    routes: [...baseRoutes(), agyRoute(), grokRoute()],
  });
  const grokAttempts = grokIds.map((reviewerId) => attempt(reviewerId));
  const grokAdmitted = synthesizeReviewRound({
    attempts: grokAttempts,
    consensus: { findings: [] },
    routingPlan: grokPlan,
    dispatch: trustedDispatch(grokPlan, grokIds),
  });
  assert.equal(grokAdmitted.status, 'reviewed');
  assert.equal(grokAdmitted.readiness_admission.records.length, 4);
  for (const mutate of [
    (dispatch) => { dispatch.records[3].compatibility_evidence_sha256 = 'f'.repeat(64); },
    (dispatch) => { dispatch.records[0].compatibility_evidence_sha256 = 'f'.repeat(64); },
    (dispatch) => { dispatch.records[3].compatibility_evidence_sha256 = null; },
  ]) {
    const dispatch = trustedDispatch(grokPlan, grokIds);
    mutate(dispatch);
    const result = synthesizeReviewRound({
      attempts: grokAttempts,
      consensus: { findings: [] },
      routingPlan: grokPlan,
      dispatch,
    });
    assert.equal(result.status, 'operational_failure');
    assert.equal(result.readiness_admission_error, 'compatibility_evidence_mismatch');
  }

  // The carrier is emitted only by *final production* synthesis. A shadow round
  // is not production and an expansion round is not final.
  const shadowPlan = routingPlan({
    shadow_mode: true,
    routes: [baseRoutes()[0]],
    candidate_reviewers: candidates.slice(0, 1),
  });
  const shadow = synthesizeReviewRound({
    attempts: [attempt('claude-opus')],
    consensus: { findings: [] },
    routingPlan: shadowPlan,
    dispatch: trustedDispatch(shadowPlan, ['claude-opus']),
  });
  assert.equal(shadow.status, 'reviewed');
  assert.equal(shadow.shadow_mode, true);
  assert.equal(Object.hasOwn(shadow, 'readiness_admission'), false);

  const expanding = synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: plan,
    readinessMismatch: true,
    dispatch: trustedDispatch(plan, ['claude-opus', 'codex-review']),
  });
  assert.equal(expanding.status, 'needs_expansion');
  assert.equal(Object.hasOwn(expanding, 'readiness_admission'), false);

  // And a round that was never handed a dispatch record emits nothing at all,
  // rather than inventing a carrier from the attempts it happens to hold.
  const undispatched = synthesizeReviewRound({
    attempts,
    consensus: { findings: [] },
    routingPlan: plan,
  });
  assert.equal(undispatched.status, 'reviewed');
  assert.equal(Object.hasOwn(undispatched, 'readiness_admission'), false);
});

function toleratedAttempt(role) {
  return {
    reviewer_id: role,
    role,
    output_digest: createHash('sha256').update(`review:${role}`).digest('hex'),
    included: true,
    exclusion: null,
    verdict: 'APPROVE',
    issues: { critical: 0, warning: 0, info: 0 },
    tolerances: ['missing_code_review_heading'],
  };
}

test('evaluateReviewerAttempt carries exclusion_detail and tolerances (T6)', async () => {
  const { evaluateReviewerAttempt, diagnoseReviewerReport } = await import(synthesisUrl);
  const fingerprint = { mode: 'hybrid', digest: 'unchanged', error: null };
  const missingContainer = canonicalReviewerReport().replace('\n## Code Review\n', '\n');
  const admitted = evaluateReviewerAttempt({
    reviewer_id: 'claude-opus',
    role: 'claude-opus',
    output: missingContainer,
    beforeFingerprint: fingerprint,
    afterFingerprint: fingerprint,
  });
  assert.equal(admitted.included, true);
  assert.deepEqual(admitted.tolerances, ['missing_code_review_heading']);
  assert.equal(Object.hasOwn(admitted, 'exclusion_detail'), false);

  const mismatched = evaluateReviewerAttempt({
    reviewer_id: 'claude-opus',
    role: 'claude-opus',
    output: missingContainer,
    beforeFingerprint: fingerprint,
    afterFingerprint: { mode: 'hybrid', digest: 'changed', error: null },
  });
  assert.equal(mismatched.exclusion, 'fingerprint_mismatch');
  assert.equal(Object.hasOwn(mismatched, 'exclusion_detail'), false);

  assert.notEqual(diagnoseReviewerReport('not a report').failure, 'invalid_encoding');
  assert.notEqual(diagnoseReviewerReport('\uFFFD').failure, 'invalid_encoding');
});

test('synthesizeReviewRound attaches admitted_with_tolerances on every return (T6)', async () => {
  const { synthesizeReviewRound } = await import(synthesisUrl);
  const provenance = {
    admitted_with_tolerances: [
      { reviewer_id: 'claude-opus', tolerances: ['missing_code_review_heading'] },
      { reviewer_id: 'codex-review', tolerances: ['missing_code_review_heading'] },
    ],
  };
  const reversed = [toleratedAttempt('codex-review'), toleratedAttempt('claude-opus')];

  const operational = synthesizeReviewRound({
    attempts: reversed,
    routingPlan: routingPlan({ operational_failure: true, shortfalls: ['denied'] }),
  });
  assert.equal(operational.error, 'routing_plan_operational_failure');
  assert.deepEqual(operational.admitted_with_tolerances, provenance.admitted_with_tolerances);

  const planIdentity = synthesizeReviewRound({
    attempts: reversed,
    routingPlan: routingPlan({ routes: [] }),
  });
  assert.equal(planIdentity.error, 'invalid_routing_plan_identity');
  assert.deepEqual(planIdentity.admitted_with_tolerances, provenance.admitted_with_tolerances);

  const waveIdentity = synthesizeReviewRound({
    attempts: reversed,
    routingPlan: routingPlan(),
    expansionWavesUsed: 1,
  });
  assert.equal(waveIdentity.error, 'invalid_routing_plan_identity');
  assert.deepEqual(waveIdentity.admitted_with_tolerances, provenance.admitted_with_tolerances);

  const reviewerIdentity = synthesizeReviewRound({
    attempts: reversed.map((row, index) => (
      index === 0 ? { ...row, role: 'codex-adversarial' } : row
    )),
    routingPlan: routingPlan(),
  });
  assert.equal(reviewerIdentity.error, 'invalid_reviewer_identity');
  assert.deepEqual(reviewerIdentity.admitted_with_tolerances, provenance.admitted_with_tolerances);

  const readiness = synthesizeReviewRound({
    attempts: reversed,
    consensus: { findings: [] },
    routingPlan: routingPlan(),
    dispatch: { round_id: 'round-1', records: [] },
  });
  assert.equal(readiness.error, 'invalid_readiness_admission');
  assert.deepEqual(readiness.admitted_with_tolerances, provenance.admitted_with_tolerances);

  const required = synthesizeReviewRound({
    attempts: [
      toleratedAttempt('claude-opus'),
      attempt('codex-review', { included: false, exclusion: 'privacy_declined' }),
    ],
    routingPlan: routingPlan({
      required_reviewer_ids: ['codex-review'],
      routes: baseRoutes().map((route) => (
        route.reviewer_id === 'codex-review'
          ? {
            ...route,
            required: true,
            selection_reason: 'explicit reviewer override requires this canonical reviewer',
          }
          : route
      )),
    }),
  });
  assert.equal(required.error, 'required_reviewer_unavailable');
  assert.deepEqual(required.admitted_with_tolerances, [
    { reviewer_id: 'claude-opus', tolerances: ['missing_code_review_heading'] },
  ]);

  const expanding = synthesizeReviewRound({
    attempts: reversed,
    consensus: { findings: [] },
    routingPlan: routingPlan(),
    readinessMismatch: true,
  });
  assert.equal(expanding.status, 'needs_expansion');
  assert.deepEqual(expanding.admitted_with_tolerances, provenance.admitted_with_tolerances);

  const floor = synthesizeReviewRound({
    attempts: reversed,
    consensus: { findings: [] },
    routingPlan: routingPlan({
      artifact_phase: 'implementation',
      risk: 'critical',
      planned_reviewers: 3,
      minimum_reviewers: 3,
      max_expansion_waves: 0,
    }),
  });
  assert.equal(floor.error, 'critical_reviewer_floor');
  assert.deepEqual(floor.admitted_with_tolerances, provenance.admitted_with_tolerances);

  const consensus = synthesizeReviewRound({
    attempts: reversed,
    routingPlan: routingPlan({
      planned_reviewers: 2,
      minimum_reviewers: 2,
      max_expansion_waves: 0,
    }),
  });
  assert.equal(consensus.error, 'consensus_required');
  assert.deepEqual(consensus.admitted_with_tolerances, provenance.admitted_with_tolerances);

  const reviewed = synthesizeReviewRound({
    attempts: reversed,
    consensus: { findings: [] },
    routingPlan: routingPlan(),
  });
  assert.equal(reviewed.status, 'reviewed');
  assert.deepEqual(reviewed.admitted_with_tolerances, provenance.admitted_with_tolerances);
  assert.equal(Object.hasOwn(reviewed, 'readiness_admission'), false);

  const strictOnly = synthesizeReviewRound({
    attempts: [attempt('claude-opus'), attempt('codex-review')],
    consensus: { findings: [] },
    routingPlan: routingPlan(),
  });
  assert.equal(strictOnly.status, 'reviewed');
  assert.equal(Object.hasOwn(strictOnly, 'admitted_with_tolerances'), false);
});

test('report-format Provenance documents exclusion_detail and leaf D16 skeleton (T6)', () => {
  const format = require('node:fs').readFileSync(
    path.join(root, 'skills/deep-review-workflow/references/report-format.md'),
    'utf8',
  );
  assert.match(format, /exclusion_detail/u);
  assert.match(format, /tolerances/u);
  assert.match(format, /D16 OUTPUT CONTRACT/u);
  assert.match(format, /synthesis-only sections\s+are not leaf requirements/u);
});
