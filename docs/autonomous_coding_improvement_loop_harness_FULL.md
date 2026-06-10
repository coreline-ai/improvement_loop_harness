# 자율 코딩 개선 루프형 AI 개발 하네스 전문가 개발 문서

> 목적: 지금까지 논의한 내용을 빠짐없이 통합해, 실제 개발자가 구현을 시작할 수 있는 수준의 제품 정의서/기술 설계서/검수 규칙서/스킬 설계서로 정리한다.  
> 핵심 방향: 단순한 “AI 코딩 자동화”가 아니라, **AI가 개선 후보를 발견하고, 작은 패치를 만들고, 검수·적대적 평가·회귀 평가·사람 승인을 통과한 개선만 살아남는 자율 코딩 개선 루프**를 만든다.

> 분리 업데이트: 이 통합 문서는 원본/전체 맥락 보존용이다. 실제 구현 기준은 `docs/README.md`에서 시작하는 분리 명세와 `schemas/*.schema.json`을 우선 source of truth로 사용한다.

---

## 1. 핵심 개념 정리

### 1.1 AI 코딩 자동화와 자율 코딩 개선 루프의 차이

```text
AI 코딩 자동화
= 사용자가 지시한다
→ AI가 코드를 작성한다
→ 테스트를 실행한다
→ 결과를 제출한다
```

```text
자율 코딩 개선 루프
= 시스템이 현재 상태를 관찰한다
→ 개선 후보를 발견한다
→ 개선 가설을 세운다
→ 작은 코드 패치를 만든다
→ 기본 검수를 통과시킨다
→ 적대적 검수를 통과시킨다
→ 회귀 검수를 통과시킨다
→ 실제 개선 증거를 남긴다
→ 위험 변경은 사람 승인을 받는다
→ 성공/실패 패턴을 스킬과 규칙에 반영한다
→ 다음 루프에서 더 나은 방식으로 다시 실행한다
```

즉, 핵심은 “AI가 코드를 잘 짜는가?”가 아니라 **“고친 코드가 진짜 개선인지 기계적으로 판정할 수 있는가?”**이다.

---

## 2. 최종 앱 컨셉

### 2.1 제품명 후보

```text
VibeLoop Harness
Autonomous Coding Improvement Harness
Self-Improving Dev Harness
AI Code Improvement Loop
```

### 2.2 한 줄 정의

**Codex, Claude Code, Gemini 같은 AI 코딩 에이전트를 반복 실행하되, 검수 룰·적대적 평가·회귀 테스트·개선 증거·사람 승인 게이트를 통과한 코드 개선만 PR로 만드는 웹 기반 자율 코딩 개선 하네스.**

### 2.3 최종 목표

이 앱은 사용자가 등록한 코드베이스에 대해 다음을 수행한다.

1. 프로젝트 상태 관찰
2. 개선 후보 자동 발견
3. 작업 단위 분해
4. AI 에이전트 실행
5. 코드 패치 생성
6. 빌드/테스트/린트/타입체크 실행
7. 적대적 평가 실행
8. 보안/성능/회귀 검수
9. 테스트 무결성 검사
10. 개선 증거 수집
11. 승인/폐기/사람 검토 판정
12. 성공한 변경은 Draft PR 생성
13. 실패/성공 패턴은 learnings/skills에 반영

---

## 3. 참고 오픈소스와 흡수할 설계 패턴

### 3.1 multi-agent-starter

```text
https://github.com/netwaif/multi-agent-starter
```

성격:

```text
Claude Code / Codex / Gemini를 파일 기반 작업 시스템으로 묶기 위한 멀티 에이전트 스타터.
```

흡수할 부분:

```text
- file-as-memory 구조
- task.md / context.md / log.md
- worker brief.md / result.md
- workers_approved 승인 구조
- target_repo / write_scope 제한
- 재진입 프로토콜
- Producer-Reviewer 구조
- 단일 orchestrator + worker 무통신 원칙
```

우리 앱에서의 역할:

```text
작업 폴더 프로토콜과 승인 게이트의 기반으로 사용한다.
```

---

### 3.2 MAT

```text
https://github.com/netwaif/mat
```

성격:

```text
multi-agent-starter 작업 폴더를 읽기 전용으로 모니터링하는 TUI 도구.
```

흡수할 부분:

```text
- task status 표시
- worker 상태 표시
- result/log 파일 추적
- read-only monitor 원칙
```

우리 앱에서의 역할:

```text
MAT의 TUI를 웹 대시보드로 확장한다.
```

---

### 3.3 Ralph / Open Ralph Wiggum

```text
https://github.com/snarktank/ralph
https://github.com/Th0rgal/open-ralph-wiggum
```

성격:

```text
PRD 또는 작업 목표가 끝날 때까지 AI 코딩 에이전트를 반복 실행하는 루프형 하네스.
```

흡수할 부분:

```text
- 반복 실행 루프
- 각 iteration을 새 컨텍스트에서 시작
- git history / progress.txt / prd.json 기반 메모리
- Claude Code / Codex / Qwen / OpenCode 등 agent rotation
```

우리 앱에서의 역할:

```text
Loop Runner의 실행 모델로 사용한다.
```

---

### 3.4 Evolve Loop

```text
https://github.com/mickeyyaya/evolve-loop
```

성격:

```text
discover → build → audit → eval gate → learn 구조의 self-improving pipeline.
```

흡수할 부분:

```text
- 개선 후보 발견
- 구현
- 감사
- eval gate
- 학습 반영
```

우리 앱에서의 역할:

```text
자율 개선 루프의 기본 프로세스 모델로 사용한다.
```

---

### 3.5 Autoresearch Skill System

```text
https://github.com/Veritas-7/autoresearch-skill-system
```

성격:

```text
Codex-first self-improvement skill harness.
```

흡수할 부분:

```text
- target binding
- evidence archive
- A/B candidate evaluation
- quality audit
- no-op gate
- publish gate
- gitleaks/preflight
- candidate retain/discard
- measurable objective 기반 반복 개선
```

우리 앱에서의 역할:

```text
검수/증거/자가개선 스킬 레이어로 흡수한다.
```

---

### 3.6 SWE-bench

```text
https://github.com/swe-bench/SWE-bench
```

성격:

```text
실제 GitHub 이슈와 실제 코드베이스에서 패치를 적용하고 테스트로 해결 여부를 평가하는 코드 패치 평가 벤치마크.
```

흡수할 부분:

