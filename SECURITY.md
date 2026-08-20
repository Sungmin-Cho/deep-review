# Security Policy

## Supported versions

Security fixes are delivered through the latest release of deep-review. The version
is tracked in `.claude-plugin/plugin.json` (and mirrored in `.codex-plugin/plugin.json`
and `package.json`); the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite)
marketplace pins the published commit.

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/Sungmin-Cho/claude-deep-review/security/advisories/new)
rather than opening a public issue.

We aim to acknowledge reports within a few days and will coordinate a fix and a
disclosure timeline with you.

## Scope

deep-review runs inside the Claude Code / Codex plugin runtime and, by design,
sends your code to reviewers.

### 2.15 Bounded hybrid fingerprint surface

Reviewer mutation detection uses a bounded hybrid fingerprint: the resolved commit at
`@HEAD`, Git-reported changed and untracked paths under `@STATUS/`, and selected
sensitive/runtime files under `@SENSITIVE/`. It does not recursively cover `.git`,
ignored paths outside that selection, or a distinct installed plugin root. Drift inside
the observed surface excludes the reviewer result, but this detector is not a total
backstop for every possible mutation.

### 2.16 External repository-content egress

- **External reviewers receive repository content.** Codex routes and explicitly enabled
  `agy` or Grok routes receive the bounded review payload. Sending repository content to
  a third-party reviewer is a **trust boundary** — enable a route only where project
  policy permits that content to leave the local machine.
- **Grok/xAI egress is opt-in.** Detection alone never dispatches Grok. An ordinary
  no-flag review, with no explicit Grok-targeting override or policy opt-in, sends
  nothing to Grok/xAI. Before any Grok dispatch, deep-review requires the external
  privacy preflight. Observed write prevention is attributed **only** to
  `--permission-mode plan`. The required `--sandbox read-only` flag was observed in
  Grok CLI v1.0.3 **not** to prevent a workspace write and is **not** a write barrier.
  Post-dispatch mutation detection is limited to the
  [bounded hybrid fingerprint surface in §2.15](#215-bounded-hybrid-fingerprint-surface).
- **Codex auto-exposure of gitignored files.** In a git repo with Codex installed,
  deep-review can temporarily expose gitignored files you have been editing so they can
  be reviewed. It always prompts before doing so, previews the exact `git` commands,
  scans for sensitive patterns (`.env*`, credentials, SSH/GCP keys, `.pgpass`, `.netrc`,
  `wrangler.toml`, JWT, …), and auto-skips an all-sensitive set without prompting.
- **Hooks execute shell commands.** Review bridges and the mutation/lock protocol run
  shell (`git`, fingerprinting, the reviewer CLIs). Review `hooks/` and the recommended
  denylist in the suite's
  [`guides/hook-patterns.md`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/guides/hook-patterns.md)
  before enabling them.

When reporting, please indicate which runtime (Claude Code / Codex) and which reviewer
path are affected.
