# Review Report Format

## 파일 위치

`.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md`

타임스탬프는 리뷰 완료(또는 합성 직전) 시점 기준. 같은 날 여러 번 실행해도
파일이 충돌하지 않는다. 파일명 생성의 정식(canonical) 경로는 Node 다 — 호스트 셸의
`date` 는 POSIX 셸 없이 지원되는 native Windows 11 에서 대화형이고 의미가 다르므로
런타임 지시문에 쓰지 않는다:

```js
const iso = new Date().toISOString();   // 2026-04-17T11:51:56.123Z
const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/gu, '')}`;
// stamp → 2026-04-17-115156, 즉 2026-04-17-115156-review.md
```

## 구조

# Deep Review Report — {날짜}

## Summary
- **Verdict**: {APPROVE | REQUEST_CHANGES | CONCERN}
- **Review Mode**: {Claude Opus Only | Claude=ultracode(6-lens[, verified]) | N-way Cross-Model where `N` is the trusted reviewer count and `N ≥ 2` — 2-way Cross-Model / 3-way Cross-Model / 4-way Cross-Model / 5-way Cross-Model | 1-way (codex-only) | 2-way (codex-only + agy) | 1-way (agy only) | (… agent-fanout fallback / UNVERIFIED fallback)}
- **Issues**: {🔴 N건, 🟡 N건, ℹ️ N건}
- **Warnings**: {운영 경고 0건이면 생략. 페이로드 조립 실패(OCR_WARNINGS)를 포함한 운영 경고를 기록 — 예: `fp-doctrine extraction failed (injection skipped)`, `change_files unavailable (omitted)`. verdict 에는 영향 없음 — 감사용.}

## Sprint Contract: {SLICE-ID} (있을 때만)
| 기준 | 상태 | 근거 |
|------|------|------|
| {description} | {✅ PASS / ❌ FAIL / ⚠️ PARTIAL / ⏭️ SKIP} | {evidence} |

## Cross-Model Verification (Codex 사용 시)
| 항목 | Claude (Opus) | Codex Review | Codex Adversarial | agy | Grok | Agreement |
|---|---|---|---|---|---|---|
| (issue) | ✓ / – | ✓ / – | ✓ / – | ✓ / – | ✓ / – | unanimous_5 / majority_4_of_5 / majority_3_of_5 / split_2_of_5 / solo_1_of_5 |

> Columns are rendered for the reviewers actually selected: a reviewer that was
> not selected has no column, or is shown as `(not run)`. Column order is
> `canonicalReviewerIndex` order — the same total order the `dissenters` array
> below uses. The `Agreement` cell instantiates the generic enum below at the
> round's own `N`; the row above is the `N = 5` instantiation.
> **XF-1**: When `claude_reviewer = ultracode-fanout`, render the "Claude (Opus)" column header as **"Claude (ultracode)"** — the cell holds the single collapsed voice (1 Anthropic vote; see [`{plugin_root}/skills/deep-review-workflow/references/ultracode-integration.md`](./ultracode-integration.md) §4).

## Routing Plan

Record protocol `3.0`, artifact phase/risk/progress, the full candidate set,
reviewer floor and cap, and every selected route's canonical reviewer id,
assignment role, rubric id, wave, required flag, requested/resolved model and
effort, selection reason, shadow/applied mode, and fallback reason. Assignment
roles never add voices. Record a single expansion and its trigger when present.

## Provenance

Record artifact `confidence`, deterministic signals, `semantic_status`, and the
adapter result fields `requested_*`, `resolved_*`, `applied_*`, and
`verification_status`. When a transmitted request cannot be observed in provider
output, render `requested-but-unverified`; never use that label for a request
that was omitted. Include fallback authorization, applied substitute, and reason.

For pure document scope, every trusted reviewer report must emit the literal
heading `## Artifact Gate` exactly once. The `json` fence must be on the
immediately following line with no intervening prose:

