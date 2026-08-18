import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import {
  delimiter,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const CMD_META_CHARACTERS = /([()\][!^"`<>&|;, *?])/g;
const CMD_LITERAL_PERCENT_ENV = 'DEEP_REVIEW_CMD_LITERAL_PERCENT_4BFE8C1A';
const POSIX_TERMINATION_GRACE_MS = 100;
const POSIX_GROUP_EXIT_POLL_MS = 10;
// A stuck process group must not keep a caller alive forever. This limit starts
// after SIGKILL; timing out reports that cleanup could not be confirmed.
const POSIX_GROUP_EXIT_HARD_DEADLINE_MS = 1000;
const POSIX_GROUP_EXIT_UNCONFIRMED_DIAGNOSTIC =
  'POSIX process group remained after SIGKILL; cleanup could not be confirmed before the hard deadline\n';
const WINDOWS_TASKKILL_FALLBACK_DIAGNOSTIC =
  'Windows taskkill failed; sent direct SIGKILL fallback\n';
const WINDOWS_BATCH_UNSAFE_ARGUMENT_DIAGNOSTIC =
  'Windows batch arguments containing quotes or line breaks require a sibling PowerShell shim\n';
const POSIX_EXECUTABLE_PREFIX_BYTES = 256;
const POSIX_EXECUTABLE_METADATA_BYTES = 8192;
const POSIX_EXECUTABLE_MAX_READS = 3;
const POSIX_ENV_NAME = /^[A-Za-z0-9._+][A-Za-z0-9._+-]*$/u;
const CLASSIFICATION_PURPOSES = new Set(['effective-executable', 'native-loader']);

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const MACHO_THIN_32_MAGIC = Buffer.from([0xce, 0xfa, 0xed, 0xfe]);
const MACHO_THIN_64_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const MACHO_THIN_32_FOREIGN_MAGIC = Buffer.from([0xfe, 0xed, 0xfa, 0xce]);
const MACHO_THIN_64_FOREIGN_MAGIC = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]);
const MACHO_FAT_32_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
const MACHO_FAT_64_MAGIC = Buffer.from([0xca, 0xfe, 0xba, 0xbf]);
const MACHO_FAT_32_FOREIGN_MAGIC = Buffer.from([0xbe, 0xba, 0xfe, 0xca]);
const MACHO_FAT_64_FOREIGN_MAGIC = Buffer.from([0xbf, 0xba, 0xfe, 0xca]);

const CPU_TYPES = Object.freeze({
  x64: 0x01000007,
  arm64: 0x0100000c,
  ia32: 7,
  arm: 12,
});
const ELF_MACHINES = Object.freeze({ x64: 62, arm64: 183, ia32: 3, arm: 40 });

class ClassificationError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function reject(reason) {
  return { ok: false, reason };
}

function startsWith(buffer, prefix) {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (!value || typeof value !== 'object') throw new TypeError('unsupported canonical JSON value');
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`,
  ).join(',')}}`;
}

function bigintToSafeNumber(value, reason) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ClassificationError(reason);
  return Number(value);
}

function checkedRange(start, size, limit, reason) {
  if (start < 0n || size < 0n) throw new ClassificationError(reason);
  const end = start + size;
  if (end < start || end > limit) throw new ClassificationError(reason);
  return end;
}

class BoundedFileReader {
  constructor(filePath) {
    this.fd = openSync(filePath, 'r');
    try {
      const stat = fstatSync(this.fd, { bigint: true });
      if (!stat.isFile()) throw new ClassificationError('not_regular_file');
      this.sizeBigInt = stat.size;
      this.size = bigintToSafeNumber(stat.size, 'file_too_large');
      this.reads = 0;
      this.prefix = this.#readFromFile(0, Math.min(this.size, POSIX_EXECUTABLE_PREFIX_BYTES));
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }

  #readFromFile(offset, length) {
    if (this.reads >= POSIX_EXECUTABLE_MAX_READS) {
      throw new ClassificationError('executable_metadata_read_budget_exceeded');
    }
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 0 || length > POSIX_EXECUTABLE_METADATA_BYTES
        || offset + length > this.size) {
      throw new ClassificationError('invalid_executable_metadata_range');
    }
    const buffer = Buffer.alloc(length);
    let consumed = 0;
    while (consumed < length) {
      const count = readSync(this.fd, buffer, consumed, length - consumed, offset + consumed);
      if (count === 0) throw new ClassificationError('truncated_executable_metadata');
      consumed += count;
    }
    this.reads += 1;
    return buffer;
  }

  read(offset, length) {
    if (offset >= 0 && length >= 0 && offset + length <= this.prefix.length) {
      return this.prefix.subarray(offset, offset + length);
    }
    return this.#readFromFile(offset, length);
  }

  close() {
    closeSync(this.fd);
  }
}

class BufferReader {
  constructor(bytes) {
    this.bytes = Buffer.from(bytes);
    this.size = this.bytes.length;
    this.sizeBigInt = BigInt(this.size);
    this.prefix = this.bytes.subarray(0, POSIX_EXECUTABLE_PREFIX_BYTES);
  }

  read(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 0 || offset + length > this.size) {
      throw new ClassificationError('invalid_executable_metadata_range');
    }
    return this.bytes.subarray(offset, offset + length);
  }

  close() {}
}

function purposeForMemberPosition(position) {
  switch (position) {
    case 'launcher':
    case 'shebang-interpreter':
    case 'path-target':
      return 'effective-executable';
    case 'native-loader':
      return 'native-loader';
    default:
      throw new ClassificationError('unknown_prepared_chain_member_position');
  }
}

function validatePurpose(purpose) {
  if (!CLASSIFICATION_PURPOSES.has(purpose)) {
    throw new ClassificationError('invalid_classification_purpose');
  }
}

function hostCpuType(arch) {
  const value = CPU_TYPES[arch];
  if (value === undefined) throw new ClassificationError('unsupported_host_cpu');
  return value;
}

function hostElfMachine(arch) {
  const value = ELF_MACHINES[arch];
  if (value === undefined) throw new ClassificationError('unsupported_host_cpu');
  return value;
}

function readUInt64(buffer, offset, littleEndian, reason) {
  if (offset < 0 || offset + 8 > buffer.length) throw new ClassificationError(reason);
  return littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
}

function readUInt32(buffer, offset, littleEndian, reason) {
  if (offset < 0 || offset + 4 > buffer.length) throw new ClassificationError(reason);
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readInt32(buffer, offset, littleEndian, reason) {
  if (offset < 0 || offset + 4 > buffer.length) throw new ClassificationError(reason);
  return littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset);
}

