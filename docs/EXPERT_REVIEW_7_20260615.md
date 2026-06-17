# 전문가 검토 7차 — 전 코드베이스·문서 심층 감사 + 개발 예정 항목 정리 (2026-06-15)

검토 대상: 전체 모노레포(12 packages + 2 apps, ~20k LOC TS) 코드 + docs/ 30문서 + dev-plan/ 19문서.
검토 방법: 영역별(검증 커널 / 격리·보안 / SDK·신뢰바닥 / 컨트롤플레인·영속화·UI / 문서·계획) 병렬 코드 정독 + 헤드라인 발견의 직접 file:line 재검증.
검토 성격: 6차에서 5차 사이클이 종결됐으므로, **종결 이후 새로 들어온 작업(frozen rule semantic runner)** 과 **이전 사이클이 다루지 못한 전 영역 횡단(cross-cutting) 결함**에 집중한 신규 감사.

> 과장 금지 원칙 유지: 모든 발견은 file:line 근거를 동반한다. 1~6차에서 이미 반영·관리된 항목은 중복 지적하지 않고 "[기존]"으로만 참조한다.

> 반영 계획: 본 검토의 발견은 [dev-plan/implement_20260615_090058.md](../dev-plan/implement_20260615_090058.md)(7차 검토 반영: 신뢰 경계 횡단 보강, Phase 1~7)로 구현 계획화됨. A-1 Frozen Rule Semantic Runner는 별도 [implement_20260615_064636.md](../dev-plan/implement_20260615_064636.md).

> 반영 진행(2026-06-15): P2 owner(`implement_20260615_090058.md`)에서 Phase 1과 Phase 3~5는 구현·로컬 검증까지 진행됐고, Phase 2/6/7도 코드·문서 보강이 반영됐다. 단 `TEST_DATABASE_URL`/Postgres 실행환경 부재로 PrismaStore 실제 DB contract leg는 미실행이며, discovery cap 초과 log/report와 Phase별 커밋 규율은 잔여다. 현재 release gate 상태는 [RELEASE_GATE_MATRIX.md](./RELEASE_GATE_MATRIX.md)가 단일 source다.

---

## 0. 총평

**코드의 결정적 골격(deterministic skeleton)은 설계 의도대로 견고하다.** Arbiter 점수·동점·정렬은 완전 결정적이고, accepted 아닌 후보가 선택될 경로나 advisory가 correctness를 바꾸는 경로는 발견되지 않았으며, auto-merge는 코드 전체에 부재하고 draft는 하드코딩으로 강제된다. git hook/credential 차단, env scrub, 워크트리 외부 강제, 컨테이너 명령의 env-전달(인젝션 방지) 같은 방어 원시(primitive)도 정교하다.

**그러나 신뢰 경계의 "기본값"과 "봉인 시점"에 구조적 약점이 반복적으로 나타난다.** 다섯 영역의 독립 감사가 동일한 4개 횡단 테마로 수렴했다: ① 명세된 보안 계약보다 약한 **fail-open 기본값**, ② 신뢰 바닥(B1~B4)의 **시간적·운영적 봉인 구멍**, ③ MemoryStore↔PrismaStore **계약 분기로 프로덕션에서 보안 게이트가 조용히 무력화**, ④ 결정 엔진 **신뢰 경계의 미세 약점**(규칙 순서·식별·보간). 이들은 개별 버그가 아니라 "검증 커널이 모델 대신 판정한다"는 제품 핵심 가치를 부분적으로 약화시키는 지점들이다.

**자가개선 루프는 아직 닫히지 않았다.** 최신 미구현 계획(`implement_20260615_064636.md`)의 Frozen Rule Semantic Runner(Phase 1~5, 전부 미착수)가 "학습 강제" 고리의 마지막 조각이며, 이는 여전히 열려 있는 R1 컨테이너 격리에 결정적으로 의존한다. Prisma `Learning`/`SkillVersion` 모델은 존재하나 어디에도 연결되지 않은 dead schema다.

발견 집계: **High 11 / Med 18 / Low 13** (+ 문서 드리프트 5).

---

## 1. 핵심 발견 — 횡단 테마 (전문가 분석의 핵심)

