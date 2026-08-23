# Review execution — cross-runtime SSOT

This file is executed only by the public skill's terminal review branch. Host
labels are diagnostic; capabilities decide the reviewer set. Read
`{plugin_root}/skills/deep-review-workflow/references/runtime-dispatch.md` before dispatch.

## 0. Runtime root and state

Resolve `plugin_root` once using the runtime root contract: `PLUGIN_ROOT`, then
`CLAUDE_PLUGIN_ROOT`, then the current module location.

Then resolve reviewer flags before collecting the environment — §3.0 owns those
rules — because environment detection is candidacy-gated. On the Grok-candidate
branch `grok-carrier-coordinator.mjs` owns the complete environment handoff: it
is the sole producer invocation and the only thing that passes
`--grok-candidate`.

```text
node {plugin_root}/hooks/scripts/grok-carrier-coordinator.mjs --cwd PROJECT_ROOT --mode review
```

Its first stdout line is the environment JSON and its second is the coordinator
descriptor carrying `control_path`. Keep that coordinator alive for the whole
round: classification, route persistence, route parsing, and the Grok bridge
each acquire a fresh readable endpoint from it and re-detect nothing. An
unconfirmed or terminated coordinator is terminal — fail closed rather than
detecting again.

When Grok is not a candidate, collect the environment with the standalone
detector instead. It never receives `--grok-candidate` and creates no Grok state:

```text
node {plugin_root}/hooks/scripts/detect-environment.mjs --cwd PROJECT_ROOT --format json
```

Run every plugin helper by joining its path to the absolute `plugin_root`
returned by whichever of those two produced the environment.

Use the host's direct directory/file tools to ensure `.deep-review/reports`,
`.deep-review/responses`, and `.deep-review/tmp` exist. No hook or MCP server is
part of this workflow.

If `.deep-review/config.yaml` is absent, create it with the defaults in
`{plugin_root}/skills/deep-review-workflow/references/init-setup.md` through a direct host file tool. If it predates the agy fields,
use `{plugin_root}/hooks/scripts/lib/config.mjs` `patchTopLevelConfig` to add each missing scalar
independently: `agy_notified=false`, `agy_enabled=true`, empty acknowledgment
fingerprint/timestamp, and `agy_fingerprint_mode=hybrid`. If it predates the
Grok fields, add `grok_notified=false`, empty acknowledgment
fingerprint/timestamp, and `grok_fingerprint_mode=hybrid` the same way. There is
no `grok_enabled` key to migrate. Never reset an existing value and never
replace the whole file during migration.

Before every review, send an `auto-recover` framed JSON request directly to
`node {plugin_root}/hooks/scripts/mutation-protocol.mjs --request-stdin`.
Construct the frame with the module's exported request encoder and pass it as
process stdin. If recovery returns `manual`, `busy`, or an error, stop and show
the JSON result. Never start a reviewer over an unresolved mutation.

All mutation requests use the exported `buildCliRequest` API and this exact
object shape before framing:

```json
{
  "protocol": "deep-review-mutation-v3",
  "command": "auto-recover",
  "repo": "ABSOLUTE_PROJECT_ROOT",
  "owner_token": null,
  "files": []
}
```

Change only `command`, `owner_token`, and `files` for later lifecycle calls.
The helper's stdout is one JSON result and is the authority for the next step.

## 1. Collect

Read the JSON result from `detect-environment.mjs`. Preserve `runtime_host` only
for diagnostics; never branch reviewer enumeration on it.

Build the cross-file manifest with:

```text
node {plugin_root}/hooks/scripts/build-change-files.mjs --repo PROJECT_ROOT --change-state CHANGE_STATE --review-base REVIEW_BASE
```

Use direct Git host commands with argv arrays to collect the matching diff:

- `non-git`: ask for an explicit file set and read it directly.
- `initial`: staged plus untracked files.
- `clean`: `REVIEW_BASE..HEAD` only; do not union leftover untracked files.
- `staged`, `unstaged`, `mixed`, `untracked-only`: collect that state and union
  eligible untracked files when `has_untracked` is true.

