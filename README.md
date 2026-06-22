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
![license](<https://img.shields.io/badge/license-UNLICENSED%20(private)-lightgrey>)

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

|     | 원칙                | 의미                                                                                         |
| --- | ------------------- | -------------------------------------------------------------------------------------------- |
| 🔒  | **격리 실행**       | 모든 후보는 base commit에 묶인 **독립 git worktree**에서 실행된다(사용자 repo 비오염).       |
| ⚖️  | **결정론 판정**     | accept/reject는 15개 first-match-wins 규칙 엔진이 결정한다. LLM 개입 없음.                   |
| 🎯  | **한 번에 1개**     | 한 루프는 **이슈 1개**만 다룬다. 범위가 명확해야 검증이 명확하다.                            |
| 🧪  | **증거 기반**       | "고쳤다"는 base에서 실패하던 테스트가 candidate에서 통과(test-on-base) 등 **증거**로만 인정. |
| 🛡️  | **누설 차단**       | hidden 수용 테스트·토큰·시크릿이 stdout/report/PR에 새지 않도록 스캔·차단.                   |
| 🚫  | **auto-merge 금지** | 통과해도 **draft PR 후보**까지만. 병합은 사람이.                                             |

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

| 항목                        | 무엇                                                                             | 출처                                     |
| --------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| `accept` / `ALL_PASS`       | **정확성** — 모든 required 게이트 통과 + 증거 충족, 가드 위반 없음               | Decision Engine(15 rules)                |
| `qualified`                 | **품질** — 결정론 evaluator 블록(변경 규모·protected·최소 증거 등) 통과          | Quality Evaluator(M0)                    |
| `selected`                  | accepted 후보들 중 Arbiter가 고른 best-known                                     | `score = evidence×100 − files×5 − lines` |
| `final_verification.passed` | 선택 patch를 **fresh base에 재적용·전체 게이트 재실행** + report↔patch 해시 일치 | Trust Floor B2·B3                        |

종료 코드: `accept=0` · `reject=10` · `cancelled=20` · `failed=2`.

---

## 🛡️ 신뢰 바닥(Trust Floor)

"선택 이후 산출물 신뢰"를 보장하는 코어 게이트:

|        | 게이트                     | 동작                                                                                                      |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| **B1** | 동점 품질심사(advisory)    | score 무차별 동점일 때만 **별도 컨텍스트** 심사가 선호를 표함. correctness 불참, 동점 집합 밖 선택 불가.  |
| **B2** | selected patch 최종 재검증 | 선택 patch를 **새 worktree에 재적용 → 전체 게이트 재실행**. `accept ∧ qualified` 재현 못 하면 PR 없음.    |
| **B3** | provenance/hash 바인딩     | 검증된 report에 기록된 `candidate_patch_hash`·gate artifact 해시를 **선택 시점 재확인**. 불일치 → reject. |
| **B4** | 반복/비용 상한             | `--max-candidates`(기본 24 백스톱) + 선택적 wall-clock deadline. 초과 시 안전 중단(`cap_hit` 기록).       |
| **#1** | dirty 가드                 | base 자동해석 + source repo dirty면 **거부**(`--allow-dirty`/pinned base 예외).                           |
| 🔐     | OS 격리(R1)                | `docker run --rm --network none`로 게이트/replay를 컨테이너 격리(선택).                                   |
| 🙈     | 누설 차단                  | agent stdout/patch/gate log를 스캔·redact, hidden 수용 테스트·토큰 노출 시 차단.                          |

---

## 🤖 에이전트(Builder LLM)

후보 패치를 만드는 어댑터는 spec 문자열로 지정한다:

| spec                          | 용도                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mock:/path/to/scenario.json` | 결정론 fixture(테스트/CI). 시나리오대로 파일을 수정.                                                                                                                                                         |
| `command:<your-agent>`        | 임의의 외부 에이전트를 서브프로세스로 실행.                                                                                                                                                                  |
| `codex`                       | 실제 **Codex CLI + ChatGPT OAuth**. VibeLoop OAuth 프록시가 강제되어 API 키를 스크럽하고 placeholder bearer로 상류에 ChatGPT OAuth만 포워딩(토큰 텍스트는 로그/출력에 안 남고 auth-header 존재 여부만 노출). |

주의: `command:`는 신뢰한 로컬 CLI/UAT 실행용 escape hatch다. server API의 `agent_spec`은 allowlist 정책을 통과해야 하며, `command:`는 R1 격리형 command-agent adapter가 붙기 전까지 거부된다.

`improve`/`orchestrate`는 `--agent`(빌더, 반복 가능)와 `--challenger`(통과 후에도 "더 나은 후보"를 탐색)를 받는다.

---

## 🚀 Quickstart

```bash
corepack pnpm install
corepack pnpm exec prisma generate
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
corepack pnpm exec prisma migrate deploy
corepack pnpm build
corepack pnpm start:server
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

| 명령                  | 설명                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| 🔍 `discover`         | repo를 스캔해 문제 후보(test/typecheck/lint/security)를 우선순위로 출력(dry-run).                              |
| ▶️ `run`              | task/eval 1개를 검증 커널로 1회 실행 → eval-report.                                                            |
| 🔁 `improve`          | builder 풀 + `--challenger`를 후보로 돌리고 Arbiter 선택 + 신뢰 바닥(B1~B4) → PR 후보.                         |
| 🧭 `orchestrate`      | **자동 모드**: discover → top-N 선택 → task **자동 생성** → `improve` 루프를 다중 이슈에 순차(`--max-issues`). |
| 🧩 `rulepack inspect` | frozen rulepack lock의 무결성·semantic readiness를 요약/검증.                                                  |
| 🔂 `retry`            | 이전 루프 재실행(`retry_same_base`/`retry_latest_base`/`retry_eval_only`/`retry_critic_only`).                 |
| 📊 `report`           | 루프 결과를 HTML 리포트로 렌더.                                                                                |
| 🧹 `gc`               | 오래된 run 아티팩트 정리.                                                                                      |

주요 플래그: `--max-candidates`(후보 수 상한) · `--deadline <ms>`(벽시계 상한) · `--token-budget-total <tokens>`(`--llm-proxy-url`이 있으면 proxy stats 자동 사용, 필요 시 `--token-usage-url <url>`로 override) · `--allow-dirty` · `--skip-final-reverify`(GitHub draft PR과 병용 불가) · `--quality-judge <command>`(B1) · `--max-issues`(orchestrate) · `--base-commit` · `--llm-proxy-url`.

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

| 패키지                         | 역할                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vibeloop/task-protocol`      | `task.yaml`/`eval.yaml` 스키마·로더·검증, 한도(limits), 위험 분류, 경로 정규화.                                                                                   |
| `@vibeloop/shared`             | 공통 프리미티브: exec, **컨테이너 격리(R1)**, 해시, data dir, 타입.                                                                                               |
| `@vibeloop/guards`             | diff 추출, scope/protected/test-integrity/**artifact-leak** 가드, 변경 파일 분석.                                                                                 |
| `@vibeloop/eval-engine`        | gate 실행기, **Decision Engine(15 rules)**, 증거 detector, baseline/test-on-base, 품질 evaluator, provenance, rulepack shadow/semantic gate, adversary 필터/실행. |
| `@vibeloop/workspace-runner`   | 격리 git worktree, base commit 해석, 의존성 provisioning, **dirty 가드**.                                                                                         |
| `@vibeloop/agent-adapters`     | mock/command/**codex** 어댑터 + **ChatGPT OAuth 프록시**.                                                                                                         |
| `@vibeloop/discovery`          | 문제 발견(test/lint/typecheck/security), 우선순위, **task 자동 생성**.                                                                                            |
| `@vibeloop/artifacts`          | run 레이아웃, manifest, 무결성 체크섬, 영속화.                                                                                                                    |
| `@vibeloop/sdk`                | `runKernel`(단일) · `runImprovementLoop`(후보 풀 + Arbiter + 신뢰 바닥) · quality judge · rulepack candidate/replay/freeze/inspect.                               |
| `@vibeloop/cli`                | `vibeloop` CLI(discover/run/improve/orchestrate/rulepack/retry/report/gc).                                                                                        |
| `@vibeloop/github-integration` | draft PR / 브랜치 헬퍼.                                                                                                                                           |
| `@vibeloop/report-html`        | HTML 리포트 렌더.                                                                                                                                                 |
| `apps/@vibeloop/server`        | Fastify 컨트롤플레인 API + PrismaStore.                                                                                                                           |
| `apps/web`                     | 대시보드 / 리포트 뷰어.                                                                                                                                           |

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
corepack pnpm exec prisma generate
corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test && corepack pnpm test:e2e && corepack pnpm build && corepack pnpm build:web
```

실제 LLM live UAT(실 Codex + 실 GitHub repo + draft PR, auto-merge 없음):

```bash
corepack pnpm uat:live-preflight              # codex/gh/corepack pnpm 확인
corepack pnpm uat:release-gates-preflight     # P0/P2/P4 readiness + P2/P3/P5 evidence + P2/P4 조건부 evidence 확인
corepack pnpm uat:release-evidence-audit      # 다운로드/병합된 CI P2/P4/P5 evidence artifact 감사
corepack pnpm uat:release-evidence-audit:gh -- --latest # 최신 GitHub run artifact 다운로드+감사
node scripts/uat/release-evidence-audit.mjs --all-release-evidence # P3/대표 live evidence까지 감사
corepack pnpm uat:postgres-contract-preflight # P2 TEST_DATABASE_URL 확인
corepack pnpm uat:postgres-contract           # P2 PrismaStore contract leg
corepack pnpm uat:postgres-contract:docker    # P2 Docker Compose postgres + migrate + contract
corepack pnpm uat:skill-loop:codex-live       # 단일 이슈, 실 gpt-5.5 + draft PR
corepack pnpm uat:skill-loop:codex-live:multi # 다중 이슈(2개) 순차 + stacked draft PR
corepack pnpm uat:adversary-live-preflight    # P4 R1 컨테이너 런타임 확인
corepack pnpm uat:adversary-live              # M2/M4/freeze/N+1 semantic live lane
# Product-100 Phase5는 기본 `node scripts/uat/product-100-codex-reviewer.mjs --live` wrapper를 사용한다.
# 필요 시 VIBELOOP_ADVERSARY_REVIEWER_COMMAND/PROVIDER/REAL_LLM=1 로 override.
corepack pnpm uat:repo-matrix                 # P5 controlled repo corpus matrix
corepack pnpm uat:repo-matrix:codex-monorepo-live # P5 대표 monorepo live cell + draft PR
corepack pnpm uat:repo-matrix:codex-python-live # P5 대표 Python live cell + draft PR
corepack pnpm uat:repo-matrix:codex-broad-live # P5 Django/Rails/Android-like 대표 broad live cells + draft PR
```

CI는 push/PR 외에도 `workflow_dispatch`로 수동 실행할 수 있습니다. `prisma-store` job은 실제 PostgreSQL service에서 `pnpm uat:postgres-contract`를 실행하고 `postgres-contract-evidence-*` artifact를 업로드합니다. CI의 `adversary-live` job은 `node:22-alpine`을 preload한 Docker runner에서 `pnpm uat:adversary-live`를 실행하고 `adversary-live-evidence-*` artifact를 업로드합니다. 이어서 `release-evidence-audit` job이 `postgres-contract-evidence-*`, `adversary-live-evidence-*`, `uat-evidence-*`를 다운로드/병합한 뒤 기본 P2/P4/P5 ledger status, manifest, Postgres checks, adversary attack/safety/reviewer provenance ledger, repo matrix cell summary를 preflight 없이 감사합니다. evidence artifact가 없거나 다운로드 단계가 실패해도 감사 단계는 실행되어 missing evidence를 JSON으로 남깁니다. audit 결과는 Step Summary와 `release-evidence-audit-*` artifact에도 남습니다. 로컬에서 GitHub Actions run을 재감사할 때는 `uat:release-evidence-audit:gh -- --latest`가 최근 CI run들을 훑어 evidence artifact가 있는 첫 run을 내려받고 같은 감사기를 실행합니다. `--repo`나 `GITHUB_REPOSITORY`가 있으면 각 후보 run의 artifact 목록을 먼저 조회해 `missing_artifacts`/matching count를 남기므로, artifact가 전혀 없는 예전 CI run과 감사 실패를 구분할 수 있습니다. 특정 run만 고정하려면 `--run-id <run-id>`를 사용합니다. 더 넓은 증거 감사가 필요하면 `--all-release-evidence`로 P3 live Codex, Python representative live, monorepo representative live, broad framework representative live evidence까지 포함하거나 `--scenario <scenario>`로 단일 시나리오만 감사할 수 있습니다.

P2 Postgres evidence는 DB URL/연결 확인만으로 통과하지 않습니다. `prisma_store_smoke`가 실제 PrismaStore candidate round-trip, 보안 메타데이터 round-trip, duplicate fingerprint 거부를 모두 `pass`로 남겨야 release gate와 CI artifact audit이 통과합니다.

**실행 원장(Run Ledger)** — `docs/SKILL_REAL_USER_SCENARIO.md`에 매 실행을 1행씩 누적(과장 금지: fixture PASS를 실사용자 PASS로 부르지 않음).

| Run | 모드                    | 빌더              | 결과                                                                                                 |
| --- | ----------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| R3  | 단일 이슈               | 실 gpt-5.5(OAuth) | PASS — accept/ALL_PASS/qualified + **B2 재검증·B3 provenance·B4 limits** 실경로 실측, draft PR       |
| R5  | **다중 이슈(cart+sku)** | 실 gpt-5.5(OAuth) | PASS — 2이슈 1개씩 수정 → **stacked draft PR 2개**, 이슈마다 신뢰 바닥 통과, `false_pass 0 / leak 0` |
| R14 | 단일 이슈 rerun         | 실 gpt-5.5(OAuth) | PASS — P0 preflight 복구 후 draft PR + durable evidence bundle copied 81/missing 0                   |
| R15 | 대표 Python stdlib live | 실 gpt-5.5(OAuth) | PASS — hidden acceptance + final reverify + draft PR, evidence copied 77/missing 0                   |
| R16 | 대표 JS monorepo live   | 실 gpt-5.5(OAuth) | PASS — scope boundary + hidden acceptance + final reverify + draft PR, evidence copied 112/missing 0 |
| R17 | 대표 broad framework live 3셀 | 실 gpt-5.5(OAuth) | PASS — Django/Rails/Android-like private repos + 3 draft PRs + hidden/final reverify, evidence copied 324/missing 0 |
| Product-100 | 풀 자율루프 UAT 계약/하네스 | real Codex Builder/Challenger/Reviewer 필수 | **Product-100 PASS / controlled corpus scope** — `PRODUCT_100_CODEX_LIVE_PASS`는 2026-06-22 local finalization run에서 20개 fixed requirement, 10/10 issue Phase4 strict-best, 10/10 issue Phase5 real reviewer/M2/M4/freeze/N+1 aggregate, 10개 GitHub draft PR, evidence bundle, release evidence audit, Phase7 docs truth checker까지 통과한 상태를 뜻한다. 증거: Phase4 `/Users/iriver/.vibeloop/product-100-phase4-full-20260619165620.json`, Phase5 `/Users/iriver/.vibeloop/product-100-phase5-full-rerun-20260621231906.json`, Phase6 draft report `/Users/iriver/.vibeloop/product-100-phase6-20260622-001250/phase6-draft-pr-report.json`, final evidence bundle `~/.vibeloop/uat-evidence/product-100-codex-live-uat/product-100-phase6-20260622-001250`. 단 이는 Product-100 controlled 5-repo/10-issue corpus 계약의 PASS이며, 임의의 모든 사용자 repo에 대한 제품 전체 100% PASS가 아니다. |

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

- ✅ **결정론 커널 + 후보 루프 + 신뢰 바닥(B1~B4·dirty 가드)** — 단위/e2e + 실 codex live(R3·R5·R14·R15·R16·R17)로 검증. Token budget은 SDK hook, CLI flags, OAuth proxy stats endpoint, `--llm-proxy-url`/`--token-usage-url`이 있는 실행의 기본 500k token 운영 상한, `VIBELOOP_TOKEN_BUDGET_TOTAL`/`VIBELOOP_UAT_TOKEN_BUDGET_TOTAL` override, 명시 disable(`off`)까지 연결됐다.
- ✅ **자동 모드 `orchestrate`** — discover→선택→task 자동생성→다중이슈 순차(결정론 오케스트레이션). fixture로 검증.
- ✅/⚠️ **adversary rulepack substrate** — M2 handoff→candidate→M4 replay/freeze→`rulepack_semantic` next-loop gate core와 `rulepack inspect`, `uat:adversary-live` 드라이버는 구현. CI `adversary-live` job은 Docker R1에서 evidence artifact를 남기도록 구성됐고, `release-evidence-audit` job이 해당 artifact의 attack/safety/reviewer provenance ledger를 검증하도록 연결됐다. 기본 controlled lane은 `real_llm=false`로만 인정되며, optional reviewer command lane은 `real_llm=true`, `accepted_review_proposal`, fixed prompt hash/version, `same_model_review=false`가 있어야 release-grade evidence로 통과한다. 이전 `CONTAINER_RUNTIME_UNAVAILABLE` blocker는 Colima `product100` profile로 해소됐다. 단 real Codex adversary reviewer→M2/M4/freeze→N+1 semantic gate의 live 완주 evidence와 broad corpus는 아직 후속이다.
- ✅ **Product-100 Codex Live UAT** — `uat:product-100:*` 계약/하네스가 추가됐다. `PRODUCT_100_CODEX_LIVE_PASS`는 20개 fixed requirement(`docs_run_ledger_readme_truthful` 포함)가 모두 true일 때만 가능하며, 2026-06-22 local finalization run에서 controlled Product-100 corpus 기준으로 충족됐다. 현재 증거는 real Codex Builder/Challenger 10/10 issue Phase4 strict-best, real Codex adversary reviewer + M2/M4/freeze/N+1 10/10 Phase5 aggregate, GitHub private corpus repo 5개와 draft PR 10개, durable evidence bundle, explicit `release-evidence-audit --scenario product-100-codex-live-uat`, Phase7 docs truth checker다. 단 이 PASS는 Product-100 controlled 5-repo/10-issue corpus 계약에 한정되며, 임의의 대형 사용자 repo나 모든 프레임워크에 대한 제품 전체 100% PASS가 아니다.
- ✅/⚠️ **Product-100 Phase6 환경 보강** — Phase6 live 요청 시 `VIBELOOP_PRODUCT_100_ENABLE_GITHUB_REPOS=1`로 corpus repo별 private GitHub repo를 자동 생성하도록 하며, 이 설정이 없으면 preflight가 `github_draft_prs_open` blocker로 fail-closed한다. 진행 상태는 stdout 대기 대신 `~/.vibeloop/product-100-real-loop-*/product-100-progress.json` heartbeat 파일로 확인한다.
- ✅/⚠️ **P5 controlled repo matrix + 대표 live 5셀** — `uat:repo-matrix` 19셀 실행: Node/Python/Ruby/Java/JVM/Swift/TypeScript ESM/monorepo/React-like/Django-like/Rails-like/Android-Gradle-like/CLI/no-PM/large/npm lockfile provisioning/pnpm lockfile provisioning/yarn lockfile provisioning PASS, dirty blocked, network-restricted PASS(현재 Docker/R1 smoke 가능). R15에서 Python stdlib, R16에서 JS monorepo scope 대표 repo가 실 Codex + GitHub draft PR + hidden acceptance + final reverify까지 PASS. R17에서 Django-like/Rails-like/Android-like controlled framework repo 3개도 실제 GitHub + 실 Codex draft PR + hidden acceptance + final reverify까지 PASS했고, `--all-release-evidence` audit가 `BROAD_LIVE_REPRESENTATIVE_PASS` 3/3 ledger를 요구한다. 단 이는 controlled representative corpus이며 임의의 대형 사용자 repo 전체 PASS가 아니다.
- 🚧 **남은 작업** — Product-100 controlled corpus 밖의 임의/대형 실제 프로젝트 corpus, hidden/adversary semantic gate 확장, 더 큰 M4 replay corpus, CI artifact 기반 장기 재현성 감사, Postgres release-grade evidence.

> 상태·표현은 항상 증거 범위를 함께 명시한다. `PASS`/`실사용자`/`프로덕션급`은 근거(Run Ledger·테스트)와 함께만 쓴다.
