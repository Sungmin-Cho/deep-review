'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { delimiter, dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const processModuleUrl = pathToFileURL(join(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'lib',
  'process.mjs',
)).href;

const runtimePromise = import(processModuleUrl);

function workspace(label) {
  const root = mkdtempSync(join(tmpdir(), `deep-review-posix-${label}-`));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function executable(root, name, bytes) {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function elf64Carrier() {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  return bytes;
}

function incompleteFatHeader() {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(1, 4);
  return bytes;
}

function derivePosixHostCapability(classifyPosixExecutableType) {
  const host = classifyPosixExecutableType(process.execPath);
  if (host.ok) {
    assert.match(host.type, /^native-(?:elf|macho)$/u);
    return host.type;
  }
  assert.equal(host.reason, 'unsupported_posix_platform');
  return 'unsupported-posix';
}

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_I386 = 7;

function elf64Fixture({
  type = 2,
  machine = 183,
  entry = 0x400080n,
  phoff = 64n,
  programHeaders = null,
  fileSize = 512,
} = {}) {
  const headers = programHeaders || [{
    type: 1,
    flags: 5,
    offset: 0n,
    vaddr: 0x400000n,
    filesz: BigInt(fileSize),
    memsz: BigInt(fileSize),
    align: 0x1000n,
  }];
  const bytes = Buffer.alloc(fileSize);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  bytes.writeUInt16LE(type, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(entry, 24);
  bytes.writeBigUInt64LE(phoff, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(headers.length, 56);
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const cursor = Number(phoff) + index * 56;
    if (cursor + 56 > bytes.length) break;
    bytes.writeUInt32LE(header.type, cursor);
    bytes.writeUInt32LE(header.flags ?? 0, cursor + 4);
    bytes.writeBigUInt64LE(header.offset ?? 0n, cursor + 8);
    bytes.writeBigUInt64LE(header.vaddr ?? 0n, cursor + 16);
    bytes.writeBigUInt64LE(header.paddr ?? 0n, cursor + 24);
    bytes.writeBigUInt64LE(header.filesz ?? 0n, cursor + 32);
    bytes.writeBigUInt64LE(header.memsz ?? 0n, cursor + 40);
    bytes.writeBigUInt64LE(header.align ?? 0n, cursor + 48);
  }
  return bytes;
}

function segment64({
  vmaddr = 0x100000000n,
  vmsize = 1024n,
  fileoff = 0n,
  filesize = 1024n,
  maxprot = 5,
  initprot = 5,
} = {}) {
  const command = Buffer.alloc(72);
  command.writeUInt32LE(0x19, 0);
  command.writeUInt32LE(72, 4);
  Buffer.from('__TEXT').copy(command, 8);
  command.writeBigUInt64LE(vmaddr, 24);
  command.writeBigUInt64LE(vmsize, 32);
  command.writeBigUInt64LE(fileoff, 40);
  command.writeBigUInt64LE(filesize, 48);
  command.writeInt32LE(maxprot, 56);
  command.writeInt32LE(initprot, 60);
  command.writeUInt32LE(0, 64);
  return command;
}

function lcMain(entryoff = 512n, commandSize = 24) {
  const command = Buffer.alloc(commandSize);
  command.writeUInt32LE(0x80000028, 0);
  command.writeUInt32LE(commandSize, 4);
  if (commandSize >= 16) command.writeBigUInt64LE(entryoff, 8);
  return command;
}

function dylinkerCommand(type = 0xe) {
  const command = Buffer.alloc(32);
  command.writeUInt32LE(type, 0);
  command.writeUInt32LE(32, 4);
  command.writeUInt32LE(12, 8);
  Buffer.from('/usr/lib/dyld\0').copy(command, 12);
  return command;
}

function buildVersion({ platform = 1, ntools = 0, commandSize = 24 + ntools * 8 } = {}) {
  const command = Buffer.alloc(commandSize);
  command.writeUInt32LE(0x32, 0);
  command.writeUInt32LE(commandSize, 4);
  if (commandSize >= 12) command.writeUInt32LE(platform, 8);
  if (commandSize >= 24) command.writeUInt32LE(ntools, 20);
  return command;
}

function unixThread({
  arch = 'arm64',
  pc = 0x100000200n,
  flavor,
  count,
  cpsrLookingPc = null,
} = {}) {
  const actualFlavor = flavor ?? (arch === 'arm64' ? 6 : 4);
  const actualCount = count ?? (arch === 'arm64' ? 68 : 42);
  const command = Buffer.alloc(8 + 8 + actualCount * 4);
  command.writeUInt32LE(0x5, 0);
  command.writeUInt32LE(command.length, 4);
  command.writeUInt32LE(actualFlavor, 8);
  command.writeUInt32LE(actualCount, 12);
  const stateStart = 16;
  const pcOffset = arch === 'arm64' ? 256 : 128;
  if (pcOffset + 8 <= actualCount * 4) command.writeBigUInt64LE(pc, stateStart + pcOffset);
  if (cpsrLookingPc !== null && arch === 'arm64') {
    command.writeBigUInt64LE(cpsrLookingPc, stateStart + 264);
  }
  return command;
}

function thinMacho({
  arch = 'arm64',
  subtype = arch === 'arm64' ? 0 : 3,
  filetype = 2,
  commands = null,
  fileSize = 1024,
} = {}) {
  const loadCommands = commands || [segment64(), lcMain(), dylinkerCommand(), buildVersion()];
  const sizeofcmds = loadCommands.reduce((total, command) => total + command.length, 0);
  assert.ok(32 + sizeofcmds <= fileSize, 'fixture commands must fit');
  const bytes = Buffer.alloc(fileSize);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeInt32LE(arch === 'arm64' ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64, 4);
  bytes.writeUInt32LE(subtype >>> 0, 8);
  bytes.writeUInt32LE(filetype, 12);
  bytes.writeUInt32LE(loadCommands.length, 16);
  bytes.writeUInt32LE(sizeofcmds, 20);
  let cursor = 32;
  for (const command of loadCommands) {
    command.copy(bytes, cursor);
    cursor += command.length;
  }
  return bytes;
}

// A load command the classifier has no branch for: it is skipped, so the only
// thing that can reject it is the load-command table's size/alignment rule.
function unknownLoadCommand(commandSize) {
  const command = Buffer.alloc(commandSize);
  command.writeUInt32LE(0x7fff0001, 0);
  command.writeUInt32LE(commandSize, 4);
  return command;
}

function segment32({
  vmaddr = 0x1000,
  vmsize = 1024,
  fileoff = 0,
  filesize = 1024,
  maxprot = 5,
  initprot = 5,
} = {}) {
  const command = Buffer.alloc(56);
  command.writeUInt32LE(0x1, 0);
  command.writeUInt32LE(56, 4);
  Buffer.from('__TEXT').copy(command, 8);
  command.writeUInt32LE(vmaddr, 24);
  command.writeUInt32LE(vmsize, 28);
  command.writeUInt32LE(fileoff, 32);
  command.writeUInt32LE(filesize, 36);
  command.writeInt32LE(maxprot, 40);
  command.writeInt32LE(initprot, 44);
  command.writeUInt32LE(0, 48);
  return command;
}

function thinMacho32({
  subtype = 3,
  filetype = 2,
  commands = null,
  fileSize = 1024,
} = {}) {
  const loadCommands = commands || [segment32(), lcMain(), dylinkerCommand()];
  const sizeofcmds = loadCommands.reduce((total, command) => total + command.length, 0);
  assert.ok(28 + sizeofcmds <= fileSize, 'fixture commands must fit');
  const bytes = Buffer.alloc(fileSize);
  bytes.writeUInt32LE(0xfeedface, 0);
  bytes.writeInt32LE(CPU_TYPE_I386, 4);
  bytes.writeUInt32LE(subtype >>> 0, 8);
  bytes.writeUInt32LE(filetype, 12);
  bytes.writeUInt32LE(loadCommands.length, 16);
  bytes.writeUInt32LE(sizeofcmds, 20);
  let cursor = 28;
  for (const command of loadCommands) {
    command.copy(bytes, cursor);
    cursor += command.length;
  }
  return bytes;
}

function fatMacho(thin, { align = 12, offset = 4096, subtype = 0 } = {}) {
  const bytes = Buffer.alloc(offset + thin.length);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(1, 4);
  bytes.writeInt32BE(CPU_TYPE_ARM64, 8);
  bytes.writeUInt32BE(subtype >>> 0, 12);
  bytes.writeUInt32BE(offset, 16);
  bytes.writeUInt32BE(thin.length, 20);
  bytes.writeUInt32BE(align, 24);
  thin.copy(bytes, offset);
  return bytes;
}

function repeatedUnixThread(pcs, { includeOtherFlavor = false } = {}) {
  const triples = [];
  if (includeOtherFlavor) {
    // Two state words, so the whole LC_UNIXTHREAD stays eight-byte aligned.
    const other = Buffer.alloc(16);
    other.writeUInt32LE(99, 0);
    other.writeUInt32LE(2, 4);
    triples.push(other);
  }
  for (const pc of pcs) {
    const triple = Buffer.alloc(8 + 68 * 4);
    triple.writeUInt32LE(6, 0);
    triple.writeUInt32LE(68, 4);
    triple.writeBigUInt64LE(pc, 8 + 256);
    triples.push(triple);
  }
  const command = Buffer.concat([Buffer.alloc(8), ...triples]);
  command.writeUInt32LE(0x5, 0);
  command.writeUInt32LE(command.length, 4);
  return command;
}

function versionMinMacos(commandSize = 16) {
  const command = Buffer.alloc(commandSize);
  command.writeUInt32LE(0x24, 0);
  command.writeUInt32LE(commandSize, 4);
  return command;
}

function fatMachoTable({ count = 16, overlap = false, align = 12 } = {}) {
  const hostThin = thinMacho();
  const foreignThin = thinMacho({ arch: 'x64' });
  const firstOffset = 4096;
  const stride = 4096;
  const finalOffset = firstOffset + (count - 1) * stride;
  const bytes = Buffer.alloc(finalOffset + hostThin.length);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(count, 4);
  for (let index = 0; index < count; index += 1) {
    const cursor = 8 + index * 20;
    const host = index === count - 1;
    const thin = host ? hostThin : foreignThin;
    const offset = overlap && index === 1 ? firstOffset : firstOffset + index * stride;
    bytes.writeInt32BE(host ? CPU_TYPE_ARM64 : CPU_TYPE_X86_64, cursor);
    bytes.writeUInt32BE(host ? 0 : 3, cursor + 4);
    bytes.writeUInt32BE(offset, cursor + 8);
    bytes.writeUInt32BE(thin.length, cursor + 12);
    bytes.writeUInt32BE(align, cursor + 16);
    thin.copy(bytes, offset);
  }
  return bytes;
}

function fatArm64Slices(subtypes) {
  const offset = 4096;
  const stride = 4096;
  const thins = subtypes.map((subtype) => thinMacho({ subtype }));
  const bytes = Buffer.alloc(offset + (thins.length - 1) * stride + thins.at(-1).length);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(thins.length, 4);
  for (let index = 0; index < thins.length; index += 1) {
    const cursor = 8 + index * 20;
    const sliceOffset = offset + index * stride;
    bytes.writeInt32BE(CPU_TYPE_ARM64, cursor);
    bytes.writeUInt32BE(subtypes[index] >>> 0, cursor + 4);
    bytes.writeUInt32BE(sliceOffset, cursor + 8);
    bytes.writeUInt32BE(thins[index].length, cursor + 12);
    bytes.writeUInt32BE(12, cursor + 16);
    thins[index].copy(bytes, sliceOffset);
  }
  return bytes;
}

test('process runtime exports the SLICE-003a classifier and chain primitives', async () => {
  const runtime = await runtimePromise;
  for (const name of [
    'classifyPosixExecutableType',
    'discoverArm64PointerAuthVersion',
    'parsePosixShebang',
    'prepareSpawnChain',
    'resolveEnvPathTarget',
  ]) {
    assert.equal(typeof runtime[name], 'function', `${name} must be exported`);
  }
});

test('platform-native Node and env are admitted only as effective executables', async (t) => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    t.skip('the closed POSIX classifier supports macOS and Linux');
    return;
  }
  const { classifyPosixExecutableType } = await runtimePromise;
  const expectedType = process.platform === 'darwin' ? 'native-macho' : 'native-elf';

  for (const path of [process.execPath, '/usr/bin/env']) {
    const result = classifyPosixExecutableType(path);
    assert.equal(result.ok, true, `${path}: ${result.reason || 'rejected'}`);
    assert.equal(result.type, expectedType);
    assert.equal(result.classification_purpose, 'effective-executable');
  }
});

test('missing shebang is never native: text, empty, truncated, and malformed carriers reject', async () => {
  const root = workspace('closed-carriers');
  const { classifyPosixExecutableType } = await runtimePromise;
  const fixtures = [
    ['ASCII executable text', Buffer.from('console.log("not native")\n')],
    ['UTF-8 executable text', Buffer.from('텍스트 실행 파일\n')],
    ['empty file', Buffer.alloc(0)],
    ['truncated ELF header', Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
    ['64-byte ELF carrier with zero e_type and zero e_machine', elf64Carrier()],
    ['eight-byte fat header with nfat_arch=1 and no following fat_arch', incompleteFatHeader()],
  ];

  for (const [name, bytes] of fixtures) {
    const result = classifyPosixExecutableType(executable(root, name.replaceAll(' ', '-'), bytes));
    assert.equal(result.ok, false, name);
    assert.equal(typeof result.reason, 'string', name);
    assert.notEqual(result.reason.length, 0, name);
  }
});

test('foreign-endian Mach-O and foreign-platform ELF fail closed', async () => {
  const root = workspace('foreign');
  const { classifyPosixExecutableType } = await runtimePromise;
  const hostType = derivePosixHostCapability(classifyPosixExecutableType);
  const malformedNativeReason = hostType === 'native-elf'
    ? /^invalid_elf_header$/u
    : hostType === 'native-macho'
      ? /foreign|unrecognized|malformed/u
      : /^unsupported_posix_platform$/u;
  assert.doesNotMatch('accepted_for_any_reason', malformedNativeReason);
  const foreignEndian = Buffer.alloc(32);
  foreignEndian.writeUInt32BE(0xfeedfacf, 0);

  const macho = classifyPosixExecutableType(executable(root, 'foreign-endian', foreignEndian));
  assert.equal(macho.ok, false);
  assert.match(macho.reason, malformedNativeReason);

  const elf = classifyPosixExecutableType(executable(root, 'foreign-elf', elf64Carrier()));
  assert.equal(elf.ok, false);
  const elfReason = hostType === 'native-macho'
    ? /^foreign_platform_elf$/u
    : hostType === 'native-elf'
      ? /^invalid_elf_type_or_cpu$/u
      : /^unsupported_posix_platform$/u;
  assert.match(elf.reason, elfReason);
});

test('resolveEnvPathTarget binds only an absolute, non-empty PATH authority', async () => {
  const root = workspace('path');
  const target = executable(root, 'node', Buffer.from('#!/invalid nested\n'));
  const { classifyPosixExecutableType, resolveEnvPathTarget } = await runtimePromise;
  const hostType = derivePosixHostCapability(classifyPosixExecutableType);

  assert.equal(
    resolveEnvPathTarget('node', { PATH: root }, root),
    hostType === 'unsupported-posix' ? null : target,
  );
  assert.equal(resolveEnvPathTarget('node', { PATH: ['', root].join(delimiter) }, root), null);
  assert.equal(resolveEnvPathTarget('node', { PATH: [root, ''].join(delimiter) }, root), null);
  assert.equal(resolveEnvPathTarget('node', { PATH: ['relative', root].join(delimiter) }, root), null);
  assert.equal(resolveEnvPathTarget('-Snode', { PATH: root }, root), null);
  assert.equal(resolveEnvPathTarget('../node', { PATH: root }, root), null);
});

test('POSIX shebang parser admits only the disjoint absolute and env-path forms', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shebang parsing is not observable on native Windows');
    return;
  }
  const root = workspace('shebang-grammar');
  const { parsePosixShebang } = await runtimePromise;
  const absolute = executable(root, 'absolute', Buffer.from(`#!${process.execPath}\n`));
  const envPath = executable(root, 'env-path', Buffer.from('#!/usr/bin/env node\n'));

  assert.deepEqual(parsePosixShebang(absolute, process.env, root), {
    ok: true,
    shebang_form: 'absolute',
    interpreter_path: process.execPath,
    path_target_path: null,
  });
  assert.deepEqual(parsePosixShebang(envPath, { ...process.env, PATH: dirname(process.execPath) }, root), {
    ok: true,
    shebang_form: 'env-path',
    interpreter_path: '/usr/bin/env',
    path_target_path: process.execPath,
  });

  const rejected = [
    ['env -S', '#!/usr/bin/env -Snode\n', process.env],
    ['env option', '#!/usr/bin/env -i node\n', process.env],
    ['bare env', '#!/usr/bin/env\n', process.env],
    ['bare bin env', '#!/bin/env\n', process.env],
    ['bin env operand', '#!/bin/env node\n', process.env],
    ['relative interpreter', '#!node\n', process.env],
    ['absolute extra token', `#!${process.execPath} --flag\n`, process.env],
    ['quoted interpreter', `#!"${process.execPath}"\n`, process.env],
    ['empty shebang', '#!\n', process.env],
    ['relative PATH entry', '#!/usr/bin/env node\n', { ...process.env, PATH: `relative:${dirname(process.execPath)}` }],
    ['empty PATH entry', '#!/usr/bin/env node\n', { ...process.env, PATH: `:${dirname(process.execPath)}` }],
  ];
  for (const [name, source, env] of rejected) {
    const result = parsePosixShebang(executable(root, name.replaceAll(' ', '-'), Buffer.from(source)), env, root);
    assert.equal(result.ok, false, name);
    assert.equal(typeof result.reason, 'string', name);
  }
});

