import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isTargetKind, SCOPE_KIND_MIXED } from './target-taxonomy.mjs';

const KNOWN = Object.freeze({
  schema_version: null,
  features: {
    semantic_classifier: null,
    adaptive_reviewer_routing: null,
    automatic_model_routing: null,
    routing_shadow_mode: null,
    suite_model_resolver: null,
  },
  classification: {
    mode: null,
    thresholds: null,
    size_thresholds: null,
    max_classifier_bytes_per_artifact: null,
    overrides: null,
  },
  routing: {
    policy: null,
    reviewer_strategy: null,
    allow_fallback: null,
    require_read_only: null,
    reviewers: null,
    document_round_limit: null,
    high_risk_document_round_limit: null,
    maximum_reviewers: null,
    max_expansion_waves: null,
  },
  providers: null,
  constraints: null,
});

function stripComment(value) {
  let single = false;
  let double = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (double) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') double = false;
    } else if (single) {
      if (character === "'" && value[index + 1] === "'") index += 1;
      else if (character === "'") single = false;
    } else if (character === '"') double = true;
    else if (character === "'") single = true;
    else if (character === '#' && (index === 0 || /\s/u.test(value[index - 1]))) return value.slice(0, index);
  }
  return value;
}

function rejectUnsafeYaml(raw, lineNumber) {
  const value = raw.trim();
  if (/^(?:[&*][^\s]+)(?:\s|$)/u.test(value) || /\s[&*][A-Za-z0-9_-]+(?:\s|$)/u.test(value)) {
    throw new Error(`YAML anchor or alias is not supported at line ${lineNumber}`);
  }
  if (/^![^\s]+(?:\s|$)/u.test(value)) throw new Error(`YAML custom tag is not supported at line ${lineNumber}`);
  if (/^[|>][+-]?$/u.test(value)) throw new Error(`YAML block scalars are not supported at line ${lineNumber}`);
}

function scalar(raw, lineNumber) {
  const value = stripComment(raw).trim();
  rejectUnsafeYaml(value, lineNumber);
  if (value === '') return undefined;
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)) return Number(value);
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { throw new Error(`invalid quoted scalar at line ${lineNumber}`); }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error(`invalid quoted scalar at line ${lineNumber}`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value.replace(/'([^']*)'/gu, (_, item) => JSON.stringify(item)));
      if (!Array.isArray(parsed)) throw new Error('not array');
      return parsed;
    } catch { throw new Error(`unsupported flow sequence at line ${lineNumber}`); }
  }
  if (value.startsWith('{')) throw new Error(`unsupported flow mapping at line ${lineNumber}`);
  return value;
}

const UNSAFE_MAPPING_KEY = /^(?:__proto__|constructor|prototype)$/u;

function keyValue(text, lineNumber) {
  const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(text);
  if (!match) throw new Error(`invalid YAML mapping at line ${lineNumber}`);
  const { 1: key } = match;
  if (UNSAFE_MAPPING_KEY.test(key)) throw new Error(`unsafe mapping key "${key}" at line ${lineNumber}`);
  return { key, rawValue: match[2] };
}

export function parseYamlSubset(source) {
  if (typeof source !== 'string') throw new TypeError('policy YAML must be a string');
  const records = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')
    .map((body, index) => ({ body, lineNumber: index + 1 }))
    .filter(({ body }) => body.trim() !== '' && !body.trimStart().startsWith('#'))
    .map(({ body, lineNumber }) => {
      if (/\t/u.test(body.slice(0, body.length - body.trimStart().length))) {
        throw new Error(`tabs are not supported for indentation at line ${lineNumber}`);
      }
      const indent = body.length - body.trimStart().length;
      if (indent % 2 !== 0) throw new Error(`indentation must use two spaces at line ${lineNumber}`);
      return { indent, text: body.trimStart(), lineNumber };
    });

  function parseBlock(start, indent, arrayMode = records[start]?.text.startsWith('- ') ?? false) {
    const container = arrayMode ? [] : {};
    const keys = new Set();
    let index = start;
    while (index < records.length) {
      const record = records[index];
      if (record.indent < indent) break;
      if (record.indent > indent) throw new Error(`unexpected indentation at line ${record.lineNumber}`);
      if (arrayMode) {
        if (!record.text.startsWith('-')) break;
        const itemText = record.text.slice(1).trimStart();
        if (itemText === '') {
          if (!records[index + 1] || records[index + 1].indent <= indent) throw new Error(`empty list item at line ${record.lineNumber}`);
          const child = parseBlock(index + 1, indent + 2);
          container.push(child.value);
          index = child.next;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/u.test(itemText)) {
          const item = {};
          const first = keyValue(itemText, record.lineNumber);
          item[first.key] = scalar(first.rawValue, record.lineNumber);
          index += 1;
          while (index < records.length && records[index].indent === indent + 2 && !records[index].text.startsWith('-')) {
            const part = keyValue(records[index].text, records[index].lineNumber);
            if (Object.hasOwn(item, part.key)) throw new Error(`duplicate key ${part.key} at line ${records[index].lineNumber}`);
            const parsed = scalar(part.rawValue, records[index].lineNumber);
            if (parsed === undefined && records[index + 1]?.indent > indent + 2) {
              const child = parseBlock(index + 1, indent + 4);
              item[part.key] = child.value;
              index = child.next;
            } else {
              item[part.key] = parsed;
              index += 1;
            }
          }
          container.push(item);
          continue;
        }
        container.push(scalar(itemText, record.lineNumber));
        index += 1;
        continue;
      }

      if (record.text.startsWith('-')) break;
      const { key, rawValue } = keyValue(record.text, record.lineNumber);
      if (keys.has(key)) throw new Error(`duplicate key ${key} at line ${record.lineNumber}`);
      keys.add(key);
      const parsed = scalar(rawValue, record.lineNumber);
      if (parsed === undefined) {
        const next = records[index + 1];
        if (!next || next.indent <= indent) {
          container[key] = {};
          index += 1;
        } else {
          const child = parseBlock(index + 1, indent + 2);
          container[key] = child.value;
          index = child.next;
        }
      } else {
        container[key] = parsed;
        index += 1;
      }
    }
    return { value: container, next: index };
  }

  if (records.length === 0) return {};
  if (records[0].indent !== 0 || records[0].text.startsWith('-')) throw new Error('policy root must be a mapping');
  const parsed = parseBlock(0, 0);
  if (parsed.next !== records.length) throw new Error(`invalid YAML structure at line ${records[parsed.next].lineNumber}`);
  return parsed.value;
}