function machoSubtype(rawSubtype, arch, acceptedPointerAuthVersions, discovery = false) {
  const raw = rawSubtype >>> 0;
  const base = raw & 0x00ffffff;
  const capabilities = (raw & 0xff000000) >>> 0;
  if (arch === 'arm64') {
    if (base !== 0 && base !== 1 && base !== 2) return null;
    if (base !== 2 && capabilities !== 0) return null;
    if (base === 2) {
      const unknown = (capabilities & 0x70000000) >>> 0;
      if (unknown !== 0) return null;
      const version = (raw & 0x0f000000) >>> 24;
      if (!discovery && !acceptedPointerAuthVersions?.has(version)) return null;
      return { base, version, grade: 3 };
    }
    return { base, version: null, grade: base === 1 ? 2 : 1 };
  }
  if (arch === 'x64') {
    if (base !== 3 && base !== 8) return null;
    if (capabilities !== 0 && capabilities !== 0x80000000) return null;
    return { base, version: null, grade: base === 8 ? 2 : 1 };
  }
  if (arch === 'ia32') {
    if (capabilities !== 0) return null;
    return base === 3 || base === 4 ? { base, version: null, grade: 1 } : null;
  }
  if (arch === 'arm') {
    if (capabilities !== 0) return null;
    return base <= 11 ? { base, version: null, grade: 1 } : null;
  }
  return null;
}

function exactDylinkerCommand(command, expectedCommand) {
  if (command.length !== 32
      || command.readUInt32LE(0) !== expectedCommand
      || command.readUInt32LE(4) !== 32
      || command.readUInt32LE(8) !== 12) return false;
  const expected = Buffer.alloc(20);
  Buffer.from('/usr/lib/dyld\0', 'utf8').copy(expected);
  return command.subarray(12).equals(expected);
}

function parseUnixThread(command, arch) {
  const expectedFlavor = arch === 'arm64' ? 6 : arch === 'x64' ? 4 : null;
  const expectedCount = arch === 'arm64' ? 68 : arch === 'x64' ? 42 : null;
  const pcOffset = arch === 'arm64' ? 256 : arch === 'x64' ? 128 : null;
  if (expectedFlavor === null) throw new ClassificationError('unsupported_macho_thread_state');
  let cursor = 8;
  let triples = 0;
  const pcs = new Set();
  while (cursor < command.length) {
    if (cursor + 8 > command.length) throw new ClassificationError('invalid_macho_unixthread_layout');
    const flavor = command.readUInt32LE(cursor);
    const count = command.readUInt32LE(cursor + 4);
    const stateBytes = count * 4;
    if (!Number.isSafeInteger(stateBytes) || cursor + 8 + stateBytes > command.length) {
      throw new ClassificationError('invalid_macho_unixthread_layout');
    }
    if (flavor === expectedFlavor) {
      if (count !== expectedCount || pcOffset + 8 > stateBytes) {
        throw new ClassificationError('invalid_macho_unixthread_state');
      }
      const stateStart = cursor + 8;
      pcs.add(command.readBigUInt64LE(stateStart + pcOffset).toString());
    }
    triples += 1;
    cursor += 8 + stateBytes;
  }
  if (cursor !== command.length || triples === 0 || pcs.size === 0) {
    throw new ClassificationError('invalid_macho_unixthread_layout');
  }
  if (pcs.size !== 1) throw new ClassificationError('conflicting_macho_unixthread_pc');
  return BigInt([...pcs][0]);
}