### 테마 1. Fail-open 기본값이 명세된 보안 계약보다 약하다 ⚠️ 최우선

README·SECURITY_MODEL은 "미신뢰 LLM 코드는 **R1 컨테이너(network none)에서만** 실행", "hidden 수용 테스트·토큰·시크릿이 stdout/report/PR에 새지 않게 스캔·차단"을 계약으로 선언한다. 그러나 실제 기본 동작은 다음과 같이 더 약하다:

- **R1 격리는 opt-in이며 미설정 시 호스트 실행** — `gate-executor.ts:63` `const isolated = execution?.isolation === 'container'`. `execution`이 없으면 에이전트가 수정한 코드(=임의 코드)가 **호스트에서, 전체 `process.env`로** 실행된다(`gate-executor.ts:114` else 분기). M2/M4(`adversary-execution.ts`, `rulepack-replay.ts`)는 런타임 부재 시 skip(fail-closed)인데 이 핵심 게이트 경로만 비대칭으로 fail-open이다. **계약과 기본 동작의 정면 충돌.**
- **artifact-leak 스캔/redaction도 opt-in** — `redact_gate_logs`(`gate-executor.ts:66`)와 `scan_patch`가 명시 설정 시에만 동작. 미설정 프로젝트는 시크릿 누설 방어가 baseline으로 깔리지 않는다.
- **아티팩트 redaction 기본값이 passthrough** — `redaction.ts:27` `passthroughRedactor`가 기본. Buffer 콘텐츠·manifest 문자열 필드(`task_id`/`base_commit`/`path`)는 redact 경로를 아예 거치지 않는다.
- **빈 게이트 목록이 가장 느슨한 accept 경로** — `gates: []`면 가드/required gate 검사가 전부 매칭 실패하고, scope 내·protected 아님·required_evidence 없으면 곧장 ALL_PASS accept(`decision/engine.ts`).
- **의존성 install이 호스트 시크릿 + postinstall 실행** — `deps.ts:111-115`가 `env ?? process.env`로 `npm ci`/`pnpm install`을 호스트에서 실행. 미신뢰 패키지의 postinstall 스크립트가 호스트 시크릿에 접근.

**근본 권고**: 미신뢰 후보 코드를 실행하는 게이트는 isolation 미설정 시 **fail-closed**(게이트 error)로 전환하거나 명시적 `isolation: none` opt-out을 요구. install 단계도 `scrubEnv`+`--ignore-scripts` 기본화. redaction/leak baseline을 always-on으로.

### 테마 2. 신뢰 바닥(Trust Floor)의 시간적·운영적 봉인 구멍

B1~B4의 *논리*는 견고하나 *봉인 시점*과 *운영 표면*에 구멍이 있다:

- **B3 TOCTOU** [High] — provenance/patch-hash 재확인은 `verifySelectedCandidate` 한 곳(`improvement-loop.ts:318-319`)에서만 일어난다. 이후 promotion이 `selectedPatch` **경로**만 받아(`promotion.ts:132`, `branch.ts:100`) PR push 시점에 파일을 **다시 읽어 `git apply`** 하는데, 그 직전 **재해시가 없다**. final verification ~ PR push 사이(orchestrate에서 길어짐)에 패치 파일 변조 창이 존재.
- **`--skip-final-reverify`가 B2를 조용히 무력화** [High] — `improvement-loop.ts:325-329`: provenance만 통과하면 `fv.passed=true`로 즉시 리턴, 프레시 워크트리 재적용+게이트 재실행이 통째로 생략. 게다가 B3는 같은 diff에서 만든 report 해시 ↔ 같은 diff에서 만든 patch 해시 비교라 **탐퍼탐지일 뿐**, 파일을 안 건드리면 항상 통과. 즉 이 플래그를 켜면 PR 후보화가 **독립 재현 없이 탐퍼탐지만으로** 성립하는데 **경고 한 줄 없다**.
- **B4 비용 상한이 실측 비용을 보장하지 못함** [Med] — `candidateCounter`(`improvement-loop.ts:667`)는 빌더 후보만 센다. B2 reverify 커널과 후보별 test-on-base가 띄우는 추가 베이스 워크트리는 미집계(예: 24후보+24 test-on-base+1 reverify=49 워크트리). `--deadline`은 SDK엔 있으나 **CLI에 미노출**.
- **위험 플래그 무경고** [Med] — `--allow-dirty`, `--skip-final-reverify` 둘 다 사용 시 stderr 경고 없음.

