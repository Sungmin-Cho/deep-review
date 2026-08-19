'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const policyUrl = pathToFileURL(path.join(root, 'hooks/scripts/lib/review-policy.mjs')).href;

test('review policy parses nested maps/lists and preserves unknown fields with warnings', async () => {
  const { parseReviewPolicy } = await import(policyUrl);
  const result = parseReviewPolicy(`
schema_version: 2
features:
  semantic_classifier: true
routing:
  policy: quality
classification:
  overrides:
    - glob: "docs/**"
      kind: design-document
future_field:
  enabled: true
`);
  assert.equal(result.policy.features.semantic_classifier, true);
  assert.equal(result.policy.routing.policy, 'quality');
  assert.deepEqual(result.policy.classification.overrides, [{ glob: 'docs/**', kind: 'design-document' }]);
  assert.equal(result.policy.future_field.enabled, true);
  assert.ok(result.warnings.some((warning) => warning.includes('future_field')));
});

test('review policy rejects duplicate keys, aliases, anchors, tags, and wrong schema', async () => {
  const { parseReviewPolicy } = await import(policyUrl);
  assert.throws(() => parseReviewPolicy('schema_version: 2\nrouting:\n  policy: auto\n  policy: fast\n'), /duplicate/i);
  assert.throws(() => parseReviewPolicy('schema_version: 2\nx: &shared value\n'), /anchor|alias/i);
  assert.throws(() => parseReviewPolicy('schema_version: 2\nx: *shared\n'), /anchor|alias/i);
  assert.throws(() => parseReviewPolicy('schema_version: 2\nx: !thing value\n'), /tag/i);
  assert.throws(() => parseReviewPolicy('schema_version: 1\n'), /schema_version.*2/i);
  assert.throws(
    () => parseReviewPolicy('schema_version: 2\nclassification:\n  overrides:\n    - glob: "docs/**"\n      kind: typo-document\n'),
    /classification\.overrides\[0\].*invalid/i,
  );
  assert.throws(
    () => parseReviewPolicy('schema_version: 2\nclassification:\n  overrides:\n    - glob: ""\n      kind: design-document\n'),
    /classification\.overrides\[0\].*invalid/i,
  );
});

// R2I3: __proto__/constructor/prototype mapping keys must fail parsing with a
// clear error naming the offending line, instead of being silently dropped by
// deepMerge — weak defense-in-depth for a committed config file.
test('R2I3: __proto__/constructor mapping keys are rejected as unsafe, but a benign prototype_notes key still parses', async () => {
  const { parseReviewPolicy } = await import(policyUrl);
  assert.throws(
    () => parseReviewPolicy('schema_version: 2\nproviders:\n  __proto__:\n    enabled: true\n'),
    /unsafe mapping key "__proto__"/,
  );
  assert.throws(
    () => parseReviewPolicy('schema_version: 2\nconstructor: value\n'),
    /unsafe mapping key "constructor"/,
  );
  assert.throws(
    () => parseReviewPolicy('schema_version: 2\nclassification:\n  overrides:\n    - prototype: value\n'),
    /unsafe mapping key "prototype"/,
  );
  const benign = parseReviewPolicy('schema_version: 2\nprototype_notes: true\n');
  assert.equal(benign.policy.prototype_notes, true);
});

test('loaders resolve project, XDG, and Windows APPDATA config locations', async () => {
  const { loadReviewPolicy, loadUserConfig, userConfigPath } = await import(policyUrl);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-policy-'));
  const projectDir = path.join(temp, '.deep-review');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'review-policy.yaml'), 'schema_version: 2\nrouting:\n  policy: fast\n');
  assert.equal(loadReviewPolicy(temp).policy.routing.policy, 'fast');
  assert.equal(loadReviewPolicy(path.join(temp, 'missing')), null);

  const xdg = path.join(temp, 'xdg');
  fs.mkdirSync(path.join(xdg, 'deep-review'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'deep-review', 'config.yaml'), 'schema_version: 2\nfeatures:\n  routing_shadow_mode: true\n');
  assert.equal(loadUserConfig({ XDG_CONFIG_HOME: xdg }, 'linux').policy.features.routing_shadow_mode, true);
  assert.equal(userConfigPath({ APPDATA: 'C:\\Users\\Me\\AppData\\Roaming' }, 'win32'), path.win32.join('C:\\Users\\Me\\AppData\\Roaming', 'deep-review', 'config.yaml'));
});

