'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const {
  cleanupGitFixtures,
  createGitFixture,
  git,
} = require('./helpers/git-fixture.js');

const modulePath = join(__dirname, '..', 'hooks', 'scripts', 'lib', 'review-target.mjs');
const moduleUrl = pathToFileURL(modulePath).href;
const cliPath = join(__dirname, '..', 'hooks', 'scripts', 'build-change-files.mjs');
const temporaryRoots = new Set();

function temporaryDirectory(prefix = 'deep-review-target-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
}

test.after(() => {
  cleanupGitFixtures();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

async function loadTarget() {
  return import(moduleUrl);
}

function paths(records) {
  return records.map((record) => record.path);
}

function parseJsonLines(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const nulSource = Buffer.concat([
  Buffer.from('export const SEP = "'),
  Buffer.from([0x00]),
  Buffer.from('";\n'),
]);
const HOSTILE_NAME = 'a\n=====\u001b\u0085\u2028\u2029\u200e\u200f\u061c'
  + '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u009b\u007f'
  + '```![x](u)"\\ignore-previous-instructions.bin';
const HOSTILE_CODEPOINTS = [
  '\u001b', '\u0085', '\u2028', '\u2029', '\u200e', '\u200f', '\u061c',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
  '\u2066', '\u2067', '\u2068', '\u2069', '\u009b', '\u007f',
];

test('staged rename and copy records retain old_path and similarity score', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('rename copy 공간 Ω');
  writeFileSync(join(repo, 'copy-source.txt'), 'copy source\nline 2\nline 3\n');
  git(repo, ['add', '--', 'copy-source.txt']);
  git(repo, ['commit', '--quiet', '-m', 'add copy source']);

  git(repo, ['mv', '--', 'tracked.txt', 'renamed.txt']);
  copyFileSync(join(repo, 'copy-source.txt'), join(repo, 'copied.txt'));
  writeFileSync(join(repo, 'copy-source.txt'), 'changed source\n');
  git(repo, ['add', '-A']);

  const records = buildChangeFiles({ repo, changeState: 'staged' });
  const rename = records.find((record) => record.status === 'R');
  const copy = records.find((record) => record.status === 'C');
  assert.deepEqual(
    { path: rename?.path, old_path: rename?.old_path, score: rename?.score },
    { path: 'renamed.txt', old_path: 'tracked.txt', score: '100' },
  );
  assert.deepEqual(
    { path: copy?.path, old_path: copy?.old_path, score: copy?.score },
    { path: 'copied.txt', old_path: 'copy-source.txt', score: '100' },
  );
});

test('every dirty state unions untracked files while clean excludes leftovers', async () => {
  const { buildChangeFiles } = await loadTarget();

  for (const state of ['staged', 'unstaged', 'mixed', 'untracked-only']) {
    const repo = createGitFixture(`state-${state}`);
    writeFileSync(join(repo, 'second.txt'), 'second base\n');
    git(repo, ['add', '--', 'second.txt']);
    git(repo, ['commit', '--quiet', '-m', 'second']);
    writeFileSync(join(repo, 'leftover.txt'), `${state}\n`);
    if (state === 'staged') {
      writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
      git(repo, ['add', '--', 'tracked.txt']);
    } else if (state === 'unstaged') {
      writeFileSync(join(repo, 'tracked.txt'), 'unstaged\n');
    } else if (state === 'mixed') {
      writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
      git(repo, ['add', '--', 'tracked.txt']);
      writeFileSync(join(repo, 'second.txt'), 'unstaged\n');
    }
    const records = buildChangeFiles({ repo, changeState: state });
    assert.equal(paths(records).includes('leftover.txt'), true, state);
  }

  const clean = createGitFixture('clean-leftover');
  const base = git(clean, ['rev-parse', 'HEAD']);
  writeFileSync(join(clean, 'committed.txt'), 'committed\n');
  git(clean, ['add', '--', 'committed.txt']);
  git(clean, ['commit', '--quiet', '-m', 'review target']);
  writeFileSync(join(clean, 'leftover.txt'), 'not in range\n');
  const records = buildChangeFiles({ repo: clean, changeState: 'clean', reviewBase: base });
  assert.equal(paths(records).includes('committed.txt'), true);
  assert.equal(paths(records).includes('leftover.txt'), false);
  assert.throws(
    () => buildChangeFiles({ repo: clean, changeState: 'clean' }),
    /reviewBase.*required/i,
  );
});

test('initial and non-Git manual targets work without a shell', async () => {
  const { buildChangeFiles } = await loadTarget();
  const initial = createGitFixture('initial', { initialCommit: false });
  writeFileSync(join(initial, 'only.txt'), 'initial\n');
  assert.deepEqual(paths(buildChangeFiles({ repo: initial, changeState: 'initial' })), ['only.txt']);

  const nonGit = temporaryDirectory('deep-review-non-git-');
  writeFileSync(join(nonGit, 'manual one.txt'), 'one\n');
  writeFileSync(join(nonGit, '한글 Ω.txt'), 'two\n');
  const filesFromZ = Buffer.from('manual one.txt\0한글 Ω.txt\0');
  const records = buildChangeFiles({ repo: nonGit, changeState: 'non-git', filesFromZ });
  assert.deepEqual(paths(records), ['manual one.txt', '한글 Ω.txt'].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  assert.equal(records.every((record) => record.status === 'non-git'), true);
});

test('JSONL round-trips control bytes, newline, leading dash, spaces, and Unicode', async () => {
  const { serializeChangeFiles } = await loadTarget();
  const records = [
    { status: 'M', path: 'a\u0001b.txt' },
    { status: 'M', path: 'c\nd.txt' },
    { status: 'M', path: '-leading.txt' },
    { status: 'M', path: 'space name.txt' },
    { status: 'M', path: '한글 Ω.txt' },
  ];
  const serialized = serializeChangeFiles(records, { maxEntries: 500, maxBytes: 65536 });
  assert.deepEqual(parseJsonLines(serialized), records);
  assert.match(serialized, /a\\u0001b\.txt/);
  assert.match(serialized, /c\\nd\.txt/);
});

test('Git collection preserves supported leading-dash, space, and Unicode paths', async () => {
  const { buildChangeFiles, serializeChangeFiles } = await loadTarget();
  const repo = createGitFixture('path spelling 공간 Ω');
  const expected = ['-leading.txt', 'space name.txt', '한글 Ω.txt'];
  for (const relative of expected) writeFileSync(join(repo, relative), `${relative}\n`);
  git(repo, ['add', '-A']);

  const records = buildChangeFiles({ repo, changeState: 'staged' });
  const decoded = parseJsonLines(serializeChangeFiles(records));
  assert.deepEqual(
    decoded.map((record) => record.path),
    expected.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
});

test('POSIX Git collection preserves control-byte and embedded-newline path bytes', { skip: process.platform === 'win32' }, async () => {
  const { buildChangeFiles, serializeChangeFiles } = await loadTarget();
  const repo = createGitFixture('control-paths');
  const expected = ['a\u0001b.txt', 'c\nd.txt'];
  for (const relative of expected) writeFileSync(join(repo, relative), 'content\n');
  git(repo, ['add', '-A']);

  const records = parseJsonLines(serializeChangeFiles(buildChangeFiles({ repo, changeState: 'staged' })));
  assert.deepEqual(
    records.map((record) => record.path),
    expected.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );
});

test('canonical directory, basename, and binary exclusions match the Stage-1 target', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('exclusions');
  const excluded = [
    'node_modules/x.js', 'dist/x.js', 'build/x.js', '.next/x.js', 'target/x.js',
    '.venv/x.py', '__pycache__/x.pyc', '.pytest_cache/x', 'vendor/x.js', '.git/never',
    'src/a.min.js', 'src/b.generated.ts', 'src/c.lock', 'src/.DS_Store',
  ];
  for (const relative of excluded.filter((entry) => !entry.startsWith('.git/'))) {
    mkdirSync(join(repo, relative, '..'), { recursive: true });
    writeFileSync(join(repo, relative), 'excluded\n');
  }
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'real.ts'), 'real\n');
  writeFileSync(join(repo, 'src', 'tracked.bin'), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(repo, 'src', 'untracked.bin'), Buffer.from([80, 75, 0, 4]));
  writeFileSync(join(repo, 'src', 'high-byte.dat'), Buffer.from([0xff, 0xfe, 0xfd]));
  git(repo, ['add', '-A']);

  const records = buildChangeFiles({ repo, changeState: 'staged' });
  assert.equal(paths(records).includes('src/real.ts'), true);
  assert.equal(paths(records).includes('src/high-byte.dat'), true);
  assert.equal(paths(records).includes('src/tracked.bin'), false);
  assert.equal(paths(records).includes('src/untracked.bin'), false);
  for (const relative of excluded) assert.equal(paths(records).includes(relative), false, relative);
});

test('untracked NUL binary is dropped while high-byte text and a missing manual path remain', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('binary-sniff');
  writeFileSync(join(repo, 'binary.dat'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(repo, 'high.dat'), Buffer.from([0xff, 0xfe, 0xfd]));
  let records = buildChangeFiles({ repo, changeState: 'unstaged' });
  assert.equal(paths(records).includes('binary.dat'), false);
  assert.equal(records.omittedBinaryRecords[0].path, 'binary.dat');
  assert.equal(paths(records).includes('high.dat'), true);

  records = buildChangeFiles({
    repo,
    changeState: 'non-git',
    filesFromZ: Buffer.from('missing.txt\0'),
  });
  assert.deepEqual(paths(records), ['missing.txt']);
});

test('FIFO binary sniff never opens the special file and cannot hang', { skip: process.platform === 'win32' }, async () => {
  const root = temporaryDirectory('deep-review-fifo-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const fifo = join(repo, 'special.fifo');
  const made = spawnSync('mkfifo', [fifo], { shell: false });
  assert.equal(made.status, 0, made.stderr?.toString());
  const list = join(root, 'files.z');
  writeFileSync(list, Buffer.concat([Buffer.from(fifo), Buffer.from([0])]));

  const result = spawnSync(process.execPath, [
    cliPath,
    '--repo', repo,
    '--change-state', 'non-git',
    '--files-from-z', list,
  ], { encoding: 'utf8', shell: false, timeout: 1000 });
  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseJsonLines(result.stdout)[0].path, fifo);
});

test('entry and byte limits emit one exact trailer and retain an oversized first row', async () => {
  const { serializeChangeFiles } = await loadTarget();
  const records = Array.from({ length: 501 }, (_, index) => ({
    status: 'M',
    path: `src/${String(index).padStart(3, '0')}.txt`,
  }));
  let lines = parseJsonLines(serializeChangeFiles(records, { maxEntries: 500, maxBytes: 65536 }));
  assert.equal(lines.length, 501);
  assert.deepEqual(lines.at(-1), { omitted: 1, truncated: true });
  assert.equal(lines.filter((record) => record.truncated === true).length, 1);

  const longRecords = [
    { status: 'M', path: `first-${'x'.repeat(256)}` },
    { status: 'M', path: 'second' },
    { status: 'M', path: 'third' },
  ];
  const serialized = serializeChangeFiles(longRecords, { maxEntries: 500, maxBytes: 32 });
  lines = parseJsonLines(serialized);
  assert.deepEqual(lines[0], longRecords[0]);
  assert.deepEqual(lines[1], { omitted: 2, truncated: true });
  assert.equal(lines.length, 2);
});

test('untracked raw-NUL text-extension file stays as a suspect row', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('nul-suspect-untracked');
  writeFileSync(join(repo, 'control.mjs'), nulSource);
  const records = buildChangeFiles({ repo, changeState: 'unstaged' });
  const row = records.find((record) => record.path === 'control.mjs');
  assert.ok(row, 'suspect row must be present');
  assert.equal(row.is_binary, true);
  assert.equal(row.binary_suspect_reason, 'text-extension');
  assert.equal(row.binary_classified_by, 'untracked-nul-sniff');
  assert.equal(records.omittedBinaryRecords, undefined, 'no diagnostics for suspect-only scope');
});