test('POSIX shebang parser rejects a truncated first line', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX shebang parsing is not observable on native Windows');
    return;
  }
  const root = workspace('truncated-shebang');
  const { parsePosixShebang } = await runtimePromise;
  const path = executable(root, 'long-shebang', Buffer.from(`#!/${'a'.repeat(300)}\n`));
  const result = parsePosixShebang(path, process.env, root);
  assert.deepEqual(result, { ok: false, reason: 'truncated_shebang' });
});

test('synthetic ELF64 positives admit static ET_EXEC and PIE ET_DYN', async () => {
  const { __testing } = await runtimePromise;
  for (const fixture of [
    elf64Fixture(),
    elf64Fixture({
      type: 3,
      entry: 0x100n,
      programHeaders: [{
        type: 1, flags: 5, offset: 0n, vaddr: 0n,
        filesz: 512n, memsz: 512n, align: 0x1000n,
      }],
    }),
  ]) {
    const result = __testing.classifyElfBytes(fixture, { arch: 'arm64' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.type, 'native-elf');
  }
});

test('synthetic ELF64 named structural polarities fail for their intended reason', async () => {
  const { __testing } = await runtimePromise;
  const load = {
    type: 1, flags: 5, offset: 0n, vaddr: 0x400000n,
    filesz: 512n, memsz: 512n, align: 0x1000n,
  };
  const phdr = {
    type: 6, flags: 4, offset: 64n, vaddr: 0x400040n,
    filesz: 112n, memsz: 112n, align: 8n,
  };
  const fixtures = [
    ['host-CPU ELF64 ET_EXEC two-phdr PT_LOAD out-of-file range',
      elf64Fixture({ programHeaders: [{ ...load, filesz: 513n }, phdr] }), /file_range/u],
    ['host-CPU ELF64 ET_EXEC two-phdr no PF_X PT_LOAD',
      elf64Fixture({ programHeaders: [{ ...load, flags: 4 }, phdr] }), /entry_outside/u],
    ['e_entry outside every executable mapping',
      elf64Fixture({ entry: 0x500000n }), /entry_outside/u],
    ['invalid p_align',
      elf64Fixture({ programHeaders: [{ ...load, align: 3n }] }), /alignment/u],
    ['virtual/file congruence',
      elf64Fixture({ programHeaders: [{ ...load, vaddr: 0x400001n }] }), /congruence/u],
    ['overflow or truncation',
      elf64Fixture({ phoff: 0xfffffffffffffff0n }), /program_header_table/u],
  ];
  for (const [name, bytes, reason] of fixtures) {
    const result = __testing.classifyElfBytes(bytes, { arch: 'arm64' });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, reason, name);
  }
});

