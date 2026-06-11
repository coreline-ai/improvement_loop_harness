# 자율 코딩 개선 루프형 AI 개발 하네스 구현 명세 인덱스

이 문서는 기존 통합 문서의 구현 진입점이다. 전체 원문은 [`autonomous_coding_improvement_loop_harness_FULL.md`](./autonomous_coding_improvement_loop_harness_FULL.md)에 보존하고, 실제 개발 기준은 아래 분리 명세를 따른다.

## 핵심 결론

```text
웹 UI보다 먼저 검증 커널을 만든다.

task.yaml
+ isolated git worktree
+ eval.yaml runner
+ robust guards
+ eval-report.json
```

## 구현 기준 문서

1. [`PRODUCT_SPEC.md`](./PRODUCT_SPEC.md)
2. [`ARCHITECTURE.md`](./ARCHITECTURE.md)
3. [`LOOP_STATE_MACHINE.md`](./LOOP_STATE_MACHINE.md)
4. [`TASK_PROTOCOL.md`](./TASK_PROTOCOL.md)
5. [`EVAL_ENGINE_SPEC.md`](./EVAL_ENGINE_SPEC.md)
6. [`SECURITY_MODEL.md`](./SECURITY_MODEL.md)
7. [`ARTIFACT_SCHEMA.md`](./ARTIFACT_SCHEMA.md)
8. [`API_SPEC.md`](./API_SPEC.md)
9. [`DB_SCHEMA.md`](./DB_SCHEMA.md)
10. [`MVP_IMPLEMENTATION_PLAN.md`](./MVP_IMPLEMENTATION_PLAN.md)
11. [`AUTONOMOUS_LOOP_SPEC.md`](./AUTONOMOUS_LOOP_SPEC.md)

## Schema source of truth

- [`../schemas/task.schema.json`](../schemas/task.schema.json)
- [`../schemas/eval.schema.json`](../schemas/eval.schema.json)
- [`../schemas/eval-report.schema.json`](../schemas/eval-report.schema.json)

## 우선 개발 순서

1. JSON Schema 3종 확정
2. task/eval validator 구현
3. git worktree workspace runner 구현 (repo 밖 데이터 디렉터리 + 의존성 프로비저닝)
4. builtin guard 구현 (git metadata integrity / diff scope / test integrity / protected file / limits)
5. baseline capture + test-on-base evidence 검증 구현
6. eval.yaml runner 구현 (가드 선행 + fail-fast)
7. eval-report.json 생성 (모든 경로에서)
8. decision engine 구현 (first-match-wins 우선순위 표)
9. fixture 기반 e2e 검증
10. 이후 웹 report viewer와 PR 연동

## 검토 이력

- [EXPERT_REVIEW_1_20260610.md](./EXPERT_REVIEW_1_20260610.md) — 1차 전문가 검토 (2026-06-10, 전 항목 반영 완료)
