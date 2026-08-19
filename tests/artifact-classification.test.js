'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const {
  cleanupGitFixtures,
  createGitFixture,
  fixtureRootFor,
  git,
} = require('./helpers/git-fixture.js');

const root = path.resolve(__dirname, '..');
const targetsDir = path.join(__dirname, 'fixtures', 'targets');

const taxonomyUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'lib', 'target-taxonomy.mjs'),
).href;
const classifyUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'lib', 'artifact-classify.mjs'),
).href;
const discoverUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'lib', 'artifact-discover.mjs'),
).href;
const scopeUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'classify-artifacts.mjs'),
).href;
const runtimeContextUrl = pathToFileURL(
  path.join(root, 'hooks', 'scripts', 'lib', 'runtime-context.mjs'),
).href;

const classifyCliPath = path.join(root, 'hooks', 'scripts', 'classify-artifacts.mjs');

// Structural signal types the deterministic classifier is allowed to emit.
// D9: artifact content is DATA — never an instruction — so no execution-derived
// signal type may ever appear.
const ALLOWED_SIGNAL_TYPES = new Set([
  'frontmatter',
  'filename',
  'path',
  'title',
  'heading',
  'keyword',
  'extension',
  'code-extension',
  'git-diff',
  'contradiction',
]);

const temporaryRoots = new Set();
function temporaryDirectory(prefix = 'deep-review-classify-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(dir);
  return dir;
}

test.after(() => {
  cleanupGitFixtures();
  for (const dir of temporaryRoots) fs.rmSync(dir, { recursive: true, force: true });
});

async function loadTaxonomy() {
  return import(taxonomyUrl);
}
async function loadClassify() {
  return import(classifyUrl);
}
async function loadDiscover() {
  return import(discoverUrl);
}
async function loadScope() {
  return import(scopeUrl);
}

function fixture(name) {
  return fs.readFileSync(path.join(targetsDir, name), 'utf8');
}

async function classifyFixture(name, overrides = {}) {
  const { classifyArtifact } = await loadClassify();
  return classifyArtifact({
    path: `docs/${name}`,
    extension: path.extname(name),
    content: fixture(name),
    isBinary: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Taxonomy (§8.1) + reserved routing constants (D6)
// ---------------------------------------------------------------------------

test('taxonomy exposes the canonical §8.1 target kinds and reserves D6 routing constants', async () => {
  const taxonomy = await loadTaxonomy();
  for (const kind of [
    'code-change',
    'design-document',
    'implementation-plan',
    'requirements-specification',
    'architecture-decision-record',
    'test-plan',
    'runbook-operations',
    'research-note',
    'configuration-infrastructure',
    'generic-document',
    'generic-text-artifact',
    'mixed',
    'unknown',
    'unsupported-binary',
  ]) {
    assert.ok(taxonomy.TARGET_KINDS.includes(kind), `missing kind: ${kind}`);
    assert.equal(taxonomy.isTargetKind(kind), true);
  }
  assert.equal(taxonomy.isTargetKind('not-a-real-kind'), false);

  // D6: symbolic tiers/efforts are reserved now, unused in Phase 1.
  assert.deepEqual(taxonomy.MODEL_TIERS, ['fast', 'balanced', 'quality', 'maximum']);
  assert.deepEqual(
    taxonomy.EFFORT_LEVELS,
    ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.equal(taxonomy.EFFORT_ALIASES.none, 'minimal');
  assert.equal(typeof taxonomy.CLASSIFICATION_VERSION, 'string');
});

// ---------------------------------------------------------------------------
// Deterministic classifier (§8.5): confirmed classifications
// ---------------------------------------------------------------------------

test('a design document is confirmed by heading fingerprints and filename', async () => {
  const result = await classifyFixture('design-en.md');
  assert.equal(result.target_kind, 'design-document');
  assert.ok(result.confidence >= 0.8, `confidence ${result.confidence}`);
  assert.equal(result.needs_semantic, false);
  assert.match(result.source, /deterministic/);
  const types = result.signals.map((s) => s.type);
  assert.ok(types.includes('heading'), 'expected a heading signal');
  assert.ok(types.includes('filename') || types.includes('path'), 'expected a path signal');
});

test('a Korean design document is confirmed by the same structural fingerprints', async () => {
  const result = await classifyFixture('design-ko.md');
  assert.equal(result.target_kind, 'design-document');
  assert.ok(result.confidence >= 0.8, `confidence ${result.confidence}`);
});

test('frontmatter kind is the strongest signal (+0.45) for an implementation plan', async () => {
  const result = await classifyFixture('implementation-plan-en.md');
  assert.equal(result.target_kind, 'implementation-plan');
  assert.ok(result.confidence >= 0.8);
  assert.equal(result.needs_semantic, false);
  const frontmatter = result.signals.find((s) => s.type === 'frontmatter');
  assert.ok(frontmatter, 'expected a frontmatter signal');
  assert.equal(frontmatter.weight, 0.45);
});

test('a requirements specification is confirmed by its acceptance-criteria fingerprints', async () => {
  const result = await classifyFixture('requirements-spec.md');
  assert.equal(result.target_kind, 'requirements-specification');
  assert.ok(result.confidence >= 0.8);
});

test('an ADR is confirmed by its ADR-* filename and status/decision fingerprints', async () => {
  const result = await classifyFixture('adr-001.md', { path: 'docs/adr/ADR-001.md' });
  assert.equal(result.target_kind, 'architecture-decision-record');
  assert.ok(result.confidence >= 0.8);
});

test('a test plan is confirmed by filename and pass/fail fingerprints', async () => {
  const result = await classifyFixture('test-plan.md');
  assert.equal(result.target_kind, 'test-plan');
  assert.ok(result.confidence >= 0.8);
});

// ---------------------------------------------------------------------------
// Deterministic classifier: provisional band (>=0.55) → needs_semantic
// ---------------------------------------------------------------------------

test('a runbook without documented fingerprints lands in the provisional band and asks for semantic help', async () => {
  const result = await classifyFixture('runbook.md');
  assert.equal(result.target_kind, 'runbook-operations');
  assert.ok(result.confidence >= 0.55, `confidence ${result.confidence}`);
  assert.ok(result.confidence < 0.8, `confidence ${result.confidence}`);
  assert.equal(result.needs_semantic, true);
  assert.match(result.source, /provisional/);
});

test('a research note is recognised but stays provisional', async () => {
  const result = await classifyFixture('research-note.md');
  assert.equal(result.target_kind, 'research-note');
  assert.ok(result.confidence >= 0.55);
});

// ---------------------------------------------------------------------------
// Deterministic classifier: fallback band (<0.55) → generic + needs_semantic
// ---------------------------------------------------------------------------

test('a generic README falls back to generic-document and asks for semantic help', async () => {
  const result = await classifyFixture('generic-readme.md');
  assert.equal(result.target_kind, 'generic-document');
  assert.equal(result.needs_semantic, true);
  assert.ok(result.confidence < 0.55);
  assert.match(result.source, /fallback/);
});

test('ambiguous notes fall back below the semantic threshold', async () => {
  const result = await classifyFixture('ambiguous-notes.md');
  assert.equal(result.target_kind, 'generic-document');
  assert.equal(result.needs_semantic, true);
});

test('a non-document text extension falls back to generic-text-artifact', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'notes/scratch.log',
    extension: '.log',
    content: 'random unlabelled lines\nno structure here\n',
    isBinary: false,
  });
  assert.equal(result.target_kind, 'generic-text-artifact');
  assert.equal(result.needs_semantic, true);
});

// ---------------------------------------------------------------------------
// Code + binary coarse classification (D3: clear cases never need a model)
// ---------------------------------------------------------------------------

test('a recognised source extension is a decisive code-change classification', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'src/cache.ts',
    extension: '.ts',
    content: fs.readFileSync(path.join(targetsDir, 'code-only', 'cache.ts'), 'utf8'),
    isBinary: false,
    gitStatus: 'M',
  });
  assert.equal(result.target_kind, 'code-change');
  assert.ok(result.confidence >= 0.8);
  assert.equal(result.needs_semantic, false);
  assert.match(result.source, /code extension/);
});

