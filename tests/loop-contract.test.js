'use strict';

// T-CADENCE-1 — round 2+ is derived by two shipped instruction authorities.
//
// There is no hidden runtime normalizer to test: the loop owner reads one of
// these authorities and applies the JavaScript policy block it contains. This
// test therefore executes each shipped block independently, then sends the
// resulting argv through the real public grammar. The examples below are the
// contract boundary: a prose-only token-list assertion would miss conflicts
// introduced by a malformed or partially stripped flag/value pair.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const routeUrl = pathToFileURL(path.join(root, 'hooks/scripts/public-route.mjs')).href;

const LOOP_SKILL = 'skills/deep-review-loop/SKILL.md';
const ULTRACODE_REFERENCE = 'skills/deep-review-workflow/references/ultracode-integration.md';
const CLAUDE_ADAPTER = 'commands/deep-review.md';
const NORMALIZER_START = '<!-- ultracode-round-2-normalizer:start -->';
const NORMALIZER_END = '<!-- ultracode-round-2-normalizer:end -->';

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n|\r/gu, '\n');
}

function argumentHint(source, relativePath) {
  const matches = [...source.matchAll(/^argument-hint: (.+)$/gmu)];
  assert.equal(matches.length, 1, `${relativePath}: expected exactly one argument-hint`);
  return matches[0][1];
}

function cadenceNormalizer(relativePath) {
  const source = read(relativePath);
  const starts = source.split(NORMALIZER_START).length - 1;
  const ends = source.split(NORMALIZER_END).length - 1;
  assert.equal(starts, 1, `${relativePath}: expected exactly one cadence normalizer start marker`);
  assert.equal(ends, 1, `${relativePath}: expected exactly one cadence normalizer end marker`);
  const block = source.slice(
    source.indexOf(NORMALIZER_START) + NORMALIZER_START.length,
    source.indexOf(NORMALIZER_END),
  ).trim();
  const match = block.match(/^```javascript\n([\s\S]+)\n```$/u);
  assert.ok(match, `${relativePath}: cadence normalizer must be one JavaScript fence`);
  const normalize = Function(`"use strict"; return (${match[1]});`)();
  assert.equal(typeof normalize, 'function', `${relativePath}: cadence normalizer is not callable`);
  return normalize;
}

function count(argv, token) {
  return argv.filter((candidate) => candidate === token).length;
}

function assertNoGrokCarrier(route, label) {
  const overrides = route.overrides ?? {};
  assert.equal(Object.hasOwn(overrides.providers ?? {}, 'grok'), false, `${label}: Grok provider override survived`);
  assert.equal(Object.hasOwn(overrides.reviewers ?? {}, 'grok'), false, `${label}: Grok reviewer override survived`);
  for (const field of ['enabled_providers', 'required_providers', 'required_reviewers']) {
    assert.equal((overrides[field] ?? []).includes('grok'), false, `${label}: ${field} still carries Grok`);
  }
}

