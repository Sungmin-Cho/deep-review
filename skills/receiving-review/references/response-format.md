# Response Report Format

## 파일 위치

`.deep-review/responses/{YYYY-MM-DD}-{HHmmss}-response.md`

타임스탬프는 response 리포트 생성 시점 기준.
같은 날 여러 번 `--respond`를 실행해도 파일이 충돌하지 않는다.

## 디렉토리

`.deep-review/responses/`와 최종 파일은
`{plugin_root}/hooks/scripts/respond-runtime.mjs write-report`가 생성한다. Main은 완성된
UTF-8 본문을 private content file로 전달하고, runtime이 충돌하지 않는
이름으로 원자적으로 publish한 절대 경로를 사용한다. Runtime을 호출할 수
없는 host는 direct host file-creation tool로 동일한 unique-create 의미론을
보장한다. 기존 response 파일을 덮어쓰지 않는다.

## 구조

```markdown
# Response Report — {YYYY-MM-DD HH:mm:ss}

## Summary
- **Source Review**: {리포트 파일 경로 또는 PR URL}
- **Original Verdict**: {APPROVE | REQUEST_CHANGES | CONCERN}
- **Items**: {수락 N건, 반박 N건, 보류 N건}
- **execution_path**: {subagent | main_fallback | mixed | n/a}

## Item Responses

### ITEM-1: {제목}
- **Severity**: {🔴 Critical | 🟡 Warning | ℹ️ Info}
- **Source**: {Human | Opus + Codex (일치) | Opus only | Opus (ultracode) | Codex only | Adversarial only | PR comment}
- **Decision**: {ACCEPT | REJECT | DEFER}
- **Evidence**:
  - files_read: `{파일:라인범위}`
  - grep_results: `{함수/패턴}` — {N} call sites
  - test_status: {테스트 상태 요약}
  - test_log: `.deep-review/tmp/phase6-{severity}.log:{item_id}`  # Phase 6 subagent 실행 시. ephemeral — 다음 `--respond` 시 `tmp/prev/`로 회전
  - log_unavailable: {true | false}  # Phase 6 subagent가 log_path에 쓰지 못한 경우 true (스펙 §6.7)
  - git_context: {필요 시 blame 결과}
- **Action**: {수정 내용 요약 + 위치} | {반박 사유} | {보류 사유}
- **Test**: {테스트 명령어} → {PASS | FAIL}

### ITEM-2: {제목}
...

## Recurring Pattern Alerts
{recurring-findings.json에서 감지된 경고가 있으면 표시}

## Re-review Recommendation
- 🔴 수정 {N}건 완료 — `/deep-review` 재실행 권장
```

## Decision 값 정의

| Decision | 의미 | evidence 필수 |
|----------|------|---------------|
| ACCEPT | 지적을 수용하고 수정함 | Yes — files_read 최소 필수 |
| REJECT | 지적을 반박함 (증거 기반) | Yes — 반박 근거 + grep/test/blame 중 1개 이상 |
| DEFER | 지금 처리하지 않음 (보류) | Yes — 보류 사유 (Human 에스컬레이션 등) |

## PR 코멘트 게시 실패 추적 (`--source=pr` 시)

PR 코멘트 게시(`gh api .../replies`)는 rate limit / 네트워크 오류 / 권한 문제로 실패할 수 있다.
실패한 posting은 리포트 말미에 기록하여 다음 `--respond --source=pr` 실행 시 재시도한다.

```markdown
## Failed Postings

| comment_id | item_id | attempted_at | error |
|-----------|---------|--------------|-------|
| 123456 | ITEM-3 | 2026-04-17T12:03:11Z | 403 resource not accessible |
| 123457 | ITEM-5 | 2026-04-17T12:03:12Z | rate limit (retry-after: 60) |
```

**재시도 규칙** (멱등성 유지):
- 기존 멱등성 로직(`comment_id` 중복 제거)은 **게시 성공한 것만** 제외 대상으로 삼는다.
- `Failed Postings` 목록의 comment_id는 다음 실행 시 반드시 재시도 대상에 포함.

**세션 간 집계 (3-strike 판정)**:

`comment_id`별 연속 실패 카운트는 단일 response 리포트에만 기록하면 세션 간 추적이 불가능하다. 다음 중 하나로 명시적 persistence를 구현한다:

- **권장 — 롤링 레저**: `.deep-review/responses/failed-postings.json`을 source of truth로 유지.

  ```json
  {
    "updated_at": "2026-04-17T12:34:56Z",
    "entries": {
      "<comment_id>": {
        "attempts": 2,
        "last_error": "rate limit (retry-after: 60)",
        "last_attempt_at": "2026-04-17T12:30:11Z",
        "source_reports": ["2026-04-17-120000-response.md", "2026-04-17-121441-response.md"]
      }
    }
  }
  ```

  - 재시도 성공 시 해당 `comment_id` 제거.
  - `attempts >= 3`에 도달하면 사용자 에스컬레이션 + 해당 엔트리 유지 (자동 재시도 중단).

- **대안 — 스캔 방식**: 매 `--source=pr` 실행 시 `.deep-review/responses/*.md`의 모든 `Failed Postings` 테이블을 스캔하여 동일 `comment_id`의 연속 항목 수를 세어 판정. persistence 파일이 필요 없으나, 리포트가 많아질수록 비용이 O(N).

**3-strike 에스컬레이션 메시지**:
"comment #{id} 게시가 3회 실패했습니다. 마지막 에러: {last_error}. 수동 확인이 필요합니다."

## PR Source 리포트 (`--source=pr`)

`--source=pr`로 진입한 경우, Source Review 필드에 PR URL을 기록:

```markdown
- **Source Review**: https://github.com/{owner}/{repo}/pull/{number}
```

각 ITEM의 Source 필드:
```markdown
- **Source**: PR comment (@{author}, #{comment_id})
```

---

## `execution_path` 값 정의

| 값 | 의미 |
|----|------|
| `subagent` | Phase 6 전 그룹을 `phase6-implementer` 서브에이전트가 성공적으로 처리 |
| `main_fallback` | 첫 dispatch 시도부터 실패하여 모든 그룹을 main이 직접 수행 |
| `mixed` | 일부 그룹은 subagent, 일부는 main fallback (중간 그룹에서 dispatch 실패 시) |
| `n/a` | ACCEPT 항목 0건으로 Phase 6 전체 skip |

결정 절차는 `{plugin_root}/skills/receiving-review/references/respond-execution.md` Step 2.5(Phase 6 subagent dispatch) 및 스펙 §5.4 결정표 참조.

## Prepared response evidence

For prepared reviews record the exact source decision path/digest and each
confirmed finding_id from the Node response-items result. Link every attempted
Phase 6 group result, verification receipt, commit result when present, and the
archived response evidence_file. Record failed/ halted/unknown status without
converting a missing report or receipt to zero changed files. This metadata
is separate from the legacy human-readable item counts. Loop completion and
final target attribution come only from the Node decide-round result.
