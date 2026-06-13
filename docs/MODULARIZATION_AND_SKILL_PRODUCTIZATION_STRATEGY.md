# 모듈 분리 및 Skill 제품화 전략

## 1. 결론

VibeLoop Harness는 **Skill 전용 프로젝트가 아니다.** 핵심은 AI 코드 변경을 격리 실행하고, 고정된 gate와 evidence로 `accept | reject | needs_human_review | needs_more_tests`를 판정하는 **범용 검증 커널**이다.

따라서 제품화 전략은 아래 순서가 맞다.

```text
검증 커널을 재사용 가능한 모듈로 고정
→ CLI/SDK/API/CI/Skill이 같은 커널을 호출
→ 우선 Skill은 가장 얇은 wrapper로 제품화
→ 이후 GitHub Action, PR Bot, 서버 API, 자율 루프가 같은 모듈을 재사용
```

핵심 원칙은 **Skill에 비즈니스 로직을 넣지 않는 것**이다. Skill은 사용자 경험과 실행 프롬프트만 담당하고, 실제 실행·검증·판정은 모듈화된 VibeLoop 코어가 담당해야 한다.

## 2. 제품 목적 재정의

| 구분             | 정의                                                         |
| ---------------- | ------------------------------------------------------------ |
| 제품의 본질      | AI가 만든 코드 변경을 검증 가능한 patch 후보로 만드는 하네스 |
| 1차 제품화       | Codex Skill 형태의 “AI 수정 검증 실행기”                     |
| 장기 제품화      | CLI, SDK, CI gate, GitHub PR bot, 서버/API, 자율 개선 루프   |
| 최종 판정권      | LLM이 아니라 deterministic decision engine                   |
| 사용자가 얻는 것 | “이 AI 수정이 PR 후보로 안전한가?”에 대한 재현 가능한 report |

## 3. 현재 구조와 목표 모듈 구조

### 현재 패키지 상태

| 현재 패키지                    | 현재 책임                                        | 제품화 관점                                |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------ |
| `@vibeloop/sdk`                | `runKernel`, `runOnce`, `verifyPatch` public API | CLI/Skill/Server/CI가 재사용할 core 진입점 |
| `@vibeloop/cli`                | `vibeloop run/discover/retry/report/gc` CLI      | argument parsing 후 SDK 호출               |
| `@vibeloop/task-protocol`      | `task.yaml`, `eval.yaml` 로딩/검증               | 독립 모듈 유지                             |
| `@vibeloop/workspace-runner`   | git worktree, env scrub, dependency provisioning | 독립 모듈 유지                             |
| `@vibeloop/agent-adapters`     | Codex/mock/command agent 실행, proxy helper      | adapter registry로 확장 필요               |
| `@vibeloop/eval-engine`        | gate 실행, baseline, evidence, decision          | core 판정 모듈로 유지                      |
| `@vibeloop/guards`             | diff/protected/scope/limits guard                | core guard 모듈로 유지                     |
| `@vibeloop/artifacts`          | run layout, manifest, report artifact            | core persistence 모듈로 유지               |
| `@vibeloop/discovery`          | 문제 후보 dry-run 발견                           | 자율 루프 입력 모듈                        |
| `@vibeloop/github-integration` | branch/PR 생성                                   | PR 제품화 모듈                             |
| `@vibeloop/report-html`        | report 렌더링                                    | UI/공유용 모듈                             |
| `apps/server`, `apps/web`      | API/UI                                           | 관리 계층, core 밖                         |

### 목표 모듈 구조

```text
@vibeloop/core
  ├─ runKernel(options)              # 단일 검증 루프 API
  ├─ validateContracts(task, eval)
  ├─ createCandidatePatch()
  ├─ runVerificationGates()
  └─ decide()

@vibeloop/contracts
  ├─ task/eval/eval-report schema
  ├─ TypeScript types
  └─ example templates

@vibeloop/agent-adapters
  ├─ command adapter
  ├─ codex adapter
  ├─ oauth proxy adapter
  ├─ api-key proxy adapter
  └─ future: claude/gemini/custom

@vibeloop/sdk
  ├─ runKernel()              # 현재 구현된 커널 API
  ├─ runOnce()                # CLI/Skill/Server 공용 실행 API
  ├─ verifyPatch()            # patch 검증 API 초안
  ├─ discoverCandidates()     # backlog
  └─ createDraftPrIfAccepted()# backlog

@vibeloop/cli
  └─ SDK를 호출하는 thin CLI

@vibeloop/skill
  └─ Codex Skill wrapper: prompt/runbook/scripts only

@vibeloop/github-action
  └─ CI gate wrapper

@vibeloop/server
  └─ API/orchestrator wrapper
```

