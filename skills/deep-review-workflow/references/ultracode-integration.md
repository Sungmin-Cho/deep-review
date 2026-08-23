# Ultracode integration

`--ultracode` upgrades the Claude family role to six focused lenses. It does
not create six independent vendor votes.

## Preconditions and payload

Resolve flags first. `--ultracode` with `--no-opus` is a terminal conflict.
Build one shared payload with `build-reviewer-payload.mjs`; every lens receives
the identical doctrine, change manifest, project context, and target diff.
Forward the configured non-empty Claude model alias unchanged, including a
custom alias such as `fable`.

When named-agent capability exists, create six fresh `Agent(code-reviewer)`
contexts focused on correctness, architecture, entropy, tests, readability,
and security. Every context remains read-only and returns the report contract.
Capture pre/post fingerprints around each context and exclude mutated output.

When six named contexts are unavailable, degrade visibly to one independent
Claude bridge through `run-claude-reviewer.mjs`; do not emulate fan-out with a
different model family and do not claim ultracode verification.

## Quorum and one-voice collapse

Let `K` be trusted successful lenses:

- `K == 0`: Claude family status is `failed`.
- `1 <= K < 4`: status is `partial`; collapse the available evidence but mark
  it unverified.
- `K >= 4`: status is `success`; collapse the six-lens evidence.

Normalize issues by severity, path, seven-line bucket, and substance, then
merge materially identical items. The collapsed result contributes exactly one
`claude-opus` voice to `N_actual`. Keep lens-level provenance in the report.

## Loop cadence

`deep-review-loop` forwards `--ultracode` only in round 1. For every
ultracode-consumed round 2+, derive the Review argv with the token-aware
normalizer below. It removes `--ultracode`, every `--grok` and existing
`--no-grok` token, and only complete Grok-keyed pairs for `--model`, `--effort`,
`--reviewer-model`, and `--reviewer-effort`. It never uses substring replacement
or consumes a neighbouring non-Grok value.

<!-- ultracode-round-2-normalizer:start -->
```javascript
(argv, { codexUnavailable = false } = {}) => {
  const grokAssignments = new Set([
    '--model', '--effort', '--reviewer-model', '--reviewer-effort',
  ]);
  const normalized = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--ultracode' || token === '--grok' || token === '--no-grok') continue;
    const value = argv[index + 1];
    if (grokAssignments.has(token) && typeof value === 'string' && /^grok=.+$/u.test(value)) {
      index += 1;
      continue;
    }
    normalized.push(token);
  }
  if (!codexUnavailable) normalized.push('--no-opus');
  normalized.push('--no-agy', '--no-grok');
  return normalized;
}
```
<!-- ultracode-round-2-normalizer:end -->

A malformed pair stays in argv so `parsePublicRoute` returns the public-route
error instead of accepting laundered input. Otherwise pass the derived argv
through `parsePublicRoute` and continue only with `ok: true`. This retains Codex
and appends exactly one `--no-grok` after the cadence disables. If Codex was
unavailable, set `codexUnavailable=true`: only the injected `--no-opus` is
withheld; Grok selectors are still stripped and `--no-grok` is still appended.
A loop that never requested ultracode keeps its original reviewer flags on
every round.
