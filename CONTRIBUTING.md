# Contributing to deep-review

Thanks for your interest in improving **deep-review** — the independent Evaluator
plugin of the [deep-suite](https://github.com/Sungmin-Cho/deep-suite),
providing cross-model code review for AI coding agents on Claude Code and Codex.

## Getting started

```bash
git clone https://github.com/Sungmin-Cho/deep-review.git
cd deep-review
npm install
```

Node 20+ is required (the test suite uses the built-in `node:test` runner).

## Running tests

```bash
npm test
```

This runs the envelope unit tests (`tests/envelope-emit.test.js`,
`tests/envelope-chain.test.js`) plus the Claude-reviewer bridge test
(`hooks/scripts/test/test-codex-claude-reviewer.sh`). Shell scripts target both
GNU bash 5 (Linux) and bash 3.2 (macOS); CI runs the suite on `ubuntu-latest`
and `macos-latest`.

## Conventions

- **Documentation** follows [`docs/DOCS_RULE.md`](docs/DOCS_RULE.md) (local maintainer
  guide). README is evergreen and bilingual (EN + KO); the CHANGELOG is the single
  source of truth for version history.
- **Version triple-sync**: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  and `package.json` must always carry the same version.
- **CHANGELOG**: [Keep a Changelog](https://keepachangelog.com/) format; one concise,
  user-observable bullet per change.

## Pull requests

1. Branch from `main`.
2. Keep changes focused and add the user-facing change to the CHANGELOG.
3. Run `npm test` and make sure it is green.
4. Explain what changed and why.

## Reporting issues

Open a GitHub issue. For security reports, see [`SECURITY.md`](SECURITY.md).

## Releasing

- Create the GitHub release environment named `release` with a required reviewer.
- Dispatch `release.yml` (`workflow_dispatch`); the first run bootstraps CLI digest pins.
- Run the Linux x64 real-turn gate on the candidate tree before approving the environment.
- After approval, `publish` tags the release commit and creates the GitHub Release.
- Pin deep-suite with `release-bump.js` to the tag commit, not `main`.
- Run the post-pin smoke on a marketplace install of each enabled platform.
- Close #66 and #65 by hand after the smoke succeeds.
- Never delete a published tag. Roll back by re-pinning deep-suite to v2.9.0 and cutting a patch release (`v2.10.1`).
- Reopen the issues if a gate fails after merge.
