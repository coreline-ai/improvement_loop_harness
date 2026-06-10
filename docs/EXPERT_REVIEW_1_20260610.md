# 전문가 검토 1차 — VibeLoop Harness 설계 문서 (2026-06-10)

검토 범위: `docs/` 분리 명세 10종 + `autonomous_coding_improvement_loop_harness_FULL.md` + `schemas/*.schema.json` 3종 (총 4,291줄 전수 검토).

> 반영 상태: 2026-06-10 — 본 검토의 전 항목을 각 명세 문서와 스키마에 반영 완료.
검토 관점: (1) 문서 간 정합성, (2) 보안 경계의 실제 시행 가능성, (3) 구현 착수 가능성(스펙 공백).

---

## 0. 총평

**설계 방향은 옳다.** "웹 UI보다 검증 커널 먼저", "AI는 개선자이지 심판이 아니다", "LLM critic은 advisory only", "deterministic decision engine", "artifact 기반 증거 바인딩" — 이 다섯 가지 축은 이 도메인에서 실패하는 프로젝트들이 놓치는 지점을 정확히 잡았다. 분리 명세 + JSON Schema를 source of truth로 두고 FULL 문서를 보존용으로 격리한 문서 체계도 건강하다.

다만 **구현 착수 전 반드시 해결해야 할 Critical 5건**이 있다. 요약하면:

1. 제품의 핵심 차별점인 **개선 증거(improvement evidence) 측정 메커니즘이 스펙에 없다** (baseline 캡처 단계, fail-on-base 검증 부재).
2. **가드와 eval 게이트의 실행 순서/중단 규칙이 미정의**라서, 현재 스펙대로면 scope 위반 패치의 코드도 `npm test`로 실행될 수 있다.
3. **git worktree가 메인 repo의 `.git`을 공유**하는 구조적 사각지대(훅/설정 변조)가 threat model에 빠져 있다.
4. DB 스키마가 **컴파일되지 않는다** (`LoopEvent` 모델 누락).
5. 상태 머신에 **terminal 정의 모순**이 있다.

이 5건은 모두 문서 수준에서 해결 가능하며, 해결 후에는 MVP-0 착수에 무리가 없다.

---

## 1. 잘 설계된 부분 (유지할 것)

| 항목 | 평가 |
|---|---|
| 검증 커널 우선, CLI-first | UI/DB부터 만들다 죽는 전형적 실패 경로를 명시적으로 금지([MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md) §8). 올바른 우선순위 |
| 역할 분리 + critic advisory-only | LLM sycophancy를 구조적으로 차단. 최종 판정은 deterministic engine만 |
| protected > forbidden > allowed 우선순위 | write_scope 충돌 해석이 명확([TASK_PROTOCOL.md](./TASK_PROTOCOL.md) §3) |
| retry = 새 loop_id + artifact 불변 | 사실상 event-sourcing. 포렌식/재현성에 유리 |
| evidence가 artifact 경로를 참조해야 한다는 계약 | "증거 없는 주장"을 스키마 수준에서 차단([ARTIFACT_SCHEMA.md](./ARTIFACT_SCHEMA.md) §7) |
| 적대적 fixture 기반 e2e 계획 | 게이트 시스템의 테스트 전략으로 정석 |
| `needs_more_tests`를 reject와 구분 | 판정의 해상도를 높이는 좋은 설계 |

---

## 2. Critical — 구현 착수 전 반드시 해결

### C1. 가드/게이트 실행 순서와 fail-fast 규칙 미정의 → 신뢰 경계 붕괴