### 테마 3. MemoryStore ↔ PrismaStore 계약 분기 → 프로덕션 보안 게이트 무력화 ⚠️

이 발견은 **프로덕션(Postgres)에서만 발현**하므로 fixture/메모리 테스트가 못 잡는다는 점에서 특히 위험하다:

- **PrismaStore.createCandidate가 `trustLevel`/`injectionIndicators`/`reproCommand`를 조용히 누락** [High] — `prisma-store.ts:210-225`의 create data에 이 세 필드가 없다(반면 `updateCandidate`는 `:237-239`에서 처리). 라우트는 명시적으로 전달하는데(`routes/candidates.ts:28-30`) DB엔 스키마 기본값 `trustLevel='medium'`, `injectionIndicators=null`로 강제 저장된다. **결과: discovery가 prompt-injection 지표를 탐지한 후보라도 Postgres에선 indicator가 사라지고 trustLevel이 항상 medium**이 되어, 오케스트레이터의 인젝션-후보 auto-pickup 차단(`scheduler.ts:78-85`)이 무력화된다. 계약 테스트(`store-contract.test.ts:147-166`)는 trustLevel을 round-trip 검증하지 않아 이 분기를 놓친다.
- **fingerprint 중복 throw 형태 불일치** [High] — MemoryStore는 사전검사 plain Error, PrismaStore는 P2002 raw 전파(createCandidate에 핸들링 없음). 동시 요청 race 시 PrismaStore는 미처리 500.
- **활성 루프 단일성 / iteration race** [Med] — `routes/loops.ts:48-62` check-then-act 비트랜잭션, `nextLoopIteration`(`prisma-store.ts:361-364`) aggregate+1 비원자. 멀티 인스턴스에서 중복 루프/iteration.
- **멀티 인스턴스 오케스트레이터 후보 중복 픽업** [Med] — 동시성 제어가 in-process `active` Map(`scheduler.ts:326-327`)에만 의존, DB 락 없음.

**근본 권고**: PrismaStore.createCandidate에 세 필드 추가 + 계약 테스트에 trustLevel/injectionIndicators round-trip 강제. active-loop는 부분 unique 인덱스, iteration/후보 선택은 `FOR UPDATE`.

### 테마 4. 결정 엔진 신뢰 경계의 미세 약점

"15 rules first-match-wins, LLM 투표 없음, 증거 기반"의 *구현 디테일*에 약점:

- **provenance 검증이 가드보다 늦은 rank** [High] — `provenanceVerified===false`(rank 9)가 git-meta/scope/test-integrity/artifact-leak/limits 가드(rank 2~8)보다 뒤. 이 가드들은 모두 gate 결과·changedFiles에 의존하는데, provenance가 실패하면 그 입력 자체를 신뢰할 수 없다. 즉 "신뢰 불가 입력"으로 먼저 판정한 뒤에야 무결성을 본다. first-match에서 변조 artifact가 rank 2~8 중 하나를 우연히 통과/실패시키면 rank 9에 도달조차 못 한다.
- **`gateMatches` 자유텍스트 부분문자열 식별** [High] — `engine.ts:49-54`가 `name+command`에 `'limits'`/`'artifact-leak'` 부분 포함만으로 가드를 식별. 프로젝트 게이트 `npm run check-rate-limits`가 fail하면 `GUARD_LIMIT_EXCEEDED`로 오분류 → 감사 추적·메타평가 분기 오도. builtin은 `builtin:` 접두로 구조적 식별이 가능한데 자유텍스트에 의존.
- **명령 보간 후 `shell:true` 실행** [High] — `interpolate.ts`가 placeholder를 셸 이스케이프 없이 치환하고 `exec.ts:138`이 `shell:true`로 실행. `LOOP_ID`/데이터 디렉터리 경로 등에 셸 메타문자(`;`,`$(...)`,백틱)가 들어가면 검증 커널이 임의 명령 실행. 화이트리스트는 변수 *이름*만 막고 *값*은 미검증.
- **증거 fallback이 인과를 우회** [Med] — `fixes-reproduced-failure.ts:31-48`: test-on-base 부재 시 "동명 게이트가 candidate에서 pass"만으로 "고쳤다" 인정. 게이트 자체 무력화나 flaky-green도 통과. test-integrity 통과를 확인하지 않음.