test('a binary artifact is unsupported-binary and never asks for semantic help', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'assets/logo.png',
    extension: '.png',
    content: '',
    isBinary: true,
  });
  assert.equal(result.target_kind, 'unsupported-binary');
  assert.equal(result.needs_semantic, false);
});

// ---------------------------------------------------------------------------
// Contradiction penalty + margin (§8.5.4)
// ---------------------------------------------------------------------------

test('frontmatter overrides a contradicting filename and the loser is demoted', async () => {
  const result = await classifyFixture('contradiction-frontmatter-vs-filename.md', {
    path: 'docs/design-notes.md',
  });
  assert.equal(result.target_kind, 'implementation-plan');
  const designAlt = result.alternatives.find((a) => a.target_kind === 'design-document');
  assert.ok(designAlt, 'design-document should be a scored alternative');
  assert.ok(designAlt.confidence < result.confidence);
});

test('a contradicting strong signal costs the loser 0.25', async () => {
  const { classifyArtifact } = await loadClassify();
  // Strong filename says spec; frontmatter decisively says plan, and the body
  // is plan-shaped so the plan candidate is named outright.
  const content = [
    '---',
    'kind: implementation-plan',
    '---',
    '',
    '# Rollout Implementation Plan',
    '',
    '## Implementation steps',
    '1. ship it',
    '',
    '## Files to change',
    '- src/a.ts',
    '',
    '## Requirements',
    'a stray requirements heading',
    '',
  ].join('\n');
  const result = classifyArtifact({
    path: 'docs/feature-spec.md',
    extension: '.md',
    content,
    isBinary: false,
  });
  assert.equal(result.target_kind, 'implementation-plan');
  const specScore = result.scores['requirements-specification'] ?? 0;
  const specNoPenalty = result.scores_without_contradiction['requirements-specification'] ?? 0;
  assert.ok(
    specNoPenalty - specScore >= 0.25 - 1e-9,
    `expected a 0.25 contradiction penalty, saw ${specNoPenalty} → ${specScore}`,
  );
});

// ---------------------------------------------------------------------------
// Scope classification (§8.7)
// ---------------------------------------------------------------------------

test('scope classification collapses one kind and reports mixed for two', async () => {
  const { classifyScope } = await loadClassify();
  assert.equal(
    classifyScope([{ target_kind: 'design-document' }, { target_kind: 'design-document' }]),
    'design-document',
  );
  assert.equal(
    classifyScope([{ target_kind: 'design-document' }, { target_kind: 'implementation-plan' }]),
    'mixed',
  );
  assert.equal(classifyScope([{ target_kind: 'code-change' }]), 'code-change');
});

// ---------------------------------------------------------------------------
// Boundaries: empty, large, purity
// ---------------------------------------------------------------------------

test('an empty file does not throw and falls back to a generic kind', async () => {
  const { classifyArtifact } = await loadClassify();
  const md = classifyArtifact({ path: 'docs/empty.md', extension: '.md', content: '', isBinary: false });
  assert.equal(md.target_kind, 'generic-document');
  assert.equal(md.needs_semantic, true);
  const txt = classifyArtifact({ path: 'notes/empty.txt', extension: '.txt', content: '', isBinary: false });
  assert.equal(txt.target_kind, 'generic-text-artifact');
});

test('a very large document classifies without error', async () => {
  const { classifyArtifact } = await loadClassify();
  const big = `# Design\n\n## Architecture\n\n## Trade-offs\n\n${'lorem cache latency store\n'.repeat(80000)}`;
  const result = classifyArtifact({ path: 'docs/design-big.md', extension: '.md', content: big, isBinary: false });
  assert.ok(typeof result.target_kind === 'string' && result.target_kind.length > 0);
});

