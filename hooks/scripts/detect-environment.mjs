import {
  existsSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectRuntimeHost, resolvePluginRoot } from './lib/runtime-context.mjs';
import { prepareSpawnChain, resolveExecutable, runProcess } from './lib/process.mjs';
import {
  PROBE_MAX_CAPTURE_BYTES_PER_STREAM,
  PROBE_MAX_CAPTURE_BYTES_TOTAL,
} from './lib/probe-limits.mjs';
import {
  canonicalStringify,
  encodeGrokCompatibilityCarrierFrame,
  parseGrokCompatibilityStdout,
  validateGrokCompatibilityCarrier,
} from './lib/grok-compatibility-carrier.mjs';
import { git, parsePorcelainV1Z } from './lib/git.mjs';

const AGY_VERSION_TIMEOUT_MS = 3000;
const AGY_VERSION_MAX_CHARS = 256;
const GROK_COMPATIBILITY_TIMEOUT_MS = 3000;
const EMPTY_GIT_FIELDS = Object.freeze({
  staged: 0,
  unstaged: 0,
  untracked: 0,
  has_untracked: false,
  review_base: '',
  review_base_method: '',
  is_shallow: false,
});

function firstLine(buffer) {
  return buffer.toString('utf8').split(/\r?\n/, 1)[0].trim();
}

function boundedProbeVersion(buffer) {
  return firstLine(buffer)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .slice(0, AGY_VERSION_MAX_CHARS);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function incompatibleGrok() {
  return {
    grok_cli: false,
    grok_cli_path: '',
    grok_version: '',
    grok_compatibility_verified: false,
    grok_compatibility_evidence: null,
    grok_unavailable_reason: 'incompatible_grok_cli',
  };
}

function successfulProbe(result) {
  return result
    && result.code === 0
    && result.timedOut !== true
    && result.captureOverflow !== true;
}

function mismatchedPreparedChain(result) {
  return Boolean(result) && result.preparedChainMismatch === true;
}

function probeStdout(result) {
  const bytes = Buffer.isBuffer(result.stdout)
    ? Buffer.from(result.stdout)
    : Buffer.from(result.stdout || '');
  return {
    bytes,
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  };
}

async function detectGrokCompatibility(cwd, env, processRunner) {
  const grokPath = resolveExecutable('grok', env) || '';
  if (!grokPath) return incompatibleGrok();

  try {
    const versionPreparation = prepareSpawnChain(grokPath, ['--version'], { cwd, env });
    const helpPreparation = prepareSpawnChain(grokPath, ['--help'], { cwd, env });
    if (!versionPreparation.ok || !helpPreparation.ok) return incompatibleGrok();
    const versionChain = versionPreparation.prepared_spawn_chain;
    const helpChain = helpPreparation.prepared_spawn_chain;
    if (versionChain.chain_sha256 !== helpChain.chain_sha256) return incompatibleGrok();

    const optionsFor = (preparedSpawnChain) => ({
      cwd,
      env,
      timeoutMs: GROK_COMPATIBILITY_TIMEOUT_MS,
      maxCaptureBytesPerStream: PROBE_MAX_CAPTURE_BYTES_PER_STREAM,
      maxCaptureBytesTotal: PROBE_MAX_CAPTURE_BYTES_TOTAL,
      expectedPreparedSpawnChain: preparedSpawnChain,
    });
    let versionResult;
    let helpResult;
    try {
      versionResult = await processRunner(
        grokPath,
        ['--version'],
        optionsFor(versionChain),
      );
    } catch {
      versionResult = null;
    }
    try {
      helpResult = await processRunner(
        grokPath,
        ['--help'],
        optionsFor(helpChain),
      );
    } catch {
      helpResult = null;
    }
    // The runner reprepares the sealed chain in the same call as its spawn. A
    // replacement present before that comparison reaches no child, and its
    // closed result maps here — and only here — to an incompatible Grok CLI.
    if (mismatchedPreparedChain(versionResult) || mismatchedPreparedChain(helpResult)) {
      return incompatibleGrok();
    }
    if (!successfulProbe(versionResult) || !successfulProbe(helpResult)) {
      return incompatibleGrok();
    }

    const versionOutput = probeStdout(versionResult);
    const helpOutput = probeStdout(helpResult);
    const parsedVersion = parseGrokCompatibilityStdout(versionOutput.text, 'version');
    const parsedHelp = parseGrokCompatibilityStdout(helpOutput.text, 'help');
    const launcher = versionChain.launcher;
    const evidenceBody = {
      schema_version: '1.0',
      launcher_path: launcher.path,
      real_path: launcher.real_path,
      platform_identity: launcher.platform_identity,
      executable_sha256: launcher.sha256,
      executable_size: launcher.size,
      prepared_spawn_chain: versionChain,
      version: parsedVersion.version,
      version_build: parsedVersion.version_build,
      version_banner_sha256: sha256(versionOutput.bytes),
      help_sha256: sha256(helpOutput.bytes),
      help_size: helpOutput.bytes.length,
      required_help_flags: parsedHelp.required_help_flags,
    };
    const evidence = validateGrokCompatibilityCarrier({
      ...evidenceBody,
      evidence_sha256: sha256(Buffer.from(canonicalStringify(evidenceBody), 'utf8')),
    });
    return {
      grok_cli: true,
      grok_cli_path: evidence.launcher_path,
      grok_version: evidence.version,
      grok_compatibility_verified: true,
      grok_compatibility_evidence: evidence,
    };
  } catch (error) {
    if (error?.grokVersionRejection) {
      return {
        grok_cli: false,
        grok_cli_path: grokPath,
        grok_version: error.grokVersionRejection.observed,
        grok_compatibility_verified: false,
        grok_compatibility_evidence: null,
        grok_unavailable_reason: 'unsupported_grok_cli_version',
        grok_supported_versions: error.grokVersionRejection.supported,
      };
    }
    return incompatibleGrok();
  }
}

function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function parseSemver(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  };
}

