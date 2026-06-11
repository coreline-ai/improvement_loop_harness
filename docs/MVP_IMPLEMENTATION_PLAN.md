# MVP_IMPLEMENTATION_PLAN.md

## 1. 최종 권고

MVP는 웹앱이 아니라 **CLI 검증 커널**에서 시작한다. 검증 커널이 하나의 candidate patch를 안전하게 판정할 수 있어야 웹 UI와 PR 자동화를 얹을 수 있다.

## 2. MVP-0: CLI Verification Kernel

### 산출물

```text
bin/vibeloop
packages/task-protocol/
packages/workspace-runner/
packages/eval-engine/
packages/guards/
packages/artifacts/
schemas/task.schema.json
schemas/eval.schema.json
schemas/eval-report.schema.json
```

### 명령 예시

```bash
vibeloop run   --repo /path/to/repo   --task tasks/auth-invalid-login-401/task.yaml   --eval eval.yaml   --agent "codex exec ..."   --out "$HOME/.vibeloop"
```

### 완료 조건

- task/eval schema validation 통과
- git worktree 생성 (repo 밖 데이터 디렉터리 + 의존성 프로비저닝)
- baseline capture 동작 (base_commit 단위 캐시 포함)
- agent command 실행 또는 mock 실행
- git metadata integrity guard 동작 (실행 전후 .git 해시 비교)
- candidate.patch 생성 (base_commit 대비, untracked/rename/symlink 포함)
- robust diff/test/protected/limits guards 실행 (builtin, 프로젝트 명령보다 선행)
- test-on-base evidence 검증 동작 (fail on base → pass on candidate)
- eval-report.json 생성 (guard 실패 경로 포함 모든 경로에서)
- decision이 first-match-wins 우선순위 표로 deterministic하게 산출

## 3. MVP-1: Single Agent Local Loop

### 산출물

- Codex CLI adapter 1개
- cancellation/retry basic support
- artifact retention
- static HTML report generator

### 완료 조건

- 실제 local repo에서 low-risk test patch를 accept
- scope escape fixture를 reject
- test weakening fixture를 reject
- protected path fixture를 reject
- auth risk fixture를 needs_human_review

## 4. MVP-2: Web Report Viewer

### 산출물

- Project 목록
- LoopRun 목록
- GateRun 상태
- eval-report viewer
- artifact log viewer
- approval queue read/write

웹은 실행을 “보여주는” 단계부터 시작한다. 웹에서 agent 실행 버튼을 넣기 전 CLI runner가 안정화되어야 한다.

## 5. MVP-3: GitHub Draft PR

### 산출물

- branch 생성
- commit 생성
- draft PR 생성
- PR body에 eval-report summary 첨부

PR 생성 조건:

```text
accepted -> 가능
approved -> 가능
needs_human_review -> 불가
rejected/failed/cancelled -> 불가
```

## 6. MVP-4: Autonomous Improvement Loop

### 산출물

- Improvement Discovery (테스트/typecheck/lint/security scan 수집기 + fingerprint dedup)
- candidate → task.yaml 자동 생성기 (deterministic, 최소 write_scope)
- Loop Orchestrator (순차 1개, supervised/auto 모드, latest base 갱신)
- Safety guardrails (kill switch, 일일 루프/토큰 예산, 재시도 한도, 연속 실패 차단기, PR 상한)
- Candidate/Orchestrator API + 승인 화면

### 완료 조건

- 발견 → 승인 → 루프 → draft PR → 다음 candidate가 무인으로 반복
- 동일 문제 중복 발견 0 (fingerprint), dismissed 재제안 0
- kill switch가 실행 중 루프를 graceful cancel하고 즉시 정지
- 가드레일 각각이 발동 조건에서 정지/차단 동작

상세 명세: [AUTONOMOUS_LOOP_SPEC.md](./AUTONOMOUS_LOOP_SPEC.md)

## 7. 테스트 Fixture

최소 fixture:

| fixture | 기대 decision |
|---|---|
| low-risk regression test added | accept |
| changes outside write_scope | reject |
| modifies eval.yaml | reject 또는 needs_human_review(meta-eval) |
| adds test.skip | reject |
| deletes assertion | reject |
| auth logic touched | needs_human_review |
| no changed files | reject |
| changes code without evidence | needs_more_tests 또는 reject |
| untracked 신규 파일이 scope 밖 | reject |
| scope 밖을 가리키는 symlink 생성 | reject |
| `.git/hooks`·`.git/config` 변조 | reject (GUARD_GIT_META_TAMPER) |
| 에이전트가 자체 commit 생성 후 종료 | diff 정상 추출 (변경 누락 없음) |
| allowed 경로 파일을 risk 경로명으로 rename | risk 재분류 → needs_human_review |
| base에서도 통과하는 테스트만 추가 | evidence missing → needs_more_tests/reject |
| limits 초과 (대량 변경) | reject |
| 게이트 timeout | status=error + required면 reject |

## 8. 구현 순서 체크리스트

- [ ] `task.schema.json` 확정
- [ ] `eval.schema.json` 확정
- [ ] `eval-report.schema.json` 확정
- [ ] task validator 구현
- [ ] git worktree runner 구현 (repo 밖 데이터 디렉터리)
- [ ] 의존성 프로비저닝(lockfile hash 캐시) 구현
- [ ] artifact layout writer 구현 (sha256 checksum 포함)
- [ ] git metadata integrity guard 구현
- [ ] diff scope guard 구현 (base_commit 대비 + untracked/rename/symlink/mode)
- [ ] test integrity guard 구현
- [ ] protected file guard 구현
- [ ] limits guard 구현
- [ ] baseline capture + 캐시 구현
- [ ] test-on-base evidence 검증 구현
- [ ] evidence detector 구현 (present/missing/inconclusive)
- [ ] eval.yaml runner 구현 (가드 선행 + fail-fast)
- [ ] decision engine 구현 (우선순위 표 + reason code)
- [ ] fixture 기반 e2e test 작성
- [ ] static report generator 작성
- [ ] 단일 agent adapter 연결 (LLM localhost proxy 경유)

## 9. 개발 중 금지사항

```text
- 웹 UI부터 구현 금지
- DB CRUD부터 구현 금지
- eval.sh 하드코딩 유지 금지
- agent에게 eval-report.json 직접 작성시키기 금지
- secret을 agent env에 전달 금지
- protected path를 allowed path로 override 금지
- 가드 통과 전 프로젝트 명령 게이트 실행 금지
- 가드를 대상 repo 스크립트로 위임 금지 (하네스 내장)
- worktree/artifact를 대상 repo 내부에 배치 금지
```
