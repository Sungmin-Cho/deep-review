# Runtime dispatch — capability SSOT

The public entries and reviewer roles are selected from available host tools
and executable capabilities. The `Claude Code` and `Codex` columns are
capability profiles, not a `runtime_host` switch.

The executable capability contract in
`{plugin_root}/hooks/scripts/lib/capability-registry.mjs` is authoritative.
This table explains that contract for orchestrators; when prose and runtime
data differ, use the protocol `2.0` registry output. Native host assertions are
injected for the current run and are never restored from the executable cache.

Each candidate explicitly declares supported assignment roles from
`standard`, `feasibility`, `traceability`, `adversarial`, `security`, and
`confirmation`. The protocol `3.0` routing plan selects a role-fit subset and
binds one trusted rubric to each selected canonical reviewer. A role assignment
does not create an additional `N_actual` voice.

| Role | Claude Code | Codex |
|---|---|---|
| public review/respond entry | `/deep-review` command shim | `$deep-review:deep-review` |
| loop entry | `/deep-review-loop` | `$deep-review:deep-review-loop` |
| independent Claude reviewer | named `Agent(code-reviewer)` or Node Claude bridge | Node Claude bridge when CLI exists |
| Codex standard reviewer | Node Codex exec bridge | generic subagent that reads `{plugin_root}/agents/code-reviewer.md` |
| Codex adversarial reviewer | Node Codex exec bridge | generic subagent that reads `{plugin_root}/agents/code-reviewer.md` |
| agy reviewer | Node agy bridge | Node agy bridge |
| grok reviewer | Node grok bridge | Node grok bridge |

## Selection invariants

- Enumerate roles by tool capability: named-agent availability, the detected
  Claude/Codex/agy executables, and fresh host assertions. `runtime_host` is
  diagnostic only and must never change reviewer enumeration or `N_actual`.
- Adaptive selection is deterministic: role fit, provider-family diversity,
  prior-round unused status, last success, then canonical reviewer id.
  `--reviewer-strategy static` preserves the eligible candidate set; shadow
  mode observes the adaptive plan without applying it.
- Native Codex creates two separate history-free contexts: one
  `codex-review` subagent and one `codex-adversarial` subagent. Both use
  `fork_turns: "none"`, have different subagent identities, count at most once
  each in `N_actual`, and are never labeled Opus. Give every attempt an
  invocation-unique `task_name`; keep the canonical reviewer IDs unchanged in
  routing and report provenance. Never use `followup_task` or reuse an existing
  subagent identity or history, including for a fallback retry.
- Each generic subagent first reads the absolute
  `{plugin_root}/agents/code-reviewer.md`, then its own route-specific payload,
  stays read-only, and returns the report contract. It receives no generator
  history. Build the `spawn_agent` options for that attempt and include model
  only when `route.resolved.model !== null`; include reasoning effort only when
  `route.resolved.effort !== null`.
- When Claude CLI exists, `run-claude-reviewer.mjs` remains the distinct
  `claude-opus` role. A named Claude agent fills the same role when available.
- On a Claude capability profile, the generic Codex exec bridge fills both
  `codex-review` and `codex-adversarial`. Each invocation consumes its own
  inline route and payload, so every canonical assignment rubric and the
  selected model/effort reach the leaf transport.
- `--no-codex` disables both the standard and adversarial Codex roles. It does
  not affect `claude-opus`, `agy`, or `grok`.
- `--no-grok` disables `grok`, and disables it completely: no coordinator
  process, no carrier, no compatibility probe, and no Grok config state. It does
  not affect `claude-opus`, `agy`, or either Codex role. `grok` is opt-in and is
  never a default candidate, so a review with no reviewer flag selects it not at
  all; the expanded `--codex-only` route carries `--no-grok`.
- If an explicit model or effort is rejected as unsupported, retry the leaf at
  most once only when `--allow-fallback` authorizes it, omitting only the
  rejected dimension. Authentication, timeout, empty output, and generic
  failures never retry.

## Read-only trust boundary

Native `spawn_agent` has no enforceable tool allowlist. Its honest read-only
contract is a read-only instruction plus fingerprint-based trust rejection;
writes remain possible and are detected after the attempt. Capture a pre and
post repository fingerprint around every external or generic reviewer. A
mutation invalidates the result: stop the round before launching any sibling
reviewer and before any response or commit action, then report the untrusted
attempt. The untrusted result is excluded from synthesis.
Use the same fingerprint API, `lib/fingerprint.mjs` `captureFingerprint`, with
identical `repo`, `pluginRoot`, and `mode` options for both snapshots. Record the
exclusion in the final report; never silently reduce `N_actual`.

The Grok bridge is preventive but only partly so, and its status is stated that
way: `--permission-mode plan` is the control observed to prevent a workspace
write, `--sandbox read-only` is required but was not observed to stop one, and
the pre/post hybrid fingerprint is a bounded detector with enumerated escape
classes rather than a total backstop. The Grok seat also captures its
post-review fingerprint only after confirmed whole-tree termination.
`{plugin_root}/skills/deep-review-workflow/references/grok-integration.md` states
each of those limits exactly.
