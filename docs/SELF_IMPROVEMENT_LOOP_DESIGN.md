# SELF_IMPROVEMENT_LOOP_DESIGN.md

이 문서는 VibeLoop Harness를 **"검증을 통과한 수정에서 더 나은 개선을 자율적으로 찾아내되, LLM이 자기 결과를 느슨하게 통과시키지 못하게 하는 자기개선 루프"**로 진화시키기 위한 종합 설계다. 기존 명세([ARCHITECTURE.md](./ARCHITECTURE.md), [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md), [AUTONOMOUS_LOOP_SPEC.md](./AUTONOMOUS_LOOP_SPEC.md))를 대체하지 않고, [implement_20260613_160413.md](../dev-plan/implement_20260613_160413.md)의 최신 결론을 설계 문서로 고정한다.

## 0. 최종 통과 공식

```text
accept = verifier_pass ∧ evaluator_pass ∧ policy_pass ∧ risk_pass ∧ provenance_pass
```

이 공식이 이 문서의 최상위 불변식이다.

- `verifier_pass`: 고정 Verifier가 correctness/safety/regression/evidence를 통과시킴.
- `evaluator_pass`: 고정 Evaluator가 improvement-quality를 통과시킴.
- `policy_pass`: `policy.lock` / `rulepack` / write scope / independence policy를 만족함.
- `risk_pass`: 자동 루프 허용 risk 범위 안에 있음. 정책 밖이면 묻지 않고 skip/backlog.
- `provenance_pass`: task/eval/policy/rulepack/candidate/artifact hash가 변조되지 않음.

LLM은 이 공식의 어느 항도 직접 통과시킬 수 없다. LLM은 **후보 생성, 반례 탐색, refinement hint 생성**까지만 한다.

## 1. 목적

핵심 질문은 변하지 않는다.

```text
이 변경이 재현 가능한 증거로 진짜 개선임을 판정할 수 있는가?
```

여기에 자기개선 루프는 한 단계를 더한다.

```text
검증 통과에서 끝내지 않고
→ 같은 문제 안에서 더 나은 후보를 병렬 탐색하고
→ 적대적 반례와 고정 평가 룰로 다시 압박하고
→ 최종적으로 현재 정책·예산·후보 풀 안에서 best-known candidate를 자동 선택한다.
```

이 설계는 "항상 세계 최고의 코드"를 수학적으로 증명하지 않는다. 일반 소프트웨어 변경에서 절대적 최고 증명은 불가능하다. 대신 현실적으로 자동화 가능한 목표를 아래처럼 정의한다.

```text
best-known candidate =
  동일 task / policy.lock / rulepack / budget / 후보 풀 / 적대적 검증 범위 안에서
  고정 Verifier와 고정 Evaluator를 모두 통과하고,
  deterministic Arbiter 점수가 가장 높은 후보
```

## 2. 한 문장 정의

> **LLM은 후보 생성과 반례 탐색에만 사용하고, 통과·품질·최종 선택은 고정 Verifier, 고정 Evaluator, deterministic Arbiter가 수행하는 multi-exec 자율 개선 루프다.**

이전 설계의 `LLM Evaluator가 advisory ranking으로 더 나음을 선택한다`는 가정은 폐기한다. 별도 provider LLM은 평가자가 아니라 **Adversary / Explorer**로 사용한다. 즉, LLM끼리는 경쟁·공격하게 만들고, 판정은 고정 룰이 한다.

## 3. 막혔던 모순과 최종 돌파구

| 시도                                    | 문제                                                         | 최종 판단     |
| --------------------------------------- | ------------------------------------------------------------ | ------------- |
| 같은 LLM이 자기 수정을 평가             | 자기 선호·느슨한 자기통과 위험                               | 폐기          |
| 다른 provider LLM을 최종 평가자로 사용  | 편향은 줄지만 여전히 LLM 판단이 품질 통과/선택에 개입        | 폐기          |
| 사람이 매 결과를 판단                   | 자율 루프가 아니라 수동 검토 루프                            | hot loop 금지 |
| 순수 단일 후보 + 고정 룰                | 안전하지만 탐색 폭이 좁아 "더 나은 후보"를 찾기 어려움       | 보완 필요     |
| 병렬 Builder + Adversary + 고정 Arbiter | 탐색 폭을 넓히되, 통과/품질/선택은 deterministic rule이 맡음 | 채택          |