function parseThinMacho(reader, sliceOffset, sliceSize, context, expectedArch = null) {
  const sliceMetadata = sliceOffset + 32 <= reader.prefix.length
    ? reader.read(sliceOffset, Math.min(sliceSize, 32))
    : reader.read(sliceOffset, Math.min(sliceSize, POSIX_EXECUTABLE_METADATA_BYTES));
  const headerPrefix = sliceMetadata.subarray(0, Math.min(sliceMetadata.length, 32));
  const is64 = startsWith(headerPrefix, MACHO_THIN_64_MAGIC);
  const is32 = startsWith(headerPrefix, MACHO_THIN_32_MAGIC);
  if (!is64 && !is32) {
    if (startsWith(headerPrefix, MACHO_THIN_64_FOREIGN_MAGIC)
        || startsWith(headerPrefix, MACHO_THIN_32_FOREIGN_MAGIC)) {
      throw new ClassificationError('foreign_macho_endian');
    }
    throw new ClassificationError('invalid_macho_header');
  }
  const headerSize = is64 ? 32 : 28;
  if (sliceSize < headerSize || headerPrefix.length < headerSize) {
    throw new ClassificationError('truncated_macho_header');
  }
  const cpuType = headerPrefix.readInt32LE(4);
  const rawSubtype = headerPrefix.readUInt32LE(8);
  const filetype = headerPrefix.readUInt32LE(12);
  const ncmds = headerPrefix.readUInt32LE(16);
  const sizeofcmds = headerPrefix.readUInt32LE(20);
  if (cpuType !== hostCpuType(context.arch)) throw new ClassificationError('foreign_macho_cpu');
  if (expectedArch && (cpuType !== expectedArch.cpuType || rawSubtype !== expectedArch.rawSubtype)) {
    throw new ClassificationError('macho_fat_slice_header_mismatch');
  }
  const subtype = machoSubtype(
    rawSubtype,
    context.arch,
    context.acceptedPointerAuthVersions,
    context.discovery,
  );
  if (!subtype) throw new ClassificationError('incompatible_macho_cpu_subtype');
  if (context.purpose === 'effective-executable' && filetype !== 2) {
    throw new ClassificationError('invalid_macho_executable_filetype');
  }
  if (context.purpose === 'native-loader' && filetype !== 7) {
    throw new ClassificationError('invalid_macho_loader_filetype');
  }
  if (ncmds < 1 || ncmds > 128
      || sizeofcmds < ncmds * 8 || sizeofcmds > 8160
      || headerSize + sizeofcmds > sliceSize) {
    throw new ClassificationError('invalid_macho_load_command_table');
  }
  const image = headerSize + sizeofcmds <= sliceMetadata.length
    ? sliceMetadata.subarray(0, headerSize + sizeofcmds)
    : reader.read(sliceOffset, headerSize + sizeofcmds);
  const commandsEnd = headerSize + sizeofcmds;
  let cursor = headerSize;
  let mainCount = 0;
  let unixThreadCount = 0;
  let loadDylinkerCount = 0;
  let idDylinkerCount = 0;
  let platformCount = 0;
  let entryoff = null;
  const threadPcs = [];
  const segments = [];

  for (let index = 0; index < ncmds; index += 1) {
    if (cursor + 8 > commandsEnd) throw new ClassificationError('invalid_macho_load_command_table');
    const commandType = image.readUInt32LE(cursor);
    const commandSize = image.readUInt32LE(cursor + 4);
    if (commandSize < 8 || commandSize % 4 !== 0 || cursor + commandSize > commandsEnd) {
      throw new ClassificationError('invalid_macho_load_command');
    }
    const command = image.subarray(cursor, cursor + commandSize);
    if (commandType === 0x19) {
      if (!is64 || commandSize < 72) throw new ClassificationError('invalid_macho_segment');
      const nsects = command.readUInt32LE(64);
      if (commandSize !== 72 + nsects * 80) throw new ClassificationError('invalid_macho_segment');
      const vmaddr = command.readBigUInt64LE(24);
      const vmsize = command.readBigUInt64LE(32);
      const fileoff = command.readBigUInt64LE(40);
      const filesize = command.readBigUInt64LE(48);
      const initprot = command.readInt32LE(60);
      if (filesize > vmsize) throw new ClassificationError('macho_filesize_exceeds_vmsize');
      const fileEnd = checkedRange(fileoff, filesize, BigInt(sliceSize), 'invalid_macho_segment_file_range');
      const vmEnd = checkedRange(vmaddr, vmsize, 0xffffffffffffffffn, 'invalid_macho_segment_vm_range');
      segments.push({ fileoff, fileEnd, vmaddr, vmEnd, executable: (initprot & 0x4) !== 0 });
    } else if (commandType === 0x1) {
      if (is64 || commandSize < 56) throw new ClassificationError('invalid_macho_segment');
      const nsects = command.readUInt32LE(48);
      if (commandSize !== 56 + nsects * 68) throw new ClassificationError('invalid_macho_segment');
      const vmaddr = BigInt(command.readUInt32LE(24));
      const vmsize = BigInt(command.readUInt32LE(28));
      const fileoff = BigInt(command.readUInt32LE(32));
      const filesize = BigInt(command.readUInt32LE(36));
      const initprot = command.readInt32LE(44);
      if (filesize > vmsize) throw new ClassificationError('macho_filesize_exceeds_vmsize');
      const fileEnd = checkedRange(fileoff, filesize, BigInt(sliceSize), 'invalid_macho_segment_file_range');
      const vmEnd = checkedRange(vmaddr, vmsize, 0xffffffffn, 'invalid_macho_segment_vm_range');
      segments.push({ fileoff, fileEnd, vmaddr, vmEnd, executable: (initprot & 0x4) !== 0 });
    } else if (commandType === 0x80000028) {
      if (commandSize !== 24) throw new ClassificationError('invalid_macho_lc_main');
      mainCount += 1;
      entryoff = command.readBigUInt64LE(8);
    } else if (commandType === 0x5) {
      unixThreadCount += 1;
      threadPcs.push(parseUnixThread(command, context.arch));
    } else if (commandType === 0xe) {
      loadDylinkerCount += 1;
      if (!exactDylinkerCommand(command, 0xe)) throw new ClassificationError('invalid_macho_load_dylinker');
    } else if (commandType === 0xf) {
      idDylinkerCount += 1;
      if (!exactDylinkerCommand(command, 0xf)) throw new ClassificationError('invalid_macho_id_dylinker');
    } else if (commandType === 0x24) {
      if (commandSize !== 16) throw new ClassificationError('invalid_macho_version_command');
      platformCount += 1;
    } else if (commandType === 0x25 || commandType === 0x2f || commandType === 0x30) {
      throw new ClassificationError('foreign_macho_platform');
    } else if (commandType === 0x32) {
      if (commandSize < 24) throw new ClassificationError('invalid_macho_build_version');
      const platform = command.readUInt32LE(8);
      const ntools = command.readUInt32LE(20);
      if (platform !== 1) throw new ClassificationError('foreign_macho_platform');
      if (commandSize !== 24 + ntools * 8) throw new ClassificationError('invalid_macho_build_version');
      platformCount += 1;
    }
    cursor += commandSize;
  }
  if (cursor !== commandsEnd) throw new ClassificationError('invalid_macho_load_command_table');

  if (context.purpose === 'effective-executable') {
    if (!((mainCount === 1 && unixThreadCount === 0)
        || (mainCount === 0 && unixThreadCount === 1))) {
      throw new ClassificationError('invalid_macho_entry_command_set');
    }
    if (loadDylinkerCount !== 1 || idDylinkerCount !== 0) {
      throw new ClassificationError('invalid_macho_dylinker_command_set');
    }
    const entry = mainCount === 1 ? entryoff : threadPcs[0];
    const entryMapped = segments.some((segment) => {
      if (!segment.executable) return false;
      return mainCount === 1
        ? entry >= segment.fileoff && entry < segment.fileEnd
        : entry >= segment.vmaddr && entry < segment.vmEnd;
    });
    if (!entryMapped) throw new ClassificationError('macho_entry_outside_executable_mapping');
  } else {
    if (mainCount !== 0 || loadDylinkerCount !== 0 || idDylinkerCount !== 1
        || unixThreadCount < 1 || platformCount < 1
        || !segments.some((segment) => segment.executable)) {
      throw new ClassificationError('invalid_macho_native_loader_structure');
    }
  }

  return {
    ok: true,
    type: 'native-macho',
    classification_purpose: context.purpose,
    native_loader_path: context.purpose === 'effective-executable' ? '/usr/lib/dyld' : null,
    macho: {
      cpu_type: cpuType,
      cpu_subtype: rawSubtype,
      filetype,
      is_64: is64,
      fat_arch_index: expectedArch?.index ?? null,
    },
  };
}

function parseFatArchTable(reader, is64) {
  if (reader.size < 8) throw new ClassificationError('truncated_macho_fat_header');
  const header = reader.read(0, 8);
  const nfatArch = header.readUInt32BE(4);
  const recordSize = is64 ? 32 : 20;
  if (nfatArch < 1 || nfatArch > 16) throw new ClassificationError('invalid_macho_fat_arch_count');
  const tableSize = 8 + nfatArch * recordSize;
  if (tableSize > reader.size) throw new ClassificationError('truncated_macho_fat_arch_table');
  const table = reader.read(0, tableSize);
  const records = [];
  for (let index = 0; index < nfatArch; index += 1) {
    const cursor = 8 + index * recordSize;
    const cpuType = table.readInt32BE(cursor);
    const rawSubtype = table.readUInt32BE(cursor + 4);
    const offsetBig = is64 ? table.readBigUInt64BE(cursor + 8) : BigInt(table.readUInt32BE(cursor + 8));
    const sizeBig = is64 ? table.readBigUInt64BE(cursor + 16) : BigInt(table.readUInt32BE(cursor + 12));
    const align = table.readUInt32BE(cursor + (is64 ? 24 : 16));
    if (align > 31) throw new ClassificationError('invalid_macho_fat_alignment');
    const endBig = checkedRange(offsetBig, sizeBig, reader.sizeBigInt, 'invalid_macho_fat_slice_range');
    const alignment = 1n << BigInt(align);
    if (offsetBig % alignment !== 0n) throw new ClassificationError('invalid_macho_fat_offset_congruence');
    records.push({
      index,
      cpuType,
      rawSubtype,
      offset: bigintToSafeNumber(offsetBig, 'macho_fat_slice_too_large'),
      size: bigintToSafeNumber(sizeBig, 'macho_fat_slice_too_large'),
      offsetBig,
      endBig,
    });
  }
  const byOffset = [...records].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < byOffset.length; index += 1) {
    if (byOffset[index].offsetBig < byOffset[index - 1].endBig) {
      throw new ClassificationError('overlapping_macho_fat_slices');
    }
  }
  return records;
}

