# API_SPEC.md

## 1. 원칙

API는 long-running job orchestration을 전제로 설계한다. 단순 CRUD가 아니라 idempotency, cancellation, retry, event streaming, artifact 조회가 핵심이다.

## 2. 인증/인가 (MVP)

- 모든 API 요청은 `Authorization: Bearer <token>`을 요구한다. MVP는 환경 설정으로 발급한 단일 사용자 토큰으로 시작한다 (multi-user RBAC은 MVP 이후).
- Approval API는 승인 행위자의 `reviewer_id`를 기록한다. MVP에서 토큰은 하나지만 감사 추적은 남긴다.
- `POST /api/loops/:loopId/evaluate`는 내부 worker 전용이다. 외부 네트워크에 노출하지 않거나 별도 internal token으로 분리한다.
- `GET /api/loops/:loopId/artifacts/*path`는 artifact root 기준 **realpath 검증**으로 traversal을 차단한다. root 밖으로 해석되는 경로는 404.

## 3. Project API

```http
POST /api/projects
GET /api/projects
GET /api/projects/:projectId
PATCH /api/projects/:projectId
```

Project 삭제는 MVP에서 soft delete만 허용한다.

## 4. Task API

```http
POST /api/projects/:projectId/tasks
GET /api/projects/:projectId/tasks
GET /api/tasks/:taskId
PATCH /api/tasks/:taskId
POST /api/tasks/:taskId/validate
```

`POST /validate`는 task.schema.json 기준으로 write_scope/risk/evidence 계약을 검증한다.

## 5. Loop API

```http
POST /api/tasks/:taskId/loops
GET /api/tasks/:taskId/loops
GET /api/loops/:loopId
POST /api/loops/:loopId/cancel
POST /api/loops/:loopId/retry
```

`POST /loops` 요청 헤더:

```http
Idempotency-Key: <uuid>
```

서버는 요청 본문의 정규화 hash(`requestHash`)를 loop와 함께 저장한다. 동일 key + 동일 hash는 기존 loop 반환(replay), 동일 key + 다른 hash는 `409 Conflict`다. key 유일성만으로는 둘을 구분할 수 없다 ([LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) §7).

Retry body:

```json
{
  "mode": "retry_same_base | retry_latest_base | retry_eval_only | retry_critic_only",
  "reason": "Added missing regression test requirement"
}
```

## 6. Evaluation API

```http
POST /api/loops/:loopId/evaluate
GET /api/loops/:loopId/reports
GET /api/reports/:reportId
GET /api/loops/:loopId/artifacts
GET /api/loops/:loopId/artifacts/*path
```

MVP에서는 `evaluate`를 내부 worker만 호출하게 제한한다.

## 7. Approval API

```http
GET /api/approvals
GET /api/approvals/:approvalId
POST /api/approvals/:approvalId/approve
POST /api/approvals/:approvalId/reject
POST /api/approvals/:approvalId/request-more-tests
```

Approve body:

```json
{
  "reviewer_id": "user_123",
  "decision_reason": "Auth behavior reviewed. Regression tests are sufficient.",
  "allow_pr_creation": true
}
```

## 8. PR API

```http
POST /api/loops/:loopId/pull-request
GET /api/loops/:loopId/pull-request
```

PR 생성 가능 조건 (loop decision 기준):

```text
accepted -> allowed
approved -> allowed
rejected/cancelled/failed -> forbidden
needs_more_tests -> forbidden (retry로 새 loop를 만들어야 함)
needs_human_review -> forbidden until approved
```

PR 생성/실패/재시도는 `PullRequest` 엔티티의 status로 추적하며 loop 상태를 바꾸지 않는다 ([LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) §4).

## 9. SSE Events

```http
GET /api/loops/:loopId/events
```

Event envelope:

```json
{
  "id": "42",
  "loop_id": "loop_123",
  "type": "gate.completed",
  "created_at": "2026-06-10T12:00:00Z",
  "payload": {
    "gate": "unit_tests",
    "status": "pass"
  }
}
```

- event `id`는 loop 단위 단조 증가 `seq`다 (`LoopEvent.seq`, [DB_SCHEMA.md](./DB_SCHEMA.md)). cuid 같은 비순서 id는 재전송 기준으로 쓸 수 없다.
- Client는 `Last-Event-ID`를 보내 재연결할 수 있다. 서버는 해당 `seq` 이후의 이벤트를 DB에서 읽어 재전송한다.

## 10. Candidate & Orchestrator API (MVP-4)

자율 루프 제어 ([AUTONOMOUS_LOOP_SPEC.md](./AUTONOMOUS_LOOP_SPEC.md)).

```http
GET  /api/projects/:projectId/candidates
POST /api/projects/:projectId/candidates            # manual 등록
POST /api/candidates/:candidateId/approve
POST /api/candidates/:candidateId/dismiss
POST /api/projects/:projectId/discovery/run         # 발견 1회 수동 트리거

GET  /api/projects/:projectId/orchestrator          # 모드·예산 사용량·큐 상태
POST /api/projects/:projectId/orchestrator/start    # body: { "mode": "supervised | auto" }
POST /api/projects/:projectId/orchestrator/stop     # kill switch — 즉시 정지
```

규칙:

- `stop`은 어떤 상태에서든 허용되는 최우선 명령이다. 실행 중 루프는 graceful cancel.
- `start`의 기본 mode는 `supervised`다. `auto`는 명시적으로만.
- guardrail 발동(예산 초과·연속 실패 차단기)은 orchestrator 상태 조회와 이벤트로 노출한다.