```text
- issue/task → patch → Docker env → patch apply → test → pass/fail
- 패치 단위 검증
- 재현 가능한 테스트 환경
- 회귀 확인
```

우리 앱에서의 역할:

```text
패치 평가 방식의 기본 원형으로 사용한다.
```

---

### 3.7 Terminal-Bench / Harbor

```text
https://github.com/harbor-framework/terminal-bench
https://github.com/harbor-framework/harbor
```

성격:

```text
터미널 작업, 빌드, 설치, 환경 구성, 최종 상태 검증을 평가하는 하네스.
```

흡수할 부분:

```text
- Docker 환경 기반 검수
- 최종 상태 검증
- agent별 동일 기준 비교
- trace/rollout 저장
```

우리 앱에서의 역할:

```text
원격 빌드, 터미널 실행, 실제 프로젝트 환경 평가 구조에 적용한다.
```

---

### 3.8 Agent Skills

```text
https://github.com/addyosmani/agent-skills
```

성격:

```text
AI coding agent에게 senior engineer 수준의 개발 절차와 품질 기준을 따르게 하는 SKILL.md 기반 규칙 시스템.
```

흡수할 부분:

```text
- SKILL.md 표준
- Verification 섹션
- Red Flags
- Common Rationalizations
- evidence requirement
```

우리 앱에서의 역할:

```text
AI가 따라야 하는 개발/검수 스킬 문서 표준으로 사용한다.
```

---

### 3.9 self-improving-agent

```text
https://github.com/BerriAI/self-improving-agent
```

성격:

```text
에이전트가 최소 diff를 제안하고, 사람이 승인하면 Draft PR을 여는 구조.
```

흡수할 부분:

```text
- minimal diff
- human approval
- draft PR
- repo-scoped token
```

우리 앱에서의 역할:

```text
사람 승인 후 PR 생성 구조에 적용한다.
```

---

### 3.10 보안/적대적 평가 도구

활용 후보:

```text
Semgrep
CodeQL
Gitleaks
OpenSSF Scorecard
Stryker
fast-check
Hypothesis
pytest-benchmark
promptfoo
garak
PyRIT
```

용도:

```text
- 정적 분석
- secret scan
- dependency audit
- mutation testing
- property-based testing
- performance regression
- prompt injection
- LLM red team
```

---

## 4. 시스템 전체 아키텍처

### 4.1 개념 아키텍처

```text
사용자
  ↓
웹 대시보드
  ↓
Project Registry
  ↓
Task Manager
  ↓
Loop Orchestrator
  ↓
Agent Runner
  ├─ Codex CLI
  ├─ Claude Code
  ├─ Gemini CLI
  ├─ Qwen Code
  └─ OpenCode
  ↓
Sandbox / Workspace
  ↓
Patch Generator
  ↓
Evaluation Engine
  ├─ Hard Gate
  ├─ Task Acceptance Gate
  ├─ Regression Gate
  ├─ Adversarial Gate
  ├─ Test Integrity Gate
  ├─ Diff Scope Gate
  ├─ Security Gate
  ├─ Performance Gate
  └─ Improvement Evidence Gate
  ↓
Decision Engine
  ├─ accept
  ├─ reject
  ├─ needs_human_review
  └─ needs_more_tests
  ↓
GitHub PR Manager
  ↓
Skill / Learning Manager
```

---

## 5. 핵심 컴포넌트

| 컴포넌트 | 역할 |
|---|---|
| Web Dashboard | 프로젝트, 작업, 루프, 검수 결과를 시각화 |
| Project Registry | GitHub repo, 로컬 경로, eval 설정 관리 |
| Task Manager | 개선 후보와 작업 상태 관리 |
| Loop Orchestrator | Observe → Propose → Patch → Evaluate → Decide → Learn 실행 |
| Agent Adapter | Codex/Claude/Gemini 등 실행 인터페이스 통합 |
| Sandbox Manager | 격리 workspace, Docker, branch 관리 |
| Patch Manager | diff/patch 생성, 적용, rollback |
| Evaluation Engine | eval.yaml 기반 검수 실행 |
| Adversarial Critic | 적대적 코드 리뷰 수행 |
| Evidence Archive | baseline/candidate/eval/adversarial 리포트 저장 |
| Human Approval Queue | 위험 변경 승인 대기열 |
| GitHub PR Manager | branch, commit, draft PR 생성 |
| Skill Manager | SKILL.md, AGENTS.md, learnings.md 관리 |

---

## 6. 루프 단계 상세

### 6.1 Observe

목적:

```text
프로젝트 상태에서 개선 후보를 찾는다.
```

입력:

```text
- CI 실패 로그
- 테스트 실패
- lint/typecheck 실패
- error log
- 성능 지표
- 보안 스캔 결과
- issue 목록
- 사용자 요청
- 이전 loop 실패 기록
```

출력:

```json
{
  "candidates": [
    {
      "id": "cand-auth-401",
      "title": "Invalid login returns 500 instead of 401",
      "evidence": ["auth-invalid-password.test failed"],
      "riskArea": "auth",
      "priority": "high"
    }
  ]
}
```

---

### 6.2 Propose

목적:

```text
개선 후보를 실제 작업 단위로 만든다.
```

출력 파일:

```text
tasks/<task-id>/task.md
tasks/<task-id>/task.yaml
tasks/<task-id>/hypothesis.md
```

task.md 예시:

```markdown
# Task: Invalid login should return 401

## Objective

잘못된 비밀번호로 로그인할 때 500 에러가 아니라 401과 표준 에러 응답을 반환하도록 수정한다.

## Hypothesis

현재 auth service의 password mismatch 예외가 API layer에서 처리되지 않아 500으로 전파되는 것으로 보인다.

## Write Scope

allowed:
- src/features/auth/
- src/app/api/auth/
- tests/auth/

forbidden:
- prisma/migrations/
- src/features/billing/
- src/features/admin/
- .github/
- eval.yaml
- scripts/

## Required Evidence

- 실패 재현 테스트 추가
- invalid password 요청 401 반환
- 정상 로그인 기존 동작 유지
- 세션 쿠키가 실패 응답에 생성되지 않음
```

---

### 6.3 Patch

목적:

```text
AI 에이전트가 허용된 범위 안에서 작은 패치를 만든다.
```

규칙:

```text
- write_scope 안에서만 수정
- 작은 diff 유지
- 테스트 추가 우선
- 평가 파일 수정 금지
- protected path 수정 금지
- 실패 원인을 설명하고 변경
```

