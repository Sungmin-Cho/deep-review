// Deterministic artifact classifier (§8.5).
//
// Doctrine D3: clear cases are decided deterministically and never call a model.
// Doctrine D9: the artifact's content is untrusted DATA. This module reads
// content only to extract *structural* signals (frontmatter keys, heading text,
// keyword presence, code-fence ratio). It never follows, executes, or is
// steered by imperative text inside the artifact. Every signal it emits has a
// structural type from a closed set.
//
// The semantic (LLM) classifier is Phase 2. When deterministic confidence is
// insufficient, this module marks `needs_semantic: true` and falls back to a
// generic kind — it does not call any model.

import { basename } from 'node:path';
import {
  CODE_CHANGE_KIND,
  CONFIG_INFRA_KIND,
  GENERIC_DOCUMENT_KIND,
  GENERIC_TEXT_KIND,
  SCOPE_KIND_MIXED,
  UNKNOWN_KIND,
  UNSUPPORTED_BINARY_KIND,
} from './target-taxonomy.mjs';
import { codeExtensions, markdownExtensions } from './text-extensions.mjs';

// Weights are expressed in integer hundredths to keep scoring free of floating
// point drift (§8.5.4). Confidence = clamp(sum, 0, 100) / 100.
const W_FRONTMATTER = 45;
const W_STRONG_PATH = 30;
const W_TITLE = 20;
const W_HEADING = 20;
const W_HEADING_SINGLE = 10;
const W_KEYWORD = 10;
const W_EXTENSION = 5;
const W_CONTRADICTION = 25;

const DEFAULT_THRESHOLDS = Object.freeze({ confirm: 0.8, margin: 0.15, semantic: 0.55 });

// Bound how much text we scan so a pathological file cannot dominate CPU.
const MAX_SCAN_BYTES = 256 * 1024;

const CODE_EXTENSIONS = new Set(codeExtensions);

// Markdown-family extensions map their generic fallback to `generic-document`;
// any other text file falls back to `generic-text-artifact`.
const MARKDOWN_EXTENSIONS = new Set(markdownExtensions);

