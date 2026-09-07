#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWriteFile } from './lib/runtime-context.mjs';
import { captureReviewTargetSync, sameReviewTarget, readControlFile, readBoundedFile, evidenceHash } from './lib/review-target-snapshot.mjs';
import {
  encodeGitPath,
  gitSync,
  splitNul,
} from './lib/git.mjs';
import { resolveExecutable, runProcess } from './lib/process.mjs';
import {
  encodeRepoPath,
  validatePhase6RepoPath,
  validatePhase6RepoPathSyntax,
} from './lib/repo-path.mjs';

const SCHEMA_VERSION = 1;
const VALID_SEVERITIES = new Set(['critical', 'warning', 'info']);
const ITEM_ID_PATTERN = /^ITEM-[A-Za-z0-9._-]+$/u;
const OBJECT_ID_PATTERN = /^[0-9a-f]{40,64}$/u;
const MODE_PATTERN = /^(?:100644|100755|120000|160000)$/u;
const CONTROL_RECEIPT_SUFFIX = '.verified.json';
const SNAPSHOT_SUFFIX = '-snapshot.json';

export const PRE_STAGED_CONFIRMATION = 'CONFIRM_PRE_STAGED';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertRepo(repo) {
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new TypeError('repo must be a non-empty string');
  }
  return resolve(repo);
}

function assertSeverity(severity) {
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`invalid Phase 6 severity: ${String(severity)}`);
  }
  return severity;
}