test('T-CADENCE-1: both cadence authorities strip Grok selectors and parse derived argv successfully', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const authorities = [LOOP_SKILL, ULTRACODE_REFERENCE].map((relativePath) => ({
    relativePath,
    normalize: cadenceNormalizer(relativePath),
  }));

  for (const relativePath of [LOOP_SKILL, CLAUDE_ADAPTER]) {
    assert.match(argumentHint(read(relativePath), relativePath), /\[--grok\|--no-grok\]/u);
  }

  const cases = [
    {
      name: 'positive selector',
      argv: ['--entropy', '--ultracode', '--grok'],
      expected: ['--entropy', '--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'provider model override',
      argv: ['--ultracode', '--model', 'grok=grok-4.6'],
      expected: ['--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'provider effort override',
      argv: ['--ultracode', '--effort', 'grok=high'],
      expected: ['--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'reviewer model override',
      argv: ['--ultracode', '--reviewer-model', 'grok=grok-4.6'],
      expected: ['--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'reviewer effort override',
      argv: ['--ultracode', '--reviewer-effort', 'grok=high'],
      expected: ['--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'existing disable is replaced, not duplicated',
      argv: ['--ultracode', '--no-grok'],
      expected: ['--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'neighbouring provider value survives before Grok pair',
      argv: ['--ultracode', '--model', 'codex=keep--grok-literal', '--effort', 'grok=high'],
      expected: ['--model', 'codex=keep--grok-literal', '--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'neighbouring provider value survives after Grok pair',
      argv: ['--ultracode', '--effort', 'grok=high', '--model', 'codex=keep--grok-literal'],
      expected: ['--model', 'codex=keep--grok-literal', '--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'neighbouring reviewer value survives before Grok pair',
      argv: ['--ultracode', '--reviewer-model', 'codex-review=keep--grok-literal', '--effort', 'grok=high'],
      expected: ['--reviewer-model', 'codex-review=keep--grok-literal', '--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'neighbouring reviewer value survives after Grok pair',
      argv: ['--ultracode', '--effort', 'grok=high', '--reviewer-model', 'codex-review=keep--grok-literal'],
      expected: ['--reviewer-model', 'codex-review=keep--grok-literal', '--no-opus', '--no-agy', '--no-grok'],
    },
    {
      name: 'Codex-unavailable branch preserves a neighbouring Claude reviewer value',
      argv: ['--ultracode', '--reviewer-model', 'claude-opus=keep--grok-literal', '--effort', 'grok=high'],
      codexUnavailable: true,
      expected: ['--reviewer-model', 'claude-opus=keep--grok-literal', '--no-agy', '--no-grok'],
    },
    {
      name: 'Codex-unavailable exception withholds only no-opus',
      argv: ['--ultracode', '--grok', '--codex'],
      codexUnavailable: true,
      expected: ['--codex', '--no-agy', '--no-grok'],
    },
  ];

  for (const fixture of cases) {
    const derivedByAuthority = authorities.map(({ normalize }) => (
      normalize([...fixture.argv], { codexUnavailable: fixture.codexUnavailable === true })
    ));
    assert.deepEqual(
      derivedByAuthority[0],
      derivedByAuthority[1],
      `${fixture.name}: cadence authorities produced different normalized argv`,
    );
    for (const [index, { relativePath }] of authorities.entries()) {
      const derived = derivedByAuthority[index];
      assert.deepEqual(derived, fixture.expected, `${relativePath}: ${fixture.name}`);
      assert.equal(count(derived, '--no-grok'), 1, `${relativePath}: ${fixture.name}: Grok disable count`);
      assert.equal(derived.includes('--ultracode'), false, `${relativePath}: ${fixture.name}: ultracode survived`);
      const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv: derived });
      assert.equal(route.ok, true, `${relativePath}: ${fixture.name}: ${route.error ?? 'route rejected'}`);
      assert.equal(count(route.argv, '--no-grok'), 1, `${relativePath}: ${fixture.name}: parsed Grok disable count`);
      assertNoGrokCarrier(route, `${relativePath}: ${fixture.name}`);
    }
  }

  const malformed = [
    {
      name: 'empty Grok provider assignment',
      argv: ['--ultracode', '--model', 'grok='],
      expected: ['--model', 'grok=', '--no-opus', '--no-agy', '--no-grok'],
      error: /--model requires <provider>=<value>/u,
    },
    {
      name: 'selector cannot become a neighbouring assignment value',
      argv: ['--ultracode', '--model', '--grok'],
      expected: ['--model', '--no-opus', '--no-agy', '--no-grok'],
      error: /--model requires <provider>=<value>/u,
    },
    {
      name: 'literal non-provider example before Grok pair remains invalid and intact',
      argv: ['--ultracode', '--model', 'claude-opus=keep--grok-literal', '--effort', 'grok=high'],
      expected: ['--model', 'claude-opus=keep--grok-literal', '--no-opus', '--no-agy', '--no-grok'],
      error: /unknown provider: claude-opus/u,
    },
    {
      name: 'literal non-provider example after Grok pair remains invalid and intact',
      argv: ['--ultracode', '--effort', 'grok=high', '--model', 'claude-opus=keep--grok-literal'],
      expected: ['--model', 'claude-opus=keep--grok-literal', '--no-opus', '--no-agy', '--no-grok'],
      error: /unknown provider: claude-opus/u,
    },
  ];

  for (const fixture of malformed) {
    const derivedByAuthority = authorities.map(({ normalize }) => normalize([...fixture.argv]));
    assert.deepEqual(
      derivedByAuthority[0],
      derivedByAuthority[1],
      `${fixture.name}: cadence authorities produced different normalized argv`,
    );
    for (const [index, { relativePath }] of authorities.entries()) {
      const derived = derivedByAuthority[index];
      assert.deepEqual(derived, fixture.expected, `${relativePath}: ${fixture.name}`);
      const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: root, argv: derived });
      assert.equal(route.ok, false, `${relativePath}: ${fixture.name}: malformed input was laundered`);
      assert.match(route.error, fixture.error, `${relativePath}: ${fixture.name}: wrong public-route error`);
    }
  }
});