// I2: classification.size_thresholds must be a known schema field (not just an
// unrecognized-but-preserved one) so review-policy.yaml can actually express
// the size thresholds that buildRoutingPlan already reads.
test('I2: classification.size_thresholds is a known schema field and surfaces its parsed value with no warning', async () => {
  const { parseReviewPolicy } = await import(policyUrl);
  const result = parseReviewPolicy(`
schema_version: 2
classification:
  size_thresholds:
    code: [50, 200, 800]
    document: [1024, 4096, 16384]
`);
  assert.deepEqual(result.policy.classification.size_thresholds.code, [50, 200, 800]);
  assert.deepEqual(result.policy.classification.size_thresholds.document, [1024, 4096, 16384]);
  assert.ok(
    !result.warnings.some((warning) => warning.includes('classification.size_thresholds')),
    'classification.size_thresholds must be a recognized field, not an unknown-field warning',
  );
});

test('merge precedence is defaults < user < project < CLI while project enforced deny wins', async () => {
  const { mergeRoutingConfig } = await import(policyUrl);
  const merged = mergeRoutingConfig({
    defaults: { routing: { policy: 'auto' }, constraints: { deny_models: ['base-deny'] } },
    user: { routing: { policy: 'fast' }, providers: { claude: { enabled: true } } },
    project: { routing: { policy: 'balanced' }, constraints: { deny_models: ['forbidden'], allowed_providers: ['claude'] } },
    cli: { routing_policy: 'quality', providers: { claude: { model: 'forbidden' } } },
  });
  assert.equal(merged.routing.policy, 'quality');
  assert.equal(merged.providers.claude.model, 'forbidden');
  assert.deepEqual(merged.constraints.deny_models, ['forbidden']);
  assert.deepEqual(merged.constraints.allowed_providers, ['claude']);
});

test('v2 policy schema recognizes adaptive reviewer routing and convergence limits', async () => {
  const { parseReviewPolicy, mergeRoutingConfig } = await import(policyUrl);
  const source = [
    'schema_version: 2',
    'features:',
    '  adaptive_reviewer_routing: true',
    '  automatic_model_routing: true',
    '  routing_shadow_mode: false',
    'routing:',
    '  reviewer_strategy: adaptive',
    '  document_round_limit: 2',
    '  high_risk_document_round_limit: 3',
    '  maximum_reviewers: 4',
    '  max_expansion_waves: 1',
  ].join('\n');
  const parsed = parseReviewPolicy(source);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.policy.features.adaptive_reviewer_routing, true);
  assert.equal(parsed.policy.routing.reviewer_strategy, 'adaptive');
  assert.equal(parsed.policy.routing.document_round_limit, 2);
  assert.equal(parsed.policy.routing.high_risk_document_round_limit, 3);
  assert.equal(parsed.policy.routing.maximum_reviewers, 4);
  assert.equal(parsed.policy.routing.max_expansion_waves, 1);

  const merged = mergeRoutingConfig({
    defaults: parsed.policy,
    cli: { reviewer_strategy: 'static' },
  });
  assert.equal(merged.routing.reviewer_strategy, 'static');
});

// The rejection polarity alone stays green under a cap of four, so the ceiling
// needs its own positive: five reviewers is exactly REVIEWER_IDS.length.
test('the reviewer ceiling admits every canonical reviewer and rejects one more', async () => {
  const { parseReviewPolicy } = await import(policyUrl);
  const { REVIEWER_IDS } = await import(
    pathToFileURL(path.join(root, 'hooks/scripts/lib/reviewer-ids.mjs')).href
  );
  assert.equal(REVIEWER_IDS.length, 5);

  for (let ceiling = 1; ceiling <= REVIEWER_IDS.length; ceiling += 1) {
    const parsed = parseReviewPolicy(`schema_version: 2\nrouting:\n  maximum_reviewers: ${ceiling}\n`);
    assert.equal(parsed.policy.routing.maximum_reviewers, ceiling, `maximum_reviewers: ${ceiling}`);
    assert.deepEqual(parsed.warnings, [], `maximum_reviewers: ${ceiling}`);
  }
  assert.throws(
    () => parseReviewPolicy(`schema_version: 2\nrouting:\n  maximum_reviewers: ${REVIEWER_IDS.length + 1}\n`),
    new RegExp(`1 through ${REVIEWER_IDS.length}`),
  );
});

test('adaptive policy enums, booleans, and convergence limits fail closed on malformed values', async () => {
  const { parseReviewPolicy } = await import(policyUrl);
  for (const [body, message] of [
    ['features:\\n  adaptive_reviewer_routing: yes', /must be boolean/],
    ['routing:\\n  reviewer_strategy: random', /adaptive or static/],
    ['routing:\\n  document_round_limit: 0', /positive integer/],
    ['routing:\\n  high_risk_document_round_limit: 2.5', /positive integer/],
    ['routing:\\n  maximum_reviewers: 6', /1 through 5/],
    ['routing:\\n  max_expansion_waves: 2', /must be 0 or 1/],
  ]) {
    assert.throws(
      () => parseReviewPolicy(`schema_version: 2\n${body.replaceAll('\\n', '\n')}\n`),
      message,
    );
  }
});
