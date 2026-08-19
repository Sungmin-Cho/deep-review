import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  POSIX_PROMPT_ARGUMENT_LIMIT,
  POSIX_PROMPT_IDENTITY_SCHEMA,
  WINDOWS_CMD_LIMIT,
  WINDOWS_COMMAND_HEADROOM,
  WINDOWS_CREATE_PROCESS_LIMIT,
  WINDOWS_PROMPT_IDENTITY_SCHEMA,
  cleanupPromptFile,
  createPromptFile,
  estimateWindowsCommandUnits,
  hostArgumentBudget,
  selectPromptTransport,
  verifyPromptIdentity,
  windowsCommandLimit,
} from '../hooks/scripts/lib/prompt-transport.mjs';
import {
  runAgyReviewer,
  __testing as agyTesting,
  estimateWindowsCommandUnits as agyEstimateWindowsCommandUnits,
  windowsCommandLimit as agyWindowsCommandLimit,
} from '../hooks/scripts/run-agy-reviewer.mjs';
import { estimateWindowsBatchCommandUnits } from '../hooks/scripts/lib/process.mjs';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Pinned to the commit this slice starts from, not HEAD, so the agy parity
// replay-and-diff cannot go vacuous once this slice's own commit lands.
const BASELINE_COMMIT = '6881588ea5404c56e6e71ec7ee8a19f029f4563b';

