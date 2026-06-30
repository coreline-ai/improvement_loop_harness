# Skill 제품화 Runbook

이 문서는 `skills/vibeloop-harness`를 첫 제품 채널로 사용하는 운영 절차다. 핵심 원칙은 **Skill은 wrapper이고, 최종 판정은 SDK/CLI가 생성한 deterministic `eval-report.json`**이라는 점이다.

## 1. 제품 경계

| 항목           | 기준                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| Core authority | `@vibeloop/sdk` → eval engine → `eval-report.json`                      |
| Skill 역할     | task/eval 초안 생성, 실행 명령 선택, report 요약, 다음 조치 안내        |
| Skill 금지     | 직접 `accept/reject` 판정, hidden test 노출, token 저장/출력, gate 조작 |
| PR 후보        | `decision=accept` + `ALL_PASS` 또는 human-approved 결과만 가능          |

## 2. 사전 조건

- Node.js `>=22`
- `pnpm install` 완료
- 검증 대상 repo가 git repo이고 base commit을 확인 가능해야 함
- Codex OAuth UAT를 실행하려면 로컬 Codex CLI가 ChatGPT 로그인 상태여야 함

```bash
pnpm build
```

## 3. Skill-first 기본 흐름

1. 한 번에 고칠 문제를 1개만 정한다.
2. `task.yaml`과 `eval.yaml`을 생성하거나 기존 파일을 재사용한다.
3. Skill wrapper 또는 CLI로 `vibeloop run`을 실행한다.
4. `eval-report.json`을 summarizer로 요약한다.
5. `accept/ALL_PASS`면 PR 후보로 정리하고, 그 외는 실패 gate를 수정한 뒤 재실행한다.

## 4. task/eval 생성

```bash
node skills/vibeloop-harness/scripts/create-task-eval.mjs \
  --template node \
  --out /tmp/vibeloop-task \
  --id cart-quantity-fix \
  --title "Cart total respects quantity" \
  --objective "Fix cart total calculation and add one regression test." \
  --project cart-quantity \
  --test-command "node tests/cart-quantity.test.cjs"
```

템플릿 선택 기준:

| Template | 기본 test command            | 사용처          |
| -------- | ---------------------------- | --------------- |
| `node`   | `npm test`                   | Node.js package |
| `python` | `python -m pytest`           | Python package  |
| `web`    | `npm test` + `npm run build` | web app/package |

`--test-command`를 지정하면 `task.yaml`의 required test와 해당 템플릿의 주 테스트 gate가 같이 바뀐다.

## 5. Skill wrapper 실행

```bash
node skills/vibeloop-harness/scripts/vibeloop-run.mjs \
  --data-dir .vibeloop \
  run \
  --repo /path/to/target-repo \
  --task /tmp/vibeloop-task/task.yaml \
  --eval /tmp/vibeloop-task/eval.yaml \
  --agent 'command:<agent command>' \
  --project-id cart-quantity \
  --loop-id cart-quantity-001 \
  --base-commit <base-sha> \
  --skip-dependency-install
```

Wrapper는 `packages/cli/bin/vibeloop`을 호출만 한다. 판정은 CLI/SDK/eval engine이 담당한다.

## 6. Report 요약

```bash
node skills/vibeloop-harness/scripts/summarize-report.mjs \
  --report .vibeloop/projects/<project>/runs/<loop>/reports/eval-report.json
```

요약 필드:

- `decision`
- `reason`
- `changedFiles`
- `failedGates`
- `evidence`
- `risk`
- `reportPath`
- `nextAction`

`nextAction` 기준:

| 조건                | nextAction                    |
| ------------------- | ----------------------------- |
| `decision=accept`   | `prepare_pr_candidate`        |
| required gate 실패  | `fix_failed_gates_then_rerun` |
| human approval 필요 | `request_human_review`        |
| 그 외               | `inspect_decision_reasons`    |

## 7. Codex OAuth 실환경 UAT

```bash
pnpm uat:codex-oauth
```

이 경로는 `packages/agent-adapters`의 reusable OAuth proxy module을 사용한다. 저장되는 것은 auth header 존재 여부와 aggregate usage뿐이며, OAuth token 원문은 log/report에 저장하지 않는다.

선택 환경 변수:

