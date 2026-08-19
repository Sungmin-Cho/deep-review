import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { runProcess } from './process.mjs';
import {
  PROBE_MAX_CAPTURE_BYTES_PER_STREAM,
  PROBE_MAX_CAPTURE_BYTES_TOTAL,
} from './probe-limits.mjs';
import { readContainedFile, writeContainedFile } from './runtime-context.mjs';
import { ASSIGNMENT_ROLES } from './assignment-rubrics.mjs';
import {
  UNSUPPORTED_GROK_CONTAINMENT,
  isGrokContainmentPlatformSupported,
} from './grok-process-supervisor.mjs';

export const CAPABILITY_PROTOCOL_VERSION = '2.0';
export const CAPABILITY_CACHE_REVISION = '5';
export const MAX_PERSISTED_VERSION_CHARS = 256;
export const MAX_PERSISTED_HELP_CHARS = 4096;
export const MAX_CAPABILITY_CACHE_BYTES = 64 * 1024;
export const CODEX_EXEC_REQUIRED_HELP_FLAGS = Object.freeze([
  '--ephemeral',
  '--sandbox',
  '--ignore-user-config',
  '--ignore-rules',
  '--cd',
  '--skip-git-repo-check',
  '--output-last-message',
  '--color',
  '--model',
]);

const ALL_TARGETS = Object.freeze([
  'code-change', 'design-document', 'implementation-plan',
  'requirements-specification', 'architecture-decision-record', 'test-plan',
  'runbook-operations', 'research-note', 'configuration-infrastructure',
  'generic-document', 'generic-text-artifact', 'mixed',
]);
const REVIEW_ROLES = Object.freeze(['classifier', 'standard', 'adversarial', 'traceability', 'synthesizer']);

function assertion(value) {
  return value === true || value === false ? value : 'unknown';
}

export function parseVersion(output) {
  const text = sanitizeVersion(output);
  if (!text) return '';
  const match = /(?:^|[^0-9])v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.-])/u.exec(text);
  return match?.[1] || text.split(/\r?\n/u, 1)[0].trim();
}

function stripUnsafeControls(value) {
  return String(value || '').replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu,
    '',
  );
}

function sanitizeVersion(value) {
  return stripUnsafeControls(value)
    .split(/\r?\n/u, 1)[0]
    .trim()
    .slice(0, MAX_PERSISTED_VERSION_CHARS);
}

function sanitizeHelp(value) {
  return stripUnsafeControls(value).slice(0, MAX_PERSISTED_HELP_CHARS);
}