// Strong filename/path signals (§8.5.2). `type` selects the surface each rule is
// tested against — 'filename' against the basename, 'path' against the whole
// path — and both carry W_STRONG_PATH. Bare-substring keywords are anchored to
// separator/word boundaries (`[-_. /]` or string edges) so an unrelated path
// segment like `inspector` or `redesign` cannot false-fire a strong signal.
const STRONG_PATH_RULES = [
  { kind: 'architecture-decision-record', type: 'path', re: /(?:^|\/)adr\//i },
  { kind: 'architecture-decision-record', type: 'filename', re: /(?:^|[-_.])adr[-_]?\d+/i },
  { kind: 'design-document', type: 'path', re: /(?:^|\/)rfc\//i },
  { kind: 'design-document', type: 'filename', re: /(?:^|[-_.])rfc[-_]?\d+/i },
  { kind: 'implementation-plan', type: 'filename', re: /implementation.*plan/i },
  { kind: 'implementation-plan', type: 'filename', re: /(?:^|[-_.])handoff(?:[-_.]|$)/i },
  { kind: 'test-plan', type: 'filename', re: /(?:^|[-_.])(?:test|qa).*plan/i },
  { kind: 'design-document', type: 'filename', re: /(?:^|[-_.])(?:designs?|architectures?)(?:[-_.]|$)/i },
  { kind: 'requirements-specification', type: 'filename', re: /(?:^|[-_.])(?:specs?|specification|requirements?)(?:[-_.]|$)/i },
  { kind: 'runbook-operations', type: 'filename', re: /(?:^|[-_.])(?:runbooks?|operations?|on-?call)(?:[-_.]|$)/i },
  { kind: 'research-note', type: 'filename', re: /(?:^|[-_.])research(?:[-_.]|$)/i },
  { kind: 'configuration-infrastructure', type: 'filename', re: /(?:^|[-_.])dockerfile(?:[-_.]|$)/i },
];

// Heading fingerprints (§8.5.3). Matching is substring-based on the lowercased
// heading text so bilingual headings like "배경 (Context)" still match.
const HEADING_FINGERPRINTS = {
  'design-document': [
    'context', 'problem', 'goals', 'non-goals', 'architecture', 'components',
    'data flow', 'alternatives', 'trade-offs', 'tradeoffs', 'observability',
    'migration',
  ],
  'implementation-plan': [
    'implementation steps', 'tasks', 'phases', 'milestones', 'files to change',
    'dependencies', 'rollout', 'rollback', 'risks', 'definition of done',
  ],
  'requirements-specification': [
    'requirements', 'acceptance criteria', 'user stories', 'constraints',
    'out of scope', 'edge cases', 'non-functional requirements',
  ],
  'architecture-decision-record': [
    'status', 'context', 'decision', 'alternatives', 'consequences',
  ],
  'test-plan': [
    'test scope', 'scenarios', 'test cases', 'expected result',
    'pass/fail criteria', 'regression',
  ],
};

// Title vocabulary (§8.5.1 top-level title). Bilingual where the fixtures need
// it. Substring match on the lowercased H1.
const TITLE_VOCAB = {
  'design-document': ['design', 'architecture', '설계', '아키텍처'],
  'implementation-plan': ['implementation plan', 'rollout plan', '구현 계획', '구현계획'],
  'requirements-specification': ['requirements', 'specification', '요구사항', '명세'],
  'architecture-decision-record': ['adr', 'decision record'],
  'test-plan': ['test plan', 'qa plan', '테스트 계획'],
  'runbook-operations': ['runbook', 'operations', 'operational', '런북'],
  'research-note': ['research', 'research note', '연구', '리서치'],
  'configuration-infrastructure': ['configuration', 'infrastructure'],
};

// Keyword-density vocabulary. Density fires (+W_KEYWORD) when at least
// KEYWORD_DENSITY_MIN distinct terms occur in the scanned body.
const KEYWORD_DENSITY_MIN = 3;
const KEYWORD_VOCAB = {
  'design-document': ['architecture', 'components', 'data flow', 'alternatives', 'trade-off', 'tradeoff', 'observability', 'migration', '설계', '아키텍처', '트레이드오프', '대안'],
  'implementation-plan': ['implementation', 'milestone', 'rollout', 'rollback', 'phase', 'files to change', 'definition of done', '구현', '롤아웃', '롤백', '마일스톤'],
  'requirements-specification': ['requirement', 'acceptance criteria', 'user story', 'constraint', 'edge case', 'non-functional', '요구사항', '수용 기준'],
  'architecture-decision-record': ['decision', 'consequence', 'accepted', 'superseded', 'rejected'],
  'test-plan': ['test case', 'scenario', 'pass/fail', 'regression', 'assertion', '테스트 케이스', '회귀'],
  'runbook-operations': ['runbook', 'alert', 'on-call', 'escalation', 'rollback', 'recovery', 'pager', '런북', '알림'],
  'research-note': ['research', 'finding', 'observation', 'open question', 'reference', '연구', '관찰'],
};

const FRONTMATTER_KIND_KEYS = new Set([
  'kind', 'type', 'artifact', 'artifact_kind', 'doc_type', 'document_type', 'category',
]);

const FRONTMATTER_VALUE_SYNONYMS = {
  design: 'design-document',
  'design-document': 'design-document',
  'design-doc': 'design-document',
  rfc: 'design-document',
  plan: 'implementation-plan',
  'implementation-plan': 'implementation-plan',
  'impl-plan': 'implementation-plan',
  spec: 'requirements-specification',
  specification: 'requirements-specification',
  requirements: 'requirements-specification',
  'requirements-specification': 'requirements-specification',
  adr: 'architecture-decision-record',
  'architecture-decision-record': 'architecture-decision-record',
  'test-plan': 'test-plan',
  runbook: 'runbook-operations',
  'runbook-operations': 'runbook-operations',
  research: 'research-note',
  'research-note': 'research-note',
  config: 'configuration-infrastructure',
  configuration: 'configuration-infrastructure',
  'configuration-infrastructure': 'configuration-infrastructure',
};

const DOCUMENT_KINDS = Object.keys(HEADING_FINGERPRINTS)
  .concat(['runbook-operations', 'research-note', 'configuration-infrastructure']);

function clampHundredths(value) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function parseFrontmatter(content) {
  if (!content.startsWith('---')) return null;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/u.exec(line);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/gu, '');
  }
  return fields;
}

