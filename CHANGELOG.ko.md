# 변경 기록

[English](./CHANGELOG.md) | **한국어**

deep-review의 모든 주요 변경 사항을 이 파일에 기록합니다. [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)와 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

## [Unreleased]

### 변경

- **디자인 리뷰 readiness 모드** — 설계 문서와 ADR은 이제 구현 가능성과 설계 건전성을 검토하고, 실행 가능한 계획은 실용적 full readiness를 유지합니다. 두 모드 모두 문구 완결성을 차단 사유로 삼지 않으며, 두 host는 동일하게 검증된 inline-route 정책을 받습니다.

## [2.6.0] — 2026-08-20

### 추가

- **Opt-in Grok/xAI reviewer** — `--grok` / `--no-grok`과 명시적인 Grok model/effort routing이 외부 privacy preflight 뒤에만 별도의 xAI-family vote를 추가합니다. 탐지와 일반 무플래그 리뷰는 Grok을 dispatch하거나 저장소 내용을 보내지 않습니다.

### 변경

- **닫힌 Codex-only expansion** — `--codex-only`가 이제 `--codex --no-opus --no-agy --no-grok`으로 확장되므로 Grok 활성화가 플래그의 문자 그대로인 provider 약속과 모순될 수 없습니다.

### 보안

- **관찰된 Grok 쓰기 강제** — `--permission-mode plan`만 테스트된 쓰기를 방지한다고 관찰된 control이며, 필수 `--sandbox read-only`는 v1.0.3에서 쓰기 장벽이 아니었습니다. 전후 mutation 제외는 완전한 coverage라고 주장하지 않고 제한된 hybrid fingerprint surface에 연결됩니다.

## [2.5.0] — 2026-08-17

### 추가

- **Suite model-router resolver overlay.** 로컬 role·rubric·wave·admission 이후에 opt-in suite overlay가 concrete model id, native effort, same-family fallback, provenance만 바꿀 수 있습니다. seats, families, rubrics, admission, critical floor는 바꾸지 않습니다. `suiteResolve` inject 또는 `features.suite_model_resolver: true`로 켭니다. 명시적 CLI model과 `automatic_model_routing: false`는 overlay를 건너뜁니다.

## [2.4.0] — 2026-08-02

### 보안

- **리뷰어 leaf 어댑터가 라우팅 플랜을 파일에서 읽지 않습니다.** 네 소비자(payload builder + 리뷰어 브리지 3개)는 애초에 플랜을 자기 route 하나로 축약해 쓰고 있었으므로, 그 route 를 `--execution-route-json` 으로 인라인 전달합니다. 플랜 파일은 분석 대상 저장소가 커밋할 수 있는 저장소 내부 경로(`.deep-review/tmp/routing-plan.json`)였고 `loadExecutionPlan` 은 출처 검증 없이 그것을 읽었습니다. 이제 어떤 어댑터도 읽지 않는 감사 사본입니다. 인라인 진입점은 `protocol_version` 을 `3.0` 으로 **고정**합니다 — 분기하면 `2.0` route 가 오류 없이 `assignment_role: standard` 로 떨어지고 rubric 검증을 건너뛰어 잘못된 rubric 텍스트가 신뢰 할당 헤더에 실립니다.
- 소비자 경계의 검증은 의도적으로 축소됩니다: 후보 집합 소속, provider/adapter 일치, `max_expansion_waves` 게이트, wave/required 교차검사, `maximum_reviewers` 상한은 단독 route 로 검사할 수 없어 synthesis 경계에서 계속 강제됩니다. synthesis 경계 자체는 여전히 오케스트레이터가 직렬화한 플랜 객체를 신뢰하며, 이는 변경되지 않았고 이 변경의 범위 밖입니다.

## [2.3.0] — 2026-08-01

### 변경

- **실용적 문서 정책** — 신뢰된 protocol 3 문서 assignment에 artifact phase, risk와 role/provider 공통 정책을 전달합니다. 저장소/아티팩트에 근거한 구체적 기능 모순, 실행을 막는 결정 누락, 도달 가능한 안전/보안/호환성/롤백 피해, 객관적으로 검증할 수 없는 acceptance criteria는 blocker로 남기고, 스타일·가독성·명명·취향·근거 없는 추측은 advisory/info로 처리합니다. 미래 구현/테스트 누락은 구현 검증 evidence이며 객관적으로 확인할 수 있습니다.
- **Readiness 소유 문서 판정** — `DOCUMENT_BLOCKED`는 `REQUEST_CHANGES`, deferred evidence가 있는 `READY_FOR_IMPLEMENTATION`은 `CONCERN`, 없는 READY는 `APPROVE`가 됩니다. 판정은 sealed Artifact Gate evidence에서 다시 계산하며 receipt schema에는 추가하지 않습니다.
- **문서 수렴** — finding만으로 pure document의 same-round reviewer를 늘리지 않습니다. reviewer minimum/floor와 readiness mismatch expansion은 fail-closed로 유지하고 구현 동작은 바꾸지 않습니다.

## [2.2.0] — 2026-07-28

### 변경

- **`agy` 가 opt-in 으로 바뀌었습니다.** `agy` CLI 가 탐지되어도 기본 리뷰어 집합에 들어가지 않습니다. `--agy` 로 켜며, `--codex` 와 동일하게 후보 자격과 선택을 모두 부여합니다. agy 를 겨냥한 model/effort 오버라이드는 후보 자격만 복원하고 선택을 강제하지 않으므로 기존 호출은 그대로 동작합니다.
- **기본 리뷰어가 4→3 으로 줄어듭니다.** 판정 규칙은 그대로(`N_actual` 구동)지만 critical 구현 하한의 리던던시 마진이 1→0 이 됩니다 — 리뷰어 1건만 실패해도 `no_unused_candidate` 후 `critical_reviewer_floor` 에 도달해 판정이 나오지 않습니다. fail-closed 이며 의도된 동작입니다. 마진이 필요하면 `--agy` 를 추가하세요.
- **`--no-opus` 와 `--no-opus --no-codex` 의 동작이 바뀝니다.** 전자는 Codex 단일 provider family 만 남아 `APPROVE` 가 `CONCERN` 으로 상한 처리되고, 후자는 남는 후보가 없습니다. 둘 다 `--agy` 로 복원합니다.
- 설정 키 `agy_enabled` 는 비활성으로 문서화했습니다. 애초에 코드 소비자가 없었으며, 강제 가능한 비활성화 수단은 `--no-agy` 입니다.

