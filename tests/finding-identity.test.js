'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { report } = require('./helpers/review-accuracy-fixtures.js');

const pluginRoot = resolve(__dirname, '..');
const modulePath = join(pluginRoot, 'hooks', 'scripts', 'lib', 'finding-identity.mjs');
const moduleUrl = pathToFileURL(modulePath).href;

async function loadIdentity() {
  return import(moduleUrl);
}

test('extractFindingState treats one bullet with three citations as one observation', async () => {
  const { extractFindingState } = await loadIdentity();
  const state = extractFindingState(report({
    warning: [
      'Retry exhaustion crosses `src/retry.js:20`, `src/caller.js:44`, and `tests/retry.test.js:71`; preserve 3 attempts.',
    ],
  }));

  assert.equal(state.schema_version, 1);
  assert.equal(state.status, 'complete');
  assert.equal(state.expected_count, 1);
  assert.equal(state.findings.length, 1);
  assert.deepEqual(state.findings[0].locations, [
    { path: 'src/retry.js', line: 20 },
    { path: 'src/caller.js', line: 44 },
    { path: 'tests/retry.test.js', line: 71 },
  ]);
  assert.deepEqual(state.findings[0].primary_location, { path: 'src/retry.js', line: 20 });
  assert.equal(state.findings[0].claim, 'Retry exhaustion crosses , , and ; preserve 3 attempts.');
  assert.match(state.findings[0].claim_key, /^[0-9a-f]{64}$/u);
  assert.equal(state.findings[0].finding_id, `F-${state.findings[0].claim_key}`);
});

test('missing location retains the observation and makes its state indeterminate', async () => {
  const { extractFindingState } = await loadIdentity();
  const state = extractFindingState(report({ warning: ['Retry bound; preserve 3 attempts.'] }));

  assert.equal(state.status, 'indeterminate');
  assert.equal(state.expected_count, 1);
  assert.equal(state.findings.length, 1);
  assert.equal(state.findings[0].primary_location, null);
  assert.ok(state.reasons.includes('missing_location:warning:1'));
});

test('exact claim identity survives +7 and +100 line moves', async () => {
  const { extractFindingState, compareFindingStates, reconcileFindingStates } = await loadIdentity();
  const before = extractFindingState(report({ warning: ['Retry bound at `src/a.js:20`; preserve 3 attempts.'] }));
  for (const line of [27, 120]) {
    const after = extractFindingState(report({ warning: [`Retry bound at \`src/a.js:${line}\`; preserve 3 attempts.`] }));
    const comparison = compareFindingStates(before, after);
    assert.deepEqual(comparison, {
      identity_status: 'complete',
      repeated_count: 1,
      newly_observed_count: 0,
      not_reobserved_count: 0,
      severity_changes: [],
      progress: 'stalled',
    });
    assert.equal(reconcileFindingStates(before, after).findings[0].finding_id, before.findings[0].finding_id);
  }
});

test('the same claim retains identity across Critical to Warning and reports the severity change', async () => {
  const { extractFindingState, compareFindingStates } = await loadIdentity();
  const before = extractFindingState(report({ critical: ['Unchecked write at `src/store.js:8` corrupts saved state.'] }));
  const after = extractFindingState(report({ warning: ['Unchecked write at `src/store.js:99` corrupts saved state.'] }));
  const comparison = compareFindingStates(before, after);

  assert.equal(before.findings[0].finding_id, after.findings[0].finding_id);
  assert.equal(comparison.repeated_count, 1);
  assert.deepEqual(comparison.severity_changes, [{
    finding_id: before.findings[0].finding_id,
    from: 'critical',
    to: 'warning',
  }]);
  assert.equal(comparison.progress, 'changed');
});

