'use strict';

// T-DISSENT-1 — the dissent annotation is cardinality-generic (D14).
//
// The agreement enum was widened once before while the dissent fields stayed
// singular. At N = 4 a `majority_3_of_4` has exactly one dissenter, so three
// singular keys sufficed *by arithmetic accident*. A fifth selectable reviewer
// makes five-way rounds reachable: a `majority_3_of_5` has two dissenters, and
// three singular keys carry one. The lost voice is exactly the cross-vendor
// signal the annotation exists to preserve — if Grok and agy both dissent,
// recording one erases that the dissent spans two vendor families rather than
// being one vendor's outlier.
//
// This is instruction vocabulary, not runtime. `review-synthesis.mjs` derives
// `n_actual` and provider-family counts but emits no dissent field at all, so
// the carrier is the composing agent and the whole contract lives in the shipped
// instruction text.
//
// Every rule below is therefore PARSED OUT OF that text and then checked against
// the text's own worked instances. The test deliberately holds no second copy of
// the rule: a copy could stay green while the shipped instruction — the only
// thing a composing agent actually reads — said something else.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');

const REPORT_FORMAT = 'skills/deep-review-workflow/references/report-format.md';
const CODEX_INTEGRATION = 'skills/deep-review-workflow/references/codex-integration.md';
const AGY_INTEGRATION = 'skills/deep-review-workflow/references/agy-integration.md';
const GROK_INTEGRATION = 'skills/deep-review-workflow/references/grok-integration.md';
const REVIEW_EXECUTION = 'skills/deep-review-workflow/references/review-execution.md';
const RESPONSE_PROTOCOL = 'skills/receiving-review/references/response-protocol.md';
const PHASE6_PROMPT = 'skills/receiving-review/references/phase6-prompt-contract.md';
const ROUTING_MODULE = 'hooks/scripts/lib/adaptive-review-routing.mjs';

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n|\r/gu, '\n');
}

// Every instruction surface an agent may read at runtime. The retired-key sweep
// needs all of them: a singular key that survives in one unscanned reference is
// still an alternative a composing agent can follow.
function instructionFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) {
        out.push(canonicalInstructionPath(path.relative(root, full)));
      }
    }
  };
  for (const dir of ['skills', 'agents', 'commands']) walk(path.join(root, dir));
  return out;
}

function canonicalInstructionPath(relativePath, separator = path.sep) {
  return relativePath.split(separator).join('/');
}

function paragraphContaining(source, needle, label) {
  const hits = source.split('\n\n').filter((block) => block.includes(needle));
  assert.equal(hits.length, 1, `${label}: expected exactly one paragraph containing ${needle}`);
  return hits[0].replace(/\n/gu, ' ');
}