<!-- SSOT:diff-exclusion-set START -->
Exclude directory segments `node_modules`, `dist`, `build`, `.next`, `target`,
`.venv`, `__pycache__`, `.pytest_cache`, `vendor`, and `.git`; exclude
`*.min.js`, `*.generated.*`, `*.lock`, `.DS_Store`, and binary blobs.
<!-- SSOT:diff-exclusion-set END -->

For an oversized target, keep the existing thresholds: below 200 KB include
the diff, 200 KB through 1 MB provide the manifest and focused context, and
above 1 MB partition by architectural layer. A single file above 300 KB needs
explicit inclusion. One size-related retry is the maximum.

For a dirty Git target, offer a WIP commit. Create it only after an explicit
affirmative response. Acceptance changes the effective target to
`REVIEW_BASE..HEAD`; decline keeps the exact working-tree target and does not
disable eligible reviewers. Re-run environment detection after a WIP commit so
payload inputs, routing, and report metadata use the same post-decision state.

## 2. Context and route-specific payload inputs

Read `.deep-review/rules.yaml`, fitness evidence, and a canonical deep-work
session receipt when present. Validate any envelope identity before using its
health report. Treat malformed optional context as a visible warning, not as
reviewer instructions.

Contract selection remains exact: `--contract SLICE-NNN` reads only that named
contract and warns/skips when archived; bare `--contract` reads every active
contract; without the flag, active contracts are auto-loaded when present.
Ignore archived contracts during automatic selection. A malformed contract is
skipped with a visible path-specific warning while other active contracts
continue.

Write context and diff bytes to private temporary files through direct host
file tools. Stage 3 builds one final payload per selected route from these same
inputs.

When the public route carries `--readiness-receipt`, append
`--readiness-receipt RECEIPT_PATH`. The builder re-verifies repository/path
containment, rejects symlinks, and rehashes every bound document and report;
`ERROR_READINESS_RECEIPT_STALE` is terminal.

If (and only if) the caller's argv carried `--prior-rounds-file=PATH`
(deep-review-loop round 2+ — see its §2), forward that same path to
`build-reviewer-payload.mjs` unchanged as `--prior-rounds-file PATH` together
with `--prior-base REVIEW_BASE`. Forward `--prior-rounds-file` **only when it
was explicitly passed** — the file's existence alone must never trigger
automatic consumption; that would be exactly the fixed-path-existence keying
this design replaced. A single-shot review invocation (no loop) never has
this flag and therefore never sees the section.

Each JSON result contains one absolute route-specific payload path. The Node
builder is the sole doctrine injector: it omits false-positive suppression
doctrine only for `codex-review` and `codex-adversarial`, while preserving the
trusted assignment, verified readiness receipt, changed files, project
context, prior rounds, and diff. All other reviewers retain the doctrine.
Preserve every builder warning in the final report.

## 3. Reviewer flags, privacy, and capability enumeration

### 3.0 resolve reviewer flags

Resolve reviewer flags before any privacy work:

Build the current adapter candidate set with `buildCapabilities` from
`{plugin_root}/hooks/scripts/lib/capability-registry.mjs`, combining detected
executables and fresh host assertions. Each protocol `2.0` capability declares
its supported assignment roles. Do not infer support from a host label,
duplicate the routing matrix in prose, or move model IDs through a shell
string.

1. Expand `--codex-only` to `--codex --no-opus --no-agy --no-grok`.
2. Reject `--ultracode` with `--no-opus`; reject `--codex` with `--no-codex`;
   reject `--agy` with `--no-agy` (and therefore with `--codex-only`); reject
   `--grok` with `--no-grok` (and therefore with `--codex-only`).
3. `--no-opus` disables `claude-opus`; `--no-codex` disables both
   `codex-review` and `codex-adversarial`; `--no-agy` disables `agy`;
   `--no-grok` disables `grok`.
4. Native Codex generic subagents supply both `codex-review` and
   `codex-adversarial` whenever the host capability exists. Claude Code uses
   the generic Codex exec bridge for both roles.
