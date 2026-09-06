import { createHash } from 'node:crypto';

// Ranged citation `path:START-END` — and comma-separated multi-range spans like
// `path:1-2, 83-100` — are captured with only the FIRST range's START line
// (mirrors loop-state.mjs `firstLocationToken`). The trailing
// `(?:\s*,\s*\d+(?:-\d+)?)*` consumes any additional ranges inside the same
// backticks so they neither break the match nor mint phantom findings.
const BACKTICKED_LOCATION = /`([^`\r\n]+):(\d+)(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*`/gu;
const BARE_LOCATION = /(?:^|[\s(])((?:[A-Za-z0-9_.-]+[\\/])*[A-Za-z0-9_.-]+):(\d+)(?=$|[\s,.)])/gu;
// Strips an already-captured backticked location (ranged and multi-range suffix
// included) so the bare pass never re-matches a quoted path's digits — or a
// trailing range's digits — as prose.
const QUOTED_LOCATION_STRIP = /`[^`\r\n]+:\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*`/gu;
const SUMMARY_ISSUES = /^- \*\*Issues\*\*:\s*🔴\s*(\d+)건,\s*🟡\s*(\d+)건,\s*ℹ️?\s*(\d+)건\s*$/gmu;
const MATERIAL_HEADINGS = Object.freeze({
  '### 🔴 Critical': 'critical',
  '### 🟡 Warning': 'warning',
});

/**
 * A bare (non-backtick) `path:line` token is only a real location if the path
 * component looks like a path: it must contain a directory separator or end
 * in a filename-shaped extension. This rejects unquoted prose like
 * 'backoff at 3:30' (path='3') from registering as a phantom finding.
 */
function isPathLikeToken(pathText) {
  if (/[\\/]/u.test(pathText)) return true;
  return /\.[A-Za-z][A-Za-z0-9]*$/u.test(pathText);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${label} must not contain NUL`);
  }
}

function stripDotSegments(pathText) {
  const segments = pathText.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  return segments.join('/');
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeFindingPath(rawPath, options) {
  if (hasUnpairedSurrogate(rawPath) || rawPath.includes('\0')) return null;
  const slashPath = rawPath.replace(/\\/gu, '/');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(slashPath)) return null;
  const segments = slashPath.split('/');
  if (segments.some((segment) => segment === '..')) return null;

  const platform = options.platform ?? process.platform;
  const isAbsolute = slashPath.startsWith('/') || /^[A-Za-z]:\//u.test(slashPath);
  if (isAbsolute) {
    if (typeof options.repoRoot !== 'string' || options.repoRoot.length === 0) return null;
    const root = options.repoRoot.replace(/\\/gu, '/').replace(/\/+$/u, '');
    const compare = (value) => (platform === 'win32' ? value.toLowerCase() : value);
    if (!(compare(slashPath) === compare(root) || compare(slashPath).startsWith(`${compare(root)}/`))) {
      return null;
    }
  }

  try {
    const normalized = canonicalizeRepoPath(rawPath, {
      repoRoot: options.repoRoot,
      platform,
      caseFold: true,
    });
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function locationMatches(lineText) {
  const quoted = [...lineText.matchAll(BACKTICKED_LOCATION)].map((match) => ({
    rawPath: match[1],
    line: Number(match[2]),
    index: match.index,
  }));
  const withoutQuotedPaths = lineText.replace(QUOTED_LOCATION_STRIP, (match) => ' '.repeat(match.length));
  const bare = [...withoutQuotedPaths.matchAll(BARE_LOCATION)]
    .filter((match) => isPathLikeToken(match[1]))
    .map((match) => ({
      rawPath: match[1],
      line: Number(match[2]),
      index: match.index + (match[0].length - match[1].length - match[2].length - 1),
    }));
  return [...quoted, ...bare].sort((left, right) => left.index - right.index);
}

function normalizeClaim(rawBullet) {
  if (hasUnpairedSurrogate(rawBullet) || rawBullet.includes('\0')) return null;
  let claim = rawBullet.normalize('NFKC');
  claim = claim.replace(QUOTED_LOCATION_STRIP, ' ');
  claim = claim.replace(BARE_LOCATION, (match, pathText) => {
    if (!isPathLikeToken(pathText)) return match;
    return /^\s/u.test(match) ? ' ' : match.startsWith('(') ? '(' : '';
  });
  claim = claim
    .replace(/!\[([^\]]*)\]\([^\r\n)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^\r\n)]*\)/gu, '$1')
    .replace(/\*\*([^*\r\n]+)\*\*/gu, '$1')
    .replace(/__([^_\r\n]+)__/gu, '$1')
    .replace(/~~([^~\r\n]+)~~/gu, '$1')
    .replace(/`([^`\r\n]+)`/gu, '$1')
    .replace(/^\s*\[(?:[CWI]\d+|(?:critical|warning|info)[-_ ]?\d+)\]\s*[:.)-]?\s*/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return claim;
}

function materialRegion(markdown, reasons) {
  const headings = [...markdown.matchAll(/^## Code Review[ \t]*$/gmu)];
  if (headings.length !== 1) {
    reasons.push(`code_review_heading_count:${headings.length}`);
    return markdown;
  }
  if (headings[0][0] !== '## Code Review') reasons.push('malformed_code_review_heading');
  const start = headings[0].index + headings[0][0].length;
  const rest = markdown.slice(start);
  const nextHeading = /^## (?!#)/mu.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

function summaryRegion(markdown, reasons) {
  const headings = [...markdown.matchAll(/^## Summary[ \t]*$/gmu)];
  if (headings.length !== 1) {
    reasons.push(`summary_heading_count:${headings.length}`);
    return markdown;
  }
  if (headings[0][0] !== '## Summary') reasons.push('malformed_summary_heading');
  const start = headings[0].index + headings[0][0].length;
  const rest = markdown.slice(start);
  const nextHeading = /^## (?!#)/mu.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

function parseMaterialSections(markdown, reasons) {
  const region = materialRegion(markdown, reasons);
  const headings = [...region.matchAll(/^###[ \t]+.*$/gmu)];
  const sections = { critical: [], warning: [] };
  for (const [heading, severity] of Object.entries(MATERIAL_HEADINGS)) {
    const icon = severity === 'critical' ? '🔴' : '🟡';
    const label = severity === 'critical' ? 'Critical' : 'Warning';
    const candidatePattern = new RegExp(`^###[ \\t]+${icon}[ \\t]+${label}\\b.*$`, 'iu');
    const matches = headings.filter((match) => candidatePattern.test(match[0]));
    if (matches.length !== 1) {
      reasons.push(`section_heading_count:${severity}:${matches.length}`);
      continue;
    }
    const match = matches[0];
    if (match[0] !== heading) reasons.push(`malformed_section_heading:${severity}`);
    const start = match.index + match[0].length;
    const next = headings.find((candidate) => candidate.index > match.index);
    const body = region.slice(start, next?.index ?? region.length);
    const nonempty = body.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const bullets = nonempty.filter((line) => /^- /u.test(line));
    const noneLines = nonempty.filter((line) => line === 'None.');
    const malformed = nonempty.filter((line) => !/^- /u.test(line) && line !== 'None.');
    if (malformed.length > 0 || noneLines.length > 1 || (noneLines.length > 0 && bullets.length > 0)) {
      reasons.push(`malformed_section:${severity}`);
    }
    sections[severity] = bullets.map((line) => line.slice(2));
  }
  return sections;
}

function summaryCounts(markdown, reasons) {
  const matches = [...summaryRegion(markdown, reasons).matchAll(SUMMARY_ISSUES)];
  if (matches.length !== 1) {
    reasons.push(`summary_issues_count:${matches.length}`);
    return null;
  }
  return { critical: Number(matches[0][1]), warning: Number(matches[0][2]) };
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Extract stable material observations from the canonical reviewer Markdown.
 * A bullet is one observation; its citations are evidence locations. The
 * parser retains malformed observations and marks the whole state
 * indeterminate instead of converting missing evidence into zero findings.
 */
export function extractFindingState(markdown, options = {}) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');
  const reasons = [];
  const counts = summaryCounts(markdown, reasons);
  const sections = parseMaterialSections(markdown, reasons);
  const findings = [];

  for (const severity of ['critical', 'warning']) {
    for (let index = 0; index < sections[severity].length; index += 1) {
      const ordinal = index + 1;
      const rawBullet = sections[severity][index];
      const claim = normalizeClaim(rawBullet);
      if (claim === null) addReason(reasons, `ambiguous_claim:${severity}:${ordinal}`);
      if (claim === '') addReason(reasons, `empty_claim:${severity}:${ordinal}`);

      let ambiguousPath = false;
      const locations = [];
      for (const match of locationMatches(rawBullet)) {
        const path = normalizeFindingPath(match.rawPath, options);
        if (path === null || !Number.isSafeInteger(match.line) || match.line <= 0) {
          ambiguousPath = true;
          continue;
        }
        locations.push({ path, line: match.line });
      }
      if (ambiguousPath) addReason(reasons, `ambiguous_path:${severity}:${ordinal}`);
      if (locations.length === 0) addReason(reasons, `missing_location:${severity}:${ordinal}`);

      const normalizedClaim = claim ?? rawBullet;
      const primaryLocation = locations[0] ?? null;
      const claimKey = sha256(`${normalizedClaim}\0${primaryLocation?.path ?? ''}`);
      findings.push({
        finding_id: `F-${claimKey}`,
        claim_key: claimKey,
        claim: normalizedClaim,
        severity,
        locations,
        primary_location: primaryLocation,
        title_slug: titleSlug(normalizedClaim),
      });
    }
  }

  if (counts) {
    for (const severity of ['critical', 'warning']) {
      if (counts[severity] !== sections[severity].length) {
        addReason(
          reasons,
          `summary_count_mismatch:${severity}:${counts[severity]}:${sections[severity].length}`,
        );
      }
    }
  }

  const keyCounts = new Map();
  for (const finding of findings) {
    keyCounts.set(finding.claim_key, (keyCounts.get(finding.claim_key) ?? 0) + 1);
  }
  for (const [key, count] of keyCounts) {
    if (count > 1) addReason(reasons, `duplicate_claim_key:${key}`);
  }

  return {
    schema_version: 1,
    status: reasons.length === 0 ? 'complete' : 'indeterminate',
    expected_count: counts ? counts.critical + counts.warning : findings.length,
    reasons,
    findings,
  };
}

function uniqueFindingsByKey(state) {
  const counts = new Map();
  for (const finding of state?.findings ?? []) {
    counts.set(finding.claim_key, (counts.get(finding.claim_key) ?? 0) + 1);
  }
  return new Map(
    (state?.findings ?? [])
      .filter((finding) => counts.get(finding.claim_key) === 1)
      .map((finding) => [finding.claim_key, finding]),
  );
}

function assertFindingState(state, label) {
  const fail = () => {
    throw new TypeError(`${label} must be a FindingStateV1 object`);
  };
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail();
  if (state.schema_version !== 1 || !['complete', 'indeterminate'].includes(state.status)) fail();
  if (!Number.isSafeInteger(state.expected_count) || state.expected_count < 0) fail();
  if (!Array.isArray(state.reasons) || state.reasons.some((reason) => typeof reason !== 'string')) fail();
  if (!Array.isArray(state.findings)) fail();
  if ((state.status === 'complete' && state.reasons.length !== 0)
    || (state.status === 'indeterminate' && state.reasons.length === 0)) fail();
  if (state.status === 'complete' && state.expected_count !== state.findings.length) fail();
  const keys = new Set();
  for (const finding of state.findings) {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) fail();
    if (!/^F-[0-9a-f]{64}$/u.test(finding.finding_id)) fail();
    if (!/^[0-9a-f]{64}$/u.test(finding.claim_key)) fail();
    if (typeof finding.claim !== 'string' || typeof finding.title_slug !== 'string') fail();
    if (state.status === 'complete'
      && (hasUnpairedSurrogate(finding.claim) || finding.claim.includes('\0'))) fail();
    if (!['critical', 'warning'].includes(finding.severity) || !Array.isArray(finding.locations)) fail();
    for (const location of finding.locations) {
      if (!location || typeof location.path !== 'string'
        || location.path.length === 0 || location.path.includes('\0')
        || !Number.isSafeInteger(location.line) || location.line <= 0) fail();
    }
    if (finding.primary_location !== null) {
      if (!finding.primary_location || typeof finding.primary_location.path !== 'string'
        || !Number.isSafeInteger(finding.primary_location.line)
        || finding.primary_location.line <= 0) fail();
    }
    if ((finding.locations.length === 0) !== (finding.primary_location === null)) fail();
    if (finding.primary_location !== null
      && (finding.primary_location.path !== finding.locations[0].path
        || finding.primary_location.line !== finding.locations[0].line)) fail();
    if (finding.finding_id !== `F-${finding.claim_key}`) fail();
    if (finding.claim_key !== sha256(`${finding.claim}\0${finding.primary_location?.path ?? ''}`)) fail();
    if (state.status === 'complete' && keys.has(finding.claim_key)) fail();
    keys.add(finding.claim_key);
  }
}

/** Reuse prior IDs only for unique exact keys in two complete states. */
export function reconcileFindingStates(previous, current) {
  assertFindingState(previous, 'previous');
  assertFindingState(current, 'current');
  const reconciled = {
    ...current,
    reasons: [...(current?.reasons ?? [])],
    findings: (current?.findings ?? []).map((finding) => ({
      ...finding,
      locations: finding.locations.map((location) => ({ ...location })),
      primary_location: finding.primary_location ? { ...finding.primary_location } : null,
    })),
  };
  if (previous?.status !== 'complete' || current?.status !== 'complete') return reconciled;
  const previousUnique = uniqueFindingsByKey(previous);
  const currentUnique = uniqueFindingsByKey(current);
  reconciled.findings = reconciled.findings.map((finding) => {
    if (!currentUnique.has(finding.claim_key) || !previousUnique.has(finding.claim_key)) return finding;
    return { ...finding, finding_id: previousUnique.get(finding.claim_key).finding_id };
  });
  return reconciled;
}

/** Compare observations without claiming regression or resolution. */
export function compareFindingStates(previous, current) {
  assertFindingState(previous, 'previous');
  assertFindingState(current, 'current');
  if (previous?.status !== 'complete' || current?.status !== 'complete') {
    return {
      identity_status: 'indeterminate',
      repeated_count: 0,
      newly_observed_count: 0,
      not_reobserved_count: 0,
      severity_changes: [],
      progress: 'indeterminate',
    };
  }
  const reconciled = reconcileFindingStates(previous, current);
  const previousUnique = uniqueFindingsByKey(previous);
  const currentUnique = uniqueFindingsByKey(reconciled);
  const repeatedKeys = [...previousUnique.keys()].filter((key) => currentUnique.has(key));
  const newlyObserved = [...currentUnique.keys()].filter((key) => !previousUnique.has(key));
  const notReobserved = [...previousUnique.keys()].filter((key) => !currentUnique.has(key));
  const severityChanges = repeatedKeys
    .filter((key) => previousUnique.get(key).severity !== currentUnique.get(key).severity)
    .map((key) => ({
      finding_id: currentUnique.get(key).finding_id,
      from: previousUnique.get(key).severity,
      to: currentUnique.get(key).severity,
    }));
  const changed = newlyObserved.length > 0 || notReobserved.length > 0 || severityChanges.length > 0;
  return {
    identity_status: 'complete',
    repeated_count: repeatedKeys.length,
    newly_observed_count: newlyObserved.length,
    not_reobserved_count: notReobserved.length,
    severity_changes: severityChanges,
    progress: changed ? 'changed' : 'stalled',
  };
}

/**
 * Normalize a report-extracted path into a repo-relative, slash-delimited
 * key. Mirrors loop-state.mjs `assertSamePath`'s win32-only case-fold rule;
 * canonicalization otherwise never resolves against the filesystem (pure
 * string handling).
 *
 * `caseFold` (default true) governs ONLY the final win32 lowercasing that
 * produces a case-insensitive IDENTITY key. The repoRoot prefix match always
 * folds case on win32 — a case-insensitive filesystem has one root regardless
 * of the citation's case — but slices from the case-preserving path, so
 * `caseFold: false` returns a case-PRESERVING DISPLAY path (repo-relativized
 * and separator-normalized, but otherwise verbatim) for `findings_signature`
 * and advisory rendering that must read identically on win32 and posix. The
 * win32 case-insensitive identity match then lives in `matchFindings`.
 */
export function canonicalizeRepoPath(rawPath, { repoRoot, platform = process.platform, caseFold = true } = {}) {
  assertNonEmptyString(rawPath, 'path');
  const isWin = platform === 'win32';
  let normalized = rawPath.replace(/\\/gu, '/');

  if (typeof repoRoot === 'string' && repoRoot.length > 0) {
    const rootNormalized = repoRoot.replace(/\\/gu, '/').replace(/\/+$/u, '');
    const compare = (value) => (isWin ? value.toLowerCase() : value);
    const rootCompare = compare(rootNormalized);
    const pathCompare = compare(normalized);
    if (rootCompare.length > 0 && (pathCompare === rootCompare || pathCompare.startsWith(`${rootCompare}/`))) {
      normalized = normalized.slice(rootNormalized.length).replace(/^\/+/u, '');
    }
  }

  normalized = stripDotSegments(normalized);
  if (isWin && caseFold) normalized = normalized.toLowerCase();
  return normalized;
}

/**
 * Deterministic, boundedly-short slug for a finding's title text: used as a
 * tiebreaker (never a sole key) in matchFindings.
 */
export function titleSlug(text) {
  if (typeof text !== 'string') return '';
  const slug = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9ㄱ-ㆎ가-힣]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug.slice(0, 40);
}

function severityAt(lineText) {
  if (/^###\s+\u{1F534}\s+Critical/iu.test(lineText)) return 'critical';
  if (/^###\s+\u{1F7E1}\s+Warning/iu.test(lineText)) return 'warning';
  if (/^###\s+/u.test(lineText)) return '';
  return undefined;
}

/**
 * Extract `{severity, path, line, title_slug}` records from a canonical
 * review report's Critical/Warning sections. Reuses loop-state.mjs
 * `signatures()`'s backtick + bare file:line detection so identity stays
 * aligned with the existing (vestigial) findings_signature extraction.
 *
 * `path` is a case-PRESERVING display path (`caseFold: false`): repo-relative
 * and slash-normalized, but never lowercased, so `findings_signature` and the
 * prior-context advisory render byte-identically on win32 and posix. The
 * win32-only case-insensitive IDENTITY comparison happens later in
 * `matchFindings`; `platform` is threaded through only so tests can pin win32
 * behavior from a posix host.
 */
export function extractFindings(markdown, { repoRoot, platform = process.platform } = {}) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');
  const findings = [];
  let severity = '';
  for (const lineText of markdown.split(/\r?\n/u)) {
    const nextSeverity = severityAt(lineText);
    if (nextSeverity !== undefined) {
      severity = nextSeverity;
      continue;
    }
    if (!severity) continue;

    const backticked = [...lineText.matchAll(BACKTICKED_LOCATION)];
    const withoutQuotedPaths = lineText.replace(QUOTED_LOCATION_STRIP, ' ');
    const bare = [...withoutQuotedPaths.matchAll(BARE_LOCATION)]
      .filter((match) => isPathLikeToken(match[1]));
    const matches = [...backticked, ...bare];
    if (matches.length === 0) continue;

    const titleText = lineText
      .replace(QUOTED_LOCATION_STRIP, ' ')
      .replace(BARE_LOCATION, ' ')
      .replace(/^\s*[-*]\s*/u, '')
      .trim();
    const slug = titleSlug(titleText);

    for (const match of matches) {
      findings.push({
        severity,
        path: canonicalizeRepoPath(match[1], { repoRoot, platform, caseFold: false }),
        line: Number(match[2]),
        title_slug: slug,
      });
    }
  }
  return findings;
}

/**
 * Deterministic, 1:1 greedy matcher between adjacent-round findings.
 * Candidates require identical severity+path and |line delta| <= tolerance;
 * an exact title_slug match outranks a closer line distance so an unrelated
 * finding at the same edited hunk is not mismatched. Unmatched entries are
 * conservatively classified resolved (previous-only) or added (current-only).
 *
 * Findings carry case-PRESERVING display paths (see `extractFindings`), so the
 * win32-only case-insensitive IDENTITY match lives here: on win32 the path
 * comparison folds case — preserving the case-insensitive-filesystem semantics
 * the old extract-time fold provided — while posix stays case-sensitive.
 * `platform` is injectable for tests; production defaults to `process.platform`.
 */
export function matchFindings(previous = [], current = [], { tolerance = 6, platform = process.platform } = {}) {
  if (!Array.isArray(previous) || !Array.isArray(current)) {
    throw new TypeError('previous and current must be arrays');
  }
  const isWin = platform === 'win32';
  const foldPath = (value) => (isWin && typeof value === 'string' ? value.toLowerCase() : value);
  const candidates = [];
  for (let p = 0; p < previous.length; p += 1) {
    const prevFinding = previous[p];
    for (let c = 0; c < current.length; c += 1) {
      const currFinding = current[c];
      if (prevFinding.severity !== currFinding.severity) continue;
      if (foldPath(prevFinding.path) !== foldPath(currFinding.path)) continue;
      const distance = Math.abs(prevFinding.line - currFinding.line);
      if (distance > tolerance) continue;
      const slugMatch = Boolean(prevFinding.title_slug) && prevFinding.title_slug === currFinding.title_slug;
      candidates.push({ p, c, distance, slugMatch });
    }
  }

  candidates.sort((left, right) => {
    if (left.slugMatch !== right.slugMatch) return left.slugMatch ? -1 : 1;
    if (left.distance !== right.distance) return left.distance - right.distance;
    const leftPrev = previous[left.p];
    const rightPrev = previous[right.p];
    if (leftPrev.line !== rightPrev.line) return leftPrev.line - rightPrev.line;
    const leftCurr = current[left.c];
    const rightCurr = current[right.c];
    if (leftCurr.line !== rightCurr.line) return leftCurr.line - rightCurr.line;
    return 0;
  });

  const usedPrev = new Set();
  const usedCurr = new Set();
  const repeated = [];
  for (const candidate of candidates) {
    if (usedPrev.has(candidate.p) || usedCurr.has(candidate.c)) continue;
    usedPrev.add(candidate.p);
    usedCurr.add(candidate.c);
    repeated.push([previous[candidate.p], current[candidate.c]]);
  }

  const resolved = previous.filter((_finding, index) => !usedPrev.has(index));
  const added = current.filter((_finding, index) => !usedCurr.has(index));
  return { repeated, resolved, added };
}
