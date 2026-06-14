<div align="center">

<img width="2752" height="1536" alt="AI 코드 검증 도구 바이브루프" src="https://github.com/user-attachments/assets/1405515b-14ff-41e9-9e47-7353fad3ce3e" />

# 🔁 VibeLoop Harness

**AI가 만든 코드 변경을 한 번에 하나씩 격리 실행하고, 고정된 결정론 게이트로만 검증해, 통과한 것만 draft PR 후보로 올리는 자율 개선 루프 하네스**

[![CI](https://github.com/coreline-ai/improvement_loop_harness/actions/workflows/ci.yml/badge.svg)](https://github.com/coreline-ai/improvement_loop_harness/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white)
![Vitest](https://img.shields.io/badge/tested%20with-Vitest-6E9F18?logo=vitest&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-7-2D3748?logo=prisma&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-API-000000?logo=fastify&logoColor=white)
![packages](https://img.shields.io/badge/monorepo-12%20packages%20%2F%202%20apps-blue)
![LOC](https://img.shields.io/badge/TypeScript-~17k%20LOC-3178C6)
![status](https://img.shields.io/badge/status-alpha%20v0.1.0-orange)
![license](https://img.shields.io/badge/license-UNLICENSED%20(private)-lightgrey)

</div>

---

## 📖 목차

- [왜 필요한가](#-왜-필요한가)
- [핵심 원칙](#-핵심-원칙)
- [동작 방식](#-동작-방식)
- [PR 후보 계약](#-pr-후보-계약-correctness--quality)
- [신뢰 바닥(Trust Floor)](#%EF%B8%8F-신뢰-바닥trust-floor)
- [에이전트](#-에이전트builder-llm)
- [Quickstart](#-quickstart)
- [CLI 명령](#-cli-명령)
- [Skill 제품 채널](#-skill-제품-채널)
- [모노레포 구조](#%EF%B8%8F-모노레포-구조)
- [검증 & 실행 증거](#-검증--실행-증거)
- [문서](#-문서)
- [현재 상태](#-현재-상태정직한-범위)

---

## 🎯 왜 필요한가

LLM 코딩 에이전트는 빠르게 패치를 만들지만, **"정말 고쳤는지"** 는 모델 자신이 보증할 수 없다(모델이 모델을 느슨하게 통과시키는 문제). VibeLoop Harness는 그 판정을 **모델에서 떼어내** 고정된 결정론 검증 커널로 옮긴다.

> **LLM은 후보를 만들고, 하네스는 고정된 Verifier / Evaluator / Arbiter 로만 판정한다.**
> accept·select·PR 후보화 어디에도 LLM 투표가 없다.

---

## 🧱 핵심 원칙

| | 원칙 | 의미 |
| --- | --- | --- |
| 🔒 | **격리 실행** | 모든 후보는 base commit에 묶인 **독립 git worktree**에서 실행된다(사용자 repo 비오염). |
| ⚖️ | **결정론 판정** | accept/reject는 15개 first-match-wins 규칙 엔진이 결정한다. LLM 개입 없음. |
| 🎯 | **한 번에 1개** | 한 루프는 **이슈 1개**만 다룬다. 범위가 명확해야 검증이 명확하다. |
| 🧪 | **증거 기반** | "고쳤다"는 base에서 실패하던 테스트가 candidate에서 통과(test-on-base) 등 **증거**로만 인정. |
| 🛡️ | **누설 차단** | hidden 수용 테스트·토큰·시크릿이 stdout/report/PR에 새지 않도록 스캔·차단. |
| 🚫 | **auto-merge 금지** | 통과해도 **draft PR 후보**까지만. 병합은 사람이. |

---

## 🔧 동작 방식

```mermaid
flowchart TD
    A[task.yaml + eval.yaml + agent spec] --> B[격리 worktree @ base commit]
    B --> C[Agent 실행<br/>builder/challenger 후보 패치]
    C --> D[Guards<br/>diff·scope·protected·test-integrity·artifact-leak]
    D --> E[Gates<br/>builtin + project: tests·typecheck·lint·security·hidden_acceptance]
    E --> F[Evidence + Quality Evaluator]
    F --> G{Decision Engine<br/>15 rules · first-match-wins}
    G -->|accept ∧ qualified| H[Arbiter<br/>결정론 score로 best-known 선택]
    G -->|아니면| X[reject / needs_review → PR 없음]
    H --> I[Final Verify<br/>B2 재실행 + B3 provenance hash]
    I -->|passed| J[✅ PR 후보 = draft PR<br/>no auto-merge]
    I -->|실패| X
```

- **단일 실행**(`run`): 위 한 줄기를 1회. 한 task를 검증.
- **개선 루프**(`improve`): builder 여러 + challenger를 후보 풀로 돌리고, **accepted 후보 중** Arbiter가 best-known을 고른 뒤 최종 재검증.
- **자동 모드**(`orchestrate`): repo를 스캔해 문제를 발견 → 1개씩 선택 → task를 **자동 생성** → 위 루프를 다중 이슈에 순차 적용(결정론 오케스트레이션, LLM은 builder뿐).

---

## ✅ PR 후보 계약 (correctness ∧ quality)

```text
PR 후보  ⇔  selected ∧ accept ∧ ALL_PASS ∧ qualified ∧ final_verification.passed
```

| 항목 | 무엇 | 출처 |
| --- | --- | --- |
| `accept` / `ALL_PASS` | **정확성** — 모든 required 게이트 통과 + 증거 충족, 가드 위반 없음 | Decision Engine(15 rules) |
| `qualified` | **품질** — 결정론 evaluator 블록(변경 규모·protected·최소 증거 등) 통과 | Quality Evaluator(M0) |
| `selected` | accepted 후보들 중 Arbiter가 고른 best-known | `score = evidence×100 − files×5 − lines` |
| `final_verification.passed` | 선택 patch를 **fresh base에 재적용·전체 게이트 재실행** + report↔patch 해시 일치 | Trust Floor B2·B3 |

종료 코드: `accept=0` · `reject=10` · `cancelled=20` · `failed=2`.

---

## 🛡️ 신뢰 바닥(Trust Floor)

"선택 이후 산출물 신뢰"를 보장하는 코어 게이트:

| | 게이트 | 동작 |
| --- | --- | --- |
| **B1** | 동점 품질심사(advisory) | score 무차별 동점일 때만 **별도 컨텍스트** 심사가 선호를 표함. correctness 불참, 동점 집합 밖 선택 불가. |
| **B2** | selected patch 최종 재검증 | 선택 patch를 **새 worktree에 재적용 → 전체 게이트 재실행**. `accept ∧ qualified` 재현 못 하면 PR 없음. |
| **B3** | provenance/hash 바인딩 | 검증된 report에 기록된 `candidate_patch_hash`·gate artifact 해시를 **선택 시점 재확인**. 불일치 → reject. |
| **B4** | 반복/비용 상한 | `--max-candidates`(기본 24 백스톱) + 선택적 wall-clock deadline. 초과 시 안전 중단(`cap_hit` 기록). |
| **#1** | dirty 가드 | base 자동해석 + source repo dirty면 **거부**(`--allow-dirty`/pinned base 예외). |
| 🔐 | OS 격리(R1) | `docker run --rm --network none`로 게이트/replay를 컨테이너 격리(선택). |
| 🙈 | 누설 차단 | agent stdout/patch/gate log를 스캔·redact, hidden 수용 테스트·토큰 노출 시 차단. |

---

## 🤖 에이전트(Builder LLM)

후보 패치를 만드는 어댑터는 spec 문자열로 지정한다:

| spec | 용도 |
| --- | --- |
| `mock:/path/to/scenario.json` | 결정론 fixture(테스트/CI). 시나리오대로 파일을 수정. |
| `command:<your-agent>` | 임의의 외부 에이전트를 서브프로세스로 실행. |
| `codex` | 실제 **Codex CLI + ChatGPT OAuth**. VibeLoop OAuth 프록시가 강제되어 API 키를 스크럽하고 placeholder bearer로 상류에 ChatGPT OAuth만 포워딩(토큰 텍스트는 로그/출력에 안 남고 auth-header 존재 여부만 노출). |

`improve`/`orchestrate`는 `--agent`(빌더, 반복 가능)와 `--challenger`(통과 후에도 "더 나은 후보"를 탐색)를 받는다.

---

## 🚀 Quickstart

```bash
pnpm install
pnpm exec prisma generate
cp .env.example .env   # 없으면 아래 env를 직접 export
```

권장 환경 변수:

```bash
export VIBELOOP_API_TOKEN="dev-token"
export VIBELOOP_STORE="memory"            # 로컬 임시. 운영은 DATABASE_URL
export VIBELOOP_DATA_DIR="$PWD/.vibeloop"
export VIBELOOP_AGENT_SPEC="codex"        # 테스트는 mock:/path/scenario.json
# export DATABASE_URL="postgresql://vibeloop:vibeloop@127.0.0.1:54329/vibeloop"
```

PostgreSQL(운영형) + 서버 기동:

```bash
docker compose up -d postgres
export DATABASE_URL="postgresql://vibeloop:vibeloop@127.0.0.1:54329/vibeloop"
pnpm exec prisma migrate deploy
pnpm build && pnpm start:server
# 헬스 확인
curl -H "Authorization: Bearer $VIBELOOP_API_TOKEN" http://127.0.0.1:3001/api/projects
```

단일 이슈 검증(가장 작은 흐름):

```bash
node packages/cli/bin/vibeloop run \
  --repo /path/to/your-repo \
  --task task.yaml --eval eval.yaml \
  --agent 'command:<your-agent>' --project-id demo --loop-id demo-1
```

---

## 🧪 CLI 명령

`vibeloop <command>` (`packages/cli/bin/vibeloop`):

| 명령 | 설명 |
| --- | --- |
| 🔍 `discover` | repo를 스캔해 문제 후보(test/typecheck/lint/security)를 우선순위로 출력(dry-run). |
| ▶️ `run` | task/eval 1개를 검증 커널로 1회 실행 → eval-report. |
| 🔁 `improve` | builder 풀 + `--challenger`를 후보로 돌리고 Arbiter 선택 + 신뢰 바닥(B1~B4) → PR 후보. |
| 🧭 `orchestrate` | **자동 모드**: discover → top-N 선택 → task **자동 생성** → `improve` 루프를 다중 이슈에 순차(`--max-issues`). |
| 🔂 `retry` | 이전 루프 재실행(`retry_same_base`/`retry_latest_base`/`retry_eval_only`/`retry_critic_only`). |
| 📊 `report` | 루프 결과를 HTML 리포트로 렌더. |
| 🧹 `gc` | 오래된 run 아티팩트 정리. |

주요 플래그: `--max-candidates`(비용 상한) · `--allow-dirty` · `--skip-final-reverify` · `--quality-judge <command>`(B1) · `--max-issues`(orchestrate) · `--base-commit` · `--llm-proxy-url`.

---

## 📦 Skill 제품 채널

`skills/vibeloop-harness`는 모노레포 밖에서도 쓸 수 있는 **단일 이슈 수정→검증→PR 후보화** 제품 채널이다.

```bash
# 1) 자체 완결 단일 파일 CLI 번들
pnpm bundle:skill                # → skills/vibeloop-harness/vendor/vibeloop.mjs

# 2) skills/vibeloop-harness 를 사용 환경(예: .claude/skills)에 복사
#    래퍼는 CLI를 VIBELOOP_CLI → 모노레포 dev bin → vendor/vibeloop.mjs → PATH 순으로 탐색

# 3) task/eval 생성 후 한 이슈 실행
node skills/vibeloop-harness/scripts/create-task-eval.mjs \
  --template node --out /tmp/vt --id my-fix --title "Fix X" \
  --objective "Fix X and add a regression test."
node skills/vibeloop-harness/scripts/vibeloop-run.mjs run \
  --repo /path/to/your-repo --task /tmp/vt/task.yaml --eval /tmp/vt/eval.yaml \
  --agent 'command:<your-agent>' --project-id my --loop-id my-1
```

상세: [SKILL.md](./skills/vibeloop-harness/SKILL.md) · [usage.md](./skills/vibeloop-harness/references/usage.md)

---

## 🗂️ 모노레포 구조

pnpm 워크스페이스 · `packages/*` + `apps/*` (~17k LOC TS).

| 패키지 | 역할 |
| --- | --- |
| `@vibeloop/task-protocol` | `task.yaml`/`eval.yaml` 스키마·로더·검증, 한도(limits), 위험 분류, 경로 정규화. |
| `@vibeloop/shared` | 공통 프리미티브: exec, **컨테이너 격리(R1)**, 해시, data dir, 타입. |
| `@vibeloop/guards` | diff 추출, scope/protected/test-integrity/**artifact-leak** 가드, 변경 파일 분석. |
| `@vibeloop/eval-engine` | gate 실행기, **Decision Engine(15 rules)**, 증거 detector, baseline/test-on-base, 품질 evaluator, provenance, rulepack shadow, adversary 필터/실행. |
| `@vibeloop/workspace-runner` | 격리 git worktree, base commit 해석, 의존성 provisioning, **dirty 가드**. |
| `@vibeloop/agent-adapters` | mock/command/**codex** 어댑터 + **ChatGPT OAuth 프록시**. |
| `@vibeloop/discovery` | 문제 발견(test/lint/typecheck/security), 우선순위, **task 자동 생성**. |
| `@vibeloop/artifacts` | run 레이아웃, manifest, 무결성 체크섬, 영속화. |
| `@vibeloop/sdk` | `runKernel`(단일) · `runImprovementLoop`(후보 풀 + Arbiter + 신뢰 바닥) · quality judge. |
| `@vibeloop/cli` | `vibeloop` CLI(discover/run/improve/orchestrate/retry/report/gc). |
| `@vibeloop/github-integration` | draft PR / 브랜치 헬퍼. |
| `@vibeloop/report-html` | HTML 리포트 렌더. |
| `apps/@vibeloop/server` | Fastify 컨트롤플레인 API + PrismaStore. |
| `apps/web` | 대시보드 / 리포트 뷰어. |

```text
.
├── packages/        # 코어 모듈(위 표)
├── apps/            # server(Fastify) + web(dashboard)
├── skills/          # vibeloop-harness 제품 채널(SKILL.md, vendor 번들)
├── schemas/         # task / eval / eval-report JSON Schema
├── scripts/uat/     # 실 codex/LLM live UAT 드라이버
├── tests/e2e/       # end-to-end + user-scenario 픽스처
└── docs/            # 명세·아키텍처·런북·실행 원장
```

---

## 🔬 검증 & 실행 증거

로컬 전체 검증:

```bash
pnpm exec prisma generate
pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e && pnpm build && pnpm build:web
```

실제 LLM live UAT(실 Codex + 실 GitHub repo + draft PR, auto-merge 없음):

```bash
pnpm uat:skill-loop:codex-live          # 단일 이슈, 실 gpt-5.5 + draft PR
pnpm uat:skill-loop:codex-live:multi    # 다중 이슈(2개) 순차 + stacked draft PR
```

**실행 원장(Run Ledger)** — `docs/SKILL_REAL_USER_SCENARIO.md`에 매 실행을 1행씩 누적(과장 금지: fixture PASS를 실사용자 PASS로 부르지 않음).

| Run | 모드 | 빌더 | 결과 |
| --- | --- | --- | --- |
| R3 | 단일 이슈 | 실 gpt-5.5(OAuth) | PASS — accept/ALL_PASS/qualified + **B2 재검증·B3 provenance·B4 limits** 실경로 실측, draft PR |
| R5 | **다중 이슈(cart+sku)** | 실 gpt-5.5(OAuth) | PASS — 2이슈 1개씩 수정 → **stacked draft PR 2개**, 이슈마다 신뢰 바닥 통과, `false_pass 0 / leak 0` |

---

## 📚 문서

- 📑 [문서 인덱스](./docs/README.md)
- 🤖 [자율 루프 명세](./docs/AUTONOMOUS_LOOP_SPEC.md) · [자가개선 루프 설계](./docs/SELF_IMPROVEMENT_LOOP_DESIGN.md)
- ⚙️ [Eval Engine 명세](./docs/EVAL_ENGINE_SPEC.md) · [Task Protocol](./docs/TASK_PROTOCOL.md)
- 🛡️ [Security Model](./docs/SECURITY_MODEL.md) · [Architecture](./docs/ARCHITECTURE.md)
- 🧾 [실사용자 시나리오 + 실행 원장](./docs/SKILL_REAL_USER_SCENARIO.md)
- 🏃 [자가개선 루프 런북](./docs/SELF_IMPROVEMENT_LOOP_RUNBOOK.md)

---

## 🚦 현재 상태(정직한 범위)

- ✅ **결정론 커널 + 후보 루프 + 신뢰 바닥(B1~B4·dirty 가드)** — 단위/e2e + 실 codex live(R3·R5)로 검증.
- ✅ **자동 모드 `orchestrate`** — discover→선택→task 자동생성→다중이슈 순차(결정론 오케스트레이션). fixture로 검증.
- 🚧 **남은 작업** — 자연어 의도 인식(지정/자동 분기, 스킬/LLM 층) · eval 자동 생성 · adversary lane · 코어 PR 브랜치 생성(현재 wrapper) · 토큰 budget.

> 상태·표현은 항상 증거 범위를 함께 명시한다. `PASS`/`실사용자`/`프로덕션급`은 근거(Run Ledger·테스트)와 함께만 쓴다.