---

## 2. 문제점 상세 (영역별 · 심각도순)

### 2.1 검증 커널 (eval-engine)

| 심각도 | 위치 | 문제 | 권고 |
| --- | --- | --- | --- |
| High | `decision/engine.ts:233` | provenance(rank 9)가 가드(rank 2~8)보다 늦음 — 변조 증거로 가드 우회 가능 | provenance를 rank 2 직후 또는 진입 직후 fail-closed 분리 |
| High | `decision/engine.ts:49-54` | `gateMatches` 부분문자열로 가드 reason 오분류 | `gate.type==='integrity'` + `builtin:<name>` 정확 매칭 |
| High | `interpolate.ts` + `exec.ts:138` | 보간 값 셸 미이스케이프 + `shell:true` → 임의 명령 실행 표면 | 값 메타문자 거부 또는 `shell:false`+argv |
| Med | `fixes-reproduced-failure.ts:31-48` | 증거 fallback이 인과 미검증(false pass) | test-integrity 조건 추가, 부재 시 inconclusive 강등 |
| Med | `decision/engine.ts:81-86`, `evidence.ts:78` | required_evidence 빈 배열이면 증거 검사 전면 우회 | 정책상 최소 증거 강제 옵션 |
| Med | `test-on-base.ts:58-67`, `baseline.ts:169` | test-on-base/baseline이 호스트·네트워크 의존(격리 미적용) | isolation=container 시 격리 실행 |
| Med | `baseline.ts:64-72` | 캐시 키에 toolchain/env fingerprint 부재 → stale baseline 재사용 | lockfile/toolchain 해시 포함 |
| Med | `gate-executor.ts:75-113` | 컨테이너 게이트가 런타임 가용성 미검증(M2/M4와 비대칭) | `isContainerRuntimeAvailable()` 명시 확인 |
| Low | `decision/engine.ts:45-47` | 비-required 게이트의 error가 결정에 미반영 | error를 신뢰 신호로 별도 집계 |
| Low | `gate-report.ts:10` | 게이트 이름 sanitize 충돌로 로그 덮어쓰기 | 이름 유일성 검증/해시 파일명 |
| Low | `run.ts:1113`, `test-on-base.ts:61` | test-on-base에 타임아웃 미전파 → 행 가능 | 기본 타임아웃 전파 |

테스트 공백: provenance↔가드 우선순위 충돌, gateMatches 오분류, interpolate 셸 주입, 빈 게이트/빈 증거 accept 경로, 비-required error 처리 — 모두 미검증.

### 2.2 격리·보안 계층 (workspace-runner / guards / agent-adapters / shared)

| 심각도 | 위치 | 문제 | 권고 |
| --- | --- | --- | --- |
| High | `gate-executor.ts:63` | R1 격리 opt-in → 미설정 시 호스트에서 미신뢰 코드 실행 (테마 1) | fail-closed 전환 |
| High | `oauth-proxy.ts:416-417` | error 메시지가 redaction 없이 logs에 push (server.ts 방어선 밖) | 모든 logs/error를 `redactProxyLog` 통과 |
| Med | `deps.ts:111-115` | install이 전체 env + postinstall 호스트 실행 | scrubEnv + `--ignore-scripts` 기본화 |
| Med | `deps.ts:143-160` | 의존성 캐시 후보 간 공유 → 캐시 오염 | read-only 마운트 / 무결성 검증 |
| Med | `improvement-loop.ts:619-629` | dirty 가드가 `--base-commit` 시 스킵 + timeout 미전달 | base 방식 무관 검사, timeout 부여 |
| Med | `gate-executor.ts:99-108` 등 | 컨테이너 마운트 rw — 미신뢰 코드가 워크트리 변조 | replay는 readonly, 메트릭만 rw |
| Med | `exec-isolated.ts:90-100` | 컨테이너 root 실행, cap-drop/메모리/pids 한도 없음 | `--user`,`--cap-drop=ALL`,`no-new-privileges`,리소스 한도 |
| Med | `path-match.ts:1-29` | 경로 정규화에서 `..`/대소문자/심링크 미처리 → 보호 경로 우회 | `path.posix.normalize` + case-insensitive |
| Low | `artifact-leak.ts:42-44` | 공백 포함 시크릿 값 일부만 마스킹 | 값 캡처를 라인 끝까지 확장 |
| Low | `test-integrity.ts:29-37` | 어설션 "삭제"만 탐지, 약화(skip/주석/항상참) 미탐 | `.skip/.only/xit` 기본 suspicious |
| Low | `promotion.ts:132` | 승격 시 패치 scope 재검증 없이 apply | 승격 직전 scope 재검증/`--include` |
| Low | `exec.ts:200-221` | timeout 미지정 시 SIGKILL escalation·force-resolve 미등록 → 행 가능 | timeout 미지정에도 상한 강제 |

