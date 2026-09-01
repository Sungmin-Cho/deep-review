---
name: deep-review
description: Public cross-runtime entrypoint for independent review, initialization, and evidence-based review response.
user-invocable: true
argument-hint: "[init] [--contract [SLICE-NNN]] [--entropy] [--ultracode] [--codex|--no-codex] [--no-opus] [--agy|--no-agy] [--grok|--no-grok] [--codex-only] [--reviewer-strategy adaptive|static] [--readiness-receipt PATH] [--dry-run] [--explain-routing] [--routing auto|fast|balanced|quality] [--model PROVIDER=MODEL] [--effort PROVIDER=EFFORT] [--reviewer-model REVIEWER=MODEL] [--reviewer-effort REVIEWER=EFFORT] [--allow-fallback|--no-fallback] [--allow-classifier] [--respond (REPORT_PATH | --source=pr [--pr=NNN])]"
---

# deep-review — public route

Use this skill through `$deep-review:deep-review` on Codex or through the
`/deep-review` Claude adapter. Both entrypoints pass the same argument tokens
to this file; this file is the single owner of argument validation and routing.

## Runtime root

Resolve `plugin_root` once with the shared runtime contract: `PLUGIN_ROOT`, then
the Claude compatibility alias, then the installed skill location. Every file
below is read by joining its relative path to that absolute `plugin_root`.
Never infer reviewer availability from the selected root or from a host label.

## Argument validation

Serialize the original argument tokens as a private JSON array and invoke:

```text
node {plugin_root}/hooks/scripts/public-route.mjs --entry review --host HOST --cwd PROJECT_ROOT --args-file ARGS_FILE
```

The returned JSON is the executable route authority. Stop on `ok=false`; use
its expanded `argv` and terminal `route` without independently reparsing them.
The runtime enforces this grammar:

1. Expand `--codex-only` to `--codex --no-opus --no-agy --no-grok` before validation.
2. Reject `--ultracode` with `--no-opus`, reject `--codex` with `--no-codex`,
   and reject `--grok` with `--no-grok` (and therefore with `--codex-only`).
3. `--contract` consumes the next token only when it matches `SLICE-[0-9]+`.
   `--respond` consumes a following report path only when it names an existing
   file; `--source=pr` and `--pr=NNN` stay respond options.
4. Reviewer flags combined with `--respond` are ignored with one visible note.
5. Any unknown flag or extra positional token is a terminal validation error.

## Terminal routes

- `init` — terminal. Read
  `{plugin_root}/skills/deep-review-workflow/references/init-setup.md`, execute
  it, report completion, and 종료. Do not load the review pipeline.
- `--respond` — terminal. Read
  `{plugin_root}/skills/receiving-review/references/respond-execution.md`,
  execute the response protocol using returned `reportPath` when non-null or
  the validated PR-source options in returned `argv` otherwise, and 종료.
  That reference uses `respond-runtime.mjs` for report/PR/report-file I/O and
  `phase6-protocol.mjs` for snapshot/test/verify/recover/commit on both hosts.
  Claude named-agent fallback and Codex generic-subagent dispatch consume one
  shared Accepted Items prompt; neither route uses a hook or MCP server.
- `--qa` — terminal. Explain that App QA is reserved for a later release and
  종료 without creating state.
- `review` — terminal for `--contract`, `--entropy`, reviewer flags, or no
  arguments.
  - Artifact-aware classification and routing (Phase 2): when the returned route sets
    `dryRun` or `explainRouting`, no reviewer runs on this branch. When Grok is a
    candidate, the Grok control-plane entrypoint for this branch is the shipped
    coordinator, started first and kept alive for the whole branch:

    ```text
    node {plugin_root}/hooks/scripts/grok-carrier-coordinator.mjs --cwd PROJECT_ROOT --mode dry-run
    ```

    Its first stdout line is the environment JSON and its second is the
    coordinator descriptor carrying `control_path`. If that first line is JSON
    whose `ok` field is present and `ok === false`, show `reason` and `remedy`
    and stop the branch (fail-closed, not a degraded listing). Then run
    `node {plugin_root}/hooks/scripts/classify-artifacts.mjs --repo PROJECT_ROOT`
    (append `--grok-coordinator-control CONTROL_PATH` on the candidate branch,
    and `--explain-routing` when the route set `explainRouting`), print its
    listing. Classification consumes the same `GROK_COMPATIBILITY_CARRIER` the
    coordinator already drained: it acquires a fresh readable endpoint, and must
    not detect the environment for itself or run a compatibility probe. An
    unconfirmed or terminated coordinator is terminal here — fail closed.
    When returned JSON has `route.overrides`, append
    `--overrides-json` and `JSON.stringify(route.overrides)` as a single argv
    value so model IDs and paths are never reparsed by a shell. Then 종료
    without running a reviewer. That helper classifies the change scope, renders
    the capability-aware routing plan, and writes provenance under
    `.deep-review/tmp/`. Semantic classification remains deferred unless
    `route.overrides.allow_classifier` is true.
  - Otherwise read the internal workflow skill and then
    `{plugin_root}/skills/deep-review-workflow/references/review-execution.md`;
    execute its routing preflight immediately before reviewer dispatch, then run
    it once and 종료 with the resulting report path and verdict or document
    readiness gate. Policy and explicit-constraint failures are terminal;
    `routing_shadow_mode: true` records a non-applied observation plan.

