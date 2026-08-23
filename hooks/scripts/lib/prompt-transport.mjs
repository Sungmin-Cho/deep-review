// Shared prompt transport (D8).
//
// The Windows `cmd`/`bat` vs `CreateProcess` budget and the POSIX per-string
// argument limit are the only part of a reviewer bridge that carries real
// cross-platform risk, so they live here once and every bridge computes its
// host budget from this module. `run-agy-reviewer.mjs` re-exports the
// estimators unchanged and keeps its own truncating policy; the lossless
// selector and the two platform identity contracts below are the Grok route's
// and are never applied to agy.
//
// Everything here is a pure computation or a direct Node syscall. No shell,
// no interpreter, no child process — the estimator must not depend on what a
// runner later prepares.

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, rmdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { estimateWindowsBatchCommandUnits } from './process.mjs';
import { makeSecureTempPath } from './runtime-context.mjs';

export const WINDOWS_CREATE_PROCESS_LIMIT = 32_767;
export const WINDOWS_CMD_LIMIT = 8_191;
export const WINDOWS_COMMAND_HEADROOM = 512;
export const POSIX_PROMPT_ARGUMENT_LIMIT = 120 * 1024;

const CMD_LAUNCHER_PATTERN = /\.(?:cmd|bat)$/iu;

export function windowsCommandLimit(binary) {
  return CMD_LAUNCHER_PATTERN.test(String(binary))
    ? WINDOWS_CMD_LIMIT
    : WINDOWS_CREATE_PROCESS_LIMIT;
}

export function estimateWindowsCommandUnits(binary, args) {
  if (CMD_LAUNCHER_PATTERN.test(String(binary))) {
    return estimateWindowsBatchCommandUnits(String(binary), args.map(String));
  }
  return (String(binary).length * 2) + 2 + args.reduce(
    (total, argument) => total + (String(argument).length * 2) + 3,
    0,
  );
}

// The host-specific argument budget. On Windows the launcher extension picks
// the ceiling and the headroom is subtracted; the budget deliberately keys on
// the configured `.cmd`/`.bat` launcher even when the shared runner may later
// select a PowerShell shim with a larger CreateProcess transport. The only
// consequence is selecting the file route earlier and never truncating.
export function hostArgumentBudget({ binary, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const limit = windowsCommandLimit(binary);
    return {
      platform,
      limit,
      headroom: WINDOWS_COMMAND_HEADROOM,
      budget: limit - WINDOWS_COMMAND_HEADROOM,
    };
  }
  return {
    platform,
    limit: POSIX_PROMPT_ARGUMENT_LIMIT,
    headroom: 0,
    budget: POSIX_PROMPT_ARGUMENT_LIMIT,
  };
}

function estimateCommandUnits(binary, args, platform) {
  if (platform === 'win32') return estimateWindowsCommandUnits(binary, args);
  // POSIX: every fixed argv token is counted, not just the prompt string.
  // Counting the whole argv against the per-string ceiling is deliberately
  // conservative — it can only select the file route earlier.
  return args.reduce(
    (total, argument) => total + Buffer.byteLength(String(argument), 'utf8') + 1,
    Buffer.byteLength(String(binary), 'utf8') + 1,
  );
}