test('staged and clean raw-NUL text files carry git-numstat provenance', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('nul-suspect-tracked');
  writeFileSync(join(repo, 'control.mjs'), nulSource);
  git(repo, ['add', '-A']);
  let row = buildChangeFiles({ repo, changeState: 'staged' })
    .find((record) => record.path === 'control.mjs');
  assert.equal(row?.binary_classified_by, 'git-numstat');

  git(repo, ['commit', '-m', 'nul']);
  const reviewBase = git(repo, ['rev-list', '--max-parents=0', 'HEAD']);
  row = buildChangeFiles({ repo, changeState: 'clean', reviewBase })
    .find((record) => record.path === 'control.mjs');
  assert.equal(row?.is_binary, true);
  assert.equal(row?.binary_classified_by, 'git-numstat');
});

test('gitattributes-forced binary text file gets git-numstat provenance without any NUL', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('gitattributes-binary');
  writeFileSync(join(repo, '.gitattributes'), '*.mjs binary\n');
  writeFileSync(join(repo, 'control.mjs'), 'export const ok = true;\n');
  git(repo, ['add', '-A']);
  const row = buildChangeFiles({ repo, changeState: 'staged' })
    .find((record) => record.path === 'control.mjs');
  assert.equal(row?.binary_suspect_reason, 'text-extension');
  assert.equal(row?.binary_classified_by, 'git-numstat');
});