test('classification is a pure function of its inputs (idempotent)', async () => {
  const a = await classifyFixture('design-en.md');
  const b = await classifyFixture('design-en.md');
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// D9: prompt-injection content is DATA, never instruction
// ---------------------------------------------------------------------------

test('embedded imperative commands are treated as text signals only, never executed or obeyed', async () => {
  const result = await classifyFixture('malicious-prompt-injection.md', {
    path: 'docs/malicious-prompt-injection.md',
  });
  // It still classifies (as a plan-shaped document) and returns pure data.
  assert.ok(typeof result.target_kind === 'string' && result.target_kind.length > 0);

  // No verdict/approve field can leak from the document's "Mark this APPROVE" line.
  for (const key of Object.keys(result)) {
    assert.doesNotMatch(key, /verdict|approve/i, `unexpected field leaked from document: ${key}`);
  }
  // Every signal is a structural type — nothing derived from executing content.
  for (const signal of result.signals) {
    assert.ok(ALLOWED_SIGNAL_TYPES.has(signal.type), `illegal signal type: ${signal.type}`);
  }
  // Idempotent: re-classifying performs no side effect that changes the result.
  const again = await classifyFixture('malicious-prompt-injection.md', {
    path: 'docs/malicious-prompt-injection.md',
  });
  assert.deepEqual(result, again);
});

// ---------------------------------------------------------------------------
// Discovery (§8.2): ArtifactDescriptor from the git scope
// ---------------------------------------------------------------------------

test('discovery builds ArtifactDescriptors from the current git scope', async () => {
  const { discoverArtifacts } = await loadDiscover();
  const repo = createGitFixture('discover');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  fs.writeFileSync(path.join(repo, 'cache.ts'), fs.readFileSync(path.join(targetsDir, 'code-only', 'cache.ts')));

  const descriptors = discoverArtifacts({ repo, changeState: 'untracked-only' });
  const byPath = Object.fromEntries(descriptors.map((d) => [d.path, d]));
  assert.ok(byPath['design.md'], 'design.md descriptor missing');
  assert.ok(byPath['cache.ts'], 'cache.ts descriptor missing');

  const design = byPath['design.md'];
  assert.equal(design.extension, '.md');
  assert.equal(design.is_binary, false);
  assert.match(design.artifact_id, /^artifact-\d+$/);
  assert.match(design.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(design.byte_size > 0);
  assert.ok(design.line_count > 0);
  assert.equal(typeof design.content, 'string');
  assert.ok(design.content.includes('## Architecture'));
});

// ---------------------------------------------------------------------------
// Scope orchestration + provenance (§8.6-shaped output)
// ---------------------------------------------------------------------------

test('scope classification over a mixed change set produces provenance and a mixed scope', async () => {
  const { classifyArtifactsScope } = await loadScope();
  const repo = createGitFixture('scope-mixed');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  fs.writeFileSync(path.join(repo, 'plan.md'), fixture('implementation-plan-en.md'));
  fs.writeFileSync(path.join(repo, 'cache.ts'), fs.readFileSync(path.join(targetsDir, 'code-only', 'cache.ts')));

  const result = classifyArtifactsScope({ repo, changeState: 'untracked-only' });
  assert.equal(result.scope, 'mixed');
  assert.equal(result.artifacts.length, 3);
  assert.equal(typeof result.classification_version, 'string');
  for (const artifact of result.artifacts) {
    assert.ok(typeof artifact.target_kind === 'string');
    assert.ok(typeof artifact.confidence === 'number');
    assert.ok(typeof artifact.source === 'string');
    assert.ok(Array.isArray(artifact.signals));
  }
});

test('dry-run listing follows the §15.7 shape and explain renders the Phase 2 routing plan', async () => {
  const { classifyArtifactsScope, formatDryRun, formatExplainRouting } = await loadScope();
  const repo = createGitFixture('scope-format');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  fs.writeFileSync(path.join(repo, 'plan.md'), fixture('implementation-plan-en.md'));

  const result = classifyArtifactsScope({ repo, changeState: 'untracked-only' });
  const listing = formatDryRun(result);
  assert.match(listing, /Detected scope:\s*mixed/);
  assert.match(listing, /design\.md/);
  assert.match(listing, /kind:/);
  assert.match(listing, /confidence:/);
  assert.match(listing, /source:/);

  const explain = formatExplainRouting(result);
  assert.match(explain, /design\.md/);
  assert.match(explain, /routing/i);
  assert.match(explain, /Routing policy:/i);
  assert.doesNotMatch(explain, /not yet implemented|not implemented/i);
});

// ---------------------------------------------------------------------------
// Dry-run integration: CLI writes provenance, executes NO reviewer
// ---------------------------------------------------------------------------

test('the classify-artifacts CLI prints the listing, writes provenance JSON, and runs no reviewer', () => {
  const repo = createGitFixture('cli-dry-run');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  fs.writeFileSync(path.join(repo, 'cache.ts'), fs.readFileSync(path.join(targetsDir, 'code-only', 'cache.ts')));

  const run = spawnSync(
    process.execPath,
    [classifyCliPath, '--repo', repo, '--change-state', 'untracked-only'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Detected scope:/);
  assert.match(run.stdout, /design\.md/);
  assert.match(run.stdout, /cache\.ts/);

  const provenancePath = path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json');
  assert.ok(fs.existsSync(provenancePath), 'provenance JSON not written');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  assert.equal(typeof provenance.classification_version, 'string');
  assert.equal(provenance.artifacts.length, 2);

  // The dry-run path must be structurally incapable of running a reviewer.
  const cliSource = fs.readFileSync(classifyCliPath, 'utf8');
  assert.doesNotMatch(cliSource, /run-(?:claude|codex|agy|grok)-reviewer/);
});

test('discovery never re-ingests its own provenance output or deep-suite runtime state', async () => {
  const { discoverArtifacts } = await loadDiscover();
  const repo = createGitFixture('runtime-state');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  // Simulate a prior dry-run having written provenance plus other runtime state.
  fs.mkdirSync(path.join(repo, '.deep-review', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json'), '{}');
  fs.mkdirSync(path.join(repo, '.deep-work'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.deep-work', 'state.json'), '{}');

  const descriptors = discoverArtifacts({ repo, changeState: 'untracked-only' });
  const paths = descriptors.map((d) => d.path);
  assert.deepEqual(paths, ['design.md']);
});

test('the classify-artifacts CLI supports --explain-routing with real routing output', () => {
  const repo = createGitFixture('cli-explain');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));

  const run = spawnSync(
    process.execPath,
    [classifyCliPath, '--repo', repo, '--change-state', 'untracked-only', '--explain-routing'],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Routing policy:/i);
  assert.doesNotMatch(run.stdout, /not yet implemented|not implemented/i);
});

// ---------------------------------------------------------------------------
// C1 (security): symlink / out-of-repo containment — discovery must never read
// content through a symlink or from a path that resolves outside the repo root.
// ---------------------------------------------------------------------------

const SECRET_HEADING = '# TOP-SECRET-CREDENTIAL-HEADING';
const SECRET_BODY = `${SECRET_HEADING}\n\n## Context\n\nAKIA-EXFIL-EXAMPLE-KEY\n`;

test('C1: an untracked symlink pointing outside the repo is metadata-only and leaks no content', async () => {
  const { discoverArtifacts } = await loadDiscover();
  const repo = createGitFixture('symlink-untracked');
  const secret = path.join(fixtureRootFor(repo), 'outside-secret-1.md');
  fs.writeFileSync(secret, SECRET_BODY);
  fs.symlinkSync(secret, path.join(repo, 'leaked.md'));

  const descriptors = discoverArtifacts({ repo, changeState: 'untracked-only' });
  const leaked = descriptors.find((d) => d.path === 'leaked.md');
  assert.ok(leaked, 'symlink descriptor missing');
  assert.equal(leaked.content, '', 'symlink content must not be read');
  assert.equal(leaked.payload_strategy, 'metadata-only');
  assert.equal(leaked.is_symlink, true);
  assert.equal(leaked.digest, null);
  assert.doesNotMatch(
    JSON.stringify(descriptors),
    /TOP-SECRET|AKIA-EXFIL/,
    'out-of-repo secret leaked into descriptors',
  );
});

test('C1: a committed (tracked) symlink to an out-of-repo target stays metadata-only', async () => {
  const { discoverArtifacts } = await loadDiscover();
  const repo = createGitFixture('symlink-tracked');
  const base = git(repo, ['rev-parse', 'HEAD']);
  const secret = path.join(fixtureRootFor(repo), 'outside-secret-2.md');
  fs.writeFileSync(secret, SECRET_BODY);
  fs.symlinkSync(secret, path.join(repo, 'leaked.md'));
  git(repo, ['add', '--', 'leaked.md']);
  git(repo, ['commit', '--quiet', '-m', 'add symlink']);

  const descriptors = discoverArtifacts({ repo, changeState: 'clean', reviewBase: base });
  const leaked = descriptors.find((d) => d.path === 'leaked.md');
  assert.ok(leaked, 'symlink descriptor missing');
  assert.equal(leaked.content, '');
  assert.equal(leaked.is_symlink, true);
  assert.doesNotMatch(JSON.stringify(descriptors), /AKIA-EXFIL/);
});

test('C1: an explicit out-of-repo target (non-git list) is rejected by realpath containment', async () => {
  const { discoverArtifacts } = await loadDiscover();
  const repo = createGitFixture('containment');
  const secret = path.join(fixtureRootFor(repo), 'outside-secret-3.md');
  fs.writeFileSync(secret, SECRET_BODY);

  const descriptors = discoverArtifacts({
    repo,
    changeState: 'non-git',
    filesFromZ: Buffer.from(`${secret}\0`),
  });
  const leaked = descriptors.find((d) => d.path.endsWith('outside-secret-3.md'));
  assert.ok(leaked, 'explicit target descriptor missing');
  assert.equal(leaked.content, '', 'out-of-repo content must not be read');
  assert.equal(leaked.payload_strategy, 'metadata-only');
  assert.doesNotMatch(JSON.stringify(descriptors), /AKIA-EXFIL/);
});

test('C1: an in-repo file is still fully read after containment checks', async () => {
  const { discoverArtifacts } = await loadDiscover();
  const repo = createGitFixture('containment-in-repo');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));

  const descriptors = discoverArtifacts({ repo, changeState: 'untracked-only' });
  const design = descriptors.find((d) => d.path === 'design.md');
  assert.ok(design, 'in-repo descriptor missing');
  assert.ok(design.content.includes('## Architecture'), 'in-repo content must still be read');
  assert.equal(design.is_symlink, false);
});

// ---------------------------------------------------------------------------
// W1: binary changes must be reachable (unsupported-binary), never dropped into
// an empty/misleading `mixed` scope.
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

test('W1: discovery preserves binaries as metadata-only descriptors', async () => {
  const { discoverArtifacts } = await loadDiscover();
  const repo = createGitFixture('binary-desc');
  fs.writeFileSync(path.join(repo, 'logo.png'), PNG_BYTES);

  const descriptors = discoverArtifacts({ repo, changeState: 'untracked-only' });
  const png = descriptors.find((d) => d.path === 'logo.png');
  assert.ok(png, 'binary descriptor missing');
  assert.equal(png.is_binary, true);
  assert.equal(png.payload_strategy, 'metadata-only');
  assert.equal(png.content, '');
});

test('W1: a binary-only untracked change classifies as unsupported-binary, not empty mixed', async () => {
  const { classifyArtifactsScope } = await loadScope();
  const repo = createGitFixture('binary-only');
  fs.writeFileSync(path.join(repo, 'logo.png'), PNG_BYTES);

  const result = classifyArtifactsScope({ repo, changeState: 'untracked-only' });
  assert.equal(result.artifacts.length, 1, 'binary should be discovered as an artifact');
  assert.equal(result.artifacts[0].target_kind, 'unsupported-binary');
  assert.equal(result.scope, 'unsupported-binary');
});

test('W1: a staged binary is discovered as unsupported-binary', async () => {
  const { classifyArtifactsScope } = await loadScope();
  const repo = createGitFixture('binary-staged');
  fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.concat([PNG_BYTES, Buffer.from([0x00, 0x01])]));
  git(repo, ['add', '--', 'logo.png']);

  const result = classifyArtifactsScope({ repo, changeState: 'staged' });
  const png = result.artifacts.find((a) => a.path === 'logo.png');
  assert.ok(png, 'staged binary missing');
  assert.equal(png.target_kind, 'unsupported-binary');
});

test('W1: a committed binary is discovered as unsupported-binary in a clean scope', async () => {
  const { classifyArtifactsScope } = await loadScope();
  const repo = createGitFixture('binary-committed');
  const base = git(repo, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.concat([PNG_BYTES, Buffer.from([0x00, 0x02])]));
  git(repo, ['add', '--', 'logo.png']);
  git(repo, ['commit', '--quiet', '-m', 'add binary']);

  const result = classifyArtifactsScope({ repo, changeState: 'clean', reviewBase: base });
  const png = result.artifacts.find((a) => a.path === 'logo.png');
  assert.ok(png, 'committed binary missing');
  assert.equal(png.target_kind, 'unsupported-binary');
});

test('W1: a mixed binary + document change keeps both members and reports mixed', async () => {
  const { classifyArtifactsScope } = await loadScope();
  const repo = createGitFixture('binary-mixed');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  fs.writeFileSync(path.join(repo, 'logo.png'), PNG_BYTES);

  const result = classifyArtifactsScope({ repo, changeState: 'untracked-only' });
  const paths = result.artifacts.map((a) => a.path).sort();
  assert.deepEqual(paths, ['design.md', 'logo.png']);
  assert.equal(result.scope, 'mixed');
  const png = result.artifacts.find((a) => a.path === 'logo.png');
  assert.equal(png.target_kind, 'unsupported-binary');
});

test('W1: classifyScope reports unknown (not mixed) for an empty artifact set', async () => {
  const { classifyScope } = await loadClassify();
  assert.equal(classifyScope([]), 'unknown');
});

// ---------------------------------------------------------------------------
// W2: a non-git dry-run must never materialize an empty `mixed` scope — it
// either classifies an explicit target list or fails closed.
// ---------------------------------------------------------------------------

test('W2: classifyArtifactsScope on non-git with no explicit targets is an empty unknown scope', async () => {
  const { classifyArtifactsScope } = await loadScope();
  const repo = createGitFixture('nongit-empty');
  const result = classifyArtifactsScope({ repo, changeState: 'non-git' });
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.scope, 'unknown');
});

test('W2: the CLI fails closed on a non-git target with no explicit list and writes no provenance', () => {
  const repo = createGitFixture('nongit-cli');
  const run = spawnSync(
    process.execPath,
    [classifyCliPath, '--repo', repo, '--change-state', 'non-git'],
    { encoding: 'utf8' },
  );
  assert.notEqual(run.status, 0, 'expected a non-zero fail-closed exit');
  assert.match(run.stderr, /non-git|target/i);
  const provenancePath = path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json');
  assert.equal(fs.existsSync(provenancePath), false, 'provenance must not be materialized');
});

test('W2: the CLI classifies an explicit non-git target list via --files-from0', () => {
  const repo = createGitFixture('nongit-cli-list');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  const listPath = path.join(repo, 'targets.z');
  fs.writeFileSync(listPath, 'design.md\0');

  const run = spawnSync(
    process.execPath,
    [classifyCliPath, '--repo', repo, '--change-state', 'non-git', '--files-from0', listPath],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const provenancePath = path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json');
  assert.ok(fs.existsSync(provenancePath), 'provenance JSON not written');
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  assert.equal(provenance.artifacts.length, 1);
  assert.equal(provenance.artifacts[0].path, 'design.md');
});

// ---------------------------------------------------------------------------
// W3: `type:'filename'` strong rules must match only their declared surface and
// respect word boundaries (no spurious +0.30 from embedded path substrings).
// ---------------------------------------------------------------------------

test('W3: an inspector path does not spuriously match the spec filename rule', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'src/inspector/notes.md',
    extension: '.md',
    content: '# Notes\n\nsome unstructured notes about the module\n',
    isBinary: false,
  });
  assert.equal(
    result.scores['requirements-specification'],
    undefined,
    'inspector path must not produce a requirements-specification signal',
  );
  assert.notEqual(result.target_kind, 'requirements-specification');
});