---

### 6.4 Evaluate

목적:

```text
기계적 검수 실행
```

기본 명령:

```bash
bash scripts/eval.sh
```

---

### 6.5 Attack

목적:

```text
후보 패치를 공격적으로 의심한다.
```

검토 항목:

```text
- 요구사항 우회
- 테스트 약화
- 평가 스크립트 완화
- 기존 기능 회귀
- 보안 취약점
- 에러 은폐
- 성능 수치 조작
- 변경 범위 과도
- 실제 개선 증거 부재
```

---

### 6.6 Decide

판정:

```text
accept
reject
needs_human_review
needs_more_tests
```

판정 규칙:

```text
Hard Gate 실패 → reject
Test Integrity 실패 → reject
Protected file 변경 → reject
개선 증거 없음 → reject
보안/인증/DB/배포/eval 변경 → needs_human_review
모든 검수 통과 + 위험 변경 아님 → accept
```

---

### 6.7 Learn

목적:

```text
성공/실패 패턴을 다음 루프에 반영한다.
```

저장 위치:

```text
learnings.md
AGENTS.md
skills/<skill-name>/SKILL.md
```

예시:

```markdown
## Learning: Auth error handling

When fixing auth error handling:
- Always add invalid password and nonexistent user tests.
- Never expose password hash or bcrypt details.
- Failed login must not create session cookies.
- Auth changes always require human approval.
```

---

## 7. 평가 Gate 전체 설계

### 7.1 Hard Gate

기본적인 프로젝트 무결성 검수.

```yaml
hard_gates:
  - name: typecheck
    command: npm run typecheck
    required: true

  - name: lint
    command: npm run lint
    required: true

  - name: unit_tests
    command: npm test
    required: true

  - name: contract_tests
    command: npm run test:contract
    required: true

  - name: build
    command: npm run build
    required: true

  - name: smoke_e2e
    command: npm run test:e2e:smoke
    required: true
```

---

### 7.2 Task Acceptance Gate

작업별 성공 조건.

```yaml
task_acceptance:
  required_tests:
    - tests/auth/login-invalid-password.test.ts
    - tests/auth/login-success.test.ts

  required_behavior:
    - invalid_password_returns_401
    - normal_login_still_works
    - failed_login_does_not_create_session
```

---

### 7.3 Regression Gate

기존 기능 회귀 방지.

```yaml
regression_gates:
  - name: public_api_contract
    command: npm run test:contract

  - name: smoke_e2e
    command: npm run test:e2e:smoke

  - name: snapshot_review
    command: npm run test:snapshot
    manual_review_on_diff: true
```

---

### 7.4 Adversarial Gate

AI의 우회/속임수/위험 변경 탐지.

```yaml
adversarial_gates:
  - name: diff_scope
    command: python scripts/check-diff-scope.py
    required: true

  - name: test_integrity
    command: python scripts/check-test-integrity.py
    required: true

  - name: protected_files
    command: python scripts/check-protected-files.py
    required: true

  - name: auth_adversarial
    command: npm run test:adversarial:auth
    required: false

  - name: api_abuse
    command: npm run test:adversarial:api
    required: false

  - name: prompt_injection
    command: npm run test:adversarial:prompt
    required: false
```

---

### 7.5 Test Integrity Gate

금지 패턴:

```text
test.skip
describe.skip
it.skip
it.only
describe.only
.todo(
@ts-ignore
eslint-disable
expect(true).toBe(true)
expect(1).toBe(1)
snapshot 대량 갱신
timeout 과도 증가
```

---

### 7.6 Diff Scope Gate

작업별 허용 범위 밖 수정 금지.

```yaml
write_scope:
  allowed:
    - src/features/auth/
    - tests/auth/

  forbidden:
    - prisma/migrations/
    - .github/
    - eval.yaml
    - scripts/
    - .env
    - .env.local
```

---

### 7.7 Security Gate

```yaml
security_gates:
  - name: secret_scan
    command: gitleaks detect --source . --no-git
    required: true

  - name: dependency_audit
    command: npm audit --audit-level=high
    required: true

  - name: semgrep
    command: semgrep scan --config auto .
    required: false
```

---

### 7.8 Performance Gate

```yaml
performance_gates:
  - name: api_latency
    command: npm run bench:api
    required: false
    max_regression_percent: 5

  - name: page_load
    command: npm run lighthouse:ci
    required: false
    max_regression_percent: 5

  - name: bundle_size
    command: npm run analyze:bundle
    required: false
    max_regression_percent: 5
```

---

### 7.9 Improvement Evidence Gate

인정되는 개선 증거:

```text
- 실패하던 테스트가 통과함
- 신규 회귀 테스트가 추가됨
- 커버리지 증가
- 성능 지표 개선
- 보안 스캔 결과 개선
- 에러 로그 감소
- 중복 코드 감소
- 접근성 점수 개선
- 사용자가 지정한 이슈 해결
```

거부되는 약한 개선:

```text
- 주석만 추가
- 포맷팅만 변경
- 파일명만 변경
- 테스트 없이 로직 변경
- 문서만 바꾸고 코드 문제 미해결
- 실제 변경 없는 no-op
```

---

### 7.10 Human Approval Gate

자동 accept 금지 영역:

```yaml
human_approval_required:
  - auth
  - permission
  - billing
  - database_schema
  - deployment
  - ci_cd
  - eval_system
  - secrets
  - admin
```

---

### 7.11 Meta-Evaluation Gate

평가 시스템 자체 변경은 별도 검수로 분리.

보호 대상:

```text
eval.yaml
scripts/eval.sh
scripts/check-test-integrity.py
scripts/check-diff-scope.py
.github/workflows/
security policy
protected file list
```

---

## 8. 웹앱 케이스별 상세 검수 룰

## 8.1 로그인 버그 수정

### 작업

```text
잘못된 비밀번호로 로그인하면 500이 아니라 401과 표준 에러 응답을 반환해야 한다.
```

### task.yaml

```yaml
id: auth-invalid-login-401
objective: Invalid password login must return 401 instead of 500.

write_scope:
  allowed:
    - src/features/auth/
    - src/app/api/auth/
    - tests/auth/
  forbidden:
    - prisma/migrations/
    - src/features/billing/
    - src/features/admin/
    - .github/
    - eval.yaml
    - scripts/

required_evidence:
  - adds_regression_test
  - invalid_password_returns_401
  - normal_login_still_works

risk_area: auth
human_approval_required: true
```