test('CRLF-configured checkout still surfaces the raw-NUL suspect row', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('crlf-nul');
  git(repo, ['config', 'core.autocrlf', 'true']);
  writeFileSync(join(repo, 'control.mjs'), Buffer.concat([
    Buffer.from('line1\r\nconst SEP = "'), Buffer.from([0x00]), Buffer.from('";\r\n'),
  ]));
  git(repo, ['add', '-A']);
  const row = buildChangeFiles({ repo, changeState: 'staged' })
    .find((record) => record.path === 'control.mjs');
  assert.equal(row?.binary_suspect_reason, 'text-extension');
});

test('non-text binaries become frozen builder diagnostics with terminal disposition', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('nul-binary-lane');
  writeFileSync(join(repo, 'binary.dat'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(repo, 'high.dat'), Buffer.from([0xff, 0xfe, 0xfd]));
  const records = buildChangeFiles({
    repo,
    changeState: 'unstaged',
    filesFromZ: Buffer.from('binary.dat\0'), // second delivery, same raw path
  });
  assert.equal(paths(records).includes('binary.dat'), false);
  assert.equal(paths(records).includes('high.dat'), true);
  const lane = records.omittedBinaryRecords;
  assert.equal(lane.length, 1, 'dedupe: one diagnostic despite double delivery');
  assert.deepEqual({ ...lane[0] }, {
    path: 'binary.dat',
    status: 'untracked',            // first delivery's status wins
    classified_by: 'untracked-nul-sniff',
    omitted_at: 'builder',
  });
  assert.equal(Object.isFrozen(lane), true);
  assert.equal(Object.isFrozen(lane[0]), true);
  const laneDescriptor = Object.getOwnPropertyDescriptor(records, 'omittedBinaryRecords');
  assert.equal(laneDescriptor.enumerable, false);
  assert.equal(laneDescriptor.writable, false);
  assert.equal(laneDescriptor.configurable, false);
});