function runtimeArtifactPath(repo, artifactPath, label, suffix) {
  if (typeof artifactPath !== 'string' || artifactPath.length === 0) {
    throw new TypeError(`Phase 6 ${label} artifact path must be non-empty`);
  }
  const project = assertRepo(repo);
  const absolute = resolve(artifactPath);
  const runtimeRoot = resolve(project, '.deep-review', 'tmp');
  const comparableAbsolute = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const comparableRoot = process.platform === 'win32' ? runtimeRoot.toLowerCase() : runtimeRoot;
  if (!comparableAbsolute.startsWith(`${comparableRoot}${sep}`)) {
    throw new Error(`Phase 6 ${label} artifact must stay inside the repository runtime directory`);
  }
  if (suffix && !absolute.endsWith(suffix)) {
    throw new Error(`Phase 6 ${label} artifact must end with ${suffix}`);
  }
  const relativePath = absolute.slice(project.length + 1).split(sep).join('/');
  validatePhase6RepoPath({ repo: project, rawPath: encodeRepoPath(relativePath) });
  let cursor = project;
  for (const segment of relativePath.split('/')) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Phase 6 ${label} runtime artifact path contains a symlink`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  return absolute;
}

function checkedGit(repo, args, options = {}) {
  const result = gitSync(repo, args, options);
  if (result.code !== 0) {
    const message = result.stderr.toString('utf8').trim() || `git ${args.join(' ')} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

function assertWorktreeRoot(repo) {
  const project = assertRepo(repo);
  const prefix = checkedGit(project, ['rev-parse', '--show-prefix']).toString('utf8').replace(/[\r\n]+$/u, '');
  if (prefix.length !== 0) {
    throw new Error('Phase 6 repo must be the Git repository root/top-level');
  }
  return project;
}

function currentHead(repo) {
  return checkedGit(repo, ['rev-parse', '--verify', 'HEAD']).toString('ascii').trim();
}

function canonicalBase64(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be non-empty standard base64`);
  }
  const raw = Buffer.from(value, 'base64');
  if (raw.length === 0 || raw.toString('base64') !== value) {
    throw new Error(`${label} is not canonical standard base64`);
  }
  return raw;
}

function compareRaw(left, right) {
  return Buffer.compare(left, right);
}

function uniqueSortedRaw(values) {
  const sorted = values.map((value) => Buffer.from(value)).sort(compareRaw);
  const unique = [];
  for (const value of sorted) {
    if (unique.length === 0 || !unique.at(-1).equals(value)) unique.push(value);
  }
  return unique;
}

function pathSet(values) {
  return new Set(values.map((value) => Buffer.from(value).toString('base64')));
}

function trimAscii(raw) {
  let start = 0;
  let end = raw.length;
  while (start < end && [0x09, 0x0a, 0x0d, 0x20].includes(raw[start])) start += 1;
  while (end > start && [0x09, 0x0a, 0x0d, 0x20].includes(raw[end - 1])) end -= 1;
  return raw.subarray(start, end);
}

function stripLineSuffix(raw) {
  let end = raw.length;
  while (end > 0 && [0x09, 0x20].includes(raw[end - 1])) end -= 1;
  let cursor = end;
  while (cursor > 0) {
    const byte = raw[cursor - 1];
    if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2c || byte === 0x2d) {
      cursor -= 1;
      continue;
    }
    break;
  }
  if (cursor < end && cursor > 0 && raw[cursor - 1] === 0x3a) {
    return trimAscii(raw.subarray(0, cursor - 1));
  }
  return trimAscii(raw.subarray(0, end));
}

function asRaw(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value !== 'string') {
    throw new TypeError('Phase 6 allowlist values must be strings or Buffers');
  }
  let raw = encodeRepoPath(value);
  if (process.platform === 'win32') {
    raw = Buffer.from(raw.map((byte) => byte === 0x5c ? 0x2f : byte));
  }
  return raw;
}

function splitAllowlistValue(value) {
  if (Array.isArray(value)) return value.flatMap(splitAllowlistValue);
  // Buffer input is the explicit raw-path form. Commas and newlines are valid
  // Git pathname bytes and must never be treated as presentation separators.
  if (Buffer.isBuffer(value)) return [Buffer.from(value)];
  const raw = asRaw(value);
  const values = [];
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== 0x2c && raw[index] !== 0x0a) continue;
    const candidate = stripLineSuffix(trimAscii(raw.subarray(start, index)));
    if (candidate.length > 0) values.push(Buffer.from(candidate));
    start = index + 1;
  }
  return values;
}

function acceptedRawPaths(acceptedItems) {
  if (!Array.isArray(acceptedItems)) throw new TypeError('acceptedItems must be an array');
  const paths = [];
  for (const item of acceptedItems) {
    if (!item || typeof item !== 'object') throw new TypeError('accepted item must be an object');
    if (item.target_location !== undefined) paths.push(...splitAllowlistValue(item.target_location));
    if (item.modifiable_paths !== undefined) paths.push(...splitAllowlistValue(item.modifiable_paths));
  }
  return uniqueSortedRaw(paths);
}

function parseIndex(repo) {
  const entries = new Map();
  for (const field of splitNul(checkedGit(repo, ['ls-files', '--stage', '-z']))) {
    const tab = field.indexOf(0x09);
    if (tab < 0) throw new Error('malformed NUL-delimited index entry');
    const header = field.subarray(0, tab).toString('ascii').split(' ');
    if (header.length !== 3 || !MODE_PATTERN.test(header[0]) || !OBJECT_ID_PATTERN.test(header[1])) {
      throw new Error('malformed index mode/blob entry');
    }
    if (header[2] !== '0') throw new Error('unmerged index entries are unsupported in Phase 6');
    const rawPath = Buffer.from(field.subarray(tab + 1));
    entries.set(rawPath.toString('base64'), {
      rawPath,
      present: true,
      mode: header[0],
      blob: header[1],
    });
  }
  return entries;
}

function parseHeadTree(repo, head) {
  const entries = new Map();
  for (const field of splitNul(checkedGit(repo, ['ls-tree', '-r', '-z', '--full-tree', head]))) {
    const tab = field.indexOf(0x09);
    if (tab < 0) throw new Error('malformed NUL-delimited tree entry');
    const header = field.subarray(0, tab).toString('ascii').split(' ');
    if (header.length !== 3 || !MODE_PATTERN.test(header[0]) || !OBJECT_ID_PATTERN.test(header[2])) {
      throw new Error('malformed tree mode/blob entry');
    }
    const rawPath = Buffer.from(field.subarray(tab + 1));
    entries.set(rawPath.toString('base64'), {
      rawPath,
      present: true,
      mode: header[0],
      blob: header[2],
    });
  }
  return entries;
}

function absentIndex() {
  return { present: false, mode: null, blob: null };
}

function indexState(index, key) {
  const entry = index.get(key);
  return entry
    ? { present: true, mode: entry.mode, blob: entry.blob }
    : absentIndex();
}

function sameIndex(left, right) {
  return Boolean(left?.present) === Boolean(right?.present)
    && (left?.mode ?? null) === (right?.mode ?? null)
    && (left?.blob ?? null) === (right?.blob ?? null);
}

function dirtyRecords(repo) {
  const fields = splitNul(checkedGit(repo, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
    '--', '.', ':(exclude).deep-review', ':(exclude).deep-review/**',
  ]));
  const records = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4 || field[2] !== 0x20) throw new Error('malformed porcelain v1 -z record');
    const indexStatus = String.fromCharCode(field[0]);
    const worktreeStatus = String.fromCharCode(field[1]);
    records.push({
      rawPath: Buffer.from(field.subarray(3)),
      indexStatus,
      worktreeStatus,
    });
    if (/[RC]/u.test(indexStatus) || /[RC]/u.test(worktreeStatus)) {
      index += 1;
      if (index >= fields.length) throw new Error('truncated porcelain rename/copy record');
      records.push({
        rawPath: Buffer.from(fields[index]),
        indexStatus,
        worktreeStatus,
      });
    }
  }
  return records;
}

function dirtyRawPaths(repo) {
  return uniqueSortedRaw(dirtyRecords(repo).map((record) => record.rawPath));
}

function repositoryRealBuffer(repo) {
  const validated = validatePhase6RepoPath({ repo, rawPath: Buffer.from('__phase6_probe__') });
  return validated.repositoryReal;
}

function absoluteGitPath(repositoryReal, rawPath) {
  validatePhase6RepoPathSyntax(rawPath);
  const nativeRaw = sep === '/'
    ? rawPath
    : Buffer.from(rawPath.map((byte) => byte === 0x2f ? 0x5c : byte));
  return Buffer.concat([repositoryReal, Buffer.from(sep), nativeRaw]);
}

function absentWorktreeState() {
  return { present: false, type: null, sha256: null, backup: null, mode: null };
}

function readGitReportedWorktree(repositoryReal, rawPath) {
  const segments = validatePhase6RepoPathSyntax(rawPath);
  const separator = Buffer.from('/');
  const prefixParts = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (index > 0) prefixParts.push(separator);
    prefixParts.push(segments[index]);
    const prefixRaw = Buffer.concat(prefixParts);
    const absolute = absoluteGitPath(repositoryReal, prefixRaw);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: absentWorktreeState(), bytes: null };
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = Buffer.from(readlinkSync(absolute, { encoding: 'buffer' }));
      const type = index === segments.length - 1 ? 'symlink' : 'ancestor_symlink';
      const authority = type === 'symlink'
        ? target
        : Buffer.concat([prefixRaw, Buffer.from([0]), target]);
      return {
        state: {
          present: true,
          type,
          sha256: sha256(authority),
          backup: null,
          mode: stat.mode & 0o777,
        },
        bytes: authority,
      };
    }
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) {
        const authority = Buffer.concat([prefixRaw, Buffer.from([0]), Buffer.from('non-directory')]);
        return {
          state: {
            present: true,
            type: 'non_directory_ancestor',
            sha256: sha256(authority),
            backup: null,
            mode: stat.mode & 0o777,
          },
          bytes: authority,
        };
      }
      continue;
    }
    if (stat.isDirectory()) throw new Error('Phase 6 Git-reported dirty path resolved to a directory');
    if (!stat.isFile()) throw new Error('Phase 6 Git-reported dirty path has an unsupported special-file type');
    const bytes = readFileSync(absolute);
    return {
      state: {
        present: true,
        type: 'file',
        sha256: sha256(bytes),
        backup: null,
        mode: stat.mode & 0o777,
      },
      bytes,
    };
  }
  return { state: absentWorktreeState(), bytes: null };
}

function readWorktree(absolutePath) {
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { state: absentWorktreeState(), bytes: null };
    }
    throw error;
  }
  if (stat.isDirectory()) throw new Error('Phase 6 allowlist paths must resolve to files, not directories');
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error('Phase 6 allowlist path has an unsupported special-file type');
  }
  const type = stat.isSymbolicLink() ? 'symlink' : 'file';
  const bytes = type === 'symlink'
    ? Buffer.from(readlinkSync(absolutePath, { encoding: 'buffer' }))
    : readFileSync(absolutePath);
  return {
    state: {
      present: true,
      type,
      sha256: sha256(bytes),
      backup: null,
      mode: stat.mode & 0o777,
    },
    bytes,
  };
}

function stateTuple({ worktree, index }) {
  return {
    worktree: {
      present: Boolean(worktree.present),
      type: worktree.type ?? null,
      sha256: worktree.sha256 ?? null,
      mode: worktree.mode ?? null,
    },
    index: {
      present: Boolean(index.present),
      mode: index.mode ?? null,
      blob: index.blob ?? null,
    },
  };
}

function sameState(left, right) {
  return stableJson(stateTuple(left)) === stableJson(stateTuple(right));
}

function captureRawState(repo, repositoryReal, rawPath, index) {
  const key = rawPath.toString('base64');
  const { state: worktree } = readGitReportedWorktree(repositoryReal, rawPath);
  return { worktree, index: indexState(index, key) };
}

function writeSnapshotBackup(repo, baselineRelative, bytes) {
  const backupRelative = join(baselineRelative, 'files', randomUUID()).split(sep).join('/');
  const backupAbsolute = join(repo, backupRelative);
  runtimeArtifactPath(repo, backupAbsolute, 'backup');
  atomicWriteFile(backupAbsolute, bytes, { mode: 0o600 });
  return backupRelative;
}

function validateSnapshotShape(repo, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schema_version !== SCHEMA_VERSION) {
    throw new Error('unsupported Phase 6 snapshot schema');
  }
  assertSeverity(snapshot.severity);
  if (snapshot.path_encoding !== 'base64') throw new Error('Phase 6 snapshot path encoding must be base64');
  if (!OBJECT_ID_PATTERN.test(snapshot.head || '')) throw new Error('Phase 6 snapshot HEAD is invalid');
  if (!Array.isArray(snapshot.allowed) || !snapshot.paths || typeof snapshot.paths !== 'object') {
    throw new Error('Phase 6 snapshot path authority is malformed');
  }
  const allowedRaw = snapshot.allowed.map((value) => canonicalBase64(value, 'allowed path'));
  const allowedKeys = new Set(snapshot.allowed);
  if (allowedKeys.size !== snapshot.allowed.length) throw new Error('Phase 6 snapshot contains duplicate allowed paths');
  for (const rawPath of allowedRaw) validatePhase6RepoPath({ repo, rawPath });
  for (const key of snapshot.allowed) {
    const entry = snapshot.paths[key];
    if (!entry || typeof entry !== 'object' || !entry.worktree || !entry.index) {
      throw new Error('Phase 6 snapshot is missing an allowed path state');
    }
    if (entry.index.present) {
      if (!MODE_PATTERN.test(entry.index.mode || '') || !OBJECT_ID_PATTERN.test(entry.index.blob || '')) {
        throw new Error('Phase 6 snapshot index state is invalid');
      }
    }
  }
  for (const key of Object.keys(snapshot.paths)) {
    canonicalBase64(key, 'snapshot path key');
    if (!allowedKeys.has(key)) throw new Error('Phase 6 snapshot contains a non-allowlisted path state');
  }
  for (const key of Object.keys(snapshot.pre_dirty || {})) {
    const rawPath = canonicalBase64(key, 'pre-dirty path key');
    // pre_dirty is read authority too. Validate it before even lstat/readlink
    // so a tampered snapshot cannot turn verification into an arbitrary read.
    validatePhase6RepoPathSyntax(rawPath);
  }
  runtimeArtifactPath(repo, snapshot.log_path, 'log', '.log');
  return { allowedRaw, allowedKeys };
}

function readSnapshot(repo, snapshotPath) {
  const absolute = runtimeArtifactPath(repo, snapshotPath, 'snapshot', '.json');
  const bytes = readFileSync(absolute);
  const snapshot = JSON.parse(bytes.toString('utf8'));
  const validated = validateSnapshotShape(repo, snapshot);
  return { absolute, bytes, snapshot, ...validated };
}

export function rotatePhase6Artifacts({ repo }) {
  const project = assertWorktreeRoot(repo);
  const tmp = join(project, '.deep-review', 'tmp');
  runtimeArtifactPath(project, join(tmp, '__phase6-rotate-probe__.json'), 'rotation', '.json');
  if (!existsSync(tmp)) return { status: 'rotated', count: 0 };
  const prev = join(tmp, 'prev');
  mkdirSync(prev, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const entry of readdirSync(tmp, { withFileTypes: true })) {
    if (entry.name === 'prev') continue;
    if (!/^phase6-(?:critical|warning|info)(?:.*\.log|.*\.json|.*\.tsv|.*-baseline)$/u.test(entry.name)) continue;
    const source = join(tmp, entry.name);
    const destination = join(prev, entry.name);
    rmSync(destination, { recursive: true, force: true });
    renameSync(source, destination);
    count += 1;
  }
  return { status: 'rotated', count };
}

export function snapshotPhase6({ repo, severity, acceptedItems, targetScope }) {
  const project = assertWorktreeRoot(repo);
  assertSeverity(severity);
  const allowedRaw = acceptedRawPaths(acceptedItems);
  if (allowedRaw.length === 0) return { status: 'skipped', reason: 'no_accepted_items' };
  const validated = allowedRaw.map((rawPath) => validatePhase6RepoPath({ repo: project, rawPath }));
  const tmp = join(project, '.deep-review', 'tmp');
  const baselineRelative = `.deep-review/tmp/phase6-${severity}-baseline`;
  const baseline = join(project, baselineRelative);
  const snapshotPath = join(tmp, `phase6-${severity}${SNAPSHOT_SUFFIX}`);
  const receiptPath = snapshotPath.replace(/\.json$/u, CONTROL_RECEIPT_SUFFIX);
  const logPath = join(tmp, `phase6-${severity}.log`);
  runtimeArtifactPath(project, snapshotPath, 'snapshot', '.json');
  runtimeArtifactPath(project, join(baseline, 'files', '__phase6-backup-probe__'), 'backup');
  runtimeArtifactPath(project, logPath, 'log', '.log');
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  chmodSync(tmp, 0o700);
  rmSync(baseline, { recursive: true, force: true });
  mkdirSync(join(baseline, 'files'), { recursive: true, mode: 0o700 });
  rmSync(snapshotPath, { force: true });
  rmSync(receiptPath, { force: true });
  rmSync(logPath, { force: true });

  const head = currentHead(project);
  const index = parseIndex(project);
  const headTree = parseHeadTree(project, head);
  const dirtyStatus = dirtyRecords(project);
  const dirty = uniqueSortedRaw(dirtyStatus.map((record) => record.rawPath));
  const dirtyKeys = pathSet(dirty);
  const allowedKeys = pathSet(allowedRaw);
  const paths = {};
  for (const { rawPath, base64: key, absolutePath } of validated) {
    const captured = readWorktree(absolutePath);
    if (captured.bytes) {
      captured.state.backup = writeSnapshotBackup(project, baselineRelative, captured.bytes);
    }
    const currentIndex = indexState(index, key);
    const headIndex = indexState(headTree, key);
    paths[key] = {
      worktree: captured.state,
      index: currentIndex,
      pre_staged: !sameIndex(currentIndex, headIndex),
    };
  }

  const repositoryReal = repositoryRealBuffer(project);
  const preDirty = {};
  for (const rawPath of dirty) {
    const key = rawPath.toString('base64');
    if (allowedKeys.has(key)) continue;
    preDirty[key] = captureRawState(project, repositoryReal, rawPath, index);
  }

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    severity,
    head,
    path_encoding: 'base64',
    allowed: allowedRaw.map((value) => value.toString('base64')),
    pre_changed: allowedRaw.filter((value) => dirtyKeys.has(value.toString('base64'))).map((value) => value.toString('base64')),
    pre_modified: uniqueSortedRaw(
      dirtyStatus
        .filter((record) => !(record.indexStatus === '?' && record.worktreeStatus === '?'))
        .map((record) => record.rawPath),
    ).map((value) => value.toString('base64')),
    pre_untracked: uniqueSortedRaw(
      dirtyStatus
        .filter((record) => record.indexStatus === '?' && record.worktreeStatus === '?')
        .map((record) => record.rawPath),
    ).map((value) => value.toString('base64')),
    pre_dirty: preDirty,
    paths,
    log_path: logPath,
  };
  if (targetScope !== undefined) {
    const target = captureReviewTargetSync({ scope: targetScope });
    if (targetScope.repo_root !== project || !sameReviewTarget(target, target)) throw new Error('Phase 6 target capture failed');
    snapshot.review_target = target;
  }
  atomicWriteFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    status: 'snapshotted',
    snapshot_path: snapshotPath,
    log_path: logPath,
    allowed: snapshot.allowed,
  };
}

function tokenizeLegacyCommand(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('legacy command must be a non-empty string');
  }
  const tokens = [];
  let token = '';
  let quote = null;
  let active = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      active = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      active = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (active) {
        tokens.push(token);
        token = '';
        active = false;
      }
      continue;
    }
    if (';|&<>`'.includes(character) || character === '$' && value[index + 1] === '(') {
      throw new Error('legacy command contains shell control or redirection syntax');
    }
    token += character;
    active = true;
  }
  if (quote) throw new Error('legacy command contains an unterminated quote');
  if (active) tokens.push(token);
  if (tokens.length === 0) throw new Error('legacy command produced no argv tokens');
  return tokens;
}