## Artifact Gate
```json
{
  "schema_version": 1,
  "findings": [
    {
      "id": "DOC-1",
      "severity": "warning",
      "stage": "implementation_verification",
      "acceptance_evidence": [
        "named final implementation test or observable rollback evidence"
      ]
    }
  ]
}
```

`severity` is `critical|warning|info`; `stage` is
`pre_implementation|implementation_verification|advisory`. Every Critical is
`pre_implementation`. Critical/Warning items require non-empty objective
acceptance evidence, and JSON counts must equal the Summary Issues counts.
Document feasibility/traceability/rollback/testability are evaluated without
applying the code-only rule “missing implementation tests = Critical”.

After synthesis, report `READY_FOR_IMPLEMENTATION` plus the sealed receipt path,
or `DOCUMENT_BLOCKED` plus blocker ids/reviewer-floor reasons. Readiness is
separate from verdict: a Warning-only CONCERN may be READY when every Warning
is deferred to verifiable implementation evidence.

## Code Review
### 🔴 Critical
- {구체적 이슈, 파일:라인, 수정 제안}

### 🟡 Warning
- {구체적 이슈, 파일:라인, 수정 제안}

### ℹ️ Info
- {정보성 관찰, 파일:라인}

### 🟢 Passed
- {통과한 관점 목록}

Each Critical, Warning, and Info finding is exactly one `- ` bullet on one line.
A zero-count severity section contains exactly `None.` and no bullets. The
Critical, Warning, and Info bullet counts must equal the corresponding Summary
Issues counts. Passed also uses one `- ` bullet per item, or exactly `None.`
when no checks passed.

## Entropy Scan (--entropy 사용 시)
{중복 코드, 패턴 불일치, ad-hoc 헬퍼 목록}

## Verdict 결정 규칙

- 🔴 이슈가 1건 이상 → REQUEST_CHANGES
- 🟡만 있고 전원 일치 (N_actual ≥ 2) → REQUEST_CHANGES
- 🟡만 있고 의견 분리 → CONCERN (사람에게 에스컬레이션)
- 🟢만 → APPROVE
- **N_actual == 1 예외**: "🟡만 있고 전원 일치" 규칙 부적용 — N=1 이면 단독 리뷰어 전용 분기(🔴 1건 이상 → REQUEST_CHANGES(critical/security 단독 blocking) / 🟡만 → CONCERN / 🟢 → APPROVE)가 최종(final)이다(🟡 1건 = 전원 일치가 자명하므로 게이트 없이 두면 REQUEST_CHANGES 로 무력화되고, 🔴 은 severity 자체가 blocking 이라 단독이라도 REQUEST_CHANGES 유지). 전용 분기 정의의 SSOT 는 [`{plugin_root}/skills/deep-review-workflow/references/review-execution.md`](./review-execution.md) §5.1 N_actual == 1 전용 분기.
- 🔴/🟡 판정은 `{plugin_root}/skills/deep-review-workflow/references/review-criteria.md`의 "severity 부여 원칙"(영향×도달 가능성, 보수적 기본값)을 따른다.

### Per-finding annotations (N-way mode)

When `Review Mode` is an N-way Cross-Model mode, each finding includes:

- `agreement: unanimous_N | majority_K_of_N | split_K_of_N | solo_1_of_N`
- `dissenters`, required whenever `agreement` is not `unanimous_N`:

```yaml
dissenters:
  - reviewer: <canonical reviewer id>
    family: anthropic | openai | google | xai
    summary: <one line>
```

`dissenters.length` is derived from `agreement` and is never declared as a
separate count: `N - K` for `majority_K_of_N` and `split_K_of_N`, `N - 1` for
`solo_1_of_N`, and the key is absent for `unanimous_N`. An annotation therefore
cannot disagree with its own agreement value.

Entries are ordered by `canonicalReviewerIndex`
(`{plugin_root}/hooks/scripts/lib/adaptive-review-routing.mjs`) — the same total order
every other reviewer-set rendering already uses, so two reports over one round
render byte-identically.

