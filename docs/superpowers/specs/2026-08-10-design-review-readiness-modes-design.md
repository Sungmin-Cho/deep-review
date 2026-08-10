# Design Review Readiness Modes

## Problem

`deep-review-loop` currently applies one practical document policy to every
reviewable document type. That policy is appropriate for executable
implementation plans, requirements, and test plans, but it lets reviewers
treat design-document completeness as a pre-implementation concern. Because
every pre-implementation Warning blocks document readiness, minor omissions
and prose-completeness findings can consume the document round cap without
improving implementation feasibility or design soundness.

The supported production path also passes each reviewer only its inline
execution route. The current inline-route parser deliberately discards
document-level `artifact_phase` and `risk`, so the common document policy is not
reliably injected through the same trusted path for Claude Code and Codex.

## Goal

Make design-stage review judge whether a design can be implemented and whether
its boundaries, responsibilities, data flow, failure behavior, compatibility,
and rollback strategy are sound. Do not make prose or documentation
completeness a convergence requirement.

Keep executable implementation artifacts strict enough to serve as safe,
objectively verifiable implementation contracts without treating writing
quality or formatting completeness as blockers.

## Scope

The new design-focused policy applies only when every reviewed document is one
of:

- `design-document`
- `architecture-decision-record`

The existing full-readiness policy applies when any reviewed document is one
of:

- `implementation-plan`
- `requirements-specification`
- `test-plan`

A design document does not become an implementation plan merely because it
contains implementation feasibility analysis, interfaces, data flow,
migration or rollback strategy, a testing approach, constraints, alternatives,
example code, or implementation notes. It becomes an implementation plan when
its primary contractual purpose is to prescribe executable work: ordered
tasks, file-level changes, dependencies, ownership, and objective completion
criteria. A mixed or unresolved scope uses full readiness.

## Readiness Modes

The routing contract carries one of two values:

- `design-validation`: validate implementability and design soundness.
- `full-readiness`: validate that an executable document can safely direct and
  objectively verify implementation.

### Design-validation blockers

A finding may block design readiness only when grounded in the reviewed
artifact and repository evidence and it demonstrates at least one of:

- a functional contradiction;
- implementation infeasibility;
- an unsound boundary, responsibility split, dependency direction, or data
  flow that would cause incorrect behavior;
- reachable safety, security, compatibility, migration, recovery, or rollback
  harm.

Unspecified implementation details, prose completeness, coverage inventories,
traceability-table completeness, missing future code or tests, formatting,
wording, naming preference, and unsupported speculation are advisory, Info, or
`implementation_verification`. They do not block design readiness unless the
omission makes implementation impossible or creates one of the concrete harms
above.

### Full-readiness blockers

Full readiness is not prose-completeness review. Style, sentence polish,
formatting, section length, naming preference, harmless typos, and
implementation-irrelevant omissions remain advisory or suppressed.

A finding may block only when it shows:

- a functional contradiction;
- a missing decision that prevents implementation or causes materially
  different valid implementations;
- implementation infeasibility;
- an unsafe or incompatible sequence, dependency, ownership boundary, or
  rollback path;
- acceptance criteria that cannot be objectively verified.

A wording defect is blocking only when it changes an executable contract, such
as a command, path, condition, negation, ordering rule, or acceptance result.

## Architecture and Data Flow

1. Artifact classification continues to assign each artifact a
   `target_kind`.
2. Adaptive review routing derives a document review mode from the complete
   artifact set:
   - all design/ADR artifacts: `design-validation`;
   - any other, mixed, empty, or unresolved set: `full-readiness`.
3. The routing plan records the derived mode and copies the trusted
   `artifact_phase`, `risk`, and `document_review_mode` onto every protocol-3
   inline execution route. The mode is fixed when the expansion template is
   built; same-round expansion forwards it verbatim and never re-derives it per
   reviewer or provider.
4. Inline-route validation accepts only the two known modes, requires document
   context to be internally consistent, and fails closed on invalid values.
   A routing-plan document that identifies document phase but omits the new
   mode defaults to `full-readiness`. A legacy inline route that lacks all
   document context preserves its pre-change behavior and cannot opt into
   `design-validation`; every route emitted by the current producer carries
   the complete context.