### 수정

- **진단 캡처만 넘쳤을 때 Codex 리뷰어의 완결된 보고서를 폐기하지 않습니다.** `run-codex-reviewer.mjs` 가 `captureOverflow` 를 종단 실패로 취급했으나, 이 플래그는 stdout/stderr 진단 버퍼만 자를 뿐 자식 프로세스에 시그널을 보내지 않습니다(`lib/process.mjs` 의 `appendCaptured`). 정식 보고서는 `--output-last-message` 로 기록되어 디스크에서 읽히므로, stderr 의 장황한 추론 트레이스가 공유 캡처 예산을 소진하면 완결된 계약 유효 보고서가 버려졌습니다 — 단일 리뷰 루프에서 3회 연속 재현되었습니다. 오버플로는 시도 provenance 에 그대로 기록되고, 읽을 보고서가 없는 오버플로는 여전히 fail-closed 이며, 잘린 stderr 는 model/effort fallback 재시도를 계속 억제합니다.

### 보안

- `agy` opt-in 은 argv 로만 전달되므로 저장소가 커밋한 설정 파일이 기본 라우팅 경로에서 agy 를 선출할 수 없습니다. 다만 저장소가 `review-policy.yaml` 로 자동 라우팅을 끈 경우에 대해서는 **보안 경계가 아닙니다** — 그 경로는 변경되지 않았고 별건으로 추적합니다.

## [2.1.0] — 2026-07-26

### 추가

- **Route별 Codex 제어** — 이제 Claude Code와 Codex에서 두 Codex reviewer 역할 모두 선택된 model과 reasoning effort를 전달받습니다.

### 변경

- **Host-native Codex transport** — Claude Code는 격리된 ephemeral read-only `codex exec` 세션으로 두 Codex 역할을 실행하고, Codex는 두 역할을 독립 history-free 네이티브 서브에이전트로 실행합니다.
- **Codex-only static gate** — 명시적인 non-critical `--codex-only --reviewer-strategy static` route는 critical reviewer-family floor를 약화하지 않으면서 두 Codex voice로 단일 family 제약을 충족할 수 있습니다.

### 제거

- **Companion 기반 review routing** — Codex companion 탐지는 2.x 환경 호환성을 위해 유지되지만 더 이상 reviewer 역할을 선택·실행·대체하지 않습니다.

### 보안

- Codex CLI report는 bounded non-symlink last-message 파일만 사용하고 ambient user config와 rule을 제외합니다. runtime model/effort 거부 retry는 명시적 fallback 승인이 필요하며 인증, timeout, 빈 출력, 모호한 오류, 일반 실패는 retry하지 않습니다.

## [2.0.0] — 2026-07-24

### 추가

- **Adaptive reviewer routing** — 단발 리뷰와 loop가 canonical reviewer identity를 유지하면서 `standard`, `feasibility`, `traceability`, `adversarial`, `security`, `confirmation` 역할을 결정적으로 선택합니다. Protocol `3.0` plan은 assignment rubric, wave, required 상태, model/effort, 사유, 전체 후보, reviewer floor, artifact phase, risk, progress를 결합합니다.
- **Progressive expansion** — provisional synthesis가 minimum 미달, 단독 critical/security finding, split concern, readiness 불일치에서 미사용 독립 reviewer를 정확히 한 명 추가한 뒤 모든 trusted attempt로 최종 verdict를 한 번 발행합니다.
- **Trusted synthesis boundary** — public synthesis CLI가 모든 attempt의 raw report와 fingerprint evidence를 다시 검증합니다. adaptive floor 실패는 한 번 원자적으로 대체하고, 명시적 required reviewer 실패는 operational error로 유지합니다.
- **Content-addressed readiness authority** — receipt 파일명이 문서 scope와 전체 sealed authority를 함께 바인딩하므로, 파일 내부를 다시 봉인해 risk·reviewer evidence·deferred finding을 축소할 수 없습니다.
- **Fail-closed plan admission** — synthesis는 이미 실패한 routing plan과 선택 route가 없는 voice를 거부하며, policy parser는 malformed/non-canonical classification override를 거부합니다.
- **문서 readiness** — 순수 design/spec/plan/ADR/test-plan 리뷰는 verdict와 별도인 `READY_FOR_IMPLEMENTATION`을 사용하고 sealed content-addressed receipt를 생성하며, 문서 round cap에서 `DOCUMENT_BLOCKED`로 종료합니다.
- **Receipt 연결 구현 리뷰** — `--readiness-receipt PATH`가 저장소/경로 containment와 현재 문서/리포트 hash를 검증하고, 모든 이월 acceptance item에 최신 구현 evidence가 생길 때까지 APPROVE를 막습니다.
- **공유 loop routing 문법** — loop가 매 라운드 reviewer strategy, routing, model/effort, fallback/classifier, receipt flag를 받습니다. round-state schema 2와 session summary가 assignment, wave, 절약 call, readiness, receipt, stop reason을 기록합니다.

### 변경

- Adaptive reviewer routing과 automatic model routing이 기본 활성화됩니다. `--reviewer-strategy static`은 eligible reviewer set을 고정하고 `routing_shadow_mode: true`는 적용 없이 관찰합니다. 둘을 함께 쓰면 정확한 2.0 이전 dispatch 호환 동작입니다.
- Risk는 `low|medium|high|critical`에서 단조롭게 유지됩니다. 순수 문서는 기본 2라운드(high/critical은 3), 구현은 명시적 `--max`가 없으면 5라운드를 유지합니다.
- 구현 reviewer floor가 높아졌습니다. low/medium은 cross-provider 2역할, high는 전문 3역할을 계획하고 부족 시 confidence floor, critical은 trusted reviewer 3명과 provider family 2개 미달 시 verdict 없이 실패합니다.
- Adaptive route가 실패해도 실제 reviewer/provider 최소값이 유지되면 문서화된 confidence floor를 적용하고, 명시적 reviewer/provider 요구만 identity-hard 제약으로 유지합니다.
- 유일한 expansion wave에서 required replacement가 실패하면 identity-hard로 처리해 verdict와 Phase 6 없이 종료합니다.

### 보안

