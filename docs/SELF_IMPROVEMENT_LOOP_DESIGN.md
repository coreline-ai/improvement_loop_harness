# SELF_IMPROVEMENT_LOOP_DESIGN.md

이 문서는 VibeLoop Harness를 **"검증을 통과한 수정에서 더 나은 개선을 자율적으로 찾아내되, LLM이 자기 결과를 느슨하게 통과시키지 못하게 하는 자기개선 루프"**로 진화시키기 위한 종합 설계다. 기존 명세(특히 [ARCHITECTURE.md](./ARCHITECTURE.md), [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md), [AUTONOMOUS_LOOP_SPEC.md](./AUTONOMOUS_LOOP_SPEC.md))를 대체하지 않고 그 위에 얹는다.

## 1. 목적

핵심 질문은 변하지 않는다 — _"이 변경이 재현 가능한 증거로 진짜 개선임을 판정할 수 있는가."_ 여기에 한 단계를 더한다:

```text
검증 통과(pass/fail 엄격) 로 끝이 아니라
→ 같은 문제 안에서 "더 나은 개선"이 가능한지 자율적으로 탐색·선택하고
→ 그 과정에서 얻은 경험을 다음 개선에 재사용하며
→ 이 능력을 모듈로 만들어 Skill 등 여러 형태로 제품화한다.
```

## 2. 한 문장 정의

> **생성·검증·평가를 완전히 분리된 실행 주체로 두고, 통과(=correctness)는 결정론 검증자만이 판정하며, "더 나음"은 결정론 적합도와 별도 provider LLM 평가자가 결정론 통과 후보들 사이에서만 advisory로 선택한다. LLM은 생성·평가에만 들어가고 통과 권한은 절대 갖지 않는다.**

## 3. 막혔던 모순과 돌파구

| 시도                              | 문제                                              |
| --------------------------------- | ------------------------------------------------- |
| 같은 LLM이 자기 수정을 평가       | 느슨한 자기통과(self-preference bias) — 신뢰 불가 |
| 사람이 매 결과를 판단             | 자율이 아님                                       |
| 순수 고정 룰만으로 "더 나음" 판정 | 측정 못 하는 품질을 못 잡음                       |

**돌파구 = 권한 분리 + 탐색-선택.**

1. **통과(correctness) 권한은 결정론 코드(검증자)만** 가진다. LLM은 절대 통과를 결정하지 않는다.
2. **"더 나음"은 판단이 아니라 탐색-선택**으로 바꾼다: 후보를 여러 개 생성해 결정론 검증자를 통과한 것들끼리 비교한다.
3. 비교는 **1차 결정론 적합도 + 2차 별도 provider LLM 평가자(advisory)**. 평가자는 **이미 통과한 후보들 사이에서만** 순위를 매기므로, 최악의 오판이 "안전하지만 덜 좋은 후보 선택"으로 **갇힌다** — 위험한 변경은 검증자가 이미 걸렀다.

이래서 자율이면서도 "LLM 느슨한 통과"가 구조적으로 불가능하다.

## 4. 3-Exec 분리 (생성자 / 검증자 / 평가자)

세 역할은 **완전히 분리된 실행 주체(별도 exec)**다. 단, **검증자만 LLM이 아니다.**

| 역할                         | 실행 주체                             | LLM?    | 권한                                    |
| ---------------------------- | ------------------------------------- | ------- | --------------------------------------- |
| 분석·수정·개선자 (Generator) | builder agent exec (provider A)       | ✅ LLM  | 수정 후보 **생성만**. 판정 0            |
| **검증자 (Verifier)**        | `vibeloop run` 결정론 커널            | ❌ 코드 | **유일한 통과 권한 (`ALL_PASS`)**       |
| 평가자 (Evaluator)           | judge agent exec (**provider B ≠ A**) | ✅ LLM  | 검증 통과 후보 사이 순위 **advisory만** |

검증자가 LLM이면 안 되는 이유는 이 프로젝트의 존재 이유와 같다: 검증자가 LLM이면 "LLM이 LLM 코드를 느슨하게 통과"가 심판 자리로 복귀한다. 검증자는 guards + gates + evidence + decision 14규칙의 **고정 룰 코드**이고, 이미 CLI(`vibeloop run`)로 존재한다.

## 5. 루프 흐름

