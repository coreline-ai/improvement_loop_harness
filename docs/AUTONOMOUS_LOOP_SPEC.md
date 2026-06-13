# AUTONOMOUS_LOOP_SPEC.md

## 1. 목적과 위치

이 문서는 **바깥 루프**(MVP-4)를 정의한다: 봇이 스스로 문제점을 발견하고 → 한 번에 1개씩 수정 루프를 돌리고 → 고정된 결과지(eval.yaml + acceptance + decision 12규칙)를 통과한 변경만 PR로 만들고 → 다음 문제로 반복하는 연속 실행 계층.

```text
[바깥 루프 — 이 문서]
Observe(발견) → Candidate 큐 → Task 자동 생성 → (승인) →
  [안쪽 루프 — 검증 커널, ARCHITECTURE §3]
  worktree → agent 수정 → guards → eval → decision
→ accept면 PR → 다음 candidate로 반복

Draft PR 생성 전 필수 accept 조건은 [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §8.1의 고정 통과 의미를 따른다. LLM/advisory 결과만으로 PR을 만들 수 없고, deterministic decision engine의 `ALL_PASS` 또는 human-approved 후보만 draft PR 대상이다.
Advisory report의 `same_model_review`는 모델 동일성 확증이 아니라 reviewer provider 독립성 미보장 표시이며, builder provider와 `critic.reviewer_provider`의 identity 비교로 판정한다(정확한 의미는 [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §8.1). advisory는 decision에 참여하지 않는다.
Hidden acceptance 테스트의 보관·주입·redaction 규칙은 [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §7.3이 정의하며, 바깥 루프는 이를 변경하거나 agent에 노출하지 않는다.
```

전제: 바깥 루프는 **검증 커널(MVP-0~3)이 완성된 뒤에만** 가동한다. 채점기 없이 자율 루프를 돌리면 테스트 약화·결과지 우회를 막을 수 없다 — 커널이 신뢰 경계다.

## 2. Autonomy 모드

| 모드 | 의미 | 기본 |
|---|---|---|
| `supervised` | 자동 발견된 candidate를 **사람이 승인해야** 루프 실행 | 기본값 |
| `auto` | low-risk candidate는 무인 실행. 단, 위험 영역 판정은 커널이 그대로 수행 — auto에서도 auth/DB 등은 `needs_human_review`로 멈춘다 | opt-in |

자동 merge는 어떤 모드에서도 없다. 산출물은 항상 **draft PR까지**다.

## 3. Observe — 문제 발견

### 3.1 입력 소스 (MVP-4 범위)

```text
- 테스트 실패        (프로젝트 test 명령 실행 결과)
- typecheck/lint 실패
- security scan      (gitleaks/audit 결과)
- 사용자 수동 등록    (UI/CLI로 candidate 직접 추가)
```

CI 로그·이슈 트래커·에러 모니터링 연동은 후속 확장이다.

### 3.2 보안 원칙 — 발견 입력은 untrusted

로그·이슈 본문은 prompt injection 벡터다. 다음을 강제한다.

```text
- 원문 텍스트를 agent 프롬프트에 그대로 넣지 않는다.
  candidate는 구조화 필드(source, 파일 경로, 테스트 이름, 에러 코드)로만 기록한다.
- 원문은 evidence artifact로 보관하되 task objective에는 하네스가
  생성한 정형 문장만 들어간다.
- 자동 생성 task의 write_scope는 실패 위치 기반 최소 경로로 제한한다 (§4).
```

### 3.3 Candidate 계약

```json
{
  "id": "cand_...",
  "source": "test_failure | typecheck | lint | security_scan | manual",
  "fingerprint": "sha256(source + 정규화된 위치 + 유형)",
  "title": "tests/auth/login.test.ts: invalid password returns 500",
  "evidence_refs": ["logs/discovery/test-run-2026....log"],
  "risk_area_hint": "auth",
  "trust_level": "medium",
  "injection_indicators": [],
  "repro_command": null,
  "priority": 80,
  "status": "proposed"
}
```

- `fingerprint`는 **중복 발견 방지** 키다. 같은 fingerprint의 candidate는 재생성하지 않는다.
- `dismissed`된 fingerprint는 기억하며, 동일 문제를 다시 제안하지 않는다 (사람이 명시적으로 해제할 때까지).

### 3.4 Candidate 상태 머신

```text
proposed -> approved | dismissed          (supervised: 사람 / auto: low-risk 자동 승인)
approved -> queued -> running -> processed | dismissed
running 중 loop decision:
  accept            -> processed (PR 생성)
  needs_human_review -> processed (승인 큐 대기 — orchestrator는 다음 candidate로)
  rejected/needs_more_tests -> 재시도 정책(§6)에 따라 queued 복귀 또는 dismissed
```

