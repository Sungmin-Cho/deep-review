# Codex integration

`{plugin_root}/skills/deep-review-workflow/references/runtime-dispatch.md` owns role selection. This file owns Codex execution and
cross-model synthesis after the public route has resolved `plugin_root`.

## Roles

- `codex-review` is the standard OpenAI voice.
- `codex-adversarial` is the adversarial OpenAI voice.
- `--no-codex` disables both roles.
- On Claude Code, each role runs through a separate generic Codex exec bridge
  invocation.
- On Codex, each role runs in its own fresh native generic subagent. The two
  roles have different subagent IDs and each counts at most once in `N_actual`.

## Native generic dispatch

For each selected Codex route, capture a pre-fingerprint with the shared
`lib/fingerprint.mjs` API, then invoke a route-specific leaf. Native
`spawn_agent` has no enforceable tool allowlist, so the read-only instruction
does not guarantee that writes cannot happen:

```text
const codexReviewOptions = {
  task_name: `codex-review-round-${roundNumber}-${invocationNonce}`,
  fork_turns: "none",
  message: "Read {plugin_root}/agents/code-reviewer.md, then the codex-review route-specific payload; stay read-only and return {plugin_root}/skills/deep-review-workflow/references/report-format.md"
}
if (codexReviewRoute.resolved.model !== null) codexReviewOptions.model = codexReviewRoute.resolved.model
if (codexReviewRoute.resolved.effort !== null) codexReviewOptions.reasoning_effort = codexReviewRoute.resolved.effort
spawn_agent(codexReviewOptions)

const codexAdversarialOptions = {
  task_name: `codex-adversarial-round-${roundNumber}-${invocationNonce}`,
  fork_turns: "none",
  message: "Read {plugin_root}/agents/code-reviewer.md, then the codex-adversarial route-specific payload; stay read-only and return {plugin_root}/skills/deep-review-workflow/references/report-format.md"
}
if (codexAdversarialRoute.resolved.model !== null) codexAdversarialOptions.model = codexAdversarialRoute.resolved.model
if (codexAdversarialRoute.resolved.effort !== null) codexAdversarialOptions.reasoning_effort = codexAdversarialRoute.resolved.effort
spawn_agent(codexAdversarialOptions)
```

`fork_turns: "none"` is mandatory: neither leaf receives generator history.
Every attempt, role, and round uses an invocation-unique `task_name`. The
canonical reviewer IDs remain `codex-review` and `codex-adversarial` in routing
and report provenance; task identity never replaces reviewer identity. Never
use `followup_task` or reuse a prior subagent or its history. A retry creates a
fresh subagent with another unique task name and `fork_turns: "none"`.

After a leaf returns, capture the post-fingerprint with the same fingerprint
API and identical options. A mutation invalidates the result and makes it
untrusted. Stop the round before launching the sibling reviewer and before any
response or commit action; record the invalid attempt and do not synthesize it.

When an explicit model or effort is rejected as unsupported, and only when
`--allow-fallback` authorized fallback, retry that leaf once with only the
rejected dimension omitted. If both explicit dimensions are clearly rejected,
omit both in the single retry. Do not retry authentication, authorization,
timeout, empty-output, or generic failures. The retry is a new history-free
subagent invocation, not a continuation.

## Claude Code bridge

Claude Code routes both roles through the generic Codex exec adapter with
separate payloads and the same routing plan:

```text
node {plugin_root}/hooks/scripts/run-codex-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PROMPT_FILE --execution-route-json EXECUTION_ROUTE_JSON --reviewer-id codex-review --output OUTPUT_FILE --timeout-seconds 900
node {plugin_root}/hooks/scripts/run-codex-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PROMPT_FILE --execution-route-json EXECUTION_ROUTE_JSON --reviewer-id codex-adversarial --output OUTPUT_FILE --timeout-seconds 900
```

The bridge applies the same model/effort, fallback, report-sidecar, and
read-only fingerprint contract as the native leaves.

## Synthesis

Normalize issues to severity, path, seven-line bucket, and substance. Merge
only materially identical issues. Preserve each role's agreement and dissent:

- with two trusted voices: unanimous or split;
- with three: unanimous, majority, or solo;
- with four: unanimous, majority three of four, split two of four, or solo;
- with five: unanimous, majority four of five, majority three of five,
  split two of five, or solo.

Dissent is carried by the `dissenters` array defined in
`{plugin_root}/skills/deep-review-workflow/references/report-format.md` — one entry per
dissenting reviewer, each with its own `family`. Past four voices the array is
routinely longer than one: `majority_3_of_5` has two entries, so a dissent
spanning two vendor families stays distinguishable from two dissenters inside
one. The singular dissent keys are retired and are never used as a
first-dissenter shorthand.

`N_actual` is the number of trusted successful roles, not the number requested.
Apply the N=0/N=1 rules in `{plugin_root}/skills/deep-review-workflow/references/review-execution.md` before ordinary consensus.
Ultracode's collapsed output remains one Anthropic voice. A failed or untrusted
role is named in Summary and contributes no vote.
