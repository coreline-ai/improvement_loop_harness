# 전문가 검토 4차 — 신뢰 경계 보강 계획 (2026-06-12)

검토 대상: [../dev-plan/implement_20260612_061855.md](../dev-plan/implement_20260612_061855.md) (LLM self-review 희석 방지 워크스트림, Phase 1~7).
검토 방법: 계획의 각 태스크를 (1) 현 구현 코드·테스트, (2) 기존 명세 11종, (3) 선행 워크스트림 2건([implement_20260610_223129.md](../dev-plan/implement_20260610_223129.md) 완료, [implement_20260612_061653.md](../dev-plan/implement_20260612_061653.md) 미착수)과 대조.

> 반영 상태: 2026-06-12 — **전 항목 반영 완료** (H1·H2·M1~M5·L1~L5 → [implement_20260612_061855.md](../dev-plan/implement_20260612_061855.md) 개정: 전제 조건·현황 기준선 신설, 태스크 gap-only 재정의, reason code 4곳 동시 개정 규칙, verifier 비교 의미론, repro_command 표시 전용, 서명 제외).

---

## 0. 총평

**문제 의식과 방향은 옳고, 이 프로젝트의 설계 철학("AI는 개선자이지 심판이 아니다")의 정확한 연장선이다.** hidden/held-out 테스트, provenance 기록, 독립 verifier lane, same-model 리뷰 표시, trust boundary UI는 실가치 있는 보강이고, 외부 근거(OWASP LLM Top 10, SWE-bench Verified, self-preference bias)를 인용한 것은 프로젝트 문서 중 처음으로 표준 근거를 단 사례다.

그러나 **두 가지 구조적 결함이 있다**: (1) 현 코드베이스에 **이미 구현·테스트된 방어를 재구현 대상으로 나열**하고 있어 그대로 착수하면 상당량이 재작업이 되고, (2) **3차 검토(EXPERT_REVIEW_3)의 미반영 발견과 선행 계획(061653)을 인지하지 못한 채** 그 완료를 전제하는 Phase(독립 verifier·smoke)를 포함한다. 태스크의 40% 안팎이 "현황 확인 후 gap만 구현"으로 재정의되어야 한다.

## 1. 높음

### H1. 선행 의존성 부재 — 같은 날 두 워크스트림이 순서 없이 공존

- 이 계획은 [EXPERT_REVIEW_3_20260612.md](./EXPERT_REVIEW_3_20260612.md)와 그 반영 계획 [implement_20260612_061653.md](../dev-plan/implement_20260612_061653.md)를 **참조 문서에서 누락**했다.
- 그 결과 충돌이 생긴다:
  - Phase 4 "독립 verifier/CI 레인"의 MVP 기본값이 "local harness required"인데, **현재 서버는 runKernel과 연결되어 있지 않다** (3차 검토 G1 — production 조립 부재). verifier 레인을 논하기 전에 1번 레인부터 존재해야 한다.
  - Phase 4의 GitHub Actions 초안은 061653 Phase 5(CI 도입, G6)와 **그대로 중복**된다.
  - Phase 7의 `pnpm --filter web test:smoke`는 smoke가 자동 게이트에 연결되지 않은 현 상태(G4)를 전제 못 한다.
- **권고**: 실행 순서를 명시하라 — **061653(서버 조립·계약 테스트·CI) 완료 후 061855 착수**. 061855의 참조 문서에 EXPERT_REVIEW_3·061653을 추가하고, Phase 4의 CI 초안 태스크는 "061653 Phase 5 산출물에 verifier lane 의미론을 얹는다"로 교체.

### H2. 기존 구현·명세와의 중복 — 재작업 위험

각 Phase에서 이미 끝난 것 (검증 근거 포함):