**돌파구는 판정자 LLM 분리가 아니라, LLM을 탐색자와 공격자로만 쓰고 판정권을 고정 코드에 가두는 것이다.**

## 4. 5-Role / Multi-Exec 구조

기존 `3-Exec(생성자/검증자/평가자)` 표현은 폐기한다. 최신 구조는 최소 5개 역할이다.

| 역할            | LLM 사용 | 실행 격리                         | 쓰기 권한          | 판정 권한       | 산출물                              |
| --------------- | -------- | --------------------------------- | ------------------ | --------------- | ----------------------------------- |
| Builder Agent   | 예       | 후보별 exec CLI + 독립 worktree   | `write_scope` 내부 | 없음            | patch, summary                      |
| Adversary Agent | 예       | 별도 exec CLI + read-only context | 없음               | 없음            | counterexample/test proposal JSON   |
| Verifier        | 아니오   | harness/eval runner               | 없음               | correctness     | gate runs, evidence, verifier lanes |
| Evaluator       | 아니오   | harness/eval runner               | 없음               | quality         | quality report, evaluator pass      |
| Arbiter         | 아니오   | harness process                   | 없음               | final selection | selection report                    |

보조 역할:

| 역할            | LLM 사용 | 권한                         | 설명                                         |
| --------------- | -------- | ---------------------------- | -------------------------------------------- |
| Refiner Agent   | 예       | 같은 `write_scope` 내부 수정 | 실패 사유 기반으로 parent candidate 개선     |
| Static Attacker | 아니오   | 없음                         | 테스트 약화, scope 우회, shortcut smell 탐지 |
| Proposal Filter | 아니오   | ephemeral test staging만     | Adversary proposal을 고정 룰로 필터링        |
| PR Creator      | 아니오   | branch/PR 생성               | selected candidate만 draft PR 후보화         |

Verifier/Evaluator/Arbiter는 LLM이 아니다. 이 셋이 자율 루프의 판정 엔진이다.

## 5. 목표 루프 흐름

```text
문제 1개 발견
  ↓
task pack + policy.lock + rulepack + budget 고정
  ↓
Builder LLM A/B/C가 병렬 후보 생성
  - 별도 exec CLI
  - 후보별 독립 worktree
  - provider/model/process identity 기록
  ↓
Candidate Pool
  ↓
고정 Verifier
  - guards
  - required gates
  - hidden acceptance
  - improvement evidence
  - verifier lane
  ↓
고정 Evaluator
  - evidence strength
  - target directness
  - diff risk
  - regression/security/performance/complexity threshold
  - no-gaming rule
  ↓
verified + qualified 후보만 남김
  ↓
Adversary LLM X/Y + Static Attacker가 read-only 공격
  - counterexample 제안
  - edge/regression test proposal
  - shortcut/scope 우회 의심 보고
  ↓
Proposal Filter가 고정 룰로 유효 proposal만 선별
  ↓
Ephemeral Gates로 후보 전체 재검증
  ↓
부족 후보는 bounded same-issue refinement
  ↓
Deterministic Arbiter가 accepted 후보 중 best-known candidate 선택
  ↓
Draft PR 후보 생성
  ↓
다음 문제로 이동
```

사람은 hot loop 심판이 아니다. 정책 밖, 위험군, 범위 확장, 독립성 부족은 사람에게 즉시 묻지 않고 `skip/backlog/dry-run only`로 처리한다.

## 6. 신뢰 불변식

1. LLM output만으로 `accept`, `quality pass`, `selected`를 만들 수 없다.
2. Builder와 Adversary는 가능하면 다른 provider/model/process/context를 사용한다.
3. Builder transcript, hidden tests, secret, private chain은 Adversary/Refiner/Skill에 노출하지 않는다.
4. Evaluator는 LLM이 아니라 `eval.yaml`/`policy.lock`/`rulepack`에 선언된 deterministic quality rule만 사용한다.
5. Adversary proposal은 고정 필터를 통과해야만 ephemeral gate가 된다.
6. 새 ephemeral gate는 후보 풀 전체에 동일 적용한다. 특정 후보만 유리한 gate는 폐기한다.
7. refinement는 같은 objective, 같은 acceptance, 같은 write_scope 안에서만 허용한다.
8. policy/rulepack은 loop 중 변경 불가이며 hash provenance에 기록한다.
9. 새 평가 룰은 현재 loop에 즉시 편입하지 않는다. shadow/replay 후 다음 loop부터 적용한다.
10. 자동 merge는 금지한다. 산출물은 draft PR 후보까지다.

