# 전문가 검토 5차 — 검토 반영·신뢰 경계 구현 검증 (2026-06-12)

검토 대상: 두 워크스트림의 구현 — [implement_20260612_061653.md](../dev-plan/implement_20260612_061653.md)(3차 검토 반영, G1~G6)와 [implement_20260612_061855.md](../dev-plan/implement_20260612_061855.md)(신뢰 경계 보강, Phase 1~7). 커밋 `5849ec6..02c99d4`, 66파일 +3,521/−316.
검토 방법: (1) 로컬 게이트 전 스위트 재현, (2) 원격 CI 실결과 대조, (3) 두 워크스트림 정합성 병렬 점검, (4) 보안·정확성 핵심 경로 직접 추적(exec 재작성, decision 14규칙, provenance, repro_command, same_model_review).

> 반영 상태: **전 항목 반영 완료** — [../dev-plan/implement_20260612_183255.md](../dev-plan/implement_20260612_183255.md) Phase 1~4 완료. M1·M2·M3·L1·L2·L3·L5 반영, L4는 본 워크스트림 커밋 규칙으로 적용. 최신 원격 CI run은 Phase 4 완료 후 기록한다.

---

## 0. 총평

**두 워크스트림 모두 계획-코드-테스트-CI의 정합이 우수하다.** 3차 검토의 핵심이었던 G1(커널↔서버 미연결)은 완전히 해소되었다 — `runner.ts`가 runKernel을 호출해 EvalReport·GateRun·Artifact·AgentRun·WorkspaceRun 5종 rows를 실영속하고(dead schema 해소), `main.ts` 기동 진입점·graceful shutdown·start 스크립트가 생겼으며, 조립 통합 테스트가 이를 고정한다. 신뢰 경계 워크스트림은 4차 검토의 gap-only 원칙을 정확히 지켰다(기구현 방어 재구현 0건, 회귀 고정으로만 보강).

발견 사항은 **높음 0건, 중간 3건, 낮음 5건** — 모두 운영·일관성 수준이며 아키텍처 결함은 없다. 가장 실질적인 것은 M1(same_model_review 판정 로직의 브리틀함)과 M3(CI actions의 Node20 강제 전환 임박)이다.

## 1. 재현 검증 결과 (2026-06-12 직접 실행)

| 항목 | 결과 |
|---|---|
| `pnpm typecheck` / `pnpm lint` | 통과 / 통과 |
| `pnpm test` (unit) | **121 테스트 전부 통과** (3차 시점 106 → +15) |
| `pnpm test:e2e` | **18/18 통과** (16종 + hidden-acceptance·provenance 계열 추가) |
| 원격 CI — 최신 커밋 `02c99d4` | **그린** (run 27406109586: verify ubuntu/macos, prisma-store, web smoke) — EXPERT_REVIEW_4 배너의 "CI 별도 확인 대상"은 해소됨 |
| PrismaStore 계약 테스트 | CI `prisma store contract` job에서 실제 Postgres로 실행·통과 확인 |
| decision 규칙 | **14규칙** — rules.ts 순서(…7 LIMIT → **8 ARTIFACT_PROVENANCE_MISMATCH** → 9 GATE_REQUIRED_FAILED → … → 12 RISK_HUMAN_APPROVAL → **13 VERIFIER_MISMATCH** → 14 ALL_PASS)가 EVAL §8 표와 일치. 12↔13 순서는 둘 다 needs_human_review라 결정에 영향 없음(reason code만 차이) — 건전 |
| repro_command | 저장·표시 경로만 존재, **실행 연결 0건**(grep) + injection indicator 스캔 대상에 포함됨 — 표시 전용 준수 |
| hidden_acceptance | repo 밖 보관·agent 종료 후 주입·artifact에 메타만 기록, 실패는 `GATE_REQUIRED_FAILED`로 흡수(새 reason code 없음 — 4차 M1 권고 그대로) |
| 푸시 상태 | main == origin/main, 작업 트리 클린 |

처음 `feat: wire production loop runner` 푸시의 CI 1회 실패 후 `fix: stabilize prisma event sequencing`으로 복구된 이력은 정상 반복이며, 그 과정에서 발견된 execa timeout hang → `exec.ts` spawn 재작성은 **dev plan "이슈 및 수정"에 기록 규칙대로 남아 있다** (3차 검토 L5 규칙의 첫 준수 사례 — 좋음).

## 2. 중간

### M1. `same_model_review` 판정이 브리틀한 문자열 휴리스틱

[run.ts](../packages/cli/src/run.ts) L360: `options.agentSpec === 'codex' && critic?.require_different_provider !== true`.

문제 2가지:

1. **정확 일치의 취약성** — agentSpec이 `mock:<path>`나 실제 codex 명령 문자열(`codex exec ...`)이면 `=== 'codex'`가 false가 되어, critic provider 독립성이 보장되지 않았는데도 플래그가 꺼진다. **"같은 모델 아님"으로 오인되는 방향의 오류**라 신뢰 경계 표시로서는 역방향 실패다.
2. **의미 과잉** — 현재 LLM critic runner가 없으므로(advisory는 명령 게이트) 이 플래그가 실제로 의미할 수 있는 것은 "critic의 provider 독립성이 **보장되지 않음**"이지 "같은 모델이 리뷰함"이 아니다.