| 계획 태스크 | 현재 상태 | 근거 |
|---|---|---|
| Phase 3 fail-to-pass 검증 | **구현 완료** — test-on-base가 "base에서 fail → candidate에서 pass"를 검증하고, base에서도 통과하는 테스트는 evidence 불인정 | `packages/eval-engine/src/test-on-base.ts`, e2e fixture `base-pass-test-only` → EVIDENCE_MISSING (16/16 통과 재현 확인) |
| Phase 3 "pass-to-pass 유지" | **사실상 구현** — 기존 테스트는 candidate에서 required gate로 실행되며, test-integrity 가드가 기존 테스트 약화·삭제를 차단 | EVAL_ENGINE_SPEC §3·§5, e2e fixture `assertion-deleted`/`test-skip-added` |
| Phase 5 구조화 intake·원문 비전달 | **구현 완료** — collectors가 구조화 필드만 추출, 악성 지시문 주입 테스트 존재 | AUTONOMOUS_LOOP_SPEC §3.2, `packages/discovery/src/collectors/`, 4차 영역 검토에서 "원문 비포함 준수" 확인 |
| Phase 6 critic advisory 격리 | **설계 핵심으로 이미 강제** — decision 12규칙의 입력에 critic 결과 자체가 없음(advisory_findings로만 기록) | EVAL_ENGINE_SPEC §8, decision/rules.ts 정합 확인(3차 검토) |
| Phase 2 "agent의 eval-report 직접 작성 차단" | **구조적으로 차단됨** — artifact root가 대상 repo 밖 데이터 디렉터리라 agent write 경로 밖이고, worktree 안에 eval-report.json을 만들어도 가짜 파일일 뿐 판정 경로와 무관 | SECURITY_MODEL §3(M9 외부화), ARCHITECTURE §6 금지 항목 |

- 신규로 실제 가치가 있는 것: **hidden_acceptance 그룹**(신규), **provenance 필드**(신규), **verifier lane**(신규), **same_model_review 표시**(신규), **discovery source trust level**(신규), **trust boundary UI**(신규).
- **권고**: 모든 태스크를 "현황 확인 → 명세·테스트와 대조 → 미충족 gap만 구현" 형태로 재서술하고, 위 표의 완료 항목은 태스크에서 제거하거나 "회귀 테스트로 고정만 추가"로 축소.

## 2. 중간

### M1. decision 규칙 개정 절차가 태스크로 없음

새 reason code 3종(`ARTIFACT_PROVENANCE_MISMATCH`, `HIDDEN_ACCEPTANCE_FAILED`, `VERIFIER_MISMATCH`)은 전부 "추가 검토"로만 적혀 있다. reason code 하나를 늘리면 **4곳 동시 개정**이 필요하다: EVAL_ENGINE_SPEC §8 우선순위 표(삽입 위치 결정), `decision/rules.ts`, `eval-report.schema.json`, fixture. 단순화 우선 검토 권고:

- `HIDDEN_ACCEPTANCE_FAILED` → hidden test를 required gate의 한 형태로 모델링하면 기존 `GATE_REQUIRED_FAILED`(rule 8)로 흡수 가능 — 새 코드 불필요할 수 있음.
- `ARTIFACT_PROVENANCE_MISMATCH` → 가드 계열(rule 2~7 부근) 삽입이면 first-match 순서 영향 분석 필수.
- `VERIFIER_MISMATCH` → needs_human_review 계열(rule 11 부근). 12규칙의 결정성 테스트(동일 입력 100회)도 함께 갱신.

### M2. verifier "비교"의 의미론 미정의

"로컬 runner 결과와 CI/verifier 결과를 비교"라고만 되어 있다. 정의가 필요하다:

- **무엇을 비교하나**: decision + required gate의 status까지만 (duration·로그·타임스탬프 제외). flaky 게이트가 있으면 mismatch가 빈발하므로 비교 대상을 결정적 필드로 한정.
- **"독립"의 정확한 의미**: 같은 deterministic engine을 다른 환경에서 돌리는 것이므로 *판정 로직 독립*이 아니라 **환경 독립**이다(로컬 환경 조작·결과 변조 탐지가 목적). 이 한계를 명세에 정직하게 적어야 "독립 검증"이 과대 포장되지 않는다.

### M3. `repro command` 필드 = 신규 injection 벡터

Phase 5 candidate allowlist에 `repro command`가 들어 있다. **untrusted 발견 입력에서 추출한 "재현 명령"을 harness가 실행하면, 구조화 추출로 막아놓은 injection이 명령 실행 경로로 되살아난다.** 권고: (a) 표시 전용(실행 금지) 필드로 명시하거나, (b) 실행이 필요하면 eval.yaml에 사전 정의된 명령 템플릿의 인자만 허용. 현 구현의 collectors는 명령을 추출하지 않으므로, 이 필드 추가 자체가 보안 후퇴가 되지 않게 설계 조건을 계획에 박아야 한다.

