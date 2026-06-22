# AGENTS.md

이 파일은 이 저장소에서 작업하는 Codex/AI agent가 반드시 따라야 하는 프로젝트 목적, 제품화 방향, 구현 원칙, 검증 규칙을 명문화한다.

## 1. 프로젝트 정체성

이 저장소는 **VibeLoop Harness** 프로젝트다.

VibeLoop Harness의 목적은 Codex, Claude Code, Gemini 같은 AI 코딩 에이전트가 만든 코드 변경을 그대로 신뢰하는 것이 아니라, 격리된 worktree에서 실행하고 `task.yaml`, `eval.yaml`, builtin guards, hidden acceptance, improvement evidence, deterministic decision engine으로 검증하여 **안전한 PR 후보인지 판정하는 AI 코드 변경 검증 하네스**를 만드는 것이다.

핵심 질문은 다음이다.

```text
AI가 코드를 작성했는가?
```

이 아니라,

```text
이 변경이 진짜 개선임을 재현 가능한 증거로 판정할 수 있는가?
```

이다.

## 2. 혼동 금지

이 프로젝트는 단순한 PR 생성 도구가 아니다. 또한 Skill 전용 프로젝트도 아니다.

| 오해                                         | 실제 목적                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| AI가 만든 코드를 자동으로 merge하는 도구     | 자동 merge는 금지. 통과한 변경도 PR 후보까지만 간다.                           |
| Skill만 만들면 되는 프로젝트                 | Skill은 첫 제품 채널일 뿐이다. 핵심은 범용 검증 커널이다.                      |
| LLM이 스스로 수정하고 스스로 통과시키는 구조 | 수정은 agent가 할 수 있지만, 최종 판정은 deterministic decision engine만 한다. |
| 장바구니 예제 앱 프로젝트                    | 장바구니는 하네스 실사용 UAT fixture다.                                        |
| 웹 UI 중심 제품                              | 핵심은 CLI/SDK 기반 verification kernel이다. UI는 관리 계층이다.               |
| GitHub/CI/PR을 통과시키는 것이 목적          | GitHub와 CI는 출판·회귀 확인 도구일 뿐이다. 목적은 내부 루프가 개선을 증명하는 것이다. |

## 3. 제품 목표

최종 제품 방향은 다음과 같다.

```text
문제 발견 또는 사용자 task
→ 한 번에 1개 문제 선택
→ isolated git worktree 생성
→ builder agent가 write_scope 안에서 수정
→ guards/eval/hidden acceptance/evidence 검증
→ deterministic decision
→ accepted 후보 중 best-known 개선분 선택
→ 선택 개선분을 PR 후보로 출판
→ 다음 문제로 반복
```

단, 완전 자율 반복 루프는 검증 커널 안정화 이후 단계다. 현재 우선순위는 **검증 커널 모듈화 + Skill-first 제품화**다.

## 4. Skill-first 제품화 원칙

VibeLoop은 Skill로 제품화할 수 있지만, Skill에 종속되면 안 된다.

제품화 전략은 다음 순서를 따른다.

```text
검증 커널을 재사용 가능한 모듈로 고정
→ CLI / SDK / API / CI / Skill이 같은 커널 호출
→ 우선 Skill은 가장 얇은 wrapper로 제품화
→ 이후 GitHub Action, PR Bot, Server API, Autonomous Worker로 확장
```

Skill은 사용자 경험과 실행 절차만 담당한다.

| Skill이 할 일                         | Skill이 하지 말아야 할 일 |
| ------------------------------------- | ------------------------- |
| 사용자 요청을 task/eval 초안으로 변환 | 직접 accept/reject 판정   |
| 적절한 agent 실행 방식 선택           | hidden test 노출          |
| CLI/SDK 호출                          | core 로직 재구현          |
| eval-report 요약                      | gate 결과 조작            |
| 실패 이유와 다음 조치 안내            | token/API key 저장        |

## 5. 모듈 분리 방향

모든 구현은 아래 목표 구조와 충돌하지 않아야 한다.

```text
@vibeloop/core 또는 @vibeloop/sdk
  - runOnce(options)
  - verifyPatch(options)
  - discoverCandidates(options)
  - createDraftPrIfAccepted(options)

@vibeloop/contracts
  - task/eval/eval-report schema
  - public TypeScript types
  - templates

@vibeloop/agent-adapters
  - command adapter
  - codex adapter
  - Codex OAuth proxy adapter
  - API-key proxy adapter
  - future Claude/Gemini/custom adapters

@vibeloop/cli
  - argument parsing
  - exit code mapping
  - SDK/core 호출만 담당

skills/vibeloop-harness
  - SKILL.md
  - task/eval templates
  - report summarizer
  - local runbook
```

중요: CLI, Skill, CI, API 서버가 서로 다른 판정 로직을 갖게 만들면 안 된다. 모든 채널은 같은 core/sdk 결과를 사용해야 한다.

## 6. 신뢰 경계와 판정 권한