5. `build-reviewer-payload.mjs` reads only the validated execution-route result.
   `artifact_phase` decides whether document policy is injected;
   `document_review_mode` is the sole selector for which document blocker
   policy is injected. The payload builder never re-derives the mode from
   phase, risk, role, reviewer, or provider. It remains the shared doctrine
   injector for Claude Code and Codex.
6. Review synthesis and document readiness consume the resulting structured
   findings exactly as they do today.

The new mode is policy context, not a new reviewer identity or assignment
role. Existing feasibility, traceability, adversarial, security, standard, and
confirmation roles remain unchanged.

## Fail-Closed and Compatibility Invariants

The change does not alter:

- `N_actual == 0` operational failure;
- reviewer-count or provider-family floors;
- reviewer independence and route provenance;
- read-only fingerprints or mutation ownership;
- document-readiness receipt schema 1.0 or historical receipt verification;
- readiness content addressing;
- Phase 6 snapshot, verification, and commit gates;
- document round caps or convergence accounting.

Mixed or unresolved artifact classifications resolve to the stricter behavior.
An explicitly supplied unknown mode is rejected rather than silently
downgraded. A routing-plan document with document phase and no mode retains
full-readiness semantics for compatibility. A legacy context-free inline route
remains readable but never gains the relaxed design policy by inference.
No missing, malformed, or default-value path may produce
`design-validation`; only the validated all-design/ADR derivation may do so.

## Host Compatibility

Claude Code and Codex already consume the same public skill and Node routing,
payload, synthesis, and readiness runtime. The mode is derived before provider
dispatch and carried in each provider-neutral inline route, so neither host
uses host markers or a separate policy implementation.

## Error Handling

- Unknown `document_review_mode`: reject the execution plan or inline route.
- Design mode on a non-document phase: reject as an inconsistent route.
- Mixed or ambiguous target kinds: derive `full-readiness`.
- Missing mode on a document-aware legacy plan route: use `full-readiness`.
- Missing document context on a legacy inline route: preserve the old parsed
  result and do not inject `design-validation`.
- Missing reviewer/provider evidence: preserve the existing operational stop.
- Invalid or stale readiness evidence: preserve the existing fail-closed
  receipt behavior.

## Test Strategy

Implementation starts with RED tests proving:

1. mode derivation returns `design-validation` for design-only and ADR-only
   scopes;
2. implementation-plan, requirements, test-plan, mixed, empty, and ambiguous
   scopes return `full-readiness`;
3. protocol-3 plans and every inline route carry the same trusted phase, risk,
   and mode, including expansion routes;
4. invalid modes and non-document/design-mode combinations fail closed;
5. document-aware legacy plan routes without a mode retain full-readiness,
   while context-free legacy inline routes remain readable and cannot opt into
   design-validation;
6. both Claude and Codex reviewer payloads receive byte-equivalent policy
   content for the same mode;
7. design-validation suppresses prose/traceability completeness as blockers
   while retaining infeasibility and concrete harm as blockers;
8. full readiness suppresses stylistic completeness while retaining missing
   executable decisions and unverifiable acceptance as blockers;
9. existing document-readiness and historical receipt tests pass unchanged;
10. public skills, reviewer definitions, and bilingual user documentation stay
    structurally consistent.

After targeted tests, run the repository contract and release verification
listed in `AGENTS.md`, including `npm test`, `npm run test:legacy`, the pinned
Node contract tests, and `git diff --check`.

## Operational Model Routing

This implementation session uses the user-requested routing:

- initial design: Fable 5;
- fixes and implementation: Sonnet 5;
- independent review: Opus 5 and `gpt-5.6-sol`;
- reasoning effort selected per dispatch based on scope, risk, and difficulty.

Requested and actually applied model/effort identities are reported
separately. Unavailable or rejected models are not silently substituted.

## Repository Hygiene

`package-lock.json` is not tracked, and this package has no dependencies or
devDependencies. The implementation may add `/package-lock.json` to the root
`.gitignore`; it must not delete or overwrite the user's existing untracked
file.

## Non-Goals

- Lowering readiness reviewer or provider floors.
- Making Warning findings globally non-blocking.
- Changing receipt schema or historical receipt semantics.
- Adding a new reviewer role or rubric version.
- Changing implementation-plan, requirements, or test-plan into lightweight
  design review.
- Reducing round caps as a substitute for correcting reviewer policy.
- Polishing documents for stylistic completeness.