function workspace(label) {
  return realpathSync(mkdtempSync(join(tmpdir(), `deep-review-${label}-`)));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// T-WIN-1 / T-WIN-2 — the estimators now live in the shared module and agy's
// exported surface is exactly the same functions.
// ---------------------------------------------------------------------------

const BINARY_SHAPES = [
  'C:\\Tools\\agy.exe',
  'C:\\Tools\\agy.cmd',
  'C:\\Tools\\agy.CMD',
  'C:\\Tools\\agy.bat',
  'C:\\Tools\\agy.BAT',
  'C:\\Program Files\\agy suite\\agy.cmd',
  '/usr/local/bin/agy',
  'agy',
];

const ARGUMENT_SHAPES = [
  [],
  ['-p', ''],
  ['-p', 'plain prompt'],
  ['-p', 'quote " and caret ^ and percent %'],
  ['-p', 'newline\nand\ttab'],
  ['-p', 'a'.repeat(4_096)],
  ['-p', '%&'.repeat(2_000)],
  ['-p', '한글 프롬프트 바이트'],
  ['--print-timeout', '900s', '--add-dir', 'C:\\repo with space'],
  ['-p', 'x', '--model', 'gpt-5.4', '--dangerously-skip-permissions'],
  ['-p', '\u{1F680}'.repeat(512)],
  ['--add-dir', '/repo', '-p', 'trailing backslash\\'],
];

test('Windows cmd budget matches the existing agy export', () => {
  // The `.cmd` budget and the POSIX argument limit are computed from the
  // shared module: agy's own exports are the shared module's functions, not
  // a copy that merely happens to agree today.
  assert.equal(agyWindowsCommandLimit, windowsCommandLimit);
  assert.equal(agyEstimateWindowsCommandUnits, estimateWindowsCommandUnits);
  assert.equal(agyTesting.windowsCommandLimit, windowsCommandLimit);
  assert.equal(agyTesting.estimateWindowsCommandUnits, estimateWindowsCommandUnits);
  assert.equal(agyTesting.POSIX_PROMPT_ARGUMENT_LIMIT, POSIX_PROMPT_ARGUMENT_LIMIT);

  assert.equal(WINDOWS_CMD_LIMIT, 8_191);
  assert.equal(WINDOWS_CREATE_PROCESS_LIMIT, 32_767);
  assert.equal(WINDOWS_COMMAND_HEADROOM, 512);
  assert.equal(POSIX_PROMPT_ARGUMENT_LIMIT, 120 * 1024);

  for (const binary of BINARY_SHAPES) {
    const cmdShaped = /\.(?:cmd|bat)$/iu.test(binary);
    assert.equal(
      windowsCommandLimit(binary),
      cmdShaped ? WINDOWS_CMD_LIMIT : WINDOWS_CREATE_PROCESS_LIMIT,
      `windowsCommandLimit disagreed for ${binary}`,
    );
    for (const args of ARGUMENT_SHAPES) {
      const units = estimateWindowsCommandUnits(binary, args);
      assert.equal(
        units,
        cmdShaped
          ? estimateWindowsBatchCommandUnits(binary, args.map(String))
          : (binary.length * 2) + 2 + args.reduce((total, argument) => total + (String(argument).length * 2) + 3, 0),
        `estimateWindowsCommandUnits disagreed for ${binary}`,
      );
    }
  }
});

test('native Windows and POSIX prompt budgets remain shell-free', () => {
  // Comments are stripped: the contract is that no *code* reaches a shell,
  // and prose about which interpreter a runner may later select is not a
  // shell dependency.
  const source = readFileSync(join(pluginRoot, 'hooks', 'scripts', 'lib', 'prompt-transport.mjs'), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  for (const forbidden of [
    /\bexecSync\b/u,
    /\bshell\s*:\s*true/u,
    /child_process/u,
    /\bcmd\.exe\b/u,
    /\/bin\/(?:ba)?sh/u,
    /\bpowershell\b/iu,
  ]) {
    assert.doesNotMatch(source, forbidden, `prompt transport must stay shell-free: ${forbidden}`);
  }

  // The two host budgets are pure computations over the argv, on both
  // platforms, and the Windows budget subtracts the headroom while POSIX
  // does not.
  const windowsCmd = hostArgumentBudget({ binary: 'C:\\Tools\\agy.cmd', platform: 'win32' });
  assert.deepEqual(windowsCmd, {
    platform: 'win32',
    limit: WINDOWS_CMD_LIMIT,
    headroom: WINDOWS_COMMAND_HEADROOM,
    budget: WINDOWS_CMD_LIMIT - WINDOWS_COMMAND_HEADROOM,
  });
  const windowsExe = hostArgumentBudget({ binary: 'C:\\Tools\\agy.exe', platform: 'win32' });
  assert.deepEqual(windowsExe, {
    platform: 'win32',
    limit: WINDOWS_CREATE_PROCESS_LIMIT,
    headroom: WINDOWS_COMMAND_HEADROOM,
    budget: WINDOWS_CREATE_PROCESS_LIMIT - WINDOWS_COMMAND_HEADROOM,
  });
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(hostArgumentBudget({ binary: '/usr/local/bin/grok', platform }), {
      platform,
      limit: POSIX_PROMPT_ARGUMENT_LIMIT,
      headroom: 0,
      budget: POSIX_PROMPT_ARGUMENT_LIMIT,
    });
  }
});

// ---------------------------------------------------------------------------
// T-PROMPT-1 — the Grok-only lossless selector.
// ---------------------------------------------------------------------------

function promptFilePathFor(label) {
  return join(workspace(label), 'grok-prompt.txt');
}

const GROK_HOSTS = [
  ['linux', '/usr/local/bin/grok'],
  ['darwin', '/usr/local/bin/grok'],
  ['win32', 'C:\\Tools\\grok.exe'],
  ['win32', 'C:\\Tools\\grok.cmd'],
];

// The largest prompt this host still admits inline, found with the selector
// itself: the boundary is the contract, so it is measured, not guessed.
function largestInlinePrompt({ binary, platform, fixedArgs, promptFilePath }) {
  const { budget } = hostArgumentBudget({ binary, platform });
  let low = 0;
  let high = budget + 4_096;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const probe = selectPromptTransport({
      binary, platform, fixedArgs, promptFilePath, promptBytes: Buffer.alloc(middle, 0x61),
    });
    if (probe.transport === 'inline') low = middle; else high = middle - 1;
  }
  return low;
}