test('different claims at the same line stay distinct observations', async () => {
  const { extractFindingState, compareFindingStates } = await loadIdentity();
  const before = extractFindingState(report({ warning: ['Retry limit is ignored at `src/a.js:20`.'] }));
  const after = extractFindingState(report({ warning: ['Timeout is swallowed at `src/a.js:20`.'] }));
  const comparison = compareFindingStates(before, after);

  assert.notEqual(before.findings[0].claim_key, after.findings[0].claim_key);
  assert.equal(comparison.repeated_count, 0);
  assert.equal(comparison.newly_observed_count, 1);
  assert.equal(comparison.not_reobserved_count, 1);
  assert.equal(comparison.progress, 'changed');
});

test('duplicate exact claims are retained but make reconciliation indeterminate', async () => {
  const { extractFindingState, compareFindingStates } = await loadIdentity();
  const duplicate = extractFindingState(report({ warning: [
    'Retry limit is ignored at `src/a.js:20`.',
    'Retry limit is ignored at `src/a.js:80`.',
  ] }));

  assert.equal(duplicate.findings.length, 2);
  assert.equal(duplicate.status, 'indeterminate');
  assert.ok(duplicate.reasons.some((reason) => reason.startsWith('duplicate_claim_key:')));
  assert.equal(compareFindingStates(duplicate, duplicate).progress, 'indeterminate');
});

test('claim normalization excludes labels and Markdown while preserving Unicode and numeric constants', async () => {
  const { extractFindingState } = await loadIdentity();
  const plain = extractFindingState(report({ warning: ['경계 3회가 ✓ 없이 우회됩니다 at `src/한글.js:10`.'] }));
  const presented = extractFindingState(report({ warning: ['**[W7]** 경계 **3회**가 `✓` 없이 우회됩니다 at `src/한글.js:999`.'] }));
  const differentConstant = extractFindingState(report({ warning: ['경계 4회가 ✓ 없이 우회됩니다 at `src/한글.js:10`.'] }));

  assert.equal(plain.status, 'complete');
  assert.equal(presented.status, 'complete');
  assert.equal(plain.findings[0].claim_key, presented.findings[0].claim_key);
  assert.notEqual(plain.findings[0].claim_key, differentConstant.findings[0].claim_key);
  assert.match(plain.findings[0].claim, /경계 3회/u);
});

test('claim normalization preserves substantive inline-code underscores and operators', async () => {
  const { extractFindingState } = await loadIdentity();
  const underscored = extractFindingState(report({ warning: ['`max_retries` is ignored at `src/a.js:10`.'] }));
  const collapsed = extractFindingState(report({ warning: ['`maxretries` is ignored at `src/a.js:10`.'] }));
  const multiply = extractFindingState(report({ warning: ['`a*b` overflows at `src/a.js:10`.'] }));
  const concatenated = extractFindingState(report({ warning: ['`ab` overflows at `src/a.js:10`.'] }));
  const complement = extractFindingState(report({ warning: ['`~mask` escapes at `src/a.js:10`.'] }));
  const bareMask = extractFindingState(report({ warning: ['`mask` escapes at `src/a.js:10`.'] }));

  assert.match(underscored.findings[0].claim, /max_retries/u);
  assert.notEqual(underscored.findings[0].claim_key, collapsed.findings[0].claim_key);
  assert.match(multiply.findings[0].claim, /a\*b/u);
  assert.notEqual(multiply.findings[0].claim_key, concatenated.findings[0].claim_key);
  assert.match(complement.findings[0].claim, /~mask/u);
  assert.notEqual(complement.findings[0].claim_key, bareMask.findings[0].claim_key);
});

test('colon-number inline code is not stripped as a citation', async () => {
  const { extractFindingState, compareFindingStates } = await loadIdentity();
  const thirty = extractFindingState(report({
    warning: ['`src/config.js:12` — Request uses `timeout:30` and violates the configured limit.'],
  }));
  const sixty = extractFindingState(report({
    warning: ['`src/config.js:12` — Request uses `timeout:60` and violates the configured limit.'],
  }));

  assert.equal(thirty.status, 'complete');
  assert.equal(sixty.status, 'complete');
  assert.match(thirty.findings[0].claim, /timeout:30/u);
  assert.match(sixty.findings[0].claim, /timeout:60/u);
  assert.notEqual(thirty.findings[0].finding_id, sixty.findings[0].finding_id);
  assert.deepEqual(thirty.findings[0].locations, [{ path: 'src/config.js', line: 12 }]);
  assert.deepEqual(compareFindingStates(thirty, sixty), {
    identity_status: 'complete',
    repeated_count: 0,
    newly_observed_count: 1,
    not_reobserved_count: 1,
    severity_changes: [],
    progress: 'changed',
  });
});