function helpHasFlag(help, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|[\\s,[\\(])${escaped}(?=$|[\\s,=\\]>)])`, 'mu').test(help);
}

export function codexExecHelpSupported(help) {
  const text = String(help || '');
  return CODEX_EXEC_REQUIRED_HELP_FLAGS.every((flag) => helpHasFlag(text, flag))
    && helpHasFlag(text, '-c');
}

export function detectEffortTransport(help, probeSucceeded = true) {
  if (!probeSucceeded) return 'unknown';
  const text = String(help || '');
  const flag = /(?:^|\s)(--(?:effort|thinking-effort|reasoning-effort))(?:[=\s,]|$)/imu.exec(text);
  if (flag) return `flag:${flag[1]}`;
  const environment = /\b(CLAUDE_(?:CODE_)?EFFORT(?:_LEVEL)?)\b/u.exec(text);
  if (environment) return `env:${environment[1]}`;
  return 'none';
}

function baseCapability({ adapterId, provider, available, version = '', invocationModes, roles = REVIEW_ROLES,
  assignmentRoles = ASSIGNMENT_ROLES,
  modelSelection, effortSelection, structuredOutput = true, background = true,
  readOnlyEnforcement = 'process-contract', customPrompt = true, inlinePayload = true, repoRead = true,
  probeSuccess }) {
  return {
    protocol_version: CAPABILITY_PROTOCOL_VERSION,
    adapter_id: adapterId,
    provider,
    available,
    version,
    invocation_modes: invocationModes,
    target_kinds: [...ALL_TARGETS],
    roles: [...roles],
    assignment_roles: [...assignmentRoles],
    model_selection: modelSelection,
    effort_selection: effortSelection,
    structured_output: structuredOutput,
    background,
    read_only_enforcement: readOnlyEnforcement,
    custom_prompt: customPrompt,
    inline_payload: inlinePayload,
    repo_read: repoRead,
    ...(probeSuccess === undefined ? {} : { probe_success: probeSuccess }),
  };
}

function cliAvailable(detectedAvailable, probe) {
  if (!detectedAvailable) return false;
  if (probe?.ok === false) return false;
  if (probe?.ok === true) return true;
  return 'unknown';
}

function codexExecAvailable(detected, hostAssertion, probe) {
  const eligible = assertion(hostAssertion);
  if (eligible === false) return false;
  if (!detected.codex_cli || !isAbsolute(String(detected.codex_cli_path || ''))) return false;
  if (probe?.ok === false) return false;
  if (eligible === true && probe?.ok === true) return true;
  return 'unknown';
}

function failClosedOverflowProbe(probe) {
  if (!probe || typeof probe !== 'object') return {};
  if (probe.captureOverflow === true || probe.capture_overflow === true) {
    return { ...probe, ok: false };
  }
  return probe;
}

// D21 / I41 — the first owner of the shortfall-to-reason carrier. When the
// containment platform/arch gate is false there is no enforceable containment
// for a Grok provider tree on this host, and that reason is *sealed*: it is the
// containment-specific cause and no other absence cause may overwrite it.
// `model-router.mjs` carries it from here into the assignment planner.
function sealedGrokUnavailableReason(detected, containment) {
  if (!isGrokContainmentPlatformSupported(containment)) return UNSUPPORTED_GROK_CONTAINMENT;
  return typeof detected.grok_unavailable_reason === 'string'
    && detected.grok_unavailable_reason.length > 0
    ? detected.grok_unavailable_reason
    : null;
}

export function buildCapabilities({
  detected = {}, hostAssertions = {}, probes = {}, containment = {},
} = {}) {
  const claudeProbe = failClosedOverflowProbe(probes.claude);
  const rawCodexProbe = failClosedOverflowProbe(probes.codex);
  const codexProbe = rawCodexProbe.ok === true && !codexExecHelpSupported(rawCodexProbe.help)
    ? { ...rawCodexProbe, ok: false }
    : rawCodexProbe;
  const grokCompatible = detected.grok_cli === true
    && isAbsolute(String(detected.grok_cli_path || ''))
    && detected.grok_compatibility_verified === true;
  // D21 / I41 — the containment platform/arch gate is folded into the same D13
  // candidacy gate: a host with no enforceable containment for a Grok provider
  // tree advertises no available Grok capability, so no round can elect a Grok
  // seat on it and a `--grok` review fails whole through the sealed reason
  // rather than degrading to a runtime bridge refusal. The compatibility claims
  // below stay keyed to the verified executable, which containment never
  // changes; `available` refuses first, so no caller reaches them here.
  const grokAvailable = grokCompatible && isGrokContainmentPlatformSupported(containment);
  const grokUnavailableReason = sealedGrokUnavailableReason(detected, containment);
  return [
    baseCapability({
      adapterId: 'claude-native-agent', provider: 'claude',
      available: assertion(hostAssertions.claudeNativeAgent), invocationModes: ['agent'],
      modelSelection: { supported: true, aliases: ['haiku', 'sonnet', 'opus', 'best'], catalog_complete: false, transport: 'agent-parameter' },
      effortSelection: { supported: false, levels: [], transport: 'none' },
      background: false, readOnlyEnforcement: 'agent-tool-allowlist',
    }),
    baseCapability({
      adapterId: 'claude-cli', provider: 'claude',
      available: cliAvailable(detected.claude_cli, claudeProbe),
      version: parseVersion(claudeProbe.version), invocationModes: ['generic-review', 'agent'],
      modelSelection: { supported: true, aliases: ['haiku', 'sonnet', 'opus', 'best'], catalog_complete: false, transport: 'flag:--model' },
      effortSelection: {
        supported: claudeProbe.ok === true
          ? detectEffortTransport(claudeProbe.help, true) !== 'none'
          : 'unknown',
        levels: ['low', 'medium', 'high', 'xhigh', 'max'],
        transport: detectEffortTransport(claudeProbe.help, claudeProbe.ok === true),
      },
    }),
    baseCapability({
      adapterId: 'codex-exec', provider: 'codex',
      available: codexExecAvailable(detected, hostAssertions.codexExecReviewer, codexProbe),
      version: parseVersion(codexProbe.version), invocationModes: ['generic-review'],
      probeSuccess: codexProbe.ok === true,
      modelSelection: { supported: true, aliases: [], catalog_complete: false, transport: 'flag:--model' },
      effortSelection: {
        supported: true,
        levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        transport: 'config:model_reasoning_effort',
      },
      readOnlyEnforcement: 'process-contract',
    }),
    baseCapability({
      adapterId: 'codex-native-generic', provider: 'codex',
      available: assertion(hostAssertions.codexNativeGeneric), invocationModes: ['generic-review'],
      modelSelection: { supported: true, aliases: [], catalog_complete: false, transport: 'agent-parameter:model' },
      effortSelection: {
        supported: true,
        levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        transport: 'agent-parameter:reasoning_effort',
      },
      background: false,
      readOnlyEnforcement: 'instruction-and-fingerprint-rejection',
    }),
    baseCapability({
      adapterId: 'codex-companion', provider: 'codex', available: Boolean(detected.codex_plugin),
      version: '', invocationModes: ['code-review'], roles: ['standard', 'adversarial'],
      assignmentRoles: ['standard', 'adversarial'],
      modelSelection: { supported: false, aliases: [], catalog_complete: false, transport: 'none' },
      effortSelection: { supported: false, levels: [], transport: 'none' },
      structuredOutput: false, readOnlyEnforcement: 'companion-read-only', inlinePayload: false,
    }),
    baseCapability({
      adapterId: 'agy-cli', provider: 'agy', available: Boolean(detected.agy_cli),
      version: parseVersion(detected.agy_version), invocationModes: ['generic-review'],
      roles: ['standard', 'adversarial'],
      modelSelection: { supported: true, aliases: [], catalog_complete: false, transport: 'config:agy_model' },
      effortSelection: { supported: false, levels: [], transport: 'none' },
      structuredOutput: false, readOnlyEnforcement: 'privacy-preflight',
    }),
    {
      ...baseCapability({
        adapterId: 'grok-cli', provider: 'grok', available: grokAvailable,
        version: parseVersion(detected.grok_version), invocationModes: ['generic-review'],
        roles: ['standard', 'adversarial'],
        modelSelection: {
          supported: true,
          aliases: ['grok-4.6', 'grok-4.6', 'grok-4.6', 'grok-4.6'],
          catalog_complete: true,
          transport: 'flag:--model',
        },
        effortSelection: {
          supported: true,
          levels: ['low', 'medium', 'high'],
          transport: 'flag:--reasoning-effort',
        },
        structuredOutput: false,
        readOnlyEnforcement: grokCompatible ? 'permission-mode-plan' : 'none',
      }),
      grok_compatibility_evidence: grokCompatible
        ? detected.grok_compatibility_evidence ?? null
        : null,
      ...(grokUnavailableReason === null ? {} : { unavailable_reason: grokUnavailableReason }),
    },
  ];
}

function outputText(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
}

async function runProbe(executable, args, options) {
  if (!executable) return { ok: false, error: 'not-detected' };
  try {
    const result = await options.run(executable, args, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      maxCaptureBytesPerStream: PROBE_MAX_CAPTURE_BYTES_PER_STREAM,
      maxCaptureBytesTotal: PROBE_MAX_CAPTURE_BYTES_TOTAL,
    });
    if (result.captureOverflow === true) {
      return {
        ok: false,
        output: '',
        error: 'capture-overflow',
        timed_out: Boolean(result.timedOut),
        capture_overflow: true,
      };
    }
    return {
      ok: result.code === 0 && !result.timedOut,
      output: outputText(result.stdout),
      error: outputText(result.stderr),
      timed_out: Boolean(result.timedOut),
      capture_overflow: false,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export async function probeCapabilities({ detected = {}, cwd = process.cwd(), env = process.env,
  run = runProcess, timeoutMs = 3000 } = {}) {
  const options = { cwd, env, run, timeoutMs };
  const [claudeVersion, claudeHelp, codexVersion, codexExecHelp] = await Promise.all([
    runProbe(detected.claude_cli_path, ['--version'], options),
    runProbe(detected.claude_cli_path, ['--help'], options),
    runProbe(detected.codex_cli_path, ['--version'], options),
    runProbe(detected.codex_cli_path, ['exec', '--help'], options),
  ]);
  return {
    claude: {
      ok: claudeVersion.ok && claudeHelp.ok,
      version: claudeVersion.output,
      help: claudeHelp.output,
      error: claudeVersion.error || claudeHelp.error,
      capture_overflow: claudeVersion.capture_overflow === true
        || claudeHelp.capture_overflow === true,
    },
    codex: {
      ok: codexVersion.ok && codexExecHelp.ok
        && codexExecHelpSupported(codexExecHelp.output),
      version: codexVersion.output,
      help: codexExecHelp.output,
      error: codexVersion.error || codexExecHelp.error
        || (
          codexVersion.ok && codexExecHelp.ok && !codexExecHelpSupported(codexExecHelp.output)
            ? 'incompatible-codex-exec-help'
            : ''
        ),
      capture_overflow: codexVersion.capture_overflow === true
        || codexExecHelp.capture_overflow === true,
    },
  };
}

export function capabilityCacheKeys(detected = {}, probes = {}) {
  const entries = {};
  for (const [name, pathKey, probeKey] of [
    ['claude', 'claude_cli_path', 'claude'],
    ['codex', 'codex_cli_path', 'codex'],
    ['agy', 'agy_cli_path', 'agy'],
    ['grok', 'grok_cli_path', 'grok'],
  ]) {
    const executable = detected[pathKey];
    if (!executable) continue;
    let mtimeMs = null;
    try { mtimeMs = statSync(executable).mtimeMs; } catch { /* invalidates against a prior real file */ }
    const version = name === 'grok'
      ? probes.grok?.version || detected.grok_version
      : probes[probeKey]?.version || (name === 'agy' ? detected.agy_version : '');
    entries[name] = {
      path: resolve(executable),
      mtime_ms: mtimeMs,
      version: parseVersion(version),
    };
  }
  return entries;
}

function sameKeys(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function validInvalidationKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(['claude', 'codex', 'agy', 'grok']);
  return Object.entries(value).every(([name, key]) => (
    allowed.has(name)
    && hasExactKeys(key, ['mtime_ms', 'path', 'version'])
    && typeof key.path === 'string'
    && isAbsolute(key.path)
    && (key.mtime_ms === null || (typeof key.mtime_ms === 'number' && Number.isFinite(key.mtime_ms)))
    && typeof key.version === 'string'
    && key.version === sanitizeVersion(key.version)
  ));
}

function validProbeResults(value, invalidationKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(['claude', 'codex']);
  return Object.entries(value).every(([name, probe]) => {
    if (!allowed.has(name) || !Object.hasOwn(invalidationKeys, name)) return false;
    if (name === 'claude') {
      return hasExactKeys(probe, ['help', 'ok', 'version'])
        && probe.ok === true
        && typeof probe.version === 'string'
        && probe.version.length > 0
        && probe.version === sanitizeVersion(probe.version)
        && typeof probe.help === 'string'
        && probe.help === sanitizeHelp(probe.help);
    }
    return hasExactKeys(probe, ['help', 'ok', 'version'])
      && probe.ok === true
      && typeof probe.version === 'string'
      && probe.version.length > 0
      && probe.version === sanitizeVersion(probe.version)
      && typeof probe.help === 'string'
      && probe.help === sanitizeHelp(probe.help)
      && codexExecHelpSupported(probe.help);
  });
}

export function loadCapabilityCache(repoRoot, filePath, invalidationKeys) {
  try {
    const cache = JSON.parse(readContainedFile(repoRoot, filePath, {
      maxBytes: MAX_CAPABILITY_CACHE_BYTES,
    }).toString('utf8'));
    if (!hasExactKeys(cache, [
      'cache_contract_revision',
      'invalidation_keys',
      'probe_results',
      'protocol_version',
    ])
        || cache.protocol_version !== CAPABILITY_PROTOCOL_VERSION
        || cache.cache_contract_revision !== CAPABILITY_CACHE_REVISION
        || !validInvalidationKeys(cache.invalidation_keys)
        || !validInvalidationKeys(invalidationKeys)
        || !validProbeResults(cache.probe_results, cache.invalidation_keys)
        || !sameKeys(cache.invalidation_keys, invalidationKeys)) return null;
    return {
      invalidation_keys: structuredClone(cache.invalidation_keys),
      probe_results: structuredClone(cache.probe_results),
    };
  } catch {
    return null;
  }
}

export function saveCapabilityCache(repoRoot, filePath, probes, invalidationKeys) {
  if (!probes || typeof probes !== 'object' || Array.isArray(probes)) {
    throw new TypeError('probes must be an object');
  }
  if (!validInvalidationKeys(invalidationKeys)) {
    throw new TypeError('invalidationKeys must contain canonical executable keys');
  }
  if (Object.values(probes).some((probe) => (
    probe?.capture_overflow === true || probe?.captureOverflow === true
  ))) {
    throw new TypeError('probe capture overflow must never be persisted');
  }
  const probeResults = {};
  if (probes.claude?.ok === true) {
    probeResults.claude = {
      ok: true,
      version: sanitizeVersion(probes.claude.version),
      help: sanitizeHelp(probes.claude.help),
    };
  }
  if (probes.codex?.ok === true) {
    probeResults.codex = {
      ok: true,
      version: sanitizeVersion(probes.codex.version),
      help: sanitizeHelp(probes.codex.help),
    };
  }
  if (!validProbeResults(probeResults, invalidationKeys)) {
    throw new TypeError('probes must contain only successful canonical raw results');
  }
  const document = {
    protocol_version: CAPABILITY_PROTOCOL_VERSION,
    cache_contract_revision: CAPABILITY_CACHE_REVISION,
    invalidation_keys: invalidationKeys,
    probe_results: probeResults,
  };
  writeContainedFile(repoRoot, filePath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return filePath;
}