5. A named Claude agent or the Claude CLI bridge supplies `claude-opus`.
   Forward `review_model` unchanged; it is a non-empty installed Claude model
   alias such as `fable`.
6. `agy` is **opt-in and is never a default candidate**. `defaultReviewers()`
   in `classify-artifacts.mjs` admits it only when the emitted overrides carry
   `enabled_providers` containing `agy`; `public-route.mjs` sets that from
   `--agy` or from an agy-targeting model/effort override. `--agy` also sets
   `required_providers`, because candidacy alone never wins a planner slot at a
   small reviewer floor. This gate is code-owned — do not re-derive it here.
   The legacy config key `agy_enabled` has **no code consumer** and never had
   one; it is inert. The enforceable disable is `--no-agy`.
7. `grok` mirrors that gate exactly and is **opt-in and never a default
   candidate**. Candidacy comes from `--grok`, from a Grok-targeting
   `--model`/`--effort`/`--reviewer-model`/`--reviewer-effort` override, or from
   emitted overrides carrying `grok` in `enabled_providers`/`required_providers`.
   `--grok` also sets `required_providers`. This gate is code-owned — do not
   re-derive it here. There is deliberately **no `grok_enabled` config key**; the
   enforceable disable is `--no-grok`. Candidacy is what the §0 environment step
   branches on, so it must be resolved before that step runs.

`--no-agy`: skip the scan and preflight, create no state or config changes;
this disabled privacy branch is a no-op. `--no-grok`: skip the scan and
preflight, create no state or config changes; it creates no coordinator process
and no Grok state at all. `--codex-only`: after expansion, skip
the agy scan and preflight, create no state or config changes; it is also a
no-op privacy branch, and the same holds for its expanded `--no-grok`.

### 3.1 external-provider privacy preflight

Run these only after the emitted routing plan (§3.2) carries the matching
route; an eligible but unselected external provider performs no privacy work
and creates no state. Neither preflight has an opt-in check of its own, so this
ordering is a prose gate, not a code guarantee. Invoke before any selected
bridge can receive an `--add-dir` or project-access argument:

```text
node {plugin_root}/hooks/scripts/agy-privacy-preflight.mjs --repo PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --config CONFIG_FILE --approval auto
node {plugin_root}/hooks/scripts/grok-privacy-preflight.mjs --repo PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --config CONFIG_FILE --approval auto
```

- `auto_ack`: patch only the two acknowledgment config fields and continue.
- `acknowledged`: continue without changing unrelated config.
- `needs_approval`: show the sensitive hits and fingerprint, request explicit
  approval, and rerun with `--approval approve` or `--approval decline`.
- A positive approval may patch only those acknowledgment fields. Decline or
  any error excludes that provider; no reviewer process receives project access.

Each provider patches only its own acknowledgment fields: `agy_*` for agy and
`grok_*` for Grok. For Grok this gate runs only after §3.3 has established
`containment_ready`. Full rules live in
`{plugin_root}/skills/deep-review-workflow/references/grok-integration.md`.

### 3.2 artifact classification and routing preflight

Immediately before §3.1 and Stage 4, invoke the reviewer-free preflight
with argv-array transport:

```text
node {plugin_root}/hooks/scripts/classify-artifacts.mjs --repo PROJECT_ROOT --grok-coordinator-control COORDINATOR_CONTROL_PATH --emit-routing-plan --format json --routing-plan-out .deep-review/tmp/routing-plan.json --host-assertions-json '{"claudeNativeAgent":true,"codexExecReviewer":true,"codexNativeGeneric":false}'
node {plugin_root}/hooks/scripts/classify-artifacts.mjs --repo PROJECT_ROOT --grok-coordinator-control COORDINATOR_CONTROL_PATH --emit-routing-plan --format json --routing-plan-out .deep-review/tmp/routing-plan.json --host-assertions-json '{"claudeNativeAgent":false,"codexExecReviewer":false,"codexNativeGeneric":true}'
```

