# TASK_PROTOCOL.md

## 1. 목적

Task Protocol은 AI agent가 무엇을 고칠 수 있고, 어떤 증거를 제출해야 하며, 어떤 변경은 자동 승인될 수 없는지를 정의한다.

정식 JSON Schema는 [../schemas/task.schema.json](../schemas/task.schema.json)을 따른다.

## 2. task.yaml 필수 구조

```yaml
id: auth-invalid-login-401
title: Invalid login should return 401
objective: Invalid password login must return 401 instead of 500.
base_branch: main
risk_area: auth
human_approval_required: true

write_scope:
  allowed:
    - src/features/auth/
    - src/app/api/auth/
    - tests/auth/
  forbidden:
    - .github/
    - eval.yaml
    - scripts/
    - .env
    - .env.local

required_evidence:
  - fixes_reproduced_failure
  - adds_regression_test
  - invalid_password_returns_401

limits:
  max_changed_files: 10
  max_changed_lines: 300
  agent_timeout_seconds: 1800

acceptance:
  required_tests:
    - tests/auth/login-invalid-password.test.ts
  required_behaviors:
    - invalid_password_returns_401
    - failed_login_does_not_create_session
  must_not:
    - expose_password_hash
    - bypass_password_check
```

## 3. write_scope 의미

| 필드 | 의미 |
|---|---|
| `allowed` | agent가 수정 가능한 경로 prefix |
| `forbidden` | task 내에서 명시 금지한 경로 |
| global protected paths | eval.yaml, eval runner, CI, secret files 등 시스템 전역 보호 경로 |

우선순위는 다음과 같다.

```text
global protected path > task.write_scope.forbidden > task.write_scope.allowed
```

즉 allowed에 포함되어도 protected path면 reject 또는 meta-evaluation으로 이동한다.

## 4. Risk Area

자동 accept 금지 risk area:

```text
auth, permission, billing, database_schema, deployment, ci_cd,
eval_system, secrets, admin, security_policy
```

risk area는 agent가 아니라 harness가 path/rule 기반으로 재분류한다. task.yaml의 값은 힌트일 뿐이다.

재분류 규칙은 eval.yaml의 `risk_classification` 경로 매핑을 따른다 ([EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §10). 어떤 매핑에도 해당하지 않는 위험 신호가 있는 변경은 `unknown`으로 분류하고 보수적으로 `needs_human_review` 처리한다. 재분류 결과는 단일값이 아니라 배열이며 eval-report의 `risk.areas`에 기록된다.

`limits`는 "작은 패치만 자동 루프에 적합하다" 원칙의 수치 강제 장치다. task 단위 값이 없으면 eval.yaml의 전역 `limits`를 사용하고, 둘 다 있으면 더 엄격한 쪽을 적용한다.

## 5. Evidence 계약

인정 가능한 evidence:

- reproduced failing test fixed
- regression test added
- coverage increased without test weakening
- p95 latency improved with stable benchmark
- security scan finding reduced
- accessibility score improved
- duplicated code reduced with behavior-preserving tests
- user-reported issue resolved with reproduction

인정하지 않는 evidence:

- comment-only diff
- formatting-only diff
- file rename only
- test/eval weakening
- benchmark input simplification
- error swallowing
- behavior deletion

## 6. Task 폴더 구조

```text
tasks/<task-id>/
├── task.yaml
├── task.md
├── hypothesis.md
├── context.md
└── runs/
    └── <loop-id>.json
```

`tasks/current/task.yaml` 같은 전역 alias는 동시 실행에 취약하므로 MVP 이후 제거한다. MVP에서 wrapper로 필요하면 symlink 대신 explicit `--task` 인자를 사용한다.