```text
문제 1개
  ↓
[생성자 LLM] 후보 N개 병렬 생성 (각자 격리 worktree, 별도 exec)        ← 생성만
  ↓
[검증자 결정론] 각 후보를 ALL_PASS로 필터                              ← correctness 바닥
  ↓  (통과 후보만 남음 — 위험/오류는 여기서 전부 탈락)
선택:
  1차  고정 적합도(결정론): diff 경제성·coverage delta·protected 미접촉·evidence 강도 …
  2차  [평가자 LLM, provider B] 측정 못 한 "더 나음"만 advisory 순위/방향
  ↓
best 후보가 사전 적합도 바(eval.yaml에 박힌 고정 기준)를 넘으면 → PR 후보
넘는 후보가 없으면 → PR 만들지 않고 "개선 못 찾음" 기록 → 다음 문제
```

- **재수정 루프**: 평가자가 방향 힌트를 주면 생성자가 다시 만들 수 있으나, **새 후보도 검증자를 다시 통과해야** 한다. 생성-평가 담합이 바닥을 못 낮춘다.
- **종료**: 바를 넘는 후보 확보 / 후보 예산 소진 / round 상한. 사람 판단은 **기존에 이미 정의된 위험군(auth·protected·eval 변경)만** — 품질 때문에 사람을 부르지 않는다.

## 6. 신뢰 불변식 (절대 규칙)

1. 통과(accept) 권한은 결정론 검증자(`ALL_PASS`)만. LLM(생성·평가)은 통과를 결정하지 않는다.
2. 평가자 LLM은 **검증 통과한 후보들 사이에서만** 순위를 매긴다(바닥 위에서만).
3. 평가자 provider ≠ 생성자 provider. 같으면 독립성 미보장 → 평가자 순위는 tie-break로 강등 또는 비활성 (`same_model_review` 신호 활용).
4. 평가자 입력은 untrusted: diff/test 출력의 prompt injection 차단(구조화 요약, hidden 원문 비노출).
5. 재수정 후보도 검증자를 다시 통과해야 한다.
6. 적합도 "바"는 사람이 eval.yaml에 **한 번** 박는다(루프 밖). 루프는 그 안에서 자율로 돈다.
7. 학습은 바를 절대 낮추지 않는다(§8).

## 7. "더 나음"의 두 층 (고정 + LLM)

| 층                         | 누가           | 무엇                                                                                                                                                                                                |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1차 (고정 적합도, 결정론)  | 코드           | 측정 가능한 품질: 변경량·파일 수·coverage/latency delta·protected 접촉·회귀 테스트 동반·evidence 강도. 전부 기존 artifact(eval-report/evidence-summary/changed-files/metrics/test-on-base)에서 계산 |
| 2차 (LLM 평가자, advisory) | provider B LLM | 1차로 못 재는 질적 "더 나음"(가독성·구조). **동률/잔여 차원에서만**, 순위만, 통과 0                                                                                                                 |