## 4. 모듈 분리 원칙

| 원칙                    | 설명                                                | 이유                                       |
| ----------------------- | --------------------------------------------------- | ------------------------------------------ |
| Core first              | 검증 커널은 UI/Skill/CLI와 분리                     | 모든 제품 형태가 같은 판정을 재사용해야 함 |
| Thin wrapper            | Skill, CLI, CI는 core를 호출만 함                   | 제품 채널별 로직 중복 방지                 |
| Contract first          | `task.yaml`, `eval.yaml`, `eval-report.json`이 경계 | 외부 도구와 쉽게 연동 가능                 |
| Adapter boundary        | Codex/OAuth/Claude/Gemini는 adapter로 분리          | 모델/인증 방식 교체 가능                   |
| Deterministic authority | 최종 accept는 decision engine만 결정                | LLM 자기평가 문제 방지                     |
| Artifact as API         | report/log/diff가 재실행 가능한 증거                | Skill 밖에서도 검증 가능                   |
| No secret in wrapper    | Skill과 report에는 token/API key 원문 금지          | 제품화 보안 조건                           |

## 5. Skill 우선 제품화 전략

### 5.1 Skill의 역할

Skill은 “제품 채널”이지 “판정 엔진”이 아니다.

| Skill이 할 일                         | Skill이 하지 말아야 할 일    |
| ------------------------------------- | ---------------------------- |
| 사용자 요청을 task/eval 초안으로 변환 | 직접 accept/reject 판정      |
| 적절한 실행 명령 선택                 | hidden test 노출             |
| `vibeloop run` 또는 SDK 호출          | auth token/API key 직접 저장 |
| report 요약                           | gate 결과 조작               |
| 실패 시 다음 조치 안내                | core 로직 재구현             |

### 5.2 Skill 제품 UX

사용자는 이렇게 쓴다.

```text
“이 repo에서 실패하는 테스트 하나를 고치고, 통과하면 PR 후보로 만들어줘.”
```

Skill은 내부적으로 아래 순서를 수행한다.

| 단계 | Skill 동작                                              | Core/CLI 동작                   |
| ---- | ------------------------------------------------------- | ------------------------------- |
| 1    | repo 목적과 테스트 명령 확인                            | 없음                            |
| 2    | `task.yaml` 초안 생성                                   | contract validation             |
| 3    | `eval.yaml` 초안 또는 기존 eval 선택                    | contract validation             |
| 4    | agent 실행 방식 선택: Codex OAuth / command / API proxy | adapter 실행                    |
| 5    | `vibeloop run` 실행                                     | worktree, diff, gates, decision |
| 6    | `eval-report.json` 읽기                                 | artifact 생성 완료              |
| 7    | 통과/실패/보류를 사용자에게 설명                        | 없음                            |

### 5.3 Skill 패키지 구성안

```text
skills/vibeloop-harness/
  SKILL.md
  scripts/
    vibeloop-run.mjs              # local CLI/SDK 호출 wrapper
    create-task-eval.mjs          # task/eval 초안 생성 helper
    summarize-report.mjs          # eval-report 요약
  templates/
    task-minimal.yaml
    eval-node.yaml
    eval-python.yaml
    eval-web.yaml
  references/
    usage.md
    safety.md
    report-interpretation.md
```

### 5.4 Skill 명령 모드

| 모드           | 사용자 의도            | 내부 실행                                                     |
| -------------- | ---------------------- | ------------------------------------------------------------- |
| `verify-only`  | 사람이 만든 patch 검증 | `vibeloop run --agent "command:git apply ..."` 또는 eval-only |
| `fix-once`     | AI가 한 문제 수정      | `vibeloop run --agent command:codex ...`                      |
| `oauth-uat`    | 실환경 Codex 검증      | `pnpm uat:codex-oauth` 또는 SDK equivalent                    |
| `discover`     | 문제 후보 찾기         | `vibeloop discover`                                           |
| `report`       | 결과 요약              | `vibeloop report <loop-id>` 또는 report parser                |
| `pr-candidate` | PR 후보 만들기         | `github-integration` 모듈 호출                                |

