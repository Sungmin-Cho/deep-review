# Grok integration

Grok is an optional independent reviewer, opt-in exactly like `agy`.
`{plugin_root}/skills/deep-review-workflow/references/review-execution.md` resolves flags
and role eligibility before this reference is used.

## Candidacy precedes every Grok-shaped side effect

`--no-grok` and a no-flag review invoke no Grok process and create no Grok
capability, carrier, or provenance state. Candidacy is true only when `--grok`
is passed, when a Grok-targeting `--model`, `--effort`, `--reviewer-model`, or
`--reviewer-effort` override restores it, or when the emitted overrides carry
`grok` in `enabled_providers`/`required_providers`. The expanded `--codex-only`
route always disables Grok.

Environment detection therefore runs *behind* flag resolution, and only the
candidate branch carries candidacy. `{plugin_root}/hooks/scripts/grok-carrier-coordinator.mjs`
owns that producer invocation and is the only thing that passes
`--grok-candidate`. Nothing else spawns the producer, and no consumer re-detects.

**Honest limitation: this ordering is a prose gate, not a code guarantee.**
Nothing in the runtime binds the instruction ordering to the CLI — the detector's
`main()` runs with whatever argv the executing agent supplies. This is the same
limitation the agy gate already carries in §3.1 of the review-execution
reference, and the Grok gate inherits it unchanged.

Both mis-orderings have to be recognisable, because they fail very differently:

- **Flag absent on a no-flag review.** Absent means *not a candidate*. That is
  the only safe default: the opposite choice would make every review in the
  repository spawn a Grok probe.
- **`--grok-candidate` forgotten on a `--grok` review.** Detection returns
  `grok_cli: false`, so no `grok-cli` candidate is emitted — while `--grok` has
  already set `required_providers: ['grok']`. The unmet hard constraint sets
  `operational_failure: true`, which fails the **entire review**: every reviewer,
  not merely the Grok one. That is loud rather than silent, which is the right
  failure direction, but an operator has to be able to name the symptom.

## Unsupported containment is the same whole-review failure

A supported Grok containment platform is known from `process.platform` and
`process.arch` *before* executable lookup. On an unsupported one the capability
is `available: false` with zero executable lookup, zero carrier creation, and
zero probe children. On such a host, `unsupported_grok_containment` is the
`operational_failure` reason a `--grok` review terminates with, and it fails the
**entire review** rather than degrading to four voices.

## Platform and helper availability

The shipped tree is a tagged release commit: it carries the `linux-x64` and
`win32-x64` containment helpers plus `SHA256SUMS`. `main` stays binary-free
(`source` polarity). Production requires the `release` polarity of the native
tree; `npm run build:native` in a source checkout is still not an on-switch.

D21 inventories only `linux/x64` (PID namespace) and `win32/x64` (Job Object).
Inventoried is not enabled. `GROK_ENABLED_PLATFORMS` is the frozen subset that
has passed the real-turn gate; in this release it is `linux/x64` only. An
inventoried pair outside that set is refused before helper lookup with
`unsupported_grok_containment` and `detail: platform_verification_pending`.
Every other platform/arch pair — including macOS — fails closed with
`unsupported_grok_containment` before tmpdir, socket, or process A creation.
On an enabled platform the helper must be a regular executable file at the
inventoried path inside the canonical plugin root; a missing, directory,
symlink, or non-executable helper is `missing_grok_containment_helper`.

Containment helpers are integrity-bound. The coordinator, the preflight and
launch admission verify the helper against `SHA256SUMS`, refuse any symlink or
junction component, and require the helper's real path to stay under the
canonical plugin root. This is an installation-integrity control: it proves
the bytes on this machine are the bytes the release workflow built, smoked and
committed. It is not a defence against a same-user process rewriting the
plugin tree.

The allowlist is Grok CLI `{1.0.4, 1.0.13}` with version-scoped help-flag
profiles. Compatibility probes (`--version`, `--help`) remain uncontained by
design (D20). A non-native launcher (`.cmd`/`.bat`, a PowerShell shim, or a
`#!` script) is `incompatible_grok_cli` before privacy.