> 1차가 metric을 읽으므로 metric 위조 방지(구조화 metric 채널, [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §7.3 N4)가 **이 적합도의 anti-gaming 기반**이다.

## 8. 학습이 안전하게 들어가는 자리

**얼어있는 것과 학습하는 것을 분리한다.**

```text
얼어있음(학습/완화 금지):  검증자(correctness) + 적합도 바(eval.yaml 고정 기준)
자율 학습:                생성자/탐색 — "어떻게 바를 넘는 후보를 더 잘/자주 만드나"
```

- 학습 자산(성공/실패 패턴, [failureClusterKey](../packages/discovery/src/fingerprint.ts) 기반 군집)은 **생성자의 탐색 힌트·후보 우선순위**로만 흐른다. 검증자·적합도 바에는 닿지 않는다.
- LLM이 마음껏 학습해도 안전한 이유: 얼어있는 두 고정 게이트를 못 속인다. 학습은 탐색을 똑똑하게 만들 뿐 바를 낮추지 않는다.
- 학습 자산은 untrusted: 구조화 요약만 저장하고 objective/프롬프트에 원문 주입 금지.

## 9. 모듈화 & Skill-first 제품화

기존 모듈 경계([MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md](./MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md))를 그대로 따른다.

```text
@vibeloop/eval-engine : evaluateQuality(artifacts, evalConfig.evaluator) → 고정 적합도(결정론)
@vibeloop/agent-adapters : 생성자/평가자를 exec CLI adapter로 (provider 분리)
@vibeloop/sdk : runImprovementLoop() — 생성 N → 검증(runKernel) → 적합도+평가자 선택 → PR/drop
   ↓ 같은 core 호출
CLI / API : 얇은 호출
Skill (1순위 제품) : skills/vibeloop-harness 의 fix-and-improve 모드 — SDK 호출 + 요약만, 판정 로직 복제 금지
```

PR 후보 자격 = `decision.accept ∧ evaluateQuality.met`. decision 14규칙은 건드리지 않는다(correctness/quality 분리).

## 10. 기존 작업·계획 재배치

이 설계가 그동안 흩어진 작업에 제자리를 준다.

| 항목                                        | 이 설계에서의 위치                                                   | 상태                   |
| ------------------------------------------- | -------------------------------------------------------------------- | ---------------------- |
| R5 worktree prune (`1b744d8`)               | 운영 위생                                                            | 유지                   |
| N4 metric 구조화 채널 (`1b744d8`)           | **1차 적합도의 anti-gaming 기반**                                    | 유지(이제 소비처 생김) |
| same_model_review provider 비교 (`e649c81`) | **평가자 provider 독립성 신호**                                      | 유지(이제 소비처 생김) |
| failureClusterKey (`d2545bc`)               | **학습→생성자 탐색 힌트 군집 키**                                    | 유지                   |
| implement_20260613_133900 (evaluator)       | §4 평가자 exec + §7 2차                                              | 이 설계로 통합         |
| implement_20260613_133901 (learning)        | §8 생성자 학습(바 불변)                                              | 방향 확정, 영속은 후속 |
| implement_20260613_133902 (convergence)     | §5 "바 넘는 후보 없음 → drop/다음" 으로 흡수                         | 대부분 흡수            |
| implement_20260613_154330 (refinement)      | §5 흐름으로 **재작성 대상** (단일 RefinementJudge → 생성N+검증+선택) | 재작성 필요            |
| implement_20260613_130927 (Phase 0 조사)    | 조사 기록                                                            | 유지                   |

## 11. 진화 로드맵 (현재 우선순위와 조화)

검증 커널이 신뢰 바닥이므로 그 위에서만 자율을 켠다.

```text
M0 (지금): evaluateQuality 고정 적합도 + runImprovementLoop(생성 1 → 검증 → 적합도 통과 시 PR)
           - 평가자 LLM 없이 결정론 적합도만으로 동작 (가장 안전, 즉시 가치)
M1: 생성 N 병렬 + 적합도 선택 (탐색 도입)
M2: 평가자 exec(다른 provider) 2차 advisory 순위 + injection 가드
M3: 생성자 학습(탐색 힌트·군집) — 바 불변
M4: Skill fix-and-improve 제품화 + 실사용 UAT
전제(병행): 컨테이너/네트워크 격리(R1)는 무인 상시 가동의 별도 전제
```

Skill 제품화([SKILL_PRODUCTIZATION_RUNBOOK.md](./SKILL_PRODUCTIZATION_RUNBOOK.md))가 첫 제품 채널이라는 원칙은 유지된다.

## 12. 비목표 (Non-goals)

- 검증자를 LLM으로 만드는 것 (절대 금지 — 신뢰 바닥 붕괴)
- LLM/평가자가 통과(accept)를 결정하는 것
- 자동 merge
- 품질 미달을 매번 사람에게 보내는 것 (자율 아님 — 바 미달이면 그냥 폐기·다음)
- 적합도 바를 학습으로 자동 완화하는 것
- 다른 문제로 범위를 확장하는 개선 (same-issue 한정)

## 13. 관계 문서

- 검증자(통과 판정): [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md), [ARCHITECTURE.md](./ARCHITECTURE.md)
- 바깥 루프·guardrails: [AUTONOMOUS_LOOP_SPEC.md](./AUTONOMOUS_LOOP_SPEC.md)
- 위협 모델·untrusted 입력: [SECURITY_MODEL.md](./SECURITY_MODEL.md)
- 모듈·Skill 제품화: [MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md](./MODULARIZATION_AND_SKILL_PRODUCTIZATION_STRATEGY.md)
- 비전 원장: [../dev-plan/loop_engineering_notes.md](../dev-plan/loop_engineering_notes.md)
- 구현 계획(재작성 대상): [../dev-plan/implement_20260613_154330.md](../dev-plan/implement_20260613_154330.md)
