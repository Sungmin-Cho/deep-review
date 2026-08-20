# init setup — public `init` terminal route

This reference is part of the reviewed runtime-reference file map. Execute it
without loading the review pipeline.

## 1. Inspect and confirm

Use a direct host read to check `.deep-review`. If it already exists, ask
whether to reinitialize. A decline is terminal and changes nothing.

Resolve the runtime root, then use the Node CLI
`detect-environment.mjs --cwd PROJECT_ROOT --format json` to collect project
context. This census is intentionally candidacy-free: initialization never
dispatches a reviewer, so it never carries a Grok candidacy argument and creates
no Grok state. Read package manifests, source layout, lint configuration, and
naming patterns with host file tools. Present inferred architecture, style, and
entropy rules for confirmation.

## 2. Create runtime directories

Use the host file-creation tool to create these directories recursively:

- `.deep-review/contracts`
- `.deep-review/reports`
- `.deep-review/responses`
- `.deep-review/journeys`
- `.deep-review/tmp`

Directory creation is a file API operation, not an executable command block.

## 3. Write configuration and rules

Write `.deep-review/config.yaml` through the host file tool. `review_model` is
an opaque non-empty installed Claude model alias and can later be changed to an
alias such as `fable`.

```yaml
review_model: opus
codex_notified: false
agy_notified: false
agy_enabled: true
agy_sensitive_acked_fingerprint: ""
agy_sensitive_acked_at: ""
agy_fingerprint_mode: hybrid
grok_notified: false
grok_sensitive_acked_fingerprint: ""
grok_sensitive_acked_at: ""
grok_fingerprint_mode: hybrid
last_review: null
app_qa:
  last_command: null
  last_url: null
```

There is deliberately no `grok_enabled` key: Grok candidacy and disabling are
owned by the parsed public flags and overrides, and a second inert
enable-looking key would create a false configuration authority.

Write the confirmed team rules to `.deep-review/rules.yaml` and preserve this
shape when a field was not inferred:

```yaml
architecture:
  layers: []
  direction: top-down
  cross_cutting: []
style:
  max_file_lines: 300
  naming: null
  logging: null
entropy:
  prefer_shared_utils: true
  max_similar_blocks: 3
  validate_at_boundaries: true
```

Explain that rules are inferential and deep-work fitness evidence is the
computational enforcement surface.

## 4. Ignore local state

Offer one precise host edit to append this block only when absent:

```gitignore
# deep-review — runtime state and local review output
.deep-review/config.yaml
.deep-review/reports/
.deep-review/responses/
.deep-review/entropy-log.jsonl
.deep-review/recurring-findings.json
.deep-review/.pending-mutation.json
.deep-review/.mutation.lock/
.deep-review/tmp/
```

`rules.yaml`, `contracts/`, and `journeys/` are shareable knowledge. The paths
above are local by default; a team may explicitly track recurring evidence.

## 5. Complete

Report that initialization completed and name both public entries:
`/deep-review` for Claude Code and `$deep-review:deep-review` for Codex.