test('W3: a redesign path does not spuriously match the design filename rule', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'packages/redesign/README.md',
    extension: '.md',
    content: '# Readme\n\ngeneral overview text\n',
    isBinary: false,
  });
  assert.equal(result.scores['design-document'], undefined);
});

test('W3: a researcher path does not spuriously match the research filename rule', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'apps/researcher/log.md',
    extension: '.md',
    content: '# Log\n\nchronological entries\n',
    isBinary: false,
  });
  assert.equal(result.scores['research-note'], undefined);
});

test('W3: an embedded keyword in a basename needs a word boundary to match', async () => {
  const { classifyArtifact } = await loadClassify();
  // Each basename embeds a rule keyword (in-spec-tor, re-design) with no boundary.
  const spec = classifyArtifact({ path: 'src/inspector.md', extension: '.md', content: '# x\n', isBinary: false });
  assert.equal(spec.scores['requirements-specification'], undefined, 'inspector.md basename must not match spec');
  const design = classifyArtifact({ path: 'src/redesign.md', extension: '.md', content: '# x\n', isBinary: false });
  assert.equal(design.scores['design-document'], undefined, 'redesign.md basename must not match design');
});

test('W3: a genuine design filename still fires the strong path signal', async () => {
  const { classifyArtifact } = await loadClassify();
  const result = classifyArtifact({
    path: 'docs/design-notes.md',
    extension: '.md',
    content: '# Design\n\n## Architecture\n\n## Trade-offs\n',
    isBinary: false,
  });
  assert.ok(result.scores['design-document'] !== undefined, 'design filename must still score');
  assert.ok(result.signals.some((s) => s.type === 'filename'), 'expected a filename signal');
});

// ---------------------------------------------------------------------------
// F2: preflight semantic classification stays gated behind explicit opt-in —
// `--emit-routing-plan` alone (the flag the supported review preflight always
// passes) must never enable the external classifier.
// ---------------------------------------------------------------------------

test('F2: --emit-routing-plan alone never enables semantic classification; explicit allow_classifier does', async () => {
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-f2-preflight-');
  fs.writeFileSync(path.join(repo, 'ambiguous-notes.md'), fixture('ambiguous-notes.md'));
  const listPath = path.join(repo, 'targets.z');
  fs.writeFileSync(listPath, 'ambiguous-notes.md\0');

  const capabilities = [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard', 'classifier'],
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  }];
  const reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];

  let defaultCalls = 0;
  const defaultResult = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', listPath, '--emit-routing-plan'],
    {},
    {
      capabilities, reviewers,
      semanticAdapter: async () => { defaultCalls += 1; return {}; },
    },
  );
  assert.equal(defaultCalls, 0, 'the classifier must never run on plain --emit-routing-plan preflight');
  const deferredArtifact = defaultResult.artifacts.find((artifact) => artifact.path === 'ambiguous-notes.md');
  assert.equal(deferredArtifact.needs_semantic, true);
  assert.equal(deferredArtifact.semantic_status, 'deferred');

  let optInCalls = 0;
  const overridesJson = JSON.stringify({
    protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, allow_classifier: true,
    providers: {}, reviewers: {},
  });
  const optInResult = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', listPath, '--emit-routing-plan', '--overrides-json', overridesJson],
    {},
    {
      capabilities, reviewers,
      semanticAdapter: async () => {
        optInCalls += 1;
        return {
          classification_version: '1.0', target_kind: 'research-note', confidence: 0.9,
          signals: [], alternative_kinds: [], uncertainty_action: 'proceed', notes: '',
        };
      },
    },
  );
  assert.equal(optInCalls, 1, 'explicit allow_classifier must enable the semantic path');
  const optInArtifact = optInResult.artifacts.find((artifact) => artifact.path === 'ambiguous-notes.md');
  assert.notEqual(optInArtifact.semantic_status, 'deferred');
});

