# Skill 실제 사용자 시나리오 — 명세 + 실행 체크 원장

작성일: `2026-06-14 KST` · 대상: `vibeloop-harness` Skill

이 문서는 **"진짜 사용자가 스킬을 쓸 때의 완전한 시나리오"** 를 명세하고, **스킬이 실제로 돌 때마다 단계별로 체크**할 수 있게 만든 살아있는 문서다. 두 가지를 동시에 만족시킨다.

1. **명세**: 목표 28단계 흐름 + 각 단계의 환경 전제 + 기대 결과 + 검증 방법(report 필드).
2. **진화**: 단계가 실제 구현·실측되면 상태(❌→⚠️→✅)를 올리고, 실행할 때마다 **Run Ledger**에 결과를 1행씩 누적한다.

> 과장 금지 규칙: 모든 단계 상태는 **코드 검증 근거**로만 적는다. fixture/scripted 결과를 "실사용자 PASS"로 부르지 않는다. (참조: [implement_20260614_193356.md](../dev-plan/implement_20260614_193356.md), [CODEX_SKILL_FULL_UAT_RUNBOOK.md](./CODEX_SKILL_FULL_UAT_RUNBOOK.md))

상태 범례: ✅ 구현·실측 / ⚠️ 부분(라이브러리/래퍼만) / ❌ 목표(미구현).

## 0. 실사용자 run 합격 공식

```text
REAL_USER_RUN_PASS =
  real_llm_builder_used            # mock/script 아님(실 codex/LLM)
  ∧ orchestrator_read_skill_md     # LLM이 SKILL.md 읽고 모드 분기·task/eval 생성
  ∧ one_issue_selected_with_reason # 한 번에 1개 + 선택 근거 기록
  ∧ deterministic_gates_only       # accept/select는 고정 게이트+Arbiter (LLM 아님)
  ∧ pr_candidate ⇔ (selected ∧ accept ∧ ALL_PASS ∧ qualified)
  ∧ no_auto_merge                  # draft PR 후보까지만
  ∧ false_pass == 0 ∧ leak == 0
```

현재 이 공식의 **`real_llm_builder_used`만 단일 이슈로 실측**됐고(아래 Run Ledger R1), `orchestrator_read_skill_md`·다중 이슈 루프는 미구현이다.

## 1. 환경 요건 (실사용자)

| 구분                        | 필요                                                                                                                                                 | 현재 환경 확인                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 런타임                      | Node ≥22, pnpm, git                                                                                                                                  | ✅                                                                     |
| CLI 배포                    | `pnpm bundle:skill` → `vendor/vibeloop.mjs`(+`schemas/`) 동봉 후 스킬 폴더 복사, 또는 `vibeloop` PATH                                                | ✅ 번들 검증됨                                                         |
| 실 LLM 빌더                 | `codex` CLI + ChatGPT OAuth(`~/.codex/auth.json`) **+ VibeLoop OAuth 프록시**(`--agent codex --llm-proxy-url <proxy>`; `codex` 어댑터가 프록시 강제) | ✅ codex 0.129 + auth.json, 프록시는 `uat:codex-oauth`가 기동          |
| 대상 repo                   | 표준 명령(`pnpm test`/`lint`/`typecheck`) + `task.yaml`/`eval.yaml`(write_scope·protected_paths·hidden_acceptance·evaluator)                         | repo마다 준비 필요                                                     |
| GitHub                      | `gh` 로그인 + 대상 repo(PR 후보 push/draft PR) **+ `delete_repo` 스코프(정리용)**                                                                    | ⚠️ gh=coreline-ai 로그인, `delete_repo` 스코프 없음 → 정리는 archive만 |
| **GitHub 테스트용 실 소스** | **실제 버그 + base에서 실패하는 테스트**가 있는 repo (실 LLM이 고치는 대상)                                                                          | ❌ 아직 미생성 — 실 E2E의 필수 전제                                    |

## 2. 28단계 명세 + 단계별 체크