`COORDINATOR_CONTROL_PATH` is the `control_path` from the §0 coordinator
descriptor. Classification consumes a fresh readable endpoint from that live
coordinator and performs **no** compatibility re-probe of its own. Omit the flag
only on the non-candidate branch, where no coordinator exists; an unconfirmed or
terminated coordinator is terminal and fails closed rather than re-detecting.

Because this subprocess cannot observe the orchestrating host directly, always
append `--host-assertions-json` with compact JSON reflecting the current host
tool capability (named Claude agent availability → `claudeNativeAgent`,
external Codex reviewer eligibility → `codexExecReviewer`, native Codex generic
subagent availability → `codexNativeGeneric`) as one argv value. The first
example is the Claude Code profile and the second is the Codex profile.
Omitting a key or the whole flag leaves that adapter `unknown`.

When public-route returned normalized overrides, append `--overrides-json` and
the compact `JSON.stringify(route.overrides)` as one argv value. An explicit
override makes this preflight mandatory and any error stops dispatch. Adaptive
reviewer and automatic model routing are also default policy, so a preflight
failure that prevents a trustworthy selected set is terminal. Only an explicit
`routing_shadow_mode: true` observation plan may fail open on a non-policy
environment/probe error with a visible warning.

A preflight error caused by policy enforcement — a denied or unavailable
provider, a denied model, read-only unavailable, or an unparseable/type-invalid
EXISTING policy file (`ERROR_PROVIDER_DENIED`, `ERROR_MODEL_DENIED`,
`ERROR_READ_ONLY_UNAVAILABLE`, `ERROR_PROVIDER_UNAVAILABLE`, or
`ERROR_POLICY_INVALID`) is TERMINAL for the whole review regardless of whether
the plan is applied or shadow-only: stop dispatch entirely rather than
downgrading it to a warning and falling back to legacy dispatch. A missing
policy file is not an error and never triggers this path.

Adaptive reviewer routing and automatic model routing default to enabled, with
`routing_shadow_mode: false`. `--reviewer-strategy static` fixes the eligible
reviewer set; shadow mode records the adaptive plan without applying it. Hard
manual eligibility/required-assignment constraints are applied before
selection. Reviewer-level overrides require that reviewer; provider-level
overrides affect selected reviewers only.

Treat the emitted routing plan as the dispatch authority. It carries one
validated protocol `3.0` route per selected canonical reviewer, plus the full
candidate set, assignment role/rubric/wave/required fields, reviewer floors,
risk, phase, progress, requested/resolved/applied/fallback, and semantic
provenance. Protocol `2.0` plans remain readable. Stage 4 leaf adapters consume
only their own route, passed inline as `--execution-route-json` together with
its reviewer id; they do not read the plan file and do not reinterpret provider
or reviewer flags. Take each route verbatim from `routing_plan.routes` in the
preflight's JSON result. The emitted `.deep-review/tmp/routing-plan.json` is an
audit copy that no adapter reads.

After the plan exists, invoke `{plugin_root}/hooks/scripts/build-reviewer-payload.mjs` once per selected
route:

```text
node {plugin_root}/hooks/scripts/build-reviewer-payload.mjs --plugin-root PLUGIN_ROOT_ABS --repo PROJECT_ROOT --change-state CHANGE_STATE --review-base REVIEW_BASE --context-file CONTEXT_FILE --diff-file DIFF_FILE --execution-route-json EXECUTION_ROUTE_JSON --reviewer-id REVIEWER_ID
```

Append the same explicit prior-context and readiness inputs described in Stage
2. The builder validates the canonical reviewer ID through the routing plan and
injects only that route's trusted rubric. Never pass raw selection reasons or
another reviewer's route to the leaf.

### 3.3 Grok containment preflight