test('backticked extensionless filenames remain citations', async () => {
  const { extractFindingState } = await loadIdentity();
  const docker = extractFindingState(report({
    warning: ['`Dockerfile:12` — FROM uses an unpinned tag.'],
  }));
  assert.equal(docker.status, 'complete');
  assert.equal(docker.findings[0].locations.length, 1);
  assert.equal(docker.findings[0].locations[0].line, 12);
  assert.match(docker.findings[0].locations[0].path, /^Dockerfile$/iu);
  assert.match(docker.findings[0].claim, /unpinned tag/u);
});

test('inline code is opaque to prose Markdown and Unicode normalization', async () => {
  const { extractFindingState } = await loadIdentity();
  const pairs = [
    ['__proto__', 'proto'],
    ['a**b**c', 'abc'],
    ['items[key](arg)', 'itemskey'],
    ['Ａ["①"]', 'A["1"]'],
  ];

  for (const [protectedCode, collision] of pairs) {
    const protectedState = extractFindingState(report({
      warning: [`\`${protectedCode}\` is mishandled at \`src/a.js:10\`.`],
    }));
    const collisionState = extractFindingState(report({
      warning: [`\`${collision}\` is mishandled at \`src/a.js:10\`.`],
    }));
    assert.ok(protectedState.findings[0].claim.includes(protectedCode), protectedCode);
    assert.notEqual(
      protectedState.findings[0].claim_key,
      collisionState.findings[0].claim_key,
      `${protectedCode} must not collide with ${collision}`,
    );
  }
});

test('prose Markdown spanning protected inline code does not change claim identity', async () => {
  const { extractFindingState } = await loadIdentity();
  for (const code of ['foo()', 'Ａ["①"] ** b']) {
    const plain = extractFindingState(report({
      warning: [`Call \`${code}\` safely at \`src/a.js:10\`.`],
    }));
    const emphasis = extractFindingState(report({
      warning: [`**Call \`${code}\` safely** at \`src/a.js:20\`.`],
    }));
    const link = extractFindingState(report({
      warning: [`[Call \`${code}\` safely](https://docs.example.test) at \`src/a.js:30\`.`],
    }));

    assert.ok(plain.findings[0].claim.includes(code), code);
    assert.equal(emphasis.findings[0].claim, plain.findings[0].claim);
    assert.equal(link.findings[0].claim, plain.findings[0].claim);
    assert.equal(emphasis.findings[0].claim_key, plain.findings[0].claim_key);
    assert.equal(link.findings[0].claim_key, plain.findings[0].claim_key);
  }
});

test('duplicate material severity headings retain every bullet while failing closed', async () => {
  const { extractFindingState } = await loadIdentity();
  const markdown = report({
    critical: ['First critical at `src/c1.js:10`.'],
    warning: ['First warning at `src/w1.js:20`.'],
  })
    .replace('🔴 1건, 🟡 1건', '🔴 2건, 🟡 2건')
    .replace(
      '### 🟡 Warning',
      '### 🔴 Critical\n\n- Second critical at `src/c2.js:30`.\n\n### 🟡 Warning',
    )
    .replace(
      '### ℹ️ Info',
      '### 🟡 Warning\n\n- Second warning at `src/w2.js:40`.\n\n### ℹ️ Info',
    );
  const state = extractFindingState(markdown);

  assert.equal(state.status, 'indeterminate');
  assert.equal(state.expected_count, 4);
  assert.equal(state.findings.length, 4);
  assert.deepEqual(state.findings.map((finding) => finding.primary_location.path), [
    'src/c1.js',
    'src/c2.js',
    'src/w1.js',
    'src/w2.js',
  ]);
  assert.ok(state.reasons.includes('section_heading_count:critical:2'));
  assert.ok(state.reasons.includes('section_heading_count:warning:2'));
});

