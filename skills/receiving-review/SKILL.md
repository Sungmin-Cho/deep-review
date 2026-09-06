---
name: receiving-review
description: |
  코드 리뷰 피드백 수신 시 증거 기반 대응 프로토콜.
  맹목적 동의를 차단하고, 기술적 검증 후 증거와 함께 수락/반박/구현한다.
  deep-review verdict 또는 외부 리뷰(PR 코멘트, 동료 리뷰) 모두에 적용.
user-invocable: false
---

# Receiving Review Protocol

이 private 스킬은 Claude `/deep-review --respond`와 Codex
`$deep-review:deep-review --respond`가 같은 absolute path로 읽어 리뷰 피드백
대응 프로세스를 실행합니다. Hook 또는 MCP server가 필요하지 않습니다.

## 참조 문서 (on-demand Read)

- `{plugin_root}/skills/receiving-review/references/response-protocol.md` — 6단계 대응 프로토콜 상세
- `{plugin_root}/skills/receiving-review/references/forbidden-patterns.md` — 금지 표현 + 합리화 차단 테이블
- `{plugin_root}/skills/receiving-review/references/response-format.md` — Response 리포트 형식
- `{plugin_root}/skills/receiving-review/references/phase6-prompt-contract.md` — **Phase 6 진입 시 반드시 참조**.
  Claude named/fallback과 Codex generic subagent가 byte-identical Accepted Items를
  공유하는 prompt/result 정식 계약.
- `{plugin_root}/skills/receiving-review/references/phase6-delegation-spec.md` — capability-based host dispatch,
  Node snapshot/verify/recover/confirmation 설계 배경과 edge cases.
- `{plugin_root}/skills/receiving-review/references/respond-execution.md` — `--respond` 전체 실행 절차 SSOT. `{plugin_root}/commands/deep-review.md` 의 `--respond` 분기에서 on-demand Read 되어 수행된다.

## 대응 원칙

1. **증거 우선**: 모든 판단(수락/반박)에 코드 증거를 첨부한다
2. **맹목적 동의 금지**: 감사 표현, 즉각 동의 등 성과주의적 반응을 차단한다
3. **검증 선행**: VERIFY 단계를 건너뛰지 않는다 — "간단한 수정"도 예외 없음
4. **기술적 반박 권장**: 증거가 있으면 반박한다. 분위기 보다 정확성이 우선
5. **기록 의무**: 모든 대응을 response 리포트에 기록한다

## 공통 근거 기준 (단일 소스)

모든 피드백은 source·provider·role에 관계없이 같은 기준으로 검증한다.
수락·반박은 구체적 트리거, 실제 영향, 도달 가능한 경로, 코드·테스트·계약
증거로 판단한다. 불확실성은 판정과 별도로 밝힌다. 다른 리뷰어의 agreement는
corroboration이지 정확성 증명이 아니며, 단독·adversarial 출처에도 자동 승격·강등·
기각 규칙을 부여하지 않는다.

## 6단계 대응 프로토콜 (요약)

각 단계의 상세 절차는 `{plugin_root}/skills/receiving-review/references/response-protocol.md` 참조.

### Phase 1: READ — 전체 피드백 읽기
반응하지 않고 전체를 먼저 읽는다. 항목 간 관계를 파악한다.

### Phase 2: UNDERSTAND — 요구사항 재진술
기술적 요구사항을 자신의 말로 재진술한다. 금지 표현 사용 불가.

### Phase 3: VERIFY — 코드베이스 대조 검증
관련 코드 읽기, 사용처 검색(YAGNI), 기존 테스트 확인, git blame 확인.

### Phase 4: EVALUATE — 기술적 판단
공통 근거 기준으로 주장을 판단하고, agreement와 disagreement는 보조 증거로만 기록한다.

### Phase 5: RESPOND — 수락 또는 반박
수락 시 간결하게, 반박 시 evidence 필수. 반박 철회 시 사과 없이 인정.

### Phase 6: IMPLEMENT — capability-based 그룹 dispatch
심각도 그룹(🔴 → 🟡 → ℹ️)별로 Claude는 named agent, Codex는 shipped
agent contract를 먼저 읽는 generic subagent를 사용한다. 두 host는 같은
Accepted Items prompt와 `phase6-protocol.mjs` snapshot/run-test/verify/recover/
commit을 사용한다. Main은 Node verify를 항상 실행하고 error 또는 회귀에서
다음 그룹을 중단한다. 상세는 `{plugin_root}/skills/receiving-review/references/respond-execution.md` 참조.

## 구현 우선순위 (Verdict 연동)

1. 🔴 Critical → 검증된 영향·도달 경로를 우선 수정
2. 🟡 Warning → 실제 영향과 인수 계약을 검증한 후 수정
3. unresolved → 필요한 증거를 명시하고 보류
4. ℹ️ Info → 선택적

## Recurring Findings 연동

상세 분류/매칭 로직은 `{plugin_root}/skills/receiving-review/references/response-protocol.md` Phase 1(READ)의 **Recurring Findings 분류** 섹션을 단일 소스로 한다. 본 `{plugin_root}/skills/receiving-review/SKILL.md`는 개요만 제공한다:

- Phase 1(READ)에서 각 리뷰 항목을 7개 taxonomy 카테고리로 LLM 분류.
- `.deep-review/recurring-findings.json`의 같은 카테고리 occurrences가 3회 이상이면 자동 경고를 출력하고 해당 항목을 "근본 원인 분석 권장"으로 표시.
- 경고 메시지 템플릿과 카테고리 정의는 `{plugin_root}/skills/receiving-review/references/response-protocol.md` 참조.

## Response 리포트

대응 완료 후 `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`에 기록.
형식은 `{plugin_root}/skills/receiving-review/references/response-format.md` 참조.

## Re-review 제안

🔴 항목 수정이 1건 이상 완료되면:
"대응이 완료되었습니다. `/deep-review`를 재실행하여 변경사항을 검증하시겠습니까?"