| version | required `--help` flags | hidden accepted flags |
|---|---|---|
| `1.0.4` | `--cwd` `--max-turns` `--model` `--no-memory` `--no-subagents` `--output-format` `--permission-mode` `--prompt-file` `--reasoning-effort` `--sandbox` `--session-id` `--single` | none |
| `1.0.13` | the same list minus `--no-memory` | `--no-memory` |

Show `reason`, `detail` and `remedy` from a refusal. Never paste `helper_stderr`
into the published review.

| reason | when | detail | remedy |
|---|---|---|---|
| `unsupported_grok_containment` | platform/arch is not inventoried, or inventoried but not in `GROK_ENABLED_PLATFORMS` | `platform_verification_pending` when inventoried-but-not-enabled | do not expect `--grok` on this host until its real-turn gate passes |
| `missing_grok_containment_helper` | inventoried platform; helper is not a regular, non-symlink, executable file | | install from a tagged release commit; compiling locally does not enable `--grok` |
| `grok_containment_helper_failed` | helper is present but cannot establish containment, fails integrity, or fails the preflight handshake | closed vocabulary: `integrity_mismatch`, `integrity_sums_missing`, `integrity_sums_malformed`, `integrity_sums_symlink`, `integrity_not_listed`, `integrity_outside_root`, `integrity_symlink_component`, `integrity_not_release`, `spawn_error`, `start_deadline`, `handshake_lost`, `helper_exit_<n>`, `helper_signal_<name>`, `record_digest_mismatch`, `record_directory_untrusted` | inspect `detail` and sanitised `helper_stderr`; `build:native` is not a remedy |
| `unsupported_grok_cli_version` | CLI version is outside `{1.0.4, 1.0.13}` | | install an allowlisted Grok CLI |
| `incompatible_grok_cli` | CLI missing, banner malformed, required help flags absent for the detected version, or the launcher is not a native executable | | install a compatible Grok CLI whose launcher is a native executable, not a `.cmd`/`.bat`, PowerShell shim, or `#!` script |

Restricted user namespaces (Ubuntu 24.04 AppArmor `userns` restriction, or a
container whose seccomp blocks `unshare`/`clone(CLONE_NEWUSER)`) fail the
preflight helper launch as `grok_containment_helper_failed` with
`detail: helper_exit_125` and `clone: Operation not permitted` in
`helper_stderr`. Remedy: `sysctl kernel.apparmor_restrict_unprivileged_userns=0`,
an AppArmor profile, or running outside the container. Never a silent degrade.

**Windows.** `win32/x64` ships its helper and CI verifies it. Runtime stays
refused with `unsupported_grok_containment` and
`detail: platform_verification_pending` until its real-turn gate passes in a
later patch release. Enabling it is a one-line change to
`GROK_ENABLED_PLATFORMS`.

## Privacy gate

Do not scan, create state, or patch config when `--no-grok` is effective,
including the expanded `--codex-only` route. Otherwise invoke:

```text
node {plugin_root}/hooks/scripts/grok-privacy-preflight.mjs --repo PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --config CONFIG_FILE --approval auto
```

The result is authoritative for the current repository fingerprint:

- `auto_ack` and `acknowledged` may continue.
- `needs_approval` must display the byte-sorted sensitive paths and fingerprint
  before requesting an explicit decision.
- approval reruns the preflight with `--approval approve`; decline reruns it
  with `--approval decline` and excludes the role.
- errors and stale results exclude the role. No project-access argument may be
  constructed before a successful outcome.

Only the acknowledgment fingerprint and timestamp may be patched. Preserve
all unrelated and unknown config keys.

## Containment preflight

`preflightGrokContainment` in
`{plugin_root}/hooks/scripts/grok-containment-preflight.mjs` establishes
`containment_ready` after the routing preflight and before the privacy gate,
session id, prompt composition, and provider launch. On success it issues one
owner-bound `containment_ready_token` and writes one single-use, TTL-bounded
owner record (30 minutes) under the OS temp directory. On refusal it issues
none and the round makes zero downstream calls. `containment_ready` is the
pre-launch admission and `termination_confirmed` is the post-exit proof — they
are never interchangeable. The in-process registry never substitutes for the
record. The `--release` form is mandatory on privacy decline, on error, and
when no launch happened:

