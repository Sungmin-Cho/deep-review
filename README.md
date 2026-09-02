**English** | [한국어](./README.ko.md)

# deep-review

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/deep-review?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/deep-review)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/deep-suite)

An independent Evaluator plugin for AI coding agents — cross-model code review with Codex integration and Sprint Contract support.

AI coding agents have a structural blind spot: they review their own work. The agent that wrote the code also judges it, so self-approval bias is built in. deep-review runs a **separate reviewer context** that sees the shared review payload — not the reasoning, intentions, or assumptions behind the code — for a structurally independent evaluation. Claude Code invokes both Codex reviewer roles through isolated `codex exec` sessions, while Codex invokes both roles as history-free native subagents; optional Claude, `agy`, and opt-in Grok/xAI roles broaden cross-model verification.

## Role in deep-suite

deep-review is the **independent evaluator** of the [deep-suite](https://github.com/Sungmin-Cho/deep-suite), implementing the Generator–Evaluator separation from the [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) framework:

- **Inferential sensor** — an independent Opus subagent review with zero Generator context, the primary quality gate for semantic issues computational sensors cannot catch.
- **Cross-model verification** — Opus + Codex review + Codex adversarial (+ opt-in agy/Grok), exceeding the framework's "LLM-as-judge" concept.
- **Fitness-aware review** — consumes `fitness.json` rules and the `health_report` from [deep-work](https://github.com/Sungmin-Cho/deep-work) for architecture-intent-aware evaluation.
- **Sprint Contract verification** — structured success-criteria checking.

## Install

Via the `claude-deep-suite` marketplace:

```bash
# Claude Code
/plugin install deep-review@claude-deep-suite

# Codex
codex plugin install deep-review
```

No additional configuration is required. On first run, `.deep-review/` is created with a default `config.yaml`. Run `/deep-review init` to generate a project-specific `rules.yaml`.

The supported runtime is zero-dependency Node.js 22 with Git 2.45 or newer on macOS, Linux, and native Windows 11. Git Bash is not a prerequisite.

## Usage

Claude Code slash commands and Codex skills are distinct host entrypoints for the same route grammar.

### Claude Code

| Command | Description |
|---|---|
| `/deep-review` | Review current changes with an independent Opus subagent (cross-model when Codex or explicitly enabled agy/Grok routes are present) |
| `/deep-review --ultracode [--codex]` | Six focused Claude reviewer contexts collapsed into one "Claude(ultracode)" voice, with a visible single-bridge fallback and optional Codex roles |
| `/deep-review --codex-only` | Disable the Claude reviewer and run only the available Codex roles |
| `/deep-review --contract [SLICE-NNN]` | Sprint Contract-based structural verification |
| `/deep-review --entropy` | Entropy scan (duplicates, pattern drift, naming mismatches) |
| `/deep-review --respond [REPORT_PATH]` | Respond to review findings with the evidence-based protocol |
| `/deep-review --respond --source=pr` | Respond to GitHub PR review comments |
| `/deep-review-loop [--max=N]` | Auto-iterate review ↔ respond until convergence (also a `user-invocable` skill — `Skill({ skill: "deep-review:deep-review-loop" })` for Codex CLI / SDK consumers) |
| `/deep-review-loop --ultracode --codex` | ultracode once (round 1) + codex every round integrated loop |
| `/deep-review-loop --session-doc` | Maintain one consolidated per-session review document, re-rendered in place after each round (per-round reports unchanged) |
| `/deep-review --reviewer-strategy static` | Fix the eligible reviewer set instead of adaptive selection |
| `/deep-review --readiness-receipt PATH` | Bind an implementation review to a verified document-readiness receipt |
| `/deep-review --dry-run` / `--explain-routing` | Classify review targets and print the capability-aware model/effort plan without running any reviewer (artifact-aware routing Phase 2) |
| `/deep-review init` | Initialize per-project review rules interactively |

### Codex

| Skill | Description |
|---|---|
| `$deep-review:deep-review` | Review current changes with the same flags and synthesis rules as `/deep-review` |
| `$deep-review:deep-review --respond [REPORT_PATH]` | Run the evidence-based response protocol |
| `$deep-review:deep-review-loop [--max=N]` | Alternate review and response until convergence |
| `$deep-review:deep-review --readiness-receipt PATH` | Verify a document receipt and enforce its deferred acceptance evidence |

**Composable reviewer flags**:

- `--ultracode` — six focused Claude reviewer contexts collapsed into one "Claude(ultracode)" voice; an unavailable fan-out degrades visibly to one native Claude bridge.
- `--codex` / `--no-codex` / `--no-opus` / `--agy` / `--no-agy` / `--grok` / `--no-grok`, and `--codex-only` (= `--codex --no-opus --no-agy --no-grok`).
- **`agy` is opt-in and off by default.** A detected `agy` CLI is no longer elected on its own; pass `--agy` to enable it. This drops the default reviewer set from 4 to 3, which removes the spare that used to backfill a failed reviewer in high/critical implementation reviews. Two pre-existing combinations change: `--no-opus` now yields Codex-only routes (one provider family), and `--no-opus --no-codex` has no reviewer left. Add `--agy` to restore either. Opt-in governs reviewer dispatch and project access, not capability detection — the `agy --version` probe still runs.
- **Grok/xAI is opt-in and off by default.** Detection alone does not elect or dispatch Grok, and an ordinary no-flag review sends no repository content to Grok/xAI. Pass `--grok` (or supply an explicit Grok-targeting routing override or policy opt-in) to make it a candidate; the external privacy preflight must pass before dispatch. `--codex-only` adds `--no-grok`, preserving its literal Codex-only meaning. `--grok` is selectable only on enabled platforms (`linux/x64` in this release) when the plugin is installed from a tagged release commit that ships the containment helpers, the Grok CLI is `1.0.4` or `1.0.13`, and its launcher is a native executable. `win32/x64` ships its helper but stays refused with `platform_verification_pending` until its real-turn gate passes; macOS and every other platform stay fail-closed with `unsupported_grok_containment`. Refusals are typed: `missing_grok_containment_helper`, `grok_containment_helper_failed` (a helper that cannot establish containment on this host, or fails its `SHA256SUMS` check), `unsupported_grok_cli_version`, `incompatible_grok_cli` (including a `.cmd`/PowerShell/`#!` launcher). Compiling with `npm run build:native` in a source checkout is still not an on-switch.
- `/deep-review-loop --ultracode --codex`: ultracode once (round 1) + codex every round.
- Adaptive reviewer and automatic model routing are enabled by default for
  single reviews and loops. `--reviewer-strategy static` fixes the eligible
  set; `routing_shadow_mode: true` records but does not apply the adaptive
  plan. Use both for pre-2.0 dispatch compatibility.
- `/deep-review-loop` convergence is deterministic: each round's findings are compared with `compare-rounds` (identity matching, not a natural-language repeat judgment), and a stalled round stops with the last trusted verdict.
- The loop passes a `--prior-rounds-file` advisory context between rounds explicitly (never by file existence) so reviewers can re-verify prior findings and rejected items.
- Pure document loops use a `READY_FOR_IMPLEMENTATION` gate: low/medium scopes
  cap at two rounds, high/critical at three, and unresolved scopes stop as
  `DOCUMENT_BLOCKED`. Implementation loops retain the five-round default.
- A READY document emits a sealed content-addressed receipt under
  `.deep-review/receipts/document-readiness/`. A later implementation review
  opts in with `--readiness-receipt PATH`; stale, tampered, out-of-repo, or
  symlink receipts fail closed, and pending deferred evidence blocks APPROVE.
- The final loop summary reports rounds and reviewer calls saved, per-round
  assignment/model/effort, expansion, readiness, receipt, and stop reason.
- `--session-doc` (loop-only, opt-in) keeps one consolidated session document keyed by the loop id — current verdict, per-round history, open-vs-resolved rollup, and a final post-stop summary — while per-round reports and their fail-closed accounting stay untouched.
- `--dry-run` / `--explain-routing` (review-only) print the artifact classification, capability-aware routing plan, and provenance, then stop before any reviewer.
- `--routing <auto|fast|balanced|quality>` selects a routing policy. Repeated `--model <provider>=<model>` / `--effort <provider>=<effort>` set provider overrides; repeated `--reviewer-model <reviewer>=<model>` / `--reviewer-effort <reviewer>=<effort>` set canonical reviewer overrides.
- `--allow-fallback` permits one visible retry when a leaf runtime explicitly rejects the requested model or effort. Authentication failures, timeouts, empty output, ambiguous errors, and generic failures never retry; without authorization, explicit rejection fails closed.
- `--no-fallback` explicitly disables fallback even when project or user policy enables it; it conflicts with `--allow-fallback`.
- `--allow-classifier` lets dry-run/explain use semantic classification for ambiguous artifacts. Bounded artifact content is treated as untrusted data and sent through stdin; secret-like content is never sent and falls back to deterministic classification.
- `--no-*`, `--codex`, `--codex-only`, and `--ultracode` are hard
  eligibility/required-assignment constraints. Reviewer-level overrides require
  that reviewer; provider-level overrides apply only to selected reviewers.

Teams can share routing policy in `.deep-review/review-policy.yaml`. If the project currently ignores `.deep-review/`, replace that directory rule with the following two rules; Git cannot re-include a file beneath a wholly ignored directory:

```yaml
schema_version: 2
features:
  adaptive_reviewer_routing: true
  automatic_model_routing: true
  routing_shadow_mode: false
routing:
  reviewer_strategy: adaptive
  document_round_limit: 2
  high_risk_document_round_limit: 3
  maximum_reviewers: 4
  max_expansion_waves: 1
```

```gitignore
.deep-review/*
!.deep-review/review-policy.yaml
```

## Review pipeline

deep-review runs a 4-stage pipeline on every invocation, with an optional Stage 5 for responding to findings:

```
Stage 1: Collect      — Detect environment, gather diff
Stage 2: Contract     — Load Sprint Contract if present
Stage 3: Deep Review  — Adaptively assign independent reviewer roles (one optional expansion)
Stage 4: Verdict      — Synthesize once; emit verdict and optional document readiness
Stage 5: Respond      — Evidence-based response to findings (via --respond)
```

### Stage 1: Collect

Environment detection determines the git state and collects the matching diff:

- `non-git` — ask the user which files to review
- `initial` (zero commits) — review all files against the empty tree
- `clean` — `git diff {review_base}..HEAD`
- `staged` — `git diff --cached`
- `unstaged` — `git diff`
- `mixed` — `git diff HEAD`
- `untracked-only` — read untracked files directly

Excluded from the diff: binaries, `vendor/`, `node_modules/`, `dist/`, `build/`, `.next/`, `target/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `.git/`, `*.min.js`, `*.generated.*`, `*.lock`, `.DS_Store`.

### Stage 2: Contract check

- `--contract SLICE-NNN` — load only `.deep-review/contracts/SLICE-NNN.yaml` (must be `status: active`)
- `--contract` — load all `status: active` contracts
- No flag — active contracts in `.deep-review/contracts/` load automatically; archived contracts are excluded
- Malformed YAML — the contract is skipped with a warning

Each criterion is verified against the actual code changes.

### Stage 3: Deep Review

Claude Code uses an independent named `code-reviewer` agent when that capability is available and otherwise uses the native Node Claude bridge. Its `codex-review` and `codex-adversarial` roles run through generic `codex exec` with an ephemeral session, a read-only sandbox, isolated configuration, and route-specific model/effort. On Codex, both roles run as separate history-free native subagents with the same route-specific inputs. A detected Claude CLI may supply a separate Claude-family voice. Before dispatch, you are told which reviewers will run. Every reviewer receives only the shared payload — never the originating session context — and evaluates 6 criteria:

| # | Criterion | Checks |
|---|---|---|
| 1 | Correctness | Logic bugs, edge cases, error handling |
| 2 | Architecture fit | `rules.yaml` violations, layer boundaries, dependency direction |
| 3 | Entropy | Duplicate code, pattern drift, ad-hoc helpers |
| 4 | Test coverage | Coverage relative to changes, missing scenarios |
| 5 | Readability | Will the next agent understand this on first read? |
| 6 | Security | Input validation, authz bypass, injection (incl. prompt injection), secret exposure, unsafe ops |

The shared reviewer payload — used by the Opus reviewer, ultracode shards, agy, and Grok — includes:

- **`change_files` manifest** — a NUL-safe, capped cross-file manifest (rename/copy detection, dirty-state untracked union) so reviewers see the whole changeset, not just one diff; the diff itself is ordered last for instruction-attention. It honors the same Stage 1 exclusions as the diff. Binary-classified text-extension paths stay as `is_binary` + `binary_suspect_reason` rows; every other binary omission is accounted for by a cap-exempt `binary_omitted` trailer and a builder warning. Binary *content* is never included.
- **FP-suppression doctrine** — a false-positive-suppression doctrine plus a conservative-balance counterweight, single-sourced from `review-criteria.md` and injected into the Opus prompt, ultracode shards, and the agy and Grok payloads. Both Codex reviewer payloads are intentionally excluded, preserving their aggression.

### Stage 4: Verdict

| Finding | Verdict |
|---|---|
| Any 🔴 Critical | `REQUEST_CHANGES` |
| 🟡 Warnings, all reviewers agree | `REQUEST_CHANGES` |
| 🟡 Warnings, split opinion | `CONCERN` |
| All pass | `APPROVE` |

The report is saved to `.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md`.

## Cross-model verification

When multiple reviewer roles are available, deep-review synthesizes their trusted results by confidence level. Native Codex reviewer dispatch is serial and trust-gated: capture the pre-review fingerprint, run one reviewer, capture the post-review fingerprint, make the trust decision, and only then run the next reviewer. A mutation stops the round before any sibling reviewer, response, or commit:

```
     Claude Opus     →     codex:review     →     codex:adversarial
    (Independent)          (Standard)              (Adversarial)
          │                     │                        │
          └──── fingerprint + trust gate after each ─────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   Synthesis by         │
                    │   Confidence Level     │
                    │                        │
                    │  All agree  → 🔴 High  │
                    │  2/3 agree  → 🟡 Med   │
                    │  1/3 only   → ℹ️ Note  │
                    │  All pass   → 🟢       │
                    └────────────────────────┘
```

The opt-in `agy` (Google Antigravity) CLI can join as a cross-vendor-family reviewer. The opt-in Grok CLI contributes a separate xAI-family vote only after its external privacy preflight; detection or a no-flag review alone never sends it repository content. If no Codex reviewer role is available, deep-review notifies once and continues with the available roles unless Codex was explicitly required. A failed or unavailable required role is fail-closed; an ordinary failed reviewer is recorded as not performed and excluded from `N_actual`, never silently replaced by the legacy companion.

For `staged`, `unstaged`, and `mixed` states, deep-review offers to create a WIP commit so cross-model verification can run against a real commit base. The prompt previews the file list, warns about sensitive patterns, and never uses `git add -A`; undo with `git reset --soft HEAD~1`. Shallow clones are detected with a `git fetch --unshallow` recommendation.

## Receiving review (Stage 5)

When Stage 4 returns `REQUEST_CHANGES`, deep-review offers an evidence-based response (`/deep-review --respond`) or manual handling. The `--respond` flag activates a 6-phase protocol:

| Phase | Action |
|---|---|
| READ | Read all feedback items without reacting |
| UNDERSTAND | Restate each requirement technically |
| VERIFY | Cross-check against the codebase (files, grep, tests, blame) |
| EVALUATE | Judge by source trust level — accept / reject / defer |
| RESPOND | Accept with a fix or reject with evidence |
| IMPLEMENT | Apply fixes by severity priority, committed per severity group |

Each source has a default trust level that sets the verification bar:

| Source | Default trust |
|---|---|
| Human (user) | High |
| deep-review Opus | Medium |
| Codex review | Medium |
| Codex adversarial | Low |
| PR comment (external) | Low |

`/deep-review --respond --source=pr` collects GitHub PR comments via `gh api` and applies the same protocol — inline comments get threaded replies, general comments get issue-level replies. Each session produces a report at `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md` documenting every decision with evidence.

## Sprint Contract

A Sprint Contract defines the success criteria for a feature slice; deep-review verifies each criterion against the actual code, not the intent. Contracts live in `.deep-review/contracts/SLICE-NNN.yaml`:

```yaml
slice: SLICE-001
title: "JWT Authentication"
status: active
criteria:
  - id: C1
    description: "Token expiry is validated on every protected route"
    verification: auto       # auto | manual | mixed
    status: null             # filled by Evaluator: PASS | FAIL | PARTIAL | SKIP
    evidence: null           # filled by Evaluator
```

- `verification: auto` — the Evaluator reads the code and determines pass/fail.
- `verification: manual` — skipped automatically, flagged as "requires manual confirmation."
- `verification: mixed` — auto-verifiable parts are checked; the rest are skipped.

## Configuration

deep-review reads several files under `.deep-review/`:

- **`rules.yaml`** (inferential) — project-specific review rules generated by `/deep-review init`; the LLM reads and applies them. Without it, generic best-practice criteria are used.
- **`fitness.json`** (computational) — architecture fitness rules created and verified by the deep-work Health Engine; when present, they are injected into the reviewer prompt for architecture-intent-aware review.
- **`config.yaml`** — runtime state (review model, Codex/agy notification flags, agy/Grok privacy acknowledgements and fingerprint modes), auto-created on first run and updated one field at a time so manual edits survive.
- **`recurring-findings.json`** — after each review, recurring patterns are classified into a 7-category taxonomy (`error-handling`, `naming-convention`, `type-safety`, `test-coverage`, `security`, `performance`, `architecture`) and emitted as an M3 cross-plugin envelope, consumed by deep-evolve to steer experiment direction.

**Team sharing**: `rules.yaml`, `contracts/`, and `journeys/` encode project knowledge and should be committed; `config.yaml`, `reports/`, `responses/`, `entropy-log.jsonl`, and `recurring-findings.json` are per-machine runtime state. `/deep-review init` configures your `.gitignore` to enforce this split.

`review_model` accepts any non-empty installed Claude model alias and forwards it unchanged; for example, `review_model: fable`.

## PRACTICAL DOCUMENT POLICY

Pure-document review uses a trusted artifact phase and risk in every reviewer
assignment. Document blockers are limited to a concrete repository/artifact-grounded
functional contradiction; implementation infeasibility or a missing decision
that prevents execution; reachable
safety/security/compatibility/migration/recovery/rollback harm; or acceptance
criteria incapable of objective verification.

Style, readability, naming, preference, and ungrounded speculation are
advisory/info or suppressed, not Warning/Critical pre-implementation blockers.
Missing future implementation/tests are implementation_verification evidence
with objective acceptance evidence, not document blockers. Document finding-only
disagreement does not add a same-round reviewer; operational floors remain.

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

Artifact Gate readiness owns the final document verdict: `DOCUMENT_BLOCKED` =>
`REQUEST_CHANGES`; `READY_FOR_IMPLEMENTATION` with deferred findings =>
`CONCERN`; and `READY_FOR_IMPLEMENTATION` with no deferred findings =>
`APPROVE`, across both modes. Readiness stays the final verdict authority; the
implementation phase retains normal code review, not this document policy.

## Links

- [Changelog](./CHANGELOG.md)
- [deep-suite](https://github.com/Sungmin-Cho/deep-suite) — the marketplace and sibling plugins
- [Contributing](./CONTRIBUTING.md) · [Security policy](./SECURITY.md)

## License

[MIT](./LICENSE)
