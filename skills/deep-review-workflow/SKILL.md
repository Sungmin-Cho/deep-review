---
name: deep-review-workflow
description: Internal cross-runtime review pipeline used by the public deep-review skill.
user-invocable: false
---

# Deep Review Workflow

This internal skill is loaded only by the public review branch. Public users
invoke `$deep-review:deep-review` or its `/deep-review` Claude adapter.

## Reference map

- `{plugin_root}/skills/deep-review-workflow/references/runtime-dispatch.md` — capability-based entry and reviewer matrix
- `{plugin_root}/skills/deep-review-workflow/references/review-execution.md` — executable review pipeline
- `{plugin_root}/skills/deep-review-workflow/references/review-criteria.md` — six review lenses and severity doctrine
- `{plugin_root}/skills/deep-review-workflow/references/codex-integration.md` — Codex roles and synthesis
- `{plugin_root}/skills/deep-review-workflow/references/agy-integration.md` — privacy-gated agy role
- `{plugin_root}/skills/deep-review-workflow/references/grok-integration.md` — candidacy-gated, privacy-gated, contained Grok role
- `{plugin_root}/skills/deep-review-workflow/references/ultracode-integration.md` — optional six-lens Claude fan-out
- `{plugin_root}/skills/deep-review-workflow/references/recurring-findings-export.md` — Stage 5.5 export
- `{plugin_root}/skills/deep-review-workflow/references/init-setup.md` — public init terminal branch
- `{plugin_root}/skills/deep-review-workflow/references/contract-schema.md` and `{plugin_root}/skills/deep-review-workflow/references/report-format.md` — data contracts

The reviewed runtime-reference file map is the list above. Every executable
review or loop path uses `.mjs`/`.js` helpers or direct host tools.

## Runtime root contract

Resolve `plugin_root` in this order: generic `PLUGIN_ROOT`, compatibility
`CLAUDE_PLUGIN_ROOT`, then the current runtime module location. The generic
override never identifies the host.

Then resolve reviewer flags before collecting the environment: detection is
candidacy-gated, so the flags decide which invocation runs. On the Grok-candidate
branch the control plane is
`node {plugin_root}/hooks/scripts/grok-carrier-coordinator.mjs --cwd {project_root} --mode review`,
which owns the complete environment handoff and is the only invocation that
carries `--grok-candidate`. Otherwise use
`node {plugin_root}/hooks/scripts/detect-environment.mjs --cwd {project_root} --format json`,
which creates no Grok state. Either way, use the absolute `plugin_root` value it
returns for every later plugin path.

## Pipeline map

1. Resolve reviewer flags, then collect environment and target data — through
   `grok-carrier-coordinator.mjs` (the sole `--grok-candidate` producer
   invocation) on the Grok-candidate branch and `detect-environment.mjs`
   otherwise — together with `build-change-files.mjs`, direct Git host commands,
   and direct file reads.
2. Load active Sprint Contracts when requested or present.
3. Build one route-specific reviewer payload per selected canonical reviewer
   with `build-reviewer-payload.mjs`.
4. Enumerate independent roles from `runtime-dispatch.md`, dispatch all
   eligible roles, and enforce read-only fingerprints.
5. Synthesize only trusted successful results into `report-format.md`.
6. Export recurring evidence through `wrap-recurring-findings-envelope.js`.

The detailed stages and failure behavior live only in `review-execution.md`.

## Configuration

`review_model` is a non-empty installed Claude model alias; `fable` is a valid
example. Treat the value as opaque and forward it unchanged to the named
Claude agent or `run-claude-reviewer.mjs`. Unknown or unavailable aliases fail
that role visibly and never fall back to a different model identity.

The remaining top-level keys retain their existing meaning:

```yaml
review_model: fable
codex_notified: false
agy_notified: false
agy_enabled: true
agy_sensitive_acked_fingerprint: ""
agy_sensitive_acked_at: ""
agy_fingerprint_mode: hybrid
grok_notified: false
grok_sensitive_acked_fingerprint: ""
grok_sensitive_acked_at: ""
grok_fingerprint_mode: hybrid
last_review: null
app_qa:
  last_command: null
  last_url: null
```

There is deliberately no `grok_enabled` key. Grok candidacy and disabling are
owned by the parsed public flags and overrides; `agy_enabled` above is a warning
rather than a precedent, because it has no code consumer and never had one.

Patch only the intended top-level key through the Node config writer or a
precise host edit. Preserve unknown user keys.