test('synthetic ELF64 validates PT_INTERP cardinality, bounds, and final NUL', async () => {
  const { __testing } = await runtimePromise;
  const load = {
    type: 1, flags: 5, offset: 0n, vaddr: 0x400000n,
    filesz: 512n, memsz: 512n, align: 0x1000n,
  };
  const interpreter = (offset, filesz) => ({
    type: 3, flags: 4, offset: BigInt(offset), vaddr: 0n,
    filesz: BigInt(filesz), memsz: BigInt(filesz), align: 1n,
  });
  const fixtures = [
    ['one-byte PT_INTERP', elf64Fixture({ programHeaders: [load, interpreter(300, 1)] })],
    ['out-of-range PT_INTERP', elf64Fixture({ programHeaders: [load, interpreter(500, 20)] })],
    ['non-NUL PT_INTERP', (() => {
      const bytes = elf64Fixture({ programHeaders: [load, interpreter(300, 4)] });
      Buffer.from('/bad').copy(bytes, 300);
      return bytes;
    })()],
    ['multiple PT_INTERP', elf64Fixture({
      programHeaders: [load, interpreter(300, 4), interpreter(320, 4)],
    })],
  ];
  for (const [name, bytes] of fixtures) {
    const result = __testing.classifyElfBytes(bytes, { arch: 'arm64' });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /interpreter|file_range/u, name);
  }
  const path = Buffer.from('/lib/ld.so\0');
  const valid = elf64Fixture({ programHeaders: [load, interpreter(300, path.length)] });
  path.copy(valid, 300);
  const admitted = __testing.classifyElfBytes(valid, { arch: 'arm64' });
  assert.equal(admitted.ok, true, admitted.reason);
  assert.equal(admitted.native_loader_path, '/lib/ld.so');
});