test('suspect duplicate delivery keeps one row; absolute spelling is a second entry', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('suspect-dup');
  writeFileSync(join(repo, 'control.mjs'), nulSource);
  const absolute = join(repo, 'control.mjs');
  const records = buildChangeFiles({
    repo,
    changeState: 'unstaged',
    filesFromZ: Buffer.from(`control.mjs\0${absolute}\0`),
  });
  const relativeRows = records.filter((record) => record.path === 'control.mjs');
  assert.equal(relativeRows.length, 1, 'same raw path delivered twice -> one row');
  assert.equal(records.omittedBinaryRecords, undefined);
  const absoluteRow = records.find((record) => record.path === absolute);
  assert.ok(absoluteRow, 'absolute spelling is a distinct raw path (documented semantics)');
  assert.equal(absoluteRow.binary_suspect_reason, 'text-extension');
});

test('rename, reverse-rename, copy and delete keep the text-extension signal', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('nul-rc-d');
  writeFileSync(join(repo, 'control.mjs'), nulSource);
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 7, 7]));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'seed']);

  git(repo, ['mv', 'control.mjs', 'control.bin']);      // .mjs -> .bin rename
  git(repo, ['mv', 'blob.bin', 'NEW.MJS']);             // .bin -> .MJS rename
  const staged = buildChangeFiles({ repo, changeState: 'staged' });
  const renamed = staged.find((record) => record.path === 'control.bin');
  assert.equal(renamed?.binary_suspect_reason, 'text-extension', 'old_path .mjs keeps it suspect');
  assert.equal(renamed?.old_path, 'control.mjs');
  const reverse = staged.find((record) => record.path === 'NEW.MJS');
  assert.equal(reverse?.binary_suspect_reason, 'text-extension', 'uppercase .MJS path is suspect');

  assert.equal(renamed?.score, '100', 'rename similarity score retained');

  git(repo, ['commit', '-m', 'renames']);
  // Copy target carries the text extension itself, so the suspect signal is
  // deterministic whether git reports A or C (a D record has no old_path, and
  // -C on an unchanged source is not reliable - never depend on either):
  copyFileSync(join(repo, 'control.bin'), join(repo, 'copy.mjs'));
  git(repo, ['add', 'copy.mjs']);
  const withCopy = buildChangeFiles({ repo, changeState: 'staged' });
  const copied = withCopy.find((record) => record.path === 'copy.mjs');
  assert.equal(copied?.binary_suspect_reason, 'text-extension', 'suspect via its own path, A or C alike');
  if (copied.old_path !== undefined) assert.match(copied.old_path, /control\.bin$/);

  git(repo, ['commit', '-m', 'copy']);
  git(repo, ['rm', 'NEW.MJS']);   // D record: no old_path exists, so the
                                  // deleted file itself must carry the text
                                  // extension for the suspect signal
  const withDelete = buildChangeFiles({ repo, changeState: 'staged' });
  const deleted = withDelete.find((record) => record.path === 'NEW.MJS');
  assert.equal(deleted?.status, 'D');
  assert.equal(deleted?.binary_suspect_reason, 'text-extension', 'deleted suspect row kept via path');
});