function backtickedTokens(text) {
  return [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
}

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// --- alternative-statement sweep ---------------------------------------------
//
// Everything else in this file pins the canonical schema block, the derivation
// sentence and the worked annotations: altering or deleting any of them fails.
// None of it notices a sentence *elsewhere in the same file* telling the
// composing agent to do the opposite. D14's carrier reads prose, and a rule
// stated once does not survive a contradiction stated twice.
//
// Natural language cannot be policed and this does not try to. What can be
// policed is the closed vocabulary D14 itself defines — one array key, one
// derived cardinality, one ordering authority, one per-entry family key. Each of
// the four rules fills exactly one slot, and an *alternative* filler has to be
// spelled out before an agent can follow it. So: find every dissent-scoped
// statement in every shipped instruction surface, and fail the ones that fill a
// slot with something the shipped vocabulary does not offer.
//
// Reach, stated plainly so nobody over-trusts it. This catches an affirmative
// statement that names an alternative: a second key whose name counts, a
// cardinality given a home of its own, an ordering that does not name the
// ordering authority, a positional or collapsing treatment of `family`, a
// selection applied to the dissent set. It does NOT catch a contradiction
// carrying a negation token, because that token is exactly how the shipped rules
// spell their own prohibitions and the two are not separable without parsing
// negation scope; nor one that invokes no slot vocabulary at all; nor one hidden
// inside a fenced block, which the canonical-block checks above own instead.

// A paragraph is dissent-scoped when it talks about the dissent array or the
// vendor-family slot, in either language these files are written in. Bare
// `family` is deliberately not a trigger: "the Claude family" and
// "provider-family count" are frequent, unrelated, and live elsewhere.
const DISSENT_SCOPE = /dissent|`family`|계열|반대자/iu;

// A unit that states a prohibition is the rule, not an alternative to it.
const NEGATED = /\b(?:never|not|no|nor|neither|cannot)\b|n't\b|\binstead of\b|\brather than\b|않|아니|없|금지|말라|결코|절대/iu;

const SLOT_CARDINALITY = /\b(?:count|counts|length|lengths|size|sizes|number|numbers|cardinality|tally|total|totals)\b|개수|갯수|건수|길이|항목\s*수/iu;
const SLOT_ORDERING = /\b(?:order|orders|ordered|ordering|sort|sorts|sorted|sorting|rank|ranks|ranked|ranking|precede[sd]?|sequence[sd]?)\b|정렬|순서|순으로|순서대로|내림차순|오름차순/iu;
const SLOT_FAMILY = /`family`|\bfamil(?:y|ies)\b|계열/iu;

// "the count lives somewhere of its own" — the alternative the derivation forbids.
const ALTERNATIVE_HOME = /\b(?:separate|separately|additional|additionally|extra|dedicated|distinct|explicit|explicitly|own|second)\b|별도|따로|별개|추가/iu;

// "one family for the whole array" — the alternative the per-dissenter rule forbids.
const COLLAPSED = /\bcollapse[sd]?\b|\bcollapsing\b|\b(?:a |one |single |shared )value\b|하나로|한\s*값|단일\s*값|공통\s*값|통일/iu;
const POSITIONAL = /\bfirst\b|\blast\b|\bprimary\b|\brepresentative\b|첫\s*번?\s*째|첫번째|맨\s*앞|마지막|대표/iu;

// "some of them" — the alternative the retirement of the singular keys forbids.
const SELECTION = new RegExp(
  [
    '\\bonly\\s+(?:the\\s+)?(?:first|last|one|single|a\\s+single|highest|most|top)\\b',
    '\\bfirst[\\s-](?:dissent\\w*|reviewer|entr\\w+|element|item|one)\\b',
    '\\b(?:omit|omits|omitted|omitting|exclude[sd]?|excluding|discard(?:s|ed)?|truncat\\w+|suppress\\w*|drop|drops|dropped)\\b',
    '\\bat\\s+most\\b',
    '\\bthe\\s+(?:rest|remainder|others|remaining)\\b',
    '하나만',
    '한\\s*(?:개|명|건|항목)\\s*만',
    '만\\s*(?:싣|기록하|남기|적는|적어|포함하|골라|택하)',
    '생략|제외|누락|버리|잘라|축약|나머지는',
  ].join('|'),
  'iu',
);

// A count key is recognised by its morphemes, not by one spelling, so
// `count`, `dissent_count`, `n_dissenters` and `entryTally` all read alike.
const COUNT_MORPHEMES = new Set([
  'count', 'counts', 'cnt', 'len', 'length', 'lengths', 'size', 'sizes', 'num',
  'nums', 'number', 'numbers', 'total', 'totals', 'tally', 'qty', 'quantity',
  'cardinality', 'n',
]);

const CODE_SPAN = /`[^`\n]*`/gu;

// Sentence splitting has to survive `dissenters.length` and `…/foo.mjs`, so code
// spans are masked out before the split and restored after it.
function splitSentences(text) {
  const spans = [];
  const masked = text.replace(CODE_SPAN, (span) => {
    spans.push(span);
    return `\uE000${spans.length - 1}\uE001`;
  });
  return masked
    .split(/(?<=[.!?])\s+/u)
    .map((piece) => piece.replace(/\uE000(\d+)\uE001/gu, (_, index) => spans[Number(index)]));
}

// Prose wraps mid-sentence, so lines inside a paragraph are rejoined before
// splitting — a negation on line 1 governs the clause that ran onto line 2. Table
// rows are the exception: each row is an independent statement.
function normativeUnits(source) {
  const units = [];
  const prosaic = source.replace(/```[\s\S]*?```/gu, '\n\nFENCE\n\n');
  for (const paragraph of prosaic.split(/\n[ \t]*\n/u)) {
    if (!DISSENT_SCOPE.test(paragraph)) continue;
    let prose = [];
    const flush = () => {
      if (prose.length > 0) units.push(...splitSentences(prose.join(' ')));
      prose = [];
    };
    for (const raw of paragraph.split('\n')) {
      const line = raw.replace(/^\s*>\s?/u, '');
      if (/^\s*\|/u.test(line)) {
        flush();
        units.push(line);
        continue;
      }
      prose.push(line);
    }
    flush();
  }
  return units.map((unit) => unit.trim()).filter((unit) => unit.length > 0);
}

function alternativeStatements(source, slots) {
  const found = [];
  for (const unit of normativeUnits(source)) {
    const text = unit.replace(/\bin order to\b/giu, ' ');
    if (NEGATED.test(text)) continue;

    for (const token of backtickedTokens(text)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(token)) continue;
      if (slots.identifiers.has(token.toLowerCase())) continue;
      const parts = token.split(/[._]|(?=[A-Z])/u).map((part) => part.toLowerCase()).filter(Boolean);
      if (parts.some((part) => COUNT_MORPHEMES.has(part))) {
        found.push({ rule: 'cardinality', unit, detail: `\`${token}\` names a count beside \`${slots.countKey}\`` });
      }
    }

    if (SLOT_CARDINALITY.test(text) && ALTERNATIVE_HOME.test(text)) {
      found.push({ rule: 'cardinality', unit, detail: `the derived \`${slots.countKey}\` is given a home of its own` });
    }

    if (SLOT_ORDERING.test(text) && !text.includes(slots.orderAuthority)) {
      found.push({ rule: 'ordering', unit, detail: `an ordering that does not name \`${slots.orderAuthority}\`` });
    }

    if (SLOT_FAMILY.test(text) && (POSITIONAL.test(text) || COLLAPSED.test(text))) {
      found.push({ rule: 'family', unit, detail: '`family` treated positionally or collapsed for the array' });
    }

    if (SELECTION.test(text)) {
      found.push({ rule: 'no-dual-writing', unit, detail: `a selection over \`${slots.arrayKey}\`` });
    }
  }
  return found;
}