| 역할            | 수정 가능 여부              | 최종 판정 권한           |
| --------------- | --------------------------- | ------------------------ |
| Builder Agent   | `write_scope` 안에서만 가능 | 없음                     |
| Eval Runner     | 수정 없음, 명령 실행        | 없음                     |
| Advisory/Critic | 수정 없음                   | advisory only            |
| Decision Engine | 수정 없음                   | 최종 deterministic 판정  |
| Human Reviewer  | 승인/거절/추가 테스트 요청  | high-risk final decision |

반드시 지킬 규칙:

- LLM output만으로 `accept` 처리하지 않는다.
- `eval-report.json` 없는 patch는 PR 후보가 될 수 없다.
- protected path, eval, CI, secret, auth, DB, deploy 변경은 자동 accept하지 않는다.
- hidden acceptance 원문은 agent/Skill에 노출하지 않는다.
- test weakening, `test.skip`, 의미 없는 assertion, allowed scope 밖 변경은 reject 또는 human review로 간다.

## 7. 보안 규칙

- OAuth token, `~/.codex/auth.json`, API key 원문을 출력하거나 artifact에 저장하지 않는다.
- proxy log에는 Authorization header의 존재 여부만 기록한다.
- secret redaction은 wrapper가 아니라 reusable module에서 보장한다.
- worktree와 artifact는 대상 repo 내부가 아니라 하네스 데이터 디렉터리에 둔다.
- agent process env는 scrubbed env를 사용한다.
- API-key 경로는 보존하되, 기본 UAT 경로는 ChatGPT login 기반 no-API-key OAuth proxy다.

## 8. 현재 중요한 실행 명령

일반 검증:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
git diff --check
```

실사용 fixture 검증:

```bash
pnpm test:scenario:user
```

Codex ChatGPT login + OAuth proxy 실환경 UAT:

```bash
pnpm uat:codex-oauth
```

API-key proxy 보존 경로:

```bash
pnpm uat:codex-proxy
```

현재 대표 UAT 기준:

| 기준          | 통과 조건                                               |
| ------------- | ------------------------------------------------------- |
| auth          | `Logged in using ChatGPT`                               |
| model         | `gpt-5.5`                                               |
| reasoning     | `xhigh`                                                 |
| final         | `status=accepted`, `decision=accept`, reason `ALL_PASS` |
| changed files | `src/cart.cjs`, `tests/cart-quantity.test.cjs`          |
| security      | hidden/token 원문 비노출                                |

## 9. 주요 문서 우선순위

작업 전 아래 문서를 먼저 확인한다.

| 문서                                                       | 용도                                |
| ---------------------------------------------------------- | ----------------------------------- |
| `docs/PRODUCT_SPEC.md`                                     | 제품 목적과 범위                    |
| `docs/ARCHITECTURE.md`                                     | 검증 커널 구조와 금지 아키텍처      |
| `docs/EVAL_ENGINE_SPEC.md`                                 | gate, evidence, final decision 기준 |
| `docs/USER_SCENARIO_TESTING.md`                            | 실제 사용자 UAT와 Codex OAuth 경로  |
| `docs/MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md` | 모듈 분리와 Skill-first 제품화 전략 |
| `dev-plan/implement_20260613_085309.md`                    | 모듈 분리 + Skill 제품화 실행 계획  |
| `docs/AUTONOMOUS_LOOP_SPEC.md`                             | 장기 자율 루프 설계                 |

## 10. 개발 계획 규칙

새로운 구현 workstream은 `dev-plan/implement_YYYYMMDD_HHMMSS.md`로 계획을 먼저 만든다.

개발 계획에는 반드시 포함한다.

- 개발 목적
- 개발 범위
- 제외 범위
- 참조 문서
- 공통 진행 규칙
- Phase별 구현 태스크
- Phase별 자체 테스트
- 완료 조건

진행 중 체크박스는 실제 상태와 일치해야 한다.

## 11. 작업 방식

- 목적을 벗어나는 리팩터링을 하지 않는다.
- 기존 검증 커널의 신뢰 경계를 약화하지 않는다.
- Skill 제품화 작업에서도 core 판정 로직을 Skill에 복사하지 않는다.
- 문서 변경만 한 경우에도 `git diff --check`는 실행한다.
- 코드 변경 시 최소 `pnpm typecheck`, `pnpm lint`, 관련 test를 실행한다.
- UAT 관련 변경 시 `pnpm test:scenario:user`와 가능하면 `pnpm uat:codex-oauth`를 실행한다.
- 최종 보고에는 변경 파일, 검증 명령, 통과/실패 결과를 분리해서 쓴다.

## 12. 현재 우선순위

현재 우선순위는 다음 순서다.

1. `@vibeloop/sdk` 또는 equivalent core API 경계 고정
2. CLI `runKernel`을 SDK/core 호출 구조로 분리
3. Codex OAuth proxy runner를 reusable module로 이동
4. `skills/vibeloop-harness` skeleton 생성
5. Skill용 task/eval templates 작성
6. eval-report summarizer 작성
7. Skill-first UAT와 기존 e2e 회귀 검증
8. 이후 GitHub Action, PR Bot, Server API, autonomous loop 확장

## 13. 한 줄 원칙

```text
수정은 AI agent가 할 수 있지만, 통과 판정은 VibeLoop deterministic verification kernel만 한다.
```