- `VIBELOOP_UAT_MODEL`
- `VIBELOOP_UAT_REASONING_EFFORT`
- `VIBELOOP_UAT_OAUTH_PROXY_URL`
- `VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL`
- `VIBELOOP_UAT_KEEP_TMP=0`

## 7.5 Skill 실사용 루프 UAT

여러 문제를 한 번에 하나씩 처리하는 실제 사용자형 loop는 아래 온디맨드 UAT로 검증한다. 이 테스트는 임시 git repo를 만들고, issue별 Skill invocation을 분리한 뒤, 각 accepted patch를 commit하고 `pr-candidate/<task-id>` branch를 만든다.

```bash
pnpm uat:skill-loop
pnpm uat:skill-loop:adversarial
```

상세 시나리오와 통과 기준은 [SKILL_REAL_USER_LOOP_UAT.md](./SKILL_REAL_USER_LOOP_UAT.md)를 따른다. 적대적 UAT는 bad candidate가 PR 후보로 넘어가지 않는지 확인한다. 제품의 완전 자율 discovery loop와는 다르게, 이 UAT는 deterministic issue queue를 사용해 Skill 제품 경로의 실제 동작을 검증한다.

## 7.6 Prototype acceptance 현황

R164(2026-06-30)는 현재 최신 prototype P0/P1 hardening evidence다. `corepack pnpm uat:prototype-acceptance`는 Gitea preflight, 2-variant real Codex Gitea PR-like, retry-loop, targeted local-pr-like evidence audit에서 4/4 PASS했다.

주요 evidence ledger:

- Durable Gitea evidence: `/Users/iriver/.vibeloop/uat-evidence/skill-real-user-prompt-corpus-live-uat/skill-prompt-corpus-live-13659-1782777198300/ledger.json`
- Retry evidence: `/Users/iriver/.vibeloop/uat-evidence/prototype-failure-retry-loop-uat/prototype-retry-loop-16333-1782777198765/ledger.json`
- Acceptance evidence: `/Users/iriver/.vibeloop/uat-evidence/prototype-acceptance-uat/prototype-acceptance-12965-1782777025246/ledger.json`
- GitHub auto_discovery single smoke: `coreline-ai/vibeloop-skill-prompt-auto-discovery-19396-1782777457900` PR #1 OPEN draft, auto-merge `null`, normalized diff match `true`

이 evidence는 prototype-targeted acceptance 기준이다. 56-variant GitHub final full, strict-best/full autonomous improvement, arbitrary/large repo product-wide PASS를 의미하지 않는다.

## 8. 고정 검증 게이트

Skill 제품화 변경 후 최소 검증:

```bash
git diff --check
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm test:scenario:user
pnpm uat:skill-loop
pnpm uat:skill-loop:adversarial
pnpm uat:codex-oauth
```

Codex OAuth UAT는 실 로그인/네트워크 상태에 의존하므로 CI 기본 gate가 아니라 온디맨드 실환경 UAT로 유지한다.

## 9. 보안/신뢰 경계 체크

- hidden acceptance source/content를 builder agent에 제공하지 않는다.
- `Bearer`, `access_token`, `refresh_token`, `api_key`, `OPENAI_API_KEY`, `auth.json`, `.env` 원문을 출력하지 않는다.
- `summarize-report.mjs` 출력도 사용자에게 보여주기 전 secret-like string이 없는지 확인한다.
- `eval.yaml`, hidden tests, auth/permission/billing/deploy/schema 변경은 human review 대상으로 취급한다.

## 10. 다음 제품 채널 backlog

| 우선순위 | 채널            | 구현 방향                                     | 완료 기준                                     |
| -------- | --------------- | --------------------------------------------- | --------------------------------------------- |
| P1       | GitHub Action   | `@vibeloop/sdk` 기반 action wrapper           | PR check가 `eval-report.json` artifact 업로드 |
| P1       | PR Bot          | `github-integration` + `runOnce()` 연결       | `accept/ALL_PASS`만 draft PR 생성             |
| P2       | Server API      | `apps/server`가 SDK result를 API/SSE로 노출   | CLI와 같은 report/decision 반환               |
| P2       | MCP/tool plugin | SDK 호출 tool wrapper                         | 외부 agent가 같은 contract로 실행             |
| P3       | Autonomous loop | discovery → one task → runOnce → PR 후보 반복 | 한 번에 1개 문제만 순차 처리                  |
