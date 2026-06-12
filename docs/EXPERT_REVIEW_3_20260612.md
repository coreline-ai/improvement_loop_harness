# 전문가 검토 3차 — 구현 완료 검증 (2026-06-12)

검토 대상: Phase 1~17 구현 코드 전체 (커밋 `aa998ca`~`78298e4`, 소스 145파일 / 15,610 LOC).
검토 방법: (1) 자체 테스트 전 스위트 재현 실행, (2) 명세 11종 대비 4영역 정합성 점검(가드·워크스페이스 / eval-engine / 서버 API·DB / 자율 루프·웹), (3) 핵심 경로 직접 추적(e2e 커버리지, CLI 배선, 영속 계층, 서버 부트스트랩).

> 반영 상태: **반영 완료 / 원격 CI 통과** — [../dev-plan/implement_20260612_061653.md](../dev-plan/implement_20260612_061653.md) Phase 1~5 구현, 로컬 게이트(`typecheck`, `lint`, `test`, `test:e2e`, `build`, `build:web`, `test:smoke`, `git diff --check`), GitHub Actions 전체(`verify` ubuntu/macos, `prisma-store`, `web smoke`) 통과를 확인했다. Run: https://github.com/coreline-ai/improvement_loop_harness/actions/runs/27389500328

---

## 0. 총평

**커널(MVP-0~1)은 명세와 사실상 완전 정합이며 품질이 높다.** 특히 e2e는 명세 요구 이상이다 — fixture 16종을 컴파일 타임에 강제(`length !== 16` throw)하고, **모든 fixture를 2회 실행해 signature 비교(재현성 검증 내장)**하며, worktree 잔존·report 스키마·skipped 정합까지 단언한다. decision 12규칙, guardrails 7종 기본값, git 방어 플래그, SIGINT graceful cancel 모두 명세대로 구현·테스트되었다.

다만 **"테스트 그린"과 "가동 가능" 사이의 간극이 서버 계층에 있다.** 가장 큰 빠진 부분은 G1 하나로 요약된다: **검증 커널과 서버를 잇는 production 조립이 없다.** 라우트·스토어·스케줄러·가드레일 로직과 계약 테스트는 전부 있으나, 실제로 `runKernel`을 호출해 DB에 영속하는 runner 구현체와 서버 기동 진입점이 존재하지 않는다.

## 1. 재현 검증 결과 (2026-06-12 실행)

| 항목 | 결과 |
|---|---|
| `pnpm typecheck` / `pnpm lint` | 통과 / 통과 |
| `pnpm test` (unit) | 13파일 106테스트 전부 통과 |
| `pnpm test:e2e` (fixture 16종) | 16/16 통과, 14.4s |
| e2e 재현성 | fixture별 2회 실행 signature 동일 (테스트에 내장) |
| decision 12규칙 ↔ EVAL_ENGINE_SPEC §8 | 순서·조건·reason code 완전 일치, 순수 함수 확인 |
| guardrails 기본값 ↔ AUTONOMOUS_LOOP_SPEC §6 | 20/필수/2/5/5/50 전부 일치 |
| prisma/schema.prisma ↔ DB_SCHEMA.md | 16개 모델 완전 일치 (구현 중 OrchestratorState·OrchestratorEvent를 스펙에 정당 추가) |
| CLI: input 고정 기록·exit codes·retry 4모드·SIGINT cancel | 구현 + 테스트 확인 |

## 2. 높음 — 빠진 부분

### G1. 서버 production 조립 부재 (커널 ↔ 서버 미연결)

증거 (직접 추적):

- `runKernel`이 **apps/ 전체에서 import되지 않는다** (검색 0건). 서버의 `LoopRunner`는 주입 가능한 인터페이스([queue.ts](../apps/server/src/queue.ts), [scheduler.ts](../apps/server/src/orchestrator/scheduler.ts) `LOOP_RUNNER_REQUIRED`)까지만 존재하고, 커널을 호출하는 구현체가 없다.
- `apps/server`에 **기동 진입점이 없다**: `listen(` 호출 0건, package.json scripts는 build/typecheck/test뿐 (start 없음). `src/index.ts`는 barrel export.
- `store.createReport` 호출처가 **app.test.ts(테스트 시드)뿐** — 실운영에서 `GET /loops/:id/reports`와 웹 report 화면은 항상 빈 데이터가 된다.
- `GateRun`·`AgentRun`·`WorkspaceRun` 모델은 **어떤 코드도 쓰지 않는 dead schema**다. DB_SCHEMA §3의 설계 이유("GateRun을 분리해야 UI에서 gate별 상태 조회")가 구현에서 실현되지 않았다.

평가: 서버 17개 테스트는 memory store + mock runner로 계약을 검증하므로 그린이지만, dev plan Phase 13 태스크 "in-process 큐로 **runLoop 실행**"의 실질(커널 실행 연결)은 미충족이다. MVP-2~4는 "계약+로직" 완성, "조립+기동" 미완 상태다.

권고 (반영 시):

