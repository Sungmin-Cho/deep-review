# Review Criteria — 6가지 리뷰 관점

독립 Evaluator가 코드를 평가할 때 사용하는 6가지 관점.

## severity 부여 원칙 (모든 관점 공통)

severity는 결함의 종류가 아니라 **영향 × 도달 가능성**으로 정한다:
- 🔴 Critical: 높은 영향(데이터 손상·보안 침해·크래시) AND 실제 도달 가능(핫패스·일반 입력으로 트리거)
- 🟡 Warning: 영향은 크나 도달 조건이 좁음, 또는 도달은 쉽지만 영향이 제한적
- ℹ️ Info: 영향·도달 모두 낮음 (주로 스타일·가독성)

<!-- fp-conservative:start -->
**보수적 기본값(중요)**: 도달 가능성을 diff만으로 확정할 수 없으면 *강등하지 않는다* — 추적 불가는 안전을 뜻하지 않는다. 명백히 도달 불가일 때만 강등하고, 불명확하면 높은 쪽을 유지한다. 보안·정확성 결함은 특히 이 보수 규칙을 우선한다.
<!-- fp-conservative:end -->

각 관점의 🔴/🟡 표기는 이 원칙으로 최종 조정된다.

## 1. 정확성 (Correctness)

- 로직 버그: 조건문 오류, off-by-one, null/undefined 미처리
- 엣지 케이스: 빈 입력, 최대값, 동시성, 타임아웃
- 에러 핸들링: try-catch 누락, 에러 삼킴, 부적절한 fallback
- 타입 안전성: 런타임 타입 불일치, 암묵적 형변환

평가: 버그 하나당 🔴. 없으면 🟢.

## 2. 아키텍처 정합성 (Architecture Compliance)

rules.yaml이 있으면 해당 규칙 기준, 없으면 일반 원칙:
- 레이어 경계 침범: UI에서 DB 직접 접근, 순환 의존성
- 종속성 방향 위반: 하위 레이어가 상위 레이어를 import
- 관심사 분리: 하나의 함수/파일이 여러 책임을 가짐
- API 경계: 내부 구현 세부사항이 외부로 노출

평가: 위반당 🔴 또는 🟡. 없으면 🟢.

## 3. 엔트로피 (Entropy Detection)

- 중복 코드: 3회 이상 반복되는 유사 블록
- 패턴 불일치: 기존 코드베이스의 패턴과 다른 방식으로 구현
- ad-hoc 헬퍼: 공유 유틸리티가 있는데 새로 만든 경우
- 네이밍 불일치: 기존 컨벤션과 다른 네이밍

평가: 건당 🟡. 심각하면 🔴.

## 4. 테스트 충분성 (Test Adequacy)

- 변경된 로직에 대한 테스트 존재 여부
- happy path + error path 커버리지
- 새로운 함수/메서드에 대한 단위 테스트
- 통합 테스트 필요 여부 판단

평가: 테스트 없으면 🔴. 부분적이면 🟡. 충분하면 🟢.

## 5. 가독성 (Agent Readability)

"다음에 이 코드를 읽을 에이전트가 이해할 수 있는가?"
- 함수/변수 이름이 의도를 명확히 전달하는가
- 복잡한 로직에 주석이 있는가
- 파일 크기가 적절한가 (300줄 이하 권장)
- 매직 넘버, 하드코딩된 값이 없는가

평가: 건당 🟡. 없으면 🟢.

## 6. 보안 (Security)

신뢰 경계(외부 입력·사용자 데이터·네트워크)를 넘는 코드에서:
- 입력 검증: 신뢰 경계에서 검증·이스케이프 누락
- 인증/인가: 권한 검사 우회, 누락된 접근 제어, IDOR
- 인젝션: SQL/command/path injection — 그리고 prompt injection (code-reviewer.md 원칙 5와 연계)
- 비밀 노출: 하드코딩된 credentials/secrets, 로그·에러로의 민감정보 유출
- 위험한 연산: 안전하지 않은 역직렬화, SSRF, path traversal

평가: 신뢰 경계의 악용 가능한 결함당 🔴. 도달 가능성이 낮으면 🟡. 없으면 🟢.

## 지적하지 말 것 (억제 규칙)

> **불변**: `build-reviewer-payload.mjs` is the doctrine injector for all supported runtimes and reviewer roles. `extract-fp-doctrine.sh` remains only a Unix parity oracle. The anchor bodies below are byte-stable authority.

신호 대 잡음비를 위해 다음은 finding으로 올리지 않거나 강등한다:
<!-- fp-doctrine:start -->
- 변경과 무관한 pre-existing 이슈: diff 밖 기존 결함은 verdict에 반영 안 함(필요 시 "참고" 1줄)
- 린터/포매터가 자동 수정하는 스타일: 중복 지적 안 함
- 근거 없는 추측: 재현 경로·도달 조건을 제시 못 하는 "~일 수도"는 ℹ️로 강등
- 단순 취향: 동작·정확성에 영향 없는 개인 선호는 보고 안 함
<!-- fp-doctrine:end -->

> ⚠️ ultracode VOICE-6(refute된 finding은 무음 삭제 금지, confidence=low로 강등·보존)과는 **층위가 다름**: anti-criteria = "올리기 전 억제", VOICE-6 = "올라온 finding의 verify 후 처리".

## PRACTICAL DOCUMENT POLICY

For a validated protocol 3 document phase, document blockers are limited to a
concrete repository/artifact-grounded functional contradiction; implementation
infeasibility or a missing decision that prevents execution; reachable
safety/security/compatibility/migration/recovery/rollback harm; or acceptance
criteria incapable of objective verification.

Style, readability, naming, preference, and ungrounded speculation are
advisory/info or suppressed, not Warning/Critical pre-implementation blockers.
Missing future implementation/tests are implementation_verification evidence
with objective acceptance evidence, not document blockers. The policy is
role- and provider-independent; it does not apply to implementation phase.

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