양호: `safeGit`의 hook/credential/전역config 차단, `scrubEnv` 이중방어, `assertWorktreeOutsideRepo`, 컨테이너 명령 env-전달(인젝션 방지), placeholder bearer — 견고.

### 2.3 SDK · 신뢰 바닥 · CLI · discovery · github-integration

| 심각도 | 위치 | 문제 | 권고 |
| --- | --- | --- | --- |
| High | `promotion.ts:121-148`, `branch.ts:98-102` | B3 TOCTOU — PR push 직전 재해시 없음 (테마 2) | promotion에 expectedPatchHash 전달, apply 직전 재해시 |
| High | `improvement-loop.ts:325-329` | `--skip-final-reverify`가 B2 무력화 + 무경고 (테마 2) | 경고 강제, PR 본문에 reverified=false 표기, draft-pr 경로 금지 |
| High | `branch.ts` ↔ `pull-request.ts:248` | PR 생성 실패 시 push된 브랜치 롤백 없음 → orphan 누적 | 실패 시 브랜치 삭제 |
| High | `discovery/task-gen.ts:143-145` | reproCommand 없으면 acceptance 없는 task 생성(trivially passable) | reproCommand 없으면 task 거부 |
| High | `discovery/task-gen.ts:71-91` | fallback write_scope가 광범위 + forbidden 미설정 → scope 봉쇄 붕괴 | scope 상한·protected 제외·forbidden 항상 생성 |
| Med | `improvement-loop.ts:646-656` | B4 상한이 reverify/test-on-base 미집계 (테마 2) | 카운터에 포함 |
| Med | CLI improve/orchestrate | `--deadline` 미노출, 위험 플래그 무경고 | 플래그 노출 + 경고 |
| Med | `orchestrate.ts:819`, `task-gen.ts:129` | stacked PR 브랜치명이 task.id(48bit)에만 의존 → 교차 이슈 충돌·덮어쓰기 | 브랜치명에 issue index/candidateId 포함 |
| Med | `promotion.ts:185-251` | promotion 패키지에 leak 재스캔 부재(skip-reverify와 결합 시 위험) | 승격 직전 leak 재스캔 |
| Med | `discovery/fingerprint.ts:7` | fingerprint가 file+test+errorCode만 → 같은 파일 다른 문제 collapse | rule id/메시지/라인 포함 |
| Med | `collectors/index.ts:318-343` | 발견 후보 하드 캡 50, 초과분 무기록 폐기 | 폐기 log, critical 우선 |
| Low | `improvement-loop.ts:744-749` | 동점 정의에 Q5 누락 → 더 나은 Q5 후보가 advisory 임의선택에 맡겨짐 | 동점에 Q5 포함 |
| Low | `pull-request.ts:228-246` | 재사용 PR이 여전히 draft인지 미확인 | draft 상태 확인 |
| Low | `orchestrate.ts:862-884` | 부분 실패가 failed로 표면화 안 됨(하나라도 성공 시 exit 0) | 에러+PR0건이면 failed |

양호: Arbiter 결정성, accepted-only 선택, auto-merge 전무, draft 하드코딩, 종료코드 일관성 — 견고. (auto-merge 부재를 보증하는 회귀 테스트만 추가 권고.)