```text
node {plugin_root}/hooks/scripts/grok-containment-preflight.mjs --release --containment-ready-token-json CONTAINMENT_READY_TOKEN_JSON
```

Both native helpers take `--parent-pid`. The leash binds the provider tree to
the reviewing bridge process: if that process dies, the tree is torn down and
no report is received (`lifecycle_unconfirmed`). There is no reconnect; the
next round starts a new preflight.

A timeout returns `timedOut: true`, `code: 124`, and is
`lifecycle_unconfirmed`. Capture overflow (provider channel above 16 MiB, or
control stream above 64 KiB) kills the tree, sets `captureOverflow: true` and
`detail: capture_overflow`, and is also unconfirmed. Both polarities are
round-terminal with no vote.

## Reviewer bridge

After containment admission and the current privacy gate both succeed, invoke
with argv data:

```text
node {plugin_root}/hooks/scripts/run-grok-reviewer.mjs --project-root PROJECT_ROOT --plugin-root PLUGIN_ROOT_ABS --prompt-file PAYLOAD_FILE --output OUTPUT_FILE --execution-route-json EXECUTION_ROUTE_JSON --reviewer-id grok --containment-ready-token-json CONTAINMENT_READY_TOKEN_JSON --timeout-seconds 900
```

The route and the containment token both travel inline, as one argv value each.
Never hand this bridge a plan path: the emitted
`.deep-review/tmp/routing-plan.json` is a repository-internal audit copy that no
adapter reads, and a repository under analysis can commit one there.

The bridge consumes the owner-bound token and never establishes readiness
itself. It uses the shared payload, consumes the sealed compatibility evidence
carried on the route without re-probing, repeats the privacy validation, and
captures pre/post fingerprints. A mutation, prompt-size refusal, timeout,
authentication failure, unconfirmed whole-tree termination, or empty output is a
visible terminal status and contributes no vote.

## What the read-only controls actually enforce

- `--permission-mode plan` is the control that **prevents** the mutation the
  compatibility experiment attempted, including one targeting an absolute path
  outside `--cwd`, and it does not disable reading. It was verified against both
  of the agent's write mechanisms — its file-write tool and its shell tool — and
  is not claimed to prevent every mutation mechanism: deletion, rename, and Git
  metadata writes were never exercised. Subagent-issued actions were not
  exercised either, so the production argv structurally disables them with
  `--no-subagents`.
- `--sandbox read-only` is required and is not inert — an unresolvable profile
  refuses to start — but in v1.0.3 it was observed **not** to stop a workspace
  write. It must never be described as a write barrier.

## The hybrid fingerprint boundary

`grok_fingerprint_mode` is `hybrid`, and hybrid is a bounded detector rather
than a complete recursive snapshot. Its observation surface is exactly:

- The repository walker excludes `.git`. The Git component observes the resolved
  commit as `@HEAD` and every path Git reports as changed or untracked as
  `@STATUS/<path>`; it hashes no other Git metadata.
- Hybrid adds only repository files selected by the sensitive-pattern and
  runtime-state scan, as `@SENSITIVE/<path>`, plus the v3 mutation-authority
  entries. A full walk is the fail-closed degradation used when canonical
  sensitive-pattern data is unavailable, not the ordinary path.
- `plugin_root` supplies the canonical sensitive-pattern data to that scan; it
  is not a second walk root, so no plugin-root file is ever fingerprinted.

Consequently the detector catches tracked/untracked worktree changes visible to
Git status, the selected sensitive/runtime files, HEAD movement, and mutation
authority drift. It does not promise to catch mutations inside `.git` that leave
HEAD resolution and Git status output unchanged, ignored paths outside the
sensitive/runtime selection, or writes to a distinct installed plugin root.
Those are explicit escape classes. Drift inside the observed surface still
yields `mutated` and exclusion, so the hybrid digest is a **bounded detector**
and **not a total backstop** for everything plan mode does not prevent.

## Synthesis identity

Label a trusted success `grok`. It is one xAI-family vote independent of
`claude-opus`, `codex-review`, `codex-adversarial`, and `agy`. Preserve a
sole-family dissent in the report even when a majority verdict is otherwise
reached.