test('synthetic Mach-O admits LC_MAIN, fat selection, and normalized arm64e', async () => {
  const { __testing } = await runtimePromise;
  const thin = thinMacho();
  const fat = fatMacho(thin);
  const arm64e = thinMacho({ subtype: 0x80000002 });
  const x64Capability = thinMacho({ arch: 'x64', subtype: 0x80000003 });

  for (const [name, bytes, options] of [
    ['thin host LC_MAIN', thin, { arch: 'arm64' }],
    ['fat selected host LC_MAIN', fat, { arch: 'arm64' }],
    ['raw 0x80000002 arm64e', arm64e, { arch: 'arm64', acceptedPointerAuthVersions: [0] }],
    ['x86_64 LIB64 capability', x64Capability, { arch: 'x64' }],
  ]) {
    const result = __testing.classifyMachoBytes(bytes, options);
    assert.equal(result.ok, true, `${name}: ${result.reason}`);
    assert.equal(result.type, 'native-macho', name);
  }
});

test('synthetic Mach-O named CPU, filetype, command, mapping, and platform polarities reject', async () => {
  const { __testing } = await runtimePromise;
  const fixtures = [
    ['invalid CPU', thinMacho({ arch: 'x64' }), {}, /cpu/u],
    ['invalid file type', thinMacho({ filetype: 7 }), {}, /filetype/u],
    ['thin host-CPU MH_EXECUTE eight-byte LC_MAIN', thinMacho({
      commands: [segment64(), lcMain(0n, 8), dylinkerCommand(), buildVersion()],
    }), {}, /lc_main/u],
    ['thin host-CPU MH_EXECUTE eight-byte LC_UNIXTHREAD', thinMacho({
      commands: [segment64(), Buffer.from([5, 0, 0, 0, 8, 0, 0, 0]), dylinkerCommand(), buildVersion()],
    }), {}, /unixthread/u],
    ['invalid segment file range', thinMacho({
      commands: [segment64({ fileoff: 1000n, filesize: 40n }), lcMain(1000n), dylinkerCommand(), buildVersion()],
    }), {}, /segment_file_range/u],
    ['invalid LC_MAIN entryoff', thinMacho({
      commands: [segment64(), lcMain(2048n), dylinkerCommand(), buildVersion()],
    }), {}, /entry_outside/u],
    ['incompatible CPU subtype', thinMacho({ subtype: 9 }), {}, /subtype/u],
    ['incompatible capability-bit', thinMacho({ subtype: 0x40000002 }), {}, /subtype/u],
    ['unknown base subtype after CPU_SUBTYPE_MASK', thinMacho({ subtype: 0x80000009 }), {}, /subtype/u],
    ['LC_BUILD_VERSION PLATFORM_IOS', thinMacho({
      commands: [segment64(), lcMain(), dylinkerCommand(), buildVersion({ platform: 2 })],
    }), {}, /platform/u],
    ['maxprot READ|EXEC initprot READ', thinMacho({
      commands: [segment64({ maxprot: 5, initprot: 1 }), lcMain(), dylinkerCommand(), buildVersion()],
    }), {}, /entry_outside/u],
  ];
  for (const [name, bytes, options, reason] of fixtures) {
    const result = __testing.classifyMachoBytes(bytes, { arch: 'arm64', ...options });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, reason, name);
  }
});

