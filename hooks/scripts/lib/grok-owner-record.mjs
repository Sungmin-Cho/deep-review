import { closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const OWNER_ID_PATTERN = /^grok-containment-owner-\d+-\d+-[a-f0-9]{8}$/u;
export const RECORD_DIRECTORY_NAME = 'deep-review-grok-containment';
const IS_WINDOWS = process.platform === 'win32';
const HEX64 = /^[a-f0-9]{64}$/u;

export function recordDirectory({ tmpRoot = tmpdir() } = {}) {
  const path = join(tmpRoot, RECORD_DIRECTORY_NAME);
  try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch { return { ok: false, path, reason: 'record_directory_untrusted' }; }
  let st;
  try { st = lstatSync(path); } catch { return { ok: false, path, reason: 'record_directory_untrusted' }; }
  if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, path, reason: 'record_directory_untrusted' };
  if (!IS_WINDOWS && (st.uid !== process.getuid() || (st.mode & 0o022) !== 0)) return { ok: false, path, reason: 'record_directory_untrusted' };
  return { ok: true, path, reason: null };
}

function recordPath(ownerId, tmpRoot) {
  if (!OWNER_ID_PATTERN.test(String(ownerId))) return null;
  return join(tmpRoot, RECORD_DIRECTORY_NAME, `${ownerId}.json`);
}

export function writeOwnerRecord({ record, tokenSha256, helperSha256, createdAt }, { tmpRoot = tmpdir() } = {}) {
  const directory = recordDirectory({ tmpRoot });
  if (!directory.ok) throw Object.assign(new Error(directory.reason), { reason: directory.reason });
  const path = recordPath(record.owner_id, tmpRoot);
  if (!path) throw new Error('invalid owner id');
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try { writeSync(fd, JSON.stringify({ record, token_sha256: tokenSha256, helper_sha256: helperSha256, created_at: createdAt })); }
  finally { closeSync(fd); }
  return path;
}

export function readOwnerRecord(ownerId, { tmpRoot = tmpdir(), now = () => Date.now(), ttlMs = 30 * 60 * 1000, expectedUid = IS_WINDOWS ? null : process.getuid() } = {}) {
  const path = recordPath(ownerId, tmpRoot);
  if (!path) return { ok: false, reason: 'absent' };
  const directory = recordDirectory({ tmpRoot });
  if (!directory.ok) return { ok: false, reason: 'directory_untrusted' };
  let st;
  try { st = lstatSync(path); } catch { return { ok: false, reason: 'absent' }; }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  if (!st.isFile()) return { ok: false, reason: 'malformed' };
  if (expectedUid !== null && st.uid !== expectedUid) return { ok: false, reason: 'foreign_uid' };
  let body;
  try { body = JSON.parse(readFileSync(path, 'utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (!body || typeof body !== 'object' || !body.record || typeof body.record !== 'object'
      || body.record.owner_id !== ownerId || !HEX64.test(String(body.token_sha256))
      || !HEX64.test(String(body.helper_sha256)) || !Number.isFinite(body.created_at)) {
    return { ok: false, reason: 'malformed' };
  }
  const current = now();
  if (body.created_at > current) return { ok: false, reason: 'future' };
  if (current - body.created_at > ttlMs) return { ok: false, reason: 'expired' };
  return { ok: true, body, path };
}

export function validateOwnerRecord(token, body) {
  if (!token || !body?.record) return { ok: false, reason: 'owner' };
  if (body.record.owner_id !== token.owner_id) return { ok: false, reason: 'owner' };
  if (body.record.generation !== token.generation) return { ok: false, reason: 'generation' };
  if (body.token_sha256 !== token.token_sha256) return { ok: false, reason: 'seal' };
  return { ok: true };
}

// The unlink is the single-use predicate, so it is guarded like a read: the
// directory must still be trusted and the record must still be a regular,
// non-symlink file owned by us. Otherwise it is treated as absent and nothing
// outside the directory is ever unlinked.
export function consumeOwnerRecord(ownerId, { tmpRoot = tmpdir(), expectedUid = IS_WINDOWS ? null : process.getuid() } = {}) {
  const path = recordPath(ownerId, tmpRoot);
  if (!path) return { consumed: false, reason: 'absent' };
  if (!recordDirectory({ tmpRoot }).ok) return { consumed: false, reason: 'directory_untrusted' };
  let st;
  try { st = lstatSync(path); } catch { return { consumed: false, reason: 'absent' }; }
  if (st.isSymbolicLink() || !st.isFile()) return { consumed: false, reason: 'symlink' };
  if (expectedUid !== null && st.uid !== expectedUid) return { consumed: false, reason: 'foreign_uid' };
  try { unlinkSync(path); return { consumed: true, reason: null }; } catch (error) {
    if (error?.code === 'ENOENT') return { consumed: false, reason: 'absent' };
    throw error;
  }
}

export function unlinkOwnerRecord(ownerId, options) { return consumeOwnerRecord(ownerId, options).consumed; }

export function sweepOwnerRecords({ tmpRoot = tmpdir(), now = () => Date.now(), ttlMs = 30 * 60 * 1000 } = {}) {
  const directory = recordDirectory({ tmpRoot });
  if (!directory.ok) return 0;
  let swept = 0;
  for (const name of readdirSync(directory.path)) {
    const ownerId = name.endsWith('.json') ? name.slice(0, -5) : null;
    if (!ownerId || !OWNER_ID_PATTERN.test(ownerId)) continue;
    const read = readOwnerRecord(ownerId, { tmpRoot, now, ttlMs });
    if (!read.ok && read.reason === 'expired' && consumeOwnerRecord(ownerId, { tmpRoot }).consumed) swept += 1;   // future-dated records are refused, never swept
  }
  return swept;
}
