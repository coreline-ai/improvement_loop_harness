# 실제 사용자 시나리오 테스트

이 문서는 mock agent가 아니라 실제 CLI 실행과 실제 명령형 agent를 사용해 VibeLoop Harness를 검증하는 사용자 시나리오 테스트 기준이다.

## 실환경 UAT 시나리오 선 구성

| 순서 | 시나리오                                   | 목적                                                                                   | 실행 명령                                                                     | 통과 판정                                        | 비고                                |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------- |
| 1    | 로컬 command agent 사용자 시나리오         | mock 없이 실제 CLI가 임시 target repo를 만들고 파일 수정·검증 루프를 수행하는지 확인   | `pnpm test:scenario:user`                                                     | `decision=accept`, `ALL_PASS`                    | 네트워크/LLM 불필요, 빠른 회귀 확인 |
| 2    | Codex ChatGPT login + 내장 OAuth proxy UAT | API key 없이 실제 Codex `gpt-5.5`/`xhigh`가 문제 수정 후 하네스 gate를 통과하는지 확인 | `pnpm uat:codex-oauth`                                                        | `status=accepted`, `decision=accept`, `ALL_PASS` | 실제 사용자 환경 대표 경로          |
| 3    | 외부 OSS OAuth proxy 연결 UAT              | `openai-oauth` 등 별도 localhost proxy를 붙여 같은 시나리오를 검증                     | `VIBELOOP_UAT_OAUTH_PROXY_URL=http://127.0.0.1:10531/v1 pnpm uat:codex-oauth` | 동일                                             | 외부 proxy를 직접 띄운 경우         |
| 4    | API-key proxy 보존 UAT                     | API-key 기반 proxy 경로가 필요한 환경의 비교/회귀 확인                                 | `pnpm uat:codex-proxy`                                                        | 동일 또는 credential block                       | 기본 경로 아님                      |

## 실환경 UAT 동작 방식 선 구성

| 단계 | 구성 요소        | 실제 동작                                                                                                           | 산출/검증 증거                                             |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1    | UAT runner       | `scripts/uat/codex-oauth-proxy-uat.mjs`가 Codex 버전과 ChatGPT login 상태를 preflight 한다                          | `codex_version`, `login_status`                            |
| 2    | 임시 사용자 repo | cart-quantity target-template를 임시 git repo로 복제하고 base commit을 고정한다                                     | `tmp_root`, `baseCommit`                                   |
| 3    | OAuth proxy      | 내장 proxy가 `/v1/models`, `/v1/responses`를 열고 Codex의 OpenAI auth header 존재 여부만 기록한다                   | `oauth_proxy.stats`, token 원문 미저장                     |
| 4    | Codex agent      | `codex exec -m gpt-5.5 -c model_reasoning_effort="xhigh"`가 실제 worktree에서 문제를 수정한다                       | agent stdout/stderr artifact                               |
| 5    | 하네스 검증      | VibeLoop가 diff scope, protected path, limits, visible/hidden acceptance, fail-on-base evidence를 순서대로 실행한다 | `gate_runs`, `improvement_evidence`                        |
| 6    | 최종 판정        | deterministic decision engine이 모든 required gate 통과 시만 accept 한다                                            | `eval-report.json`, `decision_reasons[0].code == ALL_PASS` |
| 7    | 누출 점검        | hidden expectation과 OAuth/token 문자열이 report/log에 노출되지 않았는지 확인한다                                   | `hidden_text_leaked=false`, token grep 0건                 |

## 실환경 UAT 통과 기준 요약

| 범주 | 고정 통과 기준                                          | 실패 시 의미                    |
| ---- | ------------------------------------------------------- | ------------------------------- |
| 인증 | ChatGPT login 상태 확인, API key 없이 실행              | 사용자 환경 preflight 미충족    |
| 모델 | `gpt-5.5` + `xhigh`로 실제 호출                         | 의도한 고성능 Codex 경로가 아님 |
| 수정 | `src/cart.cjs`, `tests/cart-quantity.test.cjs`만 변경   | write scope/불필요 변경 리스크  |
| 검증 | visible/hidden acceptance 모두 pass                     | 사용자 문제 해결 미검증         |
| 증거 | regression test가 base에서는 fail, candidate에서는 pass | “개선” 증거 부족                |
| 보안 | hidden expectation/token 원문 0건                       | 신뢰 경계 위반                  |
| 판정 | `accept` + `ALL_PASS`                                   | PR 후보로 올릴 수 없음          |

