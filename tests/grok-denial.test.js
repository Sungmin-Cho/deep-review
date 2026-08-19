'use strict';

// SLICE-004 — public grammar and the provider-denial gate (D5 / D13 / D23, I43).
//
// D23 is an *invocation-level* gate: a positively-candidate Grok invocation that
// effective policy rejects must return ERROR_PROVIDER_DENIED before coordinator
// creation, having observed zero executable lookup, carrier creation,
// version/help probe, privacy/config mutation, fingerprint, UUID, prompt
// construction, and provider-child calls.
//
// The defect this file exists to prevent is a denial gate keyed on `--grok`
// alone while D13 makes candidacy true for several sources. The acceptance is
// therefore a cross-product, built programmatically so a missing cell is
// impossible:
//
//   {candidacy source} x {denied_providers membership, allowed_providers
//    exclusion} x {review, dry-run, loop}
//
// Side effects are observed from *outside* the parser: every cell runs in a
// child process whose `node:fs`, `node:child_process` and `node:crypto` surfaces
// are instrumented by a preloaded CJS shim, backed by two independent
// corroborations (a PATH shim log and a recursive filesystem snapshot). The
// instrument is not assumed to work — `the side-effect instrument observes the
// side effects it claims to observe` is a positive control that fails if the
// instrument is vacuous.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const routeUrl = pathToFileURL(path.join(root, 'hooks', 'scripts', 'public-route.mjs')).href;
const classifyUrl = pathToFileURL(path.join(root, 'hooks', 'scripts', 'classify-artifacts.mjs')).href;

const temporaryRoots = new Set();

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.add(directory);
  return directory;
}