// ---------------------------------------------------------------------------
// I1: classification.max_classifier_bytes_per_artifact from the merged policy
// must reach the semantic byte budget instead of always defaulting to 24 KB.
// ---------------------------------------------------------------------------

test('I1: policy classification.max_classifier_bytes_per_artifact wires into the semantic byte budget', async () => {
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-i1-budget-');
  // Long, structurally ambiguous prose (no strong deterministic signals) so
  // needs_semantic stays true regardless of length, and long enough that a
  // 512-byte budget must visibly truncate the transmitted snippets.
  const paragraph = 'Some thoughts from today about the cache thing and a few open threads. '
    + 'It is not fully clear which one to pull first, so maybe revisit next week.\n';
  const longAmbiguousContent = `# Notes\n\n${paragraph.repeat(80)}`;
  assert.ok(Buffer.byteLength(longAmbiguousContent, 'utf8') > 8192, 'fixture must exceed the configured budget');
  fs.writeFileSync(path.join(repo, 'ambiguous-long.md'), longAmbiguousContent);
  const listPath = path.join(repo, 'targets.z');
  fs.writeFileSync(listPath, 'ambiguous-long.md\0');

  const capabilities = [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard', 'classifier'],
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  }];
  const reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];
  const overridesJson = JSON.stringify({
    protocol_version: '2.0', routing_policy: 'auto', allow_fallback: false, allow_classifier: true,
    providers: {}, reviewers: {},
  });

  const budgetedPayloads = [];
  await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', listPath, '--emit-routing-plan', '--overrides-json', overridesJson],
    {},
    {
      capabilities, reviewers,
      projectPolicy: { classification: { max_classifier_bytes_per_artifact: 512 } },
      semanticAdapter: async (payload) => {
        budgetedPayloads.push(payload);
        return {
          classification_version: '1.0', target_kind: 'research-note', confidence: 0.9,
          signals: [], alternative_kinds: [], uncertainty_action: 'proceed', notes: '',
        };
      },
    },
  );
  assert.equal(budgetedPayloads.length, 1);
  assert.ok(
    Buffer.byteLength(JSON.stringify(budgetedPayloads[0]), 'utf8') <= 512,
    'transmitted payload must respect the configured 512-byte budget',
  );

  const defaultPayloads = [];
  await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', listPath, '--emit-routing-plan', '--overrides-json', overridesJson],
    {},
    {
      capabilities, reviewers,
      semanticAdapter: async (payload) => {
        defaultPayloads.push(payload);
        return {
          classification_version: '1.0', target_kind: 'research-note', confidence: 0.9,
          signals: [], alternative_kinds: [], uncertainty_action: 'proceed', notes: '',
        };
      },
    },
  );
  assert.equal(defaultPayloads.length, 1);
  assert.ok(
    Buffer.byteLength(JSON.stringify(defaultPayloads[0]), 'utf8') > 512,
    'without the policy override the default ~24KB budget must not truncate down to 512 bytes',
  );
});

// ---------------------------------------------------------------------------
// H6: classification.thresholds from review-policy.yaml must reach the
// deterministic classifier's confidence bands (classifyArtifact consumes
// `thresholds` directly), not just classification.size_thresholds /
// max_classifier_bytes_per_artifact, which are already wired separately.
// ---------------------------------------------------------------------------

test('H6: policy classification.thresholds wires into the deterministic classifier confidence bands', async () => {
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-h6-thresholds-');
  fs.writeFileSync(path.join(repo, 'design.md'), fixture('design-en.md'));
  const listPath = path.join(repo, 'targets.z');
  fs.writeFileSync(listPath, 'design.md\0');

  const baseline = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', listPath],
    {},
    { capabilities: [], reviewers: [] },
  );
  const baselineArtifact = baseline.artifacts.find((artifact) => artifact.path === 'design.md');
  assert.equal(baselineArtifact.target_kind, 'design-document');
  assert.equal(baselineArtifact.needs_semantic, false, 'design.md must confirm deterministically under default thresholds');

  const raised = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', listPath],
    {},
    { capabilities: [], reviewers: [], projectPolicy: { classification: { thresholds: { confirm: 0.99 } } } },
  );
  const raisedArtifact = raised.artifacts.find((artifact) => artifact.path === 'design.md');
  assert.equal(raisedArtifact.target_kind, 'design-document');
  assert.equal(raisedArtifact.needs_semantic, true, 'raising classification.thresholds.confirm must push the same artifact out of the confirmed band');
});

test('K1: policy classification overrides force kind and deterministic mode suppresses semantic calls', async () => {
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-k1-policy-classification-');
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'notes.md'), fixture('ambiguous-notes.md'));
  const listPath = path.join(repo, 'targets.z');
  fs.writeFileSync(listPath, 'docs/notes.md\0');
  const capabilities = [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard', 'classifier'], structured_output: true,
    model_selection: { supported: true, aliases: ['swift'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low'], transport: 'flag:--effort' },
    read_only_enforcement: 'process-contract',
  }];
  const reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];
  const overridesJson = JSON.stringify({
    protocol_version: '2.0', allow_classifier: true, providers: {}, reviewers: {},
  });

  let overrideCalls = 0;
  const overridden = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', listPath, '--emit-routing-plan', '--overrides-json', overridesJson],
    {},
    {
      capabilities, reviewers,
      projectPolicy: { classification: { overrides: [{ glob: 'docs/**', kind: 'design-document' }] } },
      semanticAdapter: async () => { overrideCalls += 1; return {}; },
    },
  );
  assert.equal(overrideCalls, 0, 'a policy-forced kind must not invoke semantic classification');
  assert.equal(overridden.artifacts[0].target_kind, 'design-document');
  assert.equal(overridden.artifacts[0].confidence, 1);
  assert.match(overridden.artifacts[0].source, /policy override.*docs\/\*\*/);
  assert.equal(overridden.artifacts[0].needs_semantic, false);

  let deterministicCalls = 0;
  const deterministic = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', listPath, '--emit-routing-plan', '--overrides-json', overridesJson],
    {},
    {
      capabilities, reviewers,
      projectPolicy: { classification: { mode: 'deterministic' } },
      semanticAdapter: async () => { deterministicCalls += 1; return {}; },
    },
  );
  assert.equal(deterministicCalls, 0, 'deterministic mode must suppress an otherwise opted-in semantic call');
  assert.equal(deterministic.artifacts[0].needs_semantic, true);
  assert.equal(deterministic.artifacts[0].semantic_status, 'deferred');

  let baselineCalls = 0;
  await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', listPath, '--emit-routing-plan', '--overrides-json', overridesJson],
    {},
    {
      capabilities, reviewers,
      semanticAdapter: async () => {
        baselineCalls += 1;
        return {
          classification_version: '1.0', target_kind: 'research-note', confidence: 0.9,
          signals: [], alternative_kinds: [], uncertainty_action: 'proceed', notes: '',
        };
      },
    },
  );
  assert.equal(baselineCalls, 1, 'without classification policy the existing semantic opt-in remains unchanged');
});

// ---------------------------------------------------------------------------
// R2I1: routingInputs' no-runtime-capabilities/no-runtime-probes branch must
// consult the on-disk capability cache before spawning fresh probes, save the
// cache after a fresh probe, and never persist native host-assertion entries.
// These tests deliberately omit runtime.capabilities and runtime.probes (both
// take precedence and would bypass the cache/probe path entirely) and instead
// restrict PATH to a temp bin dir holding a fake `claude` script that logs
// every invocation, so "the probe runner ran" is observable without mocking
// any module.
// ---------------------------------------------------------------------------

const R2I1_SAFE_SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);

function writeFakeClaudeBinary(binDir, probeLogPath) {
  const claudeScript = path.join(binDir, 'claude');
  fs.writeFileSync(claudeScript, [
    '#!/bin/sh',
    `echo "invoked $1" >> "${probeLogPath}"`,
    'if [ "$1" = "--version" ]; then echo "Claude Code v9.9.9"; exit 0; fi',
    'if [ "$1" = "--help" ]; then echo "  --effort <level>  set reasoning effort"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'));
  if (process.platform !== 'win32') fs.chmodSync(claudeScript, 0o755);
  return claudeScript;
}