function normalizeLoggedCommand(command, args) {
  if (args !== undefined) {
    if (typeof command !== 'string' || command.length === 0) throw new TypeError('command must be non-empty');
    if (!Array.isArray(args)) throw new TypeError('args must be an array');
    return { command, args: args.map(String) };
  }
  const tokens = tokenizeLegacyCommand(command);
  return { command: tokens[0], args: tokens.slice(1) };
}

export async function runLoggedTest({ repo, itemId, command, args, logPath, timeoutMs }) {
  const project = assertWorktreeRoot(repo);
  if (!ITEM_ID_PATTERN.test(itemId || '')) throw new Error('invalid Phase 6 ITEM id');
  if (typeof logPath !== 'string' || logPath.length === 0) throw new TypeError('logPath must be non-empty');
  const absoluteLog = runtimeArtifactPath(project, logPath, 'log', '.log');
  const normalized = normalizeLoggedCommand(command, args);
  const executable = resolveExecutable(normalized.command) || (resolve(normalized.command) === normalized.command ? normalized.command : null);
  if (!executable) throw new Error(`test executable not found: ${normalized.command}`);
  mkdirSync(dirname(absoluteLog), { recursive: true, mode: 0o700 });
  if (!existsSync(absoluteLog)) writeFileSync(absoluteLog, '', { mode: 0o600 });
  chmodSync(absoluteLog, 0o600);
  appendFileSync(absoluteLog, `===== ${itemId} START ${new Date().toISOString()} =====\n`);
  const result = await runProcess(executable, normalized.args, {
    cwd: project,
    timeoutMs,
  });
  if (result.stdout.length > 0) appendFileSync(absoluteLog, result.stdout);
  if (result.stderr.length > 0) appendFileSync(absoluteLog, result.stderr);
  if ((result.stdout.length > 0 && result.stdout.at(-1) !== 0x0a) || (result.stderr.length > 0 && result.stderr.at(-1) !== 0x0a)) {
    appendFileSync(absoluteLog, '\n');
  }
  appendFileSync(absoluteLog, `===== ${itemId} END exit=${result.code} =====\n`);
  return {
    code: result.code,
    signal: result.signal ?? null,
    timed_out: result.timedOut,
    log_path: absoluteLog,
  };
}