function compareCompanions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left.version[key] !== right.version[key]) {
      return left.version[key] - right.version[key];
    }
  }
  if (Boolean(left.version.prerelease) !== Boolean(right.version.prerelease)) {
    return left.version.prerelease ? -1 : 1;
  }
  if (left.version.prerelease !== right.version.prerelease) {
    return left.version.prerelease < right.version.prerelease ? -1 : 1;
  }
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

function collectCompanions(cacheRoot) {
  if (!cacheRoot) return [];
  const versionRoot = join(cacheRoot, 'plugins', 'cache', 'openai-codex', 'codex');
  let entries;
  try {
    entries = readdirSync(versionRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const version = parseSemver(entry.name);
    if (!version) continue;
    const filePath = join(versionRoot, entry.name, 'scripts', 'codex-companion.mjs');
    if (isRegularFile(filePath)) candidates.push({ path: filePath, version });
  }
  return candidates;
}

function findCodexCompanion(env) {
  if (env.CODEX_COMPANION_PATH && isRegularFile(env.CODEX_COMPANION_PATH)) {
    return resolve(env.CODEX_COMPANION_PATH);
  }
  const home = env.HOME || env.USERPROFILE;
  const candidates = [
    ...collectCompanions(env.CODEX_HOME),
    ...collectCompanions(home ? join(home, '.claude') : ''),
  ];
  candidates.sort(compareCompanions);
  return candidates.at(-1)?.path || '';
}

async function detectAvailability(cwd, env, processRunner, grokCandidate) {
  const claudePath = resolveExecutable('claude', env) || '';
  const codexPath = resolveExecutable('codex', env) || '';
  let agyPath = resolveExecutable('agy', env) || '';
  const companionPath = findCodexCompanion(env);
  let agyVersion = '';
  if (agyPath) {
    const version = await processRunner(agyPath, ['--version'], {
      cwd,
      env,
      timeoutMs: AGY_VERSION_TIMEOUT_MS,
      maxCaptureBytesPerStream: PROBE_MAX_CAPTURE_BYTES_PER_STREAM,
      maxCaptureBytesTotal: PROBE_MAX_CAPTURE_BYTES_TOTAL,
    });
    if (version.code === 0 && !version.timedOut && version.captureOverflow !== true) {
      agyVersion = boundedProbeVersion(version.stdout);
    }
    if (version.captureOverflow === true) agyPath = '';
  }
  const grok = grokCandidate
    ? await detectGrokCompatibility(cwd, env, processRunner)
    : {};
  return {
    node_available: true,
    node_path: process.execPath,
    claude_cli: Boolean(claudePath),
    claude_cli_path: claudePath,
    codex_plugin: Boolean(companionPath),
    codex_companion_path: companionPath,
    codex_cli: Boolean(codexPath),
    codex_cli_path: codexPath,
    codex_installed: Boolean(companionPath || codexPath),
    agy_cli: Boolean(agyPath),
    agy_cli_path: agyPath,
    agy_version: agyVersion,
    ...grok,
  };
}

async function hasGitWorktree(cwd, env) {
  const result = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { env });
  return result.code === 0 && firstLine(result.stdout) === 'true';
}

async function hasHead(cwd, env) {
  const result = await git(cwd, ['rev-parse', '--verify', 'HEAD'], { env });
  return result.code === 0 && firstLine(result.stdout).length > 0;
}

function countChanges(records) {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const record of records) {
    if (record.index === '?' && record.workTree === '?') {
      untracked += 1;
      continue;
    }
    if (record.index !== ' ' && record.index !== '!') staged += 1;
    if (record.workTree !== ' ' && record.workTree !== '!') unstaged += 1;
  }
  let changeState = 'clean';
  if (staged > 0 && unstaged > 0) changeState = 'mixed';
  else if (staged > 0) changeState = 'staged';
  else if (unstaged > 0) changeState = 'unstaged';
  else if (untracked > 0) changeState = 'untracked-only';
  return {
    change_state: changeState,
    staged,
    unstaged,
    untracked,
    has_untracked: untracked > 0,
  };
}