test('every fixed argv token is charged against the host budget', () => {
  const promptFilePath = promptFilePathFor('grok-fixed-tokens');
  const base = ['--model', 'grok-4.6', '--permission-mode', 'plan'];
  const extra = 'x'.repeat(1_000);

  for (const [platform, binary] of GROK_HOSTS) {
    const withoutExtra = largestInlinePrompt({ binary, platform, fixedArgs: base, promptFilePath });
    const withExtra = largestInlinePrompt({
      binary, platform, fixedArgs: [...base, '--cwd', extra], promptFilePath,
    });
    assert.ok(withoutExtra > 0, `no inline prompt fits on ${platform}/${binary}`);
    assert.ok(
      withoutExtra - withExtra >= extra.length,
      `a ${extra.length}-byte fixed token only cost ${withoutExtra - withExtra} of the ${platform}/${binary} budget`,
    );
  }
});

test('complete composed bytes deterministically select inline or prompt-file transport', () => {
  const fixedArgs = [
    '--model', 'grok-4.6',
    '--permission-mode', 'plan',
    '--sandbox', 'read-only',
    '--cwd', '/repo',
  ];

  for (const [platform, binary] of GROK_HOSTS) {
    const promptFilePath = promptFilePathFor('grok-transport');
    const { budget } = hostArgumentBudget({ binary, platform });

    const boundary = largestInlinePrompt({ binary, platform, fixedArgs, promptFilePath });
    assert.ok(boundary > 0, `no inline prompt fits on ${platform}/${binary}`);

    const atBoundary = Buffer.alloc(boundary, 0x61);
    const overBoundary = Buffer.alloc(boundary + 1, 0x61);

    const inline = selectPromptTransport({
      binary, platform, fixedArgs, promptFilePath, promptBytes: atBoundary,
    });
    assert.equal(inline.transport, 'inline');
    assert.equal(inline.truncated, false);
    assert.equal(inline.promptBytes, atBoundary.length);
    assert.equal(inline.promptSha256, sha256(atBoundary));
    assert.ok(inline.estimatedUnits <= inline.budget);
    // Exactly one transport flag, and the complete composed bytes are the
    // inline value byte-for-byte.
    assert.equal(inline.args.filter((token) => token === '--single').length, 1);
    assert.equal(inline.args.includes('--prompt-file'), false);
    assert.equal(
      Buffer.compare(Buffer.from(inline.args[inline.args.indexOf('--single') + 1], 'utf8'), atBoundary),
      0,
    );

    const viaFile = selectPromptTransport({
      binary, platform, fixedArgs, promptFilePath, promptBytes: overBoundary,
    });
    assert.equal(viaFile.transport, 'prompt-file');
    assert.equal(viaFile.truncated, false);
    assert.equal(viaFile.promptBytes, overBoundary.length);
    assert.equal(viaFile.promptSha256, sha256(overBoundary));
    assert.equal(viaFile.args.filter((token) => token === '--prompt-file').length, 1);
    assert.equal(viaFile.args.includes('--single'), false);
    assert.equal(viaFile.args[viaFile.args.indexOf('--prompt-file') + 1], promptFilePath);

    // Far above the budget stays lossless — no byte count is ever reduced,
    // and `prompt_too_large` is not a Grok large-payload outcome.
    const huge = Buffer.alloc(budget * 4, 0x62);
    const hugeSelection = selectPromptTransport({
      binary, platform, fixedArgs, promptFilePath, promptBytes: huge,
    });
    assert.equal(hugeSelection.transport, 'prompt-file');
    assert.equal(hugeSelection.truncated, false);
    assert.equal(hugeSelection.promptBytes, huge.length);
    assert.equal(hugeSelection.promptSha256, sha256(huge));

    // Deterministic: the same complete bytes select the same transport and
    // the same argv every time.
    assert.deepEqual(
      selectPromptTransport({ binary, platform, fixedArgs, promptFilePath, promptBytes: atBoundary }).args,
      inline.args,
    );
    assert.deepEqual(
      selectPromptTransport({ binary, platform, fixedArgs, promptFilePath, promptBytes: overBoundary }).args,
      viaFile.args,
    );
  }
});