## 4. Task 자동 생성 규칙

candidate → task.yaml 변환은 하네스 코드가 수행한다 (LLM 아님, deterministic).

```text
- write_scope.allowed: 실패 파일과 그 테스트 경로 기반 최소 prefix
  (예: 실패가 src/features/auth/* 면 해당 feature + tests/auth/)
- risk_area: risk_classification 매핑으로 보수 분류,
  매핑 불가 시 unknown → 커널이 needs_human_review 처리
- required_evidence: source별 기본값
  (test_failure → fixes_reproduced_failure, lint/typecheck → adds_regression_test 또는
   해당 gate green 전환, security_scan → reduces_security_risk)
- limits: eval.yaml 전역 limits 그대로 (완화 금지)
- human_approval_required: risk_area_hint가 approval 대상이면 true 강제
```

자동 생성 task도 schemas/task.schema.json 검증을 통과해야 큐에 들어간다.

## 5. Orchestrator — 연속 실행 모델

```text
- 프로젝트당 orchestrator 1개, 동시 실행 루프 1개 (순차, 1문제 1루프)
- 매 루프 시작 전 default branch를 fetch하고 latest commit을 base로 사용
  (이전 PR과의 충돌은 PR 단계의 문제로 분리 — 루프는 항상 최신 기준)
- 우선순위 내림차순으로 candidate 1개 선택 → 안쪽 루프 실행 → 종료 처리(§3.4)
  → guardrail 점검(§6) → 다음 candidate
- candidate가 없으면 발견 주기(기본 30분)마다 Observe 재실행
- orchestrator 상태(실행 중 candidate, 예산 사용량)는 영속화 —
  재시작 시 멈춘 지점에서 복구, running 좀비는 failed 처리 후 재큐
```

## 6. Safety Guardrails

자율 루프의 폭주를 구조적으로 막는다. 전부 설정 가능하되 **기본값이 안전값**이다.

| 가드레일 | 기본값 | 동작 |
|---|---|---|
| kill switch | — | `orchestrator stop` 즉시 정지(현재 루프는 graceful cancel). 모든 모드에서 최우선 |
| 일일 루프 예산 | 20회/일 | 초과 시 다음 날까지 자동 일시정지 |
| 토큰 예산 | 설정 필수 | LLM proxy 집계 연동, 일일 한도 초과 시 일시정지 |
| 동일 candidate 재시도 | 2회 | 2회 reject되면 dismissed + 사람 알림 (무한 재시도 금지) |
| 연속 실패 차단기 | 5회 | 프로젝트에서 연속 5루프가 reject/failed면 orchestrator 자동 정지 + 알림 (체계적 문제 신호) |
| open draft PR 상한 | 5개 | 미처리 draft PR이 상한이면 새 PR 생성 루프 중단 (PR 스팸 방지) |
| 발견 폭주 제한 | 후보 50개 | proposed 초과분은 버리고 우선순위 상위만 유지 |

guardrail 발동은 전부 이벤트로 기록한다 (`orchestrator.paused`, `candidate.dismissed.retry_limit` 등).

## 7. 관측성

```text
이벤트: orchestrator.started/stopped/paused, discovery.completed,
        candidate.proposed/approved/dismissed/picked,
        loop.* (기존 LOOP_STATE_MACHINE 이벤트 그대로)
조회:   현재 모드·예산 사용량·큐 길이·최근 처리 이력
```

## 8. 범위 제외 (MVP-4)

```text
- 멀티 프로젝트 병렬 orchestration (프로젝트당 1개, 순차)
- 자동 merge (영구 금지 사항)
- LLM 기반 candidate 고도화(원인 추정·중복 군집화) — 후속
- 이슈 트래커/에러 모니터링/CI 로그 수집기 — 후속
- learnings/SKILL.md 자동 반영 — MVP-5 (Skill Manager)
```

## 9. 다른 문서와의 관계

- 커널 실행·판정: [ARCHITECTURE.md](./ARCHITECTURE.md), [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md)
- candidate 저장 모델: [DB_SCHEMA.md](./DB_SCHEMA.md) `ImprovementCandidate`
- 제어 API: [API_SPEC.md](./API_SPEC.md) §10
- 보안 가드레일의 위협 모델 근거: [SECURITY_MODEL.md](./SECURITY_MODEL.md) §10

### 7.1 Trust/injection 이벤트

Orchestrator는 `candidate.picked`, `approval.required` 외에 provenance/verifier/injection 관련 상태를 event payload에 포함할 수 있다. `injectionIndicators`가 있는 candidate는 auto 모드에서 자동 선택하지 않으며 supervised/human review 흐름에 남긴다.
