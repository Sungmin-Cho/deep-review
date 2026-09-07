#!/usr/bin/env bash
# Extract the FP-suppression doctrine (single-sourced from review-criteria.md)
# between HTML-comment markers, with per-block validation. Fail-closed.
set -Eeuo pipefail

SRC="${1:-}"
[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "extract-fp-doctrine: source file not found: ${SRC:-<empty>}" >&2; exit 3; }

# Extract the body strictly between exactly one start/end marker pair.
# Prints body to stdout; returns 1 if marker count != 1 or body empty.
extract_block() {
  local name="$1" file="$2"
  local starts ends
  starts=$(grep -c "<!-- ${name}:start -->" "$file" || true)
  ends=$(grep -c "<!-- ${name}:end -->" "$file" || true)
  [ "$starts" = "1" ] && [ "$ends" = "1" ] || { echo "extract-fp-doctrine: ${name} marker count != 1 (start=$starts end=$ends)" >&2; return 1; }
  # awk: print lines strictly between the markers
  local body
  body=$(awk -v s="<!-- ${name}:start -->" -v e="<!-- ${name}:end -->" '
    $0 ~ s {inb=1; next} $0 ~ e {inb=0} inb {print}' "$file")
  [ -n "$(printf '%s' "$body" | tr -d '[:space:]')" ] || { echo "extract-fp-doctrine: ${name} body empty" >&2; return 1; }
  printf '%s\n' "$body"
}

doctrine=$(extract_block "fp-doctrine" "$SRC") || exit 3
conservative=$(extract_block "fp-conservative" "$SRC") || exit 3

# Per-block validation: doctrine must contain the six canonical evidence rules
# (by keyword, not just count) and conservative must bind impact, reachability,
# and separately stated uncertainty. Neither may contain VOICE-6/confidence text.
bullet_count=$(printf '%s\n' "$doctrine" | grep -c '^[[:space:]]*-' || true)
[ "$bullet_count" -ge 6 ] || { echo "extract-fp-doctrine: fp-doctrine expected >=6 bullets, got $bullet_count" >&2; exit 3; }
for kw in 'pre-existing' '린터' '추측' '취향' 'named important failure' 'concrete attack path'; do
  printf '%s' "$doctrine" | grep -q "$kw" || { echo "extract-fp-doctrine: fp-doctrine missing canonical rule keyword: $kw" >&2; exit 3; }
done
for kw in 'impact' 'reachability' 'uncertainty' 'separately'; do
  printf '%s' "$conservative" | grep -q "$kw" || { echo "extract-fp-doctrine: fp-conservative missing canonical rule keyword: $kw" >&2; exit 3; }
done
if printf '%s\n%s' "$doctrine" "$conservative" | grep -Eq 'VOICE-6|confidence'; then
  echo "extract-fp-doctrine: VOICE-6/confidence text must be outside the markers" >&2; exit 3
fi

# Emit in fixed order: conservative balance first (so the reviewer reads the
# "do not over-suppress" rule before the suppression rules), then suppression.
printf '### Severity — conservative default\n%s\n\n### Findings to suppress / downgrade\n%s\n' "$conservative" "$doctrine"