test('excluded binaries reach neither rows nor diagnostics', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('excluded-binaries');
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'x.bin'), Buffer.from([0, 1]));
  writeFileSync(join(repo, 'a.min.js'), Buffer.from([0, 1]));
  const records = buildChangeFiles({ repo, changeState: 'unstaged' });
  assert.equal(paths(records).includes('a.min.js'), false);
  assert.equal(records.omittedBinaryRecords, undefined);
});

test('includeBinary:true path gains no suspect fields and no lane property', async () => {
  const { buildChangeFiles } = await loadTarget();
  const repo = createGitFixture('w1-shape');
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(repo, 'control.mjs'), nulSource);
  const records = buildChangeFiles({ repo, changeState: 'unstaged', includeBinary: true });
  for (const record of records) {
    assert.equal('binary_suspect_reason' in record, false, record.path);
    assert.equal('binary_classified_by' in record, false, record.path);
  }
  assert.equal(records.omittedBinaryRecords, undefined);
});

test('cap-truncated suspect rows enter the trailer under both cap kinds', async () => {
  const { buildChangeFiles, serializeChangeFilesDetailed } = await loadTarget();
  const repo = createGitFixture('cap-suspect');
  writeFileSync(join(repo, 'aaa.txt'), 'a\n');
  writeFileSync(join(repo, 'zzz.mjs'), nulSource);
  const records = buildChangeFiles({ repo, changeState: 'unstaged' });

  for (const limits of [{ maxEntries: 1, maxBytes: 65536 }, { maxEntries: 500, maxBytes: 40 }]) {
    const { text, binaryDiagnostics } = serializeChangeFilesDetailed(records, limits);
    const lines = parseJsonLines(text);
    assert.equal(lines.some((line) => line.path === 'zzz.mjs'), false, 'row truncated');
    const trailer = lines.at(-1);
    assert.equal(trailer.binary_omitted, 1);
    assert.deepEqual(trailer.binary_records, [{
      path: 'zzz.mjs', status: 'untracked',
      classified_by: 'untracked-nul-sniff', omitted_at: 'serializer',
    }]);
    assert.equal(lines.at(-2).truncated, true, 'generic trailer still counts it (overlap)');
    assert.equal(binaryDiagnostics.total, 1);
    assert.equal(binaryDiagnostics.omittedAt.serializer, 1);
    assert.match(binaryDiagnostics.digest, /^[0-9a-f]{64}$/);
  }
});

test('binary-only scope yields only the binary trailer', async () => {
  const { buildChangeFiles, serializeChangeFiles } = await loadTarget();
  const repo = createGitFixture('binary-only');
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 9]));
  const records = buildChangeFiles({ repo, changeState: 'unstaged' });
  assert.equal(records.length, 0);
  const lines = parseJsonLines(serializeChangeFiles(records));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].binary_omitted, 1);
  assert.equal('truncated' in lines[0], false, 'no generic trailer without caps firing');
});

test('W1 arrays under low caps gain no binary trailer and identical bytes', async () => {
  const { buildChangeFiles, serializeChangeFiles } = await loadTarget();
  const repo = createGitFixture('w1-caps');
  writeFileSync(join(repo, 'a.bin'), Buffer.from([0, 1]));
  writeFileSync(join(repo, 'b.bin'), Buffer.from([0, 2]));
  const records = buildChangeFiles({ repo, changeState: 'unstaged', includeBinary: true });
  const serialized = serializeChangeFiles(records, { maxEntries: 1, maxBytes: 65536 });
  const expected = `${JSON.stringify(records[0])}\n${JSON.stringify({ omitted: 1, truncated: true })}\n`;
  assert.equal(serialized, expected, 'low-cap W1 bytes identical to legacy');
});

test('non-record tails past the cap keep legacy output', async () => {
  const { serializeChangeFiles } = await loadTarget();
  const rows = [{ status: 'M', path: 'first.txt' }, null];
  const expected = `${JSON.stringify(rows[0])}\n${JSON.stringify({ omitted: 1, truncated: true })}\n`;
  assert.equal(serializeChangeFiles(rows, { maxEntries: 1, maxBytes: 65536 }), expected,
    'a null tail past the cap must not throw (legacy break semantics)');
});