## 6. Skill 밖 활용 채널

| 활용 채널         | 필요한 wrapper                 | 핵심 재사용 모듈      | 사용 예                    |
| ----------------- | ------------------------------ | --------------------- | -------------------------- |
| CLI 제품          | `@vibeloop/cli`                | core/sdk              | 로컬 개발자가 직접 실행    |
| Codex Skill       | `skills/vibeloop-harness`      | cli/sdk               | Codex 안에서 자연어로 실행 |
| GitHub Action     | `@vibeloop/github-action`      | sdk/contracts         | PR마다 검증 report 생성    |
| PR Bot            | `@vibeloop/github-integration` | sdk/github            | `ALL_PASS`만 draft PR 생성 |
| 서버 API          | `apps/server`                  | sdk/artifacts         | 팀 단위 실행 이력 관리     |
| Web Dashboard     | `apps/web`                     | server/report-html    | report 조회/승인 UI        |
| 외부 orchestrator | SDK                            | discovery/core/github | cron/queue 기반 반복 개선  |
| MCP/tool plugin   | MCP wrapper                    | sdk                   | ChatGPT/Codex tool로 호출  |
| 사내 DevEx 플랫폼 | SDK/API                        | core/contracts        | 여러 repo 표준 게이트      |

## 7. 우선 개발 순서

### Phase A — Core API 고정

| 작업                                                | 산출물                                                       | 완료 기준                        |
| --------------------------------------------------- | ------------------------------------------------------------ | -------------------------------- |
| `@vibeloop/core` 또는 `@vibeloop/sdk` thin API 정의 | `runOnce(options)`, `verifyPatch(options)`                   | CLI가 API를 통해서만 kernel 실행 |
| CLI `runKernel`을 SDK로 이동                        | `packages/sdk/src/run-once.ts`                               | CLI는 argument parsing만 담당    |
| `RunResult` 타입 고정                               | `loopId`, `status`, `decision`, `reportPath`, `artifactRoot` | Skill/CI/API가 동일 타입 사용    |

### Phase B — Adapter/Proxy 분리

| 작업                                              | 산출물                                 | 완료 기준                           |
| ------------------------------------------------- | -------------------------------------- | ----------------------------------- |
| Codex OAuth proxy runner를 reusable module로 이동 | `@vibeloop/agent-adapters/oauth-proxy` | UAT script와 Skill이 같은 함수 사용 |
| agent registry 도입                               | `resolveAgentAdapter(spec)`            | CLI/SDK/Skill 모두 같은 spec 사용   |
| secret redaction helper 통합                      | `redactSecrets()`                      | OAuth/API key 원문 artifact 0건     |

### Phase C — Skill 제품화

| 작업                       | 산출물                             | 완료 기준                      |
| -------------------------- | ---------------------------------- | ------------------------------ |
| Skill skeleton 작성        | `skills/vibeloop-harness/SKILL.md` | 자연어 요청을 실행 절차로 변환 |
| task/eval templates 작성   | `templates/*.yaml`                 | Node/Python/Web 최소 3종       |
| report summarizer 작성     | `scripts/summarize-report.mjs`     | `ALL_PASS`/reject 이유 요약    |
| local install/runbook 작성 | `references/usage.md`              | 사용자가 repo에 붙여 실행 가능 |

### Phase D — 제품 채널 확장

| 작업                  | 산출물                                     | 완료 기준                    |
| --------------------- | ------------------------------------------ | ---------------------------- |
| GitHub Action wrapper | `.github/actions/vibeloop` 또는 npm action | PR check로 report 생성       |
| PR candidate creator  | `createDraftPrIfAccepted()`                | `accept` 외에는 PR 생성 금지 |
| server API SDK 연결   | `apps/server`가 SDK 호출                   | CLI와 서버 판정 동일         |
| autonomous loop 연결  | discovery → task-gen → runOnce → PR        | 1 candidate씩 순차 처리      |