test('the prompt-file argv form must itself fit the host budget or the attempt fails before spawn', () => {
  const platform = 'win32';
  const binary = 'C:\\Tools\\grok.cmd';
  const { budget } = hostArgumentBudget({ binary, platform });
  const promptFilePath = `C:\\${'p'.repeat(budget)}\\grok-prompt.txt`;
  assert.throws(
    () => selectPromptTransport({
      binary,
      platform,
      fixedArgs: ['--model', 'grok-4.6'],
      promptFilePath,
      promptBytes: Buffer.alloc(1_000_000, 0x63),
    }),
    /prompt_transport_unavailable/u,
  );
});

test('the selector never truncates and never reports a truncating outcome', () => {
  const promptFilePath = promptFilePathFor('grok-no-truncation');
  for (const size of [0, 1, 4_096, 120 * 1024, 158_404, 400_000]) {
    const promptBytes = Buffer.alloc(size, 0x64);
    const selection = selectPromptTransport({
      binary: '/usr/local/bin/grok',
      platform: 'linux',
      fixedArgs: ['--model', 'grok-4.6'],
      promptFilePath,
      promptBytes,
    });
    assert.equal(selection.truncated, false);
    assert.equal(selection.promptBytes, size);
    assert.equal(selection.promptSha256, sha256(promptBytes));
    assert.equal(Object.hasOwn(selection, 'prompt_too_large'), false);
  }
});

// ---------------------------------------------------------------------------
// POSIX identity contract — `posix-dev-ino-mode-uid-v1`.
// ---------------------------------------------------------------------------

test('POSIX prompt identity binds dev/ino/mode/uid', {
  skip: process.platform === 'win32' ? 'POSIX ownership fields are not Windows authorities' : false,
}, async () => {
  const promptBytes = Buffer.from(`grok prompt ${randomUUID()}\n`, 'utf8');
  const created = await createPromptFile(promptBytes, { prefix: 'grok-prompt' });
  try {
    assert.equal(created.record.schema, POSIX_PROMPT_IDENTITY_SCHEMA);
    assert.equal(POSIX_PROMPT_IDENTITY_SCHEMA, 'posix-dev-ino-mode-uid-v1');

    const stat = lstatSync(created.path);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(lstatSync(dirname(created.path)).mode & 0o777, 0o700);

    for (const field of ['dev', 'ino', 'mode', 'uid']) {
      assert.equal(typeof created.record.file[field], 'number', `file.${field} missing`);
      assert.equal(typeof created.record.directory[field], 'number', `directory.${field} missing`);
    }
    assert.equal(created.record.file.dev, stat.dev);
    assert.equal(created.record.file.ino, stat.ino);
    assert.equal(created.record.file.mode, stat.mode);
    assert.equal(created.record.file.uid, stat.uid);
    assert.equal(created.record.size, promptBytes.length);
    assert.equal(created.record.sha256, sha256(promptBytes));
    assert.equal(created.record.promptSha256, sha256(promptBytes));
    assert.equal(created.record.path, created.path);

    const pre = await verifyPromptIdentity(created.record, { handle: created.handle });
    assert.deepEqual(pre, { ok: true, reason: null, schema: POSIX_PROMPT_IDENTITY_SCHEMA });

    // Every bound field is load-bearing: breaking any one of them alone
    // makes revalidation fail.
    for (const field of ['dev', 'ino', 'mode', 'uid']) {
      const doctored = {
        ...created.record,
        file: { ...created.record.file, [field]: created.record.file[field] + 1 },
      };
      const verdict = await verifyPromptIdentity(doctored, { handle: created.handle });
      assert.equal(verdict.ok, false, `file.${field} is not bound`);
      assert.match(verdict.reason, new RegExp(field, 'u'));
    }

    // Replacing the pathname with a different same-user file — a new inode
    // with the same bytes — is rejected, and so is a byte change.
    const replacement = join(dirname(created.path), `replacement-${randomUUID()}`);
    writeFileSync(replacement, promptBytes, { mode: 0o600 });
    rmSync(created.path);
    writeFileSync(created.path, promptBytes, { mode: 0o600 });
    const afterReplacement = await verifyPromptIdentity(created.record, { handle: created.handle });
    assert.equal(afterReplacement.ok, false);
    assert.match(afterReplacement.reason, /ino|dev/u);
    rmSync(replacement, { force: true });

    // Owner-checked cleanup refuses to unlink a replacement path.
    const refused = await cleanupPromptFile(created.record, { handle: created.handle });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'prompt_cleanup_failed');
    assert.equal(existsSync(created.path), true, 'cleanup must not unlink a replacement path');
  } finally {
    await created.handle.close();
    rmSync(dirname(created.path), { recursive: true, force: true });
  }
});

