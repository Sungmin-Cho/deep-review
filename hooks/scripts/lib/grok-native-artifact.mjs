import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const HELPER_MAX_BYTES = 4 * 1024 * 1024;
// <root>/hooks/scripts/lib/grok-native-artifact.mjs -> <root>
export const DEFAULT_PLUGIN_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
export const DEFAULT_NATIVE_DIRECTORY = join(DEFAULT_PLUGIN_ROOT, 'hooks', 'scripts', 'lib', 'native');

function canonical(path) { try { return realpathSync.native(path); } catch { return null; } }

// lstat every component of `relativePath` below `base`, in order; the first
// symlink or junction wins. Never realpath here: canonicalising first would
// erase exactly the component this walk exists to see.
function walkNoSymlink(base, relativePath) {
  let current = base;
  for (const segment of relativePath.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment);
    let st;
    try { st = lstatSync(current); } catch { return { ok: false, reason: 'missing', path: current }; }
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink_component', path: current };
  }
  return { ok: true, path: current };
}

export function evaluateHelperArtifact(gate, { nativeDirectory, pluginRoot = DEFAULT_PLUGIN_ROOT, productionMode = false } = {}) {
  const result = { present: false, executable: false, integrity: 'sums_missing', helper_sha256: null, real_path: null, detail: null };
  if (!gate || (!gate.supported && !gate.inventoried)) return result;
  const entry = GROK_CONTAINMENT_INVENTORY[gate.key];
  if (!entry) return result;
  const root = canonical(pluginRoot);
  const pluginAbs = resolve(pluginRoot);
  const native = resolve(nativeDirectory ?? DEFAULT_NATIVE_DIRECTORY);
  if (!root) return { ...result, integrity: 'outside_root' };
  // Walk from the caller-supplied plugin spelling. Canonicalising the walk
  // base first fails on macOS tmpdir (/var vs /private/var) and would also
  // hide a symlinked native directory (E4: component walk first).
  if (native !== pluginAbs && !native.startsWith(pluginAbs + sep)) {
    return { ...result, integrity: 'outside_root' };
  }
  const relNative = native === pluginAbs ? '' : relative(pluginAbs, native);
  if (relNative.split(/[\\/]/u).includes('..')) return { ...result, integrity: 'outside_root' };
  const nativeWalk = walkNoSymlink(pluginAbs, relNative);
  if (!nativeWalk.ok) return { ...result, integrity: nativeWalk.reason === 'symlink_component' ? 'symlink_component' : 'sums_missing', detail: `native:${nativeWalk.reason}` };
  const walked = walkNoSymlink(native, entry.helper);
  if (!walked.ok) return { ...result, integrity: walked.reason === 'symlink_component' ? 'symlink_component' : 'sums_missing', detail: walked.reason };
  let st;
  try { st = lstatSync(walked.path); } catch { return result; }
  if (!st.isFile()) return result;
  result.present = true;
  try { accessSync(walked.path, fsConstants.X_OK); result.executable = true; } catch { return result; }
  // Presence and executability are decided above so that a present-but-partial
  // tree is an INTEGRITY refusal (grok_containment_helper_failed), never a
  // missing-helper one.
  if (productionMode && nativeTreeState(native) !== 'release') return { ...result, integrity: 'not_release' };
  const real = canonical(walked.path);
  if (!real || !real.startsWith(root + sep)) return { ...result, integrity: 'outside_root' };
  result.real_path = real;
  if (st.size > HELPER_MAX_BYTES) return { ...result, integrity: 'mismatch', detail: 'oversized' };
  result.helper_sha256 = sha256File(walked.path);
  const sums = walkNoSymlink(native, 'SHA256SUMS');
  if (!sums.ok) return { ...result, integrity: sums.reason === 'symlink_component' ? 'sums_symlink' : 'sums_missing' };
  if (!lstatSync(sums.path).isFile()) return { ...result, integrity: 'sums_symlink' };
  const parsed = parseSha256Sums(readFileSync(sums.path, 'utf8'));
  if (!parsed.ok) return { ...result, integrity: 'sums_malformed', detail: parsed.reason };
  const expected = parsed.entries.get(entry.helper);
  if (expected === NATIVE_PLACEHOLDER_DIGEST) return { ...result, integrity: 'not_listed' };
  return { ...result, integrity: expected === result.helper_sha256 ? 'ok' : 'mismatch' };
}