각 행: 동작 / **구현 상태** / 전제(env) / 기대 결과 / **검증(체크 방법)**.

| #   | 동작                      | 상태 | 전제             | 기대 결과                       | 검증(체크)                                              |
| --- | ------------------------- | ---- | ---------------- | ------------------------------- | ------------------------------------------------------- |
| 1   | 사용자 요청 수신          | ❌   | orchestrator LLM | 자연어 프롬프트 입력            | 세션 로그에 프롬프트 존재                               |
| 2   | 입력 모드 판단(지정/자동) | ❌   | orchestrator LLM | 구체 버그 없음→자동 발견        | report에 mode 기록                                      |
| 3   | repo 상태 확인            | ⚠️   | git              | `git status`/`rev-parse HEAD`   | base_commit 기록(있음)                                  |
| 4   | 기본 명령 탐지            | ⚠️   | repo             | `pnpm test/lint/typecheck` 인식 | discovery 후보 kind                                     |
| 5   | 문제 후보 수집            | ⚠️   | discovery        | test fail/lint/TODO 후보        | `discover`는 **dry-run만**                              |
| 6   | 후보 근거 저장            | ❌   | —                | discovery-report.json           | 파일 영속 미배선                                        |
| 7   | 우선순위 계산             | ⚠️   | discovery        | failing>lint>TODO               | task-gen 위험도 힌트만                                  |
| 8   | 문제 1개 선택             | ❌   | —                | ISSUE-001 선택                  | 자동 선택→실행 미배선                                   |
| 9   | task 생성                 | ⚠️   | discovery/script | task.yaml                       | `task-gen`(라이브러리) 또는 **수동** `create-task-eval` |
| 10  | eval 생성                 | ⚠️   | script           | eval.yaml(+hidden+scope)        | 수동/템플릿                                             |
| 11  | Builder Codex 실행        | ✅   | codex+프록시     | src/tests 수정                  | `improve --agent codex`                                 |
| 12  | Challenger Codex 실행     | ✅   | codex+프록시     | 더 작은 diff                    | `--challenger`                                          |
| 13  | Adversary Codex 실행      | ❌   | —                | hardcode 후보 생성              | adversary LLM 없음                                      |
| 14  | Builder 검증              | ✅   | 게이트           | eval-report accept/ALL_PASS     | 후보 run report                                         |
| 15  | Challenger 검증           | ✅   | 게이트           | eval-report accept/ALL_PASS     | 후보 run report                                         |
| 16  | Adversary 검증            | ❌   | —                | reject/hidden fail              | adversary 미배선                                        |
| 17  | 품질 점수                 | ✅   | Arbiter          | builder 72 / challenger 82      | selection_report.score                                  |
| 18  | Arbiter 선택              | ✅   | Arbiter          | selected_candidate_id           | selection_report.selected_candidate_id                  |
| 19  | PR 조건 확인              | ✅   | predicate        | accept∧ALL_PASS∧qualified       | summarize-report `prCandidate=true`                     |
| 20  | PR 후보 branch 생성       | ⚠️   | git/gh           | `pr-candidate/<id>`             | **wrapper(UAT)만**, 코어 CLI 아님                       |
| 21  | report 저장               | ✅   | —                | selection/quality-report.json   | 파일 존재                                               |
| 22  | auto-merge 안 함          | ✅   | —                | branch만                        | merge 호출 없음                                         |
| 23  | 다음 문제 탐색            | ❌   | 자율 루프        | ISSUE-002                       | 루프 미구현                                             |
| 24  | 동일 루프 반복            | ❌   | 자율 루프        | 재실행                          | 루프 미구현(UAT가 고정 큐 흉내)                         |
| 25  | 실패 시 처리              | ✅   | predicate        | selected=null→PR 없음           | selection_report null 시 PR 없음                        |
| 26  | 종료 조건                 | ❌   | cap/budget       | max issues/시간                 | 강제 상한·budget 없음                                   |
| 27  | 최종 요약                 | ⚠️   | —                | "N PR, 0 false pass"            | 단일 run summarizer만                                   |
| 28  | 사용자에게 결과 제공      | ⚠️   | —                | branch 목록+report 경로         | wrapper 출력                                            |