test('owner-checked cleanup removes exactly the created file and its private directory', async () => {
  const promptBytes = Buffer.from('cleanup polarity\n', 'utf8');
  const created = await createPromptFile(promptBytes, { prefix: 'grok-prompt' });
  const directory = dirname(created.path);
  const cleaned = await cleanupPromptFile(created.record, { handle: created.handle });
  await created.handle.close();
  assert.deepEqual(cleaned, { ok: true, reason: null });
  assert.equal(existsSync(created.path), false);
  assert.equal(existsSync(directory), false);
});

test('digest drift between creation and the post-child check is observable', async () => {
  const promptBytes = Buffer.from('digest drift polarity\n', 'utf8');
  const created = await createPromptFile(promptBytes, { prefix: 'grok-prompt' });
  try {
    assert.equal((await verifyPromptIdentity(created.record, { handle: created.handle })).ok, true);
    const drifted = { ...created.record, sha256: sha256(Buffer.from('other bytes')) };
    const verdict = await verifyPromptIdentity(drifted, { handle: created.handle });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /sha256|digest/u);
  } finally {
    await created.handle.close();
    rmSync(dirname(created.path), { recursive: true, force: true });
  }
});

test('an in-place byte change under the same identity is caught by the pathname digest alone', async () => {
  // Same dev/ino/mode/uid and the same byte length: nothing but the SHA-256
  // of the bytes behind the pathname can observe this, and the check must
  // hold with no retained handle passed at all.
  const promptBytes = Buffer.from('in-place rewrite polarity\n', 'utf8');
  const created = await createPromptFile(promptBytes, { prefix: 'grok-prompt' });
  const before = lstatSync(created.path);
  try {
    assert.deepEqual(
      await verifyPromptIdentity(created.record),
      { ok: true, reason: null, schema: created.record.schema },
    );

    const rewritten = Buffer.from(promptBytes);
    rewritten[0] = rewritten[0] ^ 0x20;
    const inPlace = await open(created.path, 'r+');
    await inPlace.write(rewritten, 0, rewritten.length, 0);
    await inPlace.close();

    const observed = lstatSync(created.path);
    assert.equal(observed.ino, before.ino, 'the polarity must not change the inode');
    assert.equal(observed.size, before.size, 'the polarity must not change the byte length');

    const withoutHandle = await verifyPromptIdentity(created.record);
    assert.equal(withoutHandle.ok, false);
    assert.match(withoutHandle.reason, /sha256/u);

    const withHandle = await verifyPromptIdentity(created.record, { handle: created.handle });
    assert.equal(withHandle.ok, false);
    assert.match(withHandle.reason, /sha256/u);

    const refused = await cleanupPromptFile(created.record);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'prompt_cleanup_failed');
    assert.equal(existsSync(created.path), true);
  } finally {
    await created.handle.close();
    rmSync(dirname(created.path), { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T-WIN-3 — the native Windows identity contract. The production polarity
// runs only on the native Windows shard; the schema-level branch below is
// supporting unit evidence and is labelled as such.
// ---------------------------------------------------------------------------

test('native Windows prompt identity uses retained-handle SHA and no POSIX ownership authority', {
  skip: process.platform === 'win32'
    ? false
    : 'requires a native Windows retained-handle and pathname-replacement seam; the simulated branch below is supporting evidence only',
}, async () => {
  const promptBytes = Buffer.from(`grok windows prompt ${randomUUID()}\n`, 'utf8');
  const created = await createPromptFile(promptBytes, { prefix: 'grok-prompt' });
  try {
    assert.equal(created.record.schema, WINDOWS_PROMPT_IDENTITY_SCHEMA);
    assert.equal(WINDOWS_PROMPT_IDENTITY_SCHEMA, 'win32-retained-handle-sha256-v1');

    // Authorities: retained handle, contained non-reparse pathname, regular
    // file, byte length, SHA-256. POSIX ownership fields are never required.
    assert.equal(created.record.size, promptBytes.length);
    assert.equal(created.record.sha256, sha256(promptBytes));
    assert.equal(created.record.file.type, 'file');
    assert.equal(created.record.file.reparsePoint, false);
    for (const field of ['dev', 'ino', 'mode', 'uid']) {
      assert.equal(Object.hasOwn(created.record.file, field), false, `${field} must not be a Windows authority`);
    }

    const pre = await verifyPromptIdentity(created.record, { handle: created.handle });
    assert.deepEqual(pre, { ok: true, reason: null, schema: WINDOWS_PROMPT_IDENTITY_SCHEMA });

    // Diagnostic-only POSIX-shaped values cannot be made load-bearing.
    const doctored = {
      ...created.record,
      diagnostic: { ...(created.record.diagnostic ?? {}), mode: 0, dev: 0, ino: 0 },
    };
    assert.equal((await verifyPromptIdentity(doctored, { handle: created.handle })).ok, true);

    // The retained handle continues to name the created bytes, while
    // replacement of the pathname makes post-child validation fail.
    rmSync(created.path);
    writeFileSync(created.path, Buffer.from('replacement bytes\n', 'utf8'));
    const post = await verifyPromptIdentity(created.record, { handle: created.handle });
    assert.equal(post.ok, false);
    assert.match(post.reason, /sha256|size|handle/u);
    const viaHandle = Buffer.alloc(promptBytes.length);
    await created.handle.read(viaHandle, 0, promptBytes.length, 0);
    assert.equal(sha256(viaHandle), sha256(promptBytes));

    const refused = await cleanupPromptFile(created.record, { handle: created.handle });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'prompt_cleanup_failed');
  } finally {
    await created.handle.close();
    rmSync(dirname(created.path), { recursive: true, force: true });
  }
});

test('the Windows identity schema keeps POSIX mode/dev/ino out of its authority set (supporting evidence, not the native-Windows proof)', () => {
  assert.equal(WINDOWS_PROMPT_IDENTITY_SCHEMA, 'win32-retained-handle-sha256-v1');
  assert.notEqual(WINDOWS_PROMPT_IDENTITY_SCHEMA, POSIX_PROMPT_IDENTITY_SCHEMA);

  const source = readFileSync(join(pluginRoot, 'hooks', 'scripts', 'lib', 'prompt-transport.mjs'), 'utf8');
  const windowsAuthorities = /WINDOWS_IDENTITY_AUTHORITIES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/u.exec(source);
  assert.ok(windowsAuthorities, 'the Windows authority set must be declared, not implied');
  for (const posixOnly of ['dev', 'ino', 'mode', 'uid']) {
    assert.doesNotMatch(
      windowsAuthorities[1],
      new RegExp(`'${posixOnly}'`, 'u'),
      `${posixOnly} must not be a Windows admission authority`,
    );
  }
  const posixAuthorities = /POSIX_IDENTITY_AUTHORITIES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/u.exec(source);
  assert.ok(posixAuthorities, 'the POSIX authority set must be declared, not implied');
  for (const posixOnly of ['dev', 'ino', 'mode', 'uid']) {
    assert.match(posixAuthorities[1], new RegExp(`'${posixOnly}'`, 'u'));
  }
});

// ---------------------------------------------------------------------------
// The extraction guard (D8): agy's estimator surface and its truncating
// policy are replayed against the pinned pre-slice commit and diffed. The
// pinned commit — not HEAD — keeps this from going vacuous once this slice
// lands.
// ---------------------------------------------------------------------------

function extractBaseline(commit, label, mutate = null) {
  const dest = workspace(label);
  const list = spawnSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'hooks/scripts'], {
    cwd: pluginRoot, encoding: 'utf8',
  });
  assert.equal(list.status, 0, list.stderr);
  const paths = list.stdout.trim().split('\n').filter(Boolean);
  assert.ok(paths.includes('hooks/scripts/run-agy-reviewer.mjs'));
  assert.ok(paths.includes('hooks/scripts/lib/process.mjs'));
  for (const relPath of paths) {
    const show = spawnSync('git', ['show', `${commit}:${relPath}`], { cwd: pluginRoot, encoding: null });
    assert.equal(show.status, 0, show.stderr && show.stderr.toString());
    const destPath = join(dest, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, mutate ? mutate(relPath, show.stdout) : show.stdout);
  }
  return dest;
}

async function loadBaselineBridge(root) {
  return import(pathToFileURL(join(root, 'hooks', 'scripts', 'run-agy-reviewer.mjs')).href);
}

function estimatorMatrix() {
  const cases = [];
  for (const binary of BINARY_SHAPES) {
    for (const args of ARGUMENT_SHAPES) {
      cases.push({ binary, args });
    }
  }
  return cases;
}

function estimatorObservations(module, cases) {
  const observations = new Map();
  for (const { binary, args } of cases) {
    const key = `${binary}::${JSON.stringify(args)}`;
    observations.set(key, JSON.stringify({
      limit: module.windowsCommandLimit(binary),
      units: module.estimateWindowsCommandUnits(binary, args),
      testingLimit: module.__testing.windowsCommandLimit(binary),
      testingUnits: module.__testing.estimateWindowsCommandUnits(binary, args),
    }));
  }
  observations.set('::constants', JSON.stringify({
    BODY_LIMIT: module.__testing.BODY_LIMIT,
    POSIX_PROMPT_ARGUMENT_LIMIT: module.__testing.POSIX_PROMPT_ARGUMENT_LIMIT,
    READONLY_PREAMBLE: module.__testing.READONLY_PREAMBLE,
    testingKeys: Object.keys(module.__testing).sort(),
    frozen: Object.isFrozen(module.__testing),
  }));
  return observations;
}

function differingKeys(before, after) {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key));
}