// The Grok-only lossless selector. One exact Buffer of complete composed
// bytes goes in; exactly one transport comes out. No byte is ever dropped, so
// there is no truncating outcome to report: a body over the inline budget
// selects the file route instead.
export function selectPromptTransport({
  binary,
  platform = process.platform,
  promptBytes,
  promptFilePath,
  fixedArgs = [],
  inlineFlag = '--single',
  promptFileFlag = '--prompt-file',
} = {}) {
  if (!Buffer.isBuffer(promptBytes)) {
    throw new TypeError('promptBytes must be a Buffer of the complete composed prompt');
  }
  if (typeof promptFilePath !== 'string' || promptFilePath.length === 0) {
    throw new TypeError('promptFilePath must be a non-empty string');
  }
  const fixed = fixedArgs.map(String);
  const { limit, budget } = hostArgumentBudget({ binary, platform });
  const promptSha256 = createHash('sha256').update(promptBytes).digest('hex');
  const common = {
    platform,
    binary: String(binary),
    limit,
    budget,
    truncated: false,
    promptBytes: promptBytes.length,
    promptSha256,
  };

  const inlineArgs = [...fixed, inlineFlag, promptBytes.toString('utf8')];
  const inlineUnits = estimateCommandUnits(binary, inlineArgs, platform);
  if (inlineUnits <= budget) {
    return { ...common, transport: 'inline', args: inlineArgs, estimatedUnits: inlineUnits };
  }

  const fileArgs = [...fixed, promptFileFlag, promptFilePath];
  const fileUnits = estimateCommandUnits(binary, fileArgs, platform);
  if (fileUnits > budget) {
    throw new Error(
      `prompt_transport_unavailable: the ${promptFileFlag} argument form needs ${fileUnits} units of a ${budget}-unit host budget`,
    );
  }
  return { ...common, transport: 'prompt-file', args: fileArgs, estimatedUnits: fileUnits };
}

// ---------------------------------------------------------------------------
// The two D8 platform identity schemas.
//
// POSIX binds dev/ino/mode/uid; native Windows has no such authorities and
// binds the retained creation handle, a non-reparse regular-file pathname,
// byte length and SHA-256 instead. Windows records may carry POSIX-shaped
// values only under `diagnostic`, where nothing reads them for admission.
// ---------------------------------------------------------------------------

export const POSIX_PROMPT_IDENTITY_SCHEMA = 'posix-dev-ino-mode-uid-v1';
export const WINDOWS_PROMPT_IDENTITY_SCHEMA = 'win32-retained-handle-sha256-v1';

const POSIX_IDENTITY_AUTHORITIES = Object.freeze(['dev', 'ino', 'mode', 'uid']);
const WINDOWS_IDENTITY_AUTHORITIES = Object.freeze(['type', 'reparsePoint']);

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function posixIdentity(stat) {
  return {
    type: 'file',
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
  };
}

async function readAll(handle, size) {
  const buffer = Buffer.alloc(size);
  if (size === 0) return buffer;
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === size ? buffer : buffer.subarray(0, offset);
}