test('empty material bodies require an explicit None marker', async () => {
  const { extractFindingState } = await loadIdentity();
  const emptyBoth = report()
    .replace('### 🔴 Critical\n\nNone.', '### 🔴 Critical\n')
    .replace('### 🟡 Warning\n\nNone.', '### 🟡 Warning\n');
  const emptyCritical = report({ warning: ['Warning remains at `src/w.js:10`.'] })
    .replace('### 🔴 Critical\n\nNone.', '### 🔴 Critical\n');

  const allState = extractFindingState(emptyBoth);
  assert.equal(allState.status, 'indeterminate');
  assert.equal(allState.findings.length, 0);
  assert.ok(allState.reasons.includes('malformed_section:critical'));
  assert.ok(allState.reasons.includes('malformed_section:warning'));

  const partialState = extractFindingState(emptyCritical);
  assert.equal(partialState.status, 'indeterminate');
  assert.equal(partialState.findings.length, 1);
  assert.ok(partialState.reasons.includes('malformed_section:critical'));
});

test('summary count disagreement and ambiguous raw inputs fail closed without discarding observations', async () => {
  const { compareFindingStates, extractFindingState } = await loadIdentity();
  const incomplete = report({ warning: ['Reachable failure at `src/a.js:20`.'] })
    .replace('🟡 1건', '🟡 2건');
  const ambiguousPath = report({ warning: ['Escapes the root at `../src/a.js:20`.'] });
  const uriPath = report({ warning: ['Remote URL is not a repository path at `https://example.test/a.js:20`.'] });
  const invalidUnicode = report({ warning: [`Invalid raw claim \ud800 at \`src/a.js:20\`.`] });
  const nulClaim = report({ warning: ['Invalid\0claim at `src/a.js:20`.'] });

  const countState = extractFindingState(incomplete);
  assert.equal(countState.status, 'indeterminate');
  assert.equal(countState.findings.length, 1);
  assert.ok(countState.reasons.includes('summary_count_mismatch:warning:2:1'));

  const pathState = extractFindingState(ambiguousPath);
  assert.equal(pathState.status, 'indeterminate');
  assert.equal(pathState.findings.length, 1);
  assert.ok(pathState.reasons.includes('ambiguous_path:warning:1'));

  const uriState = extractFindingState(uriPath);
  assert.equal(uriState.status, 'indeterminate');
  assert.equal(uriState.findings.length, 1);
  assert.ok(uriState.reasons.includes('ambiguous_path:warning:1'));

  const unicodeState = extractFindingState(invalidUnicode);
  assert.equal(unicodeState.status, 'indeterminate');
  assert.equal(unicodeState.findings.length, 1);
  assert.ok(unicodeState.reasons.includes('ambiguous_claim:warning:1'));

  const nulState = extractFindingState(nulClaim);
  assert.equal(nulState.status, 'indeterminate');
  assert.equal(nulState.findings.length, 1);
  assert.ok(nulState.reasons.includes('ambiguous_claim:warning:1'));
  assert.equal(compareFindingStates(unicodeState, unicodeState).progress, 'indeterminate');
});

test('realistic N-way synthesis annotations outside Code Review do not mint findings', async () => {
  const { extractFindingState } = await loadIdentity();
  const markdown = `${report({
    critical: ['Bounded reader follows the symlink at `src/read.js:9`; reject it.'],
    warning: ['Retry evidence is absent at `src/retry.js:31`; run a bounded check.'],
  })}\n## Cross-Model Verification\n\n- codex-review cited \`notes.md:40\`.\n- **Issues**: 🔴 9건, 🟡 9건, ℹ️ 9건\n\n## Evidence Adjudication\n\n- source_refs: \`src/fake.js:500\``;
  const state = extractFindingState(markdown);

  assert.equal(state.status, 'complete');
  assert.equal(state.findings.length, 2);
  assert.deepEqual(state.findings.map((finding) => finding.primary_location.path), [
    'src/read.js',
    'src/retry.js',
  ]);
});