> 잔여 리스크(누설면): `artifact-leak`는 기본적으로 **agent stdout/stderr**를 스캔하고, candidate patch는 `scan_patch` opt-in으로 추가 차단한다(reject only). project gate stdout/stderr·`input/eval.yaml` 원본 config는 아직 미스캔이다(상세·잔여 v2는 [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md)의 artifact-leak 커버리지 표 참조).

## 7. 독립성 등급

| 등급 | 의미                                      | 자동 루프 허용 기본값 |
| ---- | ----------------------------------------- | --------------------- |
| I0   | 같은 모델, 같은 provider, 같은 process    | 금지                  |
| I1   | 같은 provider, 다른 model/process/context | 허용 가능하나 경고    |
| I2   | 다른 provider 또는 다른 계정/key/process  | 권장 기본값           |
| I3   | 다른 provider + 별도 sandbox/host/network | 보안 강화 목표        |

v1 기본은 **Builder 1개 이상 + Adversary 1개 이상 + I1 이상**이다. 자동 PR 모드는 가능하면 I2를 요구한다. I1만 가능하면 report에 `independence_warning`을 남긴다. I0이면 autonomous PR 후보 생성은 금지하고 local dry-run만 허용한다.

`same_model_review`는 최종 평가 판단이 아니라 독립성 경고 신호로 사용한다.

## 8. 고정 통과 상태 정의

| 상태           | 의미                                                | PR 후보 가능 여부 |
| -------------- | --------------------------------------------------- | ----------------- |
| `generated`    | LLM이 patch 생성                                    | 불가              |
| `verified`     | 고정 Verifier 통과                                  | 불가              |
| `qualified`    | 고정 Evaluator 통과                                 | 불가              |
| `attacked`     | Adversary proposal 필터 후 임시 gate 재검증 완료    | 불가              |
| `accepted`     | verifier/evaluator/policy/risk/provenance 모두 통과 | 후보              |
| `selected`     | Arbiter가 best-known candidate로 선택               | 가능              |
| `pr_candidate` | draft PR 생성 가능한 최종 상태                      | 가능              |
| `skipped`      | 정책 밖/위험/범위 확장                              | 불가, backlog     |

```text
verified  = builtin guards + required gates + hidden acceptance + evidence + verifier lane 통과
qualified = deterministic improvement-quality rules 통과
accepted  = verified ∧ qualified ∧ policy_pass ∧ risk_pass ∧ provenance_pass
selected  = accepted 후보 중 deterministic score/tie-break 통과
```

**최종 결정 (2026-06-13): `ALL_PASS`는 재정의하지 않는다.** `ALL_PASS`는 Verifier correctness 판정(= `verified`, decision rank-15 reason code)으로 **그대로 유지**한다. Evaluator를 포함하도록 확장하지 않는다 — 확장하면 `decision/rules.ts`·`EVAL_ENGINE_SPEC §8.1` 우선순위표·`eval-report.schema.json`·모든 fixture·6차 검토에서 검증된 의미를 전부 흔든다(회귀 비용 큼, 이득 작음).

대신:

- `qualified`(Evaluator 통과)는 **decision engine 밖의 별도 quality-layer 상태**다. 품질 실패는 decision reason code가 아니라 `quality_report.status`(`fail`/`inconclusive`/`needs_refinement`)로 기록한다.
- decision engine 15규칙은 **correctness 전용으로 불변**.
- **PR 후보 자격 = `accepted ∧ selected`** = `verified(=ALL_PASS) ∧ qualified ∧ policy_pass ∧ risk_pass ∧ provenance_pass ∧ Arbiter selected`.

즉 correctness(검증자)와 quality(평가자)를 **이름과 코드 경로에서 분리**한다. `EVAL_ENGINE_SPEC.md`에는 이 결정(ALL_PASS 불변 + quality는 별도 layer)을 반영한다.

## 9. Deterministic Evaluator