function collectWarnings(value, schema = KNOWN, prefix = '', warnings = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || schema === null) return warnings;
  for (const [key, child] of Object.entries(value)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(schema, key)) warnings.push(`unknown review-policy field preserved: ${dotted}`);
    else collectWarnings(child, schema[key], dotted, warnings);
  }
  return warnings;
}

function validateAdaptivePolicy(policy) {
  for (const key of [
    'adaptive_reviewer_routing',
    'automatic_model_routing',
    'routing_shadow_mode',
    'suite_model_resolver',
  ]) {
    if (policy.features?.[key] !== undefined && typeof policy.features[key] !== 'boolean') {
      throw new Error(`review policy features.${key} must be boolean`);
    }
  }
  if (policy.routing?.reviewer_strategy !== undefined
      && !['adaptive', 'static'].includes(policy.routing.reviewer_strategy)) {
    throw new Error('review policy routing.reviewer_strategy must be adaptive or static');
  }
  for (const key of ['document_round_limit', 'high_risk_document_round_limit']) {
    const value = policy.routing?.[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`review policy routing.${key} must be a positive integer`);
    }
  }
  const maximumReviewers = policy.routing?.maximum_reviewers;
  if (maximumReviewers !== undefined
      && (!Number.isInteger(maximumReviewers) || maximumReviewers < 1 || maximumReviewers > 4)) {
    throw new Error('review policy routing.maximum_reviewers must be an integer from 1 through 4');
  }
  const expansionWaves = policy.routing?.max_expansion_waves;
  if (expansionWaves !== undefined
      && (!Number.isInteger(expansionWaves) || expansionWaves < 0 || expansionWaves > 1)) {
    throw new Error('review policy routing.max_expansion_waves must be 0 or 1');
  }
  const overrides = policy.classification?.overrides;
  if (overrides !== undefined) {
    if (!Array.isArray(overrides)) {
      throw new Error('review policy classification.overrides must be an array');
    }
    for (const [index, override] of overrides.entries()) {
      if (!override || typeof override !== 'object' || Array.isArray(override)
          || Object.keys(override).some((key) => !['glob', 'kind'].includes(key))
          || typeof override.glob !== 'string'
          || override.glob.length === 0
          || override.glob.length > 4096
          || override.glob.includes('\0')
          || typeof override.kind !== 'string'
          || !isTargetKind(override.kind)
          || override.kind === SCOPE_KIND_MIXED) {
        throw new Error(`review policy classification.overrides[${index}] is invalid`);
      }
    }
  }
}

export function parseReviewPolicy(source) {
  const policy = parseYamlSubset(source);
  if (policy.schema_version !== 2) throw new Error('review policy schema_version must be 2');
  validateAdaptivePolicy(policy);
  return { policy, warnings: collectWarnings(policy) };
}

export function loadReviewPolicy(repoRoot) {
  const filePath = path.resolve(repoRoot, '.deep-review', 'review-policy.yaml');
  return existsSync(filePath) ? { ...parseReviewPolicy(readFileSync(filePath, 'utf8')), path: filePath } : null;
}

export function userConfigPath(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base = env.APPDATA || path.win32.join(env.USERPROFILE || homedir(), 'AppData', 'Roaming');
    return path.win32.join(base, 'deep-review', 'config.yaml');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), '.config'), 'deep-review', 'config.yaml');
}

export function loadUserConfig(env = process.env, platform = process.platform) {
  const filePath = userConfigPath(env, platform);
  return existsSync(filePath) ? { ...parseReviewPolicy(readFileSync(filePath, 'utf8')), path: filePath } : null;
}

function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return overlay === undefined ? base : overlay;
  const result = base && typeof base === 'object' && !Array.isArray(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(overlay)) result[key] = deepMerge(result[key], value);
  return result;
}

export function mergeRoutingConfig({ defaults = {}, user = {}, project = {}, cli = {} } = {}) {
  const cliPolicy = cli.routing_policy === undefined ? {} : { routing: { policy: cli.routing_policy } };
  const cliStrategy = cli.reviewer_strategy === undefined
    ? {}
    : { routing: { reviewer_strategy: cli.reviewer_strategy } };
  const normalizedCli = deepMerge(deepMerge(cliPolicy, cliStrategy), {
    routing: cli.allow_fallback === undefined ? {} : { allow_fallback: cli.allow_fallback },
    providers: cli.providers,
    reviewers: cli.reviewers,
  });
  let merged = deepMerge(deepMerge(deepMerge(defaults, user), project), normalizedCli);
  if (project.constraints !== undefined) {
    merged = deepMerge(merged, { constraints: project.constraints });
    merged.constraints = structuredClone(project.constraints);
  }
  return merged;
}
