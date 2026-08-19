[English](./README.md) | **한국어**

# deep-review

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/deep-review?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/deep-review)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/deep-suite)

AI 코딩 에이전트를 위한 독립 Evaluator 플러그인 — Codex 연동 교차 모델 코드 리뷰와 Sprint Contract 지원.

AI 코딩 에이전트에는 구조적 맹점이 있습니다: 자신이 작성한 코드를 스스로 리뷰합니다. 코드를 작성한 에이전트가 그것을 판단하므로 자기 승인 편향이 구조적으로 내재합니다. deep-review는 원본 세션의 추론·의도·가정이 아니라 공유 리뷰 페이로드만 보는 **별도의 reviewer context**로 구조적으로 독립된 평가를 수행합니다. Claude Code는 격리된 `codex exec` 세션으로 두 Codex reviewer 역할을 호출하고, Codex는 history-free 네이티브 서브에이전트로 두 역할을 호출합니다. 선택적 Claude와 `agy` 역할은 교차 모델 검증 범위를 넓힙니다.

## deep-suite에서의 역할

deep-review는 [deep-suite](https://github.com/Sungmin-Cho/deep-suite)의 **독립 평가자**로, [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) 프레임워크의 Generator–Evaluator 분리를 구현합니다:

- **Inferential 센서** — Generator 컨텍스트 없는 독립 Opus 서브에이전트 리뷰. computational 센서가 잡지 못하는 의미론적 문제의 주요 품질 게이트.
- **교차 모델 검증** — Opus + Codex review + Codex adversarial (+ agy). 프레임워크의 "LLM-as-judge" 개념을 초과.
- **Fitness 인지 리뷰** — [deep-work](https://github.com/Sungmin-Cho/deep-work)의 `fitness.json` 규칙과 `health_report`를 소비하여 아키텍처 의도 인지 평가.
- **Sprint Contract 검증** — 구조화된 성공 기준 확인.

## 설치

`claude-deep-suite` marketplace를 통해:

```bash
# Claude Code
/plugin install deep-review@claude-deep-suite

# Codex
codex plugin install deep-review
```

추가 설정은 필요 없습니다. 첫 실행 시 기본 `config.yaml`과 함께 `.deep-review/`가 생성됩니다. 프로젝트별 `rules.yaml`을 생성하려면 `/deep-review init`을 실행합니다.

지원 런타임은 macOS, Linux, 네이티브 Windows 11에서 동작하는 무의존성 Node.js 22와 Git 2.45 이상입니다. Git Bash는 필수 조건이 아닙니다.

## 사용법

Claude Code 슬래시 커맨드와 Codex 스킬은 동일한 라우트 문법을 위한 서로 다른 호스트 진입점입니다.

### Claude Code

| 커맨드 | 설명 |
|---|---|
| `/deep-review` | 독립 Opus 서브에이전트로 현재 변경사항 리뷰 (Codex/agy 존재 시 교차 모델) |
| `/deep-review --ultracode [--codex]` | 6개 집중 Claude reviewer context를 단일 "Claude(ultracode)" 보이스로 collapse하고, 단일 브리지 fallback을 명시적으로 표시하며 선택적 Codex 역할 추가 |
| `/deep-review --codex-only` | Claude 리뷰어를 끄고 사용 가능한 Codex 역할만 실행 |
| `/deep-review --contract [SLICE-NNN]` | Sprint Contract 기반 구조적 검증 |
| `/deep-review --entropy` | 엔트로피 스캔 (중복, 패턴 드리프트, 네이밍 불일치) |
| `/deep-review --respond [REPORT_PATH]` | 증거 기반 프로토콜로 리뷰 피드백 대응 |
| `/deep-review --respond --source=pr` | GitHub PR 리뷰 코멘트에 대응 |
| `/deep-review-loop [--max=N]` | 리뷰 ↔ 대응을 수렴까지 자동 반복 (`user-invocable` 스킬이기도 함 — Codex CLI / SDK 진입용 `Skill({ skill: "deep-review:deep-review-loop" })`) |
| `/deep-review-loop --ultracode --codex` | ultracode 1회(라운드 1) + codex 매 라운드 통합 루프 |
| `/deep-review-loop --session-doc` | 세션당 하나의 통합 리뷰 문서를 유지하며 매 라운드 in-place 재렌더 (라운드별 리포트는 그대로) |
| `/deep-review --reviewer-strategy static` | adaptive 선택 대신 eligible reviewer set 고정 |
| `/deep-review --readiness-receipt PATH` | 구현 리뷰를 검증된 문서 readiness receipt에 연결 |
| `/deep-review --dry-run` / `--explain-routing` | 리뷰어 실행 없이 리뷰 대상을 분류하고 capability-aware model/effort 계획 출력 (artifact-aware routing Phase 2) |
| `/deep-review init` | 프로젝트별 리뷰 규칙 대화형 초기화 |

### Codex

| 스킬 | 설명 |
|---|---|
| `$deep-review:deep-review` | `/deep-review`와 동일한 플래그·합성 규칙으로 현재 변경사항 리뷰 |
| `$deep-review:deep-review --respond [REPORT_PATH]` | 증거 기반 대응 프로토콜 실행 |
| `$deep-review:deep-review-loop [--max=N]` | 수렴할 때까지 리뷰와 대응 반복 |
| `$deep-review:deep-review --readiness-receipt PATH` | 문서 receipt를 검증하고 이월 acceptance evidence 강제 |

**합성 리뷰어 플래그**:

- `--ultracode` — 6개 집중 Claude reviewer context를 단일 "Claude(ultracode)" 보이스로 collapse하며, fan-out 불가 시 하나의 네이티브 Claude 브리지로 명시적으로 degrade.
- `--codex` / `--no-codex` / `--no-opus` / `--agy` / `--no-agy`, 슈가 `--codex-only`(= `--codex --no-opus --no-agy`).
- **`agy` 는 기본 비활성(opt-in)입니다.** `agy` CLI 가 탐지되어도 더 이상 자동 선택되지 않으며, `--agy` 로 켭니다. 기본 리뷰어가 4→3 으로 줄어 high/critical 구현 리뷰에서 실패 1건을 보충하던 여유가 사라집니다. 기존 조합 두 가지가 바뀝니다 — `--no-opus` 는 Codex 단일 provider family 만 남고, `--no-opus --no-codex` 는 남는 리뷰어가 없습니다. 둘 다 `--agy` 로 복원합니다. opt-in 은 리뷰어 디스패치와 프로젝트 접근을 통제하며 capability 탐지는 통제하지 않습니다 — `agy --version` 프로브는 계속 실행됩니다.
- `/deep-review-loop --ultracode --codex`: ultracode 1회(라운드 1) + codex 매 라운드.
- 단발 리뷰와 loop 모두 adaptive reviewer routing과 automatic model
  routing이 기본 활성화됩니다. `--reviewer-strategy static`은 eligible set을
  고정하고, `routing_shadow_mode: true`는 adaptive plan을 기록만 합니다.
  둘을 함께 사용하면 2.0 이전 dispatch 호환 동작을 얻습니다.
- `/deep-review-loop` 수렴은 결정적입니다: 각 라운드의 finding을 `compare-rounds`로 비교하며(자연어 반복 판정이 아닌 identity 매칭), 정체된 라운드는 마지막으로 신뢰할 수 있는 verdict로 정지합니다.
- 루프는 라운드 사이에 `--prior-rounds-file` advisory 컨텍스트를 명시적으로 전달합니다(파일 존재 여부로 자동 소비하지 않음) — 리뷰어가 이전 발견·반박 항목을 재검증할 수 있습니다.
- 순수 문서 loop는 `READY_FOR_IMPLEMENTATION` gate를 사용합니다.
  low/medium은 2라운드, high/critical은 3라운드가 기본 cap이며 미해결
  문서는 `DOCUMENT_BLOCKED`로 종료합니다. 구현 loop 기본값은 5입니다.
- READY 문서는 `.deep-review/receipts/document-readiness/` 아래에 sealed
  content-addressed receipt를 생성합니다. 이후 구현 리뷰는
  `--readiness-receipt PATH`로 명시 연결하며 stale/tampered/out-of-repo/
  symlink receipt는 fail-closed하고 미검증 이월 evidence는 APPROVE를 막습니다.
- 최종 loop summary는 절약한 라운드/reviewer call, 라운드별
  assignment/model/effort, expansion, readiness, receipt, stop reason을 보고합니다.
- `--session-doc`(루프 전용, opt-in)은 loop id로 키잉된 통합 세션 문서 하나를 유지합니다 — 현재 verdict, 라운드별 히스토리, open-vs-resolved 롤업, 종료 후 최종 요약 — 라운드별 리포트와 그 fail-closed 계상은 그대로 유지됩니다.
- `--dry-run` / `--explain-routing`(리뷰 전용)은 artifact 분류, capability-aware 라우팅 계획, provenance를 출력하고 리뷰어 실행 전에 정지합니다.
- `--routing <auto|fast|balanced|quality>`은 라우팅 정책을 선택합니다. 반복 가능한 `--model <provider>=<model>` / `--effort <provider>=<effort>`은 provider override를, `--reviewer-model <reviewer>=<model>` / `--reviewer-effort <reviewer>=<effort>`은 canonical reviewer override를 설정합니다.
- `--allow-fallback`은 leaf runtime이 요청 model 또는 effort를 명시적으로 거부할 때 한 번의 visible retry를 허용합니다. 인증 실패, timeout, 빈 출력, 모호한 오류, 일반 실패는 retry하지 않으며, 승인 없이는 명시적 거부를 fail-closed합니다.
- `--no-fallback`은 project 또는 user policy가 fallback을 허용해도 명시적으로 비활성화하며 `--allow-fallback`과 함께 사용할 수 없습니다.
- `--allow-classifier`는 dry-run/explain에서 모호한 artifact에 semantic 분류를 사용할 수 있게 합니다. 제한된 artifact 내용은 untrusted data로 취급해 stdin으로만 전달하며, secret-like 내용은 외부로 보내지 않고 결정적 분류로 fallback합니다.
- `--no-*`, `--codex`, `--codex-only`, `--ultracode`는 hard
  eligibility/required-assignment 제약입니다. reviewer-level override는 해당
  reviewer를 필수화하며 provider-level override는 선택된 reviewer에만 적용됩니다.

팀 라우팅 정책은 `.deep-review/review-policy.yaml`로 공유할 수 있습니다. 프로젝트가 현재 `.deep-review/`를 무시한다면 아래 두 규칙으로 디렉터리 규칙을 교체해야 합니다. Git은 완전히 무시된 디렉터리 아래 파일을 다시 포함할 수 없습니다:

```yaml
schema_version: 2
features:
  adaptive_reviewer_routing: true
  automatic_model_routing: true
  routing_shadow_mode: false
routing:
  reviewer_strategy: adaptive
  document_round_limit: 2
  high_risk_document_round_limit: 3
  maximum_reviewers: 4
  max_expansion_waves: 1
```

```gitignore
.deep-review/*
!.deep-review/review-policy.yaml
```

## 리뷰 파이프라인

deep-review는 매 실행 시 4단계 파이프라인을 수행하며, 선택적으로 Stage 5에서 피드백에 대응합니다:

```
Stage 1: Collect      — 환경 감지, diff 수집
Stage 2: Contract     — Sprint Contract가 있으면 로드
Stage 3: Deep Review  — 독립 reviewer role adaptive 배정 (선택적 1회 확장)
Stage 4: Verdict      — 1회 최종 합성, verdict와 선택적 문서 readiness 출력
Stage 5: Respond      — 증거 기반 피드백 대응 (--respond로 진입)
```

### Stage 1: Collect (수집)

환경 감지가 git 상태를 파악하고 적절한 diff를 수집합니다:

- `non-git` — 사용자에게 리뷰할 파일 목록 요청
- `initial` (커밋 0건) — 빈 트리 기준으로 전체 파일 리뷰
- `clean` — `git diff {review_base}..HEAD`
- `staged` — `git diff --cached`
- `unstaged` — `git diff`
- `mixed` — `git diff HEAD`
- `untracked-only` — untracked 파일 직접 읽기

diff 제외 대상: 바이너리, `vendor/`, `node_modules/`, `dist/`, `build/`, `.next/`, `target/`, `.venv/`, `__pycache__/`, `.pytest_cache/`, `.git/`, `*.min.js`, `*.generated.*`, `*.lock`, `.DS_Store`.

### Stage 2: Contract 검증

- `--contract SLICE-NNN` — `.deep-review/contracts/SLICE-NNN.yaml`만 로드 (`status: active` 확인)
- `--contract` — 모든 `status: active` contract 로드
- 플래그 없음 — `.deep-review/contracts/`의 active contract 자동 로드, 아카이브된 contract 제외
- malformed YAML — 해당 contract는 경고와 함께 skip

각 기준(criteria)을 실제 코드 변경사항에 대해 검증합니다.

### Stage 3: Deep Review (심층 리뷰)

Claude Code는 capability가 있으면 독립 named `code-reviewer` 에이전트를 사용하고, 없으면 네이티브 Node Claude 브리지를 사용합니다. `codex-review`와 `codex-adversarial` 역할은 ephemeral session, read-only sandbox, 격리 config, route별 model/effort가 적용된 generic `codex exec`로 실행합니다. Codex에서는 두 역할을 같은 route별 입력을 가진 별도의 history-free 네이티브 서브에이전트로 실행합니다. Claude CLI가 감지되면 별도의 Claude-family voice를 제공할 수 있습니다. 디스패치 전에 실행될 리뷰어 구성을 고지합니다. 모든 리뷰어는 원본 세션 컨텍스트가 아닌 공유 페이로드만 받고 6가지 관점을 평가합니다:

| # | 관점 | 검사 내용 |
|---|---|---|
| 1 | 정확성 | 로직 버그, 엣지 케이스, 에러 핸들링 |
| 2 | 아키텍처 정합성 | `rules.yaml` 위반, 레이어 경계, 종속성 방향 |
| 3 | 엔트로피 | 중복 코드, 패턴 드리프트, ad-hoc 헬퍼 |
| 4 | 테스트 충분성 | 변경 대비 커버리지, 누락 시나리오 |
| 5 | 가독성 | 다음 에이전트가 처음 읽을 때 이해 가능한가 |
| 6 | 보안 | 입력 검증, 인증/인가 우회, 인젝션(prompt injection 포함), 비밀 노출, 위험한 연산 |

공유 리뷰어 페이로드(Opus 리뷰어, ultracode 샤드, agy가 사용)는 다음을 포함합니다:

- **`change_files` 매니페스트** — NUL-safe, capped 교차 파일 매니페스트(이름 변경/복사 감지, dirty 상태 untracked 유니온)로 리뷰어가 diff 하나가 아닌 전체 변경 집합을 봅니다. diff 자체는 instruction-attention을 위해 마지막에 배치되며, 위 Stage 1 제외 목록을 동일하게 따릅니다.
- **FP-억제 독트린** — false-positive 억제 독트린과 conservative-balance 반대 가중치를 `review-criteria.md` 단일 출처에서 Opus 프롬프트, ultracode 샤드, agy 페이로드에 주입합니다. 두 Codex reviewer 페이로드는 공격성 보존을 위해 의도적으로 제외됩니다.

### Stage 4: Verdict (판정)

| 발견 사항 | 판정 |
|---|---|
| 🔴 Critical 1건 이상 | `REQUEST_CHANGES` |
| 🟡 Warning, 리뷰어 전원 동의 | `REQUEST_CHANGES` |
| 🟡 Warning, 의견 분리 | `CONCERN` |
| 전원 통과 | `APPROVE` |

리포트는 `.deep-review/reports/{YYYY-MM-DD}-{HHmmss}-review.md`에 저장됩니다.

## 교차 모델 검증

여러 reviewer 역할을 사용할 수 있으면 deep-review는 신뢰할 수 있는 결과를 신뢰도 수준에 따라 합성합니다. 네이티브 Codex reviewer dispatch는 직렬이며 신뢰 게이트를 통과해야 합니다: 리뷰 전 fingerprint를 캡처하고, 한 reviewer를 실행하고, 리뷰 후 fingerprint를 캡처하고, 신뢰 판정을 내린 뒤에만 다음 reviewer를 실행합니다. mutation이 발생하면 sibling reviewer, response, commit 전에 해당 round를 중단합니다:

```
     Claude Opus     →     codex:review     →     codex:adversarial
      (독립 리뷰)            (표준 리뷰)              (적대적 리뷰)
          │                     │                        │
          └──── 각 reviewer 뒤 fingerprint + 신뢰 게이트 ────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   신뢰도 기준 합성      │
                    │                        │
                    │  전원 일치  → 🔴 높음  │
                    │  2/3 일치   → 🟡 중간  │
                    │  단독 지적  → ℹ️ 참고  │
                    │  전원 통과  → 🟢       │
                    └────────────────────────┘
```

`agy`(Google Antigravity) CLI가 감지되면 cross-vendor-family 4번째 리뷰어로 합류합니다. Codex 리뷰어 역할을 사용할 수 없으면 deep-review는 1회 알림 후, Codex가 명시적으로 요구되지 않은 경우에만 사용 가능한 역할로 계속 진행합니다. 명시적으로 required인 역할의 실패·부재는 fail-closed하며, 일반 reviewer 실패는 "미수행"으로 기록하고 `N_actual`에서 제외하되 legacy companion으로 조용히 대체하지 않습니다.

`staged`, `unstaged`, `mixed` 상태에서는 교차 모델 검증이 실제 커밋 베이스에 대해 실행되도록 WIP 커밋 생성을 제안합니다. 제안은 파일 목록을 미리 보여주고 민감 패턴을 경고하며 `git add -A`를 사용하지 않습니다; `git reset --soft HEAD~1`로 원복합니다. shallow clone은 감지되어 `git fetch --unshallow` 권장이 표시됩니다.

## Receiving Review (Stage 5)

Stage 4가 `REQUEST_CHANGES`를 반환하면 deep-review는 증거 기반 대응(`/deep-review --respond`) 또는 수동 처리를 제공합니다. `--respond` 플래그가 6단계 프로토콜을 활성화합니다:

| 단계 | 행동 |
|---|---|
| READ | 반응 없이 전체 피드백 읽기 |
| UNDERSTAND | 각 요구사항을 기술적으로 재진술 |
| VERIFY | 코드베이스와 대조 검증 (파일, grep, 테스트, blame) |
| EVALUATE | source 신뢰도에 따라 수락 / 반박 / 보류 판단 |
| RESPOND | 수정과 함께 수락 또는 증거로 반박 |
| IMPLEMENT | 심각도 우선순위로 수정 적용, 심각도 그룹별 커밋 |

각 source는 검증 수준을 결정하는 기본 신뢰도를 가집니다:

| Source | 기본 신뢰도 |
|---|---|
| Human (사용자) | 높음 |
| deep-review Opus | 중간 |
| Codex review | 중간 |
| Codex adversarial | 낮음 |
| PR comment (외부) | 낮음 |

`/deep-review --respond --source=pr`는 `gh api`로 GitHub PR 코멘트를 수집하고 동일 프로토콜을 적용합니다 — 인라인 코멘트에는 스레드 답글, 일반 코멘트에는 이슈 레벨 답글로 응답합니다. 각 세션은 `.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`에 모든 결정을 evidence와 함께 기록한 리포트를 생성합니다.

## Sprint Contract

Sprint Contract는 기능 슬라이스의 성공 기준을 정의하며, deep-review는 의도가 아닌 실제 코드에 대해 각 기준을 검증합니다. Contract는 `.deep-review/contracts/SLICE-NNN.yaml`에 위치합니다:

```yaml
slice: SLICE-001
title: "JWT 인증"
status: active
criteria:
  - id: C1
    description: "모든 보호된 라우트에서 토큰 만료를 검증한다"
    verification: auto       # auto | manual | mixed
    status: null             # Evaluator가 채움: PASS | FAIL | PARTIAL | SKIP
    evidence: null           # Evaluator가 채움
```

- `verification: auto` — Evaluator가 코드를 읽고 pass/fail을 판단합니다.
- `verification: manual` — 자동으로 스킵되며 "수동 확인 필요"로 표시됩니다.
- `verification: mixed` — 자동 검증 가능한 부분만 검사하고 나머지는 스킵합니다.

## 설정

deep-review는 `.deep-review/` 아래 여러 파일을 읽습니다:

- **`rules.yaml`** (inferential) — `/deep-review init`이 생성하는 프로젝트별 리뷰 규칙; LLM이 읽고 적용합니다. 없으면 범용 모범 사례 기준을 사용합니다.
- **`fitness.json`** (computational) — deep-work Health Engine이 생성·검증하는 아키텍처 fitness 규칙; 존재 시 리뷰어 프롬프트에 주입하여 아키텍처 의도 인지 리뷰를 수행합니다.
- **`config.yaml`** — 런타임 상태(리뷰 모델, Codex/agy 알림 플래그, fingerprint 모드). 첫 실행 시 자동 생성되며 한 번에 한 필드씩 갱신해 수동 설정이 보존됩니다.
- **`recurring-findings.json`** — 매 리뷰 후 반복 패턴을 7개 taxonomy(`error-handling`, `naming-convention`, `type-safety`, `test-coverage`, `security`, `performance`, `architecture`)로 분류하고 M3 cross-plugin envelope으로 emit하며, deep-evolve가 소비하여 실험 방향을 조향합니다.

**팀 공유**: `rules.yaml`, `contracts/`, `journeys/`는 프로젝트 지식이므로 커밋해야 하며, `config.yaml`, `reports/`, `responses/`, `entropy-log.jsonl`, `recurring-findings.json`은 머신별 런타임 상태입니다. `/deep-review init`이 이 구분을 `.gitignore`에 반영합니다.

`review_model`은 비어 있지 않은 설치된 Claude 모델 alias를 그대로 전달합니다. 예: `review_model: fable`.

## 실용적 문서 정책

순수 문서 리뷰는 신뢰된 artifact phase와 risk를 모든 리뷰어 assignment에
전달합니다. 문서 blocker는 저장소/아티팩트에 근거한 구체적 기능 모순,
구현 불가능성 또는 실행을 막는 결정 누락, 도달 가능한
안전/보안/호환성/마이그레이션/복구/롤백 피해, 객관적으로 검증할 수 없는
acceptance criteria로 제한합니다.

스타일, 가독성, 명명, 취향, 근거 없는 추측은 advisory/info로 남기거나
억제하며 pre-implementation blocker로 올리지 않습니다. 미래 구현/테스트
누락은 구현 검증 evidence이며 객관적으로 확인할 수 있으므로 문서 blocker가 아닙니다.
문서 finding만으로 same-round reviewer를 추가하지 않으며 운영 floor는
fail-closed로 유지합니다.

### design-validation

전체 설계 문서/ADR 범위에서는 구현 가능성과 설계 건전성을 검토합니다: 위의
공유된 기능 모순, 구현 불가능성, 안전/보안/호환성/마이그레이션/복구/롤백
피해, 근거가 있고 잘못된 동작을 유발하는 불건전한 설계 blocker만
차단합니다. 문구 완결성과 구체화되지 않은 구현 세부사항은 결코
차단하지 않습니다.

### full-readiness

혼합되었거나 모호하거나 실행 가능한 문서 범위에서는 full-readiness가
적용됩니다: 누락된 실행 가능 결정 또는 객관적으로 검증 가능하지 않은
acceptance criterion을 추가로 차단합니다. 문구 완결성, 표현 다듬기, 서식,
사소한 오타는 여전히 차단하지 않습니다. 혼합되었거나 모호한 범위 분류는
full-readiness를 사용합니다.

Artifact Gate readiness가 최종 문서 판정을 소유합니다: `DOCUMENT_BLOCKED` =>
`REQUEST_CHANGES`; `READY_FOR_IMPLEMENTATION`에 deferred finding이 있으면
`CONCERN`; 없으면 `APPROVE`입니다 (양쪽 모드 공통). Readiness가 최종 판정
권한을 유지하며, implementation phase는 이 문서 정책이 아니라 일반 code
review를 유지합니다.

## 링크

- [변경 기록](./CHANGELOG.ko.md)
- [deep-suite](https://github.com/Sungmin-Cho/deep-suite) — marketplace 및 형제 플러그인
- [기여 가이드](./CONTRIBUTING.md) · [보안 정책](./SECURITY.md)

## 라이선스

[MIT](./LICENSE)