test('a malformed material heading retains its bullets and marks the state indeterminate', async () => {
  const { extractFindingState } = await loadIdentity();
  const markdown = report({ warning: ['Retry is unbounded at `src/a.js:10`.'] })
    .replace('### 🟡 Warning', '### 🟡 Warning ');
  const state = extractFindingState(markdown);

  assert.equal(state.status, 'indeterminate');
  assert.equal(state.findings.length, 1);
  assert.equal(state.findings[0].claim, 'Retry is unbounded at .');
  assert.ok(state.reasons.includes('malformed_section_heading:warning'));
});

test('comparison rejects invalid FindingState objects explicitly', async () => {
  const { compareFindingStates, extractFindingState, reconcileFindingStates } = await loadIdentity();
  assert.throws(() => compareFindingStates({}, {}), /FindingStateV1/u);
  assert.throws(() => reconcileFindingStates({ status: 'complete', findings: [] }, null), /FindingStateV1/u);
  const valid = extractFindingState(report({ warning: ['Failure at `src/a.js:10`.'] }));
  const forged = structuredClone(valid);
  forged.findings[0].finding_id = `F-${'0'.repeat(64)}`;
  assert.throws(() => compareFindingStates(valid, forged), /FindingStateV1/u);

  const indeterminate = extractFindingState(report({ warning: ['Missing location.'] }));
  assert.equal(compareFindingStates(indeterminate, indeterminate).progress, 'indeterminate');
});

test('canonicalizeRepoPath normalizes backslashes to forward slashes', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(canonicalizeRepoPath('a\\b\\c.mjs', { repoRoot: '/repo' }), 'a/b/c.mjs');
});

test('canonicalizeRepoPath strips leading ./ segments', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(canonicalizeRepoPath('./src/a.js'), 'src/a.js');
  assert.equal(canonicalizeRepoPath('./././src/a.js'), 'src/a.js');
});

test('canonicalizeRepoPath collapses duplicate slashes', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(canonicalizeRepoPath('a//b///c.js'), 'a/b/c.js');
});

test('canonicalizeRepoPath rejects NUL bytes', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.throws(() => canonicalizeRepoPath('a\0b.js'), TypeError);
  assert.throws(() => canonicalizeRepoPath(''), TypeError);
});

test('canonicalizeRepoPath is idempotent', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  const once = canonicalizeRepoPath('a\\b\\.\\c.mjs', { repoRoot: '/repo' });
  const twice = canonicalizeRepoPath(once, { repoRoot: '/repo' });
  assert.equal(twice, once);
  assert.equal(once, 'a/b/c.mjs');
});

test('canonicalizeRepoPath relativizes an absolute path under repoRoot', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(canonicalizeRepoPath('/repo/src/a.js', { repoRoot: '/repo' }), 'src/a.js');
  assert.equal(canonicalizeRepoPath('/repo/src/a.js', { repoRoot: '/repo/' }), 'src/a.js');
  // Outside repoRoot: normalized but left absolute (no relativization applied).
  assert.equal(canonicalizeRepoPath('/other/src/a.js', { repoRoot: '/repo' }), 'other/src/a.js');
});

test('canonicalizeRepoPath case-folds only on win32, matching assertSamePath', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  assert.equal(
    canonicalizeRepoPath('SRC\\A.JS', { repoRoot: 'C:\\repo', platform: 'win32' }),
    'src/a.js',
  );
  assert.equal(
    canonicalizeRepoPath('SRC/A.JS', { repoRoot: '/repo', platform: 'linux' }),
    'SRC/A.JS',
  );
});

