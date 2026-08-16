# Changelog

**English** | [한국어](./CHANGELOG.ko.md)

All notable changes to deep-review are documented here. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Design review readiness modes** — design documents and ADRs now review implementation feasibility and design soundness, while executable plans retain practical full readiness. Neither mode treats prose completeness as blocking, and both hosts receive the same validated inline-route policy.

## [2.5.0] — 2026-08-17

### Added

- **Suite model-router resolver overlay.** After local role, rubric, wave, and admission, an opt-in suite overlay may change the concrete model id, native effort, same-family fallback, and provenance. It must not change seats, families, rubrics, admission, or the critical floor. Enable via `suiteResolve` inject or `features.suite_model_resolver: true`. Explicit CLI model and `automatic_model_routing: false` skip the overlay.

## [2.4.0] — 2026-08-02

### Security

- **Reviewer leaf adapters no longer read the routing plan from a file.** Each of the four consumers — the payload builder and the three reviewer bridges — only ever reduced the plan to its own route, so that route now travels inline as `--execution-route-json`. The plan file was a repository-internal path (`.deep-review/tmp/routing-plan.json`) that a repository under analysis could commit, and `loadExecutionPlan` read it with no provenance check; it is now an audit copy that no adapter reads. The inline entry point pins `protocol_version` to `3.0` rather than branching on it, because a `2.0` route would otherwise derive `assignment_role: standard` with no error and skip rubric validation, putting the wrong rubric text into the trusted assignment header.
- Consumer-boundary validation shrinks deliberately: candidate-set membership, provider/adapter agreement, the `max_expansion_waves` gate, the wave/required cross-checks, and the `maximum_reviewers` cap have no single-route analogue and stay enforced at the synthesis boundary, which still receives the whole plan. The synthesis boundary itself still trusts the plan object the orchestrator serializes — that is unchanged and out of scope here.

## [2.3.0] — 2026-08-01

### Changed

- **Practical document policy** — trusted protocol 3 document assignments now include artifact phase and risk plus one role/provider-independent policy. Concrete repository/artifact-grounded contradictions, blocked implementation decisions, reachable safety/security/compatibility/rollback harm, and objectively unverifiable acceptance criteria remain blockers; style, readability, naming, preference, speculation, and future implementation/tests are advisory or deferred implementation-verification evidence.
- **Readiness-owned document verdict** — `DOCUMENT_BLOCKED` maps to `REQUEST_CHANGES`, ready documents with deferred evidence map to `CONCERN`, and ready documents without deferred findings map to `APPROVE`. The verdict is recomputed from sealed Artifact Gate evidence and is not added to the receipt schema.
- **Document convergence** — finding-only same-round disagreement no longer expands a pure document review; reviewer minimum/floor and readiness-mismatch expansion remain fail-closed, and implementation behavior is unchanged.

## [2.2.0] — 2026-07-28

### Changed

- **`agy` is now opt-in.** A detected `agy` CLI is no longer elected into the default reviewer set; `--agy` enables it and mirrors `--codex` by both permitting candidacy and requiring selection. An agy-targeting model or effort override restores candidacy without forcing selection, so existing invocations keep working.
- **Default reviewer count drops from 4 to 3.** Verdict rules are unchanged (`N_actual`-driven), but the redundancy margin for the critical-implementation floor falls from 1 to 0: a single failed reviewer now reaches `no_unused_candidate` and then `critical_reviewer_floor` with no verdict. This is fail-closed and intentional; add `--agy` when that margin is needed.
- **`--no-opus` and `--no-opus --no-codex` change.** The former now yields Codex-only routes (a single provider family, which caps `APPROVE` at `CONCERN`); the latter has no candidate left. Add `--agy` to restore either.
- The config key `agy_enabled` is documented as inert. It never had a code consumer; the enforceable disable is `--no-agy`.

### Fixed

- **A Codex reviewer's completed report is no longer discarded when only the diagnostic capture overflows.** `run-codex-reviewer.mjs` treated `captureOverflow` as a terminal failure, but that flag truncates only the stdout/stderr diagnostic buffers and never signals the child (`lib/process.mjs` `appendCaptured`). The canonical report is written to `--output-last-message` and read from disk, so a verbose reasoning trace on stderr could exhaust the shared capture budget and throw away a complete, contract-valid report — observed three times in a row in a single review loop. Overflow stays recorded in attempt provenance, an overflow with no readable report still fails closed, and a truncated stderr still suppresses model/effort fallback retries.

### Security

- Reviewer opt-in for `agy` is transported through argv only, so a repository-committed config file cannot elect it on the default routing path. This is **not** a security boundary for a repository that commits `review-policy.yaml` to disable automatic routing — that path is unchanged and is tracked separately.

## [2.1.0] — 2026-07-26

### Added

- **Route-level Codex controls** — both Codex reviewer roles now receive the selected model and reasoning effort on Claude Code and Codex.