### M4. "서명" 범위 과대 — 태스크는 hash뿐

개발 범위에 "`eval-report.json` 생성·**서명**·검증 경로"라고 썼지만 Phase 2 태스크는 전부 hash 기록이다. 단일 로컬 머신에서 harness가 자기 키로 서명하는 것은 변조 방어 가치가 낮다(키도 같은 머신에 있음). 이미 manifest sha256이 필수(ARTIFACT_SCHEMA §6)이므로 MVP는 **hash 기반 provenance로 범위를 축소 명시**하고, 서명은 외부 verifier lane(별도 신뢰 도메인)이 생길 때 후속 과제로.

### M5. 스키마 변경 절차·버전 정책 누락

Phase 2·3은 `eval-report.schema.json`(additionalProperties: false)과 `eval.schema.json` 변경을 수반한다. `schema_version` 인상 정책, 기존 report와의 호환(검증기 분기 또는 일괄 마이그레이션 없음 선언)이 계획에 없다. "docs/·schemas/ 선행 개정" 규칙도 공통 규칙에 빠져 있다 ("문서와 테스트 동시 갱신"은 있으나 약함).

## 3. 낮음

| ID | 내용 | 권고 |
|---|---|---|
| L1 | 참조 문서 누락: EXPERT_REVIEW_1~3, implement_20260612_061653, ARTIFACT_SCHEMA.md, MVP_IMPLEMENTATION_PLAN.md | 추가 (특히 Phase 2가 artifact를 다루면서 ARTIFACT_SCHEMA 미참조) |
| L2 | 공통 규칙에 커밋 규칙(기존: Phase당 단일 커밋)과 수동 검증 기록 규칙(3차 검토 L5로 도입) 누락 | 두 줄 추가 |
| L3 | Phase 1 자체 테스트가 `rg` 패턴 매칭 수준 — 문서 정합 검증으로 약함 | 상호참조 링크 실재 검증(이전 워크스트림 점검 방식) 추가 |
| L4 | hidden test 보관·주입 경로의 보안 전제 부족 — agent에 숨기려면 worktree 밖 보관 + eval 시점 주입이어야 하고, artifact 로그로 내용이 새지 않아야 함 | 잔여 리스크에 일부 있으나 운용 규칙 문서화 태스크에 보관 위치·주입 시점·artifact redaction을 명시 |
| L5 | `git diff --check`(공백 검사)를 자체 테스트로 사용 — 검증 의미 미약 | 유지해도 무해하나 통과 기준으로 계상하지 말 것 |

## 4. 잘된 부분 (유지)

- **"고정 통과 의미" 표와 최종 `accept` 조건 조합** — 통과의 의미를 한 곳에 고정한 것은 이 워크스트림의 가장 좋은 산출물 형식이다. 반영 시 EVAL_ENGINE_SPEC에 승격할 가치가 있다.
- **외부 근거 인용** — OWASP·SWE-bench Verified·self-preference bias 출처를 단 것은 이후 명세 개정의 논거가 된다.
- **"최종 완료 조건" 섹션** — 워크스트림 단위 acceptance를 체크박스로 고정한 것은 dev-plan 형식의 좋은 확장.
- 제외 범위의 "LLM judge를 최종 합격 판정자로 승격하지 않는다" — 제품 원칙의 재확인으로 정확.

## 5. 권고 반영 순서

1. **H1**: 참조 문서 보강 + "전제: implement_20260612_061653 완료 후 착수" 명시, Phase 4 CI 태스크를 061653 Phase 5 산출물 위 verifier 의미론 추가로 교체
2. **H2**: 전 태스크를 "현황 확인 → gap만" 형태로 재서술, 완료 항목은 회귀 고정 테스트로 축소
3. **M1~M5**: decision 규칙 개정 절차 태스크화(흡수 우선 검토), verifier 비교 의미론 정의, repro command 실행 금지 조건, 서명→hash 범위 축소, schema_version 정책
4. **L1~L5**: 참조·규칙·테스트 보강

이 수정이 반영되면 본 계획은 061653 완료 직후 착수 가능한 견고한 워크스트림이 된다.