// Creates the derived prompt file: a fresh bridge-owned 0700 directory, one
// exclusively created 0600 regular file, and a creation handle the caller
// retains until the child exits.
export async function createPromptFile(promptBytes, {
  prefix = 'deep-review-prompt',
  platform = process.platform,
} = {}) {
  const bytes = Buffer.isBuffer(promptBytes) ? promptBytes : Buffer.from(promptBytes);
  const path = makeSecureTempPath(prefix, '.prompt');
  const directory = dirname(path);
  const windows = platform === 'win32';
  const noFollow = windows ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(
    path,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    0o600,
  );
  try {
    await handle.write(bytes, 0, bytes.length, 0);
    const fileStat = await handle.stat();
    const directoryStat = await lstat(directory);
    if (!fileStat.isFile()) throw new Error('derived prompt path is not a regular file');
    const sha256 = digest(bytes);
    const record = windows
      ? {
        schema: WINDOWS_PROMPT_IDENTITY_SCHEMA,
        platform,
        path,
        size: bytes.length,
        sha256,
        promptSha256: sha256,
        file: { type: 'file', reparsePoint: false },
        directory: { path: directory, type: 'directory', reparsePoint: false },
        diagnostic: { mode: fileStat.mode, dev: fileStat.dev, ino: fileStat.ino },
      }
      : {
        schema: POSIX_PROMPT_IDENTITY_SCHEMA,
        platform,
        path,
        size: bytes.length,
        sha256,
        promptSha256: sha256,
        file: { ...posixIdentity(fileStat), path },
        directory: { ...posixIdentity(directoryStat), type: 'directory', path: directory },
      };
    return { record, handle, path, directory };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function fail(reason, schema) {
  return { ok: false, reason, schema };
}

// Revalidates the pathname identity, size and digest. The Grok bridge calls
// this immediately before spawn and again after the child exits, before
// parsing or trusting any output.
export async function verifyPromptIdentity(record, { handle = null } = {}) {
  const schema = record?.schema;
  if (schema !== POSIX_PROMPT_IDENTITY_SCHEMA && schema !== WINDOWS_PROMPT_IDENTITY_SCHEMA) {
    return fail('unknown prompt identity schema', schema ?? null);
  }
  const windows = schema === WINDOWS_PROMPT_IDENTITY_SCHEMA;
  const noFollow = windows ? 0 : (fsConstants.O_NOFOLLOW ?? 0);

  let pathHandle;
  try {
    if (windows) {
      // Windows has no O_NOFOLLOW; the non-reparse authority is checked with
      // a link-level stat before the pathname is opened.
      const link = await lstat(record.path);
      if (link.isSymbolicLink()) return fail('file.reparsePoint mismatch', schema);
      if (!link.isFile()) return fail('file.type mismatch', schema);
    }
    pathHandle = await open(record.path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    return fail(`prompt path is no longer openable: ${error.code || error.message}`, schema);
  }

  try {
    const stat = await pathHandle.stat();
    if (!stat.isFile()) return fail('file.type mismatch', schema);
    if (stat.size !== record.size) return fail('size mismatch', schema);

    if (!windows) {
      const observed = posixIdentity(stat);
      for (const field of POSIX_IDENTITY_AUTHORITIES) {
        if (observed[field] !== record.file?.[field]) return fail(`file.${field} mismatch`, schema);
      }
      const directoryStat = await lstat(record.directory.path);
      const observedDirectory = posixIdentity(directoryStat);
      for (const field of POSIX_IDENTITY_AUTHORITIES) {
        if (observedDirectory[field] !== record.directory?.[field]) {
          return fail(`directory.${field} mismatch`, schema);
        }
      }
    } else {
      // The observed set carries the POSIX-shaped values too, so promoting
      // one of them into WINDOWS_IDENTITY_AUTHORITIES cannot quietly become
      // load-bearing: a Windows record never records them, so such an
      // authority could only ever refuse admission.
      const observed = { reparsePoint: false, ...posixIdentity(stat) };
      for (const field of WINDOWS_IDENTITY_AUTHORITIES) {
        if (record.file?.[field] !== observed[field]) return fail(`file.${field} mismatch`, schema);
      }
    }

    if (digest(await readAll(pathHandle, stat.size)) !== record.sha256) {
      return fail('sha256 mismatch', schema);
    }

    if (handle) {
      const retained = await handle.stat();
      if (retained.size !== record.size) return fail('retained handle size mismatch', schema);
      if (digest(await readAll(handle, retained.size)) !== record.sha256) {
        return fail('retained handle sha256 mismatch', schema);
      }
    }
    return { ok: true, reason: null, schema };
  } finally {
    await pathHandle.close();
  }
}

// Owner-checked cleanup. It revalidates the recorded identity first and
// removes only that exact file and then its own empty directory, so a
// replacement path is never unlinked.
export async function cleanupPromptFile(record, { handle = null } = {}) {
  const identity = await verifyPromptIdentity(record, { handle });
  if (!identity.ok) {
    return { ok: false, reason: 'prompt_cleanup_failed', detail: identity.reason };
  }
  try {
    await unlink(record.path);
    await rmdir(record.directory.path);
  } catch (error) {
    return { ok: false, reason: 'prompt_cleanup_failed', detail: error.code || error.message };
  }
  return { ok: true, reason: null };
}