### 적대적 테스트 예시

```typescript
describe("auth adversarial cases", () => {
  it("does not return 500 for invalid password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "user@test.com", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      code: "INVALID_CREDENTIALS"
    });
  });

  it("does not expose password hash details", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "user@test.com", password: "wrong-password" });

    expect(JSON.stringify(res.body)).not.toContain("hash");
    expect(JSON.stringify(res.body)).not.toContain("bcrypt");
  });

  it("does not create a session on failed login", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "user@test.com", password: "wrong-password" });

    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
```

### Reject 사례

```text
- 모든 실패를 200으로 반환
- password check 제거
- 테스트에서 auth 전체 mock
- invalid password 테스트 삭제
- 실패 응답에도 세션 쿠키 생성
```

---

## 8.2 API 성능 개선

### 작업

```text
GET /api/projects/:id/dashboard p95 latency를 20% 이상 개선한다.
```

### 검수 룰

```yaml
task_acceptance:
  performance:
    baseline_p95_ms: 940
    required_p95_ms: 752
    max_query_count: 20
    max_response_size_regression_percent: 5

  contract:
    response_schema_must_match: tests/contract/dashboard.schema.json

  must_not:
    - remove_fields_to_reduce_latency
    - return_partial_data_without_flag
    - disable_permission_check
    - cache_user_specific_data_globally
    - change_pagination_semantics
```

### 성능 테스트 예시

```typescript
it("dashboard API p95 latency stays within target", async () => {
  const samples: number[] = [];

  for (let i = 0; i < 50; i++) {
    const start = performance.now();

    const res = await request(app)
      .get(`/api/projects/${projectId}/dashboard`)
      .set("Authorization", `Bearer ${userToken}`);

    const end = performance.now();

    expect(res.status).toBe(200);
    samples.push(end - start);
  }

  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];

  expect(p95).toBeLessThanOrEqual(752);
});
```

### Reject 사례

```text
- 응답 필드 제거로 빨라진 척함
- 권한 체크 제거
- 캐시 키에서 userId/projectId 누락
- benchmark 반복 수 축소
- 평균만 보고 p95를 보지 않음
```

---

## 8.3 UI 접근성 개선

### 작업

```text
작업 보드 페이지 접근성 점수 개선
```

### 검수 룰

```yaml
task_acceptance:
  accessibility:
    lighthouse_min_score: 95
    axe_violations_max: 0

  required_behaviors:
    - keyboard_navigation
    - visible_focus_ring
    - aria_labels_for_icon_buttons
    - no_click_only_interaction

  must_not:
    - remove_interactive_features
    - hide_elements_from_accessibility_tree_without_reason
    - use_div_button_without_role
    - disable_focus_outline
```

### Playwright + Axe 예시

```typescript
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("task board has no critical accessibility violations", async ({ page }) => {
  await page.goto("/projects/demo/board");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});

test("task cards are keyboard reachable", async ({ page }) => {
  await page.goto("/projects/demo/board");

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("dialog")).toBeVisible();
});
```

### Reject 사례

```text
- 문제 UI를 display:none 처리
- aria-hidden으로 핵심 UI 숨김
- focus outline 제거
- 마우스로만 가능한 동작 유지
```

---

## 8.4 WebSocket 로그 스트리밍 안정성 개선

### 작업

```text
AI 작업 로그 스트리밍 중 연결이 끊기면 자동 재연결하고, 중복 로그를 만들지 않는다.
```

### 검수 룰

```yaml
task_acceptance:
  required_tests:
    - tests/realtime/reconnect.test.ts
    - tests/realtime/deduplication.test.ts
    - tests/realtime/manual-stop.test.ts

  required_behaviors:
    - reconnect_on_network_drop
    - no_duplicate_log_lines
    - resume_from_last_event_id
    - stop_means_stop

  must_not:
    - infinite_reconnect_without_limit
    - duplicate_events
    - memory_leak
    - reconnect_after_user_cancel
```

### 테스트 예시

```typescript
it("does not duplicate logs after reconnect", async () => {
  const stream = createMockLogStream();

  stream.emit({ id: 1, text: "build started" });
  stream.disconnect();
  stream.reconnect({ lastEventId: 1 });
  stream.emit({ id: 1, text: "build started" });
  stream.emit({ id: 2, text: "build finished" });

  expect(stream.renderedLogs()).toEqual([
    "build started",
    "build finished"
  ]);
});

it("does not reconnect after user manually stops", async () => {
  const client = createRealtimeClient();

  client.connect();
  client.stopByUser();
  client.simulateNetworkDrop();

  await wait(3000);

  expect(client.reconnectAttempts()).toBe(0);
});
```

### Reject 사례

```text
- 무한 재연결 루프
- 중복 로그 허용
- 수동 중지 후 재연결
- backoff 없이 빠른 재시도
- 메모리 누수
```

---

## 8.5 DB Migration 포함 기능 추가

### 작업

```text
agent_run_events 테이블 추가
```

### 검수 룰

```yaml
task_acceptance:
  required:
    - prisma_schema_update
    - migration_file
    - rollback_plan
    - seed_update_if_needed
    - integration_test

  migration_gates:
    - forward_migration_success
    - rollback_success
    - existing_data_preserved
    - index_added_for_query_path

  must_not:
    - drop_existing_columns
    - rename_columns_without_data_migration
    - destructive_migration_without_approval
    - change_enum_semantics

human_approval_required: true
```

### 검수 명령

```bash
npm run db:test:reset
npm run db:migrate
npm run test:integration
npm run db:rollback:test
```

### Reject 사례

```text
- 기존 컬럼 삭제
- rollback 없음
- Prisma schema만 변경하고 migration 없음
- index 없이 대량 조회 경로 추가
- production lock 위험 미검토
```

---

## 8.6 관리자 권한 버그 수정

### 작업

```text
일반 사용자가 관리자 설정 API에 접근할 수 있는 문제 수정
```

### 검수 룰

```yaml
task_acceptance:
  required_tests:
    - normal_user_cannot_access_admin_api
    - admin_can_access_admin_api
    - unauthenticated_user_gets_401
    - forged_role_token_rejected

  security:
    server_side_authorization_required: true
    client_side_only_check_forbidden: true

  human_approval_required: true

  must_not:
    - hide_button_only
    - trust_client_role
    - trust_unsigned_token_claim
    - remove_admin_feature
```

### 적대적 테스트

