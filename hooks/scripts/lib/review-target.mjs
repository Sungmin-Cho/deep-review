import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  decodeGitPath,
  gitSync,
  splitNul,
} from './git.mjs';
import { isSuspectTextPath } from './text-extensions.mjs';

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 65536;
const BINARY_SNIFF_BYTES = 8192;
const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'target',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  'vendor',
  '.git',
]);

function positiveInteger(value, fallback, name) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return candidate;
}

function normalizeLimits(limits = {}) {
  return {
    maxEntries: positiveInteger(limits.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries'),
    maxBytes: positiveInteger(limits.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes'),
  };
}

function rawPathId(pathBuffer) {
  return pathBuffer.toString('hex');
}

function isExcludedPath(decodedPath) {
  const parts = decodedPath.split(/[\\/]/);
  if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return true;
  const basename = parts.at(-1) ?? decodedPath;
  return (
    basename === '.DS_Store'
    || basename.endsWith('.min.js')
    || basename.endsWith('.lock')
    || /^.*\.generated\..*$/.test(basename)
  );
}

function gitResult(repo, args, { failSoft = false } = {}) {
  const result = gitSync(repo, args);
  if (result.code === 0) return result.stdout;
  if (failSoft) return null;
  const diagnostic = result.stderr.toString('utf8').trim();
  throw new Error(`git ${args.join(' ')} failed${diagnostic ? `: ${diagnostic}` : ''}`);
}

function binaryPathsFor(repo, args) {
  const output = gitResult(repo, ['diff', '-z', '--numstat', '-M', '-C', ...args], {
    failSoft: true,
  });
  const binaries = new Set();
  if (output === null) return binaries;

  const fields = splitNul(output);
  for (let index = 0; index < fields.length;) {
    const field = fields[index];
    index += 1;
    if (field.length === 0) continue;
    const firstTab = field.indexOf(0x09);
    const secondTab = firstTab < 0 ? -1 : field.indexOf(0x09, firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = field.subarray(0, firstTab);
    const deleted = field.subarray(firstTab + 1, secondTab);
    const path = field.subarray(secondTab + 1);
    const binary = added.equals(Buffer.from('-')) && deleted.equals(Buffer.from('-'));

    if (path.length === 0) {
      if (index + 1 >= fields.length) break;
      const newPath = fields[index + 1];
      index += 2;
      if (binary) binaries.add(rawPathId(newPath));
    } else if (binary) {
      binaries.add(rawPathId(path));
    }
  }
  return binaries;
}

function parseNameStatus(output, addRecord) {
  const fields = splitNul(output);
  for (let index = 0; index < fields.length;) {
    const statusField = fields[index];
    index += 1;
    if (statusField.length === 0) continue;
    const statusText = statusField.toString('ascii');
    const status = statusText.slice(0, 1);

    if (status === 'R' || status === 'C') {
      if (index + 1 >= fields.length) {
        throw new Error('truncated rename/copy name-status record');
      }
      const oldPath = fields[index];
      const newPath = fields[index + 1];
      index += 2;
      const record = {
        status,
        path: decodeGitPath(newPath),
        old_path: decodeGitPath(oldPath),
      };
      if (statusText.length > 1) record.score = statusText.slice(1);
      addRecord(newPath, record);
      continue;
    }

    if (index >= fields.length) throw new Error('truncated name-status record');
    const path = fields[index];
    index += 1;
    addRecord(path, { status, path: decodeGitPath(path) });
  }
}

function pathForBinarySniff(repo, rawPath) {
  const decoded = decodeGitPath(rawPath);
  if (isAbsolute(decoded)) return process.platform === 'win32' ? decoded : rawPath;
  if (process.platform === 'win32') return resolve(repo, decoded);
  return Buffer.concat([
    Buffer.from(resolve(repo)),
    Buffer.from(sep),
    rawPath,
  ]);
}

function looksLikeUntrackedBinary(repo, rawPath) {
  let descriptor;
  try {
    const filePath = pathForBinarySniff(repo, rawPath);
    if (!lstatSync(filePath).isFile()) return false;
    descriptor = openSync(filePath, 'r');
    const chunk = Buffer.allocUnsafe(BINARY_SNIFF_BYTES);
    const bytesRead = readSync(descriptor, chunk, 0, chunk.length, 0);
    return chunk.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function filesFromInput(filesFromZ) {
  if (filesFromZ === undefined || filesFromZ === null || filesFromZ === '') {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(filesFromZ)) return filesFromZ;
  if (ArrayBuffer.isView(filesFromZ)) {
    return Buffer.from(filesFromZ.buffer, filesFromZ.byteOffset, filesFromZ.byteLength);
  }
  if (typeof filesFromZ === 'string') {
    if (!existsSync(filesFromZ)) throw new Error(`filesFromZ does not exist: ${filesFromZ}`);
    return readFileSync(filesFromZ);
  }
  throw new TypeError('filesFromZ must be a path, Buffer, or Uint8Array');
}

export function buildChangeFiles(options = {}) {
  const {
    repo = '.',
    changeState,
    reviewBase = '',
    filesFromZ,
    includeBinary = false,
  } = options;
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new TypeError('repo must be a non-empty string');
  }
  if (typeof changeState !== 'string' || changeState.length === 0) {
    throw new TypeError('changeState must be a non-empty string');
  }
  if (changeState === 'clean' && !reviewBase) {
    throw new Error('reviewBase is required for clean state');
  }
  const limits = normalizeLimits(options);
  const rawRecords = new Map();
  const seenPathIds = new Set();
  const omittedBinary = new Map();
  let binaryPaths = new Set();

  // Default path (`includeBinary: false`): suspect text-extension binaries stay
  // as tagged rows; every other binary becomes a builder diagnostic (first
  // delivery wins). `includeBinary: true` keeps original tagging semantics.
  const addRecord = (rawPath, record) => {
    const pathId = rawPathId(rawPath);
    if (seenPathIds.has(pathId)) return;
    if (isExcludedPath(record.path)) return;
    const untrackedFamily = ['untracked', 'initial', 'session', 'non-git'].includes(record.status);
    const fromNumstat = binaryPaths.has(pathId);
    const fromSniff = !fromNumstat && untrackedFamily && looksLikeUntrackedBinary(repo, rawPath);
    const isBinary = fromNumstat || fromSniff;
    if (isBinary && !includeBinary) {
      const classifiedBy = fromNumstat ? 'git-numstat' : 'untracked-nul-sniff';
      const suspect = isSuspectTextPath(record.path)
        || (record.old_path !== undefined && isSuspectTextPath(record.old_path));
      if (suspect) {
        record.is_binary = true;
        record.binary_suspect_reason = 'text-extension';
        record.binary_classified_by = classifiedBy;
      } else {
        const diagnostic = { path: record.path };
        if (record.old_path !== undefined) diagnostic.old_path = record.old_path;
        if (record.score !== undefined) diagnostic.score = record.score;
        diagnostic.status = record.status;
        diagnostic.classified_by = classifiedBy;
        diagnostic.omitted_at = 'builder';
        omittedBinary.set(pathId, Object.freeze(diagnostic));
        seenPathIds.add(pathId); // terminal disposition: first delivery wins
        return;
      }
    }
    if (isBinary) record.is_binary = true;
    const key = Buffer.from(rawPath);
    rawRecords.set(key, record);
    seenPathIds.add(pathId);
  };

  const collectDiff = (args) => {
    binaryPaths = binaryPathsFor(repo, args);
    const output = gitResult(repo, ['diff', '-z', '--name-status', '-M', '-C', ...args]);
    parseNameStatus(output, addRecord);
  };

  switch (changeState) {
    case 'clean':
      collectDiff([`${reviewBase}..HEAD`]);
      break;
    case 'staged':
      collectDiff(['--cached']);
      break;
    case 'unstaged':
      collectDiff([]);
      break;
    case 'mixed':
      collectDiff(['HEAD']);
      break;
    case 'initial': {
      const output = gitResult(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
      for (const path of splitNul(output)) {
        if (path.length > 0) addRecord(path, { status: 'initial', path: decodeGitPath(path) });
      }
      break;
    }
    case 'untracked-only':
    case 'non-git':
      break;
    default:
      throw new Error(`unknown change state: ${changeState}`);
  }

  if (['staged', 'unstaged', 'mixed', 'untracked-only'].includes(changeState)) {
    const output = gitResult(repo, ['ls-files', '-z', '--others', '--exclude-standard']);
    for (const path of splitNul(output)) {
      if (path.length > 0) addRecord(path, { status: 'untracked', path: decodeGitPath(path) });
    }
  }

  for (const path of splitNul(filesFromInput(filesFromZ))) {
    if (path.length === 0) continue;
    addRecord(path, {
      status: changeState === 'non-git' ? 'non-git' : 'session',
      path: decodeGitPath(path),
    });
  }

  const records = [...rawRecords.keys()]
    .sort(Buffer.compare)
    .map((path) => rawRecords.get(path));
  Object.defineProperty(records, 'serializationLimits', {
    value: limits,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  if (omittedBinary.size > 0) {
    const lane = Object.freeze([...omittedBinary.values()]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
    Object.defineProperty(records, 'omittedBinaryRecords', {
      value: lane,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  return records;
}

const BINARY_TRAILER_MAX_RECORDS = 25;
const BINARY_TRAILER_MAX_BYTES = 4096;
// U+007F (DEL), C1 controls (U+0080-U+009F incl. NEL/CSI), U+2028/U+2029,
// and every Bidi_Control code point. All BMP, so \uXXXX escapes suffice.
const DISPLAY_CONTROLS = /[\u007f\u0080-\u009f\u2028\u2029\p{Bidi_Control}]/gu;
const VALID_CLASSIFIERS = new Set(['git-numstat', 'untracked-nul-sniff']);

export function escapeDisplayControls(jsonText) {
  if (typeof jsonText !== 'string') throw new TypeError('jsonText must be a string');
  return jsonText.replace(DISPLAY_CONTROLS,
    (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function laneDigest(entries) {
  if (entries.length === 0) return null;
  const canonical = entries
    .map((entry) => JSON.stringify([
      entry.path, entry.old_path ?? null, entry.status, entry.classified_by, entry.omitted_at,
    ]))
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function truncatedSuspectDiagnostic(record) {
  const diagnostic = { path: record.path };
  if (record.old_path !== undefined) diagnostic.old_path = record.old_path;
  if (record.score !== undefined) diagnostic.score = record.score;
  diagnostic.status = record.status;
  diagnostic.classified_by = record.binary_classified_by;
  diagnostic.omitted_at = 'serializer';
  return Object.freeze(diagnostic);
}

export function serializeChangeFilesDetailed(records, limits = records?.serializationLimits ?? {}, options = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const builderLane = options.omittedBinaryRecords ?? records?.omittedBinaryRecords ?? [];
  const normalized = normalizeLimits(limits);
  const lines = [];
  const truncatedSuspects = [];
  let emitted = 0;
  let bytes = 0;
  let pastLimit = false;
  for (const record of records) {
    if (!pastLimit) {
      const line = JSON.stringify(record);
      if (line === undefined) throw new TypeError('every change record must be JSON serializable');
      const rowBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (emitted > 0 && (emitted >= normalized.maxEntries || bytes + rowBytes > normalized.maxBytes)) {
        pastLimit = true; // fall through: this record is the first capped one
      } else {
        lines.push(line);
        emitted += 1;
        bytes += rowBytes;
        continue;
      }
    }
    // Capped-out records are never stringified again (legacy behavior kept for
    // non-serializable tails); only default-path suspect rows are harvested.
    if (record?.binary_suspect_reason === 'text-extension'
        && VALID_CLASSIFIERS.has(record.binary_classified_by)) {
      truncatedSuspects.push(truncatedSuspectDiagnostic(record));
    }
  }
  if (emitted < records.length) {
    lines.push(JSON.stringify({ omitted: records.length - emitted, truncated: true }));
  }

  const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const laneEntries = [
    ...truncatedSuspects.sort(byPath),   // serializer-omitted first (design Q3)
    ...[...builderLane].sort(byPath),
  ];
  const total = laneEntries.length;
  const classifiedBy = { 'git-numstat': 0, 'untracked-nul-sniff': 0 };
  const omittedAt = { builder: 0, serializer: 0 };
  for (const entry of laneEntries) {
    classifiedBy[entry.classified_by] += 1;
    omittedAt[entry.omitted_at] += 1;
  }

  let listedRecords = [];
  if (total > 0) {
    const trailerLine = (candidate) => escapeDisplayControls(JSON.stringify({
      binary_omitted: total,
      binary_classified_by: classifiedBy,
      binary_omitted_at: omittedAt,
      binary_records: candidate,
      binary_records_listed: candidate.length,
      binary_records_unlisted: total - candidate.length,
    }));
    for (const entry of laneEntries) {
      if (listedRecords.length >= BINARY_TRAILER_MAX_RECORDS) break;
      const candidate = [...listedRecords, entry];
      if (Buffer.byteLength(trailerLine(candidate), 'utf8') + 1 > BINARY_TRAILER_MAX_BYTES) break;
      listedRecords = candidate;
    }
    lines.push(trailerLine(listedRecords));
  }

  return {
    text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    binaryDiagnostics: {
      total,
      classifiedBy,
      omittedAt,
      records: listedRecords,
      listed: listedRecords.length,
      unlisted: total - listedRecords.length,
      digest: laneDigest(laneEntries),
    },
  };
}

export function serializeChangeFiles(records, limits = records?.serializationLimits ?? {}) {
  return serializeChangeFilesDetailed(records, limits).text;
}