function parseMacho(reader, context) {
  const prefix = reader.prefix;
  const thin = startsWith(prefix, MACHO_THIN_32_MAGIC) || startsWith(prefix, MACHO_THIN_64_MAGIC);
  if (thin) return parseThinMacho(reader, 0, reader.size, context);
  if (startsWith(prefix, MACHO_THIN_32_FOREIGN_MAGIC)
      || startsWith(prefix, MACHO_THIN_64_FOREIGN_MAGIC)
      || startsWith(prefix, MACHO_FAT_32_FOREIGN_MAGIC)
      || startsWith(prefix, MACHO_FAT_64_FOREIGN_MAGIC)) {
    throw new ClassificationError('foreign_macho_endian');
  }
  const fat64 = startsWith(prefix, MACHO_FAT_64_MAGIC);
  const fat32 = startsWith(prefix, MACHO_FAT_32_MAGIC);
  if (!fat32 && !fat64) throw new ClassificationError('unrecognized_posix_executable');
  const records = parseFatArchTable(reader, fat64);
  const candidates = records
    .filter((record) => record.cpuType === hostCpuType(context.arch))
    .map((record) => ({
      ...record,
      subtype: machoSubtype(
        record.rawSubtype,
        context.arch,
        context.acceptedPointerAuthVersions,
        context.discovery,
      ),
    }))
    .filter((record) => record.subtype)
    .sort((left, right) => right.subtype.grade - left.subtype.grade || left.index - right.index);
  if (candidates.length === 0) throw new ClassificationError('no_compatible_macho_fat_slice');
  const selected = candidates[0];
  return parseThinMacho(reader, selected.offset, selected.size, context, selected);
}

function parseElf(reader, context) {
  const prefix = reader.prefix;
  if (prefix.length < 16 || !startsWith(prefix, ELF_MAGIC)) {
    throw new ClassificationError('invalid_elf_header');
  }
  const elfClass = prefix[4];
  const expectedClass = context.arch === 'x64' || context.arch === 'arm64' ? 2 : 1;
  if (elfClass !== expectedClass) throw new ClassificationError('foreign_elf_class');
  if (prefix[5] !== 1) throw new ClassificationError('foreign_elf_endian');
  if (prefix[6] !== 1) throw new ClassificationError('invalid_elf_ident_version');
  const is64 = elfClass === 2;
  const headerSize = is64 ? 64 : 52;
  if (reader.size < headerSize) throw new ClassificationError('truncated_elf_header');
  const header = reader.read(0, headerSize);
  const type = header.readUInt16LE(16);
  const machine = header.readUInt16LE(18);
  const version = header.readUInt32LE(20);
  const entry = is64 ? header.readBigUInt64LE(24) : BigInt(header.readUInt32LE(24));
  const phoff = is64 ? header.readBigUInt64LE(32) : BigInt(header.readUInt32LE(28));
  const ehsize = header.readUInt16LE(is64 ? 52 : 40);
  const phentsize = header.readUInt16LE(is64 ? 54 : 42);
  const phnum = header.readUInt16LE(is64 ? 56 : 44);
  const expectedPhent = is64 ? 56 : 32;
  if ((type !== 2 && type !== 3) || machine !== hostElfMachine(context.arch) || version !== 1) {
    throw new ClassificationError('invalid_elf_type_or_cpu');
  }
  if (ehsize !== headerSize || phentsize !== expectedPhent || phnum < 1 || phnum > 128) {
    throw new ClassificationError('invalid_elf_program_header_table');
  }
  const tableSizeBig = BigInt(phnum) * BigInt(phentsize);
  checkedRange(phoff, tableSizeBig, reader.sizeBigInt, 'invalid_elf_program_header_table');
  if (tableSizeBig > BigInt(POSIX_EXECUTABLE_METADATA_BYTES)) {
    throw new ClassificationError('invalid_elf_program_header_table');
  }
  const table = reader.read(
    bigintToSafeNumber(phoff, 'invalid_elf_program_header_table'),
    bigintToSafeNumber(tableSizeBig, 'invalid_elf_program_header_table'),
  );
  let loadCount = 0;
  let executableMapping = false;
  const interpreterHeaders = [];
  for (let index = 0; index < phnum; index += 1) {
    const cursor = index * phentsize;
    const phType = table.readUInt32LE(cursor);
    const flags = is64 ? table.readUInt32LE(cursor + 4) : table.readUInt32LE(cursor + 24);
    const offset = is64 ? table.readBigUInt64LE(cursor + 8) : BigInt(table.readUInt32LE(cursor + 4));
    const vaddr = is64 ? table.readBigUInt64LE(cursor + 16) : BigInt(table.readUInt32LE(cursor + 8));
    const filesz = is64 ? table.readBigUInt64LE(cursor + 32) : BigInt(table.readUInt32LE(cursor + 16));
    const memsz = is64 ? table.readBigUInt64LE(cursor + 40) : BigInt(table.readUInt32LE(cursor + 20));
    const align = is64 ? table.readBigUInt64LE(cursor + 48) : BigInt(table.readUInt32LE(cursor + 28));
    if (phType === 1 || phType === 3 || phType === 6) {
      checkedRange(offset, filesz, reader.sizeBigInt, 'invalid_elf_program_file_range');
    }
    if (phType === 1) {
      loadCount += 1;
      if (filesz > memsz) throw new ClassificationError('elf_filesize_exceeds_memsize');
      if (align !== 0n && align !== 1n && (align & (align - 1n)) !== 0n) {
        throw new ClassificationError('invalid_elf_alignment');
      }
      if (align > 1n && vaddr % align !== offset % align) {
        throw new ClassificationError('invalid_elf_virtual_file_congruence');
      }
      const vmEnd = checkedRange(vaddr, memsz, 0xffffffffffffffffn, 'invalid_elf_virtual_range');
      if ((flags & 0x1) !== 0 && entry >= vaddr && entry < vmEnd) executableMapping = true;
    } else if (phType === 3) {
      interpreterHeaders.push({ offset, filesz });
    }
  }
  if (loadCount === 0) throw new ClassificationError('missing_elf_load_segment');
  if (!executableMapping) throw new ClassificationError('elf_entry_outside_executable_mapping');
  if (interpreterHeaders.length > 1) throw new ClassificationError('multiple_elf_interpreters');
  let nativeLoaderPath = null;
  if (interpreterHeaders.length === 1) {
    if (context.purpose === 'native-loader') throw new ClassificationError('nested_elf_native_loader');
    const [{ offset, filesz }] = interpreterHeaders;
    if (filesz < 2n || filesz > 4096n) throw new ClassificationError('invalid_elf_interpreter');
    const bytes = reader.read(
      bigintToSafeNumber(offset, 'invalid_elf_interpreter'),
      bigintToSafeNumber(filesz, 'invalid_elf_interpreter'),
    );
    if (bytes.at(-1) !== 0 || bytes.subarray(0, -1).includes(0) || bytes[0] !== 0x2f) {
      throw new ClassificationError('invalid_elf_interpreter');
    }
    try {
      nativeLoaderPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1));
    } catch {
      throw new ClassificationError('invalid_elf_interpreter');
    }
  }
  return {
    ok: true,
    type: 'native-elf',
    classification_purpose: context.purpose,
    native_loader_path: nativeLoaderPath,
  };
}