```typescript
it("rejects forged role field from client", async () => {
  const forgedToken = createUserToken({
    userId: normalUser.id,
    role: "admin"
  });

  const res = await request(app)
    .post("/api/admin/settings")
    .set("Authorization", `Bearer ${forgedToken}`)
    .send({ siteName: "hacked" });

  expect(res.status).toBe(403);
});
```

### Reject 사례

```text
- 프론트 버튼만 숨김
- API 권한 체크 없음
- JWT role payload만 신뢰
- 테스트에서 모든 사용자를 admin으로 mock
```

---

## 8.7 AI 프롬프트/스킬 개선

### 작업

```text
AI 작업 계획 생성 스킬의 일관성을 개선한다.
```

### 검수 룰

```yaml
prompt_eval:
  dataset: tests/ai/planning-skill-cases.jsonl

  required_sections:
    - PRD
    - TRD
    - database_schema
    - test_plan
    - implementation_tasks
    - risk_list

  scoring:
    min_pass_rate: 0.90
    regression_allowed: false

  adversarial_cases:
    - vague_request
    - conflicting_requirements
    - missing_stack
    - unsafe_request
    - impossible_deadline

  must_not:
    - invent_user_requirements
    - skip_test_plan
    - produce_code_without_plan_when_plan_required
    - ignore_constraints
```

### 평가 케이스

```json
{
  "id": "planning-001",
  "input": "게시판 만들어줘. 관리자랑 유저 관리도 있어야 해.",
  "must_include": [
    "PRD",
    "TRD",
    "DB schema",
    "권한 모델",
    "테스트 계획",
    "작업 분해"
  ],
  "must_not_include": [
    "바로 코드만 작성",
    "인증 생략",
    "관리자 권한 미정의"
  ]
}
```

---

## 9. 스킬 시스템 설계

### 9.1 스킬 디렉터리 구조

```text
skills/
├── improvement-discovery/
│   ├── SKILL.md
│   ├── templates/
│   └── examples/
├── patch-builder/
│   ├── SKILL.md
│   ├── templates/
│   └── examples/
├── adversarial-evaluator/
│   ├── SKILL.md
│   ├── templates/
│   └── examples/
├── decision-gate/
│   ├── SKILL.md
│   ├── templates/
│   └── examples/
└── meta-evaluation/
    ├── SKILL.md
    ├── templates/
    └── examples/
```

---

### 9.2 improvement-discovery-skill

목적:

```text
프로젝트 상태에서 개선 후보를 발견한다.
```

입력:

```text
- CI logs
- test reports
- issue list
- error logs
- performance metrics
- security scan
- previous loop failures
```

출력:

```json
{
  "candidates": [
    {
      "title": "Fix invalid login error handling",
      "evidence": ["500 error on invalid password"],
      "priority": "high",
      "riskArea": "auth"
    }
  ]
}
```

---

### 9.3 patch-builder-skill

목적:

```text
작업 정의와 write_scope를 바탕으로 작은 패치를 만든다.
```

Hard rule:

```text
- 평가 파일 수정 금지
- 테스트 약화 금지
- protected path 수정 금지
- 관련 없는 리팩터링 금지
```

---

### 9.4 adversarial-evaluator-skill

목적:

```text
후보 패치가 실제 개선인지 공격적으로 검토한다.
```

SKILL.md 예시:

```markdown
# Adversarial Evaluator Skill

## Purpose

Determine whether a candidate patch is a genuine improvement or an unsafe, test-bypassing, regressive, or no-op change.

## Required Inputs

- task.md
- task.yaml
- git diff
- baseline-report.json
- candidate-report.json
- eval.yaml
- ACCEPTANCE.md

## Hard Reject

Reject if:

- Tests are weakened
- eval files are changed
- protected files are changed
- no real improvement evidence exists
- security scan fails
- behavior changes outside scope
- errors are hidden instead of fixed

## Human Review

Return `needs_human_review` if the patch touches:

- auth
- permission
- billing
- database schema
- deployment
- CI/CD
- secrets
- evaluation system

## Output

Write adversarial-report.json.
```

---

### 9.5 decision-gate-skill

목적:

```text
모든 검수 결과를 종합해 최종 판정한다.
```

판정식:

```text
Hard Gate 실패 → reject
Task Acceptance 실패 → reject
Regression 발견 → reject
Test Integrity 실패 → reject
Protected 파일 변경 → reject
개선 증거 없음 → reject
위험 영역 변경 → needs_human_review
모든 검수 통과 + 위험 변경 아님 → accept
```

---

### 9.6 meta-evaluation-skill

목적:

```text
평가 시스템 자체 변경을 별도 고위험 작업으로 검수한다.
```

평가 시스템 변경 예:

```text
- eval.yaml 수정
- eval.sh 수정
- CI workflow 수정
- 테스트 무결성 검사 수정
- 보안 게이트 수정
- protected file list 수정
```

---

## 10. 대상 프로젝트 템플릿 파일

### 10.1 ACCEPTANCE.md

```markdown
# ACCEPTANCE.md

## 목적

이 프로젝트의 자율 코딩 개선 루프는 웹앱의 품질, 안정성, 보안, 성능, 유지보수성을 반복적으로 개선한다.

AI는 코드를 수정할 수 있지만, 아래 검수 기준을 모두 통과하지 못하면 개선으로 인정하지 않는다.

## 기본 Hard Gate

모든 후보 변경은 아래 명령을 통과해야 한다.

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run test:contract`
- `npm run build`
- `npm run test:e2e:smoke`

## 변경 범위 제한

작업마다 `write_scope`를 지정해야 한다. AI는 허용된 경로 밖을 수정할 수 없다.

## 테스트 무결성

AI는 테스트를 약화할 수 없다.

금지:

- `test.skip`
- `describe.skip`
- `it.only`
- assertion 삭제
- snapshot 대량 갱신
- 실패 케이스 삭제
- timeout 과도 증가
- mock으로 실제 검증 우회

## 실제 개선 증거

후보 변경은 아래 중 최소 1개 이상의 개선 증거를 가져야 한다.

- 실패하던 테스트가 통과함
- 신규 회귀 테스트가 추가됨
- 커버리지가 증가함
- 성능 지표가 개선됨
- 보안 스캔 결과가 개선됨
- 에러 로그 발생률이 감소함
- 중복 코드가 감소함

## 적대적 검수 필수

모든 후보는 별도의 적대적 평가를 받아야 한다.

## 사람 승인 필요 영역

