import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const ROUTE_TASK = 'route_task.py';
const RELATIVE_CHECKOUT = '../deep-model-router';
const PERSONAL_MARKERS = ['/.claude/skills/model-router', '/.codex/skills/model-router'];
const CACHE_SUFFIX = '/skills/model-router/scripts/route_task.py';
const VERSION_RE = /\/deep-model-router\/([^/]+)\/skills\/model-router\/scripts\/route_task\.py$/;

function posix(path) {
  return String(path).replaceAll('\\', '/');
}

function isRouteTask(path) {
  try {
    return statSync(path).isFile() && basename(path) === ROUTE_TASK;
  } catch {
    return false;
  }
}

function isInstalledCacheRouteTask(path) {
  const text = posix(path);
  return VERSION_RE.test(text)
    && (text.includes('/.claude/plugins/cache/') || text.includes('/.codex/plugins/'));
}

function acceptRouteTask(path) {
  if (isForbiddenRelativeCheckout(path) || isPersonalSkillPath(path) || !isRouteTask(path)) {
    return null;
  }
  let resolved;
  try {
    resolved = realpathSync(path);
  } catch {
    return null;
  }
  if (basename(resolved) !== ROUTE_TASK) return null;
  if (isForbiddenRelativeCheckout(resolved) || isPersonalSkillPath(resolved)) return null;
  return resolved;
}

function isPersonalSkillPath(path) {
  const text = posix(path);
  return PERSONAL_MARKERS.some((marker) => text.includes(marker));
}

function isForbiddenRelativeCheckout(path) {
  return posix(path).includes(RELATIVE_CHECKOUT);
}

function parseSemver(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareCacheHits(left, right) {
  const leftVer = parseSemver(left.version);
  const rightVer = parseSemver(right.version);
  if (leftVer && rightVer) {
    for (let i = 0; i < 3; i++) {
      if (leftVer[i] !== rightVer[i]) return leftVer[i] - rightVer[i];
    }
    return 0;
  }
  if (leftVer) return 1;
  if (rightVer) return -1;
  return String(left.path).localeCompare(String(right.path));
}

function walkRouteTasks(root, hits, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walkRouteTasks(full, hits, depth + 1);
      continue;
    }
    if (entry.name !== ROUTE_TASK) continue;
    const text = posix(full);
    if (!text.includes('/deep-model-router/') || !text.endsWith(CACHE_SUFFIX)) continue;
    if (!isRouteTask(full) || isPersonalSkillPath(full)) continue;
    const version = text.match(VERSION_RE)?.[1];
    hits.push({ path: resolve(full), version: version || '' });
  }
}

function highestCacheHit(root) {
  const hits = [];
  walkRouteTasks(root, hits);
  if (hits.length === 0) return null;
  hits.sort(compareCacheHits);
  return hits[hits.length - 1].path;
}

// Host-neutral locator (design §11.5 / docs/locator.md). Consumers copy this
// order; they do not import the Python reference at runtime.
export function locateDeepModelRouter({
  env = process.env,
  home = homedir(),
  cwd = process.cwd(),
} = {}) {
  const cli = env?.DEEP_MODEL_ROUTER_CLI;
  if (cli) {
    const hit = acceptRouteTask(resolve(cwd || process.cwd(), cli));
    if (hit) return hit;
  }

  const root = env?.DEEP_MODEL_ROUTER_ROOT;
  if (root) {
    const hit = acceptRouteTask(join(root, 'skills', 'model-router', 'scripts', ROUTE_TASK));
    if (hit && isInstalledCacheRouteTask(hit)) return hit;
  }

  const claude = highestCacheHit(join(home, '.claude', 'plugins', 'cache'));
  if (claude) return claude;
  return highestCacheHit(join(home, '.codex', 'plugins'));
}