test('canonicalizeRepoPath caseFold:false yields a case-PRESERVING display path on win32 (still repo-relativized)', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  // Reproduces the win32 findings_signature regression: the DISPLAY path must
  // keep `Ω` (and mixed case) verbatim so the signature reads identically on
  // every OS. The repoRoot prefix still folds+strips on win32 (one root on a
  // case-insensitive filesystem); only the surviving remainder stays verbatim.
  assert.equal(
    canonicalizeRepoPath('src/space name Ω.js', { repoRoot: '/repo', platform: 'win32', caseFold: false }),
    'src/space name Ω.js',
  );
  assert.equal(
    canonicalizeRepoPath('C:\\Repo\\SRC\\A.JS', { repoRoot: 'c:\\repo', platform: 'win32', caseFold: false }),
    'SRC/A.JS',
  );
});

test('canonicalizeRepoPath default (caseFold:true) still folds case on win32 for IDENTITY', async () => {
  const { canonicalizeRepoPath } = await loadIdentity();
  // The identity default is retained so finding-identity.test.js:54 and any
  // direct identity use keep win32 case-insensitive keys; `Ω`→`ω`.
  assert.equal(
    canonicalizeRepoPath('src/space name Ω.js', { repoRoot: '/repo', platform: 'win32' }),
    'src/space name ω.js',
  );
});

test('extractFindings extracts backtick-quoted file:line locations per severity section', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F534} Critical',
    '- unsafe edge at `src/a.js:14`',
    '### \u{1F7E1} Warning',
    '- missing test at `src/b.js:21`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['critical', 'src/a.js', 14],
    ['warning', 'src/b.js', 21],
  ]);
  assert.equal(findings[0].title_slug, 'unsafe-edge-at');
});

test('extractFindings extracts bare (non-backtick) file:line locations', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F534} Critical',
    '- unsafe edge at src/a.js:14 without backticks',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['critical', 'src/a.js', 14],
  ]);
});

test('extractFindings ignores lines outside a Critical/Warning section', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E2} Passed',
    '- everything at `src/c.js:5` looks fine',
    '### \u{1F534} Critical',
    '- real issue at `src/d.js:9`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['critical', 'src/d.js', 9],
  ]);
});

test('extractFindings extracts a ranged backticked location `path:START-END` using the start line', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- ranged citation at `src/a.js:14-20`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['warning', 'src/a.js', 14],
  ]);
});

test('extractFindings captures a comma-separated MULTI-range backticked citation using the FIRST range start line (no phantom findings)', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- multi-range citation at `src/a.js:1-2, 83-100`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  // Exactly one finding: the extra ranges must never mint phantom findings.
  assert.equal(findings.length, 1);
  assert.deepEqual(findings.map((finding) => [finding.severity, finding.path, finding.line]), [
    ['warning', 'src/a.js', 1],
  ]);
});

test('extractFindings captures a THREE-range backticked citation as one finding at the first start line', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F534} Critical',
    '- three ranges at `pkg/mod.ts:5-9, 40-41, 77-90`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, 'pkg/mod.ts');
  assert.equal(findings[0].line, 5);
});

test('extractFindings leaves single-range and plain backticked citations unchanged alongside a multi-range one', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- plain at `src/p.js:7`',
    '- ranged at `src/r.js:10-14`',
    '- multi at `src/m.js:3-4, 30-31`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings.map((finding) => [finding.path, finding.line]), [
    ['src/p.js', 7],
    ['src/r.js', 10],
    ['src/m.js', 3],
  ]);
});

test('extractFindings does not register unquoted numeric prose (e.g. "backoff at 3:30") as a finding', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- backoff at 3:30',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo' });
  assert.deepEqual(findings, []);
});

test('extractFindings yields a case-PRESERVING display path on win32 (findings_signature stays platform-independent)', async () => {
  const { extractFindings } = await loadIdentity();
  const markdown = [
    '### \u{1F7E1} Warning',
    '- path-safe issue at `src/space name Ω.js:28`',
  ].join('\n');
  const findings = extractFindings(markdown, { repoRoot: '/repo', platform: 'win32' });
  // The signature's only platform-dependent component is finding.path; keeping
  // `Ω` verbatim here is exactly what makes findings_signature identical on
  // win32 and posix.
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, 'src/space name Ω.js');
});