`family` is per-dissenter and is never collapsed to one value for the whole
array: two dissenters split across `xai` and `google` must stay distinguishable
from two inside one family. That distinction is the entire reason the annotation
exists. A dissent whose `dissenters` all share one `family` is one vendor's
outlier, while a dissent spanning two or more families is a cross-vendor signal
and is materially weaker support for the majority.

The singular `dissenter`, `dissenter_family` and `dissent_summary` keys are
retired, not kept as a first-dissenter convenience: a consumer reading a singular
key gets a silently truncated answer and cannot tell that it was truncated.

At `N = 5` the enum instantiates as:

| agreement | `dissenters` |
|---|---|
| `unanimous_5` | (key absent) |
| `majority_4_of_5` | 1 entry |
| `majority_3_of_5` | 2 entries |
| `split_2_of_5` | 3 entries |
| `solo_1_of_5` | 4 entries |

The headline case is a `majority_3_of_5` whose two dissenters sit in different
vendor families. Both voices survive, and the report shows that the dissent spans
`google` and `xai` rather than being one vendor's outlier:

```yaml
agreement: majority_3_of_5
dissenters:
  - reviewer: agy
    family: google
    summary: the rollback path is already exercised by an existing test
  - reviewer: grok
    family: xai
    summary: the same path, reached from the containment argument instead
```

Two dissenters inside one family render the same shape with one family value
repeated. The two cases carry different weight and must never be conflated:

```yaml
agreement: majority_3_of_5
dissenters:
  - reviewer: codex-review
    family: openai
    summary: the retry bound is unreachable on the timeout path
  - reviewer: codex-adversarial
    family: openai
    summary: the same bound, reached from the adversarial pass
```

A `unanimous_5` finding carries no `dissenters` key at all:

```yaml
agreement: unanimous_5
```

Lower cardinalities use the identical shape — a `majority_3_of_4` renders a
one-element array, never a singular key:

```yaml
agreement: majority_3_of_4
dissenters:
  - reviewer: agy
    family: google
    summary: the migration step is reversible, so this is advisory not blocking
```

### Degraded mode marker

When `claude_reviewer != none AND opus_status != success AND N_actual_external ≤ 1`, the guard applies a **confidence floor** — it never overwrites a blocking verdict:

- 🔴/critical finding present → **REQUEST_CHANGES preserved** (degraded marker attached, not downgraded — a low-confidence run does not fail-open a blocking finding).
- APPROVE → **raised to CONCERN** (low-confidence approval prevented).
- already CONCERN → unchanged.

```
Summary.degraded: opus_failed_low_confidence
```

This is deterministic (no AskUserQuestion at synthesis) — see spec §4.3.1 for the rationale.

## PRACTICAL DOCUMENT POLICY

For a trusted `artifact_phase: document` assignment, document blockers are
limited to a concrete repository/artifact-grounded functional contradiction;
implementation infeasibility or a missing decision that prevents execution;
reachable safety/security/compatibility/migration/recovery/rollback harm; or
acceptance criteria incapable of objective verification.

Style, readability, naming, preference, and ungrounded speculation are
advisory/info or suppressed, not Warning/Critical pre-implementation blockers.
Missing future implementation/tests are implementation_verification evidence
with objective acceptance evidence, not document blockers. This policy is
independent of reviewer role and provider.

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

### `opus_status` under ultracode fan-out (CONS-10)

ultracode 모드에서 "opus"는 6샤드이므로 degraded 마커가 키로 쓰는 단일 `opus_status` 를 샤드 성공 수 K 의 **disjoint quorum 밴드**(우선순위 failed→partial→success)로 collapse 한다: **`failed` iff K=0; `partial` iff 1 ≤ K < 쿼럼(=4); `success` iff K ≥ 쿼럼(=4).** degraded 마커(`opus_status != success AND N_actual_external ≤ 1`)는 이 collapse 값(K<4 이면 success 아님)으로 평가되어 결정성을 유지한다. 정의 단일 출처는 [`{plugin_root}/skills/deep-review-workflow/references/ultracode-integration.md`](./ultracode-integration.md) §2(B).