function observeArm64PointerAuth(filePath) {
  let validationReader;
  let reader;
  try {
    validationReader = new BoundedFileReader(filePath);
    parseMacho(validationReader, {
      arch: 'arm64',
      purpose: 'effective-executable',
      acceptedPointerAuthVersions: new Set(),
      discovery: true,
    });
    validationReader.close();
    validationReader = null;
    reader = new BoundedFileReader(filePath);
    const prefix = reader.prefix;
    const rawSubtypes = [];
    if (startsWith(prefix, MACHO_THIN_64_MAGIC) || startsWith(prefix, MACHO_THIN_32_MAGIC)) {
      const headerSize = startsWith(prefix, MACHO_THIN_64_MAGIC) ? 32 : 28;
      const header = reader.read(0, headerSize);
      if (header.readInt32LE(4) !== CPU_TYPES.arm64) return { status: 'missing' };
      rawSubtypes.push(header.readUInt32LE(8));
    } else if (startsWith(prefix, MACHO_FAT_32_MAGIC) || startsWith(prefix, MACHO_FAT_64_MAGIC)) {
      const records = parseFatArchTable(reader, startsWith(prefix, MACHO_FAT_64_MAGIC));
      rawSubtypes.push(...records.filter((record) => record.cpuType === CPU_TYPES.arm64)
        .map((record) => record.rawSubtype));
      if (rawSubtypes.length === 0) return { status: 'missing' };
    } else {
      return { status: 'missing' };
    }
    const versions = new Set();
    for (const rawSubtype of rawSubtypes) {
      const hasPointerAuth = (rawSubtype & 0x80000000) !== 0
        || (rawSubtype & 0x0f000000) !== 0;
      if (hasPointerAuth) versions.add((rawSubtype & 0x0f000000) >>> 24);
    }
    if (versions.size > 1) return { status: 'conflict' };
    if (versions.size === 0) return { status: 'none' };
    return { status: 'version', version: [...versions][0] };
  } catch {
    return { status: 'missing' };
  } finally {
    validationReader?.close();
    reader?.close();
  }
}

function discoverArm64PointerAuthVersionFromPaths(
  paths,
  { platform = process.platform, arch = process.arch } = {},
) {
  if (platform !== 'darwin' || arch !== 'arm64') {
    return { ok: true, status: 'not_applicable', accepted_versions: [] };
  }
  const observations = paths.map(observeArm64PointerAuth);
  if (observations.some((observation) => observation.status === 'conflict')) {
    return reject('pointer_auth_version_conflict');
  }
  const present = observations.filter((observation) => observation.status !== 'missing');
  if (present.length === 0) return reject('pointer_auth_version_missing');
  const versions = new Set(
    present.filter((observation) => observation.status === 'version')
      .map((observation) => observation.version),
  );
  if (versions.size > 1) return reject('pointer_auth_version_conflict');
  return {
    ok: true,
    status: versions.size === 0 ? 'none' : 'present',
    accepted_versions: [...versions].sort((left, right) => left - right),
  };
}

export function discoverArm64PointerAuthVersion() {
  return discoverArm64PointerAuthVersionFromPaths([process.execPath, '/usr/bin/env']);
}

function classifyNativeFile(filePath, position) {
  const purpose = purposeForMemberPosition(position);
  validatePurpose(purpose);
  if (IS_WINDOWS) return reject('unsupported_posix_platform');
  let reader;
  try {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
      throw new ClassificationError('executable_path_must_be_absolute');
    }
    const normalizedPath = normalize(filePath);
    const stat = statSync(normalizedPath);
    if (!stat.isFile()) throw new ClassificationError('not_regular_file');
    accessSync(normalizedPath, constants.X_OK);
    reader = new BoundedFileReader(normalizedPath);
    const prefix = reader.prefix;
    if (prefix.length === 0) throw new ClassificationError('empty_file');
    if (prefix[0] === 0x23 && prefix[1] === 0x21) {
      if (purpose !== 'effective-executable') throw new ClassificationError('nested_shebang');
      return { ok: true, type: 'shebang', classification_purpose: purpose, native_loader_path: null };
    }
    if (process.platform === 'linux') {
      if (startsWith(prefix, MACHO_THIN_32_MAGIC) || startsWith(prefix, MACHO_THIN_64_MAGIC)
          || startsWith(prefix, MACHO_FAT_32_MAGIC) || startsWith(prefix, MACHO_FAT_64_MAGIC)) {
        throw new ClassificationError('foreign_platform_macho');
      }
      const result = parseElf(reader, { arch: process.arch, purpose });
      if (result.native_loader_path) {
        const loader = classifyNativeFile(result.native_loader_path, 'native-loader');
        if (!loader.ok || loader.type !== 'native-elf') {
          throw new ClassificationError('invalid_elf_native_loader');
        }
      }
      return result;
    }
    if (process.platform === 'darwin') {
      if (startsWith(prefix, ELF_MAGIC)) throw new ClassificationError('foreign_platform_elf');
      const discovery = discoverArm64PointerAuthVersion();
      if (!discovery.ok) throw new ClassificationError(discovery.reason);
      const result = parseMacho(reader, {
        arch: process.arch,
        purpose,
        acceptedPointerAuthVersions: new Set(discovery.accepted_versions),
        discovery: false,
      });
      if (result.native_loader_path) {
        const loader = classifyNativeFile(result.native_loader_path, 'native-loader');
        if (!loader.ok || loader.type !== 'native-macho') {
          throw new ClassificationError('invalid_macho_native_loader');
        }
      }
      return result;
    }
    throw new ClassificationError('unsupported_posix_platform');
  } catch (error) {
    return reject(error instanceof ClassificationError ? error.reason : 'unreadable_file');
  } finally {
    reader?.close();
  }
}

export function classifyPosixExecutableType(filePath) {
  if (arguments.length !== 1) return reject('caller_controlled_classification_purpose');
  return classifyNativeFile(filePath, 'launcher');
}

function envPathResolution(name, env, cwd) {
  if (IS_WINDOWS || typeof name !== 'string' || !POSIX_ENV_NAME.test(name)) {
    return reject('invalid_env_path_name');
  }
  const pathValue = environmentValue(env, 'PATH');
  if (typeof pathValue !== 'string' || pathValue.length === 0) return reject('invalid_env_path');
  const effectiveCwd = cwd === undefined ? process.cwd() : cwd;
  if (typeof effectiveCwd !== 'string' || !isAbsolute(resolve(effectiveCwd))) {
    return reject('invalid_spawn_cwd');
  }
  const directories = pathValue.split(delimiter);
  if (directories.length === 0 || directories.some(
    (directory) => directory.length === 0 || !isAbsolute(directory),
  )) return reject('invalid_env_path');
  for (const directory of directories) {
    const candidate = join(normalize(directory), name);
    if (isExecutableFile(candidate)) return { ok: true, path: candidate };
  }
  return reject('env_path_target_not_found');
}

export function resolveEnvPathTarget(name, env = process.env, cwd = process.cwd()) {
  const result = envPathResolution(name, env, cwd);
  return result.ok ? result.path : null;
}