**요약**: 실제 자동으로 도는 핵심 = 11·12·14·15·17·18·19·21·22·25. 앞단(1–10)·adversary(13·16)·PR브랜치(20)·자율루프/종료/요약(23·24·26–28)은 ❌/⚠️.

## 3. 실행 기록 (Run Ledger) — 실행할 때마다 1행 추가

| Run | 날짜       | 모드                      | 대상 repo                        | 빌더                          | orchestrator         | 통과 단계         | PR 후보                    | false pass / leak | 결과                                                              | 증거(report 경로)                    |
| --- | ---------- | ------------------------- | -------------------------------- | ----------------------------- | -------------------- | ----------------- | -------------------------- | ----------------- | ----------------------------------------------------------------- | ------------------------------------ |
| R1  | 2026-06-14 | 단일 이슈(수동 task/eval) | cart-quantity fixture repo(임시) | **실 gpt-5.5(ChatGPT OAuth)** | ❌ 없음(하네스 구동) | 11·14·17·19·21·22 | 0(단일 run, branch 미생성) | 0 / 0             | **부분 PASS** — 실 codex가 cart 수정→accept/ALL_PASS(hidden 포함) | `uat:codex-oauth` 출력(임시, 삭제됨) |

> R1 해석: **실 LLM 빌더 동작은 실측됨**(`?? 1` 등 모델 고유 코드 + hidden 통과). 그러나 orchestrator·discovery·adversary·다중이슈 루프·PR브랜치는 미포함 → "실사용자 run 합격 공식" 전체는 아직 미충족.

### 기록 행 작성 규칙

- 실행마다 위 표에 1행 추가. 모드(지정/자동), 빌더가 mock인지 실LLM인지 **반드시 명시**.
- "통과 단계"는 §2의 # 중 실제 충족된 것만. 미충족은 적지 않는다.
- 증거는 실제 `selection-report.json`/`eval-report.json`/`quality-report.json` 경로(보존 시 `VIBELOOP_UAT_KEEP_TMP=1`).
- false pass(부당 accept)·leak이 0이 아니면 그 run은 FAIL로 기록.

## 4. 진화 규칙 (문서가 체크 수준으로 자라는 법)

1. 한 단계의 코드가 실제 구현되고 **실 run으로 검증되면** §2의 상태를 ⚠️/❌ → ✅로 올리고, 그 근거 file:line 또는 Run 번호를 적는다.
2. 새 run마다 §3 Ledger에 1행. PASS 선언은 §0 공식 충족 + Ledger 증거가 있을 때만.
3. 단계 구현은 [implement_20260614_193356.md](../dev-plan/implement_20260614_193356.md)의 Phase로 추적한다(이 문서는 "무엇이 도는가"의 체크, plan은 "무엇을 만들 것인가").
   - 1–2 → Phase 1, 9–10/지정모드 → Phase 2, 3–8 자동발견 → Phase 3, 11–16 실 codex lane → Phase 4, 명칭/문서 → Phase 5, 구현 → Phase 6, advisory → Phase 7, dirty/재검증/provenance/상한 → Phase 8.
4. "실사용자 100% PASS"는 §2의 ❌가 0이고 §3 Ledger에 자동모드 실LLM run이 PASS로 남았을 때만 선언한다.

## 5. 다음 실측을 위해 필요한 것 (현재 막힌 전제)

- **GitHub 테스트용 실 소스 repo** 생성(실 버그+failing test). 실 E2E의 필수 전제(§1).
- orchestrator 층(SKILL.md 읽고 모드 분기·task/eval 생성) — Phase 1~3.
- 자율 다중이슈 루프 + 종료조건/budget — Phase 8 #5 + 루프.
- (정리) `gh`에 `delete_repo` 스코프(없으면 archive로만 정리).