- Readiness receipt는 stale/tampered content, symlink, 저장소/경로 escape를 `ERROR_READINESS_RECEIPT_STALE`로 거부합니다. fingerprint mutation exclusion, `N_actual=0`, mutation ownership, Phase 6 gate는 계속 fail-closed입니다.
- Capability cache 읽기·쓰기는 symlink 경로 구성 요소를 거부하며, companion 기반 Codex reviewer identity는 고정 invocation이 실제로 전달하는 assignment role만 노출합니다.
- Privacy preflight는 adaptive 선택이 agy를 선택한 뒤에만 실행되며, 선택 후 거부된 agy route는 최대 한 번만 재계획됩니다.

## [1.15.0] — 2026-07-21

### 추가

- **Semantic artifact classifier** — 모호한 텍스트 artifact가 제한된 semantic 분류를 opt-in할 수 있으며, 결정적 분류는 fallback으로 유지됩니다.
- **Reviewer capability registry** — protocol `2.0` adapter 계약이 host label을 capability로 간주하지 않고 현재 가용성, model/effort 지원, read-only enforcement, invocation transport를 기술합니다.
- **Model/effort 라우팅** — artifact 종류, risk, size, reviewer role로 reviewer별 검증된 execution plan을 만들며 model ID는 policy, user config, adapter alias에서만 가져옵니다.
- **라우팅 override** — 리뷰 전용 `--routing`, provider model/effort, reviewer model/effort, `--allow-fallback`, `--allow-classifier` 플래그를 정규화된 구조적 plan으로 전달합니다.
- **`review-policy.yaml`** — 팀이 `.deep-review/review-policy.yaml`에서 중첩 artifact 분류·라우팅 정책을 공유하고 별도의 user config와 병합할 수 있습니다.

### 변경

- 무플래그 dispatch 인자는 byte-identical하게 유지됩니다. 자동 route는 shadow-first이며 명시적 CLI override 또는 프로젝트 policy opt-in에서만 실제 적용됩니다.

### 보안

- Artifact 내용은 untrusted·bounded 데이터로 취급하고 argv 배열과 stdin으로 전송하며, secret-like 내용은 semantic classifier 호출 전에 fail-closed합니다.

## [1.14.0] — 2026-07-20

### 추가

- **deep-review-loop 수렴화** — 라운드 간 finding 상태를 결정적으로 기록·비교해 기존 자연어 기반 반복 판정을 대체합니다. 변경 사항이 반영되지 않은 채 정체된 라운드는 더 반복하지 않고 마지막으로 신뢰할 수 있는 verdict로 정지합니다. 루프에 종속되고 명시적으로 전달되는 `--prior-rounds-file` advisory 컨텍스트(파일 존재 여부로 키잉하지 않음)를 통해 각 라운드의 리뷰어가 이전 발견·반박 항목을 처음부터 다시 검토하지 않고도 재검증할 수 있습니다. 최종 루프 요약에는 `rounds_saved` 지표가 포함됩니다.
- **`--session-doc` (루프, opt-in)** — loop id로 키잉된 세션당 하나의 통합 리뷰 문서를 매 라운드 in-place로 재렌더합니다 — 현재 verdict, 라운드별 히스토리, 라인 드리프트를 추적하는 open-vs-resolved 롤업, 종료 후 최종 요약 포함. 라운드별 리포트와 그 fail-closed 계상은 그대로이며, 통합 문서는 모든 canonical 리포트 탐색 표면(응답 선택·recurring-findings export 포함)에서 제외됩니다.
- **Artifact-aware routing Phase 1** — `--dry-run` / `--explain-routing`(리뷰 전용, opt-in)이 리뷰 대상을 결정적으로 분류(코드, 설계 문서, 구현 플랜, 명세, ADR, 테스트 플랜, runbook, 설정, mixed)하고 confidence 스코어·provenance와 함께 계획을 출력한 뒤 리뷰어 실행 전에 정지합니다. 무플래그 동작은 byte-identical합니다. semantic 분류와 model/effort 라우팅은 이후 단계 예정입니다.

### 수정

- 리뷰 루프 라운드 상태 정리의 소유권을 일시적 셸 프로세스가 아닌 durable 호스트 세션에 바인딩 — 실행 중이지만 idle인 동시 루프의 상태는 절대 삭제되지 않으면서 crash 잔여물은 계속 회수되며, 부분 정리 실패는 재시도 가능하게 유지됩니다.
- 다중 범위 finding 인용(`path:1-2, 83-100`)을 누락하지 않고 파싱하며, `findings_signature`가 라운드 기록과 metrics에서 동일한 repo-root 기준으로 일치합니다.
- `findings_signature`가 Windows에서도 플랫폼 독립적·대소문자 보존으로 출력됩니다. win32의 대소문자 무시 identity 매칭은 그대로입니다.

### 보안

- Artifact 탐색이 심링크를 따라가거나 저장소 밖을 읽지 않습니다: 심링크는 metadata-only, 해석된 경로는 repo root 내부여야 하며, 읽기는 no-follow + open 후 검증 — 커밋된 심링크로 저장소 밖 파일 내용이 노출되지 않습니다.

## [1.13.0] — 2026-07-11

### 추가

- 네이티브 Codex 리뷰·대응 스킬과 호스트 인식 리뷰어·Phase 6 서브에이전트 디스패치로 Claude Code와 Codex 모두에서 공개 워크플로를 제공합니다.

### 변경

- 지원되는 리뷰, 루프, 뮤테이션, 리뷰어 브리지, Stage 5.5 반복 발견 내보내기, 대응 검증이 macOS, Linux, Windows 11의 무의존성 Node 22 런타임에서 실행됩니다.

### 수정

- Codex 기본 훅 검증, 프로세스 간 뮤테이션 복구, Stage 5.5 zsh shopt 노이즈, Windows 경로·타임아웃 동작, 리뷰어 뮤테이션 fail-closed 처리를 수정했습니다.

## [1.12.3] — 2026-07-07

### 수정

