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

export function serializeChangeFiles(records, limits = records?.serializationLimits ?? {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const normalized = normalizeLimits(limits);
  const lines = [];
  let emitted = 0;
  let bytes = 0;
  for (const record of records) {
    const line = JSON.stringify(record);
    if (line === undefined) throw new TypeError('every change record must be JSON serializable');
    const rowBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (
      emitted > 0
      && (emitted >= normalized.maxEntries || bytes + rowBytes > normalized.maxBytes)
    ) break;
    lines.push(line);
    emitted += 1;
    bytes += rowBytes;
  }
  if (emitted < records.length) {
    lines.push(JSON.stringify({ omitted: records.length - emitted, truncated: true }));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