1. `apps/server/src/main.ts` 신설 — env로 PrismaStore/MemoryStore 선택, **runKernel 기반 LoopRunner 조립**, `buildApp(...)` + `listen`, package.json `start` 스크립트.
2. runner가 커널 산출물(eval-report.json, gate-report.json, manifest)을 읽어 `EvalReport`·`GateRun`·`Artifact` rows로 영속. `AgentRun`·`WorkspaceRun`도 기록하거나, 기록하지 않기로 결정하면 스키마·DB_SCHEMA.md에서 제거(둘 중 하나 — dead schema 방치 금지).
3. 조립 경로의 통합 테스트 1건: 실제 runKernel(mock agent)로 loop 생성 → reports/gate rows 영속 → 웹 API로 조회.

## 3. 중간

### G2. PrismaStore 자동 테스트 0건

app.test.ts 17건은 전부 MemoryStore 경유. PrismaStore(약 430줄)는 마이그레이션 3개가 있으나 **어떤 테스트도 거치지 않는다.** 두 스토어의 미세한 동작 차이(정렬·동시성)가 무검증. 권고: Store 인터페이스 계약 테스트 스위트를 작성해 두 구현에 동일 적용 (docker-compose postgres 기반, CI에서는 서비스 컨테이너).

### G3. `POST /api/loops/:loopId/evaluate` 미구현 — 스펙 드리프트

API_SPEC §6의 evaluate 엔드포인트가 없다 (reports/artifacts GET은 [artifacts.ts](../apps/server/src/routes/artifacts.ts)에 구현됨). in-process queue 설계로 대체된 것으로 보이며 보안상 더 나은 선택이다. 권고: 라우트를 만들지 말고 **API_SPEC §6을 개정** — "MVP는 in-process runner로 실행하며 외부 evaluate 라우트를 제공하지 않는다"로 명문화.

### G4. Playwright smoke가 어떤 자동 게이트에도 연결되지 않음

`apps/web` `test:smoke` 스크립트와 설정은 있으나 root 스크립트·CI 어디에도 연결되어 있지 않다. dev plan Phase 14 "smoke 통과" 체크의 재현 경로가 없다. 권고: root `test:smoke` 연결 + CI 도입 시 포함.

### G5. LoopEvent seq 발급 경쟁 (prisma-store)

[prisma-store.ts](../apps/server/src/prisma-store.ts)의 `addLoopEvent`가 `count() → create(seq: count+1)` 패턴 — 동시 호출 시 같은 seq 계산 가능. 현재는 단일 프로세스 직렬 체인이라 사실상 안전하고 `@@unique([loopRunId, seq])`가 최후 방어지만, 충돌 시 사용자에겐 500이 된다. 권고: 트랜잭션 내 `max(seq)+1` 또는 unique 충돌 재시도.

### G6. CI 워크플로 부재

`.github/workflows` 없음. "전 스위트 그린"이 로컬에서만 보증된다. 잔여 과제로 인지되어 있으나(dev plan), MVP-0 완료를 선언한 시점에는 ubuntu+macos 매트릭스 CI(typecheck/lint/test/e2e) 도입을 권고.

## 4. 낮음 (문서·정리)

| ID | 내용 | 권고 |
|---|---|---|
| L1 | Approval.status에 `requested_more_tests` 값 사용 — 어떤 스펙에도 Approval 상태 enum이 없음 | DB_SCHEMA에 상태 값 명문화 |
| L2 | 구현이 명세보다 강한 부분 미반영: protected 기본값에 `SECURITY.md`, `GIT_PAGER/EDITOR/SEQUENCE_EDITOR/TERMINAL_PROMPT` 강제, untracked 라인 수 측정 | SECURITY_MODEL·EVAL 스펙에 역반영 |
| L3 | baseline 게이트 선택이 이름 휴리스틱(`includes('test')`)이라 hard 게이트도 포함(비용) + 캐시 적중 시 `generated_at` 갱신 의미 모호 | 타입 기반 선택으로 정리, 캐시 의미 주석 |
| L4 | test-integrity가 substring 매칭(보수적 — 오탐 가능, 누락 없음) | EVAL 스펙에 매칭 의미론 한 줄 |
| L5 | dev plan Phase 12 "실제 Codex CLI 1회 수동 검증" 체크 — 검증 기록 artifact가 없어 재현 불가 주장 | 수동 검증은 기록(log/스크린샷 ref)을 남기는 규칙 추가 |

## 5. 검토 중 기각한 의심 (기록)

- "approval에서 rejected/needs_more_tests 전이 시 finishedAt 설정이 모순" — **기각**: LOOP_STATE_MACHINE §2에서 두 상태 모두 terminal이 맞고, needs_human_review → 두 상태 전이는 §3에 정의된 정상 경로다 ([approvals.ts](../apps/server/src/routes/approvals.ts) 검증).
- "reports 라우트 누락" — **기각**: artifacts.ts에 §6의 GET 2종이 구현되어 있다.
- 가드·워크스페이스·자율 루프 영역은 기능 결함 0건 (문서화 수준 지적만 — L2에 통합).

## 6. 권고 반영 순서

1. **G1** — main.ts 조립 + runKernel runner + 영속 배선 (+ dead schema 결정). 이것이 끝나야 "구현 완료"가 "가동 가능"이 된다.
2. **G2** — Store 계약 테스트를 PrismaStore에 적용 (G1의 영속 코드도 함께 검증됨).
3. **G3·L1·L2·L4** — 스펙 개정 일괄 (코드 변경 없음).
4. **G5** — seq 발급 원자화.
5. **G4·G6** — smoke 연결 + CI 도입.
6. **L3·L5** — 정리.
