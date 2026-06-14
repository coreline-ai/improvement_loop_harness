# Skill 실제 사용자 시나리오 — 명세 + 실행 체크 원장

작성일: `2026-06-14 KST` · 대상: `vibeloop-harness` Skill

이 문서는 **"진짜 사용자가 스킬을 쓸 때의 완전한 시나리오"** 를 명세하고, **스킬이 실제로 돌 때마다 단계별로 체크**할 수 있게 만든 살아있는 문서다. 두 가지를 동시에 만족시킨다.

1. **명세**: 목표 28단계 흐름 + 각 단계의 환경 전제 + 기대 결과 + 검증 방법(report 필드).
2. **진화**: 단계가 실제 구현·실측되면 상태(❌→⚠️→✅)를 올리고, 실행할 때마다 **Run Ledger**에 결과를 1행씩 누적한다.

> 과장 금지 규칙: 모든 단계 상태는 **코드 검증 근거**로만 적는다. fixture/scripted 결과를 "실사용자 PASS"로 부르지 않는다. (참조: [implement_20260614_193356.md](../dev-plan/implement_20260614_193356.md), [CODEX_SKILL_FULL_UAT_RUNBOOK.md](./CODEX_SKILL_FULL_UAT_RUNBOOK.md))

상태 범례: ✅ 구현·실측 / ⚠️ 부분(라이브러리/래퍼만) / ❌ 목표(미구현).

## 0-1. 정직한 미완 항목

| 항목                         | 현재 상태 | 의미                                                                                                                                                                              | 다음 패치 방향                                                                |
| ---------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 자연어 의도 인식(스킬/LLM층) | ⚠️        | `skills/vibeloop-harness/SKILL.md`에 intent routing 규칙을 추가했고 `scripts/classify-intent.mjs`가 자유 프롬프트를 안전한 모드로 분류한다. 단 실제 LLM 세션이 이 helper를 호출해 실행까지 이어지는 live UAT는 아직 없다. | Skill live UAT에서 classifier 호출→선택 모드 실행까지 증명                    |
| eval 자동생성                | ⚠️        | `orchestrate --generate-eval`이 package.json test/typecheck/lint 또는 `--eval-command`로 **minimal visible-test eval**을 생성한다. hidden/adversary/policy-rich eval은 아직 없다. | hidden/adversary/rulepack 포함 eval 생성은 후속. 현재는 visible baseline only |
| adversary lane(13·16)        | ❌        | Builder/Challenger 후보는 있으나 adversary LLM이 공격 후보/테스트를 생성하고 검증되는 lane은 없다.                                                                                | advisory → test candidate → M2/M4 replay → rulepack freeze 순서               |
| 코어 PR브랜치(20)            | ⚠️        | core `improve --promote-branch`가 local PR-candidate branch를 만들 수 있다. `orchestrate --promote-branch`가 누적 local integration branch를 만들고 수정 후 재탐색한다. GitHub draft PR/push는 아직 wrapper 영역이다.                                    | GitHub draft PR/push + live RU-3 UAT까지 확장                        |
| 토큰 budget                  | 보류      | count/time cap은 있으나 provider token 회계는 아직 없다.                                                                                                                          | 합의대로 후속. token usage adapter 필요                                       |
| 최고 수정 품질판별           | ⚠️        | deterministic score와 advisory tie-break는 배선됐지만, live RU-2에서 strict score improvement는 아직 미증명이다.                                                                  | RU-2에 quality judge 연결 + 결과를 verification/full improvement로 분리       |

## 0-2. 통과 상태 용어 고정

| 용어                             | 의미                                                                                                                           | PASS 조건                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Verification PASS                | 후보가 accept/ALL_PASS/qualified이고 final reverify/provenance/leak/pr predicate를 통과                                        | `verification_status=pass`                      |
| Best-selection supported         | score 동점에서 별도 quality judge가 동점 후보 중 더 나은 후보를 골랐거나, 고정 evaluator score spread가 있음                   | `best_choice_proven_every_issue=true`           |
| Full autonomous improvement PASS | 검증 통과 + 모든 이슈에서 고정 점수 기준의 엄격한 개선이 증명됨. `strict_score_improvement_every_issue=false`이면 이 이름 금지 | `REAL_USER_MULTI_FULL_IMPROVEMENT_PASS`         |
| Fixture FULL_UAT_PASS            | hermetic fixture/catalog 검증 전용. 실 Codex/GitHub 사용자 환경 PASS가 아님                                                    | `scripts/uat/skill-real-user-full-uat.mjs` 한정 |

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

현재 이 공식 중 **`real_llm_builder_used` + `deterministic_gates_only` + `pr_candidate ⇔ …` + `no_auto_merge` + `false_pass==0 ∧ leak==0`은 실 GitHub repo + draft PR로 실측됨**(Run Ledger R2/R3). `orchestrate`는 발견→선택→task 자동생성→issue별 `runImprovementLoop`까지 **결정론 코어 명령으로 fixture 실측**됐고, 단일 이슈 local branch는 `improve --promote-branch`로 가능하다. 그러나 자연어 의도 인식은 helper 수준이고 live Skill 호출 증명은 없으며, eval 자동생성 고도화·GitHub draft PR/push·live RU-3 UAT는 없다. 따라서 공식의 `orchestrator_read_skill_md`와 RU-3 full loop는 아직 PASS가 아니다.

## 1. 환경 요건 (실사용자)