test('R2I1: repository cache never skips current probes or supplies capability objects', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-r2i1-cache-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const binDir = temporaryDirectory('deep-review-r2i1-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  writeFakeClaudeBinary(binDir, probeLog);
  const env = { PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}`, PROBE_LOG: probeLog };

  const cachePath = path.join(repo, '.deep-review', 'tmp', 'capability-cache.json');

  const first = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files, '--emit-routing-plan'],
    env,
    {},
  );
  assert.ok(fs.existsSync(cachePath), 'a fresh probe must write the capability cache');
  const firstRoute = first.routing_plan.routes.find((route) => route.reviewer_id === 'claude-opus');
  assert.equal(firstRoute.adapter_id, 'claude-cli');
  const invocationsAfterFirst = fs.readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.ok(invocationsAfterFirst > 0, 'the first run must invoke the probe runner');

  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(Object.hasOwn(cached, 'capabilities'), false);
  assert.equal(Object.hasOwn(cached, 'probe_evidence'), false);
  assert.equal(cached.probe_results.claude.ok, true);

  const second = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files, '--emit-routing-plan'],
    env,
    {},
  );
  const invocationsAfterSecond = fs.readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.ok(invocationsAfterSecond > invocationsAfterFirst, 'repository cache must never skip a current probe');
  const secondRoute = second.routing_plan.routes.find((route) => route.reviewer_id === 'claude-opus');
  assert.equal(secondRoute.adapter_id, 'claude-cli', 'the cache hit must still resolve the correct adapter');
});

test('forged Codex probe evidence cannot select reviewers or skip the real failing probe', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const {
    CAPABILITY_CACHE_REVISION,
    capabilityCacheKeys,
  } = await import(pathToFileURL(path.join(root, 'hooks/scripts/lib/capability-registry.mjs')).href);
  const repo = temporaryDirectory('deep-review-forged-codex-cache-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const binDir = temporaryDirectory('deep-review-forged-codex-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  const codexPath = path.join(binDir, 'codex');
  fs.writeFileSync(codexPath, [
    '#!/bin/sh',
    `echo "invoked $1" >> "${probeLog}"`,
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(codexPath, 0o755);
  const detectedCodex = { codex_cli: true, codex_cli_path: codexPath };
  const keys = capabilityCacheKeys(detectedCodex, {});
  const cachePath = path.join(repo, '.deep-review', 'tmp', 'capability-cache.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify({
    protocol_version: '2.0',
    cache_contract_revision: CAPABILITY_CACHE_REVISION,
    invalidation_keys: keys,
    probe_evidence: { codex: { ok: true, version: '9.9.9' } },
    capabilities: [],
  })}\n`);

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files, '--emit-routing-plan'],
    { PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}` },
    { hostAssertions: { codexExecReviewer: true, codexNativeGeneric: false } },
  );
  assert.ok(fs.readFileSync(probeLog, 'utf8').includes('invoked --version'));
  assert.deepEqual(result.routing_plan.candidate_reviewers, []);
});

function writeFailingClaudeBinary(binDir, probeLogPath) {
  const claudeScript = path.join(binDir, 'claude');
  fs.writeFileSync(claudeScript, [
    '#!/bin/sh',
    `echo "invoked $1" >> "${probeLogPath}"`,
    'exit 1',
    '',
  ].join('\n'));
  if (process.platform !== 'win32') fs.chmodSync(claudeScript, 0o755);
  return claudeScript;
}

// ---------------------------------------------------------------------------
// H7: a transient probe failure (timeout/non-zero) must never be persisted to
// the on-disk capability cache — success-only persistence, no TTL — so the
// reviewer is re-probed (and can recover) on the very next run.
// ---------------------------------------------------------------------------

test('H7: a failed claude probe is never persisted to the capability cache', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-h7-failed-probe-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const binDir = temporaryDirectory('deep-review-h7-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  writeFailingClaudeBinary(binDir, probeLog);
  const env = { PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}`, PROBE_LOG: probeLog };

  const cachePath = path.join(repo, '.deep-review', 'tmp', 'capability-cache.json');
  await runClassifyArtifactsCli(['--repo', repo, '--files-from0', files, '--emit-routing-plan'], env, {});
  assert.equal(fs.existsSync(cachePath), false, 'a failed probe must never write the capability cache');
});

test('H7: overflowing Claude probe output cannot enable a reviewer or persist cache', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-h7-overflow-probe-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const binDir = temporaryDirectory('deep-review-h7-overflow-bin-');
  const claudeScript = path.join(binDir, 'claude');
  fs.writeFileSync(claudeScript, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ] || [ "$1" = "--help" ]; then',
    "  yes 'overflow-probe-output' | head -c 200000",
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'));
  fs.chmodSync(claudeScript, 0o755);
  const cachePath = path.join(repo, '.deep-review', 'tmp', 'capability-cache.json');

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files, '--emit-routing-plan'],
    { PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}` },
    {},
  );

  assert.equal(
    result.routing_plan.candidate_reviewers.some((item) => item.adapter_id === 'claude-cli'),
    false,
  );
  assert.equal(fs.existsSync(cachePath), false);
});

test('H7: a successful probe still writes the capability cache', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-h7-success-probe-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const binDir = temporaryDirectory('deep-review-h7-success-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  writeFakeClaudeBinary(binDir, probeLog);
  const env = { PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}`, PROBE_LOG: probeLog };

  const cachePath = path.join(repo, '.deep-review', 'tmp', 'capability-cache.json');
  await runClassifyArtifactsCli(['--repo', repo, '--files-from0', files, '--emit-routing-plan'], env, {});
  assert.ok(fs.existsSync(cachePath), 'a fully successful probe must still write the capability cache');
});

test('H7: a symlinked cache directory is neither read nor written outside the repository', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script and symlink'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-h7-cache-symlink-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const safeOutput = path.join(repo, 'safe-output');
  fs.mkdirSync(safeOutput);

  const outsideRoot = temporaryDirectory('deep-review-h7-cache-outside-');
  const outsideCache = path.join(outsideRoot, 'capability-cache.json');
  fs.writeFileSync(outsideCache, 'outside sentinel');
  fs.mkdirSync(path.join(repo, '.deep-review'));
  fs.symlinkSync(outsideRoot, path.join(repo, '.deep-review', 'tmp'));

  const binDir = temporaryDirectory('deep-review-h7-cache-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  writeFakeClaudeBinary(binDir, probeLog);
  const env = { PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}`, PROBE_LOG: probeLog };

  const result = await runClassifyArtifactsCli([
    '--repo', repo,
    '--files-from0', files,
    '--emit-routing-plan',
    '--out', path.join(safeOutput, 'artifact-classification.json'),
    '--routing-plan-out', path.join(safeOutput, 'routing-plan.json'),
  ], env, {});

  assert.ok(result.routing_plan.routes.some((route) => route.reviewer_id === 'claude-opus'));
  assert.ok(
    fs.readFileSync(probeLog, 'utf8').trim().length > 0,
    'the external sentinel must not be treated as a cache hit; fresh probes must run',
  );
  assert.equal(
    fs.readFileSync(outsideCache, 'utf8'),
    'outside sentinel',
    'best-effort cache persistence must never follow the symlink outside the repository',
  );
});

function writeFakeCodexBinary(binDir, probeLogPath) {
  const codexScript = path.join(binDir, 'codex');
  fs.writeFileSync(codexScript, [
    '#!/bin/sh',
    `echo "invoked $1" >> "${probeLogPath}"`,
    'if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi',
    'if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then',
    '  echo "--ephemeral --sandbox --ignore-user-config --ignore-rules --cd --skip-git-repo-check --output-last-message --color --model -c"',
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n'));
  if (process.platform !== 'win32') fs.chmodSync(codexScript, 0o755);
  return codexScript;
}

test('cache reuse across Claude and Codex hosts recomputes both Codex adapter availabilities from current assertions', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-codex-cross-host-cache-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const binDir = temporaryDirectory('deep-review-codex-cross-host-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  writeFakeCodexBinary(binDir, probeLog);
  const env = { PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}` };
  const argv = ['--repo', repo, '--files-from0', files, '--emit-routing-plan'];

  const claudeHost = await runClassifyArtifactsCli(argv, env, {
    hostAssertions: { codexExecReviewer: true, codexNativeGeneric: false },
  });
  assert.deepEqual(
    claudeHost.routing_plan.candidate_reviewers.map((candidate) => [candidate.reviewer_id, candidate.adapter_id]),
    [['codex-review', 'codex-exec'], ['codex-adversarial', 'codex-exec']],
  );
  const probeCalls = fs.readFileSync(probeLog, 'utf8');

  const codexHost = await runClassifyArtifactsCli(argv, env, {
    hostAssertions: { codexExecReviewer: false, codexNativeGeneric: true },
  });
  assert.deepEqual(
    codexHost.routing_plan.candidate_reviewers.map((candidate) => [candidate.reviewer_id, candidate.adapter_id]),
    [['codex-review', 'codex-native-generic'], ['codex-adversarial', 'codex-native-generic']],
  );
  const codexHostProbeCalls = fs.readFileSync(probeLog, 'utf8');
  assert.ok(codexHostProbeCalls.length > probeCalls.length, 'cross-host reuse must perform a fresh authoritative probe');

  const claudeHostAgain = await runClassifyArtifactsCli(argv, env, {
    hostAssertions: { codexExecReviewer: true, codexNativeGeneric: false },
  });
  assert.deepEqual(
    claudeHostAgain.routing_plan.candidate_reviewers.map((candidate) => [candidate.reviewer_id, candidate.adapter_id]),
    [['codex-review', 'codex-exec'], ['codex-adversarial', 'codex-exec']],
  );
  assert.ok(
    fs.readFileSync(probeLog, 'utf8').length > codexHostProbeCalls.length,
    'Codex-to-Claude reuse must also perform a fresh authoritative probe',
  );
});