// --- the shipped rule, parsed ------------------------------------------------

// The generic enum line. `N` and `K` stay symbolic here; the instantiation table
// and the worked examples are what bind them to literals.
function genericEnum(report) {
  const line = report.match(/^- `agreement: ([^`]+)`$/mu);
  assert.ok(line, `${REPORT_FORMAT} no longer states the generic agreement enum`);
  const members = line[1].split('|').map((member) => member.trim());
  assert.ok(members.length >= 4, `the generic enum collapsed to ${members.length} member(s)`);
  return members;
}

// A generic member instantiates by substituting its uppercase placeholders. `\b`
// is useless here: in `majority_K_of_N` the `_` before `N` is a word character,
// so there is no boundary to anchor on. Member names are lowercase apart from the
// placeholders, so a plain uppercase substitution is exact.
function memberMatcher(member) {
  const source = member
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/K/gu, '(?<k>\\d+)')
    .replace(/N/gu, '(?<n>\\d+)');
  return new RegExp(`^${source}$`, 'u');
}

function classifyLiteral(literal, members) {
  const matched = members
    .map((member) => ({ member, match: memberMatcher(member).exec(literal) }))
    .filter((candidate) => candidate.match !== null);
  assert.equal(
    matched.length,
    1,
    `${literal} instantiates ${matched.length} generic members — the enum is ambiguous or does not cover it`,
  );
  const { member, match } = matched[0];
  const groups = match.groups || {};
  return {
    member,
    n: Number(groups.n),
    k: groups.k === undefined ? null : Number(groups.k),
  };
}

// `dissenters.length` per generic member, read off the derivation sentence. A
// mutation that declares the count instead of deriving it cannot produce a map
// that still covers every enum member, so the set equality below is the check.
function cardinalityRule(report) {
  const sentence = paragraphContaining(report, '`dissenters.length` is derived', REPORT_FORMAT)
    .replace(/−/gu, '-');
  const formulas = new Map();
  for (const clause of sentence.matchAll(/`(N ?- ?(?:K|1))` for ((?:`[A-Za-z0-9_]+`(?:,? and | )?)+)/gu)) {
    for (const member of backtickedTokens(clause[2])) formulas.set(member, clause[1]);
  }
  const absent = sentence.match(/absent for ((?:`[A-Za-z0-9_]+`(?:,? and | )?)+)/u);
  assert.ok(absent, `${REPORT_FORMAT}: the derivation sentence names no absent case`);
  for (const member of backtickedTokens(absent[1])) formulas.set(member, 'absent');
  return formulas;
}

function evaluateCardinality(expression, { n, k }) {
  if (expression === 'absent') return null;
  const operand = expression.replace(/\s+/gu, '').match(/^N-(K|1)$/u);
  assert.ok(operand, `unsupported cardinality expression: ${expression}`);
  if (operand[1] === 'K') {
    assert.equal(typeof k, 'number', `${expression} needs a K the literal does not carry`);
    return n - k;
  }
  return n - 1;
}

// The `N = 5` instantiation table. Contract tests need literals, and the literals
// are only worth having if the rule above still generates them.
function instantiationTable(report) {
  const rows = [];
  for (const row of report.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|\s*([^|]+?)\s*\|$/gmu)) {
    const declared = row[2];
    const entries = declared.match(/^(\d+) entr(?:y|ies)$/u);
    rows.push({
      literal: row[1],
      length: entries ? Number(entries[1]) : null,
      declared,
    });
  }
  assert.ok(rows.length >= 4, `${REPORT_FORMAT}: the instantiation table shrank to ${rows.length} row(s)`);
  return rows;
}

// --- the shipped instances, parsed -------------------------------------------

function yamlBlocks(source) {
  return [...source.matchAll(/```yaml\n([\s\S]*?)```/gu)].map((match) => match[1]);
}

function parseBlock(block, label) {
  const parsed = { topKeys: [], agreement: null, dissenters: [], itemKeyLists: [] };
  let current = null;
  let currentKeys = null;
  for (const line of block.split('\n')) {
    if (line.trim().length === 0) continue;
    const top = line.match(/^([a-z_]+):\s*(.*)$/u);
    if (top) {
      parsed.topKeys.push(top[1]);
      if (top[1] === 'agreement') parsed.agreement = top[2].trim();
      current = null;
      currentKeys = null;
      continue;
    }
    const opener = line.match(/^ {2}- ([a-z_]+):\s*(.*)$/u);
    if (opener) {
      current = {};
      currentKeys = [];
      parsed.dissenters.push(current);
      parsed.itemKeyLists.push(currentKeys);
      current[opener[1]] = opener[2].trim();
      currentKeys.push(opener[1]);
      continue;
    }
    const continuation = line.match(/^ {4}([a-z_]+):\s*(.*)$/u);
    assert.ok(continuation, `${label}: unparsed annotation line ${JSON.stringify(line)}`);
    assert.ok(current, `${label}: key outside any dissenters entry — ${JSON.stringify(line)}`);
    current[continuation[1]] = continuation[2].trim();
    currentKeys.push(continuation[1]);
  }
  return parsed;
}

// --- reviewer identity and vendor family, both from shipped text -------------

// Each reviewer's vendor family is claimed by its own shipped reference. Reading
// it from there rather than from a table in this test is what makes dropping
// `xai` from the report's vocabulary a failure: the claim and the vocabulary are
// two independent statements that have to agree.
const FAMILY_CLAIMS = [
  { reviewer: 'claude-opus', file: REVIEW_EXECUTION, pattern: /collapse to one ([A-Za-z]+) voice/u },
  { reviewer: 'codex-review', file: CODEX_INTEGRATION, pattern: /`codex-review` is the standard ([A-Za-z]+) voice/u },
  { reviewer: 'codex-adversarial', file: CODEX_INTEGRATION, pattern: /`codex-adversarial` is the adversarial ([A-Za-z]+) voice/u },
  { reviewer: 'agy', file: AGY_INTEGRATION, pattern: /Label a trusted success `agy`\. It is one ([A-Za-z]+)-family vote/u },
  { reviewer: 'grok', file: GROK_INTEGRATION, pattern: /Label a trusted success `grok`\. It is one ([A-Za-z]+)-family vote/u },
];

function claimedFamilies() {
  const families = new Map();
  for (const claim of FAMILY_CLAIMS) {
    const match = read(claim.file).match(claim.pattern);
    assert.ok(match, `${claim.file} no longer claims a vendor family for ${claim.reviewer}`);
    families.set(claim.reviewer, match[1].toLowerCase());
  }
  return families;
}

async function canonicalReviewerOrder() {
  const module = await import(pathToFileURL(path.join(root, 'hooks', 'scripts', 'lib', 'reviewer-ids.mjs')).href);
  return module.REVIEWER_IDS;
}

test('T-DISSENT-1 both Grok and agy dissenters survive the composing-agent contract', async () => {
  const report = read(REPORT_FORMAT);
  const members = genericEnum(report);
  const formulas = cardinalityRule(report);
  const reviewerIds = await canonicalReviewerOrder();
  const families = claimedFamilies();

  // Every canonical reviewer has a shipped family claim, so a sixth reviewer
  // cannot be added without deciding which vocabulary entry it votes as.
  assert.deepEqual(
    [...families.keys()].sort(),
    [...reviewerIds].sort(),
    'the reviewer set and the set of shipped vendor-family claims disagree',
  );

  // ---- rule 1: cardinality is derived, never declared -----------------------
  assert.deepEqual(
    [...formulas.keys()].sort(),
    [...members].sort(),
    'the derivation sentence and the generic enum name different members — one of them is stale',
  );

  const table = instantiationTable(report);
  const covered = new Set();
  for (const row of table) {
    const shape = classifyLiteral(row.literal, members);
    covered.add(shape.member);
    const expected = evaluateCardinality(formulas.get(shape.member), shape);
    assert.equal(
      row.length,
      expected,
      `${row.literal} declares ${JSON.stringify(row.declared)} but the shipped rule derives ${expected}`,
    );
  }
  assert.deepEqual(
    [...covered].sort(),
    [...members].sort(),
    'the instantiation table leaves a generic enum member without a literal',
  );
  const instantiatedAt = new Set(table.map((row) => classifyLiteral(row.literal, members).n));
  assert.ok(instantiatedAt.has(5), 'the instantiation table never reaches N = 5, the case D14 exists for');

  // No annotation key may declare the count that the rule derives. A declared
  // count is exactly the failure mode the derivation prevents: two statements
  // that can disagree.
  const blocks = yamlBlocks(report).map((block, index) => parseBlock(block, `${REPORT_FORMAT} block ${index}`));
  assert.ok(blocks.length >= 4, `${REPORT_FORMAT} ships ${blocks.length} annotation block(s) — too few to prove the shape`);
  const declaresCount = /(?:count|length|size|total)$/u;
  for (const block of blocks) {
    for (const key of block.topKeys) {
      assert.doesNotMatch(key, declaresCount, `top-level key ${key} declares what the rule derives`);
    }
    for (const keys of block.itemKeyLists) {
      for (const key of keys) {
        assert.doesNotMatch(key, declaresCount, `dissenters entry key ${key} declares what the rule derives`);
      }
    }
  }

  // ---- the worked instances obey the same rule ------------------------------
  const examples = blocks.filter((block) => block.agreement !== null);
  assert.ok(examples.length >= 3, `${REPORT_FORMAT} ships ${examples.length} worked annotation(s) — too few`);
  const schemaBlocks = blocks.filter((block) => block.agreement === null);
  assert.equal(schemaBlocks.length, 1, 'expected exactly one dissenters schema block');
  const schema = schemaBlocks[0];
  assert.deepEqual(schema.topKeys, ['dissenters'], 'the schema block no longer defines `dissenters`');

  const schemaKeys = schema.itemKeyLists[0];
  const vocabulary = schema.dissenters[0].family.split('|').map((value) => value.trim());
  assert.ok(schemaKeys.includes('family'), 'the schema entry lost its per-dissenter `family`');

  for (const [reviewer, family] of families) {
    assert.ok(
      vocabulary.includes(family),
      `${reviewer} votes as ${family}, which the shipped family vocabulary ${JSON.stringify(vocabulary)} does not offer`,
    );
  }

  let crossFamily = 0;
  let singleFamily = 0;
  let unanimousSeen = 0;
  for (const example of examples) {
    const shape = classifyLiteral(example.agreement, members);
    const expected = evaluateCardinality(formulas.get(shape.member), shape);
    if (expected === null) {
      unanimousSeen += 1;
      assert.equal(
        example.topKeys.includes('dissenters'),
        false,
        `${example.agreement} carries a dissenters key the shipped rule says is absent`,
      );
      continue;
    }
    assert.equal(
      example.dissenters.length,
      expected,
      `${example.agreement} renders ${example.dissenters.length} dissenter(s); the shipped rule derives ${expected}`,
    );

    // ---- rule 2: order is `canonicalReviewerIndex`, always ------------------
    const indexes = example.dissenters.map((entry) => {
      assert.ok(entry.reviewer, `a dissenters entry under ${example.agreement} has no reviewer`);
      const index = reviewerIds.indexOf(entry.reviewer);
      assert.notEqual(index, -1, `${entry.reviewer} is not a canonical reviewer id`);
      return index;
    });
    assert.deepEqual(
      indexes,
      [...indexes].sort((left, right) => left - right),
      `${example.agreement} lists dissenters out of canonicalReviewerIndex order: ${JSON.stringify(example.dissenters.map((entry) => entry.reviewer))}`,
    );

    // ---- rule 3: families are listed, never collapsed ----------------------
    for (const [position, entry] of example.dissenters.entries()) {
      assert.ok(
        example.itemKeyLists[position].includes('family'),
        `dissenters[${position}] under ${example.agreement} has no per-entry family key`,
      );
      assert.ok(entry.family, `${entry.reviewer} under ${example.agreement} carries no family`);
      assert.equal(
        entry.family,
        families.get(entry.reviewer),
        `${entry.reviewer} is rendered as ${entry.family} but its own reference claims ${families.get(entry.reviewer)}`,
      );
    }
    if (example.dissenters.length >= 2) {
      const distinct = new Set(example.dissenters.map((entry) => entry.family));
      if (distinct.size >= 2) crossFamily += 1;
      else singleFamily += 1;
    }
  }

  assert.ok(unanimousSeen >= 1, 'no worked unanimous annotation proves the dissenters key is absent');
  assert.ok(
    crossFamily >= 1,
    'no worked example shows a multi-dissenter dissent spanning two vendor families — the headline case D14 exists for',
  );
  assert.ok(
    singleFamily >= 1,
    'no worked example shows two dissenters inside one family, so the two cases are not shown to be distinguishable',
  );

  // The headline case names both new voices explicitly: agy and grok dissenting
  // together, in one annotation, in canonical order, with different families.
  const headline = examples.find((example) => {
    const named = example.dissenters.map((entry) => entry.reviewer);
    return named.includes('agy') && named.includes('grok');
  });
  assert.ok(headline, 'no worked example records agy and grok dissenting together');
  assert.equal(
    new Set(headline.dissenters.map((entry) => entry.family)).size,
    2,
    'the agy + grok dissent no longer spans two vendor families',
  );

  // ---- rule 4: no dual-writing ---------------------------------------------
  const retirement = report
    .replace(/\s+/gu, ' ')
    .match(/The singular ((?:`[a-z_]+`[,\s]*(?:and\s+)?)+)keys are retired/u);
  assert.ok(retirement, `${REPORT_FORMAT} no longer retires the singular dissent keys`);
  const retired = backtickedTokens(retirement[1]);
  assert.ok(retired.length >= 3, `only ${retired.length} singular key(s) are named as retired`);

  const sentence = paragraphContaining(report, 'The singular `dissenter`', REPORT_FORMAT);
  for (const relativePath of instructionFiles()) {
    const source = relativePath === REPORT_FORMAT
      ? read(relativePath).replace(/\n/gu, ' ').split(sentence).join(' ')
      : read(relativePath);
    for (const key of retired) {
      // A retired key survives as an alternative the moment it reappears as a
      // key or as a backticked identifier. `dissenter` also happens to be an
      // ordinary English word, so prose use stays legal and key use does not.
      const asKey = new RegExp(`\`${key}\`|\\b${key}\\s*:`, 'u');
      assert.doesNotMatch(
        source,
        asKey,
        `${relativePath} still offers the retired singular key \`${key}\` — a consumer reading it gets a silently truncated dissent`,
      );
    }
  }

  // The retirement is only meaningful if the array is what replaced it, and the
  // order rule has to point at something that exists.
  const order = paragraphContaining(report, 'Entries are ordered by', REPORT_FORMAT);
  assert.match(order, /`canonicalReviewerIndex`/u, 'the dissenters order rule names no total order');
  assert.match(order, new RegExp(escapeForRegex(ROUTING_MODULE), 'u'));
  assert.match(read(ROUTING_MODULE), /function canonicalReviewerIndex\(/u);

  // ---- rule 5: none of the four rules has a shipped alternative -------------
  //
  // Rules 1–4 above each pin one statement. Stating a rule once does not make it
  // the only statement: a later sentence saying the opposite is what the
  // composing agent would follow, and nothing above would notice. The four slots
  // D14 closes are checked here against every shipped instruction surface.
  const arrayKey = schema.topKeys[0];
  const derivation = paragraphContaining(report, '`dissenters.length` is derived', REPORT_FORMAT);
  const countKey = backtickedTokens(derivation).find((token) => token.startsWith(`${arrayKey}.`));
  assert.ok(countKey, `${REPORT_FORMAT}: the derivation sentence names no derived cardinality`);
  const orderAuthority = backtickedTokens(order).find((token) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(token));
  assert.ok(orderAuthority, `${REPORT_FORMAT}: the order rule names no ordering authority`);

  // The closed vocabulary, assembled from what the shipped text already says
  // rather than from a list held here — a name this test invented could go stale
  // against the instruction without either side noticing.
  const placeholders = [...new Set(members.join('').match(/[A-Z]/gu) || [])];
  const slots = {
    arrayKey,
    countKey,
    orderAuthority,
    identifiers: new Set(
      [
        arrayKey,
        countKey,
        orderAuthority,
        'agreement',
        ...schemaKeys,
        ...members,
        ...table.map((row) => row.literal),
        ...vocabulary,
        ...reviewerIds,
        ...placeholders,
      ].map((value) => value.toLowerCase()),
    ),
  };

  const alternatives = [];
  for (const relativePath of instructionFiles()) {
    for (const finding of alternativeStatements(read(relativePath), slots)) {
      alternatives.push(`${relativePath} [${finding.rule}] ${finding.detail}\n    ${finding.unit}`);
    }
  }
  assert.deepEqual(
    alternatives,
    [],
    `a shipped instruction file states an alternative to a rule D14 makes deterministic — the composing agent reads both and follows the last one:\n  ${alternatives.join('\n  ')}`,
  );
});