아래 변경은 자동 accept 금지다.

- 인증 / 권한
- 결제 / 요금
- DB schema / migration
- 배포 설정
- CI/CD
- 보안 정책
- eval 시스템
- 관리자 권한
- 외부 API 키 / 토큰 처리
```

---

### 10.2 eval.yaml

> ⚠️ 보존용 구버전 예시 — 현행 스키마([../schemas/eval.schema.json](../schemas/eval.schema.json))와 비호환. 실제 형식은 [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) 참조.

```yaml
project: vibeloop-web
mode: autonomous-improvement-loop

hard_gates:
  - name: typecheck
    command: npm run typecheck
    required: true

  - name: lint
    command: npm run lint
    required: true

  - name: unit_tests
    command: npm test
    required: true

  - name: contract_tests
    command: npm run test:contract
    required: true

  - name: build
    command: npm run build
    required: true

  - name: smoke_e2e
    command: npm run test:e2e:smoke
    required: true

security_gates:
  - name: secret_scan
    command: gitleaks detect --source . --no-git
    required: true

  - name: dependency_audit
    command: npm audit --audit-level=high
    required: true

  - name: semgrep
    command: semgrep scan --config auto .
    required: false

adversarial_gates:
  - name: diff_scope
    command: python scripts/check-diff-scope.py
    required: true

  - name: test_integrity
    command: python scripts/check-test-integrity.py
    required: true

  - name: protected_files
    command: python scripts/check-protected-files.py
    required: true

performance_gates:
  - name: api_latency
    command: npm run bench:api
    required: false
    max_regression_percent: 5

change_guards:
  protected_paths:
    - .env
    - .env.local
    - eval.yaml
    - scripts/eval.sh
    - scripts/check-test-integrity.py
    - .github/workflows/
    - prisma/migrations/

  global_forbidden_patterns:
    - "test.skip"
    - "describe.skip"
    - "it.only"
    - "console.log('debug')"
    - "TODO: bypass"
    - "eslint-disable"
    - "@ts-ignore"

improvement_evidence:
  required_any:
    - fixes_reproduced_failure
    - adds_regression_test
    - increases_coverage
    - improves_latency
    - reduces_error_rate
    - reduces_security_risk
    - removes_duplicate_code
    - improves_accessibility_score

human_approval_required:
  - auth
  - permission
  - billing
  - database_schema
  - deployment
  - ci_cd
  - eval_system
  - secrets
```

---

### 10.3 scripts/eval.sh

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "== Protected Files Check =="
python scripts/check-protected-files.py

echo "== Diff Scope Check =="
python scripts/check-diff-scope.py

echo "== Test Integrity Check =="
python scripts/check-test-integrity.py

echo "== Typecheck =="
npm run typecheck

echo "== Lint =="
npm run lint

echo "== Unit Tests =="
npm test

echo "== Contract Tests =="
npm run test:contract

echo "== Build =="
npm run build

echo "== Smoke E2E =="
npm run test:e2e:smoke

echo "== Secret Scan =="
gitleaks detect --source . --no-git

echo "== Dependency Audit =="
npm audit --audit-level=high

echo "== Collect Metrics =="
python scripts/collect-metrics.py

echo "== PASS =="
```

---

### 10.4 check-test-integrity.py

```python
#!/usr/bin/env python3
import subprocess
import sys
from pathlib import Path

FORBIDDEN_PATTERNS = [
    "test.skip",
    "describe.skip",
    "it.skip",
    "it.only",
    "describe.only",
    ".todo(",
    "@ts-ignore",
    "eslint-disable",
]

SUSPICIOUS_PATTERNS = [
    "expect(true).toBe(true)",
    "expect(1).toBe(1)",
    "return;",
    "mockResolvedValue({})",
]

def changed_files():
    result = subprocess.run(
        ["git", "diff", "--name-only", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [x.strip() for x in result.stdout.splitlines() if x.strip()]

def fail(msg):
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)

for file in changed_files():
    path = Path(file)

    if not path.exists():
        continue

    if file.startswith("tests/") or file.endswith(".test.ts") or file.endswith(".spec.ts"):
        text = path.read_text(errors="ignore")

        for pattern in FORBIDDEN_PATTERNS:
            if pattern in text:
                fail(f"Forbidden test weakening pattern found in {file}: {pattern}")

        for pattern in SUSPICIOUS_PATTERNS:
            if pattern in text:
                fail(f"Suspicious weak assertion found in {file}: {pattern}")

print("PASS: test integrity")
```

---

### 10.5 check-diff-scope.py

```python
#!/usr/bin/env python3
import subprocess
import sys
from pathlib import Path
import yaml

TASK_FILE = Path("tasks/current/task.yaml")

def load_task():
    if not TASK_FILE.exists():
        print("FAIL: tasks/current/task.yaml missing", file=sys.stderr)
        sys.exit(1)
    return yaml.safe_load(TASK_FILE.read_text())

def changed_files():
    result = subprocess.run(
        ["git", "diff", "--name-only", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]

def path_matches(file, paths):
    return any(file == p or file.startswith(p.rstrip("/") + "/") for p in paths)

task = load_task()
allowed_paths = task["write_scope"]["allowed"]
forbidden_paths = task["write_scope"]["forbidden"]

for file in changed_files():
    if path_matches(file, forbidden_paths):
        print(f"FAIL: forbidden path changed: {file}", file=sys.stderr)
        sys.exit(1)

    if not path_matches(file, allowed_paths):
        print(f"FAIL: file outside allowed scope: {file}", file=sys.stderr)
        sys.exit(1)

print("PASS: diff scope")
```

---

## 11. 최종 리포트 형식

### 11.1 eval-report.json

> ⚠️ 보존용 구버전 예시 — 현행 스키마([../schemas/eval-report.schema.json](../schemas/eval-report.schema.json))와 비호환. 실제 형식은 schema 파일이 source of truth다.