권고: (a) adapter 종류 기반 판정으로 교체하고 **불명이면 보수적으로 true**(독립성 미보장), (b) 플래그 의미를 "reviewer provider independence not guaranteed"로 스펙(EVAL §8.1/AUTONOMOUS_LOOP_SPEC)에 명문화, (c) mock/codex/문자열 변형 케이스 단위 테스트.

### M2. 061653 dev plan 체크박스 불일치 — 본문 67개 미체크

[implement_20260612_061653.md](../dev-plan/implement_20260612_061653.md)는 Phase 상태 요약 5개가 전부 `[x]`이고 "반영/검증 기록" 표까지 있으나, **각 Phase 본문의 구현 태스크·자체 테스트·완료 조건 체크박스 67개가 전부 `[ ]`로 남아 있다.** dev-plan 공통 규칙("체크박스 상태를 실제 진행 상태와 맞게 업데이트한다") 위반이며, 문서가 상태 추적 수단이라는 전제를 깨뜨린다 (061855는 0개 미체크로 정상). 권고: 구현 검증이 끝난 항목 일괄 체크 + 어긋난 항목이 있으면 그 자리에서 드러내기.

### M3. CI actions의 Node20 지원 종료 임박 (2026-06-16 강제 전환)

CI run annotation: `actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`가 Node20 기반 — **2026-06-16부터 Node24로 강제 실행**되며 호환 문제 가능성이 공지됨. 4일 뒤다. 권고: `ci.yml`의 actions 버전 인상(checkout/setup-node 최신 메이저) 후 CI 1회 그린 확인.

## 3. 낮음

| ID | 내용 | 권고 |
|---|---|---|
| L1 | [exec.ts](../packages/shared/src/exec.ts) stdout/stderr **무제한 버퍼링** — execa의 기본 maxBuffer가 사라져 폭주 게이트가 하네스 메모리를 소진할 수 있음 | 상한(예: 16MB) + 초과 시 절단 표시. 로그 파일 기록은 스트리밍 유지 |
| L2 | exec.ts safety resolve(5s) — SIGKILL조차 실패하는 극단 케이스에서 'error'로 resolve하고 프로세스가 잔존할 수 있는 트레이드오프 | 의도된 anti-hang 설계임을 코드 주석+EVAL 스펙 한 줄로 명시 (현재 dev plan 이슈 기록에만 있음) |
| L3 | `repro_command`가 TASK_PROTOCOL에 미언급, hidden_acceptance 실행 규칙이 AUTONOMOUS_LOOP_SPEC 본문에 미상세 (EVAL 스펙에는 있음) | 두 문서에 상호참조 한 줄씩 |
| L4 | 커밋 granularity 규칙 위반 — "Phase당 단일 커밋" 규칙 대비 061653(5 Phase)이 2~3커밋, 061855(7 Phase)가 1커밋으로 합쳐짐 | 이력 추적 약화. 다음 워크스트림부터 준수 (이번 건 재작업 불요) |
| L5 | EXPERT_REVIEW_4 배너의 "최종 CI 결과는 main push 후 별도 확인 대상" 문구가 구식 — 최신 커밋 CI 그린(run 27406109586) 확인됨 | 배너 갱신 |

## 4. 검증 확인 표 (계획 ↔ 구현 대조 핵심)

| 항목 | 확인 |
|---|---|
| G1: runner.ts runKernel 호출 + 5종 rows 영속 + main.ts listen/shutdown + start 스크립트 + agent_spec 경로 | ✅ (조립 통합 테스트 포함) |
| G2: store-contract describe.each(Memory/Prisma) + TEST_DATABASE_URL 게이트 + CI postgres job 실실행 | ✅ |
| G5: addLoopEvent $transaction max+1 + P2002 재시도 + 동시 10건 테스트 | ✅ |
| G3·L1~L4(3차): API_SPEC §6 in-process 명문화·agent_spec, DB_SCHEMA Approval 상태값·영속 주체, SECURITY_MODEL 역반영, EVAL 매칭 의미론·baseline 타입 기반 코드 | ✅ |
| G4·G6: ci.yml ubuntu+macos 매트릭스·Node22·전 게이트·smoke job, root test:smoke/start:server, 루트 README Quickstart | ✅ |
| 061855: provenance 4곳 동시(스키마 1.0/1.1 하위 호환 포함)·hidden 흡수·verifier lane(GateRun.lane)·비교 의미론(결정 필드 한정)·trustLevel·injection 라우팅·trust_summary·PR body 근거 | ✅ |
| gap-only 준수: 기구현 방어 재구현 0건, 회귀 고정 테스트로만 보강 | ✅ |

## 5. 권고 반영 순서

1. **M1** — same_model_review 판정 로직 교체(보수적 기본값) + 의미 명문화 + 테스트
2. **M3** — CI actions 버전 인상 (6/16 강제 전환 전)
3. **M2** — 061653 체크박스 일괄 정합화
4. **L1·L2** — exec.ts 버퍼 상한 + 트레이드오프 명시
5. **L3·L5** — 문서 한 줄 보강 + 배너 갱신

이 5건이 반영되면 두 워크스트림은 잔여 지적 없이 종결되며, 남는 것은 기존 후속 과제(컨테이너 격리, LLM critic runner, vibeloop init, hidden test 보안 저장소 연동)뿐이다.