test('the instruction sweep compares canonical paths under native Windows separators', () => {
  const windowsRoot = 'C:\\deep-review';
  const windowsReport = path.win32.join(
    windowsRoot,
    ...REPORT_FORMAT.split('/'),
  );
  assert.equal(
    canonicalInstructionPath(path.win32.relative(windowsRoot, windowsReport), path.win32.sep),
    REPORT_FORMAT,
  );
});

test('the N-way review mode and its reviewer columns generalize past four voices', async () => {
  const report = read(REPORT_FORMAT);
  const reviewerIds = await canonicalReviewerOrder();

  const mode = report.match(/^- \*\*Review Mode\*\*: \{(.+)\}$/mu);
  assert.ok(mode, `${REPORT_FORMAT} no longer states the Review Mode vocabulary`);
  assert.match(mode[1], /N-way Cross-Model/u, 'Review Mode is not documented generically');
  assert.match(mode[1], /`N ≥ 2`/u, 'the generic mode states no lower bound');
  for (const n of [2, 3, 4, reviewerIds.length]) {
    assert.match(
      mode[1],
      new RegExp(`${n}-way Cross-Model`, 'u'),
      `Review Mode cannot express a ${n}-way round even though ${n} reviewers are selectable`,
    );
  }

  // The verification table renders one column per selected reviewer, in the same
  // total order the dissenters array uses. A fifth selectable reviewer with no
  // column is a voice the report cannot show.
  const header = report.match(/^\| 항목 \|(.+)\| Agreement \|$/mu);
  assert.ok(header, `${REPORT_FORMAT} no longer ships the Cross-Model Verification header`);
  const columns = header[1].split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
  assert.equal(
    columns.length,
    reviewerIds.length,
    `${columns.length} reviewer column(s) for ${reviewerIds.length} canonical reviewers`,
  );
  assert.match(columns.join(' | '), /Grok/u, 'the verification table has no Grok column');

  const columnRule = paragraphContaining(report, 'reviewers actually selected', REPORT_FORMAT);
  assert.doesNotMatch(
    columnRule,
    /N < 4/u,
    'the column rule is still pinned to a four-reviewer world',
  );
  assert.match(columnRule, /canonicalReviewerIndex/u, 'the column rule states no order');
});