## 시나리오: 장바구니 수량 계산 버그 수정

| 항목         | 내용                                                                |
| ------------ | ------------------------------------------------------------------- |
| 대상 fixture | `tests/e2e/user-scenarios/cart-quantity/target-template`            |
| 사용자 문제  | 장바구니 합계가 `price * quantity`가 아니라 `price`만 합산한다      |
| agent        | `command:node tests/e2e/user-scenarios/cart-quantity/agent-fix.cjs` |
| task         | `tests/e2e/user-scenarios/cart-quantity/task.yaml`                  |
| eval         | `tests/e2e/user-scenarios/cart-quantity/eval.yaml`                  |
| 기대 결과    | `decision: accept`, reason `ALL_PASS`                               |

## 검증 범위

- 실제 임시 git repo 생성 및 base commit 고정
- CLI `vibeloop run` 경로 실행
- `mock:<scenario.json>` 미사용
- command agent가 worktree에서 실제 파일 수정
- write scope / protected path / limits / test integrity guard 실행
- visible acceptance 테스트 실행
- fail-on-base evidence 확인
- hidden acceptance 테스트 주입 및 실행
- eval-report artifact 생성 및 hidden expectation 비노출 확인
- worktree cleanup 확인

## 실행 명령

```bash
pnpm test:scenario:user
```

전체 e2e에 포함해 실행하려면:

```bash
pnpm test:e2e
```

## 사용자 테스트 진행 절차

1. `pnpm install --frozen-lockfile`로 의존성을 맞춘다.
2. `pnpm test:scenario:user`를 실행한다.
3. CLI 출력 JSON에서 `status: accepted`, `decision: accept`를 확인한다.
4. 출력의 `report` 경로를 열어 `decision_reasons[0].code == ALL_PASS`를 확인한다.
5. `changed_files`가 `src/cart.cjs`, `tests/cart-quantity.test.cjs` 두 개뿐인지 확인한다.
6. `gate_runs`에서 `visible_cart_regression`, `hidden_cart_mixed_quantities`가 모두 `pass`인지 확인한다.
7. artifact report에 hidden test 내부 문자열 `SECRET_HIDDEN_EXPECTATION`이 노출되지 않는지 확인한다.

## 통과 기준

| 기준         | 통과 조건                                                    |
| ------------ | ------------------------------------------------------------ |
| CLI 경로     | `packages/cli/bin/vibeloop run`이 exit code 0으로 종료       |
| 최종 판정    | `accept`                                                     |
| 결정 사유    | `ALL_PASS`                                                   |
| 변경 범위    | 허용된 `src/`, `tests/` 내 변경만 존재                       |
| visible test | `node tests/cart-quantity.test.cjs` pass                     |
| hidden test  | `node tests/hidden/cart-mixed-quantities.test.cjs` pass      |
| 증거         | 신규 regression test가 base에서는 fail, candidate에서는 pass |
| 보안         | hidden expectation 원문이 report artifact에 노출되지 않음    |
| cleanup      | 임시 worktree가 repo에 남지 않음                             |

## 다음 레벨 UAT: Codex + localhost OAuth proxy/auth

이 단계는 command agent보다 더 실제 사용자 환경에 가깝다. Codex CLI가 실제 `gpt-5.5` 모델을 `model_reasoning_effort=xhigh`로 호출하고, 하네스는 별도 localhost OAuth proxy/auth 경로를 통해 API key 없이 ChatGPT 로그인 세션을 사용한다.

핵심 원칙:

- 기본 경로는 **API key 없음**이다.
- Codex ChatGPT login이 이미 되어 있어야 한다.
- OAuth token 또는 `~/.codex/auth.json` 원문은 출력·저장하지 않는다.
- proxy는 local/trusted machine에서만 실행한다.