function readShebangLine(filePath) {
  let reader;
  try {
    reader = new BoundedFileReader(filePath);
    const prefix = reader.prefix;
    if (prefix[0] !== 0x23 || prefix[1] !== 0x21) return reject('missing_shebang');
    const newline = prefix.indexOf(0x0a);
    if (newline < 0 && reader.size > prefix.length) return reject('truncated_shebang');
    const lineBytes = prefix.subarray(0, newline < 0 ? prefix.length : newline);
    if (lineBytes.includes(0) || lineBytes.some((byte) => byte > 0x7f || byte === 0x0d)) {
      return reject('unsupported_shebang');
    }
    return { ok: true, line: lineBytes.toString('ascii') };
  } catch {
    return reject('unreadable_shebang');
  } finally {
    reader?.close();
  }
}

export function parsePosixShebang(filePath, env = process.env, cwd = process.cwd()) {
  if (IS_WINDOWS) return reject('unsupported_posix_platform');
  const read = readShebangLine(filePath);
  if (!read.ok) return read;
  const envMatch = read.line.match(/^#! *\/usr\/bin\/env +([A-Za-z0-9._+][A-Za-z0-9._+-]*)$/u);
  if (envMatch) {
    const target = envPathResolution(envMatch[1], env, cwd);
    if (!target.ok) return target;
    if (!isExecutableFile('/usr/bin/env')) return reject('env_interpreter_unavailable');
    return {
      ok: true,
      shebang_form: 'env-path',
      interpreter_path: '/usr/bin/env',
      path_target_path: target.path,
    };
  }
  const absoluteMatch = read.line.match(/^#! *(\/[^\s"'\\]+)$/u);
  if (absoluteMatch) {
    const interpreterPath = normalize(absoluteMatch[1]);
    if (interpreterPath === '/usr/bin/env' || interpreterPath === '/bin/env') {
      return reject('unsupported_shebang');
    }
    if (!isExecutableFile(interpreterPath)) return reject('shebang_interpreter_unavailable');
    return {
      ok: true,
      shebang_form: 'absolute',
      interpreter_path: interpreterPath,
      path_target_path: null,
    };
  }
  return reject('unsupported_shebang');
}

function posixIdentity(stat) {
  return {
    kind: 'posix-dev-ino-v1',
    fields: {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      type: 'regular-file',
      uid: stat.uid.toString(),
    },
  };
}

function windowsIdentity(stat, realPath) {
  return {
    kind: 'win32-file-id-v1',
    fields: {
      final_path: realPath,
      volume: stat.dev.toString(),
      file_id: stat.ino.toString(),
    },
  };
}

function sealPreparedMember(filePath, position, classification = null, posix = true) {
  const selectedPath = normalize(resolve(filePath));
  const realPath = normalize(realpathSync(selectedPath));
  const fd = openSync(realPath, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new ClassificationError('not_regular_file');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const currentRealPath = normalize(realpathSync(selectedPath));
    const current = statSync(currentRealPath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mode !== after.mode || before.uid !== after.uid
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
        || before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size
        || before.mode !== current.mode || before.uid !== current.uid
        || before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs
        || currentRealPath !== realPath) {
      throw new ClassificationError('prepared_member_changed_during_seal');
    }
    const purpose = posix ? purposeForMemberPosition(position) : null;
    if (posix && classification?.classification_purpose !== purpose) {
      throw new ClassificationError('member_inconsistent_classification_purpose');
    }
    return {
      path: selectedPath,
      real_path: realPath,
      platform_identity: posix ? posixIdentity(before) : windowsIdentity(before, realPath),
      sha256: sha256(bytes),
      size: bigintToSafeNumber(before.size, 'prepared_member_too_large'),
      classification_purpose: purpose,
    };
  } finally {
    closeSync(fd);
  }
}

function sealNativeLoader(loaderPaths, posix) {
  const paths = [...new Set(loaderPaths.filter(Boolean).map(
    (loaderPath) => normalize(realpathSync(loaderPath)),
  ))];
  if (paths.length === 0) return null;
  if (paths.length !== 1) throw new ClassificationError('conflicting_native_loader');
  const classification = classifyNativeFile(paths[0], 'native-loader');
  if (!classification.ok) throw new ClassificationError(classification.reason);
  return sealPreparedMember(paths[0], 'native-loader', classification, posix);
}

export function prepareSpawnChain(command, args = [], options = {}) {
  try {
    if (typeof command !== 'string' || command.length === 0) {
      throw new ClassificationError('command_must_be_nonempty');
    }
    if (!Array.isArray(args)) throw new ClassificationError('args_must_be_array');
    if (Object.hasOwn(options, 'classification_purpose')
        || Object.hasOwn(options, 'classificationPurpose')
        || Object.hasOwn(options, 'purpose')) {
      throw new ClassificationError('caller_controlled_classification_purpose');
    }
    const env = options.env ?? process.env;
    const cwd = options.cwd === undefined ? process.cwd() : resolve(options.cwd);
    const resolvedLauncher = resolveExecutable(command, env);
    if (!resolvedLauncher) throw new ClassificationError('launcher_not_found');
    const launcherPath = normalize(resolve(resolvedLauncher));
    const prepared = prepareSpawn(command, args.map(String), env);
    if (prepared.rejectedReason) throw new ClassificationError('prepared_spawn_rejected');

    if (IS_WINDOWS) {
      const shimPath = prepared.shimPath;
      const interpreterPath = prepared.interpreterPath;
      if (interpreterPath && (!isAbsolute(interpreterPath) || !isExecutableFile(interpreterPath))) {
        throw new ClassificationError('unsealed_windows_interpreter');
      }
      const chainWithoutHash = {
        schema_version: '1.0',
        prepared_kind: prepared.preparedKind,
        launcher: sealPreparedMember(launcherPath, 'launcher', null, false),
        shim: shimPath ? sealPreparedMember(shimPath, 'shim', null, false) : null,
        interpreter: interpreterPath
          ? sealPreparedMember(interpreterPath, 'interpreter', null, false) : null,
        shebang: null,
        posix_executable_type: null,
        native_loader: null,
      };
      return {
        ok: true,
        prepared,
        prepared_spawn_chain: {
          ...chainWithoutHash,
          chain_sha256: sha256(Buffer.from(canonicalStringify(chainWithoutHash), 'utf8')),
        },
      };
    }

    const launcherClassification = classifyNativeFile(launcherPath, 'launcher');
    if (!launcherClassification.ok) throw new ClassificationError(launcherClassification.reason);
    const launcher = sealPreparedMember(
      launcherPath,
      'launcher',
      launcherClassification,
      true,
    );
    let shebang = null;
    const loaderPaths = [];
    if (launcherClassification.type === 'shebang') {
      const parsed = parsePosixShebang(launcherPath, env, cwd);
      if (!parsed.ok) throw new ClassificationError(parsed.reason);
      const interpreterClassification = classifyNativeFile(
        parsed.interpreter_path,
        'shebang-interpreter',
      );
      if (!interpreterClassification.ok || interpreterClassification.type === 'shebang') {
        throw new ClassificationError(interpreterClassification.reason || 'nested_shebang');
      }
      loaderPaths.push(interpreterClassification.native_loader_path);
      const interpreter = sealPreparedMember(
        parsed.interpreter_path,
        'shebang-interpreter',
        interpreterClassification,
        true,
      );
      let pathTarget = null;
      if (parsed.path_target_path) {
        const targetClassification = classifyNativeFile(parsed.path_target_path, 'path-target');
        if (!targetClassification.ok || targetClassification.type === 'shebang') {
          throw new ClassificationError(targetClassification.reason || 'nested_shebang');
        }
        loaderPaths.push(targetClassification.native_loader_path);
        pathTarget = sealPreparedMember(
          parsed.path_target_path,
          'path-target',
          targetClassification,
          true,
        );
      }
      shebang = {
        shebang_form: parsed.shebang_form,
        interpreter,
        path_target: pathTarget,
      };
    } else {
      loaderPaths.push(launcherClassification.native_loader_path);
    }
    const chainWithoutHash = {
      schema_version: '1.0',
      prepared_kind: 'direct',
      launcher,
      shim: null,
      interpreter: null,
      shebang,
      posix_executable_type: launcherClassification.type,
      native_loader: sealNativeLoader(loaderPaths, true),
    };
    return {
      ok: true,
      prepared,
      prepared_spawn_chain: {
        ...chainWithoutHash,
        chain_sha256: sha256(Buffer.from(canonicalStringify(chainWithoutHash), 'utf8')),
      },
    };
  } catch (error) {
    return reject(error instanceof ClassificationError ? error.reason : 'prepared_chain_failed');
  }
}

export const __testing = Object.freeze({
  discoverArm64PointerAuthVersionFromPaths(paths) {
    return discoverArm64PointerAuthVersionFromPaths(paths, {
      platform: 'darwin',
      arch: 'arm64',
    });
  },
  classifyElfBytes(bytes, { arch = process.arch, purpose = 'effective-executable' } = {}) {
    try {
      validatePurpose(purpose);
      return parseElf(new BufferReader(bytes), { arch, purpose });
    } catch (error) {
      return reject(error instanceof ClassificationError ? error.reason : 'unrecognized_posix_executable');
    }
  },
  classifyMachoBytes(bytes, {
    arch = process.arch,
    purpose = 'effective-executable',
    acceptedPointerAuthVersions = [0],
  } = {}) {
    try {
      validatePurpose(purpose);
      return parseMacho(new BufferReader(bytes), {
        arch,
        purpose,
        acceptedPointerAuthVersions: new Set(acceptedPointerAuthVersions),
        discovery: false,
      });
    } catch (error) {
      return reject(error instanceof ClassificationError ? error.reason : 'unrecognized_posix_executable');
    }
  },
  canonicalStringify,
});

function environmentValue(env, name) {
  if (!IS_WINDOWS) return env[name];

  let value;
  const wanted = name.toLowerCase();
  for (const [key, candidate] of Object.entries(env)) {
    if (key.toLowerCase() === wanted) value = candidate;
  }
  return value;
}

function isExecutableFile(filePath) {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (!IS_WINDOWS) accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(name, env) {
  if (!IS_WINDOWS || extname(name)) return [name];
  const pathExt = environmentValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
  return pathExt
    .split(';')
    .filter(Boolean)
    .map((extension) => `${name}${extension}`);
}

export function resolveExecutable(name, env = process.env) {
  if (typeof name !== 'string' || name.length === 0) return null;

  const hasPathSeparator = name.includes('/') || name.includes('\\');
  const names = executableNames(name, env);
  if (isAbsolute(name) || hasPathSeparator) {
    for (const candidate of names) {
      const filePath = isAbsolute(candidate) ? candidate : resolve(candidate);
      if (isExecutableFile(filePath)) return filePath;
    }
    return null;
  }

  const pathValue = environmentValue(env, 'PATH');
  if (!pathValue) return null;
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/g, '') || '.';
    for (const candidate of names) {
      const filePath = join(directory, candidate);
      if (isExecutableFile(filePath)) return filePath;
    }
  }
  return null;
}

function caretEscapeCmdSyntax(value) {
  return String(value).replace(CMD_META_CHARACTERS, '^$1');
}

function protectLiteralPercent(value) {
  // cmd expands percent variables once. Expanding this reserved variable to
  // a percent after tokenization preserves literal `%NAME%` without a
  // recursive environment-variable expansion pass.
  return String(value).replaceAll('%', `%${CMD_LITERAL_PERCENT_ENV}%`);
}

function escapeCmdArgument(value, nestedBatchLayer = true) {
  let escaped = String(value);
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/g, '$1$1');
  escaped = protectLiteralPercent(`"${escaped}"`);
  escaped = caretEscapeCmdSyntax(escaped);
  if (nestedBatchLayer) escaped = caretEscapeCmdSyntax(escaped);
  return escaped;
}

