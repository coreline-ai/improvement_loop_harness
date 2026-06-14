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

현재 이 공식 중 **`real_llm_builder_used` + `deterministic_gates_only` + `pr_candidate ⇔ …` + `no_auto_merge` + `false_pass==0 ∧ leak==0`은 실 GitHub repo + draft PR로 실측됨**(아래 Run Ledger R2). 아직 미충족: `orchestrator_read_skill_md`(코드 자동 분기·task/eval 생성)와 다중 이슈 자율 루프 → 공식 전체 PASS는 아직 아님.

## 1. 환경 요건 (실사용자)

| 구분                        | 필요                                                                                                                                                 | 현재 환경 확인                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 런타임                      | Node ≥22, pnpm, git                                                                                                                                  | ✅                                                                     |
| CLI 배포                    | `pnpm bundle:skill` → `vendor/vibeloop.mjs`(+`schemas/`) 동봉 후 스킬 폴더 복사, 또는 `vibeloop` PATH                                                | ✅ 번들 검증됨                                                         |
| 실 LLM 빌더                 | `codex` CLI + ChatGPT OAuth(`~/.codex/auth.json`) **+ VibeLoop OAuth 프록시**(`--agent codex --llm-proxy-url <proxy>`; `codex` 어댑터가 프록시 강제) | ✅ codex 0.129 + auth.json, 프록시는 `uat:codex-oauth`가 기동          |
| 대상 repo                   | 표준 명령(`pnpm test`/`lint`/`typecheck`) + `task.yaml`/`eval.yaml`(write_scope·protected_paths·hidden_acceptance·evaluator)                         | repo마다 준비 필요                                                     |
| GitHub                      | `gh` 로그인 + 대상 repo(PR 후보 push/draft PR) **+ `delete_repo` 스코프(정리용)**                                                                    | ⚠️ gh=coreline-ai 로그인, `delete_repo` 스코프 없음 → 정리는 archive만 |
| **GitHub 테스트용 실 소스** | **실제 버그 + base에서 실패하는 테스트**가 있는 repo (실 LLM이 고치는 대상)                                                                          | ✅ R2에서 `gh repo create … --source`로 buggy base push(cart-quantity); 정리는 archive |

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
| R2  | 2026-06-14 | 단일 이슈 지정(수동 task/eval) | `coreline-ai/vibeloop-realuser-live-37048-1781435213776` (GitHub private, 정리=archive) | **실 gpt-5.5(ChatGPT OAuth proxy)** — builder+challenger 둘 다 | ❌ 코드 자동 아님(claude-code 세션이 SKILL.md 읽고 cart-quantity 계약 재사용) | 11·12·14·15·17·18·19·21·22·25 (+20 wrapper) | 1 — draft PR [pull/1](https://github.com/coreline-ai/vibeloop-realuser-live-37048-1781435213776/pull/1) | 0 / 0 | **PASS(RU-1)** — 실 codex 2후보 둘 다 accept/ALL_PASS/qualified(**78 동점**)→Arbiter c0 선택→draft PR, `proxy_auth_header_seen=true` | `~/.vibeloop-realuser-dAGNwK/data/projects/realuser-live/{selections,runs/…-c0/reports}` (`KEEP_TMP=1` 보존) |

> R1 해석: **실 LLM 빌더 동작은 실측됨**(`?? 1` 등 모델 고유 코드 + hidden 통과). 그러나 orchestrator·discovery·adversary·다중이슈 루프·PR브랜치는 미포함 → "실사용자 run 합격 공식" 전체는 아직 미충족.
>
> R2 해석(실 GitHub + draft PR까지): 실 gpt-5.5 빌더+챌린저가 실 repo buggy base를 고쳐 `item.price * item.quantity` + 회귀테스트(31 assert) 산출 → **결정론 게이트만으로** 둘 다 accept/ALL_PASS/qualified, **Arbiter c0 선택**(동점 78), `pr_candidate ⇔ (selected ∧ accept ∧ ALL_PASS ∧ qualified)` 충족 → **draft PR pull/1**(auto-merge 없음), false_pass 0 / leak 0. **여전히 미충족**: orchestrator 자동층(1–10)·adversary(13·16)·다중이슈 자율루프(23·24·26)·코어 CLI의 PR브랜치(20은 wrapper). 관찰된 평가·검증 보강점은 §8.

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

| Lane                       | 목적                                 | 현재 상태               | 실행 방식                                                                                                         | 통과 기준                                                 |
| -------------------------- | ------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| RU-0 preflight             | 실제 환경 가능 여부 확인             | 필요                    | `codex --version`, `codex -c service_tier=fast login status`, `gh auth status`, `pnpm build`, `pnpm bundle:skill` | 불충족 시 `blocked`로 끝나고 PASS 금지                    |
| RU-1 사용자 지정 단일 이슈 | 가장 작은 진짜 사용자 흐름           | 일부 스크립트 초안 존재 | `scripts/uat/skill-real-user-codex-live-uat.mjs`를 package script로 연결 후 실행                                  | real LLM 수정 + accept/ALL_PASS/qualified + draft PR 후보 |
| RU-2 다중 이슈 순차 루프   | “문제 여러 개를 1개씩” 검증          | 미구현                  | cart quantity → sku normalization 순차 repo/run                                                                   | 각 issue가 독립 선택·수정·검증·PR 후보화                  |
| RU-3 자동 문제 발견        | 사용자가 문제를 안 지정한 경우       | 미구현                  | repo scan → discovery report → issue 1개 선택                                                                     | 선택 근거 + 한 issue만 task/eval화                        |
| RU-4 적대적 실패 케이스    | false pass 방지                      | 부분 fixture만          | protected path, hidden leak, test weakening, hardcode 후보를 실제 LLM/fixture 혼합으로 주입                       | 전부 reject 또는 no PR                                    |
| RU-5 실패/상한/복구        | timeout/budget/dirty/provenance 검증 | 미구현                  | dirty repo, budget 초과, provenance 변조, selected patch 재검증 실패 유도                                         | 안전 중단 + report 기록 + no PR                           |

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
6. **다음**: §8 B2·B3·B4(final reverify·provenance·budget)를 코어 CLI에 배선 → RU-5/F6·F7·F8.
7. 그 뒤 RU-4 실패 케이스, 이어서 RU-2/RU-3(다중이슈·자동발견).

## 8. R2 실측 기반 평가·검증 보강점 (관찰→근거→보강)

R2는 실 gpt-5.5 builder+challenger가 실 GitHub repo를 고쳐 draft PR까지 간 **첫 완전 실 run**이다. 그 과정에서 평가(quality)·검증(gate/selection/PR predicate)이 실제로 어떻게 동작했는지 직접 확인했고, 아래가 **실 run에서 드러난** 보강 우선순위다. (설계상 알던 한계가 이번에 경험적으로 확인된 것 포함.)

| #   | 관찰(R2 실측)                                                                                                   | 근거                                                                                       | 보강                                                                                                            | 매핑               |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------ |
| B1  | **동점 선택이 품질맹목**: 실 후보 2개가 score **78 동점**(changed_files/lines/evidence 동일)→Arbiter가 순서로 c0 | `selections/…json` 두 후보 모두 `score.total=78`, `selected=c0`                            | 결정론 점수는 동점을 **품질로 못 깸**. 2nd-context LLM 품질심사(별도 CLI/컨텍스트)로 동점만 분리, **accept/correctness는 불참** | plan P7 advisory   |
| B2  | **selected patch 최종 재검증 부재**: 각 후보는 자기 run worktree에서만 검증. 선택 후 c0 patch를 fresh base에 재적용+게이트 재실행하는 **하네스 단계 없음**. R2 PR브랜치는 wrapper가 `git apply`만 성공시켜 push | wrapper `git apply out.selected_patch`(게이트 재실행 아님)                                  | 하네스급 **final reverify**(선택 patch를 clean base 재적용→게이트 전체 재실행, 실패 시 no PR)                    | trust-floor #3 / F8 |
| B3  | **provenance/hash 바인딩 부재**: verified `eval-report`와 PR에 올라간 patch 사이 **hash 결속 없음**. wrapper가 `out.selected_patch` 경로를 신뢰     | `provenanceVerified` 하드코딩 true(이전 grep 검증)                                          | report↔patch **hash 결속 검증**(불일치 시 `ARTIFACT_PROVENANCE_MISMATCH` reject)                                | trust-floor #4 / F6 |
| B4  | **반복/비용 상한 미강제**: 후보 수가 2인 건 builder+challenger만 넘겼기 때문. 하네스 강제 cap 없음. 실 gpt-5.5는 **후보당 수 분/실비용**             | run 소요 시간(실측 수 분), `--challenger` 1개만 전달                                        | 하네스 **max candidates/rounds/token/time cap + budget**(초과 시 안전중단·no PR)                                | trust-floor #5 / F7 |
| B5  | **wrapper PR predicate가 코어보다 느슨**: `quality?.status !== 'fail'`만 검사 → quality-report 누락 시 soft pass, `qualified`(met===true) 미강제 | wrapper line 168–172(현재 `quality?.met === true`로 **수정 완료**) | §0 공식의 `∧ qualified`와 정렬: `quality.met===true` 필수, 누락=fail-closed (**이미 보강함**)                    | 이 커밋에서 수정    |

**핵심 한 줄**: R2는 *"실 LLM이 고치고 결정론 게이트가 거른다"* 까지는 실증했지만, **선택 이후의 신뢰층(B1 동점 품질심사 · B2 최종 재검증 · B3 provenance · B4 상한)** 이 비어 있다. 다음 실 run(RU-1 안정화 후) 전에 B2·B3·B4(trust-floor)를 코어 CLI에 배선하는 것이 우선이고, B1은 advisory(accept 불참)로만 더한다.