test('agy estimator surface is bit-identical to the pinned pre-extraction baseline', async () => {
  const baselineRoot = extractBaseline(BASELINE_COMMIT, 'agy-estimator-baseline');
  const baseline = await loadBaselineBridge(baselineRoot);
  const current = await import('../hooks/scripts/run-agy-reviewer.mjs');

  const cases = estimatorMatrix();
  const differences = differingKeys(
    estimatorObservations(baseline, cases),
    estimatorObservations(current, cases),
  );
  assert.deepEqual(differences, [], `agy estimator surface diverged for: ${differences.join(', ')}`);

  // Positive control: a mutated baseline must be observed by exactly this
  // comparison. A diff that cannot fail proves nothing.
  const mutatedRoot = extractBaseline(BASELINE_COMMIT, 'agy-estimator-mutant', (relPath, bytes) => (
    relPath === 'hooks/scripts/run-agy-reviewer.mjs'
      ? Buffer.from(bytes.toString('utf8').replace('const WINDOWS_CMD_LIMIT = 8_191;', 'const WINDOWS_CMD_LIMIT = 8_190;'), 'utf8')
      : bytes
  ));
  assert.notEqual(
    readFileSync(join(mutatedRoot, 'hooks/scripts/run-agy-reviewer.mjs'), 'utf8'),
    readFileSync(join(baselineRoot, 'hooks/scripts/run-agy-reviewer.mjs'), 'utf8'),
    'positive control did not mutate the baseline',
  );
  const mutant = await loadBaselineBridge(mutatedRoot);
  const controlDifferences = differingKeys(
    estimatorObservations(mutant, cases),
    estimatorObservations(current, cases),
  );
  assert.ok(controlDifferences.length > 0, 'positive control failed to detect a mutated baseline');
});

