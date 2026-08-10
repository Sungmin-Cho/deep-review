# Review Report Format

## 파일 위치

`.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md`

타임스탬프는 리뷰 완료(또는 합성 직전) 시점 기준. 같은 날 여러 번 실행해도
파일이 충돌하지 않는다. 파일명 생성 예: `date "+%Y-%m-%d-%H%M%S"` → `2026-04-17-115156-review.md`.

## 구조

# Deep Review Report — {날짜}

## Summary
- **Verdict**: {APPROVE | REQUEST_CHANGES | CONCERN}
- **Review Mode**: {Claude Opus Only | Claude=ultracode(6-lens[, verified]) | 2-way Cross-Model | 3-way Cross-Model | 4-way Cross-Model | 1-way (codex-only) | 2-way (codex-only + agy) | 1-way (agy only) | (… agent-fanout fallback / UNVERIFIED fallback)}
- **Issues**: {🔴 N건, 🟡 N건, ℹ️ N건}
- **Warnings**: {운영 경고 0건이면 생략. 페이로드 조립 실패(OCR_WARNINGS)를 포함한 운영 경고를 기록 — 예: `fp-doctrine extraction failed (injection skipped)`, `change_files unavailable (omitted)`. verdict 에는 영향 없음 — 감사용.}

## Sprint Contract: {SLICE-ID} (있을 때만)
| 기준 | 상태 | 근거 |
|------|------|------|
| {description} | {✅ PASS / ❌ FAIL / ⚠️ PARTIAL / ⏭️ SKIP} | {evidence} |

## Cross-Model Verification (Codex 사용 시)
| 항목 | Claude (Opus) | Codex Review | Codex Adversarial | agy | Agreement |
|---|---|---|---|---|---|
| (issue) | ✓ / – | ✓ / – | ✓ / – | ✓ / – | unanimous_4 / majority_3_of_4 / split_2_of_4 / solo_1_of_4 |

> For N < 4 modes, the agy column is omitted (or shown as `(not run)`).
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

### Per-finding annotations (4-way mode)

When `Review Mode: 4-way Cross-Model`, each finding includes:
- `agreement: unanimous_4 | majority_3_of_4 | split_2_of_4 | solo_1_of_4`
- For `majority_3_of_4`: `dissenter: <reviewer-name>`, `dissenter_family: anthropic | openai | google`, `dissent_summary: <one line>`

This preserves cross-vendor-family signal even when the majority threshold (3/4) is met — a dissent from the sole Google reviewer (agy) is treated as informationally distinct from intra-family dissent.

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
reachable safety/security/compatibility/rollback harm; or acceptance criteria
incapable of objective verification.

Style, readability, naming, preference, and ungrounded speculation are
advisory/info or suppressed, not Warning/Critical pre-implementation blockers.
Missing future implementation/tests are implementation_verification evidence
with objective acceptance evidence, not document blockers. This policy is
independent of reviewer role and provider.

### design-validation

For an all-design-document/ADR scope, review implementation feasibility and
design soundness: block only the shared functional-contradiction,
infeasibility, and safety/security/compatibility/rollback-harm blockers
above. Prose completeness and unspecified implementation detail never block.

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