test.after(() => {
  for (const directory of temporaryRoots) fs.rmSync(directory, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// The out-of-process side-effect instrument.
// --------------------------------------------------------------------------

const PRELOAD_SOURCE = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const fsPromises = require('node:fs/promises');",
  "const cp = require('node:child_process');",
  "const crypto = require('node:crypto');",
  'const logPath = process.env.DR_PROBE_LOG;',
  "const binDir = process.env.DR_PROBE_BIN || '\\u0000no-bin-dir';",
  'const originalWriteFileSync = fs.writeFileSync;',
  'const events = [];',
  'function record(kind, detail) { events.push(kind + \' \' + String(detail)); }',
  "for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {",
  '  const original = cp[name];',
  "  if (typeof original !== 'function') continue;",
  "  cp[name] = function instrumented(...args) { record('child', name + ':' + String(args[0])); return original.apply(this, args); };",
  '}',
  "for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'mkdtempSync', 'rmSync', 'rm', 'unlinkSync', 'rmdirSync', 'renameSync', 'copyFileSync', 'truncateSync', 'chmodSync', 'symlinkSync', 'createWriteStream']) {",
  '  const original = fs[name];',
  "  if (typeof original !== 'function') continue;",
  "  fs[name] = function instrumented(...args) { record('mutation', name + ':' + String(args[0])); return original.apply(this, args); };",
  '}',
  "for (const name of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'unlink', 'rmdir', 'rename', 'copyFile', 'truncate', 'chmod', 'symlink', 'open']) {",
  '  const original = fsPromises[name];',
  "  if (typeof original !== 'function') continue;",
  "  fsPromises[name] = function instrumented(...args) { record('mutation', 'promises.' + name + ':' + String(args[0])); return original.apply(this, args); };",
  '}',
  'const originalOpenSync = fs.openSync;',
  "fs.openSync = function instrumented(...args) { record('open', String(args[0]) + ':' + String(args[1])); return originalOpenSync.apply(this, args); };",
  "for (const name of ['existsSync', 'statSync', 'lstatSync', 'accessSync', 'realpathSync', 'readFileSync', 'readdirSync', 'opendirSync']) {",
  '  const original = fs[name];',
  "  if (typeof original !== 'function') continue;",
  '  fs[name] = function instrumented(...args) {',
  '    const target = String(args[0]);',
  "    if (target.startsWith(binDir)) record('lookup', name + ':' + target);",
  '    return original.apply(this, args);',
  '  };',
  '}',
  'const originalRandomUUID = crypto.randomUUID;',
  "crypto.randomUUID = function instrumented(...args) { record('uuid', 'randomUUID'); return originalRandomUUID.apply(this, args); };",
  'const originalRandomBytes = crypto.randomBytes;',
  "crypto.randomBytes = function instrumented(...args) { record('uuid', 'randomBytes'); return originalRandomBytes.apply(this, args); };",
  "process.on('exit', () => { if (logPath) originalWriteFileSync(logPath, JSON.stringify(events)); });",
].join('\n');

// The driver imports `node:fs` / `node:child_process` / `node:crypto` with the
// same static named-import shape `public-route.mjs` uses, so the positive
// control exercises exactly the binding path the parser would use.
const DRIVER_SOURCE = [
  "import { spawnSync } from 'node:child_process';",
  "import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs';",
  "import { randomUUID } from 'node:crypto';",
  "import { join } from 'node:path';",
  '',
  'const spec = JSON.parse(process.env.DR_SPEC);',
  'const route = await import(process.env.DR_ROUTE_URL);',
  'let result;',
  "if (spec.mode === 'selfcheck') {",
  "  spawnSync(process.execPath, ['-e', '0']);",
  "  const scratch = join(spec.scratch, 'selfcheck.txt');",
  "  writeFileSync(scratch, 'x');",
  "  closeSync(openSync(scratch, 'r'));",
  "  existsSync(join(process.env.DR_PROBE_BIN, 'grok'));",
  '  result = { ok: true, uuid: randomUUID() };',
  "} else if (spec.mode === 'route') {",
  '  result = route.parsePublicRoute({ entry: spec.entry, host: spec.host, argv: spec.argv, cwd: spec.cwd });',
  "} else if (spec.mode === 'gate') {",
  '  const message = route.grokDenialGate(spec.expanded, spec.overrides, spec.cwd, process.env);',
  "  result = message === null ? { ok: true } : { ok: false, route: 'error', error: message };",
  "} else if (spec.mode === 'candidacy') {",
  '  result = { ok: true, candidacy: route.effectiveGrokCandidacy(spec.expanded, spec.overrides) };',
  '} else {',
  '  throw new Error(`unknown driver mode: ${spec.mode}`);',
  '}',
  'process.stdout.write(JSON.stringify(result));',
].join('\n');

const PROBE_SHIM_SOURCE = [
  '#!/bin/sh',
  'printf "%s\\n" "$0 $*" >> "$DR_SHIM_LOG"',
  'exit 0',
].join('\n');

let harness = null;
let driverRun = 0;

function instrumentHarness() {
  if (harness !== null) return harness;
  const base = temporaryDirectory('deep-review-grok-denial-harness-');
  const bin = path.join(base, 'bin');
  const logs = path.join(base, 'logs');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  for (const name of ['grok', 'claude', 'codex', 'agy', 'git', 'which']) {
    const shim = path.join(bin, name);
    fs.writeFileSync(shim, PROBE_SHIM_SOURCE);
    fs.chmodSync(shim, 0o755);
  }
  const preload = path.join(base, 'probe-preload.cjs');
  const driver = path.join(base, 'driver.mjs');
  fs.writeFileSync(preload, PRELOAD_SOURCE);
  fs.writeFileSync(driver, DRIVER_SOURCE);
  harness = { base, bin, logs, preload, driver };
  return harness;
}

function snapshot(directory) {
  const rows = [];
  const walk = (current) => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.relative(directory, full);
      if (entry.isDirectory()) {
        rows.push(`d ${relative}`);
        walk(full);
      } else {
        const body = fs.readFileSync(full);
        rows.push(`f ${relative} ${body.length} ${createHash('sha256').update(body).digest('hex')}`);
      }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return rows.join('\n');
}

// Runs one cell in an instrumented child process and returns the parsed route
// plus every independent side-effect observation.
function runDriver(spec, fixture) {
  const instrument = instrumentHarness();
  driverRun += 1;
  const probeLog = path.join(instrument.logs, `probe-${driverRun}.json`);
  const shimLog = path.join(instrument.logs, `shim-${driverRun}.log`);
  const watched = [fixture.repo, fixture.home, instrument.bin];
  const before = watched.map((directory) => snapshot(directory));
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  const child = spawnSync(process.execPath, [instrument.driver], {
    encoding: 'utf8',
    env: {
      ...environment,
      HOME: fixture.home,
      XDG_CONFIG_HOME: fixture.configHome,
      PATH: [instrument.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      NODE_OPTIONS: `--require ${instrument.preload}`,
      DR_SPEC: JSON.stringify(spec),
      DR_ROUTE_URL: routeUrl,
      DR_PROBE_LOG: probeLog,
      DR_PROBE_BIN: instrument.bin,
      DR_SHIM_LOG: shimLog,
    },
  });
  const after = watched.map((directory) => snapshot(directory));
  const raw = fs.existsSync(probeLog) ? JSON.parse(fs.readFileSync(probeLog, 'utf8')) : null;
  // Node 22's ESM loader opens every module through the public `fs.openSync`,
  // so the instrument doubles as a module-load ledger: `file://` opens are
  // module loads, everything else is an application open.
  const moduleLoads = (raw || []).filter((event) => event.startsWith('open file://'));
  const events = (raw || []).filter((event) => !event.startsWith('open file://'));
  const counts = { child: 0, mutation: 0, open: 0, lookup: 0, uuid: 0 };
  for (const event of events) counts[event.slice(0, event.indexOf(' '))] += 1;
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    result: child.status === 0 ? JSON.parse(child.stdout) : null,
    events: raw === null ? null : events,
    moduleLoads,
    counts,
    shimInvocations: fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8').trim().split('\n') : [],
    filesystemChanged: watched.filter((_, index) => before[index] !== after[index]),
  };
}

// A Grok runtime module reaching the loader at all would mean carrier, privacy,
// containment, fingerprint or bridge work was entered — the seams D23 forbids
// before denial.
const FORBIDDEN_MODULE = /(grok-carrier|grok-compatibility|grok-privacy|grok-process|grok-containment|run-grok-reviewer|agy-privacy|fingerprint|prompt-transport|detect-environment)/u;

function assertZeroSideEffects(run, label) {
  assert.notEqual(run.events, null, `${label}: the side-effect instrument produced no log`);
  assert.deepEqual(
    run.counts,
    { child: 0, mutation: 0, open: 0, lookup: 0, uuid: 0 },
    `${label}: a denied invocation must observe zero executable lookup, carrier creation, `
    + `version/help probe, privacy/config mutation, fingerprint, UUID, prompt construction, `
    + `and provider-child calls — saw ${JSON.stringify(run.events)}`,
  );
  assert.deepEqual(run.shimInvocations, [], `${label}: no provider executable may be invoked`);
  assert.deepEqual(run.filesystemChanged, [], `${label}: a denied invocation must mutate nothing on disk`);
  assert.deepEqual(
    run.moduleLoads.filter((entry) => FORBIDDEN_MODULE.test(entry)), [],
    `${label}: no carrier, privacy, containment, fingerprint, detection or bridge module may be reached`,
  );
}

// --------------------------------------------------------------------------
// The cross-product.
// --------------------------------------------------------------------------

// D13 candidacy sources. `argv` sources are transported by the public grammar
// and run the real entrypoint end to end. `overrides` sources
// (enabled_providers / required_providers) have no standalone public token —
// they are produced by the argv sources or by a foreign producer feeding
// `--overrides-json` — so their cells drive the same normalized gate directly
// with each entrypoint's own token vector.
const CANDIDACY_SOURCES = [
  { id: 'grok-flag', transport: 'argv', argv: ['--grok'] },
  { id: 'provider-model-override', transport: 'argv', argv: ['--model', 'grok=grok-4.6'] },
  { id: 'provider-effort-override', transport: 'argv', argv: ['--effort', 'grok=high'] },
  { id: 'reviewer-model-override', transport: 'argv', argv: ['--reviewer-model', 'grok=grok-4.6'] },
  { id: 'reviewer-effort-override', transport: 'argv', argv: ['--reviewer-effort', 'grok=high'] },
  {
    id: 'enabled-providers',
    transport: 'overrides',
    overrides: { protocol_version: '2.0', providers: {}, reviewers: {}, enabled_providers: ['grok'] },
  },
  {
    id: 'required-providers',
    transport: 'overrides',
    overrides: { protocol_version: '2.0', providers: {}, reviewers: {}, required_providers: ['grok'] },
  },
];

const DENIED_POLICY_SHAPES = [
  { id: 'project-denied-providers', project: "constraints:\n  denied_providers: ['grok']\n", user: null },
  { id: 'project-allowed-providers-excludes-grok', project: "constraints:\n  allowed_providers: ['claude', 'codex']\n", user: null },
  { id: 'user-denied-providers', project: null, user: "constraints:\n  denied_providers: ['grok']\n" },
  { id: 'user-allowed-providers-excludes-grok', project: null, user: "constraints:\n  allowed_providers: ['claude', 'codex']\n" },
];

const ALLOWED_POLICY_SHAPES = [
  { id: 'no-policy', project: null, user: null },
  { id: 'project-allowed-providers-includes-grok', project: "constraints:\n  allowed_providers: ['claude', 'codex', 'grok']\n", user: null },
];

const ENTRYPOINTS = [
  { id: 'review', entry: 'review', prefix: [] },
  { id: 'dry-run', entry: 'review', prefix: ['--dry-run'] },
  { id: 'loop', entry: 'loop', prefix: [] },
];

function policyFixture(shape) {
  const base = temporaryDirectory('deep-review-grok-denial-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const configHome = path.join(home, '.config');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(configHome, { recursive: true });
  if (shape.project !== null) {
    fs.mkdirSync(path.join(repo, '.deep-review'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.deep-review', 'review-policy.yaml'), `schema_version: 2\n${shape.project}`);
  }
  if (shape.user !== null) {
    fs.mkdirSync(path.join(configHome, 'deep-review'), { recursive: true });
    fs.writeFileSync(path.join(configHome, 'deep-review', 'config.yaml'), `schema_version: 2\n${shape.user}`);
  }
  return { base, repo, home, configHome };
}

function buildCells(shapes) {
  const cells = [];
  for (const source of CANDIDACY_SOURCES) {
    for (const shape of shapes) {
      for (const entrypoint of ENTRYPOINTS) {
        cells.push({ id: `${source.id} x ${shape.id} x ${entrypoint.id}`, source, shape, entrypoint });
      }
    }
  }
  return cells;
}

function cellSpec(cell, fixture) {
  const { source, entrypoint } = cell;
  if (source.transport === 'argv') {
    return {
      mode: 'route',
      entry: entrypoint.entry,
      host: 'claude',
      argv: [...entrypoint.prefix, ...source.argv],
      cwd: fixture.repo,
    };
  }
  return {
    mode: 'gate',
    expanded: [...entrypoint.prefix],
    overrides: source.overrides,
    cwd: fixture.repo,
  };
}

test('the side-effect instrument observes the side effects it claims to observe', () => {
  const fixture = policyFixture({ project: null, user: null });
  const run = runDriver({ mode: 'selfcheck', scratch: fixture.repo }, fixture);
  assert.equal(run.status, 0, `driver failed: ${run.stderr}`);
  assert.notEqual(run.events, null, 'the instrument must produce a log');
  for (const kind of ['child', 'mutation', 'open', 'lookup', 'uuid']) {
    assert.ok(
      run.counts[kind] > 0,
      `the instrument is vacuous for ${kind}: it observed nothing while the driver deliberately `
      + `performed that side effect through the same static named-import binding public-route.mjs uses`,
    );
  }
  assert.notDeepEqual(run.filesystemChanged, [], 'the filesystem snapshot must detect a real write');
  assert.ok(
    run.moduleLoads.length > 0,
    'the module-load ledger is vacuous: the loader no longer opens modules through the public fs.openSync, '
    + 'so the "no Grok runtime module is reached" assertion would pass without proving anything',
  );
});

test('every candidacy source x denial representation x entrypoint is denied before coordinator creation', () => {
  const cells = buildCells(DENIED_POLICY_SHAPES);
  assert.equal(CANDIDACY_SOURCES.length, 7, 'D13 names seven candidacy sources');
  assert.equal(DENIED_POLICY_SHAPES.length, 4, 'two denial representations x two policy sources');
  assert.equal(ENTRYPOINTS.length, 3, 'review, dry-run and loop');
  assert.equal(cells.length, 84, 'the cross-product must be complete: 7 x 4 x 3');

  const fixtures = new Map(DENIED_POLICY_SHAPES.map((shape) => [shape.id, policyFixture(shape)]));
  for (const cell of cells) {
    const fixture = fixtures.get(cell.shape.id);
    const run = runDriver(cellSpec(cell, fixture), fixture);
    assert.equal(run.status, 0, `${cell.id}: driver failed: ${run.stderr}`);
    assert.equal(run.result.ok, false, `${cell.id}: a denied invocation must not succeed`);
    assert.equal(run.result.route, 'error', `${cell.id}: a denied invocation must route to error`);
    assert.match(
      run.result.error,
      /^ERROR_PROVIDER_DENIED\b/u,
      `${cell.id}: effective policy rejection of positive Grok candidacy is ERROR_PROVIDER_DENIED`,
    );
    assert.equal(
      Object.hasOwn(run.result, 'overrides'), false,
      `${cell.id}: a denied invocation must emit no Grok state`,
    );
    assertZeroSideEffects(run, cell.id);
  }
});

test('an effective policy that permits grok denies no candidacy source at any entrypoint', () => {
  const cells = buildCells(ALLOWED_POLICY_SHAPES);
  assert.equal(cells.length, 42, 'the allow control must cover 7 x 2 x 3');
  const fixtures = new Map(ALLOWED_POLICY_SHAPES.map((shape) => [shape.id, policyFixture(shape)]));
  for (const cell of cells) {
    const fixture = fixtures.get(cell.shape.id);
    const run = runDriver(cellSpec(cell, fixture), fixture);
    assert.equal(run.status, 0, `${cell.id}: driver failed: ${run.stderr}`);
    assert.equal(
      run.result.ok, true,
      `${cell.id}: the gate must not over-fire — ${run.result.error}`,
    );
    if (cell.source.transport === 'argv') {
      assert.deepEqual(
        run.result.overrides.enabled_providers, ['grok'],
        `${cell.id}: a permitted candidacy source restores grok candidacy`,
      );
    }
  }
});

// --------------------------------------------------------------------------
// The four distinctions D23 separates and that are easy to collapse.
// --------------------------------------------------------------------------

test('invocation-disable is silent successful negative selection, never ERROR_PROVIDER_DENIED', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const fixture = policyFixture(DENIED_POLICY_SHAPES[0]);
  for (const argv of [['--no-grok'], ['--codex-only']]) {
    for (const entry of ['review', 'loop']) {
      const label = `${entry} ${argv.join(' ')}`;
      const route = parsePublicRoute({ entry, host: 'claude', argv, cwd: fixture.repo });
      assert.equal(route.ok, true, `${label}: invocation-disable is a successful negative selection`);
      assert.ok(route.overrides.disabled_providers.includes('grok'), `${label}: grok is disabled`);
      assert.equal(
        (route.overrides.enabled_providers || []).includes('grok'), false,
        `${label}: invocation-disable creates zero Grok candidacy state`,
      );
      assert.equal(
        (route.overrides.required_providers || []).includes('grok'), false,
        `${label}: invocation-disable creates zero Grok requirement state`,
      );
    }
  }
});

test('a denying policy still returns ok for invocation-disable and for a no-flag review', () => {
  const fixture = policyFixture(DENIED_POLICY_SHAPES[0]);
  for (const argv of [[], ['--no-grok'], ['--codex-only']]) {
    for (const entrypoint of ENTRYPOINTS) {
      const label = `${entrypoint.id} ${argv.join(' ') || '<no flags>'}`;
      const run = runDriver({
        mode: 'route', entry: entrypoint.entry, host: 'claude', argv: [...entrypoint.prefix, ...argv], cwd: fixture.repo,
      }, fixture);
      assert.equal(run.status, 0, `${label}: driver failed: ${run.stderr}`);
      assert.equal(
        run.result.ok, true,
        `${label}: ERROR_PROVIDER_DENIED is reserved for positive Grok candidacy — got ${run.result.error}`,
      );
      assertZeroSideEffects(run, label);
    }
  }
});

test('--grok combined with --no-grok or --codex-only is a selection conflict, not a denial', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const fixture = policyFixture(DENIED_POLICY_SHAPES[0]);
  for (const argv of [['--grok', '--no-grok'], ['--grok', '--codex-only'], ['--codex-only', '--grok']]) {
    for (const entry of ['review', 'loop']) {
      const label = `${entry} ${argv.join(' ')}`;
      const route = parsePublicRoute({ entry, host: 'claude', argv, cwd: fixture.repo });
      assert.equal(route.ok, false, `${label}: the combination is rejected`);
      assert.match(
        route.error,
        /--grok cannot be combined with --no-grok\/--codex-only/u,
        `${label}: the combination is a selection conflict`,
      );
      assert.doesNotMatch(route.error, /ERROR_PROVIDER_DENIED/u, `${label}: it is not a policy denial`);
    }
  }
});

test('--no-grok with a Grok-targeting override is ERROR_CONFLICTING_REVIEWER_SELECTION', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const fixture = policyFixture({ project: null, user: null });
  const overrides = [
    ['--model', 'grok=grok-4.6'],
    ['--effort', 'grok=high'],
    ['--reviewer-model', 'grok=grok-4.6'],
    ['--reviewer-effort', 'grok=high'],
  ];
  for (const override of overrides) {
    for (const disable of [['--no-grok'], ['--codex-only']]) {
      for (const entry of ['review', 'loop']) {
        const label = `${entry} ${disable.join(' ')} ${override.join(' ')}`;
        const route = parsePublicRoute({ entry, host: 'claude', argv: [...disable, ...override], cwd: fixture.repo });
        assert.equal(route.ok, false, `${label}: the combination is rejected`);
        assert.match(
          route.error,
          /^ERROR_CONFLICTING_REVIEWER_SELECTION\b/u,
          `${label}: matching the agy precedent at public-route.mjs:265-267 and :277-279`,
        );
        assert.doesNotMatch(route.error, /ERROR_PROVIDER_DENIED/u, `${label}: it is not a policy denial`);
      }
    }
  }
});

// --------------------------------------------------------------------------
// The normalized candidacy predicate and the precedence truth table.
// --------------------------------------------------------------------------

test('effectiveGrokCandidacy normalizes every D13 source and is false without one', async () => {
  const { effectiveGrokCandidacy } = await import(routeUrl);
  const empty = { providers: {}, reviewers: {} };
  const truthy = [
    ['--grok flag', ['--grok'], empty],
    ['provider model override', [], { providers: { grok: { model: 'grok-4.6' } }, reviewers: {} }],
    ['provider effort override', [], { providers: { grok: { effort: 'high' } }, reviewers: {} }],
    ['reviewer model override', [], { providers: {}, reviewers: { grok: { model: 'grok-4.6' } } }],
    ['reviewer effort override', [], { providers: {}, reviewers: { grok: { effort: 'high' } } }],
    ['enabled_providers', [], { ...empty, enabled_providers: ['grok'] }],
    ['required_providers', [], { ...empty, required_providers: ['grok'] }],
  ];
  for (const [label, expanded, overrides] of truthy) {
    assert.equal(effectiveGrokCandidacy(expanded, overrides), true, `${label} must restore candidacy`);
  }
  const falsy = [
    ['no flags', [], empty],
    ['--no-grok', ['--no-grok'], empty],
    ['--codex-only expansion', ['--codex', '--no-opus', '--no-agy', '--no-grok'], empty],
    ['non-grok provider override', [], { providers: { agy: { model: 'gemini' } }, reviewers: {} }],
    ['non-grok reviewer override', [], { providers: {}, reviewers: { agy: { model: 'gemini' } } }],
    ['non-grok enabled_providers', [], { ...empty, enabled_providers: ['agy'] }],
  ];
  for (const [label, expanded, overrides] of falsy) {
    assert.equal(effectiveGrokCandidacy(expanded, overrides), false, `${label} must not restore candidacy`);
  }
});

test('the user/project precedence truth table governs effective Grok denial', () => {
  const rows = [
    {
      id: 'project undefined + user denies grok',
      project: null,
      user: "constraints:\n  denied_providers: ['grok']\n",
      denied: true,
    },
    {
      id: 'project undefined + user allowlist excludes grok',
      project: null,
      user: "constraints:\n  allowed_providers: ['claude', 'codex']\n",
      denied: true,
    },
    {
      id: 'project undefined + user neither denies nor excludes',
      project: null,
      user: "constraints:\n  allowed_providers: ['claude', 'codex', 'grok']\n",
      denied: false,
    },
    {
      id: 'project constraints defined without grok denial + user denies grok',
      project: 'constraints:\n  require_read_only: true\n',
      user: "constraints:\n  denied_providers: ['grok']\n",
      denied: false,
    },
    {
      id: 'project constraints defined without grok denial + user allowlist excludes grok',
      project: 'constraints:\n  require_read_only: true\n',
      user: "constraints:\n  allowed_providers: ['claude', 'codex']\n",
      denied: false,
    },
    {
      id: 'project denies grok + user allowlist includes grok',
      project: "constraints:\n  denied_providers: ['grok']\n",
      user: "constraints:\n  allowed_providers: ['claude', 'codex', 'grok']\n",
      denied: true,
    },
    {
      id: 'project allowlist excludes grok + user allowlist includes grok',
      project: "constraints:\n  allowed_providers: ['claude', 'codex']\n",
      user: "constraints:\n  allowed_providers: ['claude', 'codex', 'grok']\n",
      denied: true,
    },
    {
      id: 'project policy present without a constraints key + user denies grok',
      project: 'routing:\n  policy: balanced\n',
      user: "constraints:\n  denied_providers: ['grok']\n",
      denied: true,
    },
  ];
  for (const row of rows) {
    const fixture = policyFixture(row);
    const run = runDriver({ mode: 'route', entry: 'review', host: 'claude', argv: ['--grok'], cwd: fixture.repo }, fixture);
    assert.equal(run.status, 0, `${row.id}: driver failed: ${run.stderr}`);
    assert.equal(
      run.result.ok, !row.denied,
      `${row.id}: expected denied=${row.denied}, got ${JSON.stringify(run.result)}`,
    );
    if (row.denied) {
      assert.match(run.result.error, /^ERROR_PROVIDER_DENIED\b/u, row.id);
      assertZeroSideEffects(run, row.id);
    }
  }
});

// --------------------------------------------------------------------------
// Public grammar (D5 / D13).
// --------------------------------------------------------------------------

test('--grok restores candidacy and requires the provider, mirroring --agy', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const fixture = policyFixture({ project: null, user: null });
  for (const entry of ['review', 'loop']) {
    const route = parsePublicRoute({ entry, host: 'claude', argv: ['--grok'], cwd: fixture.repo });
    assert.equal(route.ok, true, entry);
    assert.deepEqual(route.overrides.enabled_providers, ['grok'], `${entry}: candidacy restored`);
    assert.deepEqual(route.overrides.required_providers, ['grok'], `${entry}: selection required`);
  }
});

test('a Grok-targeting override restores candidacy without forcing selection', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const fixture = policyFixture({ project: null, user: null });
  const overrides = [
    ['--model', 'grok=grok-4.6'],
    ['--effort', 'grok=high'],
    ['--reviewer-model', 'grok=grok-4.6'],
    ['--reviewer-effort', 'grok=high'],
  ];
  for (const argv of overrides) {
    const route = parsePublicRoute({ entry: 'review', host: 'claude', argv, cwd: fixture.repo });
    assert.equal(route.ok, true, argv.join(' '));
    assert.deepEqual(route.overrides.enabled_providers, ['grok'], `${argv.join(' ')}: candidacy restored`);
    assert.equal(
      Object.hasOwn(route.overrides, 'required_providers'), false,
      `${argv.join(' ')}: an override never forces selection`,
    );
  }
});

