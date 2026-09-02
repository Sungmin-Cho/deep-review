import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const GROK_CONTAINMENT_INVENTORY = Object.freeze({
  'linux/x64': Object.freeze({
    mechanism: 'pid-namespace',
    source: 'grok-linux-pidns-owner.c',
    helper: 'linux-x64/grok-linux-pidns-owner',
    clone_flags: Object.freeze(['CLONE_NEWPID', 'CLONE_NEWUSER']),
    enumeration: 'namespace-member-set',
    spawn_plan: Object.freeze([
      'clone:CLONE_NEWPID',
      'namespace-init',
      'exec-grok-inside-namespace',
    ]),
  }),
  'win32/x64': Object.freeze({
    mechanism: 'job-object',
    source: 'grok-win32-job-owner.c',
    helper: 'win32-x64/grok-win32-job-owner.exe',
    enumeration: 'JobObjectBasicProcessIdList',
    applied_limits: Object.freeze(['JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE']),
    denied_limits: Object.freeze([
      'JOB_OBJECT_LIMIT_BREAKAWAY_OK',
      'JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK',
    ]),
    spawn_plan: Object.freeze([
      'CreateJobObjectW',
      'SetInformationJobObject:JOBOBJECT_EXTENDED_LIMIT_INFORMATION',
      'CreateProcessW:CREATE_SUSPENDED',
      'AssignProcessToJobObject',
      'ResumeThread',
    ]),
  }),
});

export const NATIVE_PLACEHOLDER_DIGEST = '0'.repeat(64);
export const NATIVE_INVENTORY_PATHS = Object.freeze(Object.values(GROK_CONTAINMENT_INVENTORY).map((entry) => entry.helper));
const SUMS_LINE = /^([a-f0-9]{64})(?:  | \*)(\S.*)$/u;

export function parseSha256Sums(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, reason: 'malformed' };
  const entries = new Map();
  for (const rawLine of text.split(/\r?\n/u)) {
    if (rawLine.length === 0) continue;
    const match = SUMS_LINE.exec(rawLine);
    if (!match || entries.has(match[2])) return { ok: false, reason: 'malformed' };
    entries.set(match[2], match[1]);
  }
  const expected = [...NATIVE_INVENTORY_PATHS].sort();
  const actual = [...entries.keys()].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return { ok: false, reason: 'not_inventory' };
  }
  return { ok: true, entries };
}

function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function regularFile(path) {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink() ? st : null;
  } catch {
    return null;
  }
}
function listBelow(directory, prefix = '') {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() && !entry.isSymbolicLink() ? listBelow(join(directory, entry.name), rel) : [rel];
  });
}

export function nativeTreeState(nativeDirectory) {
  const entries = listBelow(nativeDirectory);
  if (entries.length === 0) return 'invalid';
  if (entries.every((rel) => rel.endsWith('.c') && !rel.includes('/'))) return 'source';
  if (!regularFile(join(nativeDirectory, 'SHA256SUMS'))) return 'invalid';
  const parsed = parseSha256Sums(readFileSync(join(nativeDirectory, 'SHA256SUMS'), 'utf8'));
  if (!parsed.ok) return 'invalid';
  for (const rel of NATIVE_INVENTORY_PATHS) {
    const path = join(nativeDirectory, ...rel.split('/'));
    const st = regularFile(path);
    if (!st) return 'invalid';
    if (process.platform !== 'win32' && rel.startsWith('linux-x64/') && (st.mode & 0o777) !== 0o755) return 'invalid';
    const expected = parsed.entries.get(rel);
    if (expected === NATIVE_PLACEHOLDER_DIGEST || sha256File(path) !== expected) return 'invalid';
  }
  const allowed = new Set([...NATIVE_INVENTORY_PATHS, 'SHA256SUMS']);
  if (entries.some((rel) => !rel.endsWith('.c') && !allowed.has(rel))) return 'invalid';
  return 'release';
}

// The native-launcher predicate is shared by the coordinator (refuse before
// privacy) and the contained-runner adapter (belt before spawn). It lives here
// so neither the coordinator nor the supervisor imports the other for it.
export function isNativeGrokLauncher(chain) {
  if (!chain || typeof chain !== 'object') return false;
  if (chain.prepared_kind !== 'direct' || chain.shebang !== null) return false;
  return chain.posix_executable_type === null || /^native-/u.test(String(chain.posix_executable_type));
}