**위치**: [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §2, §7

**문제**: eval 게이트의 `npm run typecheck`, `npm test`는 **에이전트가 방금 수정한 코드를 하네스 권한으로 실행하는 행위**다. 그런데 스펙은:

- 게이트 실행 순서를 "runner가 결정한다"고만 하고 규칙이 없다.
- required gate 실패 시 "즉시 reject 후보 **표시**"라고만 되어 있어, 이후 게이트를 계속 실행하는지 중단하는지 모호하다.

현재 문장대로 구현하면 diff scope 위반(예: `package.json` 변조)이 탐지된 뒤에도 `npm test`가 실행되어 변조된 스크립트가 동작할 수 있다.

**권고**:
1. 규범 추가: **`scope`/`integrity`/`protected` 타입 게이트는 모든 프로젝트 명령 실행형 게이트보다 먼저 실행되어야 하며, 이 중 하나라도 실패하면 이후 프로젝트 명령 게이트는 실행하지 않고 `skipped`로 기록한다** (eval-report의 `skipped` status가 이 의미를 가지도록 정의).
2. SECURITY_MODEL에 신뢰 경계를 명시: *"MVP에서 게이트 명령 실행은 하네스 사용자 권한의 임의 코드 실행과 동등하다. MVP는 대상 repo를 신뢰 가능한 것으로 가정하며, 신뢰할 수 없는 기여자가 있는 repo에는 컨테이너 격리(MVP 이후) 전까지 사용을 금지한다."*

### C2. worktree의 공유 `.git` 변조 경로가 threat model에 없음

**위치**: [SECURITY_MODEL.md](./SECURITY_MODEL.md) §1, §2

**문제**: `git worktree add .worktrees/<loop-id>`로 만든 worktree는 메인 repo의 `.git`(객체 저장소, **hooks, config**)을 공유한다. 에이전트 프로세스는 OS 샌드박스가 없는 MVP에서 파일시스템 상 `../../.git/hooks/`나 공유 `config`에 자유롭게 쓸 수 있고, 이는:

- `git diff`/untracked 스캔에 **전혀 잡히지 않는다** (.git은 추적 대상이 아님).
- `core.fsmonitor`, `core.pager`, `filter.*.smudge`, hook 설치 → **이후 하네스가 해당 repo에서 git 명령을 실행하는 순간 하네스 측에서 코드 실행**.

threat model 표의 "symlink/path traversal", "untracked file 우회"는 있지만 이 벡터가 빠져 있다.

**권고**:
1. **git metadata integrity guard 신설**: 에이전트 실행 전 `.git/config` + `.git/hooks/` + `.git/worktrees/<id>/` 의 해시 스냅샷을 찍고, 실행 후 변경 시 해당 loop를 security violation으로 즉시 reject.
2. 하네스가 worktree에서 실행하는 모든 git 명령에 방어 플래그 사용: `git -c core.hooksPath=/dev/null -c core.fsmonitor= ...` + `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`.
3. M9(아래)와 함께: `.worktrees/`, `.runs/`를 대상 repo 밖 하네스 데이터 디렉터리로 이동.

### C3. 개선 증거 측정 메커니즘 부재 — 제품 핵심 약속의 구멍

**위치**: [ARCHITECTURE.md](./ARCHITECTURE.md) §3, [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md), [ARTIFACT_SCHEMA.md](./ARTIFACT_SCHEMA.md) §2

**문제**: 이 제품의 존재 이유는 "테스트 통과 ≠ 개선, 증거가 있어야 개선"이다. 그런데:

- `metrics/baseline.json`이 artifact 레이아웃에 존재하지만 **baseline을 언제 누가 측정하는지** 커널 실행 흐름(11단계)에 없다. coverage 증가·p95 개선 같은 evidence는 동일 환경 baseline 없이는 판정 불가능하다.
- `adds_regression_test` evidence를 인정하려면 **"새 테스트가 base에서는 실패하고 candidate에서는 통과한다"**(SWE-bench의 FAIL_TO_PASS, FULL 문서 §3.6에서 흡수한다고 명시한 바로 그 패턴)를 검증해야 하는데, 이 단계가 커널 흐름에 없다. 없으면 "base에서도 통과하는 무의미한 테스트 추가"로 게이밍 가능하다.
- evidence 타입별 판정 주체/방법(detector)이 어디에도 정의되어 있지 않다.

**권고**:
1. 커널 실행 흐름에 2단계 추가: **(3.5) baseline capture** — 에이전트 실행 전 clean worktree에서 측정형 게이트 실행 결과를 `metrics/baseline.json`으로 고정. **(6.5) test-on-base 검증** — candidate patch에서 테스트 파일만 분리해 base에 적용 후 실행, "fail on base → pass on candidate"를 확인.
2. EVAL_ENGINE_SPEC에 **evidence detector 표** 신설: evidence 타입별 판정 알고리즘·입력 artifact·실패 시 상태(`missing`/`inconclusive`)를 정의.
3. baseline 비용 절감 정책(같은 base_commit에 대한 project 단위 baseline 캐시)을 명시.

### C4. DB 스키마 컴파일 불가 — `LoopEvent` 모델 누락

**위치**: [DB_SCHEMA.md](./DB_SCHEMA.md) §2

**문제**: `LoopRun.events LoopEvent[]` 관계가 선언되어 있으나 **`LoopEvent` 모델 정의가 없다**. 이대로는 Prisma 스키마가 컴파일되지 않는다 (FULL 문서 §15.1의 구버전 초안에는 존재 — 분리 과정에서 누락된 것으로 보임).

또한 [API_SPEC.md](./API_SPEC.md) §8의 `Last-Event-ID` 재전송 계약은 **loop 내 전체 순서가 보장되는 영속 이벤트**를 요구하는데, cuid는 정렬 순서를 보장하지 않는다.

**권고**: `LoopEvent` 모델 복원 + loop 단위 단조 증가 `seq` 컬럼(`@@unique([loopRunId, seq])`) 추가. SSE event id는 `seq` 기반으로 발급.

### C5. 상태 머신 terminal 모순 + guard 단락 경로의 원칙 위반

**위치**: [LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) §2, §3

**문제** 3건:
1. `accepted`는 `terminal: yes`인데 `accepted -> pr_created` 전이가 존재한다. terminal 상태는 정의상 outgoing 전이가 없어야 한다.
2. `needs_more_tests`는 `terminal: no`인데 **outgoing 전이가 하나도 정의되어 있지 않다** (retry는 새 loop를 만들므로 이 loop의 전이가 아니다).
3. `guards_running -> rejected`, `eval_running -> rejected` 단락 전이는 decision engine을 우회한다. 이는 PRODUCT_SPEC 성공 기준("모든 patch는 eval-report.json 없이는 PR 생성 불가")과 FULL §19("모든 후보는 eval-report.json을 남긴다")의 전제인 **"모든 run은 decision engine을 거쳐 report를 남긴다"**와 충돌한다 — guard 실패 run의 report 생성 주체가 사라진다.

**권고**:
1. **PR 라이프사이클을 루프 상태 머신에서 분리**: `pr_created`를 루프 상태에서 제거하고 `PullRequest` 엔티티의 자체 status로 추적 (DB 스키마는 이미 그렇게 되어 있다). 그러면 `accepted`/`approved`/`rejected`/`needs_more_tests`가 모두 깔끔한 terminal decision 상태가 된다. `needs_human_review`만 non-terminal로 남아 `approved | rejected | needs_more_tests`로 전이.
2. guard/eval 실패 시에도 `decision_ready`로 수렴시키고 decision engine이 reject + eval-report를 산출하도록 전이 수정: `guards_running -> eval_running | decision_ready`, `eval_running -> critic_running | decision_ready`.

---

## 3. High — 설계 확정 필요 (구현 중 발견하면 비용이 큰 것들)

### H1. Credential broker가 CLI 에이전트 현실과 모순

[SECURITY_MODEL.md](./SECURITY_MODEL.md) §3은 `ANTHROPIC_API_KEY` 등을 agent env에서 금지하고 "credential broker가 tool call 단위로 주입"한다고 하는데, Codex CLI/Claude Code는 **프로세스 수준에서 인증이 필요**하므로 "tool call 단위 주입"은 실현 메커니즘이 없다. **권고**: MVP 현실적 대안을 명시 — (a) **localhost LLM reverse proxy** (agent에는 `OPENAI_BASE_URL=http://127.0.0.1:<port>`만 주고 프록시가 실제 키를 부착; 토큰 사용량 계측·로그 redaction 부수 효과) 또는 (b) MVP 한정 scoped key passthrough 허용 + 위험 명시. (a) 권장.

### H2. 가드 구현 위치 이중성 — repo 스크립트 vs 하네스 내장

[EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §7 예시는 `python scripts/check-diff-scope.py`(대상 repo 파일)를 게이트로 실행하고, [MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md)는 `packages/guards/`(하네스 내장)를 산출물로 정의한다. 둘은 양립 불가다. repo 스크립트 방식은 (1) 대상 repo에 python 의존성 강제, (2) 가드 자체가 변조 대상(보호 경로로 막더라도 가드의 버전 관리가 repo별로 파편화), (3) 하네스 업그레이드로 가드를 일괄 개선 불가라는 문제가 있다. **권고**: 가드는 하네스 내장으로 확정하고, eval.yaml에서 `command: builtin:diff_scope` 형태로 참조 (현 name 패턴 `^[a-z0-9_:-]+$`이 이미 `:`를 허용). repo 스크립트는 예시에서 제거.

### H3. risk area 재분류 규칙 설정이 어디에도 없음

[TASK_PROTOCOL.md](./TASK_PROTOCOL.md) §4 "risk area는 harness가 path/rule 기반으로 재분류한다"가 핵심 통제인데, **path→risk_area 매핑을 정의할 설정 위치가 없다** (eval.schema.json에 해당 필드 부재). 임의 repo에서 "auth 변경 → needs_human_review"를 판정할 방법이 없다. **권고**: eval.yaml에 `risk_classification: { auth: [src/auth/, ...], database_schema: [prisma/, ...] }` 섹션 신설 + 스키마 반영. 매핑이 없는 변경은 `unknown`으로 보수적 처리(needs_human_review) 권장.

### H4. worktree 의존성 프로비저닝 미정의

fresh worktree에는 `node_modules`가 없다. `npm test` 게이트는 의존성 설치 없이 실행 불가능하고, 매 loop `npm ci`는 수 분의 고정 비용이며, 메인 repo `node_modules` 공유(symlink/hardlink)는 에이전트의 공유 저장소 오염 경로가 된다. [SECURITY_MODEL.md](./SECURITY_MODEL.md) §4의 "package install은 별도 승인 또는 cached dependency"는 정책이지 메커니즘이 아니다. **권고**: `workspace_preparing` 단계에 의존성 프로비저닝 정책을 명시 — lockfile 해시 키 기반 캐시에서 복사(또는 pnpm content-addressable store의 read-only 링크), 에이전트 실행 전 설치 완료, 에이전트의 추가 설치는 네트워크 정책으로 차단.

### H5. Idempotency 충돌(409) 판정 근거 부재

[LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) §6은 "다른 payload + 같은 key → 409"를 요구하지만, DB에는 `@@unique([taskId, idempotencyKey])`만 있고 **요청 payload를 비교할 저장 필드가 없다**. **권고**: `LoopRun.requestHash`(정규화된 요청 본문 SHA-256) 추가, 같은 key 재요청 시 hash 비교로 replay/conflict 구분.

### H6. candidate diff 추출 규범 미정의

분리 명세 어디에도 "diff를 무엇 대비로 어떻게 뜨는가"가 규범으로 없다 (FULL의 구버전 스크립트는 `git diff HEAD`인데, 에이전트가 commit을 만들면 HEAD가 이동해 **변경이 통째로 누락**된다). **권고**: EVAL_ENGINE_SPEC 또는 신규 PATCH_MANAGER 절에 규범 명시 — diff는 항상 기록된 `base_commit` 대비(`git diff <base_commit>`), untracked는 `git status --porcelain=v2 -z`로 수집, rename/copy/mode change(symlink=120000) 포함, binary 변경 별도 표기. `changed-files.json`의 `untracked_files/renames/symlinks` 필드를 채우는 절차로 연결.

### H7. 네트워크 정책이 MVP에서 시행 불가능한 선언

컨테이너/netns 없는 MVP에서 "외부 network off 또는 allowlist"를 시행할 OS 메커니즘이 없다. **권고**: MVP 한정으로 "네트워크 차단은 보장되지 않는 신뢰 가정"임을 명시하고(C1의 신뢰 경계 문장과 통합), 실제 차단은 컨테이너 격리 도입 시점(MVP 이후)의 인수 조건으로 이관.

### H8. API 인증/인가 부재

[API_SPEC.md](./API_SPEC.md)에 authn/authz 절이 없다. approval API(승인 권한자), `evaluate` 내부 제한("내부 worker만 호출")의 시행 방법, artifact 경로 서빙(`GET /artifacts/*path`)의 path traversal 방어가 모두 미정의다. **권고**: MVP 수준이라도 "단일 사용자 토큰 + artifact root 밖 realpath 접근 거부" 한 절 추가.

---

## 4. Medium — 문서/스키마 보강

| ID | 위치 | 문제 | 권고 |
|---|---|---|---|
| M1 | [../schemas/eval.schema.json](../schemas/eval.schema.json) | `forbidden_patterns`(test integrity 설정), `risk_classification`(H3), `limits`, baseline 정책 등 가드 설정을 담을 자리가 없음 | 스키마 확장. 가드 내장화(H2)와 함께 가드 설정은 eval.yaml로 일원화 |
| M2 | [LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) §4 | `retry_eval_only`가 `failed`에서만 허용. flaky 테스트로 required gate가 실패하면 `rejected`가 되는데, 이때 eval-only 재실행이 불가능해 에이전트 전체 재실행(비결정적·고비용)만 가능 | `retry_eval_only` 허용 상태에 `rejected` 추가 |
| M3 | task.schema vs eval.schema | `human_approval_required`가 task에서는 boolean, eval에서는 array(risk area 목록) — 동명이의 | eval 쪽을 `human_approval_risk_areas`로 개명 |
| M4 | [../schemas/task.schema.json](../schemas/task.schema.json) | `risk_area` enum이 위험도(`low`, `unknown`)와 도메인(`auth`, `ui`)을 한 축에 혼합. 단일값인데 eval-report의 `risk.areas`는 배열 | 도메인 enum + 별도 `risk_level`로 분리하거나, 최소한 배열화하여 report와 정합 |
| M5 | [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §7 | `${TASK_FILE}`, `${BASE_COMMIT}` 보간의 정의(사용 가능 변수 목록, 치환 주체, 이스케이프)가 없음 | 사용 가능 변수 표 + "runner가 exec 전 치환, shell 미경유" 명시 |
| M6 | eval-report schema | `skipped` status의 발생 조건 미정의 | C1의 fail-fast 규칙과 연결해 정의 |
| M7 | LOOP_STATE_MACHINE | PR 라이프사이클 분리 | C5 권고 1과 동일 (중복 기재) |
| M8 | task/eval schema | agent 실행 timeout, max changed files/lines(="작은 패치" 원칙의 수치 강제), artifact 디스크 상한 부재 | `limits:` 블록 신설 (예: `max_changed_lines: 500`, `agent_timeout_seconds: 1800`) |
| M9 | [SECURITY_MODEL.md](./SECURITY_MODEL.md) §2, [ARTIFACT_SCHEMA.md](./ARTIFACT_SCHEMA.md) | `.worktrees/`, `.runs/`가 대상 repo 내부에 위치 — 에이전트의 artifact 변조 가능(같은 파일시스템 경계), git status 오염 | 하네스 데이터 디렉터리(예: `~/.vibeloop/projects/<id>/`)로 이동. C2와 세트 |
| M10 | [ARCHITECTURE.md](./ARCHITECTURE.md) §3 | critic이 커널 9단계로 고정인데 eval.yaml에 `advisory` gate 타입이 별도 존재 — 동일 개념 이중화 | critic을 advisory gate의 한 구현으로 통합(설정으로 on/off·비용 통제 가능해짐) |
| M11 | [LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) §8 | "DB transition 이후 발행"은 commit과 publish 사이 유실 가능 | MVP 단일 프로세스면 한계 명시만, 이후 outbox 패턴 예고 |
| M12 | [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §5 | "no improvement evidence → reject **or** needs_more_tests" 등 분기 모호. decision 결정성을 주장하려면 규칙 우선순위가 필요 | first-match-wins 우선순위 표로 재서술 + `decision_reasons`를 자유문이 아닌 reason code enum으로 구조화 |

---

## 5. Low

- **L1**: FULL 문서의 eval.yaml/eval-report 예시(§10.2, §11.1)는 현행 스키마와 비호환 구조다. 보존용임은 명시되어 있으나, 해당 섹션 상단에 "스키마 비호환 — schemas/ 참조" 배너 한 줄씩 추가 권장.
- **L2**: [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §1의 eval.sh wrapper가 `$LOOP_ID`를 참조 — 수동 실행 시 미설정. 기본값 처리 명시.
- **L3**: retention 만료 삭제 잡(DB row + 디스크), redaction 수행 주체(하네스 후처리)가 미지정.
- **L4**: [ARTIFACT_SCHEMA.md](./ARTIFACT_SCHEMA.md) §6 "checksum을 추가**할 수 있다**" → 변조 탐지가 목적이므로 terminal run에는 필수로 격상 권장.
- **L5**: eval-report.schema에서 `improvement_evidence`가 required가 아님 — decision의 핵심 입력이므로 required(빈 배열 허용)로 격상 권장.

---

## 6. Fixture 추가 권고 ([MVP_IMPLEMENTATION_PLAN.md](./MVP_IMPLEMENTATION_PLAN.md) §6 보강)

기존 8종에 더해, 이번 검토에서 드러난 공격 경로를 커버하는 fixture:

| fixture | 기대 결과 | 근거 |
|---|---|---|
| untracked 신규 파일이 scope 밖 | reject | H6 |
| scope 밖을 가리키는 symlink 생성 | reject | threat model 기존 항목의 검증 |
| `.git/hooks`·`.git/config` 변조 | reject (security violation) | C2 |
| 에이전트가 자체 commit 생성 후 종료 | diff 정상 추출 (누락 없음) | H6 |
| allowed 경로 파일을 risk 경로명으로 rename | risk 재분류 동작 | H3 |
| base에서도 통과하는 테스트만 추가 | evidence `missing` → needs_more_tests/reject | C3 |
| diff 크기 상한 초과 (대량 변경) | reject | M8 |
| 게이트 timeout 발생 | `error` status + 후속 처리 | 운영 경로 |

---

## 7. 권고 반영 순서

문서 수정만으로 해결 가능하며, 아래 순서를 권장한다 (선행 의존 관계 반영):

1. **C5 + M7**: 상태 머신 정리 (PR 분리, terminal 정합, decision_ready 수렴) — 이후 모든 문서가 참조하는 기반
2. **C1 + H7**: 게이트 실행 순서·fail-fast 규범 + MVP 신뢰 경계 선언 (SECURITY_MODEL/EVAL_ENGINE_SPEC)
3. **C2 + M9**: git metadata integrity guard 신설 + `.runs`/`.worktrees` 외부화
4. **C3**: baseline capture / test-on-base 단계 + evidence detector 표 (ARCHITECTURE 흐름 + EVAL_ENGINE_SPEC)
5. **C4**: LoopEvent 모델 복원 + seq 설계 (DB_SCHEMA)
6. **H1~H6, H8**: credential proxy 결정, 가드 내장화 확정, risk_classification·limits 스키마 확장, diff 추출 규범, idempotency requestHash, API auth 한 절
7. **M/L 일괄** + fixture 목록 보강 (§6)

이 1차 검토 반영 후, 스키마 3종의 최종 확정(우선 개발 순서 1번)과 MVP-0 착수가 가능하다.
