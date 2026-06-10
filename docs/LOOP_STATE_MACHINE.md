# LOOP_STATE_MACHINE.md

## 1. 목적

Loop state machine은 긴 실행 작업의 재시도, 취소, 승인, 장애 복구를 일관되게 처리하기 위한 계약이다.

PR 생성은 루프 상태가 아니다. 루프는 **decision에서 끝나고**, PR lifecycle은 `PullRequest` 엔티티의 status로 별도 추적한다. 이렇게 분리해야 terminal 상태 정의가 모순 없이 유지되고, PR 생성 실패/재시도를 루프 상태와 독립적으로 처리할 수 있다.

## 2. 상태 목록

| 상태 | 의미 | terminal |
|---|---|---|
| `draft` | task만 생성됨 | no |
| `queued` | 실행 대기 | no |
| `workspace_preparing` | worktree/의존성/baseline 준비 중 | no |
| `workspace_ready` | base commit과 workspace 고정 | no |
| `agent_running` | builder agent 실행 중 | no |
| `patch_created` | candidate patch 추출 완료 | no |
| `guards_running` | git metadata/diff/protected/test integrity guard 실행 중 | no |
| `eval_running` | eval.yaml gates 실행 중 | no |
| `critic_running` | LLM critic/adversarial review 실행 중 (advisory) | no |
| `decision_ready` | 모든 판단 입력 수집 완료 | no |
| `accepted` | low-risk 자동 승인 | yes |
| `rejected` | 실패/위험/증거 부족으로 폐기 | yes |
| `needs_human_review` | 위험 영역 변경으로 사람 승인 필요 | no |
| `needs_more_tests` | 목표는 그럴듯하나 증거/테스트 부족. 후속 작업은 retry로 새 loop 생성 | yes |
| `approved` | 사람 승인 완료 | yes |
| `cancelled` | 사용자 취소 | yes |
| `failed` | 시스템 오류 | yes |

terminal 상태는 outgoing 전이를 갖지 않는다. `accepted`/`approved` 이후의 PR 생성은 루프 전이가 아니라 PullRequest 엔티티 생성이다.

## 3. 주요 전이

```text
draft -> queued
queued -> workspace_preparing -> workspace_ready
workspace_ready -> agent_running
agent_running -> patch_created | failed | cancelled
patch_created -> guards_running
guards_running -> eval_running | decision_ready
eval_running -> critic_running | decision_ready
critic_running -> decision_ready
decision_ready -> accepted | rejected | needs_human_review | needs_more_tests
needs_human_review -> approved | rejected | needs_more_tests
```

전이 규칙:

- guard/eval 단계에서 required 실패가 발생해도 `rejected`로 직행하지 않는다. **모든 경로는 `decision_ready`로 수렴**하고, reject 판정과 `eval-report.json` 생성은 항상 decision engine이 수행한다. "모든 후보는 eval-report.json을 남긴다" 원칙의 시행 지점이 decision engine 하나로 고정된다.
- guard 실패 시 후속 프로젝트 명령 게이트는 실행하지 않고 `skipped`로 기록한 채 `decision_ready`로 넘어간다. 실행 순서 규범은 [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md)를 따른다.
- 어떤 단계든 시스템 오류는 `failed`, 사용자 취소는 `cancelled`로 전이한다.

## 4. PR Lifecycle (루프 외부)

```text
PullRequest.status: creating -> draft_created | create_failed
```

- PR 생성 가능 조건: loop decision이 `accepted` 또는 `approved`
- `create_failed`는 PullRequest 단위로 재시도하며 루프 상태에 영향을 주지 않는다.
- 취소/거절/실패 루프는 PR 생성이 금지된다.

## 5. Retry 정책

| retry 종류 | 허용 상태 | 의미 |
|---|---|---|
| `retry_same_base` | failed, rejected, needs_more_tests | 같은 base commit에서 재실행 |
| `retry_latest_base` | failed, rejected, needs_more_tests | default branch 최신 commit 기준 재실행 |
| `retry_eval_only` | failed, rejected | agent 재실행 없이 동일 patch로 eval 재실행 (flaky required gate 복구 경로) |
| `retry_critic_only` | failed | critic 단계만 재실행 |

Retry는 새 `loop_id`를 만든다. 기존 run artifact는 불변으로 남긴다.

`retry_eval_only`를 `rejected`에서 허용하는 이유: flaky 테스트로 required gate가 실패하면 decision은 `rejected`가 되는데, 이때 비결정적이고 고비용인 agent 전체 재실행 없이 동일 patch의 eval만 재검증할 수 있어야 한다.

## 6. Cancel 정책

- `queued`: 즉시 cancelled
- `workspace_preparing`: workspace cleanup 후 cancelled
- `agent_running`: graceful stop → timeout 후 kill
- `guards_running/eval_running`: 현재 command 종료 요청 → timeout 후 kill
- terminal 상태에서는 cancel 불가

취소된 run은 PR 생성 금지다.

## 7. Idempotency

`POST /api/tasks/:taskId/loops`는 `Idempotency-Key`를 받는다.

- 서버는 요청 본문의 정규화 hash(`requestHash`)를 loop와 함께 저장한다.
- 동일 key + 동일 `requestHash`(동일 task, 동일 base commit 포함) 요청은 같은 loop를 반환한다 (replay).
- 동일 key + 다른 `requestHash` 요청은 `409 Conflict`다.

key 유일성만으로는 replay와 conflict를 구분할 수 없으므로 `requestHash` 저장은 필수다. DB 모델은 [DB_SCHEMA.md](./DB_SCHEMA.md)를 따른다.

## 8. Concurrency / Lock

- 같은 project의 같은 base branch에 대한 git 변이 작업(worktree add/remove, fetch)은 project-level lock을 건다. lock 범위는 git 명령 구간으로 한정하며 루프 전체를 직렬화하지 않는다.
- read-only observe는 병렬 가능하다.
- 같은 task의 active loop는 기본 1개만 허용한다.
- PR 생성은 loop terminal decision 이후 단일 실행이어야 한다 (PullRequest 단위 멱등).

## 9. 상태 이벤트

이벤트는 loop 단위 단조 증가 `seq`를 가진 `LoopEvent`로 영속화한 뒤 발행한다. SSE event id는 `seq` 기반이며, `Last-Event-ID` 재전송의 source of truth다 ([API_SPEC.md](./API_SPEC.md) §9).

MVP 단일 프로세스에서는 DB commit과 publish 사이 유실 가능성이 있다. 재연결 시 `Last-Event-ID` 이후를 DB에서 재전송하므로 클라이언트 관점 유실은 없다. 다중 프로세스 전환 시 transactional outbox로 보완한다.

```text
loop.queued
workspace.ready
agent.started
agent.log
agent.completed
patch.created
gate.started
gate.completed
critic.completed
decision.made
approval.required
approval.completed
pr.created
loop.completed
loop.failed
loop.cancelled
```