| 구분                        | 필요                                                                                                                                                 | 현재 환경 확인                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 런타임                      | Node ≥22, pnpm, git                                                                                                                                  | ✅                                                                                     |
| CLI 배포                    | `pnpm bundle:skill` → `vendor/vibeloop.mjs`(+`schemas/`) 동봉 후 스킬 폴더 복사, 또는 `vibeloop` PATH                                                | ✅ 번들 검증됨                                                                         |
| 실 LLM 빌더                 | `codex` CLI + ChatGPT OAuth(`~/.codex/auth.json`) **+ VibeLoop OAuth 프록시**(`--agent codex --llm-proxy-url <proxy>`; `codex` 어댑터가 프록시 강제) | ✅ codex 0.129 + auth.json, 프록시는 `uat:codex-oauth`가 기동                          |
| 대상 repo                   | 표준 명령(`pnpm test`/`lint`/`typecheck`) + `task.yaml`/`eval.yaml`(write_scope·protected_paths·hidden_acceptance·evaluator)                         | repo마다 준비 필요                                                                     |
| GitHub                      | `gh` 로그인 + 대상 repo(PR 후보 push/draft PR) **+ `delete_repo` 스코프(정리용)**                                                                    | ⚠️ gh=coreline-ai 로그인, `delete_repo` 스코프 없음 → 정리는 archive만                 |
| **GitHub 테스트용 실 소스** | **실제 버그 + base에서 실패하는 테스트**가 있는 repo (실 LLM이 고치는 대상)                                                                          | ✅ R2에서 `gh repo create … --source`로 buggy base push(cart-quantity); 정리는 archive |

## 2. 28단계 명세 + 단계별 체크

각 행: 동작 / **구현 상태** / 전제(env) / 기대 결과 / **검증(체크 방법)**.