When the emitted plan carries a `grok` route, call `preflightGrokContainment`
from `{plugin_root}/hooks/scripts/grok-containment-preflight.mjs` here — after
§3.2 and before the §3.1 privacy gate, and before any Stage 4 dispatch. It
establishes `containment_ready` and issues one owner-bound
`containment_ready_token`; a refusal issues none and produces zero privacy,
config, fingerprint, session-id, prompt and provider-child work. Release the
owner on privacy decline, on error, and when no launch happened.
`containment_ready` is the pre-launch admission and `termination_confirmed` is
the post-exit proof; never substitute one for the other. An unsupported
containment platform fails the **entire review** through `operational_failure`
with reason `unsupported_grok_containment`, not a four-voice degradation.

## 4. Dispatch independent reviewers

Use a fresh isolated context for every selected route. Native Codex reviewer
dispatch is strictly serial and trust-gated: capture the pre-review fingerprint,
launch one leaf, capture the post-review fingerprint, make the trust decision,
and only then launch the next leaf. A mutation invalidates the result and makes
it untrusted. Stop the round before launching a sibling reviewer and before any
response or commit action.

A `grok` seat tightens that same gate: capture its post-review fingerprint only
after confirmed whole-tree termination. A missing or false `termination_confirmed`
is `invalid_grok_process_lifecycle` and is round-terminal with no retry, and the
next reviewer is not dispatched until that seat's complete termination has been
proven.

Use the exported `captureFingerprint` API from
`{plugin_root}/hooks/scripts/lib/fingerprint.mjs` for both snapshots, with the
same `{ repo: PROJECT_ROOT, pluginRoot: PLUGIN_ROOT_ABS, mode }` options. Read
`mode` from `agy_fingerprint_mode`, or from `grok_fingerprint_mode` for the
`grok` seat, and default to `hybrid`. Hybrid is a bounded detector, not a total
backstop; its observation surface is enumerated in
`{plugin_root}/skills/deep-review-workflow/references/grok-integration.md`. A
capture error is conservative drift. Persist only the digest/mode evidence
needed by the report; never expose file contents.

### 4.1 `claude-opus`

When named-agent capability exists, call `Agent(code-reviewer)` with its
route-specific payload. The assignment role does not add another voice. Before
native dispatch, only when the emitted plan is applicable —
`explicit_overrides: true` or `apply_automatic: true` — read the `claude-opus`
route from the emitted routing plan and pass its `resolved.model` as the Agent
model parameter. With a shadow-only plan or no emitted plan, preserve the
configured model alias unchanged. The native Agent interface has a model
parameter, but effort is unsupported. Therefore an explicit effort override on
a native-agent-only route is a strict error; never report an effort as
requested-but-unverified when it could not be transmitted. Otherwise, when
Claude CLI exists, invoke:

```text
node {plugin_root}/hooks/scripts/run-claude-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PAYLOAD_FILE --output OUTPUT_FILE --model REVIEW_MODEL --agent code-reviewer --timeout-seconds 1200
```

When the emitted plan is applicable — the v2.0 default — append
`--execution-route-json EXECUTION_ROUTE_JSON --reviewer-id claude-opus`.
With a shadow-only plan, preserve the command above byte-for-byte.

Do not replace a requested Claude role with a Codex identity. Record timeout,
authentication, empty-output, or unavailable-model status exactly as emitted.

### 4.2 `codex-review` and `codex-adversarial`

On native Codex, create two separate subagents with different subagent IDs.
Each leaf reads the absolute `{plugin_root}/agents/code-reviewer.md`, then only
its route-specific payload, stays strictly read-only, inspects the target
repository, and returns the `{plugin_root}/skills/deep-review-workflow/references/report-format.md` contract. Neither receives
generator history. Native `spawn_agent` has no enforceable tool allowlist; the
read-only instruction is paired with fingerprint-based trust rejection:

```text
const options = { task_name: `${canonicalReviewerId}-round-${roundNumber}-${invocationNonce}`, fork_turns: "none", message: ROUTE_SPECIFIC_PAYLOAD_INSTRUCTIONS }
if (route.resolved.model !== null) options.model = route.resolved.model
if (route.resolved.effort !== null) options.reasoning_effort = route.resolved.effort
spawn_agent(options)
```