function buildWindowsBatchCommand(command, args) {
  const shellCommand = [
    escapeCmdArgument(command, false),
    ...args.map((argument) => escapeCmdArgument(argument, false)),
  ].join(' ');
  return `"${shellCommand}"`;
}

function siblingPowerShellShim(filePath) {
  const candidate = filePath.replace(/\.(?:cmd|bat)$/iu, '.ps1');
  return candidate !== filePath && existsSync(candidate) ? candidate : null;
}

export function estimateWindowsBatchCommandUnits(command, args) {
  return buildWindowsBatchCommand(command, args).length;
}

function cmdTransportEnvironment(env) {
  const transported = {};
  const reserved = CMD_LITERAL_PERCENT_ENV.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() !== reserved) transported[key] = value;
  }
  transported[CMD_LITERAL_PERCENT_ENV] = '%';
  return transported;
}

function prepareSpawn(command, args, env) {
  const resolved = resolveExecutable(command, env) || command;
  if (!IS_WINDOWS || !/\.(?:cmd|bat)$/i.test(resolved)) {
    return {
      command: resolved,
      args,
      windowsVerbatimArguments: false,
      preparedKind: 'direct',
      launcherPath: resolved,
      shimPath: null,
      interpreterPath: null,
    };
  }

  const comSpec = environmentValue(env, 'ComSpec')
    || environmentValue(process.env, 'ComSpec')
    || 'cmd.exe';
  const powerShellShim = siblingPowerShellShim(resolved);
  const powerShell = resolveExecutable('pwsh.exe', env)
    || resolveExecutable('powershell.exe', env)
    || resolveExecutable('pwsh.exe', process.env)
    || resolveExecutable('powershell.exe', process.env);
  if (powerShellShim && powerShell) {
    return {
      command: powerShell,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', powerShellShim,
        ...args,
      ],
      windowsVerbatimArguments: false,
      preparedKind: 'powershell-shim',
      launcherPath: resolved,
      shimPath: powerShellShim,
      interpreterPath: powerShell,
    };
  }
  if (args.some((argument) => /["\r\n]/u.test(String(argument)))) {
    return { rejectedReason: WINDOWS_BATCH_UNSAFE_ARGUMENT_DIAGNOSTIC };
  }
  return {
    command: comSpec,
    args: ['/d', '/v:off', '/s', '/c', buildWindowsBatchCommand(resolved, args)],
    env: cmdTransportEnvironment(env),
    windowsVerbatimArguments: true,
    preparedKind: 'comspec-batch',
    launcherPath: resolved,
    shimPath: null,
    interpreterPath: comSpec,
  };
}

function terminateWindowsProcessTree(child, env, appendStderr) {
  if (child.pid) {
    const taskkill = resolveExecutable('taskkill.exe', env) || 'taskkill.exe';
    let fallbackIssued = false;
    const fallback = () => {
      if (fallbackIssued) return;
      fallbackIssued = true;
      appendStderr(Buffer.from(WINDOWS_TASKKILL_FALLBACK_DIAGNOSTIC));
      try {
        child.kill('SIGKILL');
      } catch {
        // The process exited between taskkill failing and direct fallback.
      }
    };
    let killer;
    try {
      killer = spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
        env,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      fallback();
      return;
    }
    killer.once('error', fallback);
    killer.once('close', (code) => {
      if (code !== 0) fallback();
    });
    return;
  }
  child.kill();
}

function signalPosixProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    try {
      child.kill(signal);
    } catch {
      // The process exited between the group signal and direct fallback.
    }
  }
}