test('--codex-only expands to --codex --no-opus --no-agy --no-grok (D5)', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const fixture = policyFixture({ project: null, user: null });
  const review = parsePublicRoute({ entry: 'review', host: 'claude', argv: ['--codex-only'], cwd: fixture.repo });
  assert.deepEqual(review.argv, ['--codex', '--no-opus', '--no-agy', '--no-grok']);
  assert.deepEqual(review.overrides.disabled_providers, ['agy', 'claude', 'grok']);
  const loop = parsePublicRoute({ entry: 'loop', host: 'codex', argv: ['--codex-only'], cwd: fixture.repo });
  assert.deepEqual(loop.argv, ['--codex', '--no-opus', '--no-agy', '--no-grok']);
  assert.deepEqual(loop.overrides.disabled_providers, ['agy', 'claude', 'grok']);
});

test('classify-artifacts accepts the grok public-grammar vocabulary', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = temporaryDirectory('deep-review-grok-vocabulary-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const overrides = {
    protocol_version: '2.0',
    allow_classifier: false,
    providers: {},
    reviewers: {},
    enabled_providers: ['grok'],
    required_providers: ['grok'],
    disabled_providers: ['agy'],
  };
  const capabilities = grokCapabilities();
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files,
      '--overrides-json', JSON.stringify(overrides), '--emit-routing-plan'],
    {},
    { capabilities },
  );
  assert.ok(
    result.routing_plan.routes.some((route) => route.reviewer_id === 'grok'),
    'an enabled grok provider with an available grok-cli capability must be routable',
  );
});

