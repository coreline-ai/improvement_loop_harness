# ARCHITECTURE.md

## 1. 아키텍처 원칙

VibeLoop Harness의 핵심은 웹 UI가 아니라 **검증 커널**이다. UI, DB, GitHub PR, 스킬 시스템은 검증 커널 위에 올라가는 관리 계층이다.

```text
Web/API Layer
  ↓
Loop Orchestrator
  ↓
Verification Kernel
  ├─ Task Protocol
  ├─ Workspace Runner
  ├─ Agent Adapter
  ├─ Patch Manager
  ├─ Eval Runner (baseline/test-on-base 포함)
  ├─ Guard Suite (하네스 내장 builtin)
  ├─ Artifact Archive
  └─ Decision Engine
  ↓
PR / Approval / Skill Layer
```

## 2. 핵심 컴포넌트

| 컴포넌트 | 책임 | MVP 필수 여부 |
|---|---|---|
| Task Manager | task.yaml 생성/검증, 상태 관리 | 필수 |
| Workspace Runner | git worktree 생성(repo 밖 데이터 디렉터리), 의존성 프로비저닝, env scrub, 실행 디렉터리 통제 | 필수 |
| Agent Adapter | Codex/Claude 등 하나의 command 실행, LLM proxy 경유 | 필수 |
| Patch Manager | base_commit 대비 diff 추출(untracked/rename/symlink 포함), patch 저장, rollback | 필수 |
| Eval Runner | eval.yaml 기반 gate 실행, baseline capture, test-on-base 검증 | 필수 |
| Guard Suite | git metadata integrity, diff scope, test integrity, protected files, limits — 전부 하네스 내장 | 필수 |
| Artifact Archive | logs/reports/patch/metrics 저장 | 필수 |
| Decision Engine | gate 결과로 최종 판정 (first-match-wins 우선순위 표) | 필수 |
| Web Dashboard | run/report/approval 표시 | MVP-2 |
| GitHub PR Manager | branch/commit/draft PR (PullRequest 엔티티로 루프와 분리 추적) | MVP-3 |
| Skill Manager | learnings/SKILL.md 반영 | MVP-4 |

## 3. 검증 커널 실행 흐름

```text
 1. task.yaml validate
 2. base commit resolve
 3. isolated git worktree create (하네스 데이터 디렉터리, repo 밖)
 4. dependency provisioning (lockfile hash 키 캐시)
 5. baseline capture (비교형 게이트, base_commit 단위 캐시 가능)
 6. git metadata snapshot (config/hooks 해시 기록)
 7. agent command run with scrubbed env (LLM은 localhost proxy 경유)
 8. git metadata integrity check (변조 시 즉시 reject 입력으로 기록)
 9. candidate diff extract (base_commit 대비, untracked/rename/symlink/mode 포함)
10. builtin guards run (protected/diff scope/limits/test integrity)
11. test-on-base evidence 검증 (신규 테스트가 base에서 fail인지 확인)
12. eval.yaml gates run (가드 전부 통과 시에만 프로젝트 명령 실행)
13. metrics/evidence collect (detector가 present/missing/inconclusive 판정)
14. adversarial critic run (advisory gate의 하나로 실행)
15. decision engine emits eval-report.json (모든 경로에서 항상 생성)
16. accepted/approved low-risk patch can create draft PR (PullRequest 엔티티)
```

가드 실패 시 12~14의 프로젝트 명령/critic은 실행하지 않고 `skipped`로 기록한 채 15로 수렴한다. 순서 규범과 fail-fast 규칙은 [EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §3이 정의한다.

## 4. 역할 분리

| 역할 | 수정 가능 여부 | 최종 판정 권한 |
|---|---|---|
| Builder Agent | write_scope 안에서만 가능 | 없음 |
| Eval Runner | 수정 없음, 명령 실행 | gate별 exit code 제공 |
| Adversarial Critic | 수정 없음 | advisory only |
| Decision Engine | 수정 없음 | deterministic decision |
| Human Reviewer | 승인/거절/추가 테스트 요청 | high-risk final decision |

## 5. 외부 참고 패턴 반영

- multi-agent-starter: file-as-memory, worker approval, adapter layer, deterministic validation
- Evolve Loop: exit code 기반 verdict, structural anti-gaming, per-cycle worktree
- Harbor: agent/environment evaluation abstraction, rollout 보존
- self-improving-agent: minimal diff, explicit human approval, draft PR
- SWE-bench: fail-on-base → pass-on-candidate 패치 검증 (test-on-base의 원형)

## 6. 금지 아키텍처

```text
- agent가 eval-report.json을 직접 작성
- agent가 같은 working tree에서 직접 수정
- eval.sh가 eval.yaml과 별도 source of truth로 동작
- LLM critic pass를 최종 accept로 사용
- protected path를 allowed path로 덮어씀
- secret이 agent process env에 그대로 노출
- 가드를 대상 repo의 스크립트에 위임 (가드는 하네스 내장이어야 함)
- 가드 통과 전에 프로젝트 명령 게이트 실행
- worktree/artifact를 대상 repo 내부에 배치
- guard/eval 실패를 decision engine을 거치지 않고 종결 (eval-report 누락)
```