test('synthetic Mach-O requires exact LC_LOAD_DYLINKER bytes and exclusive entry authority', async () => {
  const { __testing } = await runtimePromise;
  const badPadding = dylinkerCommand();
  badPadding[31] = 1;
  const embeddedNul = dylinkerCommand();
  embeddedNul[16] = 0;
  const malformedSize = dylinkerCommand();
  // Eight-byte aligned but not the exact 32 LC_LOAD_DYLINKER requires, so the
  // dylinker rule rejects it rather than the load-command alignment rule.
  malformedSize.writeUInt32LE(24, 4);
  const badNameOffset = dylinkerCommand();
  badNameOffset.writeUInt32LE(16, 8);
  const missingFinalNul = dylinkerCommand();
  missingFinalNul[25] = 0x78;
  const nonAbsolute = dylinkerCommand();
  Buffer.alloc(20).copy(nonAbsolute, 12);
  Buffer.from('usr/lib/dyld\0').copy(nonAbsolute, 12);
  const alternate = dylinkerCommand();
  Buffer.alloc(20).copy(alternate, 12);
  Buffer.from('/tmp/ld\0').copy(alternate, 12);
  const fixtures = [
    ['absent LC_LOAD_DYLINKER', thinMacho({ commands: [segment64(), lcMain(), buildVersion()] })],
    ['duplicate LC_LOAD_DYLINKER', thinMacho({
      commands: [segment64(), lcMain(), dylinkerCommand(), dylinkerCommand(), buildVersion()],
    })],
    ['nonzero alignment-padding', thinMacho({
      commands: [segment64(), lcMain(), badPadding, buildVersion()],
    })],
    ['embedded-NUL-before-suffix', thinMacho({
      commands: [segment64(), lcMain(), embeddedNul, buildVersion()],
    })],
    ['malformed cmdsize', thinMacho({
      commands: [segment64(), lcMain(), malformedSize, buildVersion()],
    })],
    ['bad name offset', thinMacho({
      commands: [segment64(), lcMain(), badNameOffset, buildVersion()],
    })],
    ['missing final NUL', thinMacho({
      commands: [segment64(), lcMain(), missingFinalNul, buildVersion()],
    })],
    ['non-absolute dylinker', thinMacho({
      commands: [segment64(), lcMain(), nonAbsolute, buildVersion()],
    })],
    ['alternate dylinker', thinMacho({
      commands: [segment64(), lcMain(), alternate, buildVersion()],
    })],
    ['LC_ID_DYLINKER on MH_EXECUTE', thinMacho({
      commands: [segment64(), lcMain(), dylinkerCommand(0xf), buildVersion()],
    })],
    ['mixed LC_MAIN and LC_UNIXTHREAD', thinMacho({
      commands: [segment64(), lcMain(), unixThread(), dylinkerCommand(), buildVersion()],
    })],
  ];
  for (const [name, bytes] of fixtures) {
    const result = __testing.classifyMachoBytes(bytes, { arch: 'arm64' });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /dylinker|entry_command/u, name);
  }
});