test('defaultReviewers elects grok only through explicit enabled_providers candidacy', async () => {
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = temporaryDirectory('deep-review-grok-optin-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const result = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
    {},
    { capabilities: grokCapabilities() },
  );
  assert.equal(
    result.routing_plan.routes.some((route) => route.provider === 'grok'), false,
    'capability detection alone must never elect grok',
  );
});

function grokCapabilities() {
  return [
    {
      protocol_version: '2.0', adapter_id: 'claude-cli', provider: 'claude', available: true, roles: ['standard'],
      model_selection: { supported: true, aliases: ['steady'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: { supported: true, levels: ['low', 'medium'], transport: 'flag:--effort' },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
    {
      protocol_version: '2.0', adapter_id: 'codex-exec', provider: 'codex', available: true, roles: ['standard', 'adversarial'],
      assignment_roles: ['standard', 'feasibility', 'traceability', 'adversarial', 'security', 'confirmation'],
      model_selection: { supported: true, aliases: ['fast'], catalog_complete: false, transport: 'flag:--model' },
      effort_selection: { supported: true, levels: ['minimal', 'low', 'medium', 'high', 'xhigh'], transport: 'config:model_reasoning_effort' },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
    {
      protocol_version: '2.0', adapter_id: 'grok-cli', provider: 'grok', available: true, roles: ['standard'],
      model_selection: { supported: true, aliases: ['grok-4.6', 'grok-4.6', 'grok-4.6', 'grok-4.6'], catalog_complete: true, transport: 'flag:--model' },
      effort_selection: { supported: true, levels: ['low', 'medium', 'high'], transport: 'flag:--reasoning-effort' },
      structured_output: true, read_only_enforcement: 'permission-mode-plan',
    },
  ];
}

// --------------------------------------------------------------------------
// Acceptance: a review with no flags emits a plan identical to the pre-change
// plan. The digests below were captured from the pre-change tree on this
// baseline (see the slice report) and are asserted, not assumed.
// --------------------------------------------------------------------------

const PRE_CHANGE_GROK_FREE_GRAMMAR_DIGEST = 'ba4452a45369795de6462a17af428351f3593a56954dcec35cfccafa5e8aec61';
const PRE_CHANGE_NO_FLAG_PLAN_DIGEST = '5fdfc9cfda07254601224da28f4caa812e5f0de39e7a8012f17fc46692f2b59d';

const GROK_FREE_ARGV = [
  [], ['--entropy'], ['--ultracode'], ['--codex'], ['--no-codex'], ['--no-opus'], ['--no-agy'], ['--agy'],
  ['--dry-run'], ['--explain-routing'],
  ['--allow-fallback'], ['--no-fallback'], ['--allow-classifier'], ['--routing', 'quality'],
  ['--reviewer-strategy', 'static'], ['--model', 'claude=opus'], ['--effort', 'codex=high'],
  ['--reviewer-model', 'agy=gemini'], ['--reviewer-effort', 'codex-review=high'],
  ['--agy', '--no-agy'], ['--ultracode', '--no-opus'], ['--codex', '--no-codex'],
  ['--no-agy', '--model', 'agy=x'], ['--no-opus', '--reviewer-model', 'claude-opus=x'],
  ['init'], ['--qa'], ['--respond'], ['--max=3'], ['--session-doc'],
];

test('every grok-free public invocation parses byte-for-byte as it did before the slice', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const rows = [];
  for (const entry of ['review', 'loop']) {
    for (const host of ['claude', 'codex']) {
      for (const argv of GROK_FREE_ARGV) {
        let value;
        try {
          value = parsePublicRoute({ entry, host, argv, cwd: root });
        } catch (error) {
          value = { threw: error.message };
        }
        rows.push([entry, host, argv, value]);
      }
    }
  }
  assert.equal(rows.length, 116, 'the grok-free grammar sweep must stay complete');
  const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  assert.equal(
    digest, PRE_CHANGE_GROK_FREE_GRAMMAR_DIGEST,
    'the public grammar changed for an invocation that names no grok token',
  );
});

test('a no-flag review emits a routing plan identical to the pre-change plan', async () => {
  const { parsePublicRoute } = await import(routeUrl);
  const { runClassifyArtifactsCli } = await import(classifyUrl);
  const repo = temporaryDirectory('dr-baseline-');
  fs.writeFileSync(path.join(repo, 'notes.md'), 'plain review notes');
  const files = path.join(repo, 'targets.z');
  fs.writeFileSync(files, 'notes.md\0');
  const capabilities = [
    ...grokCapabilities().slice(0, 2),
    {
      protocol_version: '2.0', adapter_id: 'agy-cli', provider: 'agy', available: true, roles: ['standard'],
      model_selection: { supported: true, aliases: ['a'], catalog_complete: false, transport: 'config:agy_model' },
      effort_selection: { supported: false, levels: [], transport: 'none' },
      structured_output: true, read_only_enforcement: 'process-contract',
    },
    grokCapabilities()[2],
  ];
  const route = parsePublicRoute({ entry: 'review', host: 'claude', cwd: repo, argv: [] });
  const plan = await runClassifyArtifactsCli(
    ['--repo', repo, '--change-state', 'non-git', '--files-from0', files, '--emit-routing-plan'],
    { SOURCE_DATE_EPOCH: '1700000000' },
    { capabilities },
  );
  const serialized = JSON.stringify({ route, plan }).replaceAll(repo, '<REPO>');
  assert.equal(
    createHash('sha256').update(serialized).digest('hex'),
    PRE_CHANGE_NO_FLAG_PLAN_DIGEST,
    'a no-flag review must emit the pre-change plan byte-for-byte, even with an available grok-cli capability',
  );
});