async function determineReviewBase(cwd, env) {
  for (const remoteRef of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const verified = await git(cwd, ['rev-parse', '--verify', '--quiet', remoteRef], { env });
    if (verified.code !== 0) continue;
    const merged = await git(cwd, ['merge-base', 'HEAD', remoteRef], { env });
    const candidate = firstLine(merged.stdout);
    if (merged.code === 0 && candidate) {
      return { review_base: candidate, review_base_method: 'merge-base' };
    }
  }

  const countResult = await git(cwd, ['rev-list', '--count', 'HEAD'], { env });
  const count = Number(firstLine(countResult.stdout));
  if (countResult.code === 0 && Number.isInteger(count) && count > 1) {
    return { review_base: 'HEAD~1', review_base_method: 'head-parent' };
  }

  const emptyTree = await git(cwd, ['hash-object', '-t', 'tree', '--stdin'], {
    env,
    input: Buffer.alloc(0),
  });
  const reviewBase = firstLine(emptyTree.stdout);
  if (emptyTree.code !== 0 || !/^[0-9a-f]+$/.test(reviewBase)) {
    throw new Error(`failed to compute repository empty-tree hash: ${firstLine(emptyTree.stderr)}`);
  }
  return { review_base: reviewBase, review_base_method: 'empty-tree' };
}

async function detectShallow(cwd, env) {
  const result = await git(cwd, ['rev-parse', '--is-shallow-repository'], { env });
  if (result.code === 0) return firstLine(result.stdout) === 'true';

  const shallowPath = await git(cwd, ['rev-parse', '--git-path', 'shallow'], { env });
  const value = firstLine(shallowPath.stdout);
  return shallowPath.code === 0 && value.length > 0 && existsSync(resolve(cwd, value));
}

export async function detectEnvironment({
  cwd = process.cwd(),
  env = process.env,
  processRunner = runProcess,
  grokCandidate = false,
} = {}) {
  const workingDirectory = resolve(cwd);
  const common = {
    runtime_host: detectRuntimeHost(env),
    plugin_root: resolvePluginRoot({ env }),
    ...(await detectAvailability(workingDirectory, env, processRunner, grokCandidate === true)),
  };

  if (!(await hasGitWorktree(workingDirectory, env))) {
    return {
      ...common,
      is_git: false,
      has_commits: false,
      change_state: 'non-git',
      ...EMPTY_GIT_FIELDS,
    };
  }

  if (!(await hasHead(workingDirectory, env))) {
    return {
      ...common,
      is_git: true,
      has_commits: false,
      change_state: 'initial',
      ...EMPTY_GIT_FIELDS,
    };
  }

  const status = await git(
    workingDirectory,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { env },
  );
  if (status.code !== 0) {
    throw new Error(`failed to inspect Git status: ${firstLine(status.stderr)}`);
  }

  return {
    ...common,
    is_git: true,
    has_commits: true,
    ...countChanges(parsePorcelainV1Z(status.stdout)),
    ...(await determineReviewBase(workingDirectory, env)),
    is_shallow: await detectShallow(workingDirectory, env),
  };
}

function parseArguments(argv) {
  let cwd = process.cwd();
  let format = 'json';
  let grokCandidate = false;
  let grokCarrierFd;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--cwd') {
      if (!argv[index + 1]) throw new Error('--cwd requires a value');
      cwd = argv[index + 1];
      index += 1;
    } else if (argument === '--format') {
      if (!argv[index + 1]) throw new Error('--format requires a value');
      format = argv[index + 1];
      index += 1;
    } else if (argument === '--grok-candidate') {
      grokCandidate = true;
    } else if (argument === '--grok-carrier-fd') {
      const rawFd = argv[index + 1];
      if (!rawFd) throw new Error('--grok-carrier-fd requires a value');
      if (!/^\d+$/u.test(rawFd)) throw new Error('--grok-carrier-fd must be an integer greater than 2');
      grokCarrierFd = Number(rawFd);
      if (!Number.isSafeInteger(grokCarrierFd) || grokCarrierFd <= 2) {
        throw new Error('--grok-carrier-fd must be an integer greater than 2');
      }
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!['json', 'kv'].includes(format)) throw new Error('--format must be json or kv');
  if (grokCandidate && grokCarrierFd === undefined) {
    throw new Error('--grok-candidate requires --grok-carrier-fd <n>');
  }
  if (!grokCandidate && grokCarrierFd !== undefined) {
    throw new Error('--grok-carrier-fd requires --grok-candidate');
  }
  return { cwd, format, grokCandidate, grokCarrierFd };
}

function formatKv(result) {
  return `${Object.entries(result)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await detectEnvironment({
    cwd: options.cwd,
    env: process.env,
    grokCandidate: options.grokCandidate,
  });
  if (options.grokCandidate && result.grok_compatibility_verified === true) {
    const carrier = validateGrokCompatibilityCarrier(result.grok_compatibility_evidence);
    const frame = encodeGrokCompatibilityCarrierFrame(carrier);
    let offset = 0;
    while (offset < frame.length) {
      offset += writeSync(options.grokCarrierFd, frame, offset, frame.length - offset);
    }
  }
  process.stdout.write(options.format === 'json'
    ? `${JSON.stringify(result)}\n`
    : formatKv(result));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