## 8. 제품화 MVP: Skill-first 범위

Skill 제품화의 첫 버전은 아래만 포함한다.

| 포함                              | 제외                          |
| --------------------------------- | ----------------------------- |
| 단일 repo, 단일 문제              | 무한 자율 루프                |
| Codex OAuth 실행                  | 멀티 agent rotation           |
| `task.yaml`/`eval.yaml` 생성 보조 | 자동 merge                    |
| `vibeloop run` 호출               | 복잡한 대시보드               |
| report 요약                       | 대규모 병렬 실행              |
| 실패 시 다음 조치 안내            | 모든 언어/framework 자동 지원 |

이 범위가 좋은 이유는 다음과 같다.

1. 현재 검증 커널과 UAT가 이미 존재한다.
2. Skill은 얇은 wrapper라 빠르게 제품화 가능하다.
3. 같은 모듈을 CLI/CI/서버/API로 확장할 수 있다.
4. “AI가 직접 판단한다”는 신뢰 문제를 피할 수 있다.

## 9. Skill 제품 사용 예시

### 9.1 AI가 한 문제 수정 후 검증

```text
사용자: 이 repo에서 실패하는 장바구니 수량 계산 문제 하나를 고치고, hidden test까지 통과하면 PR 후보로 정리해줘.

Skill:
1. task/eval 확인 또는 생성
2. Codex OAuth 경로 선택
3. vibeloop run 실행
4. eval-report 확인
5. ALL_PASS면 변경 파일과 PR 후보 요약 제시
```

### 9.2 사람이 만든 patch 검증

```text
사용자: 이 patch가 실제 개선인지 VibeLoop 기준으로 검증해줘.

Skill:
1. patch를 임시 worktree에 적용
2. eval.yaml gate 실행
3. test-on-base evidence 확인
4. accept/reject 결과 제시
```

### 9.3 CI 실패 자동 후보화

```text
사용자: test 로그에서 하나의 low-risk candidate만 뽑아서 수정 루프를 돌려줘.

Skill:
1. vibeloop discover 실행
2. candidate 하나 선택
3. task.yaml 생성
4. runOnce 실행
5. 결과 report 제시
```

## 10. 모듈 분리 후 가능한 제품 목록

| 제품              | 설명                          | 모듈만 분리되면 가능한 이유        |
| ----------------- | ----------------------------- | ---------------------------------- |
| Codex Skill       | 자연어로 AI 수정 검증 실행    | Skill이 SDK/CLI만 호출하면 됨      |
| npm CLI           | `vibeloop run` 독립 도구      | 이미 CLI 구조 존재                 |
| GitHub Action     | PR check로 eval-report 생성   | SDK + contracts + artifacts 재사용 |
| PR Bot            | `ALL_PASS`만 draft PR         | github-integration 재사용          |
| SaaS Dashboard    | 여러 repo 실행 이력 관리      | server/web가 SDK 결과 저장         |
| 사내 DevEx Gate   | AI PR 표준 검증               | core가 독립이면 플랫폼에 삽입 가능 |
| MCP Tool          | ChatGPT/Codex에서 tool로 호출 | SDK를 MCP command로 감싸면 됨      |
| Autonomous Worker | 문제 발견→수정→검증 반복      | discovery + sdk + github 조합      |

## 11. 위험과 예방책

| 위험                       | 예방책                                                         |
| -------------------------- | -------------------------------------------------------------- |
| Skill에 판정 로직이 들어감 | Skill은 report 해석만 하고 최종 판정은 core output 그대로 사용 |
| agent가 eval을 약화        | protected path + test integrity + hidden acceptance 유지       |
| OAuth token 노출           | proxy log는 auth header 존재 여부만 기록, token 원문 저장 금지 |
| 제품 채널마다 결과가 다름  | 모든 채널이 동일 SDK `RunResult` 사용                          |
| task/eval 생성 품질 낮음   | templates + schema validation + human 확인 모드 제공           |
| 자동 PR 스팸               | `ALL_PASS` + risk low + open PR 상한 + human review gate       |

## 12. 바로 다음 실행 계획