function extractHeadings(scanText) {
  const headings = [];
  for (const line of scanText.split(/\r?\n/u)) {
    const match = /^#{1,6}\s+(.+?)\s*$/u.exec(line);
    if (match) headings.push(match[1].toLowerCase());
  }
  return headings;
}

function extractTitle(scanText) {
  for (const line of scanText.split(/\r?\n/u)) {
    const match = /^#\s+(.+?)\s*$/u.exec(line);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

function codeFenceRatio(scanText) {
  const lines = scanText.split(/\r?\n/u);
  if (lines.length === 0) return 0;
  let inside = false;
  let fenced = 0;
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      inside = !inside;
      fenced += 1;
      continue;
    }
    if (inside) fenced += 1;
  }
  return fenced / lines.length;
}

function frontmatterKind(frontmatter) {
  if (!frontmatter) return null;
  for (const key of Object.keys(frontmatter)) {
    if (!FRONTMATTER_KIND_KEYS.has(key)) continue;
    const canonical = FRONTMATTER_VALUE_SYNONYMS[frontmatter[key].toLowerCase()];
    if (canonical) return canonical;
  }
  return null;
}

function headingSignal(kind, headings) {
  const fingerprints = HEADING_FINGERPRINTS[kind];
  if (!fingerprints) return { matched: 0, weight: 0 };
  const seen = new Set();
  for (const heading of headings) {
    for (const phrase of fingerprints) {
      if (heading.includes(phrase)) seen.add(phrase);
    }
  }
  const matched = seen.size;
  if (matched >= 2) return { matched, weight: W_HEADING };
  if (matched === 1) return { matched, weight: W_HEADING_SINGLE };
  return { matched: 0, weight: 0 };
}

function keywordSignal(kind, lowerBody) {
  const vocab = KEYWORD_VOCAB[kind];
  if (!vocab) return 0;
  let distinct = 0;
  for (const term of vocab) {
    if (lowerBody.includes(term)) distinct += 1;
  }
  return distinct >= KEYWORD_DENSITY_MIN ? W_KEYWORD : 0;
}

function genericFallbackKind(extension, fenceRatio) {
  if (MARKDOWN_EXTENSIONS.has(extension) && fenceRatio <= 0.6) return GENERIC_DOCUMENT_KIND;
  if (MARKDOWN_EXTENSIONS.has(extension)) return GENERIC_TEXT_KIND;
  return GENERIC_TEXT_KIND;
}

function decisiveInfraPath(name, path, extension) {
  if (/^dockerfile(\.|$)/i.test(name)) return true;
  if (extension === '.tf' || extension === '.tfvars' || extension === '.hcl') return true;
  if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)) return true;
  if (/^docker-compose[.\w-]*\.ya?ml$/i.test(name)) return true;
  return false;
}

/**
 * Classify one artifact from its descriptor fields and (bounded) text content.
 * Returns a TargetClassification-shaped object (§16.2) plus scoring provenance.
 * Pure: identical inputs always produce a deep-equal result.
 */