Evaluator는 LLM이 아니다. `eval.yaml`, `policy.lock`, `rulepack`에 선언된 고정 임계값과 하네스 artifact만 사용한다.

| Rule ID | 평가 기준         | 고정 판정 예시                                                                               |
| ------- | ----------------- | -------------------------------------------------------------------------------------------- |
| Q1      | evidence strength | `required_evidence` 중 task 유형에 맞는 evidence가 최소 1개 이상 `present`                   |
| Q2      | test meaning      | 새/수정 테스트는 base에서 fail, candidate에서 pass                                           |
| Q3      | target directness | changed files가 `task.metadata.target_paths` 또는 discovery fingerprint 위치와 교차          |
| Q4      | diff risk         | changed files/lines가 policy 상한 이하, forbidden/protected path 미접촉                      |
| Q5      | regression        | pass-to-pass required gates 유지, hidden acceptance 통과                                     |
| Q6      | security          | 신규 critical/high finding 0개 또는 declared threshold 이하                                  |
| Q7      | performance       | 성능 task는 baseline 대비 declared threshold 이상 개선, 일반 task는 declared regression 이내 |
| Q8      | complexity        | complexity/duplication metric이 악화되지 않거나 declared threshold 이내                      |
| Q9      | adversary closure | 필터를 통과한 critical counterexample/ephemeral gate가 모두 pass                             |
| Q10     | no gaming         | test weakening, skip, 의미 없는 assertion, eval/rule 완화, hidden test 노출 시도 없음        |

Evaluator report 예시:

```json
{
  "schema_version": "1.0",
  "candidate_id": "cand-a1",
  "status": "pass",
  "score": 87,
  "threshold": 80,
  "rules": [
    {
      "id": "Q3",
      "status": "pass",
      "metric": "target_directness",
      "value": 1,
      "threshold": 1,
      "artifact_ref": "reports/quality/directness.json"
    }
  ],
  "refinement_reasons": [],
  "rulepack_hash": "sha256:..."
}
```