The internal workflow and receiving skills are implementation details and are
not public marketplace prompts.

## Artifact-aware routing Phase 2

Routing overrides are review-only. `--routing` selects `auto`, `fast`,
`balanced`, or `quality`; repeated `--model PROVIDER=MODEL` and
`--effort PROVIDER=EFFORT` set provider defaults; repeated
`--reviewer-model REVIEWER=MODEL` and `--reviewer-effort REVIEWER=EFFORT` set
canonical reviewer overrides. `--allow-fallback` permits a visible downgrade
when an explicit request cannot be applied. `--no-fallback` explicitly
overrides a permissive project/user policy and conflicts with
`--allow-fallback`. Model values are opaque and split only at the first `=`.

Adaptive reviewer routing and automatic model routing are enabled by default.
`--reviewer-strategy adaptive` selects only the role-fit reviewer floor and may
expand once within the same round. `--reviewer-strategy static` fixes the
eligible reviewer set for compatibility. `routing_shadow_mode: true` computes
and records the adaptive plan but does not apply it. Use static strategy and
shadow mode together when exact pre-2.0 dispatch behavior is required.

The `--no-*`, `--codex`, `--codex-only`, `--agy`, `--grok`, and `--ultracode`
flags are hard eligibility or required-assignment constraints. A reviewer-level model or
effort override requires that canonical reviewer to be selected; a provider
override applies only to selected reviewers from that provider and never adds a
reviewer.

`agy` is the one exception to that last clause, because it is not a default
candidate: it is opt-in. `--agy` both permits agy candidacy and requires its
selection, exactly like `--codex` does for Codex. An agy-targeting model or
effort override (`--model agy=…`, `--effort agy=…`, `--reviewer-model agy=…`,
`--reviewer-effort agy=…`) restores agy candidacy so the override is not a
terminal error, while leaving its required-ness exactly as it is for every
other provider — a provider-level agy override still never forces selection.

`grok` is the same exception, on the same terms. `--grok` both permits Grok
candidacy and requires its selection; a Grok-targeting `--model grok=…`,
`--effort grok=…`, `--reviewer-model grok=…`, or `--reviewer-effort grok=…`
restores candidacy without forcing selection. `--no-grok` alone is successful
silent negative selection; `--no-grok` combined with a Grok-targeting override
is `ERROR_CONFLICTING_REVIEWER_SELECTION`, not a quiet win for either side.
Candidacy is resolved here, before environment detection, because Grok probing
and Grok state are gated on it — a review with no Grok flag creates none.
There is no `grok_enabled` config key; `--no-grok` is the enforceable disable.

`--allow-classifier` opts `--dry-run` or `--explain-routing` into semantic
classification for ambiguous artifacts. Artifact content is untrusted data;
the classifier receives bounded text through stdin, and secret-like content
fails closed to deterministic classification without being sent externally.

`--readiness-receipt PATH` is implementation-review-only linkage to an earlier
document gate. The runtime verifies repository and path containment, rejects
symlinks, and rehashes every document and reviewer report before dispatch.
Stale or tampered input terminates with `ERROR_READINESS_RECEIPT_STALE`;
unverified deferred acceptance items prevent `APPROVE`.

A team may commit `.deep-review/review-policy.yaml`; because Git cannot
re-include a file below an ignored directory, replace a `.deep-review/` ignore
with both rules below:

```gitignore
.deep-review/*
!.deep-review/review-policy.yaml
```