export function classifyArtifact(input = {}) {
  const {
    path = '',
    extension = '',
    content = '',
    isBinary = false,
    gitStatus = '',
    thresholds = DEFAULT_THRESHOLDS,
  } = input;

  const ext = String(extension).toLowerCase();
  const name = basename(String(path));

  // --- Tier 1: coarse artifact class (descriptor only, no content) ----------
  if (isBinary) {
    return {
      target_kind: UNSUPPORTED_BINARY_KIND,
      confidence: 1,
      source: 'binary',
      needs_semantic: false,
      signals: [{ type: 'extension', value: ext || 'binary', weight: W_EXTENSION / 100 }],
      alternatives: [],
      scores: {},
      scores_without_contradiction: {},
    };
  }

  if (CODE_EXTENSIONS.has(ext)) {
    const signals = [{ type: 'code-extension', value: ext, weight: 1 }];
    let source = 'code extension';
    if (gitStatus) {
      signals.push({ type: 'git-diff', value: gitStatus, weight: 1 });
      source = 'code extension + git diff';
    }
    return {
      target_kind: CODE_CHANGE_KIND,
      confidence: 1,
      source,
      needs_semantic: false,
      signals,
      alternatives: [],
      scores: { [CODE_CHANGE_KIND]: 1 },
      scores_without_contradiction: { [CODE_CHANGE_KIND]: 1 },
    };
  }

  if (decisiveInfraPath(name, String(path), ext)) {
    return {
      target_kind: CONFIG_INFRA_KIND,
      confidence: 0.9,
      source: 'deterministic',
      needs_semantic: false,
      signals: [{ type: 'filename', value: name, weight: W_STRONG_PATH / 100 }],
      alternatives: [],
      scores: { [CONFIG_INFRA_KIND]: 0.9 },
      scores_without_contradiction: { [CONFIG_INFRA_KIND]: 0.9 },
    };
  }

  // --- Tier 2: weighted document scoring (§8.5.4) ---------------------------
  const scanText = content.length > MAX_SCAN_BYTES ? content.slice(0, MAX_SCAN_BYTES) : content;
  const lowerBody = scanText.toLowerCase();
  const frontmatter = parseFrontmatter(content);
  const fmKind = frontmatterKind(frontmatter);
  const headings = extractHeadings(scanText);
  const title = extractTitle(scanText);
  const fenceRatio = codeFenceRatio(scanText);
  const isMarkdownExt = MARKDOWN_EXTENSIONS.has(ext);

  // Per-kind signal ledgers. Scores accumulate in integer hundredths (`scoreH`)
  // to avoid float drift; emitted signal weights are decimals.
  const ledger = new Map();
  const ensure = (kind) => {
    if (!ledger.has(kind)) ledger.set(kind, { signals: [], strong: 0, scoreH: 0 });
    return ledger.get(kind);
  };
  const add = (kind, type, value, weightH, strong = false) => {
    const entry = ensure(kind);
    entry.signals.push({ type, value, weight: weightH / 100 });
    entry.scoreH += weightH;
    if (strong && weightH > entry.strong) entry.strong = weightH;
  };

  if (fmKind) add(fmKind, 'frontmatter', fmKind, W_FRONTMATTER, true);

  for (const rule of STRONG_PATH_RULES) {
    const haystack = rule.type === 'path' ? String(path) : name;
    if (rule.re.test(haystack)) {
      add(rule.kind, rule.type, haystack, W_STRONG_PATH, true);
    }
  }

  for (const [kind, vocab] of Object.entries(TITLE_VOCAB)) {
    if (title && vocab.some((phrase) => title.includes(phrase))) {
      add(kind, 'title', title, W_TITLE);
    }
  }

  for (const kind of Object.keys(HEADING_FINGERPRINTS)) {
    const { matched, weight } = headingSignal(kind, headings);
    if (weight > 0) add(kind, 'heading', `${matched} fingerprint headings`, weight);
  }

  for (const kind of DOCUMENT_KINDS) {
    if (keywordSignal(kind, lowerBody) > 0) add(kind, 'keyword', 'density', W_KEYWORD);
  }

  // Extension family is a weak absolute nudge for any doc candidate that
  // already has a positive signal.
  if (isMarkdownExt) {
    for (const kind of [...ledger.keys()]) add(kind, 'extension', ext, W_EXTENSION);
  }

  // Contradiction (§8.5.4): a candidate whose strongest strong-signal is
  // out-ranked by a strong signal for a *different* kind loses W_CONTRADICTION.
  const scoreH = {};
  const scoreWithoutH = {};
  for (const [kind, entry] of ledger) {
    scoreWithoutH[kind] = entry.scoreH;
    let maxOtherStrong = 0;
    for (const [other, otherEntry] of ledger) {
      if (other !== kind && otherEntry.strong > maxOtherStrong) maxOtherStrong = otherEntry.strong;
    }
    const penalty = maxOtherStrong > entry.strong ? W_CONTRADICTION : 0;
    if (penalty > 0) {
      entry.signals.push({ type: 'contradiction', value: 'stronger signal for another kind', weight: -penalty / 100 });
    }
    scoreH[kind] = clampHundredths(entry.scoreH - penalty);
  }

  const ranked = [...ledger.keys()].sort((a, b) => scoreH[b] - scoreH[a] || a.localeCompare(b));
  const confirmH = Math.round((thresholds.confirm ?? DEFAULT_THRESHOLDS.confirm) * 100);
  const marginH = Math.round((thresholds.margin ?? DEFAULT_THRESHOLDS.margin) * 100);
  const semanticH = Math.round((thresholds.semantic ?? DEFAULT_THRESHOLDS.semantic) * 100);

  const topKind = ranked[0];
  const topScore = topKind ? scoreH[topKind] : 0;
  const secondScore = ranked[1] ? scoreH[ranked[1]] : 0;
  const margin = topScore - secondScore;

  // Emit decimal score maps (consistent with `confidence`).
  const scores = {};
  const scores_without_contradiction = {};
  for (const kind of ledger.keys()) {
    scores[kind] = scoreH[kind] / 100;
    scores_without_contradiction[kind] = scoreWithoutH[kind] / 100;
  }

  const alternatives = ranked
    .slice(1)
    .filter((kind) => scoreH[kind] > 0)
    .slice(0, 3)
    .map((kind) => ({ target_kind: kind, confidence: scoreH[kind] / 100 }));

  const provenance = { scores, scores_without_contradiction, alternatives };

  if (topKind && topScore >= confirmH && margin >= marginH) {
    return {
      target_kind: topKind,
      confidence: topScore / 100,
      source: 'deterministic',
      needs_semantic: false,
      signals: ledger.get(topKind).signals,
      ...provenance,
    };
  }

  if (topKind && topScore >= semanticH) {
    return {
      target_kind: topKind,
      confidence: topScore / 100,
      source: 'deterministic-provisional',
      needs_semantic: true,
      signals: ledger.get(topKind).signals,
      ...provenance,
    };
  }

  return {
    target_kind: genericFallbackKind(ext, fenceRatio),
    confidence: topScore / 100,
    source: 'deterministic-fallback',
    needs_semantic: true,
    signals: topKind ? ledger.get(topKind).signals : [],
    ...provenance,
  };
}

/**
 * Scope classification (§8.7): one shared kind, or `mixed`. An empty set is
 * `unknown`, never `mixed` — `mixed` for zero artifacts is a misleading scope
 * (W1) that hides a discovery gap behind a plausible-looking classification.
 */
export function classifyScope(classifications) {
  if (classifications.length === 0) return UNKNOWN_KIND;
  const kinds = new Set(classifications.map((c) => c.target_kind));
  if (kinds.size === 1) return [...kinds][0];
  return SCOPE_KIND_MIXED;
}

export { DEFAULT_THRESHOLDS };
