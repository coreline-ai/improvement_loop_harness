# 전문가 검토 2차 — 개발 계획 (2026-06-10)

검토 대상: 전체 개발 계획 문서 (구 `docs/impl-plan-vibeloop-harness.md` → 현 [../dev-plan/implement_20260610_223129.md](../dev-plan/implement_20260610_223129.md)).
검토 방법: 계획의 모든 Phase·태스크를 분리 명세 10종 + 스키마 3종과 양방향 대조 (계획에 없는 명세 요구사항 / 명세에 없는 계획 항목 탐색).

> 반영 상태: 2026-06-10 — 본 검토의 전 항목을 새 개발 계획(`dev-plan/implement_20260610_223129.md`)에 반영 완료. 구 impl-plan 문서는 폐기.

---

## 0. 총평

계획의 **기술 내용은 명세와 높은 정합성**을 보였다 (가드 선행 fail-fast, test-on-base 게이밍 차단, base_commit 대비 diff, decision 12규칙, fixture 16종 등 1차 검토 반영 사항이 전부 태스크화됨). 그러나 **프로세스 결함 1건(형식 위반)과 커버리지 공백 4건, 명확화 필요 3건**이 발견되었다. 특히 retry와 재현성 입력 기록은 명세가 명시적으로 요구하는데 계획에서 누락되어 있었다 — 구현 중에 발견했다면 CLI/커널 배선의 재작업을 유발했을 항목들이다.

---

## 1. 프로세스 결함

### F1. dev-plan 스킬 형식 미준수 (Critical — process)

**문제**: 구 계획서는 임의 템플릿(impl-plan)으로 작성되어 프로젝트의 dev-plan 규칙을 위반했다.

| 규칙 (dev-plan-generator) | 구 문서 | 조치 |
|---|---|---|
| `dev-plan/implement_YYYYMMDD_HHMMSS.md` 위치·명명 | `docs/impl-plan-*.md` | `dev-plan/implement_20260610_223129.md`로 재작성 |
| 첫 H1 = 파일명, `작성 일시` 명기 | 불일치 | 준수 |
| 상단 고정 섹션: 개발 목적/개발 범위/제외 범위/참조 문서/공통 진행 규칙 | 일부만 존재 | 전부 포함 |
| Phase마다 구현 태스크 + **자체 테스트 + 이슈 및 수정 + 완료 조건** 체크박스 | 이슈/완료조건 체크박스 부재 | 전 Phase 포함 |
| 경량 유지 — PRD/대형 설계서化 금지 | 아키텍처 다이어그램·리스크 표 등 과중 | 경량화 (설계 내용은 docs/ 명세가 담당) |
| 선행 Phase 자체 테스트 완료 후에만 다음 진행 | "병렬 가능" 표기와 충돌 | 선형 순서(Phase 1~15)로 재배열 |

**교훈**: 계획 문서의 형식은 곧 실행 규칙이다. 병렬 표기는 dev-plan의 순차 진행 규칙과 양립하지 않으므로 제거했다.

---

## 2. 커버리지 공백 (명세 요구 ↔ 계획 누락)

### P1. retry 명령 부재 (High)

**근거**: [LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) §5가 retry 4모드를 정의하고, [MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md) MVP-1 산출물이 "cancellation/retry basic support"를 요구한다. 구 계획은 cancellation만 있고 **CLI retry가 어느 Phase에도 없었다** (API의 retry는 Phase 13에야 등장 — MVP-1 요구 시점보다 늦음).

**반영**: Phase 10에 `vibeloop retry <loop-id> --mode <4모드>` 태스크 신설. `retry_eval_only`는 보관된 candidate.patch를 재적용해 agent 재실행 없이 재평가 — flaky required gate 복구 경로(1차 검토 M2)의 CLI 구현체.

### P2. 재현성 입력 고정 기록 누락 (High)

**근거**: [ARTIFACT_SCHEMA.md](./ARTIFACT_SCHEMA.md) §2는 `input/{task.yaml, eval.yaml, base_commit.txt, env-snapshot.json}`과 `workspace/workspace-ref.json`을 요구하고, [PRODUCT_SPEC.md](./PRODUCT_SPEC.md) 성공 기준 "재현성"은 이 입력 스냅샷이 전제다. 구 계획의 artifacts Phase는 디렉터리 생성만 있고 **입력 고정 기록 태스크가 어디에도 없었다**.

**반영**: Phase 10(CLI 배선)에 "입력 고정 기록" 태스크 + 자체 테스트("input/ 4파일 + workspace-ref.json 존재") 추가.

### P3. patch 재적용 유틸의 소유자 불명 (Medium)