function groupFields(lines, start, end) {
  const fields = {};
  for (let index = start; index < end; index += 1) {
    const match = /^- ([a-z_]+):\s*(.*)$/u.exec(lines[index]);
    if (!match) continue;
    if (Object.hasOwn(fields, match[1])) throw new Error(`duplicate Group Result field: ${match[1]}`);
    fields[match[1]] = match[2].trim();
  }
  return fields;
}

function parseCount(fields, name) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(fields[name] || '')) {
    throw new Error(`Group Result ${name} count is invalid`);
  }
  return Number(fields[name]);
}

function parseItemBlock(lines, start, end) {
  const header = /^### (ITEM-[A-Za-z0-9._-]+)$/u.exec(lines[start]);
  if (!header) throw new Error('Items block contains an invalid item heading');
  const fields = {};
  const tokens = [];
  for (let index = start + 1; index < end; index += 1) {
    const field = /^- ([a-z_]+):\s*(.*)$/u.exec(lines[index]);
    if (!field) continue;
    if (Object.hasOwn(fields, field[1])) throw new Error(`duplicate Items field: ${field[1]}`);
    fields[field[1]] = field[2].trim();
    if (field[1] !== 'files_changed') continue;
    if (field[2].trim() === '[]') continue;
    for (index += 1; index < end; index += 1) {
      const claim = /^\s{2,}-\s+(.+)$/u.exec(lines[index]);
      if (!claim) {
        index -= 1;
        break;
      }
      if (claim[1] === '(none)') continue;
      let decoded;
      try {
        decoded = JSON.parse(claim[1]);
      } catch {
        throw new Error('files_changed claim must be a JSON string token');
      }
      if (typeof decoded !== 'string' || JSON.stringify(decoded) !== claim[1]) {
        throw new Error('files_changed claim must be one canonical JSON string token');
      }
      tokens.push(claim[1]);
    }
  }
  const statusAliases = {
    pass: 'pass',
    passed: 'pass',
    fail: 'fail',
    failed: 'fail',
    skipped: 'skipped',
    skipped_due_to_halt: 'skipped',
    error: 'error',
  };
  const itemStatus = statusAliases[fields.status];
  if (!itemStatus) {
    throw new Error(`Items ${header[1]} status is invalid`);
  }
  if (!Object.hasOwn(fields, 'files_changed')) throw new Error(`Items ${header[1]} lacks files_changed`);
  let testExitCode;
  if (/^-?[0-9]+$/u.test(fields.test_exit_code || '')) {
    testExitCode = Number(fields.test_exit_code);
  } else if (fields.test_exit_code === '(n/a)' && ['skipped', 'error'].includes(itemStatus)) {
    testExitCode = null;
  } else {
    throw new Error(`Items ${header[1]} test exit is invalid`);
  }
  const raw = tokens.map((token) => encodeGitPath(JSON.parse(token)));
  return {
    item_id: header[1],
    status: itemStatus,
    test_exit_code: testExitCode,
    files_changed_tokens: tokens,
    files_changed_raw: raw,
  };
}