function policyMatrix() {
  const cases = [];
  for (const [platform, binary] of [
    ['win32', 'C:\\Tools\\agy.exe'],
    ['win32', 'C:\\Tools\\agy.cmd'],
    ['win32', 'C:\\Tools\\agy.BAT'],
    ['linux', '/usr/local/bin/agy'],
  ]) {
    for (const bodySize of [0, 5_000, (120 * 1024) + 10, 198_001]) {
      for (const model of ['', 'gpt-5.4']) {
        cases.push({ platform, binary, bodySize, model });
      }
    }
  }
  return cases;
}

async function observePolicy(runner, shape, caseDir, promptFile, outputFile) {
  const calls = [];
  const result = await runner({
    binary: shape.binary,
    projectRoot: caseDir,
    pluginRoot,
    configPath: join(caseDir, 'config.yaml'),
    promptFile,
    outputFile,
    platform: shape.platform,
    model: shape.model,
    mode: 'off',
    privacyPreparer: async () => ({
      hits: [], fingerprint: 'same', outcome: 'acknowledged', error: null,
    }),
    fingerprintCapturer: async () => ({ mode: 'off', digest: null, entries: 0, error: null }),
    async processRunner(command, args) {
      calls.push({ command, args });
      return {
        code: 0,
        timedOut: false,
        stdout: Buffer.from('nonconforming stdout\n'),
        stderr: Buffer.alloc(0),
      };
    },
  });
  return JSON.stringify({
    calls,
    status: result.status,
    truncated: result.truncated,
    attempted: result.attempted,
    stderr: result.stderr,
    statusFile: readFileSync(`${outputFile}.status`, 'utf8'),
    stderrTail: readFileSync(`${outputFile}.stderr-tail`, 'utf8'),
    published: sha256(readFileSync(outputFile)),
  });
}

