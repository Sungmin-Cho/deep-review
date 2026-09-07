---
name: deep-review-loop
description: Alternate independent review and evidence-based response until convergence on Claude Code or Codex.
user-invocable: true
argument-hint: "[--contract [SLICE-NNN]] [--entropy] [--ultracode] [--codex|--no-codex] [--no-opus] [--agy|--no-agy] [--grok|--no-grok] [--codex-only] [--reviewer-strategy adaptive|static] [--readiness-receipt PATH] [--routing auto|fast|balanced|quality] [--model PROVIDER=MODEL] [--effort PROVIDER=EFFORT] [--reviewer-model REVIEWER=MODEL] [--reviewer-effort REVIEWER=EFFORT] [--allow-fallback|--no-fallback] [--allow-classifier] [--max=N] [--session-doc]"
---

# deep-review-loop — Review and Respond loop

Claude Code enters through `/deep-review-loop`; Codex enters through
`$deep-review:deep-review-loop`. Both execute this file with identical args.

Resolve `plugin_root` using `PLUGIN_ROOT`, then `CLAUDE_PLUGIN_ROOT`, then the
installed skill location. Use absolute paths joined to that root for every
reference and Node helper.

## 0. Validate

Serialize the original argument tokens as a private JSON array and invoke
`public-route.mjs --entry loop --host HOST --args-file ARGS_FILE`. Its returned
JSON is the executable grammar authority. Stop on `ok=false` and use its
expanded `argv` without independently reparsing it.

- Reject `init`, `--respond`, and `--qa`; those are terminal routes of the
  public `$deep-review:deep-review` skill.
- `--max=N` must be a positive integer and counts Review calls, not Respond
  work. When it is omitted, implementation scope defaults to 5 rounds,
  low/medium document scope to 2, and high/critical document scope to 3.
- Accept `--contract [SLICE-NNN]`, `--entropy`, every public reviewer flag,
  routing/model/effort override, `--reviewer-strategy`, `--allow-fallback`, `--no-fallback`,
  `--allow-classifier`, and `--readiness-receipt`.
- Accept `--session-doc` (opt-in, **default OFF**). When present, maintain one
  consolidated per-session review document (§4/§6); the terminal review and
  respond routes never accept it. Default OFF is byte-identical to today.
- Expand and validate reviewer flags exactly as the public skill does.

Announce the safety maximum and that each round reports verdict, remaining
issues, and progress.

## 1. Round argument derivation

Never forward `--max`, `--respond`, `init`, or `--qa` to Review.

At round 1 start, clear residual `.deep-review/tmp/loop-*-round-*.state.json`
and `loop-*-round-*.prior.md` files left by a *crashed* previous loop, using the
Node runtime (never a shell-only helper):

```text
node {plugin_root}/hooks/scripts/loop-state.mjs cleanup-residue --tmp-dir .deep-review/tmp
```

`cleanup-residue` removes a loop's residue only when it is *provably not live* —
every recorded round's stamped owner probes as departed **and** its most-recent
activity predates the staleness grace window. The owner is bound to the loop's
**durable session process**, not this ephemeral CLI (whose transient
per-command shell parent dies immediately): on Claude Code the top-level
`claude` process (`CLAUDE_PID`, alive across every round and idle gap), carrying
the session UUID (`CLAUDE_CODE_SESSION_ID`); on Codex the session id
(`CODEX_COMPANION_SESSION_ID`) with no durable pid. Any owner that is live,
permission-blocked, on a foreign host, timeline-inconsistent, session-id-only
(no probeable pid), or absent (legacy state, or no durable identity was
resolvable), and any orphan `.prior.md` with no state file, is left untouched.
This mirrors the owner + liveness model in `mutation-protocol.mjs`
(`classifyLiveness`): a concurrent loop that is merely idle — waiting on
reviewers or human input, even for hours — keeps its live round state and
pending prior-context, because its durable session process is still alive and
probes live. When no durable identity can be resolved, `record-round` stamps no
owner at all — keep-biased, never more aggressive than an age-only sweep — so
deletion never fires on an unknowable owner. Session-only, advisory-only REJECT
memory therefore never leaks across loop instances, and a live sibling loop is
never disrupted. Round 1's `record-round` (§4) mints a fresh `loop_id` and
echoes it; store that value and reuse it via `--loop-id` on every later round in
this session — never re-mint mid-session.