export function parseGroupResult(groupResult) {
  if (typeof groupResult !== 'string') throw new TypeError('groupResult must be a string');
  const lines = groupResult.replace(/\r\n?/gu, '\n').split('\n');
  const groupIndex = lines.indexOf('## Group Result');
  const itemsIndex = lines.indexOf('## Items');
  if (groupIndex < 0 || itemsIndex < 0 || itemsIndex <= groupIndex) {
    throw new Error('required ## Group Result and ## Items blocks are missing or out of order');
  }
  if (lines.lastIndexOf('## Group Result') !== groupIndex || lines.lastIndexOf('## Items') !== itemsIndex) {
    throw new Error('Group Result or Items block is duplicated');
  }
  const fields = groupFields(lines, groupIndex + 1, itemsIndex);
  if (fields.severity !== undefined && !VALID_SEVERITIES.has(fields.severity)) {
    throw new Error('Group Result severity is invalid');
  }
  const executionStatus = fields.execution_status;
  if (!['completed', 'halted_on_regression', 'error'].includes(executionStatus)) {
    throw new Error('Group Result execution_status is invalid');
  }
  const total = parseCount(fields, 'items_total');
  const passed = parseCount(fields, 'items_passed');
  const failed = parseCount(fields, 'items_failed');
  const skipped = parseCount(fields, 'items_skipped');
  if (passed + failed + skipped !== total) throw new Error('Group Result count invariant failed');

  const starts = [];
  for (let index = itemsIndex + 1; index < lines.length; index += 1) {
    if (/^### ITEM-/u.test(lines[index])) starts.push(index);
  }
  const items = starts.map((start, index) => parseItemBlock(lines, start, starts[index + 1] ?? lines.length));
  if (items.length !== total) throw new Error('Items block count does not equal Group Result items_total');
  if (new Set(items.map((item) => item.item_id)).size !== items.length) throw new Error('Items block contains duplicate item ids');
  if (
    executionStatus === 'halted_on_regression'
    && (!ITEM_ID_PATTERN.test(fields.halt_item || '') || !items.some((item) => item.item_id === fields.halt_item))
  ) {
    throw new Error('halted_on_regression Group Result requires a valid halt_item');
  }
  const statusCounts = {
    pass: items.filter((item) => item.status === 'pass').length,
    fail: items.filter((item) => item.status === 'fail' || item.status === 'error').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
  };
  if (statusCounts.pass !== passed || statusCounts.fail !== failed || statusCounts.skipped !== skipped) {
    throw new Error('Items statuses do not match Group Result counts');
  }
  if (executionStatus === 'completed' && (failed !== 0 || skipped !== 0 || passed !== total)) {
    throw new Error('completed Group Result must pass every item');
  }
  return {
    execution_status: executionStatus,
    severity: fields.severity || null,
    items_total: total,
    items_passed: passed,
    items_failed: failed,
    items_skipped: skipped,
    halt_item: fields.halt_item || null,
    items,
  };
}

function verifyLogs(snapshot, parsed) {
  if (typeof snapshot.log_path !== 'string' || !existsSync(snapshot.log_path)) {
    throw new Error('Phase 6 log is missing');
  }
  const log = readFileSync(snapshot.log_path, 'utf8');
  verifyLogText(log, parsed);
}

function verifyLogText(log, parsed) {
  for (const item of parsed.items) {
    if (item.status !== 'pass') continue;
    const escaped = item.item_id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const starts = [...log.matchAll(new RegExp(`^===== ${escaped} START [^\\r\\n]+ =====$`, 'gmu'))];
    const ends = [...log.matchAll(new RegExp(`^===== ${escaped} END exit=([0-9]+) =====$`, 'gmu'))];
    if (
      starts.length !== 1
      || ends.length !== 1
      || ends[0][1] !== String(item.test_exit_code)
      || item.test_exit_code !== 0
    ) {
      throw new Error(`Phase 6 log lacks exact successful START/END markers for ${item.item_id}`);
    }
  }
}

function currentAllowedStates(repo, snapshot, allowedRaw, index) {
  const states = {};
  for (const rawPath of allowedRaw) {
    const validated = validatePhase6RepoPath({ repo, rawPath });
    const { state: worktree } = readWorktree(validated.absolutePath);
    const key = rawPath.toString('base64');
    states[key] = { worktree, index: indexState(index, key) };
  }
  return states;
}

function verificationState(repo, snapshot, allowedRaw) {
  const index = parseIndex(repo);
  const allowed = currentAllowedStates(repo, snapshot, allowedRaw, index);
  const repositoryReal = repositoryRealBuffer(repo);
  const dirty = {};
  for (const rawPath of dirtyRawPaths(repo)) {
    dirty[rawPath.toString('base64')] = captureRawState(repo, repositoryReal, rawPath, index);
  }
  return {
    head: currentHead(repo),
    allowed,
    dirty,
  };
}

function receiptPathFor(snapshotPath) {
  return resolve(snapshotPath).replace(/\.json$/u, CONTROL_RECEIPT_SUFFIX);
}

export function verifyPhase6({ repo, snapshotPath, groupResult }) {
  const project = assertWorktreeRoot(repo);
  const loaded = readSnapshot(project, snapshotPath);
  const { snapshot, allowedRaw, allowedKeys } = loaded;
  if (currentHead(project) !== snapshot.head) {
    throw new Error('Phase 6 HEAD changed; history recovery is not permitted');
  }
  const parsed = parseGroupResult(groupResult);
  if (parsed.severity !== null && parsed.severity !== snapshot.severity) {
    throw new Error('Phase 6 Group Result severity does not match the snapshot');
  }
  if (parsed.execution_status !== 'completed' || parsed.items_failed !== 0 || parsed.items_skipped !== 0) {
    throw new Error('Phase 6 group result is not a complete successful group');
  }
  verifyLogs(snapshot, parsed);

  const index = parseIndex(project);
  const current = currentAllowedStates(project, snapshot, allowedRaw, index);
  const changed = [];
  for (const rawPath of allowedRaw) {
    const key = rawPath.toString('base64');
    if (!sameIndex(snapshot.paths[key].index, current[key].index)) {
      throw new Error(`Phase 6 index/staged state changed for allowlisted path ${key}`);
    }
    if (!sameState(snapshot.paths[key], current[key])) changed.push(rawPath);
  }
  if (changed.length === 0) throw new Error('Phase 6 verified group produced no changed paths');

  const claims = parsed.items.flatMap((item) => item.files_changed_raw);
  for (const rawPath of claims) {
    validatePhase6RepoPath({ repo: project, rawPath });
    if (!allowedKeys.has(rawPath.toString('base64'))) throw new Error('Phase 6 claim is outside the allowlist');
  }
  const uniqueClaims = uniqueSortedRaw(claims);
  if (uniqueClaims.length !== claims.length) throw new Error('Phase 6 claim contains duplicate changed paths');
  const sortedChanged = uniqueSortedRaw(changed);
  if (
    uniqueClaims.length !== sortedChanged.length
    || uniqueClaims.some((value, indexValue) => !value.equals(sortedChanged[indexValue]))
  ) {
    throw new Error('Phase 6 claim does not equal the exact content delta');
  }

  const repositoryReal = repositoryRealBuffer(project);
  for (const [key, before] of Object.entries(snapshot.pre_dirty || {})) {
    const rawPath = canonicalBase64(key, 'pre-dirty path');
    const after = captureRawState(project, repositoryReal, rawPath, index);
    if (!sameState(before, after)) {
      throw new Error(`Phase 6 changed a pre-dirty outside path: ${key}`);
    }
  }
  const preDirtyKeys = new Set(Object.keys(snapshot.pre_dirty || {}));
  for (const rawPath of dirtyRawPaths(project)) {
    const key = rawPath.toString('base64');
    if (!allowedKeys.has(key) && !preDirtyKeys.has(key)) {
      throw new Error(`Phase 6 created or changed a path outside the allowlist: ${key}`);
    }
  }

  const state = verificationState(project, snapshot, allowedRaw);
  const receiptPath = receiptPathFor(loaded.absolute);
  runtimeArtifactPath(project, receiptPath, 'verification receipt', '.json');
  const receipt = {
    schema_version: 1,
    snapshot_sha256: sha256(loaded.bytes),
    head: snapshot.head,
    severity: snapshot.severity,
    changed_paths: sortedChanged.map((value) => value.toString('base64')),
    state_sha256: sha256(Buffer.from(stableJson(state))),
  };
  if (snapshot.review_target) {
    const target = captureReviewTargetSync({ scope: snapshot.review_target.scope });
    if (!sameReviewTarget(target, target)) throw new Error('Phase 6 post target capture failed');
    Object.assign(receipt, { review_target: target, verified_state: state,
      group_result_sha256: evidenceHash(groupResult),
      log_sha256: evidenceHash(readBoundedFile(project, snapshot.log_path, 16 * 1024 * 1024)) });
  }
  atomicWriteFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    status: 'verified',
    changed_paths: receipt.changed_paths,
    verification_receipt: receiptPath,
  };
}