Use an invocation-unique `task_name` on every role, round, and retry. Preserve
the canonical reviewer IDs `codex-review` and `codex-adversarial` in routing and
report provenance. Never use `followup_task` or reuse a prior subagent or its
history; retries also create a fresh `fork_turns: "none"` invocation.

Capture pre/post fingerprints for each leaf with the same
`lib/fingerprint.mjs` API and identical options. A mutation invalidates the
result and makes it untrusted; stop the round before launching the sibling
reviewer and before any response or commit action. Each canonical role counts
at most once.

If the host rejects an explicit model or effort as unsupported, retry that leaf
at most once and only when `--allow-fallback` authorized it. Omit only the
rejected dimension, or both when both are clearly rejected. Authentication,
authorization, timeout, empty-output, and generic failures never retry.

On Claude Code, invoke the generic Codex exec bridge once per role:

```text
node {plugin_root}/hooks/scripts/run-codex-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PROMPT_FILE --execution-route-json EXECUTION_ROUTE_JSON --reviewer-id codex-review --output OUTPUT_FILE --timeout-seconds 900
node {plugin_root}/hooks/scripts/run-codex-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PROMPT_FILE --execution-route-json EXECUTION_ROUTE_JSON --reviewer-id codex-adversarial --output OUTPUT_FILE --timeout-seconds 900
```

The bridge reads each route's resolved model/effort and applies the same
explicit runtime-rejection-only single-retry rule.

### 4.4 `agy`

After a successful current privacy outcome, invoke:

```text
node {plugin_root}/hooks/scripts/run-agy-reviewer.mjs --binary AGY_FILE --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PAYLOAD_FILE --output OUTPUT_FILE --mode hybrid --model AGY_MODEL --timeout-seconds 900
```

When the emitted plan is applicable — the v2.0 default — append
`--execution-route-json EXECUTION_ROUTE_JSON --reviewer-id agy`. With a
shadow-only plan, preserve the command above byte-for-byte.

The bridge revalidates privacy and fingerprint state. A `mutated` result is
untrusted even if the process produced report text.

### 4.5 `--ultracode`

Follow `{plugin_root}/skills/deep-review-workflow/references/ultracode-integration.md`.
Ultracode may launch its eligible lens contexts in fresh background contexts.
Six lenses collapse to one Anthropic voice; they never increase `N_actual`
above one for the Claude family. The loop may request ultracode only on its
first round.

### 4.6 `grok`

Follow `{plugin_root}/skills/deep-review-workflow/references/grok-integration.md`. Dispatch only after §3.3
issued a `containment_ready_token` and §3.1 returned a successful current Grok
privacy outcome, then invoke:

```text
node {plugin_root}/hooks/scripts/run-grok-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PAYLOAD_FILE --output OUTPUT_FILE --execution-route-json EXECUTION_ROUTE_JSON --reviewer-id grok --containment-ready-token-json CONTAINMENT_READY_TOKEN_JSON --timeout-seconds 900
```

`CONTAINMENT_READY_TOKEN_JSON` is the compact `JSON.stringify` of the token §3.3
issued, passed as one argv value — the same inline shape
`--execution-route-json` uses, so the admission is bound to this single
invocation and leaves no on-disk artifact a later round could replay. The bridge
consumes that token and never establishes readiness itself. It also consumes the
sealed compatibility evidence carried on the route, acquiring a fresh endpoint
from the §0 coordinator rather than re-probing. Never pass `--routing-plan`
here: the route travels inline.

A `mutated` result is untrusted even if the process produced report text, and an
unconfirmed whole-tree termination is `invalid_grok_process_lifecycle` rather
than a vote.

## 5. Synthesize and report

For every attempted role, serialize `role`, raw `output`, and the pre/post
fingerprint results to a private `attempts` JSON array. When at least two roles
remain trusted, perform the issue matching from `{plugin_root}/skills/deep-review-workflow/references/codex-integration.md` and add
a `consensus.findings` array. Each finding records `severity` (`critical` or
`warning`) and the unique admitted reviewer `roles` that reported that material
finding. Include every admitted critical and warning exactly once per reporting
role. Serialize `{ attempts, consensus, routing_plan, expansion_waves_used }`,
then invoke:

