'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const loopState = path.join(root, 'hooks', 'scripts', 'loop-state.mjs');
const publicRoutePath = path.join(root, 'hooks', 'scripts', 'public-route.mjs');
const publicRouteUrl = pathToFileURL(publicRoutePath).href;

async function loadPublicRoute() {
  return import(publicRouteUrl);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function anchoredBody(source, name) {
  const normalized = source.replace(/\r\n|\r/gu, '\n');
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  assert.notEqual(normalized.indexOf(start), -1, `${name} start marker missing`);
  assert.notEqual(normalized.indexOf(end), -1, `${name} end marker missing`);
  return normalized.slice(
    normalized.indexOf(start) + start.length,
    normalized.indexOf(end),
  );
}

function runLoop(args) {
  const result = spawnSync(process.execPath, [loopState, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { ...result, json };
}

test('public skill owns the route-first grammar and Claude command is a thin same-args shim', () => {
  const publicSkill = read('skills/deep-review/SKILL.md');
  assert.match(publicSkill, /^name: deep-review$/m);
  assert.match(publicSkill, /^user-invocable: true$/m);
  assert.match(publicSkill, /--contract \[SLICE-NNN\]/);
  assert.match(publicSkill, /--respond \(REPORT_PATH \| --source=pr/);
  assert.match(publicSkill, /--ultracode/);
  assert.match(publicSkill, /--codex-only/);
  assert.match(publicSkill, /public-route\.mjs --entry review/);
  for (const route of ['init', '--respond', '--qa', 'review']) {
    assert.match(
      publicSkill,
      new RegExp(`(?:${escapeRegex(route)}).{0,160}(?:terminal|종료)`, 'isu'),
      `${route} must be terminal`,
    );
  }

  const command = read('commands/deep-review.md');
  assert.match(command, /skills\/deep-review\/SKILL\.md/);
  assert.match(command, /\$ARGUMENTS/);
  assert.doesNotMatch(command, /deep-review-workflow\/SKILL\.md/);
  assert.doesNotMatch(command, /review-execution\.md/);
  assert.ok(command.split(/\r?\n/).length <= 35, 'Claude shim duplicated the public pipeline');
});

test('production route and synthesis helpers own parsing and fail-closed reviewer admission', () => {
  const publicSkill = read('skills/deep-review/SKILL.md');
  const loop = read('skills/deep-review-loop/SKILL.md');
  const review = read('skills/deep-review-workflow/references/review-execution.md');
  assert.match(publicSkill, /returned JSON.{0,120}executable route authority/is);
  assert.match(loop, /public-route\.mjs --entry loop/);
  assert.match(review, /review-synthesis\.mjs --input/);
  assert.match(review, /phase6_allowed/);
  assert.match(review, /operational_failure.{0,160}no later response or Phase 6 commit/is);
});

test('reviewer admission separates raw-output binding from independent reviewer identity', () => {
  const review = read('skills/deep-review-workflow/references/review-execution.md');

  assert.match(review, /SHA-256.{0,120}raw output.{0,160}each\s+attempt/is);
  assert.match(
    review,
    /independence.{0,240}unique canonical reviewer IDs.{0,240}fresh route-specific dispatch.{0,240}provenance.{0,160}fingerprints/is,
  );
  assert.match(
    review,
    /byte-identical canonical reports.{0,200}distinct\s+identities.{0,160}allowed.{0,160}not.{0,120}operational identity\s+failure/is,
  );
  assert.match(
    review,
    /duplicate `reviewer_id`.{0,200}missing or invalid provenance.{0,160}operational failure/is,
  );
  assert.doesNotMatch(
    review,
    /reusing one identical output under two canonical voice identities is an operational identity failure/is,
  );
});

test('Codex manifest exposes only the two public entrypoints and keeps hooks/MCP empty', () => {
  const manifest = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.deepEqual(manifest.interface.defaultPrompt, [
    '$deep-review:deep-review',
    '$deep-review:deep-review-loop',
  ]);
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);
  assert.deepEqual(JSON.parse(read('hooks/hooks.json')).hooks, {});
});

test('release documentation keeps Claude and Codex public route examples distinct', () => {
  const publicSkill = read('skills/deep-review/SKILL.md');
  const loopSkill = read('skills/deep-review-loop/SKILL.md');
  const command = read('commands/deep-review.md');
  const readmes = [read('README.md'), read('README.ko.md')];

  assert.match(publicSkill, /\$deep-review:deep-review/u);
  assert.match(publicSkill, /\/deep-review/u);
  assert.match(loopSkill, /\$deep-review:deep-review-loop/u);
  assert.match(loopSkill, /\/deep-review-loop/u);
  assert.match(command, /same argument|same arguments|동일한 인자/iu);

  for (const source of readmes) {
    assert.match(source, /Claude Code/u);
    assert.match(source, /Codex/u);
    assert.equal(source.includes('/deep-review'), true);
    assert.equal(source.includes('/deep-review --respond'), true);
    assert.equal(source.includes('/deep-review-loop'), true);
    assert.equal(source.includes('$deep-review:deep-review'), true);
    assert.equal(source.includes('$deep-review:deep-review-loop'), true);
    assert.match(source, /Node(?:\.js)? 22/u);
    assert.match(source, /Windows 11/u);
    assert.match(source, /Git Bash/u);
  }
});

test('runtime dispatch SSOT is capability-based and defines the exact role matrix', () => {
  const dispatch = read('skills/deep-review-workflow/references/runtime-dispatch.md');
  const rows = [
    ['public review/respond entry', '/deep-review', '$deep-review:deep-review'],
    ['loop entry', '/deep-review-loop', '$deep-review:deep-review-loop'],
    ['independent Claude reviewer', 'Agent(code-reviewer)', 'Node Claude bridge when CLI exists'],
    ['Codex standard reviewer', 'Node Codex exec bridge', 'generic subagent'],
    ['Codex adversarial reviewer', 'Node Codex exec bridge', 'generic subagent'],
    ['agy reviewer', 'Node agy bridge', 'Node agy bridge'],
  ];
  for (const row of rows) {
    for (const cell of row) assert.match(dispatch, new RegExp(escapeRegex(cell)));
  }
  assert.match(dispatch, /tool capability/i);
  assert.match(dispatch, /runtime_host.{0,100}(?:never|아니|금지)/is);
  assert.match(dispatch, /codex-review/);
  assert.match(dispatch, /codex-adversarial/);
  assert.match(dispatch, /claude-opus/);
  assert.match(dispatch, /--no-codex.{0,120}(?:both|둘 다)/is);
  assert.match(dispatch, /pre.{0,20}post.{0,80}fingerprint/is);
  assert.match(dispatch, /untrusted.{0,80}excluded/is);
  assert.match(dispatch, /capability-registry\.mjs/u);
  assert.match(dispatch, /executable capability contract.{0,120}authoritative/isu);
  assert.doesNotMatch(dispatch, /companion/iu);
});

test('Codex native dispatch uses two history-free route-specific leaves with transport and trust controls', () => {
  const workflow = read('skills/deep-review-workflow/SKILL.md');
  const dispatch = read('skills/deep-review-workflow/references/runtime-dispatch.md');
  const integration = read('skills/deep-review-workflow/references/codex-integration.md');
  const execution = read('skills/deep-review-workflow/references/review-execution.md');
  const agent = read('agents/code-reviewer.md');
  const combined = [workflow, dispatch, integration, execution, agent].join('\n');

  for (const reviewerId of ['codex-review', 'codex-adversarial']) {
    assert.match(
      combined,
      new RegExp(`${reviewerId}.{0,500}fork_turns:\\s*["'\`]none["'\`]`, 'isu'),
      `${reviewerId} must use a history-free leaf`,
    );
    assert.match(
      combined,
      new RegExp(`${reviewerId}.{0,700}(?:resolved\\.)?model.{0,160}(?:resolved\\.)?effort`, 'isu'),
      `${reviewerId} must receive its resolved model and effort`,
    );
  }
  assert.match(combined, /two.{0,100}(?:separate|distinct|independent).{0,160}subagents/is);
  assert.match(combined, /different subagent (?:IDs|identities)/i);
  assert.match(combined, /invocation-unique.{0,100}task_name/is);
  assert.match(combined, /canonical reviewer IDs.{0,160}(?:routing|report) provenance/is);
  assert.match(combined, /never.{0,100}(?:reuse|followup_task).{0,160}(?:subagent|history)/is);
  assert.match(combined, /route-specific payload/i);
  assert.match(combined, /generator history.{0,100}(?:not|never|without|없)/is);
  assert.match(combined, /same.{0,80}fingerprint API/is);
  assert.match(combined, /explicit.{0,120}(?:model|effort).{0,160}(?:unsupported|rejected).{0,160}(?:single|one).{0,80}retry/is);
  assert.match(combined, /--allow-fallback/);
  assert.match(agent, /both.{0,40}`codex-review` and `codex-adversarial`/s);
  assert.doesNotMatch(combined, /companion/iu);

  for (const dimension of ['model', 'effort']) {
    assert.match(
      combined,
      new RegExp(`resolved\\.${dimension}\\s*!==\\s*null`, 'u'),
      `native dispatch must omit a null ${dimension} field`,
    );
  }
  assert.doesNotMatch(
    combined,
    /spawn_agent\(\{[^}\n]*model:\s*codexReviewRoute\.resolved\.model/u,
    'native dispatch examples must not unconditionally pass null model/effort fields',
  );
  assert.match(combined, /spawn_agent.{0,500}no enforceable (?:tool )?allowlist/is);
  assert.match(
    execution,
    /strictly serial.{0,240}pre-review fingerprint.{0,240}one leaf.{0,240}post-review fingerprint.{0,240}trust decision.{0,240}next leaf/is,
    'native reviewer dispatch must serialize each leaf behind its fingerprint trust decision',
  );
  assert.doesNotMatch(
    execution,
    /launch every (?:selected|eligible) route in a fresh background context/is,
  );
  assert.match(
    combined,
    /mutation.{0,160}(?:invalidates|untrusted).{0,240}stop.{0,120}round.{0,200}sibling.{0,160}commit/is,
  );
  assert.doesNotMatch(combined, /mutation.{0,100}(?:prevented|cannot occur)/is);
});

test('Codex bridge and host assertions route both roles without companion fallback', () => {
  const execution = read('skills/deep-review-workflow/references/review-execution.md');
  const integration = read('skills/deep-review-workflow/references/codex-integration.md');
  const combined = [execution, integration].join('\n');

  assert.match(
    execution,
    /"claudeNativeAgent":true,"codexExecReviewer":true,"codexNativeGeneric":false/u,
  );
  assert.match(
    execution,
    /"claudeNativeAgent":false,"codexExecReviewer":false,"codexNativeGeneric":true/u,
  );
  for (const reviewerId of ['codex-review', 'codex-adversarial']) {
    assert.match(
      combined,
      new RegExp(
        `run-codex-reviewer\\.mjs[^\\n]*--prompt-file PROMPT_FILE[^\\n]*--execution-route-json EXECUTION_ROUTE_JSON[^\\n]*--reviewer-id ${reviewerId}`,
        'u',
      ),
      `${reviewerId} must use the generic Codex exec bridge`,
    );
  }
  assert.doesNotMatch(combined, /--kind|--companion|--focus-file|index exposure/iu);
});

test('public review skill documents every Phase 2 routing override', () => {
  const publicSkill = read('skills/deep-review/SKILL.md');
  const hint = publicSkill.match(/^argument-hint: (.+)$/mu)?.[1] ?? '';
  for (const flag of [
    '--reviewer',
    '--model',
    '--reviewer-model',
    '--effort',
    '--routing',
    '--reviewer-strategy',
    '--readiness-receipt',
    '--allow-fallback',
    '--allow-classifier',
  ]) assert.match(hint, new RegExp(flag));
  assert.match(publicSkill, /--allow-classifier.{0,240}semantic/isu);
  assert.match(publicSkill, /review-policy\.yaml/u);
  assert.match(publicSkill, /shadow/iu);
  assert.match(publicSkill, /Adaptive reviewer routing and automatic model routing are enabled by default/u);
});

test('loop public contract forwards routing controls and codifies document readiness caps', () => {
  const loop = read('skills/deep-review-loop/SKILL.md');
  const hint = loop.match(/^argument-hint: (.+)$/mu)?.[1] ?? '';
  for (const flag of [
    '--reviewer-strategy',
    '--readiness-receipt',
    '--routing',
    '--model',
    '--effort',
    '--reviewer-model',
    '--reviewer-effort',
    '--allow-fallback',
    '--allow-classifier',
  ]) assert.match(hint, new RegExp(flag));
  assert.match(loop, /low\/medium document scope to 2/u);
  assert.match(loop, /high\/critical document scope to 3/u);
  assert.match(loop, /READY_FOR_IMPLEMENTATION/u);
  assert.match(loop, /DOCUMENT_BLOCKED/u);
  assert.match(loop, /routing-metadata-file/u);
});

test('supported runtime references use Node/direct tools and the runtime-root contract', () => {
  const runtimeReferences = [
    'skills/deep-review-workflow/SKILL.md',
    'skills/deep-review-loop/SKILL.md',
    'skills/deep-review-workflow/references/runtime-dispatch.md',
    'skills/deep-review-workflow/references/review-execution.md',
    'skills/deep-review-workflow/references/codex-integration.md',
    'skills/deep-review-workflow/references/agy-integration.md',
    'skills/deep-review-workflow/references/ultracode-integration.md',
    'skills/deep-review-workflow/references/recurring-findings-export.md',
    'skills/deep-review-workflow/references/init-setup.md',
  ];
  const forbidden = /(?:\.sh\b|\bbash\b|\bpython3\b|\bperl\b|\bmktemp\b|\bshopt\b|\bfind\b|\bawk\b|\bsed\b|\bxargs\b|<\(|\bcomm\b|\brealpath\b|_timeout)/i;
  for (const relativePath of runtimeReferences) {
    const source = read(relativePath);
    assert.doesNotMatch(source, forbidden, `${relativePath} retains a host-only executable path`);
    assert.doesNotMatch(source, /\$\{CLAUDE_PLUGIN_ROOT(?::[^}]*)?\}/, `${relativePath} bypasses runtime root`);
  }
  const combined = runtimeReferences.map(read).join('\n');
  for (const helper of [
    'detect-environment.mjs',
    'build-reviewer-payload.mjs',
    'mutation-protocol.mjs',
    'agy-privacy-preflight.mjs',
    'run-claude-reviewer.mjs',
    'run-codex-reviewer.mjs',
    'run-agy-reviewer.mjs',
    'loop-state.mjs',
  ]) assert.match(combined, new RegExp(helper.replace('.', '\\.')));
  assert.match(combined, /plugin_root.{0,160}PLUGIN_ROOT.{0,160}CLAUDE_PLUGIN_ROOT/is);
});

test('respond references are shell-free and route every stateful operation through Node helpers', () => {
  const respondReferences = [
    'skills/deep-review/SKILL.md',
    'skills/receiving-review/SKILL.md',
    'skills/receiving-review/references/respond-execution.md',
    'skills/receiving-review/references/response-protocol.md',
    'skills/receiving-review/references/response-format.md',
    'skills/receiving-review/references/phase6-delegation-spec.md',
    'skills/receiving-review/references/phase6-prompt-contract.md',
    'agents/phase6-implementer.md',
  ];
  const forbidden = /```(?:bash|sh|shell)|\bbash\s+-c\b|\btee\b|\bls\s+-[^\n]*t\b|\bmkdir\s+-p\b|\bcompgen\b|\b(?:awk|sed)\b|<\(|\$log_path|\$\{(?:severity|CLAUDE_PLUGIN_ROOT)|'\\''/iu;
  for (const relativePath of respondReferences) {
    assert.doesNotMatch(
      read(relativePath),
      forbidden,
      `${relativePath} retains an executable shell-only respond recipe`,
    );
  }

  const respond = read('skills/receiving-review/references/respond-execution.md');
  assert.match(respond, /mutation-protocol\.mjs.{0,180}auto-recover/is);
  assert.match(respond, /phase6-protocol\.mjs.{0,100}rotate/is);
  for (const subcommand of ['list-reports', 'fetch-pr', 'write-report', 'post-pr-response']) {
    assert.match(respond, new RegExp(`respond-runtime\\.mjs.{0,180}${subcommand}`, 'is'));
  }
  assert.match(respond, /fs\.stat|statSync/);
  assert.match(respond, /(?:explicit|지정).{0,120}(?:unchanged|그대로)/is);
  assert.match(respond, /exact.{0,80}\*-review\.md|\*-review\.md.{0,80}exact/is);
});

test('Claude and Codex Phase 6 dispatch reuse one accepted-items prompt and one Node protocol', () => {
  const respond = read('skills/receiving-review/references/respond-execution.md');
  const prompt = read('skills/receiving-review/references/phase6-prompt-contract.md');
  const delegation = read('skills/receiving-review/references/phase6-delegation-spec.md');
  const agent = read('agents/phase6-implementer.md');
  const combined = [respond, prompt, delegation, agent].join('\n');

  assert.match(respond, /Agent\(\{\s*subagent_type:\s*["']deep-review:phase6-implementer["']/s);
  assert.match(respond, /Agent\(\{\s*subagent_type:\s*["']phase6-implementer["']/s);
  assert.match(respond, /spawn_agent/);
  assert.match(respond, /one generic subagent per severity group|심각도 그룹마다 하나의 generic subagent/i);
  assert.match(respond, /first action.{0,200}absolute.{0,120}agents\/phase6-implementer\.md/is);
  assert.match(respond, /nested dispatch.{0,80}(?:forbid|금지)/is);
  assert.match(combined, /same serialized.{0,120}Accepted Items|Accepted Items.{0,120}byte-identical/is);
  assert.match(combined, /snapshot_path.{0,160}allowed paths/is);

  for (const subcommand of ['snapshot', 'run-test', 'verify', 'recover', 'commit']) {
    assert.match(combined, new RegExp(`phase6-protocol\\.mjs.{0,180}${subcommand}`, 'is'));
  }
  assert.match(agent, /JSON argv file/i);
  assert.match(agent, /JSON-escaped string token/i);
  assert.match(agent, /(?:Agent|subagent).{0,100}(?:forbidden|금지)/is);
  assert.match(respond, /always.{0,100}verify|verify.{0,100}(?:always|항상)/is);
  assert.match(respond, /malformed.{0,180}execution_status.{0,40}error/is);
  assert.match(respond, /requires_user_confirmation/);
  assert.match(respond, /explicit affirmative|명시적 긍정/);
  assert.match(respond, /decline|defer/i);
  assert.match(respond, /DEEP_REVIEW_FORCE_FALLBACK=1/);
  assert.match(respond, /zero-item|0건.{0,80}skip/is);
  for (const executionPath of ['subagent', 'main_fallback', 'mixed', 'n/a']) {
    assert.match(respond, new RegExp(escapeRegex(executionPath)));
  }
});

test('review loop delegates Respond to the public branch and keeps defer and stop semantics', () => {
  const loop = read('skills/deep-review-loop/SKILL.md');
  assert.match(loop, /public `--respond` branch/);
  assert.match(loop, /exact absolute.{0,80}round_review_report_path/is);
  assert.match(loop, /DEFER-and-stop/);
  assert.match(loop, /response halted/);
});

test('model and reviewer dispatch documentation preserves aliases and Codex generic independence', () => {
  const combined = [
    read('skills/deep-review-workflow/SKILL.md'),
    read('skills/deep-review-workflow/references/review-execution.md'),
    read('skills/deep-review-workflow/references/runtime-dispatch.md'),
  ].join('\n');
  assert.match(combined, /review_model.{0,140}non-empty installed Claude model alias/is);
  assert.match(combined, /review_model.{0,140}fable/is);
  assert.doesNotMatch(combined, /opus\s*\|\s*sonnet/i);
  assert.match(combined, /Agent\(code-reviewer\)/);
  assert.match(combined, /spawn_agent/);
  assert.match(combined, /absolute.{0,80}agents\/code-reviewer\.md.{0,160}route-specific payload/is);
  assert.match(combined, /read-only/i);
  assert.match(combined, /report contract/i);
  assert.match(combined, /codex-review.{0,200}codex-adversarial.{0,240}(?:separate|distinct|independent)/is);
  assert.match(combined, /fork_turns:\s*["'`]none["'`]/);
});

test('agy route resolves flags before preflight and no-agy/codex-only are mutation-free', () => {
  const source = read('skills/deep-review-workflow/references/review-execution.md');
  const flagOffset = source.indexOf('resolve reviewer flags');
  const preflightOffset = source.indexOf('agy-privacy-preflight.mjs');
  assert.ok(flagOffset >= 0 && preflightOffset > flagOffset);
  assert.match(source, /needs_approval.{0,220}(?:approval|승인)/is);
  assert.match(source, /auto_ack.{0,160}(?:patch|config)/is);
  assert.match(source, /--no-agy.{0,220}(?:scan|preflight).{0,140}(?:state|config).{0,80}(?:no-op|않)/is);
  assert.match(source, /--codex-only.{0,220}(?:scan|preflight).{0,140}(?:state|config).{0,80}(?:no-op|않)/is);
});

test('init is shell-free and doctrine anchors remain byte-identical under the Node injector', () => {
  const init = read('skills/deep-review-workflow/references/init-setup.md');
  assert.match(init, /Node CLI|host file-creation tool/i);
  assert.doesNotMatch(init, /```(?:sh|shell)|mkdir -p/i);

  const criteria = read('skills/deep-review-workflow/references/review-criteria.md');
  assert.match(criteria, /build-reviewer-payload\.mjs.{0,160}all supported runtimes/is);
  assert.match(criteria, /extract-fp-doctrine\.sh.{0,120}Unix parity oracle/is);
  assert.doesNotMatch(criteria, /extract-fp-doctrine\.sh.{0,120}(?:inject|주입)/is);
  const doctrineLf = anchoredBody(criteria, 'fp-doctrine');
  const doctrineCrlf = anchoredBody(criteria.replace(/\r\n|\n|\r/gu, '\r\n'), 'fp-doctrine');
  assert.equal(doctrineCrlf, doctrineLf);
  assert.equal(sha256(doctrineLf), '1cfa74f3e6af65b7d778a476a3faf18d4e780392393ab0251bd1851b4cbf2dbe');
  const conservativeLf = anchoredBody(criteria, 'fp-conservative');
  const conservativeCrlf = anchoredBody(criteria.replace(/\r\n|\n|\r/gu, '\r\n'), 'fp-conservative');
  assert.equal(conservativeCrlf, conservativeLf);
  assert.equal(sha256(conservativeLf), '14a3f66dc8637dc14bc7a39c349dcc606a208f50c29ba8a934b8e6696ef1ba08');
});

test('loop-state snapshots sets, enforces one-report delta, compares paths, and emits metrics JSON', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep review loop Ω-'));
  const reports = path.join(repo, '.deep-review', 'reports');
  const responses = path.join(repo, '.deep-review', 'responses');
  const snapshot = path.join(repo, '.deep-review', 'tmp', 'round-1.json');
  fs.mkdirSync(reports, { recursive: true });
  fs.mkdirSync(responses, { recursive: true });
  fs.writeFileSync(path.join(reports, '2026-07-13-100000-review.md'), '# old\n');

  const before = runLoop(['snapshot-reports', '--reports-dir', reports, '--output', snapshot]);
  assert.equal(before.status, 0, before.stderr);
  assert.equal(before.json.ok, true);
  assert.deepEqual(before.json.reports, [path.resolve(reports, '2026-07-13-100000-review.md')]);

  const newReport = path.join(reports, '2026-07-13-100001-review.md');
  fs.writeFileSync(newReport, [
    '# Deep Review Report',
    '## Summary',
    '- **Verdict**: REQUEST_CHANGES',
    '- **Issues**: 🔴 1건, 🟡 2건, ℹ️ 3건',
    '### 🔴 Critical',
    '- unsafe edge at `src/a.js:14`',
    '### 🟡 Warning',
    '- missing test at `src/b.js:21`',
    '- path-safe issue at `src/space name Ω.js:28`',
  ].join('\n'));

  const resolved = runLoop(['resolve-round-report', '--reports-dir', reports, '--snapshot-file', snapshot]);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(resolved.json.report_path, path.resolve(newReport));

  const same = runLoop(['assert-same-path', '--expected', newReport, '--actual', path.join(reports, '.', path.basename(newReport))]);
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.json.same, true);
  const different = runLoop(['assert-same-path', '--expected', newReport, '--actual', path.join(reports, 'other.md')]);
  assert.notEqual(different.status, 0);
  assert.equal(different.json.same, false);

  const response = path.join(responses, '2026-07-13-100002-response.md');
  fs.writeFileSync(response, [
    '# Response Report',
    '## Summary',
    '- **Items**: 수락 2건, 반박 1건, 보류 0건',
    '- **execution_path**: subagent',
    '- **implemented_count**: 2',
    '- **halted**: false',
  ].join('\n'));
  const metrics = runLoop([
    'collect-metrics', '--round-number', '1', '--review-report', newReport,
    '--response-report', response,
  ]);
  assert.equal(metrics.status, 0, metrics.stderr);
  assert.deepEqual(
    {
      verdict: metrics.json.verdict,
      red: metrics.json.count_red,
      yellow: metrics.json.count_yellow,
      info: metrics.json.count_info,
      accepted: metrics.json.accepted_count,
      rejected: metrics.json.rejected_count,
      deferred: metrics.json.deferred_count,
      implemented: metrics.json.implemented_count,
      halted: metrics.json.halted,
      execution: metrics.json.execution_path,
    },
    {
      verdict: 'REQUEST_CHANGES', red: 1, yellow: 2, info: 3,
      accepted: 2, rejected: 1, deferred: 0, implemented: 2,
      halted: false, execution: 'subagent',
    },
  );
  assert.ok(metrics.json.findings_signature.includes('critical:src/a.js:2:untagged'));
  assert.ok(metrics.json.findings_signature.includes('warning:src/b.js:3:untagged'));
  assert.ok(metrics.json.findings_signature.includes('warning:src/space name Ω.js:4:untagged'));

  fs.writeFileSync(path.join(reports, '2026-07-13-100003-review.md'), '# second new\n');
  const ambiguous = runLoop(['resolve-round-report', '--reports-dir', reports, '--snapshot-file', snapshot]);
  assert.notEqual(ambiguous.status, 0);
  assert.equal(ambiguous.json.error.code, 'REPORT_DELTA_COUNT');
});

test('loop metrics rejects a report that omits the required Issues summary', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-review-loop-malformed-'));
  const report = path.join(repo, 'bad-review.md');
  fs.writeFileSync(report, '# Review\n- **Verdict**: APPROVE\n');
  const result = runLoop(['collect-metrics', '--round-number', '1', '--review-report', report]);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.error.code, 'INVALID_REPORT');
});

test('public-route review grammar accepts an optional --prior-rounds-file=PATH token without changing any existing flag semantics', async () => {
  const { parsePublicRoute } = await loadPublicRoute();
  const cwd = process.cwd();

  const withPrior = parsePublicRoute({
    entry: 'review',
    argv: ['--entropy', '--prior-rounds-file=/tmp/loop-x-round-2.prior.md'],
    host: 'claude',
    cwd,
  });
  assert.equal(withPrior.ok, true);
  assert.equal(withPrior.route, 'review');

  const combinedWithCodexOnly = parsePublicRoute({
    entry: 'review',
    argv: ['--codex-only', '--prior-rounds-file=/tmp/x.md'],
    host: 'claude',
    cwd,
  });
  assert.equal(combinedWithCodexOnly.ok, true);
  assert.deepEqual(combinedWithCodexOnly.argv, ['--codex', '--no-opus', '--no-agy', '--prior-rounds-file=/tmp/x.md']);

  // A value-less token is still rejected — the flag requires `=PATH`.
  const valueless = parsePublicRoute({ entry: 'review', argv: ['--prior-rounds-file'], host: 'claude', cwd });
  assert.equal(valueless.ok, false);

  // Existing flag conflicts are unchanged by the new token's presence.
  const stillConflicts = parsePublicRoute({
    entry: 'review', argv: ['--ultracode', '--no-opus', '--prior-rounds-file=/tmp/x.md'], host: 'claude', cwd,
  });
  assert.equal(stillConflicts.ok, false);
  assert.match(stillConflicts.error, /--ultracode cannot be combined with --no-opus/);

  // No flag at all: baseline review route is unaffected.
  const bare = parsePublicRoute({ entry: 'review', argv: [], host: 'claude', cwd });
  assert.equal(bare.ok, true);
  assert.equal(bare.route, 'review');
});

test('public-route loop grammar is unchanged (does not accept --prior-rounds-file)', async () => {
  const { parsePublicRoute } = await loadPublicRoute();
  const rejected = parsePublicRoute({
    entry: 'loop', argv: ['--prior-rounds-file=/tmp/x.md'], host: 'claude', cwd: process.cwd(),
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /unknown loop argument/);
});

test('public-route loop grammar accepts the opt-in --session-doc flag; review and respond keep rejecting it', async () => {
  const { parsePublicRoute } = await loadPublicRoute();
  const cwd = process.cwd();

  // Loop entry accepts --session-doc (value-less opt-in), alone and combined.
  const loopAlone = parsePublicRoute({ entry: 'loop', argv: ['--session-doc'], host: 'claude', cwd });
  assert.equal(loopAlone.ok, true);
  assert.equal(loopAlone.route, 'loop');

  const loopCombined = parsePublicRoute({
    entry: 'loop', argv: ['--max=3', '--entropy', '--session-doc'], host: 'claude', cwd,
  });
  assert.equal(loopCombined.ok, true);

  // Default OFF is byte-identical to today: no flag → same accepted loop route.
  const loopBare = parsePublicRoute({ entry: 'loop', argv: [], host: 'claude', cwd });
  assert.equal(loopBare.ok, true);
  assert.equal(loopBare.route, 'loop');

  // The review entry (terminal single-review route) must NOT accept it.
  const reviewRejected = parsePublicRoute({ entry: 'review', argv: ['--session-doc'], host: 'claude', cwd });
  assert.equal(reviewRejected.ok, false);
  assert.match(reviewRejected.error, /unknown review argument/);

  // The respond branch must NOT accept it either.
  const respondRejected = parsePublicRoute({ entry: 'review', argv: ['--respond', '--session-doc'], host: 'claude', cwd });
  assert.equal(respondRejected.ok, false);
  assert.match(respondRejected.error, /unknown respond argument/);
});

test('public-route review grammar accepts the artifact-aware --dry-run and --explain-routing flags (review-only, dormant)', async () => {
  const { parsePublicRoute } = await loadPublicRoute();
  const cwd = process.cwd();

  // Each flag is accepted on the review entry and surfaced as an explicit boolean.
  const dryRun = parsePublicRoute({ entry: 'review', argv: ['--dry-run'], host: 'claude', cwd });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.route, 'review');
  assert.equal(dryRun.dryRun, true);

  const explain = parsePublicRoute({ entry: 'review', argv: ['--explain-routing'], host: 'codex', cwd });
  assert.equal(explain.ok, true);
  assert.equal(explain.explainRouting, true);

  // Composable with existing reviewer flags without disturbing them.
  const combined = parsePublicRoute({
    entry: 'review', argv: ['--codex-only', '--dry-run', '--explain-routing'], host: 'claude', cwd,
  });
  assert.equal(combined.ok, true);
  assert.deepEqual(combined.argv, ['--codex', '--no-opus', '--no-agy', '--dry-run', '--explain-routing']);
  assert.equal(combined.dryRun, true);
  assert.equal(combined.explainRouting, true);

  // Dormancy: with neither flag the review route is byte-identical to today —
  // no dryRun/explainRouting keys appear at all.
  const bare = parsePublicRoute({ entry: 'review', argv: [], host: 'claude', cwd });
  assert.deepEqual(bare, { ok: true, route: 'review', host: 'claude', argv: [] });

  // Existing conflicts are unchanged by the new tokens' presence.
  const stillConflicts = parsePublicRoute({
    entry: 'review', argv: ['--ultracode', '--no-opus', '--dry-run'], host: 'claude', cwd,
  });
  assert.equal(stillConflicts.ok, false);
  assert.match(stillConflicts.error, /--ultracode cannot be combined with --no-opus/);
});

test('the artifact-aware flags are review-only; loop and respond keep rejecting them', async () => {
  const { parsePublicRoute } = await loadPublicRoute();
  const cwd = process.cwd();

  for (const flag of ['--dry-run', '--explain-routing']) {
    const loopRejected = parsePublicRoute({ entry: 'loop', argv: [flag], host: 'claude', cwd });
    assert.equal(loopRejected.ok, false);
    assert.match(loopRejected.error, /unknown loop argument/);

    const respondRejected = parsePublicRoute({ entry: 'review', argv: ['--respond', flag], host: 'claude', cwd });
    assert.equal(respondRejected.ok, false);
    assert.match(respondRejected.error, /unknown respond argument/);
  }
});

test('the public skill wires --dry-run/--explain-routing to the classifier and never runs a reviewer', () => {
  const publicSkill = read('skills/deep-review/SKILL.md');
  assert.match(publicSkill, /--dry-run/);
  assert.match(publicSkill, /--explain-routing/);
  assert.match(publicSkill, /classify-artifacts\.mjs/);
  // The dry-run branch is explicit that it stops before any reviewer runs.
  assert.match(publicSkill, /(?:dryRun|dry-run|explainRouting|explain-routing)[\s\S]{0,400}(?:without running|no reviewer|리뷰어[^\n]*실행|종료)/i);
});

test('loop SKILL codifies compare-rounds consumption, no-new-verdict-on-skip, and explicit-flag prior-context handoff', () => {
  const loop = fs.readFileSync(path.join(root, 'skills', 'deep-review-loop', 'SKILL.md'), 'utf8');

  // Condition 3 is re-stated to consume compare-rounds's code output rather
  // than a natural-language "half of the larger set repeats" judgment.
  assert.match(loop, /compare-rounds.{0,200}stalled/is);
  assert.match(loop, /implemented_count.{0,80}0|0.{0,80}implemented_count/is);
  assert.match(loop, /response halted/i);

  // A review-skipped round must never fabricate a new verdict/N_actual.
  assert.match(loop, /(?:새|new).{0,40}verdict.{0,60}(?:생성 금지|must not|never)/is);

  // The prior-round advisory context is handed to Review via the explicit
  // public flag — never consumed merely because a file happens to exist.
  assert.match(loop, /--prior-rounds-file=/);
  assert.match(loop, /render-prior-context/);

  // rounds_saved bookkeeping and loop_id/record-round wiring.
  assert.match(loop, /rounds_saved/);
  assert.match(loop, /record-round/);
});

test('loop SKILL documents the opt-in --session-doc single per-session review document flow', () => {
  const loop = fs.readFileSync(path.join(root, 'skills', 'deep-review-loop', 'SKILL.md'), 'utf8');

  // The flag is advertised in the argument hint and the validate section.
  assert.match(loop, /--session-doc/);
  // ON path calls render-session-doc keyed by loop_id, in the reports dir.
  assert.match(loop, /render-session-doc/);
  assert.match(loop, /loop-\{loop_id\}-review\.md/);
  // The end-of-loop summary is absorbed into the session doc to avoid dup.
  assert.match(loop, /absorb|absorbed|흡수/i);
  // A FINAL post-stop render pass supplies the closing summary the per-round
  // renders never received, via the explicit --final-summary-file input.
  assert.match(loop, /--final-summary-file/);
  // Default OFF preserves today's per-round + loop-summary behavior.
  assert.match(loop, /(?:default|기본).{0,40}(?:OFF|off|없)/i);
});

test('review-execution Stage 2 forwards --prior-rounds-file to build-reviewer-payload only when explicitly provided', () => {
  const review = fs.readFileSync(
    path.join(root, 'skills', 'deep-review-workflow', 'references', 'review-execution.md'),
    'utf8',
  );
  assert.match(review, /--prior-rounds-file.{0,300}only when.{0,80}explicitly/is);
  assert.match(review, /--prior-rounds-file.{0,120}--prior-base/is);
  assert.match(review, /existence alone.{0,80}never trigger.{0,80}automatic consumption/is);
});

test('document instructions use practical blockers and readiness-owned final verdicts', () => {
  const english = [
    read('skills/deep-review-workflow/references/review-criteria.md'),
    read('agents/code-reviewer.md'),
    read('skills/deep-review-workflow/references/report-format.md'),
    read('skills/deep-review-workflow/references/review-execution.md'),
    read('skills/deep-review-loop/SKILL.md'),
    read('README.md'),
  ];
  const korean = [read('README.ko.md')];
  const practicalBlocker = /concrete repository\/artifact-grounded functional contradiction/i;
  const deferredEvidence = /implementation_verification.*objective acceptance evidence/is;
  const nonBlockers = /style.*readability.*naming.*preference.*ungrounded speculation/is;

  for (const source of english) {
    const normalized = source.replace(/\s+/gu, ' ');
    assert.match(normalized, /PRACTICAL DOCUMENT POLICY/u);
    assert.match(normalized, practicalBlocker);
    assert.match(normalized, /implementation infeasibility.*missing decision.*prevents execution/is);
    assert.match(normalized, /reachable safety\/security\/compatibility\/rollback harm/is);
    assert.match(normalized, /acceptance criteria.*objective(?:ly verified| verification)/is);
    assert.match(normalized, nonBlockers);
    assert.match(normalized, deferredEvidence);
    assert.match(normalized, /DOCUMENT_BLOCKED.*REQUEST_CHANGES.*READY_FOR_IMPLEMENTATION.*APPROVE/is);
    assert.match(normalized, /design-validation/u);
    assert.match(normalized, /full-readiness/u);
    assert.match(normalized, /design-validation.*implementation feasibility.*design soundness/is);
    assert.match(normalized, /full-readiness.*missing executable decision.*objectively verif/is);
    assert.match(normalized, /prose completeness.*(?:not|never).*block/is);
    assert.match(normalized, /mixed.*full-readiness/is);
  }
  for (const source of korean) {
    const normalized = source.replace(/\s+/gu, ' ');
    assert.match(normalized, /실용적 문서 정책/u);
    assert.match(normalized, /구체적.*기능 모순.*실행을 막는 결정 누락/is);
    assert.match(normalized, /안전.*보안.*호환성.*롤백/is);
    assert.match(normalized, /스타일.*가독성.*명명.*취향.*근거 없는 추측/is);
    assert.match(normalized, /구현 검증.*객관적으로/is);
    assert.match(normalized, /DOCUMENT_BLOCKED.*REQUEST_CHANGES.*READY_FOR_IMPLEMENTATION.*APPROVE/is);
    assert.match(normalized, /design-validation.*구현 가능성.*설계 건전성/is);
    assert.match(normalized, /full-readiness.*누락된 실행 가능 결정.*객관적으로 검증/is);
    assert.match(normalized, /문구 완결성.*차단하지/is);
    assert.match(normalized, /혼합.*full-readiness/is);
  }

  for (const relativePath of ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    assert.equal(JSON.parse(read(relativePath)).version, '2.4.0', relativePath);
  }

  const changelog = read('CHANGELOG.md');
  const koreanChangelog = read('CHANGELOG.ko.md');
  assert.match(changelog, /## \[2\.3\.0\][\s\S]*Practical document policy[\s\S]*Readiness-owned document verdict[\s\S]*Document convergence/u);
  assert.match(koreanChangelog, /## \[2\.3\.0\][\s\S]*실용적 문서 정책[\s\S]*Readiness 소유 문서 판정[\s\S]*문서 수렴/u);
  assert.doesNotMatch(changelog, /\n## PRACTICAL DOCUMENT POLICY\n/u);
});

// The emitted routing plan lives at a repository-internal path, so a repository
// under analysis can commit one there. Leaf adapters no longer read it — routes
// travel inline — and the only thing that could put a planted plan back into the
// trusted path is an instruction telling the orchestrator to read that file.
// Writing it (`--routing-plan-out`) is the audit copy and stays allowed.
test('no shipped instruction directs a read of the repository-internal routing plan', () => {
  const shipped = [
    'skills/deep-review-workflow/SKILL.md',
    'skills/deep-review-loop/SKILL.md',
    'skills/deep-review/SKILL.md',
    'skills/deep-review-workflow/references/runtime-dispatch.md',
    'skills/deep-review-workflow/references/review-execution.md',
    'skills/deep-review-workflow/references/codex-integration.md',
    'skills/deep-review-workflow/references/agy-integration.md',
    'commands/deep-review.md',
    'agents/code-reviewer.md',
  ];
  for (const relativePath of shipped) {
    const source = read(relativePath);
    for (const line of source.split('\n')) {
      if (!line.includes('.deep-review/tmp/routing-plan.json')) continue;
      assert.ok(
        line.includes('--routing-plan-out') || !line.includes('--routing-plan'),
        `${relativePath} feeds the repository-internal plan back as a trusted source: ${line.trim()}`,
      );
    }
  }

  // Leaves take their route inline; nothing hands them a plan path.
  const leafSurfaces = [
    'skills/deep-review-workflow/references/review-execution.md',
    'skills/deep-review-workflow/references/codex-integration.md',
  ].map(read).join('\n');
  for (const bridge of ['run-claude-reviewer.mjs', 'run-agy-reviewer.mjs', 'run-codex-reviewer.mjs']) {
    for (const line of leafSurfaces.split('\n')) {
      if (!line.includes(bridge)) continue;
      assert.doesNotMatch(
        line,
        /--routing-plan(?!-out)/u,
        `${bridge} must receive its route inline, not as a plan path`,
      );
    }
  }
});