test('matchFindings matches identical severity+path+line as repeated', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'critical', path: 'src/a.js', line: 14, title_slug: 'unsafe-edge' }];
  const current = [{ severity: 'critical', path: 'src/a.js', line: 14, title_slug: 'unsafe-edge' }];
  const result = matchFindings(previous, current);
  assert.equal(result.repeated.length, 1);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.added, []);
});

test('matchFindings matches within +-6 lines as repeated (boundary)', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'warning', path: 'src/b.js', line: 21, title_slug: 'x' }];
  const current = [{ severity: 'warning', path: 'src/b.js', line: 27, title_slug: 'y' }];
  const result = matchFindings(previous, current);
  assert.equal(result.repeated.length, 1);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.added, []);
});

test('matchFindings treats +-7 lines as unmatched (resolved+added)', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'warning', path: 'src/b.js', line: 21, title_slug: 'x' }];
  const current = [{ severity: 'warning', path: 'src/b.js', line: 28, title_slug: 'y' }];
  const result = matchFindings(previous, current);
  assert.deepEqual(result.repeated, []);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.added.length, 1);
});

test('matchFindings prefers an exact title_slug match over a closer line distance', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'critical', path: 'src/a.js', line: 10, title_slug: 'stable-slug' }];
  const current = [
    { severity: 'critical', path: 'src/a.js', line: 10, title_slug: 'different-slug' },
    { severity: 'critical', path: 'src/a.js', line: 13, title_slug: 'stable-slug' },
  ];
  const result = matchFindings(previous, current);
  assert.equal(result.repeated.length, 1);
  assert.equal(result.repeated[0][1].title_slug, 'stable-slug');
  assert.equal(result.repeated[0][1].line, 13);
  assert.equal(result.resolved.length, 0);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].title_slug, 'different-slug');
});

test('matchFindings performs 1:1 greedy matching without double-consuming a candidate', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [
    { severity: 'warning', path: 'src/a.js', line: 5, title_slug: 'p1' },
    { severity: 'warning', path: 'src/a.js', line: 10, title_slug: 'p2' },
  ];
  const current = [
    { severity: 'warning', path: 'src/a.js', line: 11, title_slug: 'c1' },
  ];
  const result = matchFindings(previous, current);
  assert.equal(result.repeated.length, 1);
  // The closer previous entry (line 10, distance 1) wins the single current candidate
  // over the farther one (line 5, distance 6) — both are within tolerance.
  assert.equal(result.repeated[0][0].title_slug, 'p2');
  assert.equal(result.resolved.length, 1);
  assert.equal(result.resolved[0].title_slug, 'p1');
  assert.deepEqual(result.added, []);
});

test('matchFindings folds path case on win32 (case-insensitive-filesystem IDENTITY preserved with case-preserving display paths)', async () => {
  const { matchFindings } = await loadIdentity();
  // Findings now carry case-preserving display paths, so the win32-only
  // case-insensitive identity match must live in matchFindings: two citations
  // of the same file differing only in case are ONE finding on win32.
  const previous = [{ severity: 'warning', path: 'src/Space Name Ω.js', line: 28, title_slug: 'path-safe-issue-at' }];
  const current = [{ severity: 'warning', path: 'src/space name ω.js', line: 28, title_slug: 'path-safe-issue-at' }];
  const result = matchFindings(previous, current, { platform: 'win32' });
  assert.equal(result.repeated.length, 1);
  assert.deepEqual(result.resolved, []);
  assert.deepEqual(result.added, []);
});

test('matchFindings keeps path comparison case-sensitive on posix (case-differing paths are distinct findings)', async () => {
  const { matchFindings } = await loadIdentity();
  const previous = [{ severity: 'warning', path: 'src/Foo.js', line: 10, title_slug: 'x' }];
  const current = [{ severity: 'warning', path: 'src/foo.js', line: 10, title_slug: 'y' }];
  const result = matchFindings(previous, current, { platform: 'linux' });
  assert.deepEqual(result.repeated, []);
  assert.equal(result.resolved.length, 1);
  assert.equal(result.added.length, 1);
});