`role` is the canonical reviewer ID, not the assignment role or a display
label. Ultracode's single Anthropic voice uses `claude-opus`. Duplicate,
non-canonical, or plan-absent identities are an operational failure and never
increase `N_actual`.

```text
node {plugin_root}/hooks/scripts/review-synthesis.mjs --input ATTEMPTS_FILE
```

This production helper validates the report contract, excludes fingerprint
drift or malformed/empty output, and is the executable authority for
`N_actual`, terminal status, provisional expansion, final verdict, and
`phase6_allowed`. Its CLI never accepts caller-pre-evaluated attempts: every
attempt must carry raw output plus pre/post fingerprint evidence and is
re-evaluated at this boundary. If provisional synthesis returns `needs_expansion`, dispatch
exactly its one unused wave-2 route against the same original evidence and
independent rubric, then re-run synthesis once with all trusted attempts. Never
expand twice and never publish a provisional verdict. Stop when it returns
`operational_failure`; no later response or Phase 6 commit may proceed. When
the provisional result requests expansion, pass its `next_assignment` verbatim
as the added reviewer's `--execution-route-json`; that protocol-3 route already
contains the trusted rubric and resolved model/effort, so no plan file is
written or re-read. A
missing, invalid, or count-inconsistent materialized consensus for two or more
trusted roles fails closed with `consensus_required`.

An unavailable explicitly required reviewer/provider is an immediate
operational failure. An unavailable adaptive floor route may be replaced once:
the provisional result removes that failed soft floor route and marks the
materialized expansion route required in `expanded_routing_plan`. Adaptive
reviewer/provider counts are carried by the numeric floors, while
`required: true` is reserved for explicit constraints and the materialized
floor replacement. Final synthesis rejects a missing required route and also
rejects any missing materialized wave-2 route, so clearing or changing the
required flag cannot authorize Phase 6. SHA-256 binds the raw output to each
attempt at the synthesis boundary; the digest is an integrity binding, not a
reviewer identity. Independence comes from unique canonical reviewer IDs plus
fresh route-specific dispatch, validated route/report provenance, and trusted
pre/post fingerprints. Byte-identical canonical reports from distinct
identities are allowed: digest equality alone is not an operational identity
failure. A duplicate `reviewer_id`, a non-canonical or plan-absent identity, or
missing or invalid provenance remains an operational failure. Protocol-3
attempts require `reviewer_id == role`, and the materialized wave-2 route set
is cross-checked against the expansion counter so neither carrier can be
omitted. The plan's
`initial_reviewer_ids` and `required_reviewer_ids` are structural carriers:
every wave-1 route must remain in the initial set, every initial ID must have a
route, every wave-2 route must remain outside the set, and a wave-1 `required`
flag must agree with the hard-required set. The one allowed adaptive-floor
replacement atomically removes its failed soft ID from both the route list and
the initial set. Synthesis rejects route-only wave relabeling, dangling carrier
IDs, or required-bit clearing before any reviewer or provider-family count.

Count only successful trusted reviewer roles:

- `N_actual == 0`: no verdict is allowed; report an operational failure.
- `N_actual == 1`: critical or security findings yield `REQUEST_CHANGES`,
  warnings alone yield `CONCERN`, and no blocking finding yields `APPROVE`.
- `N_actual >= 2`: critical findings or agreed warnings yield
  `REQUEST_CHANGES`; split warnings yield `CONCERN`; otherwise `APPROVE`.

For critical implementation scope, require `N_actual >= 3` and at least two
provider families; a shortage is operational failure with no verdict. Other
floor shortages raise only an `APPROVE` to `CONCERN` and never lower a blocking
verdict. One critical/security finding, split CONCERN, a readiness mismatch, or
a failed minimum may request the single expansion wave.

Ultracode's six lenses are one role. A degraded failed Claude role never
downgrades a blocking verdict; it raises a low-confidence `APPROVE` to
`CONCERN` when at most one external role remains.