- **N=1 verdict 규칙을 Stage-4 합성 SSOT 에 인라인화 (#3)** — `review-execution.md` §5.1 실행 블록이 `N_actual == 1` 전용 분기(`1건 이상 → 🟡 CONCERN + "단일 리뷰어" 표기 / 0건 → 🟢 APPROVE + 표기`)를 인라인으로 담고, "단독 지적 → 참고" 강등을 `N_actual ≥ 3` 로 한정(`N_actual == 2` 는 1/2 → CONCERN 명시 분기 — codex-integration N-way 표와 동일; 3-way 이상에서만 단독 finding 을 참고로 강등). 이전에는 1-way 리뷰(예: `--codex-only`)를 문자 그대로 수행하면 모든 finding 이 참고로 강등돼 공허 APPROVE 가 될 수 있어, `codex-integration.md` 에 이미 있던 올바른 N=1 행과 상충했다. `codex-integration.md` 에 SSOT 정합 주석을 추가해 두 파일이 동일 매핑을 유지. verdict 결정 블록 자체가 "🟡만, 전원 일치 → REQUEST_CHANGES" 규칙을 `N_actual ≥ 2` 로 게이트하고, N=1 분기가 **최종(final)**임을 못박는 `N_actual == 1` 명시 예외를 추가한다(단독 리뷰어의 1건은 "전원 일치"가 자명하므로 게이트가 없으면 1-way CONCERN 이 REQUEST_CHANGES 로 조용히 승격돼 N=1 분기가 무력화됨). `report-format.md` verdict 규칙 목록에도 미러링하고 `test-verdict-synthesis-ssot.sh` 로 고정. N≥2(2/3/4-way) 매핑은 그 외 불변. **행동 변경:** N=1 에서 🔴(critical/security) finding 은 이제 CONCERN 으로 강등하지 않고 REQUEST_CHANGES 를 낸다(단일 리뷰어 표기 유지) — 단독 리뷰어의 critical 은 blocking 이며 일반 "🔴 → REQUEST_CHANGES" 규칙 및 `review-criteria.md` severity 원칙과 정합; 🟡만인 N=1 리뷰만 CONCERN 유지. 매핑 SSOT 인 `codex-integration.md` N=1 표의 `1/1` 행을 🔴/🟡 두 행으로 분리.
- **codex-only 을 opus-degraded 가드에서 제외 (#3-파생)** — Stage 4.3.1 degraded 마커(`review-execution.md` §4.3.1 및 `report-format.md`)를 `claude_reviewer != none AND opus_status != success AND N_actual_external ≤ 1` 로 정정. 계획된 1-way `--codex-only`/`--no-opus`(Opus 미spawn, `opus_status = not_planned`)가 더 이상 CONCERN 으로 강제 강등되지 않는다. `opus_status` 도메인 sentinel 주석(`not_planned`)을 추가. **Floor 의미(R4):** degraded 가드는 이제 덮어쓰기가 아니라 신뢰도 *floor* 다 — 🔴/critical finding 이 있으면 REQUEST_CHANGES 를 보존(degraded 마커만 병기, 강등 금지)하고 APPROVE 만 CONCERN 으로 상향한다. 이전에는 CONCERN 을 강제해, Opus 타임아웃 + Codex critical 발견 시 blocking verdict 를 fail-open 할 수 있었다.
- **`restore_attempts` 3-strikes 에스컬레이션 도달 가능화 (#1)** — `restore_mutation` 이 `git rm --cached --ignore-unmatch`(항상 exit 0) 이후 각 복원 대상 intent-to-add 엔트리를 재검사하고, protocol 이 만든 엔트리가 잔존하면 state 파일을 보존하고 non-zero 를 반환한다(lock 은 해제). 이로써 `auto_recover` 의 `restore_attempts` 카운터가 세션 간 누적되어, 광고된 "3회 이상 실패 시 에스컬레이션" 경로가 write-only dead 가 아니라 실제로 도달 가능해진다. 정상 복원 경로는 불변. **(R4)** `git rm` 파이프라인 자체를 errexit-안전하게: 실제(`--ignore-unmatch` 아닌) `git rm` 실패를 명시 캡처(`if ! … ; then`)해, errexit 호출자 아래서 함수가 중간에 중단되지 않는다 — 실패 시 state 보존 + lock 해제 + non-zero 반환(동일 에스컬레이션 경로 합류)하여 lock/state 가 half-recovered 로 남지 않는다.

### 내부

- **CI 테스트 열거 드리프트 가드 (#2)** — orphan 이던 `test-extract-anchor.sh` 를 `tests.yml` 에 등록하고, `hooks/scripts/test/test-*.sh` 중 어느 워크플로우 `run:` 스텝/`npm test` 에도 호출되지 않은 테스트를 실패시키는 CI 게이트 `scripts/check-test-ci-enrollment.sh`(+단위 테스트)를 추가. 가드가 다른 워크플로우 편집에서도 트리거되도록 `tests.yml` `pull_request.paths` 를 `.github/workflows/**` 로 확장. 열거 코퍼스는 이제 워크플로우 `run:` 스텝에서 실제 도달하는 package.json script(`npm test`→`scripts.test`, `npm run <name>`→`scripts.<name>`) 값만 인정 — 어느 run: 도 호출하지 않는 script(예: `test:all`/`test:local`)에만 언급된 테스트는 더 이상 false-pass 로 통과하지 못한다. 별개로, `phase6-protocol.yml` 의 `paths` 필터에 `skills/deep-review-workflow/**` 를 추가해 `init-setup.md`(를 `test-phase6-subagent.sh` 가 읽음)만 바꾼 PR 도 phase6 스위트를 발화하게 했다 — 그 테스트의 신규 check 12 로 핀. 열거 가드 헤더에 스코프 한계를 명문화: 본 가드는 *등록*(어느 워크플로우가 테스트를 실행하는가)만 검증하며 *트리거 경로 커버리지*(테스트가 읽는 소스 변경에 그 워크플로우가 발화하는가)는 검증하지 않고, 일반 트리거-커버리지 검증기는 의도적으로 비스코프.
- **`.gitignore` 강화** — `.claude/` 런타임 상태(hook 입출력 + 센서 캐시)를 제외해, dogfooding 중 `git add -A` 한 번으로 세션 전사가 공개 소스 저장소에 유출되지 않도록 함.

## [1.12.2] — 2026-06-23

### 변경

- **thin-dispatcher Phase B (내부 리팩토링, 동작 보존)** — 리뷰 모드 본문을 `commands/deep-review.md`에서 on-demand 참조 파일(`skills/deep-review-workflow/references/review-execution.md`, Stage 5.5용 `skills/deep-review-workflow/references/recurring-findings-export.md`, `--entropy`용 `skills/deep-review-workflow/references/entropy-scan.md`)로 추출. 커맨드는 route-first thin router(~53줄)로 전환: `init` / `--respond` / `--qa` 경로가 더 이상 `deep-review-workflow` 스킬을 적재하지 않음(비-리뷰 호출 시 컨텍스트 적재 절감). 라인번호 SSOT 앵커(`:172` / `:505-508` / `:478-485`)를 이름 기반 `<!-- SSOT:name -->` HTML 주석 앵커로 전환하고, 공유 `extract_anchor` / `assert_anchor_singleton` 테스트 헬퍼로 추출·검증. SKILL split-brain 해소(실행 SSOT = `review-execution.md`). **동작 / 플래그 / verdict 불변.**

## [1.12.1] — 2026-06-23

### 변경

- **thin-dispatcher Phase A (내부 리팩토링, 동작 보존)** — `--respond`·`init` 모드 본문을 1628줄 `commands/deep-review.md`에서 on-demand 참조 파일(`skills/receiving-review/references/respond-execution.md`, `skills/deep-review-workflow/references/init-setup.md`)로 추출하고, 그 자리에 dispatch 스텁을 남김. 커맨드는 1628 → 1136줄로 축소; `--respond`·`init` 절차는 해당 모드 실행 시에만 적재되어 공통 리뷰 경로가 가벼워짐. 리뷰 모드 영역(커맨드 1–1122줄, `:172` diff-제외 및 `:505-508` claude-bridge 라인번호 앵커 포함)은 byte-identical — 동작 변화 없음. 단일 구조 스위트 게이트 `scripts/run-all-tests.sh`(`npm run test:all`) 추가(npm 테스트 + `test-helpers.sh` 제외 모든 `hooks/scripts/test/test-*.sh`). 상단 thin-router(route-first) 재구조화, 리뷰 모드 추출, 라인앵커 디앵커는 Phase B로 이관.

## [1.12.0] — 2026-06-22

### 추가

- **FP-억제 독트린 주입 (#2)** — `extract-fp-doctrine.sh`가 단일 소스 독트린 파일에서 `fp-doctrine` + `fp-conservative` 블록을 HTML 주석 마커로 추출(블록별 엄격 검증, fail-closed)하고 `build-reviewer-payload.sh`를 통해 Opus 리뷰어 프롬프트, 모든 ultracode 샤드, agy 페이로드에 주입. 억제 규칙과 함께 conservative-balance 반대 가중치가 항상 공동 주입됨. 적대적 리뷰어는 의도적으로 제외.
- **`change_files` 교차 파일 매니페스트 (#3)** — `build-change-files.sh`가 NUL-safe, 상태 인식 교차 파일 매니페스트를 생성. 이름 변경/복사 감지(`-M -C`), 추적되지 않은 파일 유니온, 초기 커밋 처리, `python3 -c`를 통한 파일 경로 JSON 인코딩 포함. 200개 항목 제한. 매니페스트는 `build-reviewer-payload.sh`를 통해 공유 리뷰어 페이로드에 추가(diff-last 지시문 주의 순서).

### 변경

- `build-reviewer-payload.sh`가 모든 Claude · agy 리뷰어가 사용하는 순서 있는 페이로드를 조합: 독트린 블록 → 컨텍스트 → change_files 매니페스트 → diff(마지막, 지시문 주의 우선순위용).
- `commands/deep-review.md`가 모든 리뷰어 경로에 `extract-fp-doctrine.sh` + `build-change-files.sh` + `build-reviewer-payload.sh`를 연결. 페이로드 빌더가 사용 가능할 때 직접 diff 주입을 차단하는 Strict-Focus 가드 추가.
- ultracode 샤드가 공유 페이로드에서 독트린 + change_files를 상속(Task 5); `skills/deep-review-workflow/references/report-format.md`에 `change_files` 크기 초과/누락 경고 추가.

### 보류

- 위조방지 게이트(#1) 보류 — `diff_integrity` + 안정적인 finding ID + receiving-review/recurring/loop 제약 조건이 갖춰질 때까지 안전하게 출시 불가(spec §9.1 참조).

## [1.11.0] — 2026-06-16

### 추가

- **보안 리뷰 관점(6번째 기준)** — `review-criteria.md`에 보안 관점 추가(입력 검증, 인증/인가 우회, 인젝션(prompt injection 포함), 비밀 노출, 위험한 연산). recurring-findings `security` taxonomy와 1:1 대응. ultracode 샤드 5→6, quorum을 `floor(n/2)+1`(=4)로 공식화.
- **severity 기준** — severity = 영향 × 도달 가능성. diff로 도달 가능성을 확정 못하면 강등하지 않는 보수적 기본값.
- **anti-criteria** — 억제 규칙(pre-existing, 린터 자동수정 스타일, 근거 없는 추측, 단순 취향)으로 리뷰 노이즈 감소.

## [1.10.0] — 2026-06-09

### 추가

- **합성 리뷰어 플래그** — `/deep-review` · `/deep-review-loop` 에 `--ultracode`(멀티에이전트 Claude fan-out, 5차원 샤드 → 단일 "Claude(ultracode)" 보이스), `--codex`(Codex 2-way 강제), `--no-codex` / `--no-opus` / `--no-agy`, 슈가 `--codex-only`(= `--codex --no-opus --no-agy`) 추가. 무플래그 = 기존 동작 100% 유지.
- **하이브리드 fan-out** — Claude Code + Workflow 도구 가용 시 `--ultracode`가 `Workflow` 도구(차원 fan-out + 적대 verify)를 사용하며, 그 외 런타임은 `run-claude-reviewer.sh` 브리지 병렬 에이전트로 폴백. 신규 `skills/deep-review-workflow/references/ultracode-integration.md` 가 collapse 알고리즘 단일 출처.
- **deep-review-loop 통합 캐던** — `--ultracode --codex` 루프는 ultracode 1회(라운드 1) + codex 매 라운드. `--codex-only` 는 외부 ultracode + codex 루프 역할분담에 활용. 2단 전달 규약 + `ultracode_consumed` 기반 codex-down 분기.

### 변경

- Phase 6 `source` enum 에 `Opus (ultracode)` / `opus-ultracode` 추가.
- Review Mode 라벨 확장(ultracode / agy-only / fallback 변형); `opus_status` fan-out collapse 규칙 — disjoint quorum 밴드(failed=0, partial=1–2, success≥3; 쿼럼 미달 시 degraded).
- findings_signature line 버킷을 고정 버킷 `floor(line/7)` 으로 통일하여 결정적 정체 감지.

### 보안

- `--no-agy` 가 Stage 3.5 민감파일 ack 게이트를 short-circuit — agy 제외 시 민감파일 스캔 프롬프트를 표시하지 않으며 `agy_sensitive_acked_fingerprint` 도 변경하지 않음.

### 보류 / 알려진 한계

- ARCH-6(path-B verify-equivalence 라벨), ARCH-8(비-Claude 직렬 브리지 partial-failure 예산), SEC-3(토큰 비용 가드레일: Y/N 프롬프트 + verify 패널 top-K 상한)은 후속 릴리스에서 처리 예정.

## [1.9.0] — 2026-06-04 (agy 모델 티어 + 더 빠른 hybrid fingerprint)

### 추가

- agy 리뷰어 모델 티어를 `.deep-review/config.yaml` 의 `agy_model` (또는 `AGY_MODEL` env) 로 설정 가능. 기본값 `Gemini 3.5 Flash (High)` — 리뷰는 bounded read 작업이므로 더 빠른 티어. 지원하지 않는 값은 agy 기본 티어로 폴백.

### 수정

- agy 의 `hybrid` fingerprint 모드가 sub-second 로 빨라짐 (이전엔 리뷰마다 수 초의 불필요한 로컬 작업이 추가됐다). 기본값으로 유지하면서도 파이프라인을 느리게 하지 않는다.

## [1.8.1] — 2026-05-25 (agy read-only 강제)

### 수정

- agy 리뷰어가 Stage 4 합성 단계가 아니라 Stage 3 리뷰 *도중에* Edit/Write 수정을 워크스페이스에 적용할 수 있던 문제. agy bridge가 파일/git/상태 변경을 금지하는 read-only 프리앰블(ASCII 전용, locale-safe)을 프롬프트 앞에 삽입하도록 변경. 변경이 발생하면 pre/post 워크트리 fingerprint에 걸려 agy 결과가 N-way 합성에서 제외된다.

### 변경

- read-only 프리앰블용 argv 여유 확보를 위해 agy 프롬프트 본문 한도를 200 KB → 198 KB로 하향.

## [1.8.0] — 2026-05-22 (symlink·디렉토리명 커버리지)

### 추가

- 사이드카 `sensitive-patterns-dir-match.list` 로 선택된 민감 패턴이 디렉토리명 매칭에 opt-in 가능 (`credentials*`, `bearer_*` 기본 활성).
- 민감 스캔·런타임 상태 스냅샷·full-walk 모드가 공유하는 symlink-aware 워크트리 fingerprint.

### 수정

- in-repo 파일(≤ 16 KB)을 가리키는 기존 런타임 상태 symlink(`config.yaml`, `.pending-mutation.json`)도 스냅샷되어 symlink를 통한 쓰기가 감지된다.
- full-walk·hybrid 민감 스캔이 일반 파일과 함께 symlink도 열거.
- symlink 해석이 40 링크에서 제한되어 무한 대기 대신 명확한 cycle 메시지로 실패.

## [1.7.2] — 2026-05-22 (hybrid 커버리지 보강)

### 수정

- hybrid 모드 민감 스캔이 bilateral-wildcard 패턴에 대해 토큰이 디렉토리명에만 있는 gitignored 시크릿(예: `./secrets/config.json`)도 감지.
- hybrid 모드가 `.deep-review/config.yaml`과 `.deep-review/.pending-mutation.json`을 해싱하여 agy가 자체 bridge 설정/락 상태를 변경하는 것을 감지.

## [1.7.1] — 2026-05-22 (agy fingerprint hybrid 모드)

### 변경

- 기본 agy fingerprint 모드가 `full-walk` → `hybrid`(`git status` + dirty 파일별 SHA-256 + 집중 민감 패턴 스캔)로 변경되어 대형 repo에서 약 100× 빨라짐. 이전 동작은 `config.yaml`의 `agy_fingerprint_mode: full-walk` 또는 `AGY_FINGERPRINT_MODE=full-walk`로 복원.

### 추가

- `lib/sensitive-patterns.list` — mutation 프로토콜과 agy bridge가 함께 읽는 공유 민감 패턴 데이터.
- `agy_fingerprint_mode` 설정 필드 및 `AGY_FINGERPRINT_MODE` 환경변수 override; 모드 `hybrid` | `full-walk` | `git-status` | `off`.
- `off` 모드는 mutation 감지를 명시적으로 해제 (agy가 워크트리를 변경하지 않음이 확실할 때만 사용).

## [1.7.0] — 2026-05-20 (agy 4-way 리뷰 통합)

### 추가

- **교차 모델 파이프라인의 4번째 리뷰어로 Google Antigravity CLI(`agy`) 추가** — Opus + Codex review + Codex adversarial과 cross-vendor-family 병렬.
- cross-vendor 반대 의견 신호를 보존하는 4-way verdict 합성과 spawn 전 fingerprint 기반 민감 파일 확인.
- `agy_notified`, `agy_enabled`, `agy_sensitive_acked_fingerprint` 설정 필드 (기존 사용자 자동 마이그레이션, `agy_enabled: false` opt-out 보존).

### 변경 없음

- Codex mutation 프로토콜(`git add -f -N` + 락)은 codex 전용 유지; agy는 직교적인 `--add-dir` walk 사용.

## [1.6.1] — 2026-05-18 (Codex 네이티브 플러그인 manifest 및 AGENTS 가이드)

### 추가

- `.codex-plugin/plugin.json` — Claude Code manifest와 동일한 skill/hook 표면을 가리키는 Codex 네이티브 manifest.
- `AGENTS.md` — runtime surface, 검증, suite marketplace 갱신 단계를 다루는 Codex 프로젝트 가이드.

### 변경

- README가 기존 Claude Code 표면과 함께 Codex 호환성을 명시.

## [1.6.0] — 2026-05-16 (`/deep-review-loop` 가 user-invocable 스킬로)

### 변경

- `/deep-review-loop` 가 슬래시 커맨드에서 `user-invocable: true` 스킬로 이전되어 Codex CLI / Copilot CLI / Gemini CLI / Agent SDK에서 `Skill({ skill: "deep-review:deep-review-loop" })` 로 호출 가능. Claude Code에서는 `/deep-review-loop` 슬래시 진입이 그대로 동작하며, loop 동작은 변경 없음.

## [1.5.1] — 2026-05-13 (스킬 문서 정리)

### 수정

- 스킬/스펙 문서와 실제 shipped 산출물 간 문서 drift 해소 (비표준 agent frontmatter 필드 제거, dangling 상호 참조 정리, Phase 6 그룹 dispatch 규칙 single-source화). 커맨드/훅/런타임 동작 변경 없음.

## [1.5.0] — 2026-05-13

### 추가

- **`/deep-review-loop`** — `/deep-review`(리뷰)와 `/deep-review --respond`(대응)을 연속 실행하며 수렴까지 반복. `--contract [SLICE-NNN]` / `--entropy`(매 라운드 전달)와 `--max=N` 안전장치(기본 5, Review 호출만 카운트)를 수용. 자연 수렴(`APPROVE`, 🔴/🟡 없음), `--max` 도달, findings 정체, 운영 오류 누적, 사용자 중단 중 하나로 종료.

### 변경

- Codex 호출당 timeout을 300s → 900s로 상향. 대형/rate-limit diff에서 유효한 3-way 리뷰가 1-way로 강등되던 false-positive timeout 제거.
- mutation 락 orphan window를 600s → 1200s로 상향하여 새 900s 호출당 timeout 위에 유지 (`REVIEW_TIMEOUT_SECONDS`로 override).

## [1.4.2] — 2026-05-12 (cross-platform `stat` 수정)

### 수정

- `mutation-protocol.sh` 가 락 mtime을 BSD `stat -f %m` 먼저 해석했는데, Linux에서는 이것이 silently 오작동(GNU `-f`는 "filesystem status" 의미)하여 락 복구가 깨졌다. stat 순서를 GNU `-c %Y` 먼저, BSD `-f %m` fallback으로 반전.

## [1.4.1] — 2026-05-12

### 추가

- 잔여 락 + crashed mutation이 무관한 사용자 staging과 공존할 때의 mutation 락 stale-recovery 통합 테스트 추가 (orphan 감지, 락 해제, 사용자 staging 보존). 테스트 전용; 런타임 변경 없음.

## [1.4.0] — 2026-05-08

### 추가

- `.deep-review/recurring-findings.json` 을 M3 cross-plugin envelope으로 emit하며, 소비한 deep-work session-receipt의 `run_id`를 `parent_run_id`로 chain하여 교차 플러그인 trace 제공.

### 변경

- Stage 3 receipt loader와 recurring-findings emitter를 envelope-aware로 전환 (strict producer/artifact_kind/schema identity guard); foreign·corrupt envelope은 경고와 함께 skip.

### 호환성

- wrap된 payload(`findings`, `taxonomy_version`, `updated_at`)는 같은 shape 유지. legacy 최상위 `findings[]` 를 읽던 pre-envelope consumer는 envelope-aware unwrap으로 업그레이드하거나 `payload.findings`를 직접 접근해야 함; 6개월 마이그레이션 윈도우 적용.

## [1.3.4] — 2026-04-24

### 추가

- Phase 6 위임 스펙을 on-demand 참조로 ship (이전에는 blanket-ignore된 `docs/`에 있어 전달되지 않았음).

### 변경

- Phase 6 그룹 커밋이 staged·unstaged rename을 모두 읽어 subagent의 `git mv`가 allowlist를 벗어나지 못하게 함; binary 파일은 `git hash-object`로 delta 감지.
- 런타임 경고 문구를 리뷰/대응 UI 전반과 일치하도록 한국어로 통일.

### 수정

- pre-dirty outside 파일을 통한 allowlist 우회 — Phase 6 검증이 dispatch 전 dirty 집합 전체의 content hash를 스냅샷하여 allowlist 밖 변경을 플래그.
- dirty recovery가 실패한 subagent의 `git add` / `git mv` 후 워크트리뿐 아니라 git index도 복원.
- recovery가 tracked-but-deleted WIP 구분을 보존 (` D` 가 `D ` 로 변질되지 않음).
- macOS bash 3.2 호환성 — Phase 6 스니펫의 `declare -A` 를 TSV 임시 파일로 교체.

## [1.3.3] — 2026-04-24

### 추가

- `phase6-implementer` 서브에이전트 — `/deep-review --respond`가 자동 dispatch하는 Phase 6 구현 전용 에이전트.
- `implementation_guide.modifiable_paths` — Phase 6 allowlist에 acceptance 충족에 필요한 companion 파일(test/fixture/helper)을 포함.

### 변경

- `/deep-review --respond` Phase 6가 심각도 그룹별로 `phase6-implementer` 서브에이전트에 위임되며, dispatch 실패 시 in-session graceful fallback.
- 대응 리포트 Summary에 `execution_path` 필드(`subagent | main_fallback | mixed | n/a`) 추가.
- Fail-closed main 검증: `files_changed`를 정규화하고 `git hash-object` content 스냅샷으로 비교; allowlist 밖·되돌려진 경로는 `execution_status=error`로 라우팅하고 commit/PR 게시를 억제.
- 그룹 커밋은 비그룹 경로용 `:(exclude)` pathspec과 함께 `git commit --only` 사용; dirty recovery는 파일별 content baseline으로 복원.

## [1.3.2] — 2026-04-21

### 추가

- **Codex 자동 노출 프로토콜** — `/deep-review`가 세션에서 편집 중인 gitignored 파일을 감지해 Codex에 임시 노출(`git add -f -N`)하여 교차 모델 리뷰를 수행. `mkdir` 기반 atomic 락과 `.pending-mutation.json` 상태 파일로 보호.
- 공유 `mutation-protocol.sh` Bash 라이브러리 (bash 3.2 호환, macOS + Linux 테스트).
- Codex 인증 오류 감지 + 전용 "`!codex login` 후 재시도" 안내, "플러그인 설치됨 but node 없음"을 일반 실패와 구분하는 Node.js 가용성 probe.
- 민감 파일 스캔(40+ 패턴: dotenv, credentials, SSH 키, GCP 서비스 계정, `.pgpass`, `.netrc`, `wrangler.toml`, JWT) case-insensitive 매칭; 전원 민감 파일이면 자동 skip.
- mutation 실패 시 1-way Opus 단독 리뷰로 graceful fallback, crashed 세션의 stale mutation 자동 회수(사용자 실제 staging 보존).

### 수정

- Codex companion은 `--scope <auto|working-tree|branch>` 만 수용하는데 기존 `--uncommitted` 플래그는 silently 거부되고 있었다. 모든 호출 지점을 `--scope working-tree`로 교정.
- `review_base`로 쓰이던 empty-tree fallback SHA를 정식 git empty-tree 해시로 교정.

### 변경

- 3-way 리뷰가 git repo + Codex 플러그인만 요구하도록 변경(기존 "커밋 존재" 요구 제거 — 첫 커밋 전 repo도 교차 모델 리뷰 가능).

### 폐기 예정

- `detect-environment.sh` 출력의 `codex_installed` 필드 (`codex_plugin` 사용); 추후 릴리스에서 제거 예정.

## [1.3.1] — 2026-04-17

### 수정

- 공개 repo `.gitignore`가 `.deep-review/`와 `docs/`를 완전히 ignore; downstream 사용자는 여전히 `/deep-review init`에서 세분화된 안내를 받는다.
- WIP 커밋 안전화 — `git add -A` 제거; 제안 전 파일 목록 미리보기, 민감 패턴 경고, `git reset --soft HEAD~1` 원복 힌트.
- adversarial focus 파일을 `mktemp` + `chmod 600` + 정리로 처리해 `/tmp` race·symlink 공격 표면 제거.
- `config.yaml`을 `Edit` tool로만 갱신하여 사용자 수정 필드·미지 필드 보존.
- 리포트 파일명에 `{HHmmss}` 타임스탬프 추가로 recurring-findings 카운트를 오염시키던 같은 날 덮어쓰기 제거.
- 리뷰어 system prompt과 PR 코멘트 수집에 prompt-injection 방어 추가; 의심 문구는 보안 이슈로 플래그.

### 변경

- portable `_timeout` shim(`gtimeout`/`timeout` 우선, `perl alarm` fallback)으로 macOS에서 교차 모델 리뷰가 1-way로 silently 강등되지 않도록 함.
- Contract YAML을 PyYAML 부재 시 LLM 파싱으로 degrade하는 `yaml.safe_load` 래퍼로 로드; malformed contract는 경고와 함께 skip.
- Stage 3 대용량 diff 처리: 크기 기준 라우팅, 디렉토리 그룹 순차 spawn, 크기 상한 경고.
- `--respond`의 "가장 최근"을 `*-review.md` glob의 mtime으로 정의; `--pr=NNN` override와 실패한 PR 코멘트 게시의 idempotent 재시도 추적 추가.

## [1.3.0] — 2026-04-16

### 추가

- **Stage 5: Receiving Review** — 증거 기반 대응 프로토콜(READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT)로 맹목적 동의를 차단하고 모든 판단을 코드 증거로 뒷받침.
- **`/deep-review --respond`** — 가장 최근 리뷰 리포트 또는 지정 경로로 대응 모드 진입.
- **`/deep-review --respond --source=pr`** — `gh api`로 GitHub PR 리뷰 코멘트에 대응, 인라인 코멘트에 스레드 답글.
- `receiving-review` 스킬 — source 신뢰도 매트릭스, 금지 표현 차단, 합리화 탐지로 프로토콜을 가이드.
- Response Report — 수락/반박/보류 결정을 evidence와 함께 구조화하여 `.deep-review/responses/`에 저장.

### 변경

- `REQUEST_CHANGES` verdict가 3가지 선택지 제공: 증거 기반 대응(기본), `codex:rescue` 위임, 수동 처리.

## [1.2.0] — 2026-04-14

### 추가

- **Stage 5.5 반복 발견 패턴 내보내기** — taxonomy 기반(7 카테고리) LLM 분류로 반복 패턴을 `recurring-findings.json`에 기록, deep-evolve가 소비하여 실험 방향 조향.

## [1.1.2] — 2026-04-12

### 수정

- Codex review 호출이 `codex:rescue`로 잘못 라우팅되던 문제; Codex companion을 Bash tool로 직접 호출.
- 쉘 인젝션 — repo 제어 파일의 `focus_text`를 쉘 명령에 삽입하지 않고 stdin으로 전달.
- Codex 플러그인 경로 부재 시 `detect-environment.sh`가 중단되지 않도록 수정.
- dirty tree 리뷰 불일치 — Codex와 Opus가 동일한 변경을 리뷰.

### 변경

- Codex 감지를 `codex_plugin`(Claude Code 플러그인)과 `codex_cli`(독립 CLI)로 분리, "CLI가 감지되었지만 플러그인이 필요합니다" 맞춤 안내.

## [1.1.1] — 2026-04-11

### 변경

- 모든 리뷰어(Opus 서브에이전트, Codex review, Codex adversarial)를 백그라운드 실행하고, spawn 전 리뷰어 구성을 표시하며, 실제 완료된 리뷰어 기준 N-way 합성으로 결과 수집.

## [1.1.0] — 2026-04-09

### 추가

- `fitness.json` 통합 — Stage 3가 컴퓨테이션 아키텍처 규칙을 리뷰어 프롬프트에 주입하여 아키텍처 의도 인식 리뷰 수행.
- Receipt `health_report` 통합 — Stage 3가 최신 deep-work 세션 receipt를 발견하고 `scan_commit` stale 여부를 확인해 drift/fitness 컨텍스트를 주입.
- `/deep-review init`이 추론 규칙(`rules.yaml`)과 컴퓨테이션 규칙(`fitness.json`)의 차이를 설명하고 deep-work Phase 1 자동 생성으로 안내.

## [1.0.0] — 2026-04-08

### 추가

- 독립 Opus 서브에이전트 코드 리뷰.
- Codex 교차 검증(`codex:review` + `codex:adversarial-review`).
- Sprint Contract 소비 및 검증.
- 엔트로피 탐지.
- 환경 자동 감지(git / non-git, Codex 유무).
- `/deep-review init` — 프로젝트별 규칙 초기화.

### 변경

- `--contract`가 slice 특정 contract 로딩을 위해 `SLICE-NNN` 지원; `status: active` contract 자동 로드, 아카이브된 contract 제외.
- 리뷰 기준을 command, skill, README에 걸쳐 정렬.

### 수정

- change state에 관계없이 항상 untracked 파일을 리뷰에 포함. *(v1.12.0에서 정제: untracked 유니온은 이제 dirty 상태에만 적용되며 `clean`은 제외됨.)*
- Codex 합성 규칙을 verdict 로직과 정렬(2/3 → `CONCERN`).
- 무음 성능 저하를 방지하기 위한 Codex preflight 체크 추가.
- shallow clone 처리, 아카이브된 contract 필터, malformed YAML 오류 처리 추가.
