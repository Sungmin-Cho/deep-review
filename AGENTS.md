# deep-review — Agent Guide

Independent Evaluator for AI coding agents. This repository ships the public
cross-runtime skills, the Claude Code command adapter, a zero-dependency native
Node runtime, reviewer definitions, and compatibility oracles.

Both hosts read this file; it is the single source and carries no `@`-import of its
own, because Codex does not support them.

Read the current version, never hardcode it:
```bash
node -p "JSON.parse(require('node:fs').readFileSync('{plugin_root}/package.json','utf8')).version"
```

Two things about that command are deliberate. It is **anchored**, because unanchored it
reports the *analysed* project's version, not the plugin's. And it reads the file rather
than `require()`-ing it: a plugin path inside a JS module specifier has no safe spelling
here, since nothing substitutes a documentation placeholder inside JS — Node would look
for a package literally named `{plugin_root}` under the workspace's `node_modules`.

> 📄 Doc maintenance follows `docs/DOCS_RULE.md` — a maintainer rulebook that is
> gitignored and ships with nothing. It exists only in a maintainer's own checkout;
> never try to open it at runtime, because the only place that path can resolve in an
> installed plugin is the project being analysed.

## Runtime surfaces

- Manifests: `{plugin_root}/.claude-plugin/plugin.json` · `{plugin_root}/.codex-plugin/plugin.json`
- Public skills: `{plugin_root}/skills/deep-review/SKILL.md` and
  `{plugin_root}/skills/deep-review-loop/SKILL.md`
- Claude adapter: `{plugin_root}/commands/deep-review.md` — a thin passthrough to the skill
- Pipeline references: `{plugin_root}/skills/deep-review-workflow/references/`
- Response references: `{plugin_root}/skills/receiving-review/references/`
- Native runtime: `{plugin_root}/hooks/scripts/*.mjs` and `{plugin_root}/hooks/scripts/lib/*.mjs`
- Agent definitions: `{plugin_root}/agents/code-reviewer.md` and
  `{plugin_root}/agents/phase6-implementer.md`
- Legacy Unix parity oracles: `{plugin_root}/hooks/scripts/test/test-*.sh`

Review output under `.deep-review/` is runtime state, not product source. Do not
commit it unless it is explicitly requested as an artifact.

## Path anchoring

Every plugin path an instruction tells an agent to open or run is written against
`{plugin_root}`, and must resolve *inside* that root. `{plugin_root}/commands/deep-review.md`
resolves the absolute root first — generic `PLUGIN_ROOT`, then the Claude
compatibility alias, then the installed command location supplied by the host — and
substitutes it.

`{plugin_root}` is this repo's single anchor spelling, and it is a **documentation
placeholder an agent substitutes**, not a shell variable. Do not spell it as one:
`${PLUGIN_ROOT}` would stay literal wherever no such variable is exported, and a
literal resolves against the analysed workspace — which is the substitution the
anchor exists to prevent. An anchor alone is not enough either: resolve first, then
check the result is under the root, because an anchored path followed by a parent
segment or through a symlink still leaves the plugin.

`{plugin_root}/tests/skill-reference-integrity.test.js` enforces all of this.

## Release invariants

- Node 22 on macOS, Linux, and native Windows 11 — no Git Bash.
- Supported review/respond/loop paths use Node or direct host tools, never shell-only
  helpers. Keep runtime references shell-free and capability-routed.
- Public routing stays capability-based; host markers are diagnostic only.
- Both manifests and `package.json` always carry one version.
- `{plugin_root}/.codex-plugin/plugin.json` uses default hook discovery and has no `hooks` or
  `mcpServers` key. Never add them.
- Preserve fail-closed reviewer counting (`N_actual=0`), read-only fingerprints,
  persisted mutation ownership, and the Phase 6 snapshot/verify/commit gates.
- `hooks/scripts/test/test-*.sh` are Unix parity oracles only, never a supported path.
- Keep README and CHANGELOG pairs structurally bilingual and evergreen.
- The shipped tree is the tagged release commit produced by
  `{plugin_root}/.github/workflows/release.yml`; `main` never carries
  `hooks/scripts/lib/native/{linux-x64,win32-x64,SHA256SUMS}`. The deep-suite
  pin is the tag commit, not `main`.

## Verification

```bash
npm test
npm run test:legacy
node --test {plugin_root}/tests/plugin-contract.test.js \
  {plugin_root}/tests/skill-runtime-contract.test.js \
  {plugin_root}/tests/native-release-smoke.test.js
git diff --check
```

A maintainer may also have the Codex plugin validator installed locally. It is a
maintainer-local preflight, not part of the contract: run it from wherever it lives on
that machine, and skip it when absent. Generic CI uses the pinned Node contract tests
above instead. An absolute path to one maintainer's home directory does not belong in
a shipped instruction file — it resolves to nothing on every other machine, and to
whatever happens to sit there on a machine under analysis.