### 2.4 컨트롤플레인 · 영속화 · UI (server / prisma / artifacts / report-html / web)

| 심각도 | 위치 | 문제 | 권고 |
| --- | --- | --- | --- |
| High | `auth.ts:17` | Bearer 토큰 비상수 시간 비교(timing attack) | `crypto.timingSafeEqual` |
| High | `auth.ts:20` | 단일 공유 토큰·정적 `reviewerId='mvp-user'` — 인가 부재·책임추적 불가 | per-actor 토큰/식별, 프로젝트 스코프 |
| High | `prisma-store.ts:210-225` | createCandidate가 trustLevel/injectionIndicators/reproCommand 누락 → 프로덕션 인젝션 게이트 무력화 (테마 3) | 필드 추가 + 계약 테스트 강화 |
| High | `artifacts/layout.ts:16-18` | run 경로 조립 시 id 미검증 → path traversal | id allowlist + containment 검증 |
| High | `artifacts/manifest.ts:46-58` | manifest 무서명 + verify가 디스크 재워킹 안 함 → 위변조/추가파일 미탐 | manifest HMAC/서명, verify 시 재워킹 |
| High | `artifacts/writer.ts:154`, `redaction.ts:27` | redaction이 Buffer/manifest 미적용 + 기본 passthrough (테마 1) | always-on redactor, Buffer/manifest 포함 |
| High | `artifacts/retention.ts:67-90` | GC가 status/lock 미검사 → 실행 중 run 삭제 가능 | delete 직전 status≠running 재확인, 원자적 write |
| Med | `app.ts:29-30` | CORS/helmet/rate-limit 전무 | 보안 미들웨어 등록 |
| Med | `routes/loops.ts:48-62` | 활성 루프 check-then-act race (테마 3) | 부분 unique 인덱스/트랜잭션 |
| Med | `scheduler.ts:149,325` | 멀티 인스턴스 후보 중복 픽업 (테마 3) | DB 비관락 |
| Med | `report-html/template.ts:40` | `<title>`에 escape 없이 agent 문자열 삽입 → XSS | `escapeHtml(title)` |
| Med | `artifacts/redaction.ts:7,15` | 패턴이 bearer/aws/ghp_/JWT/PEM 등 누락 | 형식 기반 탐지 추가 |
| Med | `web/.../events/route.ts:16` | 업스트림 에러 본문 그대로 브라우저 중계 | 에러 봉투 정규화 |
| Med | `prisma/schema.prisma` | FK 컬럼 단독 인덱스 다수 누락 → 풀스캔 | `@@index` 추가 |
| Low | `memory-store.ts:165` | updateCandidate 전체 머지(화이트리스트 불일치) | 명시 필드만 |
| Low | `render.ts:51-57` | href 스킴 allowlist 부재 | 상대/file 허용 allowlist |

양호: 아티팩트 다운로드 라우트 realpath+isInside 방어, 웹 토큰 서버 전용(클라 미노출), escapeHtml 본문 일관 적용, 마이그레이션↔스키마 정합 — 견고.

---

## 3. 개발 예정 항목 마스터 리스트

상태: **미착수** / **계획수립**(dev-plan 있음·코드 0) / **부분구현**(substrate 있음·핵심 미배선).

### P0 — 자가개선 루프의 닫힘 고리 (가장 시급)

**A-1. Frozen Rule Semantic Runner / Adversary Semantic Gate** — `dev-plan/implement_20260615_064636.md` 전체, **전부 미착수**. 코드 대조로 공백 확인: `rulepack-runner.ts` 부재, `RulepackRule={id,hash}`만(`rulepack-shadow.ts:19`, RuleSpec 없음), `builtin:rulepack-semantic` 0건, `FrozenRulepack`이 실행 spec 미포함. 이것이 §17 로드맵 **M4 EXECUTION**의 실구현물이다.

| Phase | 내용 | 의존성 |
| --- | --- | --- |
| P1 | content-addressed RuleSpec + freeze 확장(lock_hash가 실행 내용 덮음) | 없음(데이터 계약 토대) |
| P2 | Frozen Rule Semantic Runner — R1 격리 실행, 규칙별 결정론 verdict | P1 + **A-2(R1)** + replay substrate |
| P3 | `builtin:rulepack-semantic` 게이트 + eval 스키마 + decision reason | P2 |
| P4 | 다음-루프 적용 배선(loop N→N+1) + e2e(학습 강제 실증) | P3 |
| P5 | 안전 불변식·provenance·CLI(`rulepack inspect`)·문서 | P1~P4 |