test('Codex CLI removal invalidates cached probe evidence and companion detection never creates candidates', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-codex-cli-removal-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const binDir = temporaryDirectory('deep-review-codex-cli-removal-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  const codexPath = writeFakeCodexBinary(binDir, probeLog);
  const companionPath = path.join(binDir, 'codex-companion.mjs');
  fs.writeFileSync(companionPath, '// fake codex companion plugin\n');
  const env = {
    PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}`,
    CODEX_COMPANION_PATH: companionPath,
  };
  const argv = ['--repo', repo, '--files-from0', files, '--emit-routing-plan'];
  const hostAssertions = { codexExecReviewer: true, codexNativeGeneric: false };
  const first = await runClassifyArtifactsCli(argv, env, { hostAssertions });
  assert.equal(first.routing_plan.candidate_reviewers.length, 2);

  fs.rmSync(codexPath);
  const second = await runClassifyArtifactsCli(argv, env, { hostAssertions });
  assert.deepEqual(second.routing_plan.candidate_reviewers, []);
});

test('Codex CLI installation invalidates an absent-CLI cache and enables both codex-exec reviewers', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-codex-cli-install-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const binDir = temporaryDirectory('deep-review-codex-cli-install-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  const env = { PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}` };
  const argv = ['--repo', repo, '--files-from0', files, '--emit-routing-plan'];
  const hostAssertions = { codexExecReviewer: true, codexNativeGeneric: false };

  const absent = await runClassifyArtifactsCli(argv, env, { hostAssertions });
  assert.deepEqual(absent.routing_plan.candidate_reviewers, []);

  writeFakeCodexBinary(binDir, probeLog);
  const installed = await runClassifyArtifactsCli(argv, env, { hostAssertions });
  assert.deepEqual(
    installed.routing_plan.candidate_reviewers.map((candidate) => candidate.reviewer_id),
    ['codex-review', 'codex-adversarial'],
  );
});