### Changed

- **Host-native Codex transport** — Claude Code runs both Codex roles through isolated, ephemeral, read-only `codex exec` sessions, while Codex runs both as independent history-free native subagents.
- **Codex-only static gates** — an explicit non-critical `--codex-only --reviewer-strategy static` route can satisfy its one-family constraint with both Codex voices without weakening critical reviewer-family floors.

### Removed

- **Companion-backed review routing** — Codex companion detection remains compatible for 2.x environments but no longer selects, executes, or replaces a reviewer role.

### Security

- Codex CLI reports come only from bounded non-symlink last-message files; ambient user configuration and rules are excluded, runtime model/effort rejection retries require explicit fallback authorization, and authentication, timeout, empty, ambiguous, or generic failures never retry.

## [2.0.0] — 2026-07-24

### Added

- **Adaptive reviewer routing** — single reviews and loops deterministically select role-fit `standard`, `feasibility`, `traceability`, `adversarial`, `security`, or `confirmation` assignments while preserving canonical reviewer identities. Protocol `3.0` plans bind assignment rubric, wave, required status, model/effort, reason, full candidates, reviewer floors, artifact phase, risk, and progress.
- **Progressive expansion** — provisional synthesis may add exactly one unused independent reviewer for a failed minimum, lone critical/security finding, split concern, or readiness mismatch, then emits one final verdict from all trusted attempts.
- **Trusted synthesis boundary** — the public synthesis CLI revalidates raw report and fingerprint evidence for every attempt; adaptive floor failures are atomically replaced once, while explicit required-reviewer failures remain operational errors.
- **Content-addressed readiness authority** — receipt filenames bind both the document scope and full sealed authority, so in-place self-resealing cannot lower risk, remove reviewer evidence, or discard deferred findings.
- **Fail-closed plan admission** — synthesis rejects pre-failed routing plans and voices without selected routes, while policy parsing rejects malformed or non-canonical classification overrides.
- **Document readiness** — pure design/spec/plan/ADR/test-plan reviews use `READY_FOR_IMPLEMENTATION` independently of verdict, produce a sealed content-addressed receipt, and stop as `DOCUMENT_BLOCKED` at the document round cap.
- **Receipt-linked implementation review** — `--readiness-receipt PATH` verifies repository/path containment and current document/report hashes, then prevents APPROVE until every deferred acceptance item has fresh implementation evidence.
- **Shared loop routing grammar** — loop accepts reviewer strategy, routing, model/effort, fallback/classifier, and receipt flags on every round; round-state schema 2 and session summaries record assignments, waves, saved calls, readiness, receipt, and stop reason.

### Changed

- Adaptive reviewer and automatic model routing are enabled by default. `--reviewer-strategy static` fixes the eligible reviewer set, while `routing_shadow_mode: true` observes without applying; use both for exact pre-2.0 dispatch compatibility.
- Risk is monotonic across `low|medium|high|critical`. Pure documents default to 2 rounds (3 for high/critical); implementation remains 5 unless explicit `--max` overrides it.
- Implementation reviewer floors are higher: low/medium plans two cross-provider roles, high plans three specialized roles with a confidence floor on shortage, and critical requires three trusted reviewers across two provider families or fails without a verdict.
- Adaptive route loss uses the documented confidence floor once actual reviewer/provider minima remain satisfied; only explicit reviewer/provider requirements remain identity-hard.
- A required same-round replacement that fails after the sole expansion wave is identity-hard and terminates without a verdict or Phase 6.

### Security

- Readiness receipts reject stale/tampered content, symlinks, and repository/path escape with `ERROR_READINESS_RECEIPT_STALE`; fingerprint mutation exclusion, `N_actual=0`, mutation ownership, and Phase 6 gates remain fail-closed.
- Capability cache reads and writes reject symlinked path components, and companion-backed Codex reviewer identities expose only the assignment roles their fixed invocations actually transport.
- Privacy preflight runs only after adaptive selection chooses agy; a selected-but-declined agy route is replanned at most once.

## [1.15.0] — 2026-07-21

### Added

- **Semantic artifact classifier** — ambiguous text artifacts can opt into bounded semantic classification, with deterministic classification retained as the fallback.
- **Reviewer capability registry** — protocol `2.0` adapter contracts describe current availability, model and effort support, read-only enforcement, and invocation transport without treating the host label as capability.
- **Model/effort routing** — artifact kind, risk, size, and reviewer role produce a validated per-reviewer execution plan whose model identifiers come from policy, user configuration, or adapter aliases.
- **Routing overrides** — review-only `--routing`, provider model/effort, reviewer model/effort, `--allow-fallback`, and `--allow-classifier` flags flow through normalized structured plans.
- **`review-policy.yaml`** — teams can share nested artifact classification and routing policy at `.deep-review/review-policy.yaml` while user configuration remains separately mergeable.