function bufferDirname(pathBuffer) {
  const separator = Buffer.from(sep)[0];
  const index = pathBuffer.lastIndexOf(separator);
  if (index < 0) throw new Error('cannot derive raw path parent');
  return pathBuffer.subarray(0, index);
}

function removeFileIfPresent(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isDirectory()) throw new Error('refusing to replace a directory during Phase 6 recovery');
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function writeRecoveredFile(path, bytes, mode) {
  mkdirSync(bufferDirname(path), { recursive: true });
  removeFileIfPresent(path);
  const descriptor = openSync(path, 'wx', mode ?? 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode ?? 0o600);
}

function restoreIndex(repo, entries) {
  const removals = [];
  const restorations = [];
  for (const { rawPath, entry } of entries) {
    if (!entry.index.present) removals.push(rawPath);
    else restorations.push(Buffer.concat([
      Buffer.from(`${entry.index.mode} ${entry.index.blob}\t`, 'ascii'),
      rawPath,
      Buffer.from([0]),
    ]));
  }
  if (removals.length > 0) {
    checkedGit(repo, ['update-index', '--force-remove', '-z', '--stdin'], {
      input: Buffer.concat(removals.flatMap((value) => [value, Buffer.from([0])])),
    });
  }
  if (restorations.length > 0) {
    checkedGit(repo, ['update-index', '-z', '--index-info'], { input: Buffer.concat(restorations) });
  }
}

function normalizeRecoveryPaths(paths, allowedRaw) {
  if (paths === undefined) return allowedRaw;
  if (!Array.isArray(paths)) throw new TypeError('recovery paths must be an array');
  return uniqueSortedRaw(paths.map(asRaw));
}