test('R2I1: a corrupt capability cache falls open to a fresh probe instead of failing the preflight', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-r2i1-corrupt-cache-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const binDir = temporaryDirectory('deep-review-r2i1-corrupt-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  writeFakeClaudeBinary(binDir, probeLog);
  const env = { PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}`, PROBE_LOG: probeLog };

  const cachePath = path.join(repo, '.deep-review', 'tmp', 'capability-cache.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, 'not valid json {{{');

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files, '--emit-routing-plan'],
    env,
    {},
  );
  const route = result.routing_plan.routes.find((r) => r.reviewer_id === 'claude-opus');
  assert.equal(route.adapter_id, 'claude-cli', 'a corrupt cache must fail open to a fresh probe, never a hard error');
  const invocations = fs.readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.ok(invocations > 0, 'the corrupt-cache path must still invoke the probe runner');
});

test('R2I1: an oversized capability cache falls open to bounded fresh probes', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX-only fake probe shell script'); return; }
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-r2i1-oversized-cache-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');

  const binDir = temporaryDirectory('deep-review-r2i1-oversized-bin-');
  const probeLog = path.join(binDir, 'probe-calls.log');
  writeFakeClaudeBinary(binDir, probeLog);
  const env = {
    PATH: `${binDir}${path.delimiter}${R2I1_SAFE_SYSTEM_PATH}`,
    PROBE_LOG: probeLog,
  };
  const cachePath = path.join(repo, '.deep-review', 'tmp', 'capability-cache.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, ' '.repeat((64 * 1024) + 1));

  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--files-from0', files, '--emit-routing-plan'],
    env,
    {},
  );
  assert.ok(result.routing_plan.routes.some((route) => route.reviewer_id === 'claude-opus'));
  assert.ok(
    fs.readFileSync(probeLog, 'utf8').trim().length > 0,
    'oversized cache rejection must continue with fresh probes',
  );
});

// ---------------------------------------------------------------------------
// H3: content_risk/assessRisk must consider the actual change patch (removed
// lines, deleted-file content), not just the current working-tree content, so
// a change that erases high-risk terms from a neutrally named file — or
// deletes a high-risk file outright — still routes '/high/'.
// ---------------------------------------------------------------------------

function h3RoutingRuntime() {
  const capabilities = [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard', 'classifier'],
    model_selection: { supported: true, aliases: ['swift', 'steady', 'deep', 'best'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  }];
  const reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];
  return { capabilities, reviewers };
}

test('H3: removing a high-risk line from a neutrally named file still routes /high/ via the actual patch', async () => {
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = createGitFixture('h3-removed-content', { initialCommit: false });

  fs.writeFileSync(
    path.join(repo, 'session-notes.md'),
    '# Session Notes\n\nRemember to check the authorization guard before merging.\n',
  );
  git(repo, ['add', '--', 'session-notes.md']);
  git(repo, ['commit', '--quiet', '-m', 'base with a high-risk line']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(repo, 'session-notes.md'), '# Session Notes\n\nAll clear.\n');
  git(repo, ['add', '--', 'session-notes.md']);
  git(repo, ['commit', '--quiet', '-m', 'remove the high-risk line']);

  const { capabilities, reviewers } = h3RoutingRuntime();
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'clean', '--review-base', baseSha, '--emit-routing-plan'],
    {},
    { capabilities, reviewers },
  );
  const route = result.routing_plan.routes.find((item) => item.reviewer_id === 'claude-opus');
  assert.match(route.route_explanation, /\/high\//, 'the removed authorization line must still raise the routed risk floor to high');
  assert.doesNotMatch(JSON.stringify(result), /authorization guard/, 'raw diff text must never be persisted into provenance or the routing plan');
});

test('H3: deleting a file whose base content held a high-risk term still routes /high/ via the actual patch', async () => {
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = createGitFixture('h3-deleted-file', { initialCommit: false });

  fs.writeFileSync(
    path.join(repo, 'ops-notes.md'),
    '# Ops Notes\n\nRun the database migration script overnight.\n',
  );
  git(repo, ['add', '--', 'ops-notes.md']);
  git(repo, ['commit', '--quiet', '-m', 'base with a high-risk file']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);

  // Delete the high-risk file and add an unrelated file so the 'clean' scope
  // still has at least one classifiable artifact after the deletion.
  fs.rmSync(path.join(repo, 'ops-notes.md'));
  fs.writeFileSync(path.join(repo, 'readme.md'), '# Readme\n\nNothing special here.\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'delete the high-risk file, add an unrelated file']);

  const { capabilities, reviewers } = h3RoutingRuntime();
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'clean', '--review-base', baseSha, '--emit-routing-plan'],
    {},
    { capabilities, reviewers },
  );
  const route = result.routing_plan.routes.find((item) => item.reviewer_id === 'claude-opus');
  assert.match(route.route_explanation, /\/high\//, 'deleting a file whose base content held a high-risk term must still raise the routed risk floor to high');
  assert.doesNotMatch(JSON.stringify(result), /database migration/, 'raw diff text must never be persisted into provenance or the routing plan');
});

// ---------------------------------------------------------------------------
// J2 (security): writeProvenance / the routing-plan write must land at a
// repository-contained real path with no symlinked component. A symlinked
// destination file or a symlinked ancestor directory that escapes the repo
// must be refused, never followed.
// ---------------------------------------------------------------------------

test('J2: writeContainedFile performs a plain contained write and the content matches', async () => {
  const { writeContainedFile } = await import(runtimeContextUrl);
  const repo = temporaryDirectory('deep-review-j2-plain-');
  const dest = path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json');

  const returned = writeContainedFile(repo, dest, '{"ok":true}\n');

  assert.equal(returned, dest);
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"ok":true}\n');
});

test('J2: validateContainedFilePath preflights destinations without creating or writing them', async () => {
  const { validateContainedFilePath } = await import(runtimeContextUrl);
  assert.equal(typeof validateContainedFilePath, 'function');
  const repo = temporaryDirectory('deep-review-j2-validate-');
  const destination = path.join(repo, '.deep-review', 'reports', 'result.md');

  assert.equal(validateContainedFilePath(repo, destination), destination);
  assert.equal(fs.existsSync(path.join(repo, '.deep-review')), false);

  const outside = temporaryDirectory('deep-review-j2-validate-outside-');
  const target = path.join(outside, 'target.json');
  fs.writeFileSync(target, 'outside\n');
  const linkedDestination = path.join(repo, 'result.json');
  fs.symlinkSync(target, linkedDestination);
  assert.throws(() => validateContainedFilePath(repo, linkedDestination), /symlink/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside\n');
});

test('J2: writeContainedFile refuses a destination symlink pointing outside the repo and leaves the outside target unmodified', async () => {
  const { writeContainedFile } = await import(runtimeContextUrl);
  const repo = temporaryDirectory('deep-review-j2-dest-symlink-');
  const outsideRoot = temporaryDirectory('deep-review-j2-outside-file-');
  const outsideTarget = path.join(outsideRoot, 'victim.json');
  fs.writeFileSync(outsideTarget, 'untouched');
  fs.mkdirSync(path.join(repo, '.deep-review', 'tmp'), { recursive: true });
  const dest = path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json');
  fs.symlinkSync(outsideTarget, dest);

  assert.throws(() => writeContainedFile(repo, dest, '{"pwned":true}\n'), /symlink/);
  assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'untouched', 'the outside target must never be modified');
});

test('J2: writeContainedFile refuses a symlinked .deep-review/tmp ancestor directory that escapes the repo', async () => {
  const { writeContainedFile } = await import(runtimeContextUrl);
  const repo = temporaryDirectory('deep-review-j2-dir-symlink-');
  const outsideRoot = temporaryDirectory('deep-review-j2-outside-dir-');
  fs.mkdirSync(path.join(repo, '.deep-review'), { recursive: true });
  fs.symlinkSync(outsideRoot, path.join(repo, '.deep-review', 'tmp'));
  const dest = path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json');

  assert.throws(() => writeContainedFile(repo, dest, '{"pwned":true}\n'), /symlink/);
  assert.equal(
    fs.existsSync(path.join(outsideRoot, 'artifact-classification.json')),
    false,
    'no file must be written through the symlinked directory to the outside target',
  );
});

test('J2: writeContainedFile rejects an ancestor swapped to an outside symlink after validation', async () => {
  const { writeContainedFile } = await import(runtimeContextUrl);
  const repo = temporaryDirectory('deep-review-j2-ancestor-swap-');
  const outsideRoot = temporaryDirectory('deep-review-j2-swap-outside-');
  const parent = path.join(repo, '.deep-review', 'tmp');
  const displacedParent = path.join(repo, '.deep-review', 'tmp-before-swap');
  const outsideTarget = path.join(outsideRoot, 'artifact-classification.json');
  const dest = path.join(parent, 'artifact-classification.json');
  fs.mkdirSync(parent, { recursive: true });
  let swapped = false;
  let writeError;

  try {
    writeContainedFile(repo, dest, '{"pwned":true}\n', {
      beforeAtomicWrite() {
        fs.renameSync(parent, displacedParent);
        fs.symlinkSync(outsideRoot, parent, process.platform === 'win32' ? 'junction' : 'dir');
        swapped = true;
      },
    });
  } catch (error) {
    writeError = error;
  }
  assert.equal(swapped, true, 'the deterministic race hook must swap the validated ancestor');
  assert.equal(
    fs.existsSync(outsideTarget),
    false,
    'the write must fail before publishing through the swapped ancestor',
  );
  assert.deepEqual(
    fs.readdirSync(displacedParent),
    [],
    'a rejected publication must leave no temporary file in the displaced directory',
  );
  assert.match(writeError?.message ?? '', /changed during contained write/);
});

test('J2: readContainedFile refuses a symlinked ancestor directory that escapes the repo', async () => {
  const { readContainedFile } = await import(runtimeContextUrl);
  const repo = temporaryDirectory('deep-review-j2-read-dir-symlink-');
  const outsideRoot = temporaryDirectory('deep-review-j2-read-outside-');
  fs.writeFileSync(path.join(outsideRoot, 'capability-cache.json'), '{"outside":true}\n');
  fs.mkdirSync(path.join(repo, '.deep-review'), { recursive: true });
  fs.symlinkSync(outsideRoot, path.join(repo, '.deep-review', 'tmp'));

  assert.throws(
    () => readContainedFile(repo, path.join(repo, '.deep-review', 'tmp', 'capability-cache.json')),
    /symlink/,
  );
});

test('J2: readContainedFile rejects an oversized regular file before returning its contents', async () => {
  const { readContainedFile } = await import(runtimeContextUrl);
  const repo = temporaryDirectory('deep-review-j2-read-bounded-');
  const cache = path.join(repo, 'capability-cache.json');
  fs.writeFileSync(cache, 'x'.repeat(65));

  assert.throws(
    () => readContainedFile(repo, cache, { maxBytes: 64 }),
    /maximum|exceeds|too large/iu,
  );
});

test('J2: a benign runClassifyArtifactsCli run still writes provenance through the contained-write path', async () => {
  const { runClassifyArtifactsCli } = await loadScope();
  const repo = temporaryDirectory('deep-review-j2-benign-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const capabilities = [{
    protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true,
    roles: ['standard'],
    model_selection: { supported: true, aliases: ['steady'], catalog_complete: false, transport: 'flag:--model' },
    effort_selection: { supported: true, levels: ['low', 'medium'], transport: 'flag:--effort' },
    structured_output: true, read_only_enforcement: 'process-contract',
  }];
  const reviewers = [{ id: 'claude-opus', provider: 'claude', role: 'standard', adapter_id: 'claude-cli' }];

  await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files],
    {},
    { capabilities, reviewers },
  );

  const provenancePath = path.join(repo, '.deep-review', 'tmp', 'artifact-classification.json');
  assert.ok(fs.existsSync(provenancePath), 'provenance must still be written for a benign run');
  const written = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  assert.equal(written.artifacts[0].path, 'notes.md');
});
