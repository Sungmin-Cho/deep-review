import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { gitSync, splitNul } from './git.mjs';
import { canonicalStringify } from '../document-readiness.mjs';

export const CONTROL_LIMIT = 1024 * 1024;
export const SOURCE_LIMIT = 16 * 1024 * 1024;
export const evidenceHash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalStringify(value))
    .digest('hex');
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const states = new Set([
  'clean',
  'staged',
  'unstaged',
  'mixed',
  'initial',
  'untracked-only',
  'non-git',
]);
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function containedPath(repo, file) {
  if (typeof file !== 'string' || !file || file.includes('\0') || !file.isWellFormed())
    throw new Error('unsupported target path');
  const root = realpathSync(repo);
  let absolute = resolve(root, file);
  if (isAbsolute(file) && !absolute.startsWith(root + sep)) {
    // macOS /var and /private/var are aliases outside the repository boundary.
    // Resolve only a root alias; never follow a symlink inside the repository.
    let ancestor = absolute;
    while (dirname(ancestor) !== ancestor) {
      try {
        if (realpathSync(ancestor) === root) {
          absolute = resolve(root, relative(ancestor, absolute));
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      ancestor = dirname(ancestor);
    }
  }
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('path outside repository');
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('symlink path unsupported');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return absolute;
}

export function readBoundedFile(repo, file, limit = CONTROL_LIMIT) {
  const absolute = containedPath(repo, file);
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > limit)
      throw new Error('file must be regular and within byte limit');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      bytes.length > limit ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('file changed during read');
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export const readControlFile = (repo, file) => JSON.parse(decode(readBoundedFile(repo, file)));

function git(repo, args, { optional = false } = {}) {
  const result = gitSync(repo, args, { maxBuffer: SOURCE_LIMIT + CONTROL_LIMIT });
  if (result.code !== 0) {
    if (optional) return null;
    throw new Error(`target git capture failed: ${args[0]}`);
  }
  return result.stdout;
}
function pathText(repo, value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\\'))
    throw new Error('unsupported target path');
  return relative(repo, containedPath(repo, value)).split(sep).join('/');
}
function normalizeScope(scope) {
  if (
    !scope ||
    scope.schema_version !== 1 ||
    !states.has(scope.change_state) ||
    !Array.isArray(scope.files) ||
    !scope.files.length ||
    scope.files.length > 2000
  )
    throw new Error('invalid target scope');
  const root = realpathSync(scope.repo_root);
  if (root !== scope.repo_root) throw new Error('noncanonical repository root');
  if (scope.review_base !== null && !/^[a-f0-9]{40,64}$/.test(scope.review_base))
    throw new Error('base must be immutable object id');
  const files = scope.files
    .map((row) => {
      if (!row || typeof row.status !== 'string' || !row.status.trim())
        throw new Error('invalid target record');
      return {
        path: pathText(root, row.path),
        status: row.status,
        ...(row.old_path !== undefined ? { old_path: pathText(root, row.old_path) } : {}),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(files.map((row) => row.path)).size !== files.length)
    throw new Error('duplicate target path');
  return {
    schema_version: 1,
    repo_root: root,
    change_state: scope.change_state,
    review_base: scope.review_base,
    files,
  };
}
export async function createTargetScope({ repo, changeState, reviewBase = null, records }) {
  const root = realpathSync(repo);
  let base = null;
  if (reviewBase !== null) {
    if (typeof reviewBase !== 'string' || !reviewBase || reviewBase.startsWith('-'))
      throw new Error('invalid review base');
    base = decode(git(root, ['rev-parse', '--verify', `${reviewBase}^{commit}`])).trim();
  }
  if (changeState === 'clean' && !base) throw new Error('clean target requires review base');
  return normalizeScope({
    schema_version: 1,
    repo_root: root,
    change_state: changeState,
    review_base: base,
    files: records,
  });
}
function runtimePath(path, explicit) {
  if (explicit.has(path)) return false;
  return (
    /^\.deep-review\/(?:reports|responses|tmp|receipts|audits)(?:\/|$)/.test(path) ||
    /^\.deep-review\/(?:config\.yaml|last-review[^/]*|\.?pending-mutation[^/]*|\.mutation\.[^/]*(?:\/.*)?|.*\.lock(?:\/.*)?|locks\/.*|slots\/.*|recurring[^/]*|entropy[^/]*|loop-state[^/]*|state\.json)$/.test(
      path,
    )
  );
}
function fileIdentity(repo, path) {
  const absolute = containedPath(repo, path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return { type: 'missing' };
    throw error;
  }
  if (!stat.isFile()) throw new Error('target must be regular file');
  return {
    type: 'file',
    mode: stat.mode & 0o777,
    sha256: evidenceHash(readBoundedFile(repo, path, SOURCE_LIMIT)),
  };
}
function policies(repo) {
  const rows = [];
  for (const prefix of ['', '.deep-review/']) {
    for (const name of ['rules.yaml', 'review-policy.yaml', 'fitness.json']) {
      const path = prefix + name;
      try {
        lstatSync(containedPath(repo, path));
        rows.push(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const walk = (path) => {
      let stat;
      try {
        stat = lstatSync(containedPath(repo, path));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (stat.isDirectory()) {
        for (const entry of readdirSync(containedPath(repo, path))) walk(`${path}/${entry}`);
      } else rows.push(path);
      if (rows.length > 2000) throw new Error('policy path limit exceeded');
    };
    walk(prefix + 'contracts');
  }
  return rows.sort();
}
export async function captureReviewTarget({ scope }) {
  return captureReviewTargetSync({ scope });
}
// The capture core is synchronous; both APIs share exactly the same guards.
export function captureReviewTargetSync({ scope }) {
  try {
    scope = normalizeScope(scope);
    const repo = scope.repo_root;
    const explicit = new Set(
      scope.files.flatMap((row) => [row.path, ...(row.old_path ? [row.old_path] : [])]),
    );
    const index = new Map();
    let head = null;
    const dirty = [];
    if (scope.change_state !== 'non-git') {
      head = git(repo, ['rev-parse', '--verify', 'HEAD'], { optional: true });
      head = head ? decode(head).trim() : null;
      if (!head && scope.change_state !== 'initial') throw new Error('missing repository HEAD');
      for (const entry of splitNul(git(repo, ['ls-files', '--stage', '-z']))) {
        const text = decode(entry);
        const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(text);
        if (!match) throw new Error('invalid index record');
        const path = pathText(repo, match[4]);
        if (runtimePath(path, explicit)) continue;
        if (match[3] !== '0') throw new Error('unmerged index');
        index.set(path, { mode: match[1], blob: match[2] });
      }
      const fields = splitNul(
        git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      );
      for (let i = 0; i < fields.length; i++) {
        const text = decode(fields[i]);
        const status = text.slice(0, 2);
        const path = pathText(repo, text.slice(3));
        const oldPath = /[RC]/.test(status) ? pathText(repo, decode(fields[++i])) : null;
        if (runtimePath(path, explicit) && (!oldPath || runtimePath(oldPath, explicit))) continue;
        dirty.push({ path, status, old_path: oldPath, worktree: fileIdentity(repo, path) });
      }
    }
    const entries = [];
    for (const row of scope.files) {
      for (const path of [row.path, ...(row.old_path ? [row.old_path] : [])]) {
        const indexed = index.get(path) ?? null;
        let view = 'worktree',
          content;
        if (scope.change_state === 'clean' && row.status !== 'session') {
          view = 'head';
          const blob = git(repo, ['ls-tree', '-z', 'HEAD', '--', path]);
          content = decode(blob);
          if (content) {
            const objectId = /^\d+ blob ([a-f0-9]+)/.exec(content)?.[1];
            if (
              !objectId ||
              Number(decode(git(repo, ['cat-file', '-s', objectId])).trim()) > SOURCE_LIMIT
            )
              throw new Error('HEAD artifact unsupported or exceeds byte limit');
          }
        } else if (
          ['staged', 'initial'].includes(scope.change_state) &&
          indexed &&
          row.status !== 'session'
        ) {
          view = 'index';
          content = indexed;
          const size = Number(decode(git(repo, ['cat-file', '-s', indexed.blob])).trim());
          if (size > SOURCE_LIMIT) throw new Error('index artifact exceeds byte limit');
        } else content = fileIdentity(repo, path);
        entries.push({
          path,
          view,
          content,
          index: indexed,
          worktree_guard: fileIdentity(repo, path),
        });
      }
    }
    const policy = policies(repo).map((path) => ({ path, ...fileIdentity(repo, path) }));
    const scopeDigest = evidenceHash(scope);
    const targetDigest = evidenceHash({
      scope_digest: scopeDigest,
      head,
      index: [...index].sort(),
      dirty: dirty.sort((a, b) => a.path.localeCompare(b.path)),
      entries,
      policy,
    });
    return {
      schema_version: 1,
      algorithm: 'deep-review-target-v1',
      status: 'captured',
      scope,
      scope_digest: scopeDigest,
      target_digest: targetDigest,
      entries: entries.length,
      error: null,
    };
  } catch (error) {
    return {
      schema_version: 1,
      algorithm: 'deep-review-target-v1',
      status: 'indeterminate',
      scope,
      scope_digest: null,
      target_digest: null,
      entries: 0,
      error: error.message,
    };
  }
}
export function sameReviewTarget(left, right) {
  try {
    for (const value of [left, right])
      if (
        value?.schema_version !== 1 ||
        value.algorithm !== 'deep-review-target-v1' ||
        value.status !== 'captured' ||
        value.error !== null ||
        !sha(value.scope_digest) ||
        !sha(value.target_digest) ||
        !Number.isSafeInteger(value.entries) ||
        value.entries <= 0 ||
        evidenceHash(normalizeScope(value.scope)) !== value.scope_digest
      )
        return false;
    return (
      left.scope_digest === right.scope_digest &&
      left.target_digest === right.target_digest &&
      left.entries === right.entries
    );
  } catch {
    return false;
  }
}

// This observes the route payload read by an adapter, before provider-specific
// wrapping. It does not attest provider-internal conversation state.
export function observeRoutePayload(bytes, expectedSha256, prepared = false) {
  if (prepared && !sha(expectedSha256))
    throw new Error('prepared bridge requires expected payload SHA-256');
  const digest = evidenceHash(bytes);
  if (expectedSha256 !== undefined && (!sha(expectedSha256) || digest !== expectedSha256))
    throw new Error('route payload digest mismatch before spawn');
  return { route_payload_sha256: digest, route_payload_bytes: Buffer.byteLength(bytes) };
}