export function recoverPhase6({ repo, snapshotPath, paths }) {
  const project = assertWorktreeRoot(repo);
  const loaded = readSnapshot(project, snapshotPath);
  const { snapshot, allowedRaw, allowedKeys } = loaded;
  if (currentHead(project) !== snapshot.head) {
    throw new Error('Phase 6 HEAD changed; recovery would rewrite user history');
  }
  const recoveryRaw = normalizeRecoveryPaths(paths, allowedRaw);
  const prepared = [];
  for (const rawPath of recoveryRaw) {
    const validated = validatePhase6RepoPath({ repo: project, rawPath });
    const key = rawPath.toString('base64');
    if (!allowedKeys.has(key)) throw new Error('Phase 6 recovery path is outside the snapshot allowlist');
    const entry = snapshot.paths[key];
    let bytes = null;
    if (entry.worktree.present) {
      if (typeof entry.worktree.backup !== 'string') throw new Error('Phase 6 snapshot backup reference is missing');
      const backup = resolve(project, entry.worktree.backup);
      const baselineRoot = resolve(project, `.deep-review/tmp/phase6-${snapshot.severity}-baseline`);
      if (backup !== baselineRoot && !backup.startsWith(`${baselineRoot}${sep}`)) {
        throw new Error('Phase 6 snapshot backup escaped the private baseline');
      }
      runtimeArtifactPath(project, backup, 'backup');
      bytes = readFileSync(backup);
      if (sha256(bytes) !== entry.worktree.sha256) throw new Error('Phase 6 snapshot backup hash mismatch');
    }
    prepared.push({ rawPath, validated, entry, bytes });
  }

  restoreIndex(project, prepared);
  for (const { validated, entry, bytes } of prepared) {
    if (!entry.worktree.present) removeFileIfPresent(validated.absolutePath);
    else if (entry.worktree.type === 'symlink') {
      mkdirSync(bufferDirname(validated.absolutePath), { recursive: true });
      removeFileIfPresent(validated.absolutePath);
      symlinkSync(bytes, validated.absolutePath);
    } else {
      writeRecoveredFile(validated.absolutePath, bytes, entry.worktree.mode);
    }
  }
  rmSync(receiptPathFor(loaded.absolute), { force: true });
  return {
    status: 'recovered',
    paths: recoveryRaw.map((value) => value.toString('base64')),
  };
}

function restoreSnapshotIndexAfterCommitFailure(repo, snapshot, rawPaths) {
  const entries = rawPaths.map((rawPath) => ({
    rawPath,
    entry: snapshot.paths[rawPath.toString('base64')],
  }));
  restoreIndex(repo, entries);
}

function pathspecInput(rawPaths) {
  return Buffer.concat(rawPaths.flatMap((value) => [value, Buffer.from([0])]));
}

export function commitPhase6({ repo, snapshotPath, severity, confirmPreStaged } = {}) {
  const project = assertWorktreeRoot(repo);
  assertSeverity(severity);
  const loaded = readSnapshot(project, snapshotPath);
  const { snapshot, allowedRaw } = loaded;
  if (snapshot.severity !== severity) throw new Error('Phase 6 commit severity does not match the snapshot');
  if (currentHead(project) !== snapshot.head) throw new Error('Phase 6 HEAD changed before commit');
  const receiptPath = receiptPathFor(loaded.absolute);
  runtimeArtifactPath(project, receiptPath, 'verification receipt', '.json');
  if (!existsSync(receiptPath)) throw new Error('Phase 6 verification receipt is missing');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (
    receipt.schema_version !== 1
    || receipt.snapshot_sha256 !== sha256(loaded.bytes)
    || receipt.head !== snapshot.head
    || receipt.severity !== severity
    || !Array.isArray(receipt.changed_paths)
  ) {
    throw new Error('Phase 6 verification receipt is stale or malformed');
  }
  const changedRaw = receipt.changed_paths.map((value) => canonicalBase64(value, 'verified changed path'));
  if (changedRaw.length === 0) throw new Error('Phase 6 verification receipt contains no changed paths');
  const allowedKeys = new Set(allowedRaw.map((value) => value.toString('base64')));
  for (const rawPath of changedRaw) {
    validatePhase6RepoPath({ repo: project, rawPath });
    if (!allowedKeys.has(rawPath.toString('base64'))) throw new Error('verified changed path is outside snapshot allowlist');
  }
  const state = verificationState(project, snapshot, allowedRaw);
  if (receipt.state_sha256 !== sha256(Buffer.from(stableJson(state)))) {
    throw new Error('Phase 6 verification state is stale; verify again before commit');
  }

  const preStaged = changedRaw.filter((rawPath) => snapshot.paths[rawPath.toString('base64')].pre_staged);
  if (preStaged.length > 0) {
    if (confirmPreStaged === undefined || confirmPreStaged === false) {
      return {
        status: 'requires_user_confirmation',
        paths: preStaged.map((value) => value.toString('base64')),
      };
    }
    if (confirmPreStaged !== PRE_STAGED_CONFIRMATION) {
      throw new Error('invalid explicit pre-staged confirmation token');
    }
  }

  const input = pathspecInput(changedRaw);
  try {
    checkedGit(project, ['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input });
    checkedGit(project, [
      '--literal-pathspecs', 'commit', '--only',
      '-m', `fix(review-response): resolve ${severity} Phase 6 items`,
      '--pathspec-from-file=-', '--pathspec-file-nul',
    ], { input });
  } catch (error) {
    try {
      restoreSnapshotIndexAfterCommitFailure(project, snapshot, changedRaw);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], 'Phase 6 commit failed and index recovery also failed');
    }
    throw error;
  }
  const result = {
    status: 'committed',
    commit: currentHead(project),
    paths: changedRaw.map((value) => value.toString('base64')),
  };
  if (snapshot.review_target) {
    result.review_target = captureReviewTargetSync({ scope: snapshot.review_target.scope });
    result.verification_receipt_sha256 = evidenceHash(readBoundedFile(project, receiptPath));
  }
  return result;
}

