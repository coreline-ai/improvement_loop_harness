# VibeLoop Harness 문서 인덱스

이 폴더는 `autonomous_coding_improvement_loop_harness_FULL.md` 통합 문서를 실제 구현 가능한 명세 단위로 분리한 결과다.

## 읽는 순서

- [autonomous_coding_improvement_loop_harness.md](./autonomous_coding_improvement_loop_harness.md) — 구현 명세 진입점

1. [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) — 제품 정의, 사용자 가치, 범위
2. [ARCHITECTURE.md](./ARCHITECTURE.md) — 전체 아키텍처와 검증 커널 우선 구조
3. [LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) — loop 상태 전이, retry/cancel/idempotency
4. [TASK_PROTOCOL.md](./TASK_PROTOCOL.md) — task.yaml, write_scope, risk/evidence 계약
5. [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) — eval.yaml source of truth, gate runner, decision engine
6. [SECURITY_MODEL.md](./SECURITY_MODEL.md) — threat model, workspace isolation, secret/network/protected path, trust boundary 정책
7. [ARTIFACT_SCHEMA.md](./ARTIFACT_SCHEMA.md) — `.runs/<loop-id>/` 증거 보관 구조
8. [API_SPEC.md](./API_SPEC.md) — API, SSE event, idempotency 요구사항
9. [DB_SCHEMA.md](./DB_SCHEMA.md) — Prisma 모델 확장안
10. [MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md) — CLI 검증 커널 우선 구현 계획
11. [AUTONOMOUS_LOOP_SPEC.md](./AUTONOMOUS_LOOP_SPEC.md) — MVP-4 자율 발견·연속 실행 바깥 루프, autonomy 모드, guardrails
12. [SELF_IMPROVEMENT_LOOP_DESIGN.md](./SELF_IMPROVEMENT_LOOP_DESIGN.md) — 생성·검증·평가 3-exec 분리, 통과 후보 탐색-선택, 학습이 생성자만 개선하는 자기개선 루프 종합 설계
13. [SKILL_PRODUCTIZATION_RUNBOOK.md](./SKILL_PRODUCTIZATION_RUNBOOK.md) — `vibeloop-harness` Skill 제품화 실행 절차와 검증 gate
14. [SKILL_REAL_USER_LOOP_UAT.md](./SKILL_REAL_USER_LOOP_UAT.md) — 임시 git repo에서 Skill이 여러 문제를 1개씩 수정·검증·PR 후보화하고 적대적 실패 케이스를 차단하는 실사용 루프 UAT

## 실제 계약 파일

- [../schemas/task.schema.json](../schemas/task.schema.json)
- [../schemas/eval.schema.json](../schemas/eval.schema.json)
- [../schemas/eval-report.schema.json](../schemas/eval-report.schema.json)

## 개발 계획

- [../dev-plan/implement_20260610_223129.md](../dev-plan/implement_20260610_223129.md) — 전체 개발 계획 (Phase 1~17, MVP-0~4) — **완료**
- [../dev-plan/implement_20260612_061653.md](../dev-plan/implement_20260612_061653.md) — 3차 검토 반영 계획 (Phase 1~5: 서버 조립·Store 계약 테스트·스펙 개정·CI) — 반영 완료, 원격 CI 통과
- [../dev-plan/implement_20260612_061855.md](../dev-plan/implement_20260612_061855.md) — 신뢰 경계 보강 구현 완료 (Phase 1~7: provenance·hidden test·verifier lane·trust boundary 표시)
- [../dev-plan/implement_20260612_183255.md](../dev-plan/implement_20260612_183255.md) — 5차 검토 반영 패치 완료 (Phase 1~4: same_model_review 교체·CI actions 인상·체크박스 정합·exec 버퍼 상한)
- [../dev-plan/implement_20260613_085309.md](../dev-plan/implement_20260613_085309.md) — 모듈 분리 및 Skill 우선 제품화 개발 계획 (Phase 1~8: SDK/API 경계·OAuth proxy module·Skill skeleton·templates·실사용 루프 UAT)

## 실제 사용자 시나리오 테스트

- [MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md](./MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md) — VibeLoop을 Skill 우선 제품으로 만들되 CLI/SDK/CI/API/PR Bot으로 확장 가능하게 하는 모듈 분리 전략
- [SKILL_PRODUCTIZATION_RUNBOOK.md](./SKILL_PRODUCTIZATION_RUNBOOK.md) — Skill wrapper, task/eval 생성, report summarizer, Codex OAuth UAT 운영 runbook
- [SKILL_REAL_USER_LOOP_UAT.md](./SKILL_REAL_USER_LOOP_UAT.md) — 임시 git repo에서 두 문제를 순차 수정하고 accepted patch를 commit/PR 후보 branch로 남기며 hidden/protected/test/context 실패를 차단하는 Skill 루프 UAT
- [USER_SCENARIO_TESTING.md](./USER_SCENARIO_TESTING.md) — mock agent가 아닌 실제 CLI + command agent, Codex ChatGPT login, no-API-key OAuth proxy 기반 장바구니 수량 버그 수정 사용자 시나리오/UAT

## 검토 이력

- [EXPERT_REVIEW_1_20260610.md](./EXPERT_REVIEW_1_20260610.md) — 1차 전문가 검토: 설계 명세 (2026-06-10, 전 항목 반영 완료)
- [EXPERT_REVIEW_2_20260610.md](./EXPERT_REVIEW_2_20260610.md) — 2차 전문가 검토: 개발 계획 (2026-06-10, 전 항목 반영 완료)
- [EXPERT_REVIEW_3_20260612.md](./EXPERT_REVIEW_3_20260612.md) — 3차 전문가 검토: 구현 완료 검증 (2026-06-12, 반영 완료, 원격 CI 통과)
- [EXPERT_REVIEW_4_20260612.md](./EXPERT_REVIEW_4_20260612.md) — 4차 전문가 검토: 신뢰 경계 보강 계획(implement_20260612_061855) (2026-06-12, 전 항목 반영 완료)
- [EXPERT_REVIEW_5_20260612.md](./EXPERT_REVIEW_5_20260612.md) — 5차 전문가 검토: 검토 반영·신뢰 경계 구현 검증 (2026-06-12, 전 항목 반영 완료)
- [EXPERT_REVIEW_6_20260612.md](./EXPERT_REVIEW_6_20260612.md) — 6차 전문가 검토: 5차 반영 패치 구현 검증 (2026-06-12, 발견 0건 — **검토 사이클 종결**, 경미 관찰 O1만 선택 과제)

## 현재 결론

웹 UI가 MVP의 중심이 아니다. 먼저 아래 검증 커널을 만든다.

```text
task.yaml
+ isolated git worktree
+ eval.yaml runner
+ robust diff/test/protected-file guards
+ eval-report.json
```

이 커널이 하나의 candidate patch를 안전하게 `accept | reject | needs_human_review | needs_more_tests`로 판정할 수 있어야 웹 대시보드와 PR 자동화를 얹을 수 있다.

## Trust boundary 핵심

- 최종 통과 판정은 LLM이 아니라 deterministic decision engine의 `ALL_PASS`다.
- Advisory/critic 결과는 report에 표시되지만 final authority가 아니다.
- `eval-report` 1.1은 provenance hash와 verifier/trust summary를 포함한다.