**A-2. R1 컨테이너/네트워크 격리 OS 강제 + M2 adversary 실제 실행** — **부분구현**. M2 confirm substrate·CLI는 존재(`adversary-execution.ts`), OS 강제 격리는 미완. [기존] 1·5·6차 carry-forward. **A-1의 하드 전제이자 테마 1의 근본 해소책** — 우선순위를 A-1과 동급으로 끌어올려야 함.

### P1 — 자율 모드 완성 + 학습 자산화

- **A-3. 사용자 지정 문제 모드** — 자연어 프롬프트에서 repo-specific **hidden/policy/adversary eval 자동 추론·생성**. `implement_20260614_193356.md` Phase2(미체크), README "eval 자동 생성". 현재 minimal visible eval만 생성(부분구현).
- **A-4. 자동 발견 모드** — 광범위 M4 semantic corpus 자동생성. `…193356.md` Phase3(미체크). substrate만 존재(부분구현).
- **A-5. 토큰 budget** — provider 토큰 회계. `…193356.md` Phase8 #5, AUTONOMOUS_LOOP_SPEC §6. count/time cap만 존재(미착수). README "남은 작업".
- **A-6. 학습/메모리 자산 계층** — `loop_engineering_notes.md` Appendix A·B: 테스트 자동확장(N1), Failure Analyzer + cross-loop 실패 원장(N2), 품질 수렴 종료조건(N3), Same-Issue Refinement(N5), LLM critic/evaluator runner(R2)[기존], learnings/SKILL 자동반영(R6). **Prisma `Learning`/`SkillVersion`이 dead schema** — 연결 미구현. 제품 비전의 핵심.

### P2 — 보강 / carry-forward

- **A-7. 6차 carry-forward** [기존] — `vibeloop init` 템플릿 생성기(CLI에 `init` 없음 확인), hidden-test 보안 저장소(R3), O1(`removeWorktree` rm 폴백 후 `git worktree prune` 미호출).
- **A-8. artifact-leak always-on redact-only baseline** — 부분구현(opt-in만). `input/eval.yaml` 원본 미스캔(`artifact-leak.ts`는 stdout/stderr/patch만). **테마 1과 직결**.
- **본 7차 신규 발견 즉시 조치 항목** — 테마 1~4의 High 11건은 신규 작업으로 등재 필요. 특히 **R1 fail-closed화 / PrismaStore 필드 보존 / B3 재해시 / 토큰 상수비교**는 dev-plan 한 사이클로 묶을 가치가 있음.

### P3 — 인프라/제품 구조 (MVP 이후)

- **A-9. 제품 모듈 분리** — `@vibeloop/core`/`contracts`/`skill` 패키지. `MODULARIZATION…STRATEGY.md` §3(계획수립).
- **A-10. 인프라 deferred** — 다중 프로세스 transactional outbox, RBAC, repro_command 실행 설계, CI artifact 자동수집, 발견소스 확장(CI로그/이슈트래커/에러모니터링 R8).

---

## 4. 문서↔코드 드리프트

| 심각도 | 위치 | 드리프트 | 권고 |
| --- | --- | --- | --- |
| 중 | `SELF_IMPROVEMENT_LOOP_DESIGN.md` §8 | `ALL_PASS`를 "rank-14"로 명시 — 코드/스펙은 rank 15(rank 14는 VERIFIER_MISMATCH) | "rank-15"로 정정, "14규칙" 약칭→"15규칙" |
| 중 | `skills/vibeloop-harness/SKILL.md:36` | eval 안전 플래그가 improve 경로에도 전달된다는 서술 — 실제론 orchestrate만(`improve.ts`에 `--eval-*` 0개) | "auto_discovery/orchestrate 경로 한정"으로 정정 |
| 낮 | `…DESIGN.md` §17 | M2/M4 상태가 신규 confirm/freeze substrate를 과소표현("필터/안전핵만") | "필터+격리 confirm+freeze substrate 구현, semantic runner만 미구현"으로 갱신 |
| 낮 | `implement_20260613_194055.md`/`…214944.md` | 완료 작업의 본문 체크박스 미틱 → grep 잔여집계 오탐 | 헤더에 "본문 박스는 요약 기준 완료" 주석 |
| 낮 | `MVP_IMPLEMENTATION_PLAN.md:134-153` | 체크리스트 13개 전부 `[ ]`이나 전부 구현됨 | "MVP-0 완료(3차 확인), historical" 주석 |