Metric 위조 방지는 구조화 metric 채널([EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §7.3 N4)을 기반으로 한다. stdout fallback은 보조이며, 구조화 metric이 있으면 stdout 주장은 무시한다.

## 10. Adversary proposal과 Ephemeral Gate

> **격리 전제 (최종 결정):** Adversary가 만든 테스트는 ephemeral gate로 **실제 실행**된다 — 이는 미신뢰 LLM 생성 코드를 호스트에서 돌리는 것이므로, 기존 커널(빌더의 write_scope 코드만 실행)보다 위험 표면이 크다. 따라서 **Adversary 단계(M2)는 컨테이너/네트워크 격리(R1)를 하드 전제로 한다.** R1 이전에는 Adversary를 dry-run/dev에서만 돌리고 자율 PR 모드에서는 비활성한다.

Adversary LLM은 통과 여부를 판단하지 않는다. 대신 검증된 후보를 공격한다.

| Adversary 작업         | 결과물                           | 권한   |
| ---------------------- | -------------------------------- | ------ |
| 후보 diff 공격         | counterexample                   | 제안만 |
| 엣지케이스 생성        | test proposal                    | 제안만 |
| 우회성 수정 의심       | suspicion report                 | 제안만 |
| 더 단순한 대안 힌트    | refinement hint                  | 제안만 |
| 누락된 acceptance 지적 | candidate issue / backlog signal | 제안만 |

Proposal은 아래 고정 필터를 모두 통과해야 ephemeral gate가 된다.

| 필터           | 조건                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| scope          | test target path가 허용된 테스트 디렉터리 또는 ephemeral staging 디렉터리 내부 |
| objective link | task objective, target paths, failure fingerprint와 구조적으로 연결            |
| no weakening   | 기존 테스트 삭제/skip/느슨한 assertion/timeout 완화 없음                       |
| base/candidate | fail-to-pass 또는 pass-to-pass 기대 결과가 실제 실행으로 확인됨                |
| determinism    | 반복 실행에서 같은 결과                                                        |
| no hidden leak | hidden acceptance 원문·경로·시크릿 문자열 포함 없음                            |
| bounded cost   | 실행 시간/파일 수/라인 수 상한 이하                                            |
| all-candidate  | 특정 후보에만 유리하게 적용하지 않고 후보 풀 전체에 동일 적용                  |

Proposal 분류:

| 분류               | 처리                                                   |
| ------------------ | ------------------------------------------------------ |
| `objective_edge`   | base fail/candidate pass이면 임시 task acceptance gate |
| `regression_guard` | base pass/candidate pass이면 임시 regression gate      |
| `quality_probe`    | metric 산출 가능하면 Evaluator input                   |
| `out_of_scope`     | backlog candidate로 저장, 현재 PR에는 미편입           |
| `invalid`          | 폐기, adversary quality report에 기록                  |

## 11. Refinement Controller

Refinement는 LLM 감상이 아니라 고정 실패 사유를 해결하기 위한 bounded retry다.

```text
candidate fails verifier/evaluator/adversary gate
  → structured failure reasons 생성
  → 같은 objective/write_scope/acceptance/policy 안에서 refinement task 생성
  → parent candidate patch에서 분기
  → Refiner exec CLI 실행
  → verifier/evaluator/adversary 재검증
  → accepted 후보면 candidate pool에 추가
  → round/budget/plateau 상한 도달 시 stop
```

Refiner 입력 제한:

- hidden test 원문 금지
- Adversary private reasoning/log 금지
- 구조화 실패 사유와 공개 artifact ref만 제공
- objective/acceptance 재작성 금지
- write_scope 확장 금지
- eval/test/rulepack 완화 금지

중단 조건:

- refinement round 상한 도달
- 모든 후보가 같은 reason으로 반복 실패
- score 개선폭이 plateau threshold 이하
- 비용/시간 budget 초과
- out-of-policy/high-risk 분류
- valid counterexample 미해결
- evaluator/rule/test 완화 시도

## 12. Deterministic Arbiter

Arbiter는 accepted 후보만 비교한다. LLM 투표나 LLM 점수는 사용하지 않는다.

```text
candidate_score =
  evidence_score
  + quality_score
  + adversary_closure_score
  + security_delta_score
  + performance_delta_score
  + directness_score
  - diff_risk_penalty
  - complexity_penalty
  - cost_penalty
```

Tie-break 순서:

1. hidden acceptance와 critical ephemeral gate를 더 많이 닫은 후보
2. 더 높은 deterministic quality score
3. 더 작은 diff
4. 더 적은 파일 수
5. 더 낮은 risk area
6. 더 빠른 gate runtime
7. candidate id 사전순 안정 정렬

Arbiter 산출물은 `reports/selection-report.json`에 저장하고 rulepack hash, candidate patch hash, evaluator report hash를 포함한다.

## 13. policy.lock / rulepack

`policy.lock`은 loop가 자율로 움직일 수 있는 헌법이다. 사람은 hot loop 중 후보를 승인하지 않고, 사전에 이 룰을 고정한다.

```json
{
  "schema_version": "1.0",
  "mode": "autonomous_best_known_loop",
  "rulepack": {
    "id": "coreline-default-autonomous-v1",
    "version": "1.0.0",
    "hash": "sha256:...",
    "mutation": "frozen_during_loop"
  },
  "quality": {
    "required": true,
    "min_score": 80,
    "rules": ["Q1", "Q2", "Q3", "Q4", "Q5", "Q9", "Q10"]
  },
  "refinement": {
    "max_rounds": 2,
    "plateau_min_delta": 3,
    "max_total_candidates": 6
  },
  "autonomy": {
    "hot_loop_human_prompt": false,
    "out_of_policy_action": "skip_to_backlog",
    "create_draft_pr": true,
    "auto_merge": false
  }
}
```

## 14. 학습이 안전하게 들어가는 자리

얼어있는 것과 학습하는 것을 분리한다.

```text
얼어있음:  Verifier + Evaluator + Arbiter + policy.lock + rulepack
학습 가능: Builder 탐색 힌트, Adversary 공격 패턴, candidate 우선순위, shadow rule proposal
```

- 학습 자산([failureClusterKey](../packages/discovery/src/fingerprint.ts) 기반 군집 포함)은 생성자 탐색 힌트와 candidate 우선순위로만 흐른다.
- 학습 자산은 untrusted다. 구조화 요약만 저장하고 objective/프롬프트에 원문 주입을 금지한다.
- 학습은 현재 loop의 통과 바를 낮추지 않는다.
- 새 룰 후보는 shadow/replay를 통과해야 다음 loop rulepack candidate가 된다.
- replay-safe frozen rulepack은 `builtin:rulepack-semantic`으로 다음 loop의 required integrity gate가 될 수 있다. 실행은 R1 격리·`network=none`·hash-bound spec만 허용하며, 같은 loop 적용은 fail-closed다.

Shadow rule learning:

```text
loop artifacts + failures + adversary proposals
  → rule proposal 생성
  → shadow rule로 replay corpus에 적용
  → known-bad를 pass시키지 않는지 확인
  → known-good rejection rate가 threshold 이하인지 확인
  → append-only 강화인지 확인
  → 다음 loop rulepack candidate로 승격
```

자동 승격 조건:

- 기존 룰 삭제/완화 없음
- 현재 실행 중인 loop에는 적용 금지
- replay corpus에서 known-bad pass 없음
- known-good rejection rate가 policy threshold 이하
- deterministic implementation만 포함
- rulepack diff와 hash가 artifact에 남음

## 15. 모듈화 & Skill-first 제품화

기존 모듈 경계([MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md](./MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md))를 유지한다. Skill은 wrapper이고 판정 로직을 복제하지 않는다.

```text
@vibeloop/eval-engine
  - verify candidate
  - evaluate quality
  - filter adversary proposals
  - execute frozen rulepack semantic gates
  - arbitrate selected candidate

@vibeloop/agent-adapters
  - builder/refiner/adversary exec adapter
  - provider/model/process identity
  - read-only/write-scope policy

@vibeloop/sdk
  - runAutonomousBestKnownLoop()
  - candidate pool orchestration
  - refinement loop
  - adversary rulepack candidate/replay/freeze/inspect
  - PR candidate handoff

CLI / API / Skill
  - SDK 호출
  - 결과 요약
  - 판정 로직 복제 금지
```

PR 후보 자격 (전 채널 동일 predicate — CLI `run`, Skill summarizer, server PR 게이트, `improve` selection):

```text
pr_candidate = decision=accept (⇒ ALL_PASS + hidden/protected/scope guards)
             ∧ qualified (quality-report.status != fail)
             ∧ (improve 경로) Arbiter selected
```

accepted-but-unqualified는 PR 후보가 아니다 → `improve_quality_then_rerun`. `improve`는 selection-report와 출력에 `selected_artifact_root/report/patch`, 후보별 `artifact_root/report_path/quality_report_ref`를 담아 PR-actionable하게 만든다.

"통과 후 더 나은 개선" 탐색: `runImprovementLoop`의 **challengerRounds**는 accepted 후보가 있어도 항상 실행되어 더 나은 후보를 찾고, Arbiter가 best-known을 재선택한다(실패/열등 challenger는 기존 통과 후보를 못 밀어냄). 실패 복구용 `refinementRounds`(첫 accepted에서 중단)와 구분된다.

## 16. 기존 작업·계획 재배치

| 항목                                                                  | 최신 설계에서의 위치                                                   | 상태            |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------- |
| R5 worktree prune (`1b744d8`)                                         | 운영 위생                                                              | 유지            |
| N4 metric 구조화 채널 (`1b744d8`)                                     | Deterministic Evaluator의 anti-gaming 기반                             | 유지            |
| same_model_review provider 비교 (`e649c81`)                           | agent independence warning / I0~I3 등급 산정                           | 유지            |
| failureClusterKey (`d2545bc`)                                         | learning → Builder 탐색 힌트 / 반복 실패 cluster                       | 유지            |
| [implement_20260613_130927](../dev-plan/implement_20260613_130927.md) | Phase 0 조사 기록                                                      | 유지            |
| [implement_20260613_133900](../dev-plan/implement_20260613_133900.md) | LLM evaluator가 아니라 Adversary/provider independence 기반으로 재해석 | 정정 필요       |
| [implement_20260613_133901](../dev-plan/implement_20260613_133901.md) | learning/failure ledger → 탐색 힌트 + shadow rule source               | 유지            |
| [implement_20260613_133902](../dev-plan/implement_20260613_133902.md) | convergence → budget/plateau/skip/backlog stop                         | 유지            |
| [implement_20260613_154330](../dev-plan/implement_20260613_154330.md) | advisory RefinementJudge 가정은 폐기, 본 문서와 160413 계획으로 대체   | superseded      |
| [implement_20260613_160413](../dev-plan/implement_20260613_160413.md) | 최신 구현 계획                                                         | source of truth |

## 17. 진화 로드맵 (구현 상태)

```text
M0 [구현 완료]  Deterministic Evaluator + 단일 Builder
    - evaluateQuality (eval-engine), eval.yaml `evaluator` block, SDK `qualified`
    - LLM evaluator 없음; verified ∧ qualified일 때만 PR 후보. (commit 6205af7)

M1 [구현 완료]  병렬 Builder 후보 풀 + deterministic Arbiter
    - runImprovementLoop (sdk): 후보별 격리 kernel → 고정 점수/tie-break best-known 선택. (70bcf80)

M3 [구현 완료]  bounded same-issue refinement
    - refinementRounds: accepted 없을 때만 추가 round, keep-best, round-cap. (31a3343)

M5 [구현 완료]  Skill-first 제품화
    - `vibeloop improve` CLI + Skill fix-and-improve 모드. (b9e869f)

M2 [부분 구현]  Adversary proposal filter + isolated confirmation substrate
    - filterAdversaryProposal (eval-engine): 정적 고정 필터(scope/objective/no-weakening/
      no-hidden-leak/bounded-cost) 구현. (0888ef3)
    - improve/orchestrate `--adversary-review`는 advisory-only M2 handoff를 생성하고,
      `adversary-confirm`은 R1 격리 실행 또는 dry-run 경계로 확인한다.
    - 남은 증거: 실제 live adversary M2 실행 lane과 광범위 corpus.

M4 [부분 구현]  shadow rule learning + frozen semantic gate core
    - diffRulepack(append-only) + decideShadowPromotion(승격 게이트) 구현. (1ca7c1a)
    - `adversary-rulepack-candidate` → `adversary-rulepack-replay-corpus` →
      `adversary-rulepack-replay` → `adversary-rulepack-freeze`로 replay-safe
      frozen lock을 만들 수 있다.
    - `builtin:rulepack-semantic`은 frozen executable spec을 다음 loop required
      gate로 실행한다. 적용 경로는 `orchestrate --generate-eval`의
      `--eval-rulepack-semantic`, 기존 eval을 승계 overlay하는
      `orchestrate --carry-rulepack`, 단일 루프 `improve --rulepack-semantic`이다.
      `rulepack inspect`는 lock validity와 `semantic_ready`를 요약한다.
    - 남은 증거: live adversary lane + broad M4 semantic corpus + 운영 재현 evidence.
```

병행 전제: 컨테이너/네트워크 격리(R1)는 무인 상시 가동의 별도 보안 전제이며, **M2의 Adversary 테스트 실행의 하드 전제**다.

## 18. 비목표 (Non-goals)

- 검증자 또는 평가자를 LLM으로 만드는 것
- LLM output만으로 통과/품질/최종 선택을 결정하는 것
- LLM 투표로 winner를 정하는 것
- 자동 merge
- hot loop 중 사람에게 품질 판단을 묻는 것
- policy/rulepack을 현재 loop에서 자동 완화하는 것
- hidden acceptance 원문을 Builder/Adversary/Skill에 노출하는 것
- 다른 문제로 범위를 확장하는 개선
- 절대적 "세계 최고 코드" 증명

## 19. 관계 문서

- 최신 구현 계획: [implement_20260613_160413.md](../dev-plan/implement_20260613_160413.md)
- 검증자/통과 판정: [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md), [ARCHITECTURE.md](./ARCHITECTURE.md)
- 바깥 루프/guardrails: [AUTONOMOUS_LOOP_SPEC.md](./AUTONOMOUS_LOOP_SPEC.md)
- 위협 모델/untrusted 입력: [SECURITY_MODEL.md](./SECURITY_MODEL.md)
- 모듈/Skill 제품화: [MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md](./MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md)
- Skill 제품화 runbook: [SKILL_PRODUCTIZATION_RUNBOOK.md](./SKILL_PRODUCTIZATION_RUNBOOK.md)
- 비전 원장: [loop_engineering_notes.md](../dev-plan/loop_engineering_notes.md)
- superseded refinement 초안: [implement_20260613_154330.md](../dev-plan/implement_20260613_154330.md)
