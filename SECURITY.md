# Security Policy

## Supported versions

Security fixes are delivered through the latest release of deep-review. The version
is tracked in `.claude-plugin/plugin.json` (and mirrored in `.codex-plugin/plugin.json`
and `package.json`); the [deep-suite](https://github.com/Sungmin-Cho/deep-suite)
marketplace pins the published commit.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/Sungmin-Cho/deep-review/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge reports within a few days and will coordinate a fix and a
disclosure timeline with you.

## Scope

deep-review runs inside the Claude Code / Codex plugin runtime and, by design,
sends your code to reviewers:

- **External reviewers receive your diff.** When the Codex plugin (and optionally the
  `agy` CLI) is installed, deep-review escalates to cross-model review and passes your
  changed code to those external tools. Sending code to a third-party reviewer is a
  **trust boundary** — only enable cross-model review where your project's policy
  allows the diff to leave the local machine. Opus-only review (the default when no
  external reviewer is detected) keeps the diff within the Claude Code session.
- **Codex auto-exposure of gitignored files.** In a git repo with Codex installed,
  deep-review can temporarily expose gitignored files you have been editing so they can
  be reviewed. It always prompts before doing so, previews the exact `git` commands,
  scans for sensitive patterns (`.env*`, credentials, SSH/GCP keys, `.pgpass`, `.netrc`,
  `wrangler.toml`, JWT, …), and auto-skips an all-sensitive set without prompting.
- **Hooks execute shell commands.** Review bridges and the mutation/lock protocol run
  shell (`git`, fingerprinting, the reviewer CLIs). Review `hooks/` and the recommended
  denylist in the suite's
  [`guides/hook-patterns.md`](https://github.com/Sungmin-Cho/deep-suite/blob/main/guides/hook-patterns.md)
  before enabling them.

When reporting, please indicate which runtime (Claude Code / Codex) and which reviewer
path are affected.