### Changed

- No-flag dispatch arguments remain byte-identical; automatic routes are shadow-first and become active only through an explicit CLI override or project policy opt-in.

### Security

- Artifact content is untrusted, bounded, and transported with argv arrays plus stdin; secret-like content fails closed before any semantic classifier invocation.

## [1.14.0] — 2026-07-20

### Added

- **deep-review-loop convergence** — round-to-round finding state is recorded and compared deterministically, replacing a natural-language repeat judgment; a stalled round with no implemented change stops with the last trusted verdict instead of cycling further. A loop-bound, explicitly-flagged `--prior-rounds-file` advisory context (never keyed on file existence) lets each round's reviewers re-verify prior findings and rejected items without re-litigating them from scratch. The final loop summary reports a `rounds_saved` metric.
- **`--session-doc` (loop, opt-in)** — one consolidated review document per loop session, keyed by the loop id and re-rendered in place after each round with the current verdict, per-round history, an open-vs-resolved rollup that tracks line drift, and a final post-stop summary; per-round reports and their fail-closed accounting are unchanged, and the aggregate is excluded from every canonical report discovery surface (response selection and recurring-findings export included).
- **Artifact-aware routing, Phase 1** — `--dry-run` / `--explain-routing` (review-only, opt-in) deterministically classify review targets (code, design document, implementation plan, specification, ADR, test plan, runbook, config, mixed) with confidence scoring and provenance, then stop before any reviewer runs; no-flag behavior is byte-identical. Semantic classification and model/effort routing are planned for a later phase.

### Fixed

- Round-state cleanup in the loop now binds ownership to the durable host session instead of a transient shell process, so a live-but-idle concurrent loop's state is never deleted while crashed residue is still reclaimed; partial cleanup failures stay retryable.
- Multi-range finding citations (`path:1-2, 83-100`) are parsed instead of dropped, and `findings_signature` agrees between round recording and metrics on the same repo-root basis.
- `findings_signature` is platform-independent and case-preserving on Windows; win32 case-insensitive identity matching is unchanged.

### Security

- Artifact discovery never follows symlinks or reads outside the repository: symlinks are metadata-only, resolved paths must stay inside the repo root, and reads are no-follow with post-open verification — a committed symlink can no longer expose out-of-repo file content.

## [1.13.0] — 2026-07-11

### Added

- Native Codex review/respond skills and host-aware reviewer and Phase 6 subagent dispatch now provide the public workflows on both Claude Code and Codex.

### Changed

- Supported review, loop, mutation, reviewer bridges, Stage 5.5 recurring export, and response verification now run on the zero-dependency Node 22 runtime across macOS, Linux, and Windows 11.

### Fixed

- Codex default-hook validation, cross-process mutation recovery, Stage 5.5 zsh shopt noise, Windows path and timeout behavior, and fail-closed reviewer mutation handling.

## [1.12.3] — 2026-07-07

### Fixed