test('arm64 LC_UNIXTHREAD uses state byte 256 and never cpsr/pad byte 264', async () => {
  const { __testing } = await runtimePromise;
  const valid = thinMacho({
    commands: [segment64(), unixThread(), dylinkerCommand(), buildVersion()],
  });
  const cpsrPolarity = thinMacho({
    commands: [
      segment64(),
      unixThread({ pc: 0x200000000n, cpsrLookingPc: 0x100000200n }),
      dylinkerCommand(),
      buildVersion(),
    ],
  });
  const invalidCount = thinMacho({
    commands: [segment64(), unixThread({ count: 66 }), dylinkerCommand(), buildVersion()],
  });

  assert.equal(__testing.classifyMachoBytes(valid, { arch: 'arm64' }).ok, true);
  const cpsr = __testing.classifyMachoBytes(cpsrPolarity, { arch: 'arm64' });
  assert.equal(cpsr.ok, false);
  assert.match(cpsr.reason, /entry_outside/u);
  const count = __testing.classifyMachoBytes(invalidCount, { arch: 'arm64' });
  assert.equal(count.ok, false);
  assert.match(count.reason, /unixthread_state/u);
  assert.equal(__testing.classifyMachoBytes(fatMacho(valid), { arch: 'arm64' }).ok, true);
  const fatCpsr = __testing.classifyMachoBytes(fatMacho(cpsrPolarity), { arch: 'arm64' });
  assert.equal(fatCpsr.ok, false);
  assert.match(fatCpsr.reason, /entry_outside/u);
});

test('native-loader purpose is a closed non-recursive MH_DYLINKER structural profile', async () => {
  const { __testing } = await runtimePromise;
  const loader = thinMacho({
    filetype: 7,
    commands: [segment64(), unixThread(), dylinkerCommand(0xf), buildVersion()],
  });
  const genericOnly = thinMacho({ filetype: 7, commands: [buildVersion()] });
  const executableAsLoader = thinMacho();

  const positive = __testing.classifyMachoBytes(loader, {
    arch: 'arm64',
    purpose: 'native-loader',
  });
  assert.equal(positive.ok, true, positive.reason);
  assert.equal(positive.classification_purpose, 'native-loader');
  assert.equal(__testing.classifyMachoBytes(loader, { arch: 'arm64' }).ok, false);
  assert.equal(__testing.classifyMachoBytes(genericOnly, {
    arch: 'arm64', purpose: 'native-loader',
  }).ok, false);
  assert.equal(__testing.classifyMachoBytes(executableAsLoader, {
    arch: 'arm64', purpose: 'native-loader',
  }).ok, false);
  assert.equal(__testing.classifyMachoBytes(loader, {
    arch: 'arm64', purpose: 'caller-controlled',
  }).ok, false);
});

test('public classifier rejects a caller-controlled classification purpose', async () => {
  const { classifyPosixExecutableType } = await runtimePromise;
  assert.deepEqual(
    classifyPosixExecutableType(process.execPath, { classification_purpose: 'native-loader' }),
    { ok: false, reason: 'caller_controlled_classification_purpose' },
  );
});