// Read-only historical join. It never calls verify/commit or grants mutation
// authority. The caller archives these exact files before runtime rotation.
export function verifyPhase6History({ repo, snapshotFile, groupResultFile, verificationResultFile, receiptFile, logFile, commitResultFile }) {
  const snapshotBytes = readBoundedFile(repo, snapshotFile);
  const snapshot = readControlFile(repo, snapshotFile);
  validateSnapshotShape(repo, snapshot);
  const receiptBytes = readBoundedFile(repo, receiptFile);
  const receipt = readControlFile(repo, receiptFile);
  const result = readControlFile(repo, verificationResultFile);
  const groupText = readBoundedFile(repo, groupResultFile).toString('utf8');
  const parsed = parseGroupResult(groupText);
  const log = readBoundedFile(repo, logFile, 16 * 1024 * 1024).toString('utf8');
  if (parsed.execution_status !== 'completed' || parsed.items_failed !== 0 || parsed.items_skipped !== 0
      || (parsed.severity !== null && parsed.severity !== snapshot.severity)
      || result.status !== 'verified' || receipt.schema_version !== 1
      || receipt.head !== snapshot.head || receipt.severity !== snapshot.severity
      || receipt.snapshot_sha256 !== evidenceHash(snapshotBytes)
      || receipt.group_result_sha256 !== evidenceHash(groupText) || receipt.log_sha256 !== evidenceHash(log)
      || !receipt.verified_state || receipt.state_sha256 !== sha256(Buffer.from(stableJson(receipt.verified_state)))
      || !sameReviewTarget(snapshot.review_target, snapshot.review_target)
      || !sameReviewTarget(receipt.review_target, receipt.review_target)
      || snapshot.review_target.scope_digest !== receipt.review_target.scope_digest)
    throw new Error('Phase 6 historical evidence is missing, stale or malformed');
  // Reuse the existing log predicate with captured bytes, not a live old path.
  verifyLogText(log, parsed);
  const changed = snapshot.allowed.filter(key => {
    const after = receipt.verified_state.allowed[key];
    if (!after || !sameIndex(snapshot.paths[key].index, after.index)) throw new Error('Phase 6 historical index mismatch');
    return !sameState(snapshot.paths[key], after);
  }).sort();
  const claimed = parsed.items.flatMap(item => item.files_changed_raw.map(value => value.toString('base64'))).sort();
  if (!changed.length || stableJson(changed) !== stableJson([...receipt.changed_paths].sort())
      || stableJson(changed) !== stableJson([...result.changed_paths].sort())
      || stableJson(changed) !== stableJson(claimed)) throw new Error('Phase 6 historical changed paths mismatch');
  let post = receipt.review_target;
  let commit = null;
  if (commitResultFile) {
    const committed = readControlFile(repo, commitResultFile);
    if (committed.status !== 'committed' || !OBJECT_ID_PATTERN.test(committed.commit || '')
        || stableJson([...committed.paths].sort()) !== stableJson(changed)
        || committed.verification_receipt_sha256 !== evidenceHash(receiptBytes)
        || !sameReviewTarget(committed.review_target, committed.review_target)
        || committed.review_target.scope_digest !== snapshot.review_target.scope_digest)
      throw new Error('Phase 6 historical commit result mismatch');
    const parent = checkedGit(repo, ['rev-parse', `${committed.commit}^`]).toString('utf8').trim();
    if (parent !== snapshot.head) throw new Error('Phase 6 historical commit parent mismatch');
    const paths = splitNul(checkedGit(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', committed.commit])).map(value => value.toString('base64')).sort();
    if (stableJson(paths) !== stableJson(changed)) throw new Error('Phase 6 historical commit delta mismatch');
    const tree = parseHeadTree(repo, committed.commit);
    for (const key of changed) {
      const entry = indexState(tree, key), expected = receipt.verified_state.allowed[key].worktree;
      if (entry.present !== expected.present) throw new Error('Phase 6 historical committed path mismatch');
      if (entry.present) {
        const bytes = checkedGit(repo, ['cat-file', 'blob', entry.blob]);
        if (sha256(bytes) !== expected.sha256
            || (entry.mode === '120000' ? 'symlink' : 'file') !== expected.type
            || (expected.type === 'file' && (entry.mode === '100755') !== Boolean(expected.mode & 0o111)))
          throw new Error('Phase 6 historical committed content mismatch');
      }
    }
    post = committed.review_target; commit = committed.commit;
  }
  return { status: 'verified', reviewed_target: snapshot.review_target, post_target: post,
    changed_paths: changed.map(key => Buffer.from(key, 'base64').toString('utf8')), commit };
}

function parseCli(argv) {
  const [subcommand, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) throw new Error(`unexpected CLI argument: ${key}`);
    if (key === '--confirm-pre-staged') {
      options.confirmPreStaged = PRE_STAGED_CONFIRMATION;
      continue;
    }
    if (index + 1 >= rest.length || rest[index + 1].startsWith('--')) {
      throw new Error(`missing value for ${key}`);
    }
    options[key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = rest[index + 1];
    index += 1;
  }
  return { subcommand, options };
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`failed to read ${label} JSON: ${error.message}`);
  }
}

async function runCli(argv) {
  const { subcommand, options } = parseCli(argv);
  switch (subcommand) {
    case 'rotate':
      return rotatePhase6Artifacts({ repo: options.repo });
    case 'snapshot':
      return snapshotPhase6({
        repo: options.repo,
        severity: options.severity,
        acceptedItems: readJsonFile(options.acceptedItemsFile, 'accepted items'),
        ...(options.targetScopeFile ? { targetScope: readControlFile(options.repo, options.targetScopeFile) } : {}),
      });
    case 'run-test': {
      const command = readJsonFile(options.argvFile, 'argv');
      return runLoggedTest({
        repo: options.repo,
        itemId: options.itemId,
        command: command.command,
        args: command.args,
        logPath: options.logPath,
        timeoutMs: options.timeoutMs === undefined ? undefined : Number(options.timeoutMs),
      });
    }
    case 'verify':
      return verifyPhase6({
        repo: options.repo,
        snapshotPath: options.snapshot,
        groupResult: readFileSync(resolve(options.resultFile), 'utf8'),
      });
    case 'recover': {
      const raw = readJsonFile(options.pathsFile, 'recovery paths');
      const values = (raw.paths_base64 || raw).map((value) => canonicalBase64(value, 'recovery path'));
      return recoverPhase6({ repo: options.repo, snapshotPath: options.snapshot, paths: values });
    }
    case 'commit':
      return commitPhase6({
        repo: options.repo,
        snapshotPath: options.snapshot,
        severity: options.severity,
        confirmPreStaged: options.confirmPreStaged,
      });
    default:
      throw new Error('usage: phase6-protocol.mjs <rotate|snapshot|run-test|verify|recover|commit> [options]');
  }
}

const invoked = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'error', error: error.message })}\n`);
    process.exitCode = 1;
  }
}