| #   | 동작                      | 상태 | 전제             | 기대 결과                          | 검증(체크)                                                                                 |
| --- | ------------------------- | ---- | ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | 사용자 요청 수신          | ❌   | orchestrator LLM | 자연어 프롬프트 입력               | 세션 로그에 프롬프트 존재(스킬/LLM 층)                                                     |
| 2   | 입력 모드 판단(지정/자동) | ⚠️   | CLI 명령         | 지정=`improve`, 자동=`orchestrate` | 명령 레벨 분기(결정론); 자연어 판단은 스킬 층                                              |
| 3   | repo 상태 확인            | ⚠️   | git              | `git status`/`rev-parse HEAD`      | base_commit 기록 + dirty 가드(#1)                                                          |
| 4   | 기본 명령 탐지            | ⚠️   | repo             | `pnpm test/lint/typecheck` 인식    | discovery 후보 kind                                                                        |
| 5   | 문제 후보 수집            | ✅   | discovery        | test fail/lint/TODO 후보           | `orchestrate`가 `discoverCandidates` 실행                                                  |
| 6   | 후보 근거 저장            | ✅   | —                | discovery-report.json              | `orchestrate`가 `discovery/<loop>.json` 영속                                               |
| 7   | 우선순위 계산             | ✅   | discovery        | security>test>typecheck/lint       | `selectTopCandidates`(고정 priority)                                                       |
| 8   | 문제 1개 선택             | ✅   | —                | top-N 선택→실행                    | `orchestrate --max-issues`(기본 1)                                                         |
| 9   | task 생성                 | ✅   | discovery        | task.yaml 자동생성                 | `generateTaskFromCandidate`(+acceptance reproCommand)                                      |
| 10  | eval 생성                 | ⚠️   | 계약             | eval.yaml(+hidden+scope)           | 제공된 eval 계약 사용(자동생성 아님)                                                       |
| 11  | Builder Codex 실행        | ✅   | codex+프록시     | src/tests 수정                     | `improve --agent codex`                                                                    |
| 12  | Challenger Codex 실행     | ✅   | codex+프록시     | 더 작은 diff                       | `--challenger`                                                                             |
| 13  | Adversary Codex 실행      | ❌   | —                | hardcode 후보 생성                 | adversary LLM 없음                                                                         |
| 14  | Builder 검증              | ✅   | 게이트           | eval-report accept/ALL_PASS        | 후보 run report                                                                            |
| 15  | Challenger 검증           | ✅   | 게이트           | eval-report accept/ALL_PASS        | 후보 run report                                                                            |
| 16  | Adversary 검증            | ❌   | —                | reject/hidden fail                 | adversary 미배선                                                                           |
| 17  | 품질 점수                 | ✅   | Arbiter          | builder 72 / challenger 82         | selection_report.score                                                                     |
| 18  | Arbiter 선택              | ✅   | Arbiter          | selected_candidate_id              | selection_report.selected_candidate_id                                                     |
| 19  | PR 조건 확인              | ✅   | predicate        | accept∧ALL_PASS∧qualified          | summarize-report `prCandidate=true`                                                        |
| 20  | PR 후보 branch 생성       | ⚠️   | git/gh           | `pr-candidate/<id>`                | core `improve --promote-branch` + `orchestrate --promote-branch` local branch 가능; GitHub draft PR/push는 wrapper |
| 21  | report 저장               | ✅   | —                | selection/quality-report.json      | 파일 존재                                                                                  |
| 22  | auto-merge 안 함          | ✅   | —                | branch만                           | merge 호출 없음                                                                            |
| 23  | 다음 문제 탐색            | ⚠️   | 자율 루프        | ISSUE-002                          | `orchestrate --promote-branch`는 local branch commit 후 재탐색. live RU-3/GitHub 증거는 없음 |
| 24  | 동일 루프 반복            | ⚠️   | 자율 루프        | 재실행                             | issue별 `runImprovementLoop` + local patch 누적/재탐색 가능. GitHub draft PR은 wrapper만 |
| 25  | 실패 시 처리              | ✅   | predicate        | selected=null→PR 없음              | selection_report null 시 PR 없음                                                           |
| 26  | 종료 조건                 | ✅   | cap              | max issues + 후보 cap              | `--max-issues` + 유한 후보 + per-issue `--max-candidates`                                  |
| 27  | 최종 요약                 | ✅   | —                | "N discovered/processed, K PR"     | `orchestrate` 출력(discovered/processed/pr_candidates)                                     |
| 28  | 사용자에게 결과 제공      | ⚠️   | —                | branch 목록+report 경로            | CLI 출력(코어); PR 브랜치는 wrapper                                                        |

**요약**: 코어가 자동으로 도는 부분 = **자동 발견·선택·task생성(5–9)** + 후보 루프(11·12·14·15·17·18·19·21·22·25) + 단일 이슈 local branch promotion(20 일부) + `orchestrate --promote-branch` local 누적/재탐색(23·24 일부)다. Full/live RU-3로 격상하려면 eval 자동생성 고도화, GitHub draft PR/push, 실 Codex RU-3 UAT가 더 필요하다. 남은 ❌/⚠️: 자연어 의도 인식 live 증명(1·2 스킬층), eval 자동생성 고도화(10), adversary(13·16), orchestrate PR브랜치(20·28).

## 3. 실행 기록 (Run Ledger) — 실행할 때마다 1행 추가

| Run | 날짜       | 모드                                                 | 대상 repo                                                                                   | 빌더                                                              | orchestrator                                                                  | 통과 단계                                                                                  | PR 후보                                                                                                                                                                                                         | false pass / leak | 결과                                                                                                                                                                    | 증거(report 경로)                                                                                                                  |
| --- | ---------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 2026-06-14 | 단일 이슈(수동 task/eval)                            | cart-quantity fixture repo(임시)                                                            | **실 gpt-5.5(ChatGPT OAuth)**                                     | ❌ 없음(하네스 구동)                                                          | 11·14·17·19·21·22                                                                          | 0(단일 run, branch 미생성)                                                                                                                                                                                      | 0 / 0             | **부분 PASS** — 실 codex가 cart 수정→accept/ALL_PASS(hidden 포함)                                                                                                       | `uat:codex-oauth` 출력(임시, 삭제됨)                                                                                               |
| R2  | 2026-06-14 | 단일 이슈 지정(수동 task/eval)                       | `coreline-ai/vibeloop-realuser-live-37048-1781435213776` (GitHub private, 정리=archive)     | **실 gpt-5.5(ChatGPT OAuth proxy)** — builder+challenger 둘 다    | ❌ 코드 자동 아님(claude-code 세션이 SKILL.md 읽고 cart-quantity 계약 재사용) | 11·12·14·15·17·18·19·21·22·25 (+20 wrapper)                                                | 1 — draft PR [pull/1](https://github.com/coreline-ai/vibeloop-realuser-live-37048-1781435213776/pull/1)                                                                                                         | 0 / 0             | **PASS(RU-1 verification)** — 실 codex 2후보 둘 다 accept/ALL_PASS/qualified(**78 동점**)→Arbiter c0 선택→draft PR, `proxy_auth_header_seen=true`                       | `~/.vibeloop-realuser-dAGNwK/data/projects/realuser-live/{selections,runs/…-c0/reports}` (`KEEP_TMP=1` 보존)                       |
| R3  | 2026-06-14 | 단일 이슈 지정(수동 task/eval)                       | `coreline-ai/vibeloop-realuser-live-44218-1781438315621` (GitHub private, 정리=archive)     | **실 gpt-5.5(ChatGPT OAuth proxy)** — builder+challenger 둘 다    | ❌ 코드 자동 아님(R2와 동일)                                                  | 11·12·14·15·17·18·19·21·22·25 (+20 wrapper) + B2/B3/B4                                     | 1 — draft PR [pull/1](https://github.com/coreline-ai/vibeloop-realuser-live-44218-1781438315621/pull/1)                                                                                                         | 0 / 0             | **PASS(RU-1 verification + trust-floor)** — final reverify accept, `provenance_ok=true`, `limits{max_candidates:24, cap_hit:false}`                                     | `~/.vibeloop-realuser-tFEhuQ/data/projects/realuser-live/runs/…-reverify/reports/eval-report.json` (`KEEP_TMP=1` 보존)             |
| R4  | 2026-06-14 | 단일 이슈 지정(수동 task/eval)                       | `coreline-ai/vibeloop-realuser-live-47470-1781438416883` (GitHub private, `KEEP_REMOTE=1`)  | **실 gpt-5.5(ChatGPT OAuth proxy)** — builder+challenger 둘 다    | ❌ 코드 자동 아님(R2/R3와 동일)                                               | 11·12·14·15·17·18·19·21·22·25 (+20 wrapper) + final reverify/provenance/limits             | 1 — draft PR [pull/1](https://github.com/coreline-ai/vibeloop-realuser-live-47470-1781438416883/pull/1)                                                                                                         | 0 / 0             | **PASS(RU-1 verification) / 최고수정 미증명** — 두 후보 score 78 동점, c1이 더 방어적(`quantity ?? 1`)이나 c0 선택                                                      | `~/.vibeloop-realuser-BfPeyJ/data/projects/realuser-live/{selections,runs/…-c0,reverify}` (`KEEP_TMP=1` 보존)                      |
| R5  | 2026-06-14 | 다중 이슈 순차(2이슈 큐: cart + sku, 수동 task/eval) | `coreline-ai/vibeloop-realuser-multi-40106-1781440051727` (GitHub private, archive)         | **실 gpt-5.5(ChatGPT OAuth proxy)** — 이슈마다 builder+challenger | 스크립트 큐(자동발견 아님; `orchestrate` 자동모드는 fixture 검증 §8.2)        | 이슈마다 11·12·14·15·17·18·19·21·22·25 + B2/B3/B4 + 다중이슈 순차(23·24·26·27)             | 2 — stacked draft PR [#1 cart](https://github.com/coreline-ai/vibeloop-realuser-multi-40106-1781440051727/pull/1) + [#2 sku](https://github.com/coreline-ai/vibeloop-realuser-multi-40106-1781440051727/pull/2) | 0 / 0             | **검증 PASS(RU-2) / 풀 자율개선 PASS 아님** — 2이슈 accept/ALL_PASS/qualified + reverify/provenance 통과. `strict_score_improvement=false`라 최고수정 품질판별은 미증명 | `~/.vibeloop-realuser-multi-ZQoR9c/data/projects/realuser-live-multi/runs/…-reverify/reports/eval-report.json` (`KEEP_TMP=1` 보존) |
| R6  | 2026-06-14 | 다중 이슈 순차 루프(시나리오 큐)                     | `coreline-ai/vibeloop-realuser-multi-80859-1781439023896` (GitHub private, `KEEP_REMOTE=1`) | **실 gpt-5.5(ChatGPT OAuth proxy)** — 각 이슈 builder+challenger  | ⚠️ 자동 discovery 아님(scripted issue queue)                                  | 11·12·14·15·17·18·19·21·22·23·24·25·27·28 (+20 wrapper) + final reverify/provenance/limits | 2 — stacked draft PR [pull/1](https://github.com/coreline-ai/vibeloop-realuser-multi-80859-1781439023896/pull/1), [pull/2](https://github.com/coreline-ai/vibeloop-realuser-multi-80859-1781439023896/pull/2)   | 0 / 0             | **검증 PASS(RU-2) / 최고수정 미증명** — 2개 이슈를 1개씩 순차 처리하고 PR 후보화했지만, 두 이슈 모두 후보 점수 동점(`strict_score_improvement_every_issue=false`)       | `~/.vibeloop-realuser-multi-yipB75/data/projects/realuser-live-multi/{selections,runs}` (`KEEP_TMP=1` 보존)                        |

> R1 해석: **실 LLM 빌더 동작은 실측됨**(`?? 1` 등 모델 고유 코드 + hidden 통과). 그러나 orchestrator·discovery·adversary·다중이슈 루프·PR브랜치는 미포함 → "실사용자 run 합격 공식" 전체는 아직 미충족.
>
> R2/R3 해석: 실 GitHub + draft PR까지의 **verification lane**은 확인됐다. accept/select는 결정론 게이트+Arbiter가 했고 false_pass/leak은 0이다. 그러나 자동 문제 발견과 최고수정 품질판별은 포함하지 않는다.
>
> R4 해석: **real Codex 단일 이슈 live loop는 다시 통과**했다. 다만 두 후보가 score 78 동점이고 더 방어적인 후보를 선택하지 못해, Arbiter만으로 “최고 수정”을 증명하지 못한다는 B1 한계가 재확인됐다.
>
> R5/R6 해석: **real Codex 다중 이슈 순차 루프(RU-2)는 verification pass**다. cart PR을 base로 sku PR을 쌓는 stacked draft PR 구조와 “문제 1개 처리→선택 patch 적용→다음 문제 처리→최종 테스트”는 확인됐다. 단 issue queue는 scripted라 RU-3 자동 문제 발견이 아니며, `strict_score_improvement_every_issue=false`이면 **풀 자율개선 PASS로 부르지 않는다**. 현재 코드도 이를 `REAL_USER_MULTI_VERIFICATION_PASS_*`와 `REAL_USER_MULTI_FULL_IMPROVEMENT_PASS`로 분리한다.

### 기록 행 작성 규칙

- 실행마다 위 표에 1행 추가. 모드(지정/자동), 빌더가 mock인지 실LLM인지 **반드시 명시**.
- "통과 단계"는 §2의 # 중 실제 충족된 것만. 미충족은 적지 않는다.
- 증거는 실제 `selection-report.json`/`eval-report.json`/`quality-report.json` 경로(보존 시 `VIBELOOP_UAT_KEEP_TMP=1`).
- false pass(부당 accept)·leak이 0이 아니면 그 run은 FAIL로 기록.

## 3-1. RU-3 격상 판단 — `orchestrate --promote-branch`는 local RU-3 substrate

| 판단 항목            | 현재 `orchestrate`                           | Full/live RU-3 필요조건                    | 판정      |
| -------------------- | -------------------------------------------- | ------------------------------------------- | --------- |
| 문제 자동 발견       | eval contract 기반 discovery 실행            | 동일                                        | 충족      |
| 문제 1개 선택        | top-N slice / `--max-issues`                 | 선택 근거 report + 한 번에 1개              | 부분 충족 |
| task 자동생성        | discovery candidate → task 생성              | 동일                                        | 충족      |
| eval 자동생성        | `--generate-eval` minimal visible eval 가능  | hidden/adversary/policy-rich eval 자동생성  | 부분 충족 |
| 선택 patch 누적 적용 | `--promote-branch`에서 local branch commit | 통합 브랜치에 적용·커밋                     | 충족(로컬) |
| 수정 후 재탐색       | `--promote-branch`에서 issue 후 다시 discovery | 각 issue 후 다시 discovery 실행             | 충족(로컬) |
| 코어 PR브랜치        | `improve`/`orchestrate --promote-branch` local branch 가능 | GitHub draft PR 후보까지 확장 | 부분 충족 |
| live Codex full run  | fixture/unit 중심                            | 실 Codex + GitHub evidence                  | 미충족    |

**결정**: 현재 `vibeloop orchestrate --promote-branch`는 **local RU-3 substrate**로 격상한다. 다만 실 Codex + GitHub draft PR까지 포함한 **full/live RU-3 PASS는 아니다**. Full 승격은 `apply selected patch → commit/integration branch → rediscover → next issue → GitHub draft PR 후보`가 실 run evidence로 남을 때만 한다.

`VIBELOOP_UAT_ALLOW_VERIFICATION_ONLY=1`은 RU-2에서 verification pass 상태를 관찰하기 위한 옵션일 뿐, 실패 run을 성공으로 바꾸지 않는다. `verification_status=fail`이면 항상 exit non-zero다.

## 4. 진화 규칙 (문서가 체크 수준으로 자라는 법)

1. 한 단계의 코드가 실제 구현되고 **실 run으로 검증되면** §2의 상태를 ⚠️/❌ → ✅로 올리고, 그 근거 file:line 또는 Run 번호를 적는다.
2. 새 run마다 §3 Ledger에 1행. PASS 선언은 §0 공식 충족 + Ledger 증거가 있을 때만.
3. 단계 구현은 [implement_20260614_193356.md](../dev-plan/implement_20260614_193356.md)의 Phase로 추적한다(이 문서는 "무엇이 도는가"의 체크, plan은 "무엇을 만들 것인가").
   - 1–2 → Phase 1, 9–10/지정모드 → Phase 2, 3–8 자동발견 → Phase 3, 11–16 실 codex lane → Phase 4, 명칭/문서 → Phase 5, 구현 → Phase 6, advisory → Phase 7, dirty/재검증/provenance/상한 → Phase 8.
4. "실사용자 100% PASS"는 §2의 ❌/⚠️가 모두 0이고, §3 Ledger에 **RU-3 자동모드 실LLM run + Adversary/rulepack freeze 포함** PASS가 남았을 때만 선언한다. 현재는 선언 금지다.

## 5. 다음 실측을 위해 필요한 것 (현재 막힌 전제)

- **GitHub 테스트용 실 소스 repo** 생성(실 버그+failing test). 실 E2E의 필수 전제(§1).
- orchestrator 층(SKILL.md 읽고 모드 분기·task/eval 생성) — classifier helper는 추가됨. 실제 Skill live UAT에서 호출·실행 증명 필요.
- 자율 다중이슈 루프 + 종료조건/budget — Phase 8 #5 + 루프.
- (정리) `gh`에 `delete_repo` 스코프(없으면 archive로만 정리).

## 6. 풀 실환경 테스트 전략 (진짜 사용자 환경)

목표는 fixture/scripted agent가 아니라 **실제 Codex/LLM + 실제 git/GitHub repo + 실제 Skill/CLI bundle + 실제 PR 후보 흐름**으로 §0 공식을 검증하는 것이다. 단, 자동 merge는 금지하고 draft PR 후보까지만 만든다.

### 6.1 테스트 환경 원칙

| 원칙            | 내용                                                                                           | 실패 판정                              |
| --------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- |
| 실 LLM 수정     | Builder/Challenger는 `command agent fixture`가 아니라 `codex` CLI + ChatGPT OAuth proxy를 사용 | `builder.real_llm !== true`면 FAIL     |
| 실 repo         | 임시 로컬 repo만이 아니라 GitHub private repo에 buggy base를 push                              | remote repo/branch 증거 없으면 FAIL    |
| 실 Skill bundle | `pnpm bundle:skill` 결과물 또는 `packages/cli/bin/vibeloop`가 실제 run에 사용됨                | vendor/CLI 경로 불명확하면 FAIL        |
| 고정 판정       | accept/select는 deterministic gate + Arbiter만 사용                                            | LLM verdict가 `decision` 변경하면 FAIL |
| 증거 보존       | `VIBELOOP_UAT_KEEP_TMP=1`에서 selection/eval/quality report 경로 보존                          | report 경로 없으면 FAIL                |
| 자동 merge 금지 | draft PR 또는 branch까지만 생성                                                                | merge/push main 발생 시 FAIL           |
| 누설 금지       | hidden sentinel/token이 stdout/report/PR body에 없어야 함                                      | 1건이라도 발견되면 FAIL                |

### 6.2 실행 lane

| Lane                       | 목적                                 | 현재 상태                              | 실행 방식                                                                                                         | 통과 기준                                                                                                                         |
| -------------------------- | ------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| RU-0 preflight             | 실제 환경 가능 여부 확인             | 필요                                   | `codex --version`, `codex -c service_tier=fast login status`, `gh auth status`, `pnpm build`, `pnpm bundle:skill` | 불충족 시 `blocked`로 끝나고 PASS 금지                                                                                            |
| RU-1 사용자 지정 단일 이슈 | 가장 작은 진짜 사용자 흐름           | 일부 스크립트 초안 존재                | `scripts/uat/skill-real-user-codex-live-uat.mjs`를 package script로 연결 후 실행                                  | real LLM 수정 + accept/ALL_PASS/qualified + draft PR 후보                                                                         |
| RU-2 다중 이슈 순차 루프   | “문제 여러 개를 1개씩” 검증          | ⚠️ verification PASS, 최고수정 미증명  | `pnpm uat:skill-loop:codex-live:multi`                                                                            | 각 issue가 독립 선택·수정·검증·stacked draft PR 후보화. `strict_score_improvement_every_issue=false`면 full improvement PASS 금지 |
| RU-3 자동 문제 발견        | 사용자가 문제를 안 지정한 경우       | ⚠️ local substrate 배선, live/full 미구현 | `vibeloop orchestrate --promote-branch`                                                                            | discover→task→improve→local branch commit→rediscover는 가능. GitHub draft PR/live Codex 증거는 미완                              |
| RU-4 적대적 실패 케이스    | false pass 방지                      | 부분 fixture만                         | protected path, hidden leak, test weakening, hardcode 후보를 실제 LLM/fixture 혼합으로 주입                       | 전부 reject 또는 no PR                                                                                                            |
| RU-5 실패/상한/복구        | timeout/budget/dirty/provenance 검증 | 미구현                                 | dirty repo, budget 초과, provenance 변조, selected patch 재검증 실패 유도                                         | 안전 중단 + report 기록 + no PR                                                                                                   |

### 6.3 RU-1 기준 명령 초안

`package.json`에 아래 script가 **등록됨**(R2에서 실행·검증). 스크립트는 `agent-adapters/dist`와 `packages/cli/bin/vibeloop`를 직접 쓰므로 `pnpm build`만 필요(skill 번들 불요).

```jsonc
{
  "scripts": {
    "uat:skill-loop:codex-live": "pnpm build && node scripts/uat/skill-real-user-codex-live-uat.mjs"
  }
}
```

실행:

```bash
# 증거 보존 모드
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-live
```

기대 JSON 핵심:

```jsonc
{
  "status": "REAL_USER_RUN_PASS",
  "scenario": "skill-real-user-codex-live-uat",
  "builder": { "real_llm": true, "via": "chatgpt-oauth-proxy" },
  "github": {
    "repo": "coreline-ai/...",
    "pr_url": "https://github.com/.../pull/..."
  },
  "selected_decision": "accept",
  "selected_reason": "ALL_PASS",
  "pr_candidate": true,
  "false_pass": 0,
  "leak": 0,
  "evidence": {
    "selection_report": ".../selection-report.json",
    "selected_report": ".../eval-report.json",
    "tmp_root": "..."
  }
}
```

### 6.4 풀 실환경 PASS 판정 매트릭스

| 증거                              | 필수 여부  | 확인 방법                                                          |
| --------------------------------- | ---------- | ------------------------------------------------------------------ |
| Codex login 실제 사용             | 필수       | preflight stdout/stderr + proxy `auth_header_seen=true`            |
| Builder/Challenger real LLM       | 필수       | ledger `builder.real_llm=true`, agent spec이 `codex`/proxy command |
| GitHub private repo 생성          | 필수       | `github.repo`, `github.url`, base commit push 확인                 |
| buggy base에서 visible test fail  | 필수       | base checkout에서 `node tests/...` 실패 로그 보존                  |
| candidate에서 visible+hidden pass | 필수       | selected `eval-report.json` gate status 전부 pass                  |
| deterministic selection           | 필수       | `selection-report.json` selected id + score/tie-break              |
| PR predicate                      | 필수       | `selected ∧ accept ∧ ALL_PASS ∧ qualified` 재계산                  |
| draft PR 또는 branch              | 필수(RU-1) | `gh pr view` 또는 remote branch 확인                               |
| hidden/token leak 0               | 필수       | stdout/report/PR body grep                                         |
| auto-merge 0                      | 필수       | main branch unchanged, PR draft/open 상태                          |

### 6.5 실패 케이스 세트

| 케이스                        | 만드는 방법                                      | 기대 결과                                               |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| F1 protected path write       | agent가 `.env` 또는 `eval.yaml` 수정 시도        | `protected_files` reject, PR 없음                       |
| F2 hidden leak                | agent stdout/report에 hidden sentinel 출력 유도  | artifact leak/context leak reject 또는 wrapper no PR    |
| F3 test weakening             | `test.skip`, `expect(true)` 추가                 | `test_integrity` reject                                 |
| F4 hardcode visible only      | visible test만 맞추고 hidden mixed quantity 실패 | hidden gate reject                                      |
| F5 dirty source repo          | 실행 전 uncommitted 변경 생성                    | dirty guard fail-fast 또는 명시 경고 + no autonomous PR |
| F6 provenance 변조            | candidate patch/report hash 변조                 | `ARTIFACT_PROVENANCE_MISMATCH` reject                   |
| F7 budget 초과                | max candidates/round/token/time 낮게 설정        | 안전 중단 + no PR                                       |
| F8 selected patch 재적용 실패 | 선택 patch를 clean base에 재적용 불가하게 조작   | final reverify fail + no PR                             |

### 6.6 구현 순서와 연결

| 순서 | 문서 계획                  | 이 문서에서 검증되는 것                      |
| ---- | -------------------------- | -------------------------------------------- |
| P0   | 문서/용어 과장 방지        | fixture PASS와 live PASS 분리                |
| P1   | trust-floor 보강           | F5~F8, final reverify/provenance/budget      |
| P2   | 입력/문제 선택 계약        | §2 #1~#10의 mode/issue selection             |
| P3   | 사용자 지정 문제 모드      | RU-1                                         |
| P4   | fixture baseline 명칭 정정 | 기존 FULL UAT 오해 제거                      |
| P5   | 실제 Codex/LLM live UAT    | RU-1 공식화                                  |
| P6   | 자동 문제 발견 모드        | RU-3                                         |
| P7   | advisory reviewer          | RU-4 확장, 단 accept 불참                    |
| P8   | option 2 rulepack freeze   | LLM 생성 테스트를 다음 루프 고정 gate로 승격 |

## 7. 지금 당장 해야 할 작업

1. ✅ `scripts/uat/skill-real-user-codex-live-uat.mjs` 코드 리뷰 완료(+ B5 PR predicate 엄격화).
2. ✅ `uat:skill-loop:codex-live` package script 등록.
3. ✅ RU-0 preflight가 `blocked`(exit 20)와 run FAIL을 구분.
4. ✅ RU-1을 `VIBELOOP_UAT_KEEP_TMP=1`로 1회 실행 → Ledger R2(증거 경로 보존).
5. PASS가 아니면 PASS라고 부르지 말고, 실패 lane/게이트/reason을 기록한다. (상시 규칙)
6. ✅ RU-2 real Codex multi-issue loop 실행 → Ledger R5/R6(2 stacked draft PR, 최종 `npm test`) — 단 verification pass이며 full improvement pass 아님.
7. ✅ RU-2 PASS 기준 분리 패치 — `strict_score_improvement_every_issue=false`이면 `REAL_USER_MULTI_FULL_IMPROVEMENT_PASS` 금지.
8. ✅ live RU-2에 별도 `qualityJudge` command 연결 — 동점 후보에서는 advisory tie-break evidence 기록.
9. ✅ RU-3 local substrate: `orchestrate --promote-branch`로 local branch 누적 적용 + 재탐색 테스트 추가. **다음**: GitHub draft PR/live RU-3와 P7 adversary/rulepack freeze.
10. 그 뒤 RU-4/RU-5 실패 케이스(F1~F8)를 live lane에 확장.

## 8. R2 실측 기반 평가·검증 보강점 (관찰→근거→보강)

R2는 실 gpt-5.5 builder+challenger가 실 GitHub repo를 고쳐 draft PR까지 간 **첫 완전 실 run**이다. 그 과정에서 평가(quality)·검증(gate/selection/PR predicate)이 실제로 어떻게 동작했는지 직접 확인했고, 아래가 **실 run에서 드러난** 보강 우선순위다. (설계상 알던 한계가 이번에 경험적으로 확인된 것 포함.)

| #   | 관찰(R2 실측)                                                                                                                                                                                                   | 근거                                                               | 보강                                                                                                                            | 매핑                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| B1  | **동점 선택이 품질맹목**: 실 후보 2개가 score **78 동점**(changed_files/lines/evidence 동일)→Arbiter가 순서로 c0                                                                                                | `selections/…json` 두 후보 모두 `score.total=78`, `selected=c0`    | 결정론 점수는 동점을 **품질로 못 깸**. 2nd-context LLM 품질심사(별도 CLI/컨텍스트)로 동점만 분리, **accept/correctness는 불참** | plan P7 advisory    |
| B2  | **selected patch 최종 재검증 부재**: 각 후보는 자기 run worktree에서만 검증. 선택 후 c0 patch를 fresh base에 재적용+게이트 재실행하는 **하네스 단계 없음**. R2 PR브랜치는 wrapper가 `git apply`만 성공시켜 push | wrapper `git apply out.selected_patch`(게이트 재실행 아님)         | 하네스급 **final reverify**(선택 patch를 clean base 재적용→게이트 전체 재실행, 실패 시 no PR)                                   | trust-floor #3 / F8 |
| B3  | **provenance/hash 바인딩 부재**: verified `eval-report`와 PR에 올라간 patch 사이 **hash 결속 없음**. wrapper가 `out.selected_patch` 경로를 신뢰                                                                 | `provenanceVerified` 하드코딩 true(이전 grep 검증)                 | report↔patch **hash 결속 검증**(불일치 시 `ARTIFACT_PROVENANCE_MISMATCH` reject)                                                | trust-floor #4 / F6 |
| B4  | **반복/비용 상한 미강제**: 후보 수가 2인 건 builder+challenger만 넘겼기 때문. 하네스 강제 cap 없음. 실 gpt-5.5는 **후보당 수 분/실비용**                                                                        | run 소요 시간(실측 수 분), `--challenger` 1개만 전달               | 하네스 **max candidates/rounds/token/time cap + budget**(초과 시 안전중단·no PR)                                                | trust-floor #5 / F7 |
| B5  | **wrapper PR predicate가 코어보다 느슨**: `quality?.status !== 'fail'`만 검사 → quality-report 누락 시 soft pass, `qualified`(met===true) 미강제                                                                | wrapper line 168–172(현재 `quality?.met === true`로 **수정 완료**) | §0 공식의 `∧ qualified`와 정렬: `quality.met===true` 필수, 누락=fail-closed (**이미 보강함**)                                   | 이 커밋에서 수정    |

**핵심 한 줄**: R2는 _"실 LLM이 고치고 결정론 게이트가 거른다"_ 까지는 실증했지만, **선택 이후의 신뢰층(B1 동점 품질심사 · B2 최종 재검증 · B3 provenance · B4 상한)** 과 입력 가드(#1 dirty)가 비어 있었다. 이후 **#1·B1·B2·B3·B4·B5를 모두 코어에 배선**했다(§8.1). 남은 것은 토큰 budget(보류) 뿐.

### 8.1 코어 배선 반영 (#1·B1·B2·B3·B4·B5) — 실 테스트로 검증

R2 관찰 후 trust-floor를 코어 CLI/SDK에 배선하고 결정론 테스트로 검증했다. 상태 갱신:

| #                    | 상태                     | 코어 배선(file:line)                                                                                                                                                                                                                                                                                                                                                                        | 검증(실 테스트)                                                                                                                                                    |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1 dirty 가드        | ✅ 배선                  | `improvement-loop.ts` — base 자동해석 + source repo dirty면 **거부(throw)**. `--base-commit` 핀 또는 `--allow-dirty` 시 예외. `workspace-runner/git.ts` `worktreeStatus()` 신규. CLI `--allow-dirty`.                                                                                                                                                                                       | `index.test.ts` "refuses a dirty source repo …(#1)" — dirty+auto→throw, `--allow-dirty`/pinned→진행                                                                |
| B1 동점 품질심사     | ✅ 배선 + live RU-2 연결 | `improvement-loop.ts` — score 무차별 동점인 accepted 후보가 2+면 `qualityJudge`(별도 프로세스=별도 컨텍스트, `quality-judge.ts` `commandQualityJudge`)가 **동점 집합 안에서만** 선호를 표함. correctness 불참, 동점 밖/throw는 무시(deterministic 유지), 선택은 여전히 B2/B3로 게이트. CLI `--quality-judge <command>`. live RU-2는 `scripts/uat/quality-judge-best-patch.mjs`를 기본 연결. | `index.test.ts` B1 3건 + `commandQualityJudge` 별도프로세스 1건 + `node scripts/uat/quality-judge-best-patch.mjs` 이전 RU-2 artifact 수동 검증                     |
| B2 최종 재검증       | ✅ 배선                  | `improvement-loop.ts` `verifySelectedCandidate()` — 선택 patch를 fresh worktree에 `evalOnlyPatch`로 재적용→전체 게이트 재실행, `accept ∧ qualified` 재현 못 하면 `selected=undefined`(PR 없음). `--skip-final-reverify`로 옵트아웃.                                                                                                                                                         | `index.test.ts` "re-verifies the selected patch …(B2/B3)" + 토글 + **부정경로** "no longer applies on a clean base …(B2 reverify→no PR)"                           |
| B3 provenance 바인딩 | ✅ 배선                  | `eval-report.ts` `verifyCandidatePatchHash()` 신규 + 선택 시 `verifyEvalReportProvenance`(gate artifact)와 함께 호출. 불일치→`provenance_ok=false`→PR 없음. (주의: 각 후보 *자기 run*의 `provenanceVerified`는 여전히 in-run 하드코딩 — 의미 있는 검증은 **선택 시점** 교차검증)                                                                                                            | `decision-report.test.ts` "verifyCandidatePatchHash … detects tampering (B3)" + **부정경로** `index.test.ts` "hash no longer matches …(PROVENANCE_MISMATCH→no PR)" |
| B4 상한/budget       | ✅ 배선(count/time)      | `improvement-loop.ts` `budgetExhausted()` — `maxCandidates`/`deadlineMs` 강제(매 kernel run 전 검사, 초과 시 `cap_hit`/`deadline_hit` 기록·중단). CLI `--max-candidates`(기본 24 백스톱). **토큰 budget은 보류**.                                                                                                                                                                           | `index.test.ts` "enforces the maxCandidates cost ceiling (B4)" — 빌더 3·cap 2→2개·`cap_hit`                                                                        |
| B5 wrapper predicate | ✅ 수정                  | `scripts/uat/skill-real-user-codex-live-uat.mjs` PR predicate에 `quality?.met === true` 필수화(fail-closed)                                                                                                                                                                                                                                                                                 | 위 codex-live wrapper                                                                                                                                              |

**SelectionReport(schema_version `1.1`)** 에 `pr_candidate`·`final_verification`·`advisory_tie_break`·`limits` 추가, `selected_*`는 최종검증 통과 시에만 채워진다. CLI `improve` 출력도 동일 필드 노출.

**부정 경로도 실측**: `PROVENANCE_MISMATCH→no PR`와 `REVERIFY 실패→no PR`은 **실제 산출물(patch/report)을 변조**해 `verifySelectedCandidate`를 직접 구동하는 테스트로 검증됨(함수 export). 단, `REVERIFY_REJECTED`(게이트 재실행이 정상 적용되었는데 fail)는 결정론 게이트 특성상 **재현 = 동일 결과**라 단일 호출 내 결정론 부정 케이스가 성립 안 함 — 진짜 비결정/드리프트 케이스는 RU-5에서.

**보류**: 토큰 budget(count+time으로 비용은 이미 bound).

전체 검증(2026-06-14 재확인): `pnpm typecheck`/`lint` clean, **unit 223 pass(11 skip)**, **e2e 26 pass**, `git diff --check` clean. (codex-live OAuth 실경로 재확인 = Ledger R3/R5/R6 원장, live RU-3는 아직 아님)

### 8.2 자율 orchestrator + 다중이슈 루프 (자동 모드 코어 배선)

§8.1(선택 이후 신뢰층) 이후, §0 공식의 **자동 오케스트레이션 + 다중이슈 자율 루프**를 결정론 코어 명령으로 배선했다.

| 항목                               | 배선(file:line)                                                                                                                                                                                                                                                                                                             | 검증                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `vibeloop orchestrate` (자동 모드) | `packages/cli/src/commands/orchestrate.ts` — discover→discovery-report 영속→`selectTopCandidates` top-N→이슈마다 `generateTaskFromCandidate`로 task 자동생성→`runImprovementLoop`(B1~B4 포함)→다중이슈 순차 + 요약. `--max-issues`/`--max-candidates`로 종료 bound. 오케스트레이션은 **결정론**(LLM은 builder/challenger뿐) | `index.test.ts` "discovers a failing test, auto-generates a task, and runs the loop to a PR candidate" + "errors when no eval contract" |
| task-gen 검증가능화                | `discovery/collectors`가 실패 게이트 명령을 `reproCommand`로 캡처 + `discovery/task-gen`이 이를 `acceptance.required_tests`로 설정 → 자동생성 task의 `fixes_reproduced_failure`를 test-on-base로 검증 가능                                                                                                                  | 위 orchestrate 테스트가 PR 후보(accept/ALL_PASS/qualified+reverify) 도달                                                                |

§8.2는 **core fixture 기준 자동 발견 배선**이다. discover→선택→task 자동생성→issue별 `runImprovementLoop`는 확인됐지만, `--promote-branch` 없는 기본 모드는 선택 patch를 누적 적용하지 않는다. `--promote-branch`를 주면 local branch에 누적 commit 후 다시 discovery를 돌린다. `improve --promote-branch`로 단일 선택 patch의 local PR-candidate branch는 만들 수 있고, `orchestrate --generate-eval`로 minimal visible eval은 만들 수 있다. 그러나 hidden/adversary/policy-rich eval과 GitHub draft PR은 아직 없다. 남은 ❌/⚠️: 자연어 의도 인식 live 증명(1·2 스킬층), eval 자동생성 고도화(10), adversary(13·16), orchestrate PR브랜치(20·28), live RU-3/GitHub draft PR. 실 Codex 다중이슈 실측은 **Ledger R5/R6**이며 verification pass다.

### 8.3-1 minimal eval 자동생성

| 항목                          | 배선                                                                                                                                                                                                         | 검증                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrate --generate-eval` | `<repo>/eval.yaml`이 없을 때 package.json의 `test`/`typecheck`/`lint` 또는 `--eval-command`로 보수적 eval contract 생성. guard gates + visible command + fixed evaluator(`require_test_on_base_pass`)만 포함 | `index.test.ts` "can generate a minimal visible-test eval contract when no eval.yaml exists" — generated eval file 생성, `npm test` discovery, selected patch reverify 통과 |

이 기능은 #10의 **minimal visible eval**만 줄인다. hidden acceptance, artifact-leak forbidden literal, adversary-generated tests, project-specific policy는 자동생성하지 않는다. 따라서 full 실사용자 PASS의 eval 자동생성으로 과장하지 않는다.

### 8.3 코어 local PR-candidate branch promotion

| 항목                              | 배선                                                                                                                                                                                  | 검증                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `improve --promote-branch <name>` | selected 후보가 final reverify/provenance를 통과한 경우에만 source repo를 clean 상태에서 `<name>` branch로 checkout→selected patch `git apply --index`→commit. push/merge는 하지 않음 | `index.test.ts` "improve can promote the selected final-verified patch to a local PR-candidate branch" — `main`은 그대로, `pr-candidate/*`에만 수정/테스트가 존재 |

이 기능은 #20의 **단일 이슈 local branch** 미완을 줄인다. 단 GitHub draft PR/push와 live RU-3 UAT는 아직 미구현이다.