- Every round forwards the user's review, contract, entropy, reviewer,
  reviewer-strategy, routing, model/effort, fallback/classifier, and explicit
  readiness-receipt flags. A leaf adapter receives only its selected route.
- If round 1 requested `--ultracode`, mark `ultracode_consumed=true` after that
  attempt. For every ultracode-consumed round 2+, derive the Review argv with
  the token-aware normalizer below. It removes `--ultracode`, every `--grok`
  and existing `--no-grok` token, and only complete Grok-keyed pairs for
  `--model`, `--effort`, `--reviewer-model`, and `--reviewer-effort`. It never
  uses substring replacement or consumes a neighbouring non-Grok value.

  For ultracode-consumed loops, Rounds 2+ remove `--ultracode`; the cadence normally injects `--no-opus --no-agy`, but a Codex-unavailable round must withhold only the injected `--no-opus`.

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
  through `parsePublicRoute` and continue only with `ok: true`. This retains
  Codex and appends exactly one `--no-grok` after the cadence disables.
- If that round reports Codex unavailable, set `codexUnavailable=true`: only
  the injected `--no-opus` is withheld on the next round. Grok selectors are
  still stripped, `--no-grok` is still appended, and ultracode is not repeated.
- When the user never requested ultracode, preserve the original reviewer
  constraints on every round. Adaptive routing derives each round's role-fit
  selected set; `--codex-only` loops remain Codex-only.
- `review_model` is read by the review pipeline and forwarded unchanged on
  every eligible Claude round. Custom installed aliases such as `fable` are
  never replaced with a hardcoded model.

## 2. Review sub-step

At the beginning of every round, execute the review pipeline's Stage 0
`mutation-protocol.mjs auto-recover` path. Failure is an operational stop.

For round 2+, **before** `review-execution.md` Stage 0 begins (this ordering
keeps the write outside the Stage 3/4 fingerprint-sensitive window — RF-008),
render the previous round's advisory context from its `record-round`-echoed
`state_file`:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs render-prior-context --state-file PREVIOUS_STATE_FILE --output PRIOR_CONTEXT_FILE
```

Forward the echoed `output_file` explicitly as `--prior-rounds-file=PRIOR_CONTEXT_FILE`
on this round's review branch call — the file's mere existence never triggers
consumption; only this explicit flag does (`public-route.mjs` `parseReview`
accepts the token; `build-reviewer-payload.mjs` performs the validated
ingest, per `review-execution.md` Stage 2). Round 1 has no previous state, so
this step is skipped on round 1.

Before Review, create a private snapshot file with:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs snapshot-reports --reports-dir REPORTS_DIR --output SNAPSHOT_FILE
```

Then read and execute `deep-review-workflow/references/review-execution.md` with
the derived round args. Wait for all reviewer contexts and Stage 5.5 to finish.

Immediately resolve the report-set delta:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs resolve-round-report --reports-dir REPORTS_DIR --snapshot-file SNAPSHOT_FILE
```

The Node CLI compares exact absolute set entries and succeeds only when exactly
one new canonical `*-review.md` exists. Zero or multiple entries is a terminal
operational error. Store its `report_path` as `round_review_report_path`.

The prepared review pipeline returns `report_path` and `decision_path` from
`review-evidence.mjs finalize`. Require exact equality of `report_path` with the
resolved report delta and store the returned `decision_path`. A missing or
changed companion is operational failure; never reconstruct it from prose.
Synthesis owns reviewer admission, required roles, the at-most-one expansion,
and the critical implementation floor of three trusted reviewers across two
provider families. An operational failure is terminal on its first occurrence.

At loop start, use the captured target's immutable `scope.review_base` for all
rounds. It is null for initial/non-Git scopes; do not invent a commit. Keep the
actual explicit path manifest, including session documents. After classification
and before planning a later round, generate the schema-3 carrier with:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs adaptive-context --state-file PREVIOUS_STATE_FILE --current-target-file CURRENT_TARGET_FILE
```