| 우선순위 | 작업                                                | 파일/모듈                                              |
| -------- | --------------------------------------------------- | ------------------------------------------------------ |
| P0       | `@vibeloop/sdk` 생성, `runOnce()`로 CLI kernel 추출 | `packages/sdk`                                         |
| P0       | Skill skeleton 생성                                 | `skills/vibeloop-harness/SKILL.md`                     |
| P0       | Skill용 task/eval template 3종 작성                 | `skills/vibeloop-harness/templates/`                   |
| P1       | OAuth proxy runner를 reusable module로 이동         | `packages/agent-adapters/src/oauth-proxy.ts`           |
| P1       | report summarizer 작성                              | `skills/vibeloop-harness/scripts/summarize-report.mjs` |
| P1       | 실제 repo 연결 smoke test 작성                      | `tests/e2e/skill-productization/`                      |
| P2       | GitHub Action wrapper 설계                          | `packages/github-action` 또는 `.github/actions`        |
| P2       | PR candidate creator를 SDK API로 노출               | `packages/github-integration`                          |

## 13. 최종 판단

모듈만 제대로 분리하면 VibeLoop Harness는 Skill에 갇히지 않는다. Skill은 첫 번째 제품 채널일 뿐이고, 핵심 자산은 다음 3개다.

```text
1. contracts: task/eval/report
2. core/sdk: runOnce + deterministic decision
3. adapters: Codex/OAuth/command/GitHub/CI
```

따라서 **우선 Skill로 제품화하되, Skill 내부에는 core 로직을 넣지 않고 SDK/CLI를 호출하는 얇은 제품 wrapper로 만든다.** 이 구조가 되어야 이후 CLI, CI, PR bot, SaaS, autonomous worker로 자연스럽게 확장된다.

## 10. 현재 구현 반영 상태 (2026-06-13)

| 영역                 | 현재 상태                                                                   | 증거 파일                                                                      |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| SDK/API              | `@vibeloop/sdk`가 `runKernel`, `runOnce`, `verifyPatch`, 공개 타입을 export | `packages/sdk/src/index.ts`, `packages/sdk/src/run-once.ts`                    |
| CLI thin wrapper     | `@vibeloop/cli`는 argument parsing 후 SDK를 호출                            | `packages/cli/src/commands/run.ts`, `packages/cli/src/run.ts`                  |
| Server reuse         | server runner가 CLI가 아니라 SDK를 import                                   | `apps/server/src/runner.ts`                                                    |
| OAuth proxy module   | Codex OAuth proxy가 reusable adapter로 분리                                 | `packages/agent-adapters/src/oauth-proxy.ts`                                   |
| Skill package        | Codex Skill skeleton, templates, safety/usage reference 추가                | `skills/vibeloop-harness/SKILL.md`                                             |
| Skill scripts        | task/eval 생성, CLI wrapper, report summarizer 추가                         | `skills/vibeloop-harness/scripts/*.mjs`                                        |
| Skill-first e2e      | template 생성, wrapper 실행, summarizer redaction 검증                      | `tests/e2e/skill-productization/skill-productization.e2e.test.ts`              |
| Skill loop UAT       | 임시 git repo에서 여러 문제를 1개씩 수정·검증·commit·PR 후보 branch화       | `scripts/uat/skill-real-user-loop-uat.mjs`, `docs/SKILL_REAL_USER_LOOP_UAT.md` |
| Adversarial loop UAT | hidden bypass/protected path/test-integrity/context leak 실패 차단 검증     | `scripts/uat/skill-real-user-loop-adversarial-uat.mjs`                         |
| Runbook              | 제품화 실행 절차와 다음 채널 backlog 문서화                                 | `docs/SKILL_PRODUCTIZATION_RUNBOOK.md`                                         |

현재 구현은 `@vibeloop/core`라는 별도 패키지를 새로 만들지 않고, 기존 커널을 `@vibeloop/sdk`의 public API로 먼저 고정한 상태다. 따라서 제품 채널은 아래처럼 연결한다.

```text
Codex Skill / CLI / Server / future CI
        ↓
@vibeloop/sdk
        ↓
workspace-runner + agent-adapters + guards + eval-engine + artifacts
        ↓
eval-report.json / deterministic decision
```

다음 확장은 새 판정 로직을 만들지 말고 `@vibeloop/sdk` 호출 wrapper만 추가해야 한다.