test('the report filename example is Node-expressible on every supported platform', () => {
  const report = read(REPORT_FORMAT);
  // AGENTS.md makes native Windows 11 with no Git Bash a release invariant, and
  // `cmd.exe`'s `date` is interactive with different semantics. A host shell
  // command inside a runtime-loaded instruction is a supported-platform failure.
  assert.doesNotMatch(
    report,
    /`date\s+["'+]/u,
    `${REPORT_FORMAT} tells an agent to shell out to \`date\`, which fails on native Windows`,
  );
  assert.match(report, /new Date\(\)\.toISOString\(\)/u, 'no Node-expressible filename recipe is shipped');
});

test('every reference that carries dissent points at the dissenters array', () => {
  const codex = read(CODEX_INTEGRATION);
  const agy = read(AGY_INTEGRATION);
  const response = read(RESPONSE_PROTOCOL);
  const phase6 = read(PHASE6_PROMPT);

  // Codex owns the synthesis vocabulary: the five-voice case has to exist there
  // or a composing agent has no authority to write `majority_3_of_5` at all.
  assert.match(codex, /with five: unanimous, majority four of five, majority three of five,\s+split two of\s+five, or solo/u);
  assert.match(codex, /`dissenters`/u, 'codex-integration.md never names the dissenters array');
  assert.match(codex, /`majority_3_of_5` has two entries/u, 'codex-integration.md omits the multi-dissenter shape');

  assert.match(agy, /`dissenters`/u, 'agy-integration.md still describes a singular dissent');

  // The respond side has to be able to weigh a two-family dissent differently
  // from a lone-vendor one, which means its confidence table has to name both.
  assert.match(response, /Grok/u, 'the response confidence matrix has no Grok row');
  assert.match(response, /`majority_K_of_N`/u, 'the response matrix is still pinned to 3/4');
  assert.doesNotMatch(response, /3\/4 이상 일치/u, 'the hardcoded 3/4 row survives');
  assert.match(response, /`dissenters\.length` ≥ 2/u, 'no row covers a multi-dissenter dissent');
  assert.match(response, /2개 이상[^|]*family/u, 'no row covers a dissent spanning two provider families');

  assert.match(phase6, /^- source: .*\bGrok\b.*$/mu, 'the Phase 6 source enumeration cannot name Grok');
});
