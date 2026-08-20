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

Apply reviewer-count rules before Respond:

- `N_actual == 0`: stop with operational failure; no verdict is trusted.
- `N_actual == 1`: Critical or security is `REQUEST_CHANGES`, Warning-only is
  `CONCERN`, and no blocking issue is `APPROVE`.
- Larger sets use the synthesis contract in
  `{plugin_root}/skills/deep-review-workflow/references/review-execution.md`.

Review synthesis is two-wave at most. First produce a provisional result with
`review-synthesis.mjs`. When it reports `needs_expansion`, dispatch exactly one
unused reviewer from wave 2. Pass the returned `next_assignment` verbatim as the
added reviewer's `--execution-route-json`; this binds the returned model/effort
and trusted rubric without hand-editing or re-persisting a plan. Use the same original evidence and never reveal another reviewer's
conclusion. Re-synthesize all trusted attempts once and emit one final verdict.
Critical implementation scope requires at least three trusted reviewers across
two provider families; a shortage is an operational failure without a verdict.

For round 2+, pass `classify-artifacts.mjs --adaptive-context-json` a schema-2
JSON object containing the previous risk, code-owned progress result, and
canonical reviewer IDs used in the previous round. Schema 1 state is advisory
only and must not populate this carrier.

For pure document scope, evaluate the `Artifact Gate` after synthesis.
`READY_FOR_IMPLEMENTATION` skips Respond and stops the loop after atomically
writing the content-addressed readiness receipt. If the document cap is
reached without readiness, preserve the last canonical verdict, record
`DOCUMENT_BLOCKED`, and do not start another Review.

## 3. Respond sub-step

Skip Respond for `READY_FOR_IMPLEMENTATION`, for `APPROVE` with zero Critical
and Warning issues, and for a split-only `CONCERN` with no accepted actionable
item.

Otherwise execute the public `--respond` branch with the exact absolute
`round_review_report_path`. After the response reference loads its source path,
verify identity through:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs assert-same-path --expected ROUND_REVIEW_REPORT_PATH --actual LOADED_RESPONSE_SOURCE
```

The comparison canonicalizes absolute paths without filesystem alias
resolution. A mismatch stops the loop before implementation. The loop's entry
notice pre-approves the ordinary response confirmation, but privacy warnings,
mutation ownership, pre-staged confirmation, and DEFER choices remain active.
If the user selects DEFER-and-stop, end after the current round.

## 4. Metrics sub-step

After Review and optional Respond, invoke:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs collect-metrics --round-number N --review-report ROUND_REVIEW_REPORT_PATH --response-report RESPONSE_REPORT_PATH --recurring-findings RECURRING_FILE
```

Omit the response arguments when Respond was skipped. Store the JSON fields:
round number, absolute review/response paths, verdict, Critical/Warning/Info
counts, accepted/rejected/deferred/implemented counts, halted, execution path,
and `findings_signature`.

Each signature is
`severity:file:floor(line/7):taxonomy_category`. The category comes from the
current recurring artifact's exact `example_files` match and otherwise is
`untagged`. This field is vestigial for stop-condition purposes — display and
backward-compatibility only. The deterministic stop logic in §5 consumes
`compare-rounds` output, never `findings_signature`.

Immediately after `collect-metrics`, record this round's finding-state for
convergence comparison:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs record-round --round-number N --review-report ROUND_REVIEW_REPORT_PATH --response-report RESPONSE_REPORT_PATH --base-commit REVIEW_BASE --repo-root PROJECT_ROOT --state-dir .deep-review/tmp [--loop-id LOOP_ID]
```

Omit `--response-report` when Respond was skipped. Omit `--loop-id` on round 1
only — `record-round` mints one and echoes `{loop_id, state_file}`; store both
for every later round in this session (pass the same `loop_id` back via
`--loop-id` on rounds 2+; never re-mint). `--base-commit` is required.
`--repo-root PROJECT_ROOT` is required so finding locations canonicalize to a
repo-relative identity — without it absolute path citations stay absolute and
`compare-rounds` misreads an unchanged finding as resolved+added instead of
repeated, defeating stall detection. `record-round` also stamps the round state
with this loop's **durable session** liveness owner (the top-level `claude`
process on Claude Code, the session id on Codex, or none when neither is
resolvable), which §1's `cleanup-residue` consults to tell a crashed loop's
residue from a live sibling's — the live sibling's durable session process is
still probeable, so its residue is kept.

Write a private routing-metadata JSON file and pass
`--routing-metadata-file ROUTING_METADATA_FILE`. It records schema-2 evidence:
artifact phase/risk, routing-plan digest, planned/actual reviewers,
assignment/model/effort and wave, response metrics, expansion, calls saved,
readiness, and receipt path. A schema-1 state remains readable as legacy
convergence evidence but must never be used to infer adaptive routing.

### 4a. Session doc (only when `--session-doc`)

When `--session-doc` was accepted (§0), re-render this session's single
consolidated review document **in place** right after `record-round`, keyed by
this loop's `loop_id`:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs render-session-doc --loop-id LOOP_ID --tmp-dir .deep-review/tmp --reports-dir REPORTS_DIR --output REPORTS_DIR/loop-{loop_id}-review.md
```