// Both sides run against the *same* fixture paths: `--add-dir` carries the
// project root into the argv, so two different temp roots would diverge for
// a reason that has nothing to do with the extraction.
async function policyReplay(beforeRunner, afterRunner, cases, label) {
  const root = workspace(label);
  const before = new Map();
  const after = new Map();
  for (const [index, shape] of cases.entries()) {
    const caseDir = join(root, `case-${index}`);
    mkdirSync(caseDir, { recursive: true });
    const promptFile = join(caseDir, 'prompt.txt');
    writeFileSync(promptFile, Buffer.alloc(shape.bodySize, 0x61));
    const outputFile = join(caseDir, 'out.txt');
    const key = `${shape.platform}::${shape.binary}::${shape.bodySize}::${shape.model || 'no-model'}`;
    before.set(key, await observePolicy(beforeRunner, shape, caseDir, promptFile, outputFile));
    after.set(key, await observePolicy(afterRunner, shape, caseDir, promptFile, outputFile));
  }
  return { before, after };
}

test('agy prompt-transport policy is bit-identical to the pinned pre-extraction baseline', async () => {
  const baselineRoot = extractBaseline(BASELINE_COMMIT, 'agy-policy-baseline');
  const baseline = await loadBaselineBridge(baselineRoot);

  const cases = policyMatrix();
  const replay = await policyReplay(baseline.runAgyReviewer, runAgyReviewer, cases, 'agy-policy');
  const differences = differingKeys(replay.before, replay.after);
  assert.deepEqual(differences, [], `agy prompt-transport policy diverged for: ${differences.join(', ')}`);

  const mutatedRoot = extractBaseline(BASELINE_COMMIT, 'agy-policy-mutant', (relPath, bytes) => (
    relPath === 'hooks/scripts/run-agy-reviewer.mjs'
      ? Buffer.from(bytes.toString('utf8').replace('const WINDOWS_COMMAND_HEADROOM = 512;', 'const WINDOWS_COMMAND_HEADROOM = 1024;'), 'utf8')
      : bytes
  ));
  const mutant = await loadBaselineBridge(mutatedRoot);
  const control = await policyReplay(mutant.runAgyReviewer, runAgyReviewer, cases, 'agy-policy-control');
  const controlDifferences = differingKeys(control.before, control.after);
  assert.ok(controlDifferences.length > 0, 'positive control failed to detect a mutated baseline');
});
