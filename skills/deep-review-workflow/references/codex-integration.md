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
  task_name: `codex-review-${codexReviewLaunch.invocation_id}`,
  fork_turns: "none",
  message: codexReviewLaunch.payload
}
if (codexReviewRoute.resolved.model !== null) codexReviewOptions.model = codexReviewRoute.resolved.model
if (codexReviewRoute.resolved.effort !== null) codexReviewOptions.reasoning_effort = codexReviewRoute.resolved.effort
spawn_agent(codexReviewOptions)

const codexAdversarialOptions = {
  task_name: `codex-adversarial-${codexAdversarialLaunch.invocation_id}`,
  fork_turns: "none",
  message: codexAdversarialLaunch.payload
}
if (codexAdversarialRoute.resolved.model !== null) codexAdversarialOptions.model = codexAdversarialRoute.resolved.model
if (codexAdversarialRoute.resolved.effort !== null) codexAdversarialOptions.reasoning_effort = codexAdversarialRoute.resolved.effort
spawn_agent(codexAdversarialOptions)
```

Obtain each launch from `{plugin_root}/hooks/scripts/review-evidence.mjs`
`build-launch`, using the prepared route and exact evidence inputs. Pass its
payload bytes verbatim as shown above; the payload includes the role-definition
read and canonical report instructions. Capture actual native handle and mark
`payload_provenance: native-argument`. The local invocation ID is not an
attestation of provider-internal session identity. Capture the prepared target
before and after every leaf in addition to the fingerprints.

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

Prepared implementation review uses the evidence adjudication workflow in
`{plugin_root}/skills/deep-review-workflow/references/review-execution.md`.
`review-evidence.mjs source-findings` extracts admitted canonical source refs;
cover every Critical/Warning observation exactly once in adjudication-v1.
Corroboration is evidence to investigate, not a vote that establishes truth.
The Node finalizer publishes the canonical report and decision companion.
Unresolved items stay material, and only the verified confirmed set is eligible
for implementation Respond. A Node-designated confirmation reviewer also receives the
exact previous pending IDs; positive closure and current findings are checked
by the runtime without changing the leaf parser's outer grammar.

Document Artifact Gate remains the final document authority. Legacy unprepared
consensus callers preserve their existing role agreement/dissent arrays and
frozen report admission. Those arrays are descriptive provenance on new
implementation routes and never override adjudicated disposition.

`N_actual` counts trusted successful canonical roles. Required-role and
critical-implementation provider floors remain runtime-enforced. Ultracode's
collapsed output remains one Anthropic role. Failed/time-out and retry attempts
remain visible in dispatched-call accounting while contributing no admitted role.