The document always lives at `.deep-review/reports/loop-{loop_id}-review.md`
(no timestamp — the SAME file every round, so a session yields exactly one human
review doc). `render-session-doc` is pure and deterministic: it reads only this
session's sorted per-round `loop-{loop_id}-round-{N}.state.json` files (and the
review/response paths recorded in them) and re-renders the latest verdict, the
per-round verdict/count history with code-owned
`regression > confirmation > stalled > changed` progress, adaptive assignments,
model/effort, expansion and readiness, the
open-vs-resolved findings rollup (via `matchFindings`), and per-round
review/response links, written atomically. Because its name matches the
`loop-<id>-review.md` session-doc pattern (not the timestamp-prefixed canonical
`{date}-{time}-review.md`), it is **excluded** from `snapshot-reports` /
`resolve-round-report` delta accounting — the per-round REPORT_DELTA_COUNT
invariant (§2) still observes exactly one NEW canonical report per round. The
session doc is a derived, additive view; it never replaces a per-round
`*-review.md`. When `--session-doc` is absent (default), skip this step entirely
and behave exactly as before.

## 5. Stop or continue

Stop immediately when any condition holds:

1. `READY_FOR_IMPLEMENTATION` for pure document scope, or implementation
   `APPROVE` with zero Critical and Warning issues and every deferred receipt
   item verified.
2. Review count reaches the resolved cap. For a non-ready document this stop
   reason is `DOCUMENT_BLOCKED`; no additional Review is created.
3. `compare-rounds` (previous round's `state_file` vs. this round's) reports
   `stalled=true` AND this round's `implemented_count == 0`, or the response halted:

   ```text
   node {plugin_root}/hooks/scripts/loop-state.mjs compare-rounds --previous PREVIOUS_STATE_FILE --current CURRENT_STATE_FILE
   ```

   This condition **consumes `compare-rounds`'s code-owned `stalled` output**
   in place of the former natural-language "half of the larger set repeats"
   judgment; the `halted` branch is preserved unchanged. Round 1 has no
   previous state to compare against, so condition 3 cannot fire before
   round 2.
4. Two operational failures occur in one round.
5. The user chooses stop or DEFER-and-stop.
6. `N_actual == 0` or a Codex-only round has no Codex role.
7. This round's `accepted_count == 0` AND `implemented_count == 0` AND
   `halted == false` — a Review executed but nothing was accepted or
   implemented and Respond did not halt (most often a split-only `CONCERN`
   round where Respond was itself skipped per §3). Stop with the last
   trusted verdict; **do not start another Review round.**

**Condition interaction**: condition 7 fires immediately whenever a
split-only `CONCERN` round skips Respond (§3) — this is an intended early
stop, not a bug. §3's Respond-skip rule and condition 7 interact by design to
avoid an idle extra round.

**Skip semantics — three distinct kinds, never conflate them**:
(a) *Respond skip within an executed round* (§3 — `APPROVE` with zero issues,
or a split-only `CONCERN` with no accepted actionable item; that round's
metrics use response defaults);
(b) *stopping before starting another Review round* (conditions 2/3/6/7 — no
new round begins, and a new `verdict` or `N_actual` must never be generated
for a round whose Review was never started; the loop summary's final verdict
attribution is always the last executed canonical report, never inferred or
synthesized by the loop layer);
(c) the user's explicit DEFER-and-stop choice (§3), which ends after the
current round regardless of other conditions.

Continue when the verdict is actionable, at least one change was implemented,
the response did not halt, `compare-rounds` shows progress (`progressed=true`
or `stalled=false`), and the resolved round cap is not reached. In a gray area,
stop on external dependency or repeatedly failing dispatch rather than
cycling without evidence.

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

**Default (no `--session-doc`)**: use a direct host file tool to write one unique
`.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-loop-summary.md`. Include each
round's review and response paths, counts, implemented total, final verdict,
stop reason, `rounds_saved` (the resolved cap minus the number of rounds that
actually executed a Review), `reviewer_calls_saved`, per-round assignments,
expansion, readiness and receipt path, and remaining human or external work.
Loop state is otherwise session-local; existing reports allow a later explicit
response to resume.

**When `--session-doc` is ON**: after the loop stops (§5), run one FINAL
`render-session-doc` pass — the per-round renders (§4a) run before the stop is
decided and never receive the closing data, so this pass supplies it explicitly
via `--final-summary-file`:

```text
node {plugin_root}/hooks/scripts/loop-state.mjs render-session-doc --loop-id LOOP_ID --tmp-dir .deep-review/tmp --reports-dir REPORTS_DIR --output REPORTS_DIR/loop-{loop_id}-review.md --final-summary-file FINAL_SUMMARY_FILE
```

`FINAL_SUMMARY_FILE` is a private JSON object with `stop_reason`, `rounds_saved`
(the resolved cap minus the number of rounds that actually executed a Review),
`reviewer_calls_saved`, `implemented_total` (the summed `implemented_count`
across rounds), `readiness`, `receipt_path`, and `remaining_work` (an array of
remaining human or external items). This final
pass appends a `## Final summary` section, so the single durable document
`.deep-review/reports/loop-{loop_id}-review.md` **absorbs** the loop summary — do
**not** write a separate `*-loop-summary.md`, avoiding a duplicated
round-by-round artifact. The doc already carries the per-round review/response
links, the verdict/count history, and the cumulative open-vs-resolved rollup;
the final pass adds exactly the stop reason, `rounds_saved`, implemented total,
and remaining work the standalone summary used to hold, so nothing durable is
lost. Omitting `--final-summary-file` renders a byte-identical doc, so the
per-round renders (§4a) and the default-OFF path are unaffected.

Delete this session's `loop-*-round-*.prior.md` advisory files with a direct
host file tool. Leave the `.state.json` files in place — they remain
readable evidence of the round history.