- **N=1 verdict rule inlined into the Stage-4 synthesis SSOT (#3)** — the Stage-4 execution block in `review-execution.md` §5.1 now carries the `N_actual == 1` branch inline (`1건 이상 → 🟡 CONCERN + "단일 리뷰어" 표기 / 0건 → 🟢 APPROVE + 표기`) and gates the "단독 지적 → 참고" demotion to `N_actual ≥ 3` only (with an explicit `N_actual == 2` branch mapping 1/2 → CONCERN, matching the codex-integration N-way table; only a 3+-way review demotes a lone finding to info). Previously a 1-way review (e.g. `--codex-only`) read literally could demote every finding to info and emit a hollow APPROVE, contradicting the correct N=1 row that already lived in `codex-integration.md`. `codex-integration.md` now carries an SSOT-alignment note so the two files stay in lockstep. The verdict-decision block itself now gates the "🟡만, 전원 일치 → REQUEST_CHANGES" rule to `N_actual ≥ 2` and adds an explicit `N_actual == 1` exception marking the N=1 branch **final** (a single reviewer's 1 finding is trivially "unanimous", so without the gate a 1-way CONCERN would be silently escalated to REQUEST_CHANGES, nullifying the N=1 branch); mirrored in `report-format.md`'s verdict-rule list and pinned by `test-verdict-synthesis-ssot.sh`. N≥2 (2/3/4-way) mappings are otherwise unchanged. **Behavior:** at N=1 a 🔴 (critical/security) finding now yields REQUEST_CHANGES (single-reviewer note kept) instead of being demoted to CONCERN — a lone reviewer's critical is blocking, consistent with the general "🔴 → REQUEST_CHANGES" rule and the `review-criteria.md` severity principle; only a 🟡-only N=1 review stays CONCERN. The `codex-integration.md` N=1 table (the mapping SSOT) splits its `1/1` row into 🔴/🟡 rows accordingly.
- **codex-only excluded from the opus-degraded guard (#3-derived)** — the Stage 4.3.1 degraded marker (`review-execution.md` §4.3.1 and `report-format.md`) now reads `claude_reviewer != none AND opus_status != success AND N_actual_external ≤ 1`, so a planned 1-way `--codex-only`/`--no-opus` run (where Opus is never spawned, `opus_status = not_planned`) is no longer force-degraded to CONCERN. Added an `opus_status` domain sentinel note documenting `not_planned`. **Floor semantics (R4):** the degraded guard is now a confidence *floor*, not an overwrite — a 🔴/critical finding keeps REQUEST_CHANGES (degraded marker attached, no downgrade) and only APPROVE is raised to CONCERN. Previously it force-set CONCERN, which could fail-open a blocking verdict when Opus timed out but Codex flagged a critical.
- **`restore_attempts` 3-strikes escalation made reachable (#1)** — `restore_mutation` now re-checks each restored intent-to-add entry after `git rm --cached --ignore-unmatch` (which always exits 0) and, if a protocol-created entry survived, preserves the state file and returns non-zero (lock still released). This lets `auto_recover`'s `restore_attempts` counter accumulate across sessions so the advertised "escalates after 3 failures" path is actually reached instead of being write-only dead. Normal restore paths are unchanged. **(R4)** The `git rm` pipeline itself is now errexit-safe: a genuine (non-`--ignore-unmatch`) `git rm` failure is captured explicitly (`if ! … ; then`) instead of aborting the function mid-way under an errexit caller — on failure it preserves state, releases the lock, and returns non-zero (joining the same escalation path), so the lock/state can no longer be left half-recovered.

### Internal

- **CI test-enrollment drift guard (#2)** — enrolled the previously orphaned `test-extract-anchor.sh` in `tests.yml`, and added `scripts/check-test-ci-enrollment.sh` (+ unit test) as a CI gate that fails when any `hooks/scripts/test/test-*.sh` is not invoked by a workflow `run:` step or `npm test`. `tests.yml` `pull_request.paths` widened to `.github/workflows/**` so the guard also triggers on other workflow edits. The enrollment corpus now counts only package.json scripts actually reached from a workflow `run:` step (`npm test` → `scripts.test`, `npm run <name>` → `scripts.<name>`), so a test mentioned solely in an unreachable script (e.g. `test:all` / `test:local`) is no longer a false-pass. Separately, `phase6-protocol.yml`'s `paths` filter now includes `skills/deep-review-workflow/**` so a PR touching `init-setup.md` (read by `test-phase6-subagent.sh`) actually triggers the phase6 suite — pinned by that test's new check 12. The enrollment guard's header documents its scope limit: it verifies *enrollment* (which workflow runs a test), not *trigger-path coverage* (whether that workflow fires on the sources a test reads); a general trigger-coverage verifier is intentionally out of scope.
- **`.gitignore` hardening** — ignore `.claude/` runtime state (hook I/O + sensor cache) so a dogfooding `git add -A` cannot leak a session transcript into the public source repo.

## [1.12.2] — 2026-06-23

### Changed

- **thin-dispatcher Phase B (internal refactor, behavior-preserving)** — extracted the review-mode body from `commands/deep-review.md` into on-demand reference files (`skills/deep-review-workflow/references/review-execution.md`, `skills/deep-review-workflow/references/recurring-findings-export.md` for Stage 5.5, and `skills/deep-review-workflow/references/entropy-scan.md` for `--entropy`). The command is now a route-first thin router (~53 lines): `init` / `--respond` / `--qa` paths no longer load the `deep-review-workflow` skill (reduced context load on non-review invocations). Line-number SSOT anchors (`:172` / `:505-508` / `:478-485`) converted to named `<!-- SSOT:name -->` HTML-comment anchors extracted and validated by shared `extract_anchor` / `assert_anchor_singleton` test helpers. SKILL split-brain resolved (execution SSOT = `review-execution.md`). **Behavior / flags / verdict unchanged.**

## [1.12.1] — 2026-06-23

### Changed

- **thin-dispatcher Phase A (internal refactor, behavior-preserving)** — extracted the `--respond` and `init` mode bodies out of the 1628-line `commands/deep-review.md` into on-demand reference files (`skills/receiving-review/references/respond-execution.md`, `skills/deep-review-workflow/references/init-setup.md`), leaving in-place dispatch stubs. The command shrinks 1628 → 1136 lines; the `--respond` / `init` procedures now load only when those modes run, lightening the common review path. The review-mode region (command lines 1–1122, holding the `:172` diff-exclusion and `:505-508` claude-bridge line-number anchors) is byte-identical — no behavior change. Added `scripts/run-all-tests.sh` (`npm run test:all`) as the single structural-suite gate (npm tests + every `hooks/scripts/test/test-*.sh` except `test-helpers.sh`). Route-first top-router restructure, review-mode extraction, and line-anchor de-anchoring are deferred to Phase B.

## [1.12.0] — 2026-06-22

### Added

- **FP-suppression doctrine injection (#2)** — `extract-fp-doctrine.sh` extracts `fp-doctrine` + `fp-conservative` blocks (via strict HTML-comment markers with per-block validation, fail-closed) from a single-source doctrine file and injects them into the Opus reviewer prompt, all ultracode shards, and the agy payload via `build-reviewer-payload.sh`. Conservative-balance counterweight is always co-injected alongside suppression rules. Adversarial reviewer is intentionally excluded.
- **`change_files` cross-file manifest (#3)** — `build-change-files.sh` builds a NUL-safe, state-aware cross-file manifest with rename/copy detection (`-M -C`), untracked-file union, initial-commit handling, and per-file path JSON-encoding via `python3 -c`. Capped at 200 entries. The manifest is appended to the shared reviewer payload (diff-last instruction-attention ordering) via `build-reviewer-payload.sh`.

### Changed

- `build-reviewer-payload.sh` assembles the ordered payload consumed by all Claude and agy reviewers: doctrine block → context → change_files manifest → diff (last, for instruction-attention priority).
- `commands/deep-review.md` wires `extract-fp-doctrine.sh` + `build-change-files.sh` + `build-reviewer-payload.sh` for every reviewer path; Strict-Focus guard blocks direct diff injection when the payload builder is available.
- ultracode shards inherit doctrine + change_files from the shared payload (Task 5); `skills/deep-review-workflow/references/report-format.md` adds Warnings for oversized / missing `change_files`.

### Deferred

- Falsifiability gate (#1) deferred — requires `diff_integrity` + stable finding IDs + receiving-review/recurring/loop constraints before it can ship safely (see spec §9.1).

## [1.11.0] — 2026-06-16

### Added

- **Security review lens (6th criterion)** — `review-criteria.md` adds a Security lens (input validation, authz bypass, injection incl. prompt injection, secret exposure, unsafe ops), mapping 1:1 to the recurring-findings `security` taxonomy. ultracode shards go 5→6 and the quorum is formalized to `floor(n/2)+1` (=4).
- **Severity rubric** — severity = impact × reachability, with a conservative default: do not downgrade when reachability is unprovable from the diff.
- **Anti-criteria** — suppression rules (pre-existing issues, lint-autofixable style, unsubstantiated speculation, pure preference) to cut review noise.

## [1.10.0] — 2026-06-09

### Added

- **Composable reviewer flags** — `/deep-review` and `/deep-review-loop` now accept `--ultracode` (multi-agent Claude fan-out, 5-dimension shards collapsed into one "Claude(ultracode)" voice), `--codex` (force Codex 2-way), `--no-codex` / `--no-opus` / `--no-agy`, and sugar `--codex-only` (= `--codex --no-opus --no-agy`). No-flag behavior is 100% unchanged.
- **Hybrid fan-out** — when Claude Code + Workflow tool is available, `--ultracode` uses the `Workflow` tool (dimension fan-out + adversarial verify); other runtimes fall back to parallel `run-claude-reviewer.sh` bridge agents. New `skills/deep-review-workflow/references/ultracode-integration.md` is the single source of truth for the collapse algorithm.
- **deep-review-loop integrated cadence** — `--ultracode --codex` loop runs ultracode once (round 1) + codex every round. `--codex-only` supports an external-ultracode + codex-loop split role. 2-tier forwarding spec + `ultracode_consumed`-based codex-down branch.

### Changed

- Phase 6 `source` enum extended with `Opus (ultracode)` / `opus-ultracode`.
- Review Mode labels expanded (ultracode / agy-only / fallback variants); `opus_status` fan-out collapse rule — disjoint quorum bands (failed=0, partial=1–2, success≥3; degraded marker fires below quorum).
- findings_signature line bucket unified to fixed bucket `floor(line/7)` for deterministic stagnation detection.

### Security

- `--no-agy` now short-circuits Stage 3.5 sensitive-file ack gate — when agy is excluded, no sensitive-file scan prompt is shown and `agy_sensitive_acked_fingerprint` is not modified.

### Deferred / Known limitations

- ARCH-6 (path-B verify-equivalence label), ARCH-8 (non-Claude serial-bridge partial-failure budget), SEC-3 (token-cost guardrail: Y/N prompt + verify panel top-K cap) are tracked for a follow-up release.

## [1.9.0] — 2026-06-04 (agy model tier + faster hybrid fingerprint)

### Added

- agy reviewer model tier is now configurable via `agy_model` in `.deep-review/config.yaml` (or the `AGY_MODEL` env var), defaulting to `Gemini 3.5 Flash (High)` — a faster tier for the bounded read task of review. An unsupported value falls back to agy's default tier.

### Fixed

- agy's `hybrid` fingerprint mode is now sub-second (previously it added several seconds of redundant local work to every review), so it stays the default without slowing the pipeline.

## [1.8.1] — 2026-05-25 (agy read-only enforcement)

### Fixed

- The agy reviewer could apply Edit/Write fixes to the workspace *during* Stage 3 review instead of only at the Stage 4 synthesis. The agy bridge now prepends a strict read-only preamble (ASCII-only, locale-safe) forbidding file/git/state mutation; any mutation still trips the pre/post worktree fingerprint and excludes agy from N-way synthesis.

### Changed

- agy prompt body limit lowered from 200 KB to 198 KB to reserve argv headroom for the read-only preamble.

## [1.8.0] — 2026-05-22 (symlink and directory-name coverage)

### Added

- Sidecar `sensitive-patterns-dir-match.list` lets selected sensitive patterns opt into directory-name matching (`credentials*`, `bearer_*` enabled by default).
- Symlink-aware worktree fingerprinting shared across sensitive scans, runtime-state snapshots, and full-walk mode.

### Fixed

- Pre-existing runtime-state symlinks (`config.yaml`, `.pending-mutation.json`) pointing at in-repo files ≤ 16 KB are now snapshotted, so writes through the symlink are detected.
- Full-walk and hybrid sensitive scans now enumerate symlinks alongside regular files.
- Symlink resolution is capped at 40 links and fails with a clear cycle message instead of hanging.

## [1.7.2] — 2026-05-22 (hybrid coverage gaps)

### Fixed

- Hybrid-mode sensitive scan now detects gitignored secrets whose token appears only in a directory name (e.g. `./secrets/config.json`) for bilateral-wildcard patterns.
- Hybrid mode now hashes `.deep-review/config.yaml` and `.deep-review/.pending-mutation.json`, so agy mutations to its own bridge config/lock state are detected.

## [1.7.1] — 2026-05-22 (agy fingerprint hybrid mode)

### Changed

- Default agy fingerprint mode changes from `full-walk` to `hybrid` (`git status` + per-dirty-file SHA-256 + a focused sensitive-pattern scan), ~100× faster on large repos. Restore the old behavior with `agy_fingerprint_mode: full-walk` in `config.yaml` or `AGY_FINGERPRINT_MODE=full-walk`.

### Added

- `lib/sensitive-patterns.list` — shared sensitive-pattern data read by both the mutation protocol and the agy bridge.
- `agy_fingerprint_mode` config field and `AGY_FINGERPRINT_MODE` env override; modes `hybrid` | `full-walk` | `git-status` | `off`.
- `off` mode explicitly opts out of mutation detection (use only when agy is known not to mutate the worktree).

## [1.7.0] — 2026-05-20 (agy 4-way review integration)

### Added

- **Google Antigravity CLI (`agy`) as a 4th reviewer** in the cross-model pipeline — cross-vendor-family parallel with Opus + Codex review + Codex adversarial.
- 4-way verdict synthesis preserving cross-vendor dissent signal, with a pre-spawn fingerprint-based sensitive-file acknowledgment.
- `agy_notified`, `agy_enabled`, and `agy_sensitive_acked_fingerprint` config fields (auto-migrated for existing users, preserving an `agy_enabled: false` opt-out).

### Unchanged

- The Codex mutation protocol (`git add -f -N` + lock) stays codex-only; agy uses an orthogonal `--add-dir` walk.

## [1.6.1] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### Added

- `.codex-plugin/plugin.json` — Codex-native manifest pointing at the same skill and hook surfaces as the Claude Code manifest.
- `AGENTS.md` — Codex project guide covering runtime surfaces, verification, and the suite marketplace update step.

### Changed

- README now documents Codex compatibility alongside the existing Claude Code surface.

## [1.6.0] — 2026-05-16 (`/deep-review-loop` becomes a user-invocable skill)

### Changed

- `/deep-review-loop` migrates from a slash command to a `user-invocable: true` skill, so it can be invoked from Codex CLI, Copilot CLI, Gemini CLI, and the Agent SDK via `Skill({ skill: "deep-review:deep-review-loop" })`. The `/deep-review-loop` slash entry keeps working in Claude Code; loop behavior is unchanged.

## [1.5.1] — 2026-05-13 (skill-doc cleanup)

### Fixed

- Resolved documentation drift between the skill/spec docs and the shipped artifacts (removed a non-standard agent frontmatter field, fixed dangling cross-references, single-sourced the Phase 6 group-dispatch rules). No command, hook, or runtime behavior changed.

## [1.5.0] — 2026-05-13

### Added

- **`/deep-review-loop`** — runs `/deep-review` (review) and `/deep-review --respond` (respond) back-to-back, repeating until convergence. Accepts `--contract [SLICE-NNN]` / `--entropy` (forwarded each round) plus a `--max=N` safety cap (default 5, counting Review calls). Terminates on natural convergence (`APPROVE`, no 🔴/🟡), `--max`, a stalled-findings state, accumulated operational errors, or user stop.

### Changed

- Codex per-call timeout raised 300s → 900s, removing false-positive timeouts that demoted valid 3-way reviews to 1-way on large or rate-limited diffs.
- Mutation-lock orphan window raised 600s → 1200s to stay above the new 900s per-call timeout (override with `REVIEW_TIMEOUT_SECONDS`).

## [1.4.2] — 2026-05-12 (cross-platform `stat` fix)

### Fixed

- `mutation-protocol.sh` resolved the lock mtime with BSD `stat -f %m` first, which silently misbehaves on Linux (GNU `-f` means "filesystem status") and broke lock recovery. Stat order reversed to GNU `-c %Y` first, BSD `-f %m` fallback.

## [1.4.1] — 2026-05-12

### Added

- Integration test coverage for mutation-lock stale-recovery when a leftover lock and a crashed mutation co-exist with unrelated user-staged changes (orphan detection, lock release, user-staging preservation). Test-only; no runtime change.

## [1.4.0] — 2026-05-08

### Added

- `.deep-review/recurring-findings.json` is now emitted as an M3 cross-plugin envelope, with the consumed deep-work session-receipt's `run_id` chained into `parent_run_id` for cross-plugin trace.

### Changed

- The Stage 3 receipt loader and the recurring-findings emitter are envelope-aware, with a strict producer/artifact_kind/schema identity guard; foreign or corrupt envelopes are skipped with a warning.

### Compatibility

- The wrapped payload (`findings`, `taxonomy_version`, `updated_at`) keeps the same shape. Pre-envelope consumers reading the legacy top-level `findings[]` must upgrade to envelope-aware unwrap or read `payload.findings` directly; a 6-month migration window applies.

## [1.3.4] — 2026-04-24

### Added

- Shipped the Phase 6 delegation spec as an on-demand reference (it previously lived under the blanket-ignored `docs/` and never shipped).

### Changed

- Phase 6 group commits read both staged and unstaged renames so a subagent's `git mv` cannot escape the allowlist; binary files flow through `git hash-object` for delta detection.
- Runtime warning strings unified to Korean, matching the rest of the review/response UI.

### Fixed

- Allowlist bypass via pre-dirty outside files — Phase 6 verification now snapshots content hashes for the full pre-dispatch dirty set and flags any out-of-allowlist mutation.
- Dirty recovery now restores the git index (not just the worktree) when a failed subagent used `git add` / `git mv`.
- Recovery preserves the tracked-but-deleted WIP distinction (` D` no longer becomes `D `).
- macOS bash 3.2 compatibility — replaced `declare -A` with TSV temp files across the Phase 6 snippets.

## [1.3.3] — 2026-04-24

### Added

- `phase6-implementer` subagent — dedicated Phase 6 implementation agent, auto-dispatched by `/deep-review --respond`.
- `implementation_guide.modifiable_paths` — lets the Phase 6 allowlist include companion files (tests, fixtures, helpers) needed to satisfy acceptance.

### Changed

- `/deep-review --respond` Phase 6 is delegated to the `phase6-implementer` subagent per severity group, with graceful in-session fallback on dispatch failure.
- Response report Summary gains an `execution_path` field (`subagent | main_fallback | mixed | n/a`).
- Fail-closed main verification: `files_changed` is normalized and compared via `git hash-object` content snapshots; out-of-allowlist or reverted paths route to `execution_status=error` and suppress commit/PR posting.
- Group commit uses `git commit --only` with an `:(exclude)` pathspec for non-group paths; dirty recovery restores from per-file content baselines.

## [1.3.2] — 2026-04-21

### Added

- **Codex Auto-Exposure Protocol** — `/deep-review` detects gitignored files you have been editing in the session and offers to temporarily expose them to Codex (`git add -f -N`) for cross-model review, guarded by a `mkdir`-based atomic lock and a `.pending-mutation.json` state file.
- Shared `mutation-protocol.sh` Bash library (bash 3.2 compatible, macOS + Linux tested).
- Codex auth-error detection with a dedicated "run `!codex login`" hint, and a Node.js availability probe distinguishing "plugin installed but node missing" from other failures.
- Sensitive-file scan (40+ patterns: dotenv, credentials, SSH keys, GCP service accounts, `.pgpass`, `.netrc`, `wrangler.toml`, JWT) matched case-insensitively; all-sensitive sets auto-skip.
- Graceful fallback to 1-way Opus-only review if a mutation fails, plus auto-recovery of stale mutations from crashed sessions (user's real staging preserved).

### Fixed

- Codex companion only accepts `--scope <auto|working-tree|branch>`; the previously used `--uncommitted` flag was silently rejected. All call sites corrected to `--scope working-tree`.
- Corrected the empty-tree fallback SHA used as `review_base` to the canonical git empty-tree hash.

### Changed

- 3-way review now requires only a git repo + Codex plugin (dropped the prior "has commits" requirement, so initial-commit repos get cross-model review too).

### Deprecated

- The `codex_installed` field in `detect-environment.sh` output (use `codex_plugin`); slated for removal in a later release.

## [1.3.1] — 2026-04-17

### Fixed

- Public-repo `.gitignore` now fully ignores `.deep-review/` and `docs/`; downstream users still get granular guidance from `/deep-review init`.
- WIP commit safety — removed `git add -A`; the prompt previews the file list, warns on sensitive patterns, and shows a `git reset --soft HEAD~1` undo hint.
- Adversarial focus file uses `mktemp` with `chmod 600` + cleanup, removing a `/tmp` race and symlink attack surface.
- `config.yaml` is updated via the `Edit` tool only, preserving user-modified and unknown fields.
- Report filenames gain an `{HHmmss}` timestamp, ending same-day overwrites that corrupted recurring-findings counts.
- Prompt-injection defense added to the reviewer system prompt and PR-comment ingestion; suspicious strings are flagged as security issues.

### Changed

- Portable `_timeout` shim (prefers `gtimeout`/`timeout`, falls back to `perl alarm`) so cross-model review is no longer silently downgraded to 1-way on macOS.
- Contract YAML is loaded via a `yaml.safe_load` wrapper that degrades to LLM parsing when PyYAML is absent; malformed contracts are skipped with a warning.
- Large-diff handling in Stage 3: threshold-based routing, directory-grouped sequential spawn, and size-cap warnings.
- `--respond` "most recent" is defined by mtime on the `*-review.md` glob; added a `--pr=NNN` override and idempotent retry tracking for failed PR-comment postings.

## [1.3.0] — 2026-04-16

### Added

- **Stage 5: Receiving Review** — evidence-based response protocol (READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT) that blocks blind agreement and backs every decision with code evidence.
- **`/deep-review --respond`** — enter response mode on the most recent review report or a specified path.
- **`/deep-review --respond --source=pr`** — respond to GitHub PR review comments via `gh api`, with threaded replies on inline comments.
- `receiving-review` skill — guides the protocol with a source-trust matrix, forbidden-expression blocking, and rationalization detection.
- Response Report — structured accept/reject/defer record with evidence, saved under `.deep-review/responses/`.

### Changed

- A `REQUEST_CHANGES` verdict now offers three options: evidence-based response (default), `codex:rescue` delegation, or manual handling.

## [1.2.0] — 2026-04-14

### Added

- **Stage 5.5 Recurring Findings Export** — taxonomy-based (7 categories) LLM classification records recurring patterns to `recurring-findings.json`, consumed by deep-evolve to steer experiment direction.

## [1.1.2] — 2026-04-12

### Fixed

- Codex review invocation was misrouted to `codex:rescue`; now calls the Codex companion directly via the Bash tool.
- Shell injection — `focus_text` from repo-controlled files is now passed via stdin instead of interpolated into shell commands.
- `detect-environment.sh` no longer aborts when the Codex plugin path is absent.
- Dirty-tree review mismatch — Codex and Opus now review the same changes.

### Changed

- Split Codex detection into `codex_plugin` (Claude Code plugin) and `codex_cli` (standalone CLI), with a targeted "CLI detected but plugin required" message.

## [1.1.1] — 2026-04-11

### Changed

- All reviewers (Opus subagent, Codex review, Codex adversarial) now run in the background, with reviewer composition shown before spawning and results collected via N-way synthesis on whichever reviewers completed.

## [1.1.0] — 2026-04-09

### Added

- `fitness.json` integration — Stage 3 injects computational architecture rules into the reviewer prompt for architecture-intent-aware review.
- Receipt `health_report` integration — Stage 3 discovers the latest deep-work session receipt, checks `scan_commit` for staleness, and injects drift/fitness context.
- `/deep-review init` explains inferential rules (`rules.yaml`) vs computational rules (`fitness.json`) and points to deep-work Phase 1 for auto-generation.

## [1.0.0] — 2026-04-08

### Added

- Independent Opus subagent code review.
- Codex cross-verification (`codex:review` + `codex:adversarial-review`).
- Sprint Contract consumption and verification.
- Entropy detection.
- Environment auto-detection (git / non-git, Codex presence).
- `/deep-review init` — per-project rule initialization.

### Changed

- `--contract` supports `SLICE-NNN` for slice-specific contract loading; `status: active` contracts auto-load, archived contracts are excluded.
- Review criteria aligned across command, skill, and README.

### Fixed

- Always include untracked files in review regardless of change state. *(Refined in v1.12.0: the untracked union now applies to dirty states only — `clean` is excluded.)*
- Aligned Codex synthesis rules with verdict logic (2/3 → `CONCERN`).
- Added a Codex preflight check to prevent silent degradation.
- Added shallow-clone handling, archived-contract filtering, and malformed-YAML error handling.