test('W1 serialization is byte-identical to plain per-row JSON.stringify', async () => {
  const { buildChangeFiles, serializeChangeFiles } = await loadTarget();
  const repo = createGitFixture('w1-bytes');
  writeFileSync(join(repo, 'plain.bin'), Buffer.from([0, 2]));
  const records = buildChangeFiles({ repo, changeState: 'unstaged', includeBinary: true });
  const expected = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  assert.equal(serializeChangeFiles(records), expected);
});

test('hostile-named W1 binaries keep legacy bytes', { skip: process.platform === 'win32' }, async () => {
  const { buildChangeFiles, serializeChangeFiles } = await loadTarget();
  const repo = createGitFixture('w1-hostile');
  writeFileSync(join(repo, 'bad\u2028name.bin'), Buffer.from([0, 1]));
  const records = buildChangeFiles({ repo, changeState: 'unstaged', includeBinary: true });
  const expected = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const serialized = serializeChangeFiles(records);
  assert.equal(serialized, expected);
  assert.equal(serialized.includes('\u2028'), true, 'legacy row leaves U+2028 literal');
});

test('artifact discovery descriptors are unchanged by the default-path fields', async () => {
  const { discoverArtifacts } = await import('../hooks/scripts/lib/artifact-discover.mjs');
  const repo = createGitFixture('w1-descriptors');
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1]));
  writeFileSync(join(repo, 'control.mjs'), nulSource);
  const descriptors = discoverArtifacts({ repo, changeState: 'unstaged' });
  const binary = descriptors.find((descriptor) => descriptor.path === 'blob.bin');
  assert.equal(binary.is_binary, true);
  assert.equal(binary.payload_strategy, 'metadata-only');
  for (const descriptor of descriptors) {
    assert.equal('binary_suspect_reason' in descriptor, false, descriptor.path);
  }
});

test('row lane keeps legacy encoding for hostile names; trailer hardens them', async () => {
  const { serializeChangeFilesDetailed } = await loadTarget();
  // Row lane (legacy): U+2028 stays literal in row output.
  const rows = serializeChangeFilesDetailed([{ status: 'M', path: HOSTILE_NAME }], {});
  assert.equal(rows.text.includes('\u2028'), true, 'rows keep plain JSON.stringify');
  // Trailer lane (hardened):
  const lane = [Object.freeze({
    path: HOSTILE_NAME, status: 'untracked',
    classified_by: 'untracked-nul-sniff', omitted_at: 'builder',
  })];
  const { text } = serializeChangeFilesDetailed([], {}, { omittedBinaryRecords: lane });
  const trailerLine = text.trimEnd().split('\n').at(-1);
  for (const banned of HOSTILE_CODEPOINTS) {
    assert.equal(trailerLine.includes(banned), false,
      `unescaped U+${banned.codePointAt(0).toString(16)}`);
  }
  assert.equal(trailerLine.includes('\n'), false, 'trailer is one line');
  assert.equal(JSON.parse(trailerLine).binary_records[0].path, HOSTILE_NAME, 'round-trip exact');
});