### 실행 명령 — 내장 OAuth forwarder

```bash
pnpm uat:codex-oauth
```

선택 설정:

```bash
export VIBELOOP_UAT_MODEL="gpt-5.5"
export VIBELOOP_UAT_REASONING_EFFORT="xhigh"
export VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL="https://chatgpt.com/backend-api/codex"
export VIBELOOP_UAT_KEEP_TMP=0 # 성공/실패 후 tmp 제거가 필요할 때만
```

### 실행 명령 — 외부 OSS OAuth proxy 연결

`openai-oauth` 같은 OpenAI-compatible OAuth proxy를 별도 터미널에서 기동한 뒤 연결할 수 있다.

```bash
npx openai-oauth
VIBELOOP_UAT_OAUTH_PROXY_URL=http://127.0.0.1:10531/v1 pnpm uat:codex-oauth
```

외부 proxy 모드에서는 proxy가 자체적으로 Codex/ChatGPT OAuth cache를 읽으므로 하네스는 API key를 요구하지 않는다.

### 통과 기준

| 기준                 | 통과 조건                                                                   |
| -------------------- | --------------------------------------------------------------------------- |
| auth preflight       | `codex --version` 통과, `codex login status`가 ChatGPT login 상태를 확인    |
| proxy                | localhost OAuth proxy가 `/v1/models`, `/v1/responses` 경로를 처리           |
| no API key           | `VIBELOOP_UAT_OPENAI_API_KEY`/`OPENAI_API_KEY` 없이 실행 가능               |
| token safety         | OAuth Authorization/auth.json 원문이 stdout, logs, artifact에 노출되지 않음 |
| model                | `gpt-5.5`                                                                   |
| reasoning            | `xhigh`                                                                     |
| 최종 판정            | `status: accepted`, `decision: accept`, reason `ALL_PASS`                   |
| 변경 범위            | `src/cart.cjs`, `tests/cart-quantity.test.cjs`만 변경                       |
| visible/hidden gates | `visible_cart_regression`, `hidden_cart_mixed_quantities` 모두 `pass`       |
| 증거                 | `adds_regression_test`가 `present`                                          |

### 보존 경로: API-key proxy UAT

API key 기반 proxy는 비교/회귀용 온디맨드 경로로만 유지한다.

```bash
export VIBELOOP_UAT_OPENAI_API_KEY="..." # 또는 OPENAI_API_KEY
pnpm uat:codex-proxy
```

### 현재 환경 실행 결과 (2026-06-13 KST)

| UAT                                                          | 결과        | 근거                                                                                                                                         |
| ------------------------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 실제 Codex CLI + 사용자 ChatGPT login + 하네스 command agent | **통과**    | `decision=accept`, reason `ALL_PASS`, changed files `src/cart.cjs`, `tests/cart-quantity.test.cjs`, hidden acceptance pass, evidence present |
| localhost proxy + OpenAI API key auth                        | **blocked** | `pnpm uat:codex-proxy` → `MISSING_PROXY_API_KEY`; 현재 셸에 `VIBELOOP_UAT_OPENAI_API_KEY`/`OPENAI_API_KEY` 없음                              |
| localhost OAuth proxy + ChatGPT login auth                   | **통과**    | `pnpm uat:codex-oauth` → `accept/ALL_PASS`; `gpt-5.5`/`xhigh`, `/v1/responses` 12회 upstream 200, hidden/token 원문 비노출                   |

실제 Codex CLI 실행에서 확인한 환경 보정:

- 현재 `codex-cli 0.129.0`은 사용자 `~/.codex/config.toml`의 `service_tier = "default"`를 거부한다.
- 실제 `codex exec`에는 `-c service_tier=fast` override가 필요했다.
- 임시 worktree는 trusted directory가 아니므로 `--skip-git-repo-check`가 필요했다.
- `service_tier=flex`는 현재 계정/모델 조합에서 upstream API가 `Unsupported service_tier: flex`로 거부했다.