```json
{
  "task_id": "auth-invalid-login-401",
  "loop_id": "loop-0018",
  "base_commit": "abc123",
  "candidate_commit": "def456",
  "decision": "needs_human_review",
  "hard_gates": {
    "typecheck": "pass",
    "lint": "pass",
    "unit_tests": "pass",
    "contract_tests": "pass",
    "build": "pass",
    "smoke_e2e": "pass"
  },
  "security_gates": {
    "secret_scan": "pass",
    "dependency_audit": "pass",
    "semgrep": "pass"
  },
  "adversarial_gates": {
    "diff_scope": "pass",
    "test_integrity": "pass",
    "protected_files": "pass",
    "auth_adversarial": "pass"
  },
  "task_acceptance": {
    "invalid_password_returns_401": true,
    "no_session_created_on_failure": true,
    "password_hash_not_exposed": true,
    "normal_login_still_works": true
  },
  "improvement_evidence": {
    "fixes_reproduced_failure": true,
    "adds_regression_test": true,
    "coverage_delta": 0.8,
    "performance_delta_percent": 0
  },
  "risk": {
    "area": "auth",
    "human_approval_required": true,
    "reason": "Authentication behavior changed."
  },
  "reject_reasons": [],
  "summary": "The candidate fixes invalid login handling and adds regression coverage. Because auth logic changed, it requires human approval before merge."
}
```

---

## 12. 적대적 평가자 프롬프트

```text
너는 자율 코딩 개선 루프의 적대적 평가자다.

역할:
- 후보 패치가 실제 개선인지 공격적으로 검토한다.
- 코드를 수정하지 않는다.
- 통과/실패/사람 검토 필요 여부만 판정한다.

검토 항목:
1. 요구사항을 우회했는가?
2. 테스트를 삭제하거나 약화했는가?
3. 평가 스크립트를 완화했는가?
4. 기존 기능 회귀 가능성이 있는가?
5. 보안 취약점이 생겼는가?
6. 에러를 숨겼는가?
7. 성능 수치를 조작했는가?
8. 변경 범위가 과도한가?
9. 실제 개선 증거가 있는가?
10. 사람 승인이 필요한 위험 영역인가?

출력 JSON:
{
  "decision": "pass | fail | needs_human_review",
  "risks": [],
  "evidence": [],
  "required_additional_tests": [],
  "reason": ""
}
```

---

## 13. 웹앱 UI 설계

### 13.1 주요 화면

```text
1. Project Registry
2. Improvement Candidates
3. Task Detail
4. Loop Run Monitor
5. Evaluation Report
6. Adversarial Review
7. Evidence Archive
8. Human Approval Queue
9. Skill Manager
10. Settings
```

### 13.2 Loop Run Monitor

표시 항목:

```text
- 현재 iteration
- 실행 중 agent
- 현재 phase
- 로그 스트림
- 변경 파일
- gate별 상태
- 실패 이유
- decision
```

### 13.3 Evaluation Report 화면

표시 항목:

```text
Hard Gates:
- typecheck
- lint
- tests
- build

Adversarial Gates:
- diff scope
- test integrity
- protected files
- security

Improvement Evidence:
- fixed failure
- added regression test
- coverage delta
- latency delta
- risk area

Decision:
- accept
- reject
- needs human review
```

### 13.4 Human Approval Queue

승인 대상:

```text
- auth 변경
- DB migration
- deployment 변경
- eval 시스템 변경
- security policy 변경
- admin 권한 변경
```

사용자 액션:

```text
- approve PR creation
- reject candidate
- request more tests
- ask critic review
- rollback
```

---

## 14. API 설계

### 14.1 Project API

```http
POST /api/projects
GET /api/projects
GET /api/projects/:id
PATCH /api/projects/:id
DELETE /api/projects/:id
```

### 14.2 Task API

```http
POST /api/projects/:projectId/tasks
GET /api/projects/:projectId/tasks
GET /api/tasks/:taskId
PATCH /api/tasks/:taskId
```

### 14.3 Loop API

```http
POST /api/tasks/:taskId/loops
GET /api/tasks/:taskId/loops
GET /api/loops/:loopId
POST /api/loops/:loopId/cancel
POST /api/loops/:loopId/retry
```

### 14.4 Evaluation API

```http
POST /api/loops/:loopId/evaluate
GET /api/loops/:loopId/reports
GET /api/reports/:reportId
```

### 14.5 Approval API

```http
GET /api/approvals
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject
POST /api/approvals/:id/request-more-tests
```

### 14.6 SSE 이벤트

```http
GET /api/loops/:loopId/events
```

이벤트 타입:

```text
loop.started
agent.started
agent.log
patch.created
gate.started
gate.passed
gate.failed
critic.completed
decision.made
approval.required
loop.completed
```

---

## 15. DB 모델 초안

### 15.1 Prisma Schema 초안

```prisma
model Project {
  id             String   @id @default(cuid())
  name           String
  repoUrl        String
  defaultBranch  String   @default("main")
  localPath      String?
  evalConfigPath String   @default("eval.yaml")
  status         String   @default("active")
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  tasks          Task[]
}

model Task {
  id          String   @id @default(cuid())
  projectId   String
  title       String
  objective   String
  status      String   @default("draft")
  riskArea    String?
  writeScope  Json
  acceptance  Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  project     Project  @relation(fields: [projectId], references: [id])
  loops       LoopRun[]
}

model LoopRun {
  id              String   @id @default(cuid())
  taskId          String
  iteration       Int
  baseCommit      String?
  candidateCommit String?
  status          String   @default("running")
  decision        String?
  startedAt       DateTime @default(now())
  finishedAt      DateTime?

  task            Task     @relation(fields: [taskId], references: [id])
  events          LoopEvent[]
  reports         EvalReport[]
}

model LoopEvent {
  id        String   @id @default(cuid())
  loopRunId String
  type      String
  message   String
  payload   Json?
  createdAt DateTime @default(now())

  loopRun   LoopRun @relation(fields: [loopRunId], references: [id])
}

model EvalReport {
  id          String   @id @default(cuid())
  loopRunId   String
  type        String
  status      String
  reportJson  Json
  summary     String?
  createdAt   DateTime @default(now())

  loopRun     LoopRun  @relation(fields: [loopRunId], references: [id])
}

model Approval {
  id        String   @id @default(cuid())
  loopRunId String
  reason    String
  status    String   @default("pending")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Skill {
  id        String   @id @default(cuid())
  name      String
  version   String
  path      String
  type      String
  enabled   Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

---

## 16. 하네스 앱 폴더 구조

```text
vibeloop-harness/
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── lib/
│   │   └── api/
│   └── worker/
│       ├── src/
│       └── runners/
├── packages/
│   ├── agent-adapters/
│   ├── eval-engine/
│   ├── sandbox-manager/
│   ├── github-integration/
│   ├── skill-manager/
│   └── shared/
├── skills/
│   ├── improvement-discovery/
│   ├── patch-builder/
│   ├── adversarial-evaluator/
│   ├── decision-gate/
│   └── meta-evaluation/
├── templates/
│   ├── ACCEPTANCE.md
│   ├── eval.yaml
│   ├── task.md
│   ├── task.yaml
│   └── eval-report.json
├── prisma/
│   └── schema.prisma
└── docs/
```

---

## 17. MVP 개발 범위

### 17.1 MVP 목표

최소 동작 버전은 다음을 지원해야 한다.

```text
- 프로젝트 등록
- 작업 생성
- write_scope 설정
- 단일 agent 실행
- patch 생성
- eval.sh 실행
- diff scope 검사
- test integrity 검사
- protected files 검사
- eval-report.json 생성
- accept/reject/needs_human_review 판정
- 로그 웹 표시
```

### 17.2 MVP에서 제외

```text
- 완전한 다중 agent rotation
- 대규모 병렬 실행
- 복잡한 스킬 마켓
- 자동 merge
- multi-tenant billing
- 고급 시각화
- 완전한 Docker isolation
```

### 17.3 MVP 기술 스택

```text
Frontend:
- Next.js
- React
- Tailwind CSS
- shadcn/ui