test('lone-surrogate paths from invalid bytes survive the trailer round-trip', { skip: process.platform === 'win32' }, async () => {
  const { buildChangeFiles, serializeChangeFiles, serializeChangeFilesDetailed } = await loadTarget();
  const { decodeGitPath } = await import('../hooks/scripts/lib/git.mjs');
  const rawName = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xff]), Buffer.from('.bin')]);
  assert.equal(decodeGitPath(rawName), 'bad-\udcff.bin', 'exact lone-surrogate decode');
  const repo = createGitFixture('invalid-bytes');
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${repo}/`), rawName]), Buffer.from([0, 1]));
  } catch (error) {
    // APFS/HFS+ reject invalid UTF-8 filenames (EILSEQ). Linux still exercises
    // the builder; here the trailer must still round-trip the decoded path.
    if (error.code !== 'EILSEQ') throw error;
    const { text } = serializeChangeFilesDetailed([], {}, {
      omittedBinaryRecords: [Object.freeze({
        path: 'bad-\udcff.bin', status: 'untracked',
        classified_by: 'untracked-nul-sniff', omitted_at: 'builder',
      })],
    });
    const trailer = parseJsonLines(text).at(-1);
    assert.equal(trailer.binary_omitted, 1);
    assert.equal(trailer.binary_records[0].path, 'bad-\udcff.bin', 'exact lone-surrogate decode');
    return;
  }
  const records = buildChangeFiles({ repo, changeState: 'unstaged' });
  const trailer = parseJsonLines(serializeChangeFiles(records)).at(-1);
  assert.equal(trailer.binary_omitted, 1);
  assert.equal(trailer.binary_records[0].path, 'bad-\udcff.bin', 'exact lone-surrogate decode');
});

test('trailer bounds: 26 omitted lists 25; byte bound is exact; oversized entry skipped', async () => {
  const { serializeChangeFilesDetailed } = await loadTarget();
  const entry = (path) => Object.freeze({
    path, status: 'untracked', classified_by: 'untracked-nul-sniff', omitted_at: 'builder',
  });
  const lane26 = Array.from({ length: 26 }, (_, index) =>
    entry(`bin/${String(index).padStart(2, '0')}.bin`));
  const capped = serializeChangeFilesDetailed([], {}, { omittedBinaryRecords: lane26 });
  const trailer26 = parseJsonLines(capped.text).at(-1);
  assert.equal(trailer26.binary_omitted, 26);
  assert.equal(trailer26.binary_records.length, 25);
  assert.equal(trailer26.binary_records_unlisted, 1);

  // Exact byte boundary: construct the trailer the implementation would emit
  // for one entry (same key order) and pad the path so line+newline lands
  // exactly on 4096, then 4097.
  const trailerFor = (path) => JSON.stringify({
    binary_omitted: 1,
    binary_classified_by: { 'git-numstat': 0, 'untracked-nul-sniff': 1 },
    binary_omitted_at: { builder: 1, serializer: 0 },
    binary_records: [{ path, status: 'untracked', classified_by: 'untracked-nul-sniff', omitted_at: 'builder' }],
    binary_records_listed: 1,
    binary_records_unlisted: 0,
  });
  const overhead = Buffer.byteLength(trailerFor(''), 'utf8') + 1; // + newline
  const fitPath = 'x'.repeat(4096 - overhead);
  const fits = serializeChangeFilesDetailed([], {}, { omittedBinaryRecords: [entry(fitPath)] });
  assert.equal(parseJsonLines(fits.text).at(-1).binary_records.length, 1, 'exactly 4096 fits');
  const underPath = 'x'.repeat(4096 - overhead - 1);
  const under = serializeChangeFilesDetailed([], {}, { omittedBinaryRecords: [entry(underPath)] });
  assert.equal(parseJsonLines(under.text).at(-1).binary_records.length, 1, '4095 fits');
  const overPath = 'x'.repeat(4096 - overhead + 1);
  const over = serializeChangeFilesDetailed([], {}, { omittedBinaryRecords: [entry(overPath)] });
  const overTrailer = parseJsonLines(over.text).at(-1);
  assert.equal(overTrailer.binary_records.length, 0, '4097 does not fit');
  assert.equal(overTrailer.binary_omitted, 1, 'count survives');
  assert.equal(overTrailer.binary_records_unlisted, 1);
});

test('digest is order-insensitive and field-sensitive; property boundary honored', async () => {
  const { buildChangeFiles, serializeChangeFilesDetailed } = await loadTarget();
  const entryA = Object.freeze({ path: 'a.bin', status: 'untracked', classified_by: 'untracked-nul-sniff', omitted_at: 'builder' });
  const entryB = Object.freeze({ path: 'b.bin', status: 'untracked', classified_by: 'git-numstat', omitted_at: 'builder' });
  const forward = serializeChangeFilesDetailed([], {}, { omittedBinaryRecords: [entryA, entryB] });
  const reversed = serializeChangeFilesDetailed([], {}, { omittedBinaryRecords: [entryB, entryA] });
  assert.equal(forward.binaryDiagnostics.digest, reversed.binaryDiagnostics.digest);
  const mutated = serializeChangeFilesDetailed([], {}, {
    omittedBinaryRecords: [entryA, Object.freeze({ ...entryB, status: 'session' })],
  });
  assert.notEqual(mutated.binaryDiagnostics.digest, forward.binaryDiagnostics.digest);
  for (const patch of [
    { classified_by: 'untracked-nul-sniff' }, { path: 'c.bin' },
    { old_path: 'z.mjs' }, { omitted_at: 'serializer' },
  ]) {
    const variant = serializeChangeFilesDetailed([], {}, {
      omittedBinaryRecords: [entryA, Object.freeze({ ...entryB, ...patch })],
    });
    assert.notEqual(variant.binaryDiagnostics.digest, forward.binaryDiagnostics.digest,
      JSON.stringify(patch));
  }
  const { createHash } = await import('node:crypto');
  const canonical = [entryA, entryB]
    .map((entry) => JSON.stringify([
      entry.path, entry.old_path ?? null, entry.status, entry.classified_by, entry.omitted_at,
    ]))
    .sort()
    .join('\n');
  assert.equal(forward.binaryDiagnostics.digest,
    createHash('sha256').update(canonical, 'utf8').digest('hex'), 'canonical algorithm');

  const repo = createGitFixture('property-boundary');
  writeFileSync(join(repo, 'x.bin'), Buffer.from([0, 1]));
  const records = buildChangeFiles({ repo, changeState: 'unstaged' });
  const spread = [...records];
  assert.equal(serializeChangeFilesDetailed(spread, {}).binaryDiagnostics.total, 0);
  assert.equal(serializeChangeFilesDetailed(spread, {}, {
    omittedBinaryRecords: records.omittedBinaryRecords,
  }).binaryDiagnostics.total, 1);
});

test('trailer lists mixed BMP and astral paths in JS code-unit order', async () => {
  const { serializeChangeFilesDetailed } = await loadTarget();
  const emojiPath = `x${String.fromCodePoint(0x1f600)}.bin`;
  const bmpPath = `x${String.fromCharCode(0xe000)}.bin`;
  const lonePath = 'bad-\udcff.bin';
  assert.equal(emojiPath < bmpPath, true, 'JS code-unit order: surrogate pair precedes U+E000');
  assert.equal(lonePath < emojiPath, true, 'JS code-unit order: U+DCFF path precedes x…');
  const { text } = serializeChangeFilesDetailed([], {}, {
    omittedBinaryRecords: [
      Object.freeze({
        path: bmpPath, status: 'untracked',
        classified_by: 'untracked-nul-sniff', omitted_at: 'builder',
      }),
      Object.freeze({
        path: emojiPath, status: 'untracked',
        classified_by: 'untracked-nul-sniff', omitted_at: 'builder',
      }),
      Object.freeze({
        path: lonePath, status: 'untracked',
        classified_by: 'untracked-nul-sniff', omitted_at: 'builder',
      }),
    ],
  });
  const listed = parseJsonLines(text).at(-1).binary_records.map((entry) => entry.path);
  assert.deepEqual(listed, [lonePath, emojiPath, bmpPath]);
});

test('twin by_path encodes lone surrogates without crashing and matches JS order', () => {
  const twinPath = join(__dirname, '..', 'hooks', 'scripts', 'build-change-files.sh');
  const source = readFileSync(twinPath, 'utf8');
  const match = source.match(/def by_path\(entry\):\n(?:.*\n)*?    return entry\["path"\]\.encode\(([^)]+)\)/);
  assert.ok(match, 'twin defines by_path with an encode(...) sort key');
  const result = spawnSync('python3', ['-c', `