Require the CLI result's `ok: true`, then remove only the transport `ok` key.
Pass the remaining schema-3 carrier verbatim to the classifier's
`--adaptive-context-json`. The classifier re-captures its actual selected scope
and validates the previous decision, observations, pending ledger and Phase 6
proof. A full review after a changed view or expanded scope still receives the
exact pending IDs, bound to the fresh current target; this does not permit a
smaller reviewer slate. Schema 1/2 history remains advisory. Only runtime-verified confirmation
can contract; report-only new or stalled observations do not add cost. Explicit
regression evidence uses the source/target-bound carrier accepted by the Node
runtime. Public constraints and risk floors still apply.

If terminal review failure produced no decision, use the count-only
record-operations / decide-operational-stop sequence in
`{plugin_root}/skills/deep-review-workflow/references/review-execution.md` and
publish that stopped result. Do not create a successful schema-3 state or a new
verdict. Preserve retired soft-floor receipts separately and pass their JSON
path list as `--operation-receipts-file` to record-round and before-Respond
decide-round so attempted calls remain in the totals.

## 3. Decide before Respond

Unconditionally capture the current target through the review-evidence capture
helper, even if Respond appears unnecessary. Then invoke:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs decide-round --decision-file DECISION_FILE --round-number N --round-limit ROUND_LIMIT --current-target-file CURRENT_TARGET_FILE --phase before-respond
```

On rounds 2+, append `--previous-state PREVIOUS_STATE_FILE`. Use the first
recorded limit; an explicit user change requires the runtime-validated
`--round-limit-override-file` with source, reason, prior_limit and new_limit.
These fields record the user's actual instruction; elapsed time is not consent.
Execute only the returned action. This is the stop/continue authority, including
last-slot behavior: `--max=1` is review-only and the final Review never starts
automatic Respond. New verdicts or N_actual must never be generated for a Review
that did not run. Record the last trusted verdict against its reviewed target.

For `action: respond`, execute the public `--respond` branch with the exact absolute `round_review_report_path` and carry the exact `decision_path` as
internal response context. The response reference verifies that companion and
uses `review-evidence.mjs response-items` for implementation ACCEPT eligibility.
Verify the loaded report path through:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs assert-same-path --expected ROUND_REVIEW_REPORT_PATH --actual LOADED_RESPONSE_SOURCE
```

The loop pre-approves ordinary response confirmation. Privacy, mutation
ownership, pre-staged confirmation and DEFER choices retain their existing gates.
Phase 6 records every attempted group and returns archived `evidence_file` from
`loop-state.mjs build-response-evidence`. A response halted or failed result
remains unknown evidence; it never becomes a zero-change success.

## 4. Record the round

After Review and optional Respond, capture the current scope again. Call:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs record-round --repo-root PROJECT_ROOT --state-dir .deep-review/tmp --round-number N --round-limit ROUND_LIMIT --review-report ROUND_REVIEW_REPORT_PATH --decision-file DECISION_FILE --post-response-target-file CURRENT_TARGET_FILE
```

On rounds 2+, append `--previous-state PREVIOUS_STATE_FILE --loop-id LOOP_ID`.
For an executed response, append `--response-report RESPONSE_REPORT_PATH` and
its actual `--response-evidence-file RESPONSE_EVIDENCE_FILE` when available.
Store returned `{loop_id, state_file}`. The runtime binds the immutable base,
report/decision digests, observed findings, prior pending ledger, positive
closure, snapshots, response proof and actual operation accounting. It retains
the durable-session owner used by `cleanup-residue`. The legacy
`collect-metrics` and report-only schema-2 `record-round` remain display APIs;
their parsed counters and `findings_signature` grant no completion authority.

An omitted pending ID is displayed as not re-observed and remains pending.
Only bound positive confirmation closes implementation findings. Document
readiness retains scope-level Artifact Gate and deferred receipt evidence.

### 4a. Session doc (only when `--session-doc`)

When the flag is present (default OFF), re-render one consolidated per-session
review document in place after each recorded round:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs render-session-doc --loop-id LOOP_ID --tmp-dir .deep-review/tmp --reports-dir REPORTS_DIR --output REPORTS_DIR/loop-{loop_id}-review.md
```