function isPosixProcessGroupGone(processGroupId) {
  if (!processGroupId) return false;
  try {
    process.kill(-processGroupId, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

export function runProcess(command, args = [], options = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    return Promise.reject(new TypeError('command must be a non-empty string'));
  }
  if (!Array.isArray(args)) {
    return Promise.reject(new TypeError('args must be an array'));
  }
  const captureLimit = (value, name) => {
    if (value === undefined) return Number.POSITIVE_INFINITY;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
    return value;
  };
  let maxCaptureBytesPerStream;
  let maxCaptureBytesTotal;
  try {
    maxCaptureBytesPerStream = captureLimit(
      options.maxCaptureBytesPerStream,
      'maxCaptureBytesPerStream',
    );
    maxCaptureBytesTotal = captureLimit(
      options.maxCaptureBytesTotal,
      'maxCaptureBytesTotal',
    );
  } catch (error) {
    return Promise.reject(error);
  }

  const env = options.env ?? process.env;
  const prepared = prepareSpawn(command, args.map(String), env);
  if (prepared.rejectedReason) {
    return Promise.resolve({
      code: 2,
      signal: undefined,
      timedOut: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(prepared.rejectedReason),
      captureOverflow: false,
    });
  }
  return new Promise((resolveResult) => {
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let totalBytes = 0;
    let captureOverflow = false;
    let timedOut = false;
    let spawnError;
    let stdinError;
    let settled = false;
    let closeCode;
    let closeSignal;

    const appendCaptured = (chunks, value, streamBytes) => {
      const chunk = Buffer.from(value);
      const allowed = Math.max(0, Math.min(
        chunk.length,
        maxCaptureBytesPerStream - streamBytes,
        maxCaptureBytesTotal - totalBytes,
      ));
      if (allowed < chunk.length) captureOverflow = true;
      if (allowed > 0) {
        chunks.push(Buffer.from(chunk.subarray(0, allowed)));
        totalBytes += allowed;
      }
      return streamBytes + allowed;
    };
    const appendStdout = (chunk) => {
      stdoutBytes = appendCaptured(stdout, chunk, stdoutBytes);
    };
    const appendStderr = (chunk) => {
      stderrBytes = appendCaptured(stderr, chunk, stderrBytes);
    };

    const child = spawn(prepared.command, prepared.args, {
      cwd: options.cwd,
      env: prepared.env || env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      detached: !IS_WINDOWS,
    });

    child.stdout.on('data', appendStdout);
    child.stderr.on('data', appendStderr);
    child.once('error', (error) => {
      spawnError = error;
      timedOut = false;
      finish(127, undefined);
    });
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') {
        stdinError ??= error;
      }
    });

    let timeout;
    let escalation;
    let groupExitWait;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (groupExitWait) clearTimeout(groupExitWait);
      if (spawnError) appendStderr(Buffer.from(`${spawnError.message}\n`));
      if (stdinError) appendStderr(Buffer.from(`stdin error: ${stdinError.code || 'UNKNOWN'}\n`));
      resolveResult({
        code: spawnError ? 127 : (timedOut ? 124 : (code ?? 127)),
        signal,
        timedOut,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        captureOverflow,
      });
    };

    const waitForPosixProcessGroupExit = () => {
      const processGroupId = child.pid;
      if (!processGroupId) {
        appendStderr(Buffer.from(POSIX_GROUP_EXIT_UNCONFIRMED_DIAGNOSTIC));
        finish(closeCode, closeSignal);
        return;
      }

      const deadline = Date.now() + POSIX_GROUP_EXIT_HARD_DEADLINE_MS;
      const pollForExit = () => {
        if (isPosixProcessGroupGone(processGroupId)) {
          finish(closeCode, closeSignal);
          return;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          appendStderr(Buffer.from(POSIX_GROUP_EXIT_UNCONFIRMED_DIAGNOSTIC));
          finish(closeCode, closeSignal);
          return;
        }
        // Keep this timer referenced: resolving before ESRCH would let an
        // awaited caller exit while a detached descendant still survives.
        groupExitWait = setTimeout(
          pollForExit,
          Math.min(POSIX_GROUP_EXIT_POLL_MS, remainingMs),
        );
      };
      pollForExit();
    };

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        if (IS_WINDOWS) {
          terminateWindowsProcessTree(child, env, appendStderr);
          return;
        }

        signalPosixProcessGroup(child, 'SIGTERM');
        escalation = setTimeout(() => {
          signalPosixProcessGroup(child, 'SIGKILL');
          waitForPosixProcessGroupExit();
        }, POSIX_TERMINATION_GRACE_MS);
      }, options.timeoutMs);
      timeout.unref();
    }

    child.once('close', (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      if (!timedOut || IS_WINDOWS) finish(code, signal);
    });

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

export function runProcessSync(command, args = [], options = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('command must be a non-empty string');
  }
  if (!Array.isArray(args)) throw new TypeError('args must be an array');

  const env = options.env ?? process.env;
  const prepared = prepareSpawn(command, args.map(String), env);
  if (prepared.rejectedReason) {
    return {
      code: 2,
      signal: undefined,
      timedOut: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(prepared.rejectedReason),
    };
  }
  const result = spawnSync(prepared.command, prepared.args, {
    cwd: options.cwd,
    env: prepared.env || env,
    input: options.input,
    encoding: null,
    maxBuffer: options.maxBuffer,
    shell: false,
    timeout: options.timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: prepared.windowsVerbatimArguments,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const spawnError = result.error && !timedOut;
  return {
    code: timedOut ? 124 : (spawnError ? 127 : (result.status ?? 127)),
    signal: result.signal,
    timedOut,
    stdout: Buffer.from(result.stdout ?? []),
    stderr: Buffer.concat([
      Buffer.from(result.stderr ?? []),
      spawnError ? Buffer.from(`${result.error.message}\n`) : Buffer.alloc(0),
    ]),
  };
}