test('fat Mach-O rejects invalid alignment, overlap, and malformed selected slices', async () => {
  const { __testing } = await runtimePromise;
  const invalidAlignment = fatMacho(thinMacho(), { align: 32 });
  const overlapping = fatMachoTable({ count: 2, overlap: true });
  const fatMain8 = fatMacho(thinMacho({
    commands: [segment64(), lcMain(0n, 8), dylinkerCommand(), buildVersion()],
  }));
  const fatThread8 = fatMacho(thinMacho({
    commands: [segment64(), Buffer.from([5, 0, 0, 0, 8, 0, 0, 0]), dylinkerCommand(), buildVersion()],
  }));
  const fatInitprot = fatMacho(thinMacho({
    commands: [segment64({ maxprot: 5, initprot: 1 }), lcMain(), dylinkerCommand(), buildVersion()],
  }));
  const fixtures = [
    ['fat host-CPU invalid alignment exponent', invalidAlignment, /alignment/u],
    ['fat host-CPU overlapping-slices', overlapping, /overlapping/u],
    ['fat-wrapped host-CPU MH_EXECUTE eight-byte LC_MAIN', fatMain8, /lc_main/u],
    ['fat-wrapped host-CPU MH_EXECUTE eight-byte LC_UNIXTHREAD', fatThread8, /unixthread/u],
    ['fat-wrapped host-CPU MH_EXECUTE maxprot READ|EXEC initprot READ', fatInitprot, /entry_outside/u],
  ];
  for (const [name, bytes, reason] of fixtures) {
    const result = __testing.classifyMachoBytes(bytes, { arch: 'arm64' });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, reason, name);
  }
});

test('Mach-O validates filesize, version command sizes, and repeated thread triples', async () => {
  const { __testing } = await runtimePromise;
  const filesizeTooLarge = thinMacho({
    commands: [segment64({ vmsize: 512n, filesize: 1024n }), lcMain(), dylinkerCommand(), buildVersion()],
  });
  const badVersionMin = thinMacho({
    commands: [segment64(), lcMain(), dylinkerCommand(), versionMinMacos(24)],
  });
  const badBuildVersion = thinMacho({
    commands: [segment64(), lcMain(), dylinkerCommand(), buildVersion({ ntools: 1, commandSize: 24 })],
  });
  const equalPcs = thinMacho({
    fileSize: 2048,
    commands: [
      segment64({ vmsize: 2048n, filesize: 2048n }),
      repeatedUnixThread([0x100000200n, 0x100000200n], { includeOtherFlavor: true }),
      dylinkerCommand(),
      buildVersion(),
    ],
  });
  const conflictingPcs = thinMacho({
    fileSize: 2048,
    commands: [
      segment64({ vmsize: 2048n, filesize: 2048n }),
      repeatedUnixThread([0x100000200n, 0x100000300n]),
      dylinkerCommand(),
      buildVersion(),
    ],
  });

  for (const [name, bytes, reason] of [
    ['filesize > vmsize', filesizeTooLarge, /filesize_exceeds/u],
    ['LC_VERSION_MIN cmdsize != 16', badVersionMin, /version_command/u],
    ['LC_BUILD_VERSION cmdsize != 24+8*ntools', badBuildVersion, /build_version/u],
    ['conflicting repeated LC_UNIXTHREAD triples', conflictingPcs, /conflicting/u],
  ]) {
    const result = __testing.classifyMachoBytes(bytes, { arch: 'arm64' });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, reason, name);
  }
  const repeated = __testing.classifyMachoBytes(equalPcs, { arch: 'arm64' });
  assert.equal(repeated.ok, true, repeated.reason);
});

test('sizeofcmds=8160 and maximum fat-architecture table fit the bounded schedule', async (t) => {
  const { __testing, classifyPosixExecutableType } = await runtimePromise;
  const filler = Buffer.alloc(8008);
  filler.writeUInt32LE(0x77777777, 0);
  filler.writeUInt32LE(filler.length, 4);
  const boundary = thinMacho({
    fileSize: 8192,
    commands: [
      segment64({ vmsize: 8192n, filesize: 8192n }),
      lcMain(),
      dylinkerCommand(),
      buildVersion(),
      filler,
    ],
  });
  const maximumFatTable = fatMachoTable();
  assert.equal(__testing.classifyMachoBytes(boundary, { arch: 'arm64' }).ok, true);
  assert.equal(__testing.classifyMachoBytes(maximumFatTable, { arch: 'arm64' }).ok, true);

  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.diagnostic('production bounded-read polarity requires macOS arm64');
    return;
  }
  const root = workspace('bounded-metadata');
  const boundaryPath = executable(root, 'sizeofcmds-8160', boundary);
  const fatPath = executable(root, 'maximum-fat-table', maximumFatTable);
  const boundaryResult = classifyPosixExecutableType(boundaryPath);
  const fatResult = classifyPosixExecutableType(fatPath);
  assert.equal(boundaryResult.ok, true, boundaryResult.reason);
  assert.equal(fatResult.ok, true, fatResult.reason);
});

test('pointer-auth discovery admits the local raw arm64e version authority', async (t) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('ARM64 pointer-auth discovery is macOS arm64-specific');
    return;
  }
  const { discoverArm64PointerAuthVersion } = await runtimePromise;
  assert.deepEqual(discoverArm64PointerAuthVersion(), {
    ok: true,
    status: 'present',
    accepted_versions: [0],
  });
});