This additive view links the canonical review/response reports, shows observed
progress and pending versus verified-closed findings, and derives executed
calls and unused capacity from all recorded rounds. It is excluded from
`snapshot-reports` / `resolve-round-report` delta accounting and never replaces
a canonical report. `compare-rounds` is an advisory observation comparison,
not a second termination predicate.

## 5. Decide after Respond

Use the freshly captured current target even when Respond was skipped:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs decide-round --state-file CURRENT_STATE_FILE --round-limit ROUND_LIMIT --current-target-file CURRENT_TARGET_FILE --phase after-respond
```

Before-Respond decision-file and after-Respond state-file modes are mutually
exclusive. Forward actual user stop, DEFER-and-stop, halt and operational signals with
their corresponding boolean flags. Follow the returned `action`, `stop_reason`,
`completion_status` and `final_tree_verified` without recomputing a verdict.
`review` starts the next bounded Review; `stop` publishes the result and ends.
A changed source awaiting another Review is `verification_pending`; terminal
unreviewed bytes carry `UNVERIFIED_FINAL_TREE` alongside the actual stop reason.
History-only replay retains the ledger and supplies no current readiness.

## PRACTICAL DOCUMENT POLICY

For a trusted `artifact_phase: document` loop, document blockers are limited to
a concrete repository/artifact-grounded functional contradiction;
implementation infeasibility or a missing decision that prevents execution;
reachable safety/security/compatibility/migration/recovery/rollback harm; or
acceptance criteria incapable of objective verification.

Style, readability, naming, preference, and ungrounded speculation are
advisory/info or suppressed, not Warning/Critical pre-implementation blockers.
Missing future implementation/tests are implementation_verification evidence
with objective acceptance evidence, not document blockers. Finding-only
document disagreement does not cause same-round expansion; reviewer
minimum/floor and readiness mismatch remain fail-closed.

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
findings => `APPROVE`, across both modes. Readiness stays the final verdict
authority; the implementation phase retains normal code review, not this
document policy.

After each round, report verdict, issue counts, change summary, and the decision
in one paragraph.

## 6. Final summary

**Default (no `--session-doc`)**: write one unique private loop summary with a
direct host file tool. Use the final `decide-round` result and schema-3 states:
round_limit, rounds_executed, unused_round_capacity, planned/executed/admitted/
not-run reviewer calls, final_tree_verified, completion_status, last trusted
verdict and target attribution, stop reason, response evidence, readiness and
remaining human or external work. Unknown token/time/cost usage stays null.
Legacy `rounds_saved` and `reviewer_calls_saved` are non-authoritative historical
labels; unused capacity is not measured money saved.

**When `--session-doc` is ON**: save the final Node decision result as
`FINAL_SUMMARY_FILE`, adding only explanatory remaining_work, then run:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs render-session-doc --loop-id LOOP_ID --tmp-dir .deep-review/tmp --reports-dir REPORTS_DIR --output REPORTS_DIR/loop-{loop_id}-review.md --final-summary-file FINAL_SUMMARY_FILE
```

This final pass appends the closing summary to the single durable document;
do not write a separate `*-loop-summary.md`. Omitting `--final-summary-file`
keeps per-round rendering deterministic. Delete only this session's advisory
`loop-*-round-*.prior.md` files. Preserve states, target snapshots, decision
companions and archived response evidence for verification and history.
