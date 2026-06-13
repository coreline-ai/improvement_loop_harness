# Skill 실사용 루프 UAT

이 문서는 `vibeloop-harness` Skill이 실제 사용자 흐름에 가깝게 동작하는지 검증하는 온디맨드 UAT다. 목적은 **임시 git repo를 만들고, 여러 문제를 한 번에 하나씩 Skill wrapper로 수정·검증·PR 후보화한 뒤, 큐가 끝났을 때 정확히 종료되는지** 확인하는 것이다.

## 1. UAT 목적

| 검증 항목       | 기준                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| 실제 git 환경   | `/tmp` 아래 임시 repo를 `git init -b main`으로 만들고 실제 commit을 생성한다.                                       |
| 실제 코드 수정  | command builder agent가 VibeLoop 격리 worktree에서 코드를 수정하고 regression test를 추가한다.                      |
| Skill 경로 사용 | `skills/vibeloop-harness/scripts/vibeloop-run.mjs` → CLI/SDK → eval engine 경로로 실행한다.                         |
| 고정 판정       | 각 iteration은 `eval-report.json`의 `decision=accept`와 `ALL_PASS`만 통과로 본다.                                   |
| 순차 루프       | 두 개 문제를 순서대로 처리하고, 각 통과 patch를 임시 repo에 적용·commit한다.                                        |
| PR 후보         | 각 accepted commit에 `pr-candidate/<task-id>` 로컬 branch를 생성한다.                                               |
| 컨텍스트 격리   | issue마다 `loopId`, `projectId`, `dataDir`, task/eval 파일이 다르고 이전 issue id가 agent log에 섞이지 않아야 한다. |
| 종료 판정       | 모든 issue가 accepted되고 최종 `npm test`가 통과하면 `issue_queue_exhausted`로 종료한다.                            |

## 2. 시나리오

Fixture 위치:

```text
tests/e2e/user-scenarios/skill-loop/
  target-template/               # 실제 사용자 repo 템플릿
  tasks/*.task.yaml              # issue별 task contract
  evals/*.eval.yaml              # issue별 eval/hidden gate contract
  hidden/*.hidden.cjs            # builder agent에 노출하지 않는 hidden acceptance
  agent-fix.cjs                  # UAT용 command builder agent
```

임시 target repo에는 의도적으로 두 문제가 있다.

| 순서 | task id                        | 문제                                    | visible gate                            | hidden gate                       |
| ---- | ------------------------------ | --------------------------------------- | --------------------------------------- | --------------------------------- |
| 1    | `skill-loop-cart-quantity`     | 장바구니 합계가 `quantity`를 무시       | `node tests/cart-quantity.test.cjs`     | `hidden_cart_mixed_quantities`    |
| 2    | `skill-loop-sku-normalization` | SKU 정규화가 trim/uppercase를 하지 않음 | `node tests/sku-normalization.test.cjs` | `hidden_sku_whitespace_lowercase` |

## 3. 실행 명령

```bash
pnpm build
node scripts/uat/skill-real-user-loop-uat.mjs
```

단축 script:

```bash
pnpm uat:skill-loop
```

디버깅을 위해 임시 repo와 artifacts를 보존하려면:

```bash
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop
```

## 4. 동작 방식

1. UAT script가 `/tmp/vibeloop-skill-loop-uat-*` 아래 임시 git repo를 만든다.
2. base repo에서 `npm test`를 실행해 사용자 repo의 시작 상태를 확인한다.
3. issue queue의 첫 문제만 선택한다.
4. Skill wrapper가 `vibeloop run`을 호출한다.
5. VibeLoop은 isolated git worktree에서 agent를 실행한다.
6. visible test와 hidden acceptance를 실행하고 `eval-report.json`을 생성한다.
7. `accept/ALL_PASS`면 candidate patch를 임시 repo에 적용하고 commit한다.
8. `pr-candidate/<task-id>` branch를 만들어 PR 후보 상태를 남긴다.
9. 다음 issue도 새 `loopId`/`dataDir`로 반복한다.
10. queue가 비면 최종 `npm test`, branch 존재, artifact uniqueness, context isolation을 확인하고 종료한다.

## 5. 통과 기준

UAT stdout JSON은 아래 조건을 모두 만족해야 한다.

| 필드                              | 기대값                     |
| --------------------------------- | -------------------------- |
| `status`                          | `ALL_PASS`                 |
| `scenario`                        | `skill-real-user-loop-uat` |
| `stopReason`                      | `issue_queue_exhausted`    |
| `issueCount`                      | `2`                        |
| `acceptedIssueCount`              | `2`                        |
| `remainingIssueCount`             | `0`                        |
| `artifactRootsUnique`             | `true`                     |
| `acceptedCommitsUnique`           | `true`                     |
| `iterations[*].decision`          | `accept`                   |
| `iterations[*].reason`            | `ALL_PASS`                 |
| `iterations[*].summaryNextAction` | `prepare_pr_candidate`     |
| `iterations[*].contextIsolated`   | `true`                     |

## 6. 보안/신뢰 체크

- hidden test source는 agent에게 전달하지 않고 eval engine이 gate 실행 직전에 worktree에 주입한다.
- stdout JSON과 report summary에는 `SECRET_HIDDEN_EXPECTATION`이 없어야 한다.
- Skill은 판정하지 않고 `eval-report.json`을 읽어 요약만 한다.
- 같은 LLM/agent 자기평가가 아니라 deterministic gate와 hidden acceptance가 최종 authority다.

## 8. 적대적 실패 케이스 UAT

성공 경로와 같은 임시 git repo/Skill wrapper 구조를 사용하되, 의도적으로 나쁜 candidate를 만들어 하네스가 실패를 감지하는지 확인한다.

```bash
pnpm uat:skill-loop:adversarial
```

E2E 단축 명령:

```bash
pnpm test:skill-loop:adversarial
```

| case                   | 공격/실패 시나리오                                               | 기대 탐지                                                | PR 후보   |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- | --------- |
| `hidden-bypass`        | visible test만 통과하도록 hardcode                               | hidden acceptance fail → `reject / GATE_REQUIRED_FAILED` | 생성 금지 |
| `protected-path`       | `.env` protected file 변경                                       | protected path guard → `reject / GUARD_PROTECTED_PATH`   | 생성 금지 |
| `test-integrity-cheat` | regression test에 `test.skip` marker 삽입                        | test integrity guard → `reject / GUARD_TEST_INTEGRITY`   | 생성 금지 |
| `context-leak`         | deterministic gates는 통과하지만 이전 task id가 agent log에 섞임 | UAT context isolation block                              | 생성 금지 |

통과 stdout은 `status=ADVERSARIAL_PASS`, `caseCount=4`, `detectedCaseCount=4`, `blockedPrCandidateCount=4`, `hiddenLeakCount=0`이어야 한다.

## 7. 회귀 테스트 연결

이 UAT는 e2e에도 연결되어 있다.

```bash
pnpm test:skill-loop
```

전체 Skill 제품화 변경 후 최소 확인:

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