Use `{plugin_root}/skills/deep-review-workflow/references/codex-integration.md` for issue matching and `{plugin_root}/skills/deep-review-workflow/references/report-format.md` for the
artifact. Create one unique
`.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md` through a direct host
file tool. Record every attempted role, terminal status, `N_actual`, builder
warning, privacy exclusion, mutation outcome, and fingerprint exclusion.

For pure document scope, require every trusted reviewer report to contain
exactly one `Artifact Gate` JSON block from `{plugin_root}/skills/deep-review-workflow/references/report-format.md`. Invoke
`{plugin_root}/hooks/scripts/document-readiness.mjs` after final synthesis. Any pre-implementation Critical
or Warning, or a reviewer/provider-family shortage, yields
`DOCUMENT_BLOCKED`. `READY_FOR_IMPLEMENTATION` atomically writes
`.deep-review/receipts/document-readiness/{scope_sha256}-{receipt_sha256}.json`; return that path
and skip Respond. Warnings may coexist with READY only when they are
implementation-verification items with objective acceptance evidence.
Before readiness evaluation, atomically persist each trusted individual report
under `.deep-review/tmp/reviewer-reports/{round}-{reviewer_id}.md`. These private
files are receipt evidence and do not count as canonical round reports; the
exact-one `*-review.md` report-set delta remains unchanged.

## PRACTICAL DOCUMENT POLICY

For a validated document phase, document blockers are limited to a concrete
repository/artifact-grounded functional contradiction; implementation
infeasibility or a missing decision that prevents execution; reachable
safety/security/compatibility/migration/recovery/rollback harm; or acceptance
criteria incapable of objective verification.

Style, readability, naming, preference, and ungrounded speculation are
advisory/info or suppressed, not Warning/Critical pre-implementation blockers.
Missing future implementation/tests are implementation_verification evidence
with objective acceptance evidence, not document blockers. Document findings
alone do not allocate a same-round expansion; reviewer minimum/floor and
readiness-mismatch expansion remain active.

### design-validation

For an all-design-document/ADR scope, review implementation feasibility and
design soundness: block only the shared functional-contradiction,
infeasibility, safety/security/compatibility/migration/recovery/rollback-harm,
and grounded behavior-causing unsound design blockers above. Prose
completeness and unspecified implementation detail never block.

### full-readiness

For mixed, ambiguous, or executable document scopes, full-readiness applies:
additionally block a missing executable decision or an acceptance criterion
that fails to be objectively verifiable. Prose completeness, wording polish,
formatting, and harmless typos still never block. Mixed or ambiguous scope
classification uses full-readiness.

Artifact Gate readiness owns the final document verdict:
`DOCUMENT_BLOCKED` => `REQUEST_CHANGES`; `READY_FOR_IMPLEMENTATION` with
deferred findings => `CONCERN`; and `READY_FOR_IMPLEMENTATION` with no deferred
findings => `APPROVE`, across both modes. Recompute this verdict from the
sealed Artifact Gate evidence during verification; do not add it to the
readiness receipt schema. Readiness stays the final verdict authority; the
implementation phase retains normal code review, not this document policy.

For an implementation linked by a verified readiness receipt, evaluate every
deferred finding against fresh final-implementation evidence before allowing
`APPROVE`. Pending items raise APPROVE to CONCERN while preserving more
blocking verdicts.

## 6. Stage 5.5 and optional entropy

After the report exists, read `{plugin_root}/skills/deep-review-workflow/references/recurring-findings-export.md`. When at least two
reports exist, classify the taxonomy once, write the payload file directly,
and call `{plugin_root}/hooks/scripts/wrap-recurring-findings-envelope.js --discover-sources-from`.
Preserve the payload and return a visible nonzero result if wrapping fails.

When `--entropy` is present, read `{plugin_root}/skills/deep-review-workflow/references/entropy-scan.md` and append its evidence.
Patch `last_review` only after the report and optional export complete, while
preserving every unrelated config field.