**근거**: [ARCHITECTURE.md](./ARCHITECTURE.md) §2 Patch Manager 책임에 "patch 저장, rollback"이 있고, patch 적용은 test-on-base(테스트만 분리 적용)·retry_eval_only(전체 재적용)·PR 생성(branch에 적용) **3곳에서 필요**한데 구 계획은 test-on-base 내부 구현으로만 암시했다.

**반영**: Phase 5 diff.ts에 `applyPatch(target, patch, {includeOnly?})` 헬퍼를 명시하고 3개 사용처(Phase 7·10·15)가 재사용하도록 연결.

### P4. 같은 task active loop 1개 제한 누락 (Medium)

**근거**: [LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) §8 "같은 task의 active loop는 기본 1개만 허용한다". 구 계획의 loops API 태스크에 이 제약이 없었다.

**반영**: Phase 13 loops 라우트 태스크에 명시 + 자체 테스트("active loop 존재 시 신규 생성 거부") 추가.

---

## 3. 명확화 (모호하면 구현 중 흔들리는 것들)

### P5. critic의 MVP 위치 (Medium)

[ARCHITECTURE.md](./ARCHITECTURE.md) §3 14단계 "adversarial critic run (advisory gate의 하나로 실행)" — 계획에 LLM critic runner가 없는 것이 **누락인지 의도인지** 불명확했다. **반영**: advisory 명령 게이트 실행 경로(Phase 6 orchestrator)까지가 본 계획 범위이고, LLM critic runner 구현체는 "제외 범위 + 잔여 과제"로 명시. 커널은 critic 없이도 deterministic 판정이 완결된다(critic은 advisory only이므로 decision 규칙에 불참 — EVAL_ENGINE_SPEC §8).

### P6. `vibeloop init` 부재의 명시 (Low)

[EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §1의 repo 측 `scripts/eval.sh` wrapper와 eval.yaml은 누가 만들어 주는가 — 템플릿 생성기는 어떤 MVP 산출물에도 없으므로 후속 과제로 명시했다 (e2e fixture는 수제 eval.yaml 사용).

### P7. 수동 검증의 MVP-1 완료 조건 연결 (Low)

MVP-1 완료 조건 "실제 local repo에서 low-risk test patch를 accept"가 자동 테스트로는 불가(실제 Codex CLI 필요) — Phase 12 자체 테스트에 수동 검증 항목으로 명시했다.

---

## 4. 명세 ↔ 계획 정합성 체크표 (수치 대조)

| 항목 | 명세 | 계획 반영 | 일치 |
|---|---|---|---|
| 커널 실행 단계 | 16단계 (ARCHITECTURE §3) | Phase 10 배선 태스크가 16단계 전부 나열 | ✅ |
| builtin 가드 | 5종 (git-meta/protected/scope/limits/test-integrity) | Phase 5 태스크 5종 + Phase 6 디스패처 | ✅ |
| decision 규칙 | 12규칙 + reason code (EVAL §8) | Phase 8 "12규칙 각각" 자체 테스트 | ✅ |
| evidence detector | 6종 (EVAL §7.3) | Phase 7 detectors 6종 | ✅ |
| 보간 변수 | 5종 (EVAL §6) | Phase 2 interpolation 화이트리스트 5종 | ✅ |
| fixture | 16종 (MVP §6) | Phase 11 — 6+5+5종 분해 합 16 | ✅ |
| DB 모델 | 13개 (DB_SCHEMA §2) | Phase 13 "13개 모델 전사" | ✅ |
| retry 모드 | 4종 (LOOP §5) | Phase 10 CLI + Phase 13 API | ✅ (P1 반영 후) |
| artifact 디렉터리 | 8종 (input~integrity, ARTIFACT §2) | Phase 3 레이아웃 + Phase 10 입력 기록 | ✅ (P2 반영 후) |
| PR 금지 상태 | 5종 (API §8) | Phase 15 "금지 상태 5종 전부 403" | ✅ |
| env allowlist / 차단 키 | SECURITY §5 | Phase 4 env scrub + 자체 테스트 | ✅ |
| SSE seq 재전송 | LOOP §9 / API §9 | Phase 13 events + Phase 14 dedup | ✅ |
| 금지사항 9개 | MVP §8 | dev-plan "문서 기반 제약 사항" 전사 | ✅ |

---

## 5. 결론

- 형식: dev-plan 규칙 완전 준수 형태로 재작성 (F1).
- 내용: 커버리지 공백 4건(P1~P4)과 명확화 3건(P5~P7)을 계획에 반영.
- 정합성: §4 체크표 13항목 전부 일치.

이 계획(`dev-plan/implement_20260610_223129.md`)은 Phase 1부터 착수 가능하며, 진행 중 발견 이슈는 dev-plan 규칙대로 해당 Phase의 "이슈 및 수정"에 기록한다.