test('pointer-auth discovery combines missing, none, equal, and conflicting observations', async () => {
  const root = workspace('pointer-auth-outcomes');
  const none = executable(root, 'none', thinMacho({ subtype: 0 }));
  const version0a = executable(root, 'version-0-a', thinMacho({ subtype: 0x80000002 }));
  const version0b = executable(root, 'version-0-b', thinMacho({ subtype: 0x80000002 }));
  const version1 = executable(root, 'version-1', thinMacho({ subtype: 0x81000002 }));
  const malformed = executable(root, 'malformed', Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  const { __testing } = await runtimePromise;
  const discover = __testing.discoverArm64PointerAuthVersionFromPaths;
  assert.equal(typeof discover, 'function');

  assert.deepEqual(discover([malformed, malformed]), {
    ok: false, reason: 'pointer_auth_version_missing',
  });
  assert.deepEqual(discover([malformed, version0a]), {
    ok: true, status: 'present', accepted_versions: [0],
  });
  assert.deepEqual(discover([none, version0a]), {
    ok: true, status: 'present', accepted_versions: [0],
  });
  assert.deepEqual(discover([version0a, version0b]), {
    ok: true, status: 'present', accepted_versions: [0],
  });
  assert.deepEqual(discover([version0a, version1]), {
    ok: false, reason: 'pointer_auth_version_conflict',
  });
});

test('native-loader profile rejects missing platform, no executable segment, foreign subtype, and incompatible pointer-auth', async () => {
  const { __testing } = await runtimePromise;
  const missingPlatform = thinMacho({
    filetype: 7,
    commands: [segment64(), unixThread(), dylinkerCommand(0xf)],
  });
  const noExecutableSegment = thinMacho({
    filetype: 7,
    commands: [segment64({ initprot: 1 }), unixThread(), dylinkerCommand(0xf), buildVersion()],
  });
  const foreignSubtype = thinMacho({
    subtype: 9,
    filetype: 7,
    commands: [segment64(), unixThread(), dylinkerCommand(0xf), buildVersion()],
  });
  const incompatiblePointerAuth = thinMacho({
    subtype: 0x81000002,
    filetype: 7,
    commands: [segment64(), unixThread(), dylinkerCommand(0xf), buildVersion()],
  });
  for (const [name, bytes, reason] of [
    ['missing-platform', missingPlatform, /native_loader_structure/u],
    ['no-executable-segment', noExecutableSegment, /native_loader_structure/u],
    ['foreign-subtype', foreignSubtype, /subtype/u],
    ['incompatible-pointer-auth', incompatiblePointerAuth, /subtype/u],
  ]) {
    const result = __testing.classifyMachoBytes(bytes, {
      arch: 'arm64', purpose: 'native-loader', acceptedPointerAuthVersions: [0],
    });
    assert.equal(result.ok, false, name);
    assert.match(result.reason, reason, name);
  }
});

test('64-bit load commands require eight-byte alignment and 32-bit ones require four', async () => {
  const { __testing } = await runtimePromise;
  const misaligned64 = thinMacho({
    commands: [segment64(), lcMain(), dylinkerCommand(), buildVersion(), unknownLoadCommand(12)],
  });
  const aligned64 = thinMacho({
    commands: [segment64(), lcMain(), dylinkerCommand(), buildVersion(), unknownLoadCommand(16)],
  });
  const misaligned32 = thinMacho32({
    commands: [segment32(), lcMain(), dylinkerCommand(), unknownLoadCommand(10)],
  });
  const aligned32 = thinMacho32({
    commands: [segment32(), lcMain(), dylinkerCommand(), unknownLoadCommand(12)],
  });

  for (const [name, bytes, options] of [
    ['thin arm64 twelve-byte load command', misaligned64, { arch: 'arm64' }],
    ['fat-wrapped arm64 twelve-byte load command', fatMacho(misaligned64), { arch: 'arm64' }],
    ['thin i386 ten-byte load command', misaligned32, { arch: 'ia32' }],
  ]) {
    const result = __testing.classifyMachoBytes(bytes, options);
    assert.equal(result.ok, false, name);
    assert.match(result.reason, /invalid_macho_load_command$/u, name);
  }
  const wide = __testing.classifyMachoBytes(aligned64, { arch: 'arm64' });
  assert.equal(wide.ok, true, wide.reason);
  const narrow = __testing.classifyMachoBytes(aligned32, { arch: 'ia32' });
  assert.equal(narrow.ok, true, narrow.reason);
});

test('fat compatible-slice grading is ARM64E then V8 then ALL with lowest-index ties', async () => {
  const { __testing } = await runtimePromise;
  const graded = __testing.classifyMachoBytes(
    fatArm64Slices([0, 1, 0x80000002]),
    { arch: 'arm64', acceptedPointerAuthVersions: [0] },
  );
  assert.equal(graded.ok, true, graded.reason);
  assert.equal(graded.macho.cpu_subtype, 0x80000002);
  assert.equal(graded.macho.fat_arch_index, 2);

  const tie = __testing.classifyMachoBytes(
    fatArm64Slices([0x80000002, 0x80000002]),
    { arch: 'arm64', acceptedPointerAuthVersions: [0] },
  );
  assert.equal(tie.ok, true, tie.reason);
  assert.equal(tie.macho.fat_arch_index, 0);
});