Backend:
- Next.js API Routes 또는 Fastify
- Prisma
- PostgreSQL
- Redis optional

Runner:
- Node child_process
- Git CLI
- GitHub CLI/API

Eval:
- Bash
- Python scripts
- npm scripts

Agent:
- Codex CLI 우선
- Claude Code optional
- Gemini optional
```

---

## 18. 개발 로드맵

### Phase 1. 검수 파일 템플릿 생성기

산출물:

```text
- ACCEPTANCE.md template
- eval.yaml template
- eval.sh
- check-test-integrity.py
- check-diff-scope.py
- check-protected-files.py
- eval-report schema
```

### Phase 2. 단일 프로젝트 로컬 루프

산출물:

```text
- 프로젝트 등록
- 작업 생성
- 루프 실행
- 패치 생성
- 검수 실행
- 리포트 저장
```

### Phase 3. 웹 대시보드

산출물:

```text
- Project dashboard
- Task dashboard
- Loop monitor
- Eval report viewer
- Approval queue
```

### Phase 4. 적대적 평가 도입

산출물:

```text
- critic prompt
- LLM critic runner
- adversarial-report.json
- reject reason UI
```

### Phase 5. GitHub PR 연동

산출물:

```text
- branch 생성
- commit 생성
- draft PR 생성
- PR body에 eval report 첨부
```

### Phase 6. 스킬 시스템

산출물:

```text
- skills/ 디렉터리
- SKILL.md 표준
- skill manager
- learnings.md 반영
```

### Phase 7. Multi-Agent 확장

산출물:

```text
- Codex adapter
- Claude adapter
- Gemini adapter
- agent rotation
- producer-reviewer pattern
```

---

## 19. 성공 기준

이 프로젝트가 성공했다고 볼 수 있는 기준:

```text
1. AI가 만든 패치가 평가 없이 바로 반영되지 않는다.
2. 모든 후보는 eval-report.json을 남긴다.
3. 테스트 약화 시 자동 reject 된다.
4. protected file 변경 시 자동 reject 된다.
5. auth/DB/deploy/eval 변경은 자동 accept되지 않는다.
6. 개선 증거 없는 변경은 reject 된다.
7. 실패한 루프는 learnings.md에 남는다.
8. 승인된 변경은 draft PR로 생성된다.
9. 동일 작업을 다시 실행해도 trace를 재현할 수 있다.
10. 웹 UI에서 각 Gate의 pass/fail 이유를 확인할 수 있다.
```

---

## 20. 가장 중요한 설계 원칙

### 20.1 AI는 개선자이면서 심판이면 안 된다

```text
Builder Agent
= 코드를 고친다.

Evaluator
= 검수 명령을 실행한다.

Adversarial Critic
= 공격적으로 문제를 찾는다.

Human Reviewer
= 위험 변경을 승인한다.
```

### 20.2 테스트 없는 자가 개선은 위험하다

테스트가 없는 프로젝트의 첫 루프 목표는 코드 개선이 아니다.

```text
첫 목표:
현재 동작을 보호하는 smoke test, contract test, eval.sh를 만든다.
```

### 20.3 평가 시스템은 보호해야 한다

아래 파일은 일반 루프에서 수정 금지다.

```text
eval.yaml
scripts/eval.sh
check-test-integrity.py
CI workflow
protected file list
security gate
```

### 20.4 작은 패치만 허용한다

```text
좋은 후보:
작은 diff + 명확한 테스트 + 개선 증거

나쁜 후보:
대규모 리팩터링 + 테스트 없음 + 개선 주장만 있음
```

### 20.5 개선 증거가 없으면 개선이 아니다

```text
통과했음 ≠ 개선됨

개선됨 =
통과함
+ 회귀 없음
+ 실제 개선 증거 있음
+ 적대적 평가 통과
```

---

## 21. 최종 결론

우리가 만들려는 것은 단순한 AI 코딩 자동화 도구가 아니다.

정확한 정의는 다음이다.

```text
스스로 개선 후보를 만들고,
작은 패치를 생성하고,
기계 검수와 적대적 평가를 통과한 개선만 채택하고,
실패/성공 경험을 스킬과 룰로 축적하는
자율 코딩 개선 루프형 AI 개발 하네스.
```

가장 먼저 개발해야 할 것은 화려한 UI가 아니라 다음 6개다.

```text
1. ACCEPTANCE.md
2. eval.yaml
3. scripts/eval.sh
4. check-test-integrity.py
5. check-diff-scope.py
6. eval-report.json
```

이 6개가 있어야 AI가 만든 변경을 “느낌”이 아니라 “증거”로 검수할 수 있다.

최종 조합은 다음이 가장 적합하다.

```text
open-ralph-wiggum
→ 반복 실행 루프

multi-agent-starter
→ 작업 폴더 / worker brief / result / log / 승인 규칙

autoresearch-skill-system
→ A/B 검증 / evidence archive / quality audit / target binding

self-improving-agent 패턴
→ 사람 승인 후 Draft PR

MAT 패턴
→ 작업 상태 모니터링 UI
```

이 구조를 기반으로 개발하면, 단순한 바이브 코딩 보조도구가 아니라 **스스로 개선하고, 스스로 검증하며, 위험한 변경은 인간에게 넘기는 전문가형 AI 개발 하네스**로 구현할 수 있다.