paths = ["x\\ue000.bin", "bad-\\udcff.bin", "x\\U0001f600.bin"]
want = ["bad-\\udcff.bin", "x\\U0001f600.bin", "x\\ue000.bin"]
ordered = sorted(paths, key=lambda p: p.encode(${match[1]}))
assert ordered == want, [p.encode("utf-8", "backslashreplace") for p in ordered]
print("ok")
`], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'ok');
});

test('CLI stdout carries suspect row and trailer', async () => {
  const repo = createGitFixture('cli-smoke');
  writeFileSync(join(repo, 'control.mjs'), nulSource);
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1]));
  const result = spawnSync(process.execPath, [cliPath, '--repo', repo, '--change-state', 'unstaged'],
    { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr);
  const lines = parseJsonLines(result.stdout);
  assert.equal(lines.some((line) => line.binary_suspect_reason === 'text-extension'), true);
  assert.equal(lines.at(-1).binary_omitted, 1);
});

test('numstat failure with successful name-status keeps files ordinary rows', { skip: process.platform === 'win32' }, async () => {
  const repo = createGitFixture('numstat-failsoft');
  writeFileSync(join(repo, 'control.mjs'), nulSource);
  git(repo, ['add', '-A']);
  const shimDir = temporaryDirectory('git-shim-');
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(shimDir, 'git'),
    `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = "--numstat" ] && exit 129; done\nexec "${realGit}" "$@"\n`,
    { mode: 0o755 });
  const result = spawnSync(process.execPath, [cliPath, '--repo', repo, '--change-state', 'staged'], {
    encoding: 'utf8', shell: false,
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = parseJsonLines(result.stdout);
  const row = lines.find((line) => line.path === 'control.mjs');
  assert.ok(row, 'file stays visible as an ordinary row');
  assert.equal('binary_suspect_reason' in row, false);
  assert.equal(lines.some((line) => 'binary_omitted' in line), false);
});