**과장 표현 점검 결과 양호**: README(R3/R5 PASS는 Run Ledger 근거 명시 + 자기제약), SKILL.md(semantic gate "future work" 정확 고지) 모두 증거 없는 PASS/프로덕션급 주장 없음. 6차 "근거 동반 표기" 규율 유지 [기존].

---

## 5. 권고 우선순위 (실행 로드맵)

> 갱신 주석(2026-06-17): 아래 순서는 외부 리뷰의 Critical(API agent_spec host 실행)·P0(live UAT 환경 복구)·token budget 기본 정책화가 닫히기 **이전** 작성분이다. 현재 canonical 실행 순서는 [RELEASE_GATE_MATRIX](./RELEASE_GATE_MATRIX.md)(P0~P5)다 — 아래는 7차 테마 우선순위 참고용이며, agent_spec 차단선(매트릭스 P1)이 fail-open 차단(매트릭스 P2)보다 앞선다.

1. **[즉시·1 사이클] 테마 1·3의 High fail-open/분기 차단** — ① R1 isolation fail-closed화(`gate-executor.ts:63`), ② PrismaStore.createCandidate 필드 보존 + 계약 테스트(`prisma-store.ts:210`), ③ 토큰 `timingSafeEqual`(`auth.ts:17`), ④ artifact redaction always-on + manifest 서명. **제품 핵심 가치(검증 커널 신뢰)에 직접 영향.**
2. **[즉시·동일 사이클] 테마 2 신뢰 바닥 봉인** — B3 promotion 재해시, `--skip-final-reverify` 경고+draft-pr 금지, B4 카운터 보정, 위험 플래그 경고.
3. **[단기] 테마 4 결정 엔진 강화** — provenance rank 상향, gateMatches 구조적 식별, interpolate 값 sanitize, 증거 fallback 강화. + 누락 테스트 추가.
4. **[중기] A-2(R1 OS 격리) → A-1(Frozen Rule Semantic Runner)** — 격리가 선행돼야 semantic runner가 안전하게 닫힌다. 자가개선 루프 "학습 강제" 고리 완성.
5. **[중기] discovery 자동생성 안전화** — task-gen 빈 acceptance/광범위 scope/fingerprint collapse(A-3·A-4 선결).
6. **[장기] A-5 토큰 budget, A-6 학습 자산 계층(dead schema 연결), A-9 모듈 분리.**

---

## 6. 종합 결론

VibeLoop Harness는 "판정을 모델에서 떼어내 결정론 커널로 옮긴다"는 핵심 가치를 **논리 수준에서는 성공적으로 구현**했고, 1~6차 검토 사이클을 거치며 설계↔구현↔테스트↔CI 정합과 신뢰 경계 표기 규율을 높은 수준으로 끌어올렸다. 7차 감사가 새로 드러낸 것은 *논리의 결함*이 아니라 **"기본값·봉인 시점·저장소 분기"라는 운영 표면의 약점들** — fail-open 디폴트, 신뢰 바닥의 시간적 구멍, 프로덕션 전용 보안 게이트 무력화, 결정 엔진의 미세한 신뢰 경계 — 이며, 이들이 결합하면 "검증 커널이 보증한다"는 약속이 특정 설정·경로에서 조용히 약화될 수 있다. 다행히 대부분이 **국소적·고신뢰 수정**(기본값 전환, 필드 추가, 재해시, 상수비교)으로 해소 가능하고, 그 다음에야 비로소 자가개선 루프의 마지막 고리(A-1 Frozen Rule Semantic Runner, A-2 R1 격리 위에서)를 신뢰 가능하게 닫을 수 있다.
