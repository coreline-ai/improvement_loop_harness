# SECURITY_MODEL.md

## 1. Threat Model

AI agent는 선의라고 가정하지 않는다. 다음 행위를 구조적으로 막아야 한다.

| 위협 | 방어 |
|---|---|
| eval/test script 약화 | protected path + meta-evaluation gate |
| allowed path 밖 파일 생성 | diff scope guard + worktree path allowlist |
| untracked file로 우회 | git status + untracked scan |
| symlink/path traversal | realpath 검증, symlink 제한 |
| **공유 `.git` 메타데이터 변조 (hooks/config/filter)** | **git metadata integrity guard + 방어 플래그 (§4)** |
| secret/env 탈취 | env scrub, LLM proxy, no secret passthrough |
| benchmark 조작 | baseline/candidate artifact 고정, benchmark config protected |
| 에러 숨김 | regression/contract/adversarial tests |
| 무의미한 테스트 추가로 evidence 게이밍 | test-on-base 검증 (fail on base → pass on candidate) |
| prompt injection learning | learning 후보 human review, source tagging |
| 자동 발견 입력(로그/이슈)을 통한 prompt injection | candidate 구조화 추출(원문 비전달) + supervised 승인 + 최소 write_scope (§10) |
| 자율 루프 폭주 (무한 재시도·PR 스팸·예산 소진) | orchestrator guardrails: 재시도 한도·차단기·예산·PR 상한·kill switch (§10) |
| LLM critic sycophancy | critic은 advisory only, deterministic gates 우선 |
| LLM self-review dilution | 동일/유사 LLM이 수정·리뷰를 모두 수행해 통과 의미가 희석되는 위험. 최종 authority는 deterministic decision engine이며, advisory는 판정 입력이 아니고 provenance/hidden_acceptance/verifier lane으로 증거를 분리한다. |

## 2. MVP 신뢰 경계 (명시적 한계)

컨테이너 격리가 없는 MVP의 경계를 정직하게 선언한다.

```text
- eval gate의 프로젝트 명령 실행(npm test 등)은 에이전트가 수정한 코드를
  하네스 사용자 권한으로 실행하는 행위다. 즉 임의 코드 실행과 동등하다.
- 따라서 MVP는 "대상 repo와 그 의존성을 신뢰할 수 있다"를 전제로 한다.
- 신뢰할 수 없는 기여자가 있는 repo, 알 수 없는 외부 repo에는
  컨테이너 격리(MVP 이후) 도입 전까지 사용을 금지한다.
- 네트워크 차단은 MVP에서 OS 수준으로 시행되지 않는다 (§6).
  worktree 격리 + env scrub + 가드 선행 실행(fail-fast)이 MVP의 실제 방어선이다.
```

이 한계를 줄이는 MVP 내 수단: 가드 게이트를 모든 프로젝트 명령보다 먼저 실행하고, 가드 실패 시 프로젝트 명령을 아예 실행하지 않는다 ([EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §3).

## 3. Workspace Isolation

MVP 최소 격리:

```text
- loop마다 git worktree 생성
- worktree와 artifact는 대상 repo "밖" 하네스 데이터 디렉터리에 둔다
- base commit 고정
- agent cwd는 worktree root
- worktree 밖 write 금지 (MVP에서는 사후 가드로 탐지, OS 강제는 컨테이너 도입 후)
- env allowlist 방식
- candidate patch만 추출
- 실패/거절 workspace는 retention 기간 보존
```

권장 명령 흐름:

```bash
DATA_DIR="${VIBELOOP_DATA_DIR:-$HOME/.vibeloop}/projects/<project-id>"
git -C <repo> fetch origin
git -C <repo> worktree add "$DATA_DIR/worktrees/<loop-id>" <base-commit>
cd "$DATA_DIR/worktrees/<loop-id>"
# 의존성 프로비저닝 (§3.1) → baseline capture → agent 실행 (scrubbed env)
```

worktree/artifact를 repo 밖에 두는 이유: repo 내부(`.worktrees/`, `.runs/`)에 두면 (1) 에이전트가 같은 파일시스템 경계 안에서 artifact를 변조할 수 있고, (2) git status를 오염시키며, (3) diff guard의 제외 규칙이 복잡해진다.

### 3.1 의존성 프로비저닝

fresh worktree에는 `node_modules`가 없고, eval gate는 의존성 없이 실행될 수 없다. `workspace_preparing` 단계에서 다음 정책으로 제공한다.

```text
- lockfile content hash를 키로 하는 하네스 의존성 캐시에서 복사한다.
  (pnpm 사용 가능 시 content-addressable store의 read-only 링크 권장)
- 캐시 미스 시 workspace_preparing 단계에서 설치를 1회 수행하고 캐시에 적재한다.
- 설치는 agent 실행 "전"에 완료한다. agent 실행 중 추가 패키지 설치는
  승인 없이는 허용하지 않는다 (§6 network policy).
- 메인 repo의 node_modules를 worktree에 공유(symlink/hardlink)하지 않는다.
  에이전트가 공유 저장소를 오염시키는 경로가 된다.
```

## 4. Git Metadata Integrity

git worktree는 메인 repo의 `.git`(객체 저장소, **hooks, config**)을 공유한다. OS 샌드박스가 없는 MVP에서 에이전트는 파일시스템 상 공유 `.git`에 쓸 수 있고, 이 변경은 `git diff`/untracked 스캔에 **잡히지 않는다**. hook 설치나 `core.fsmonitor`/`filter.*.smudge` 설정은 이후 하네스가 git 명령을 실행하는 순간 하네스 측 코드 실행으로 이어진다.

방어 2중화:

```text
1. git metadata integrity guard (builtin, required)
   - agent 실행 전: .git/config + .git/hooks/ + .git/worktrees/<id>/의
     보안 민감 고정 메타데이터(`gitdir`, `commondir`, `config.worktree`) 해시 스냅샷 기록
   - 정상 `git commit`으로 바뀌는 volatile worktree 메타데이터(`HEAD`, `index`, `logs/`)는
     자체 commit fixture의 diff 누락 방지를 위해 변조 판정 대상에서 제외
   - agent 실행 후: 재해시 비교. 변경 발견 시 해당 loop는
     GUARD_GIT_META_TAMPER로 즉시 reject (security violation)

2. 하네스 측 git 명령 방어 플래그
   - 하네스가 worktree/repo에서 실행하는 모든 git 명령에:
     git -c core.hooksPath=/dev/null -c core.fsmonitor= ...
   - 환경: GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
     GIT_PAGER=cat GIT_EDITOR=: GIT_SEQUENCE_EDITOR=: GIT_TERMINAL_PROMPT=0
   - repo-level config의 pager/editor/alias가 개입하지 못하게
     porcelain 대신 plumbing 명령 우선 사용
```

## 5. Environment Policy

기본적으로 agent process에 전달 가능한 env는 allowlist다.

허용 예:

```text
PATH
HOME=<ephemeral-home>
CI=true
NODE_ENV=test
VIBELOOP_LOOP_ID
VIBELOOP_TASK_FILE
```

금지:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
GITHUB_TOKEN
AWS_*
DATABASE_URL(production)
*_URL / *_DSN / *_ENDPOINT 중 credential-bearing 가능 키
.env contents
```

`VIBELOOP_*` 키도 예외적으로 모두 안전하다고 보지 않는다. agent env scrubber는 token/secret/password/auth 계열뿐 아니라 URL/DSN/ENDPOINT 계열 키도 제거한다. 입력 artifact의 `env-snapshot.json`은 재현 가능한 key 목록과 `values_redacted=true`만 저장하며, env value map을 저장하지 않는다.

### 5.1 LLM Credential 주입 — localhost reverse proxy

CLI 에이전트(Codex CLI 등)는 프로세스 수준 인증이 필요하므로 "tool call 단위 주입"은 성립하지 않는다. MVP의 표준 메커니즘은 **localhost LLM reverse proxy**다.

```text
- agent env에는 실제 API key 대신 OPENAI_BASE_URL=http://127.0.0.1:<port>
  (provider별 상응 변수)만 전달한다.
- proxy가 하네스 측에서 실제 key를 보관하고 upstream 요청에 부착한다.
- 부수 효과: loop 단위 토큰 사용량 계측, 요청/응답 로그의 secret redaction,
  rate limit 적용 지점 확보.
- proxy를 경유할 수 없는 provider는 MVP 한정 scoped key passthrough를
  허용하되, 해당 key는 최소 권한·짧은 만료로 발급하고 artifact에
  raw value가 남지 않게 redaction한다 (위험을 문서화한 예외 경로).
```

## 6. Network Policy

MVP 기본값:

- 로컬 테스트에 필요한 network만 허용한다는 **정책 선언**이며, 컨테이너/netns 없는 MVP에서는 OS 수준 강제가 없다 (§2 신뢰 경계).
- LLM 호출은 localhost proxy 경유가 표준 경로다 (§5.1).
- package install은 workspace_preparing 단계의 캐시 기반 프로비저닝으로 해결하고 (§3.1), agent 실행 중 설치는 비표준 경로로 간주한다.
- OS 수준 네트워크 차단(컨테이너, netns, egress allowlist)은 MVP 이후 격리 단계의 인수 조건이다.

## 7. Protected Path Policy

전역 protected path:

```text
.env
.env.*
eval.yaml
scripts/eval.sh
.github/workflows/
SECURITY.md
security policy files
protected file list
```

가드 스크립트(`check-*.py`)는 더 이상 대상 repo에 존재하지 않는다 — 가드는 하네스 내장(builtin)이며 repo가 변조할 수 없다 ([EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §1). repo에 남는 평가 관련 파일은 `eval.yaml`과 얇은 wrapper `scripts/eval.sh`뿐이고, 둘 다 protected path다.

protected path 변경은 일반 루프에서 자동 accept 불가다.

```text
if protected path touched:
  if task.risk_area == eval_system and meta-evaluation enabled:
    needs_human_review
  else:
    reject
```

## 8. Meta-Evaluation

평가 시스템 자체 변경은 별도 task type으로 실행한다.

필수 조건:

- 변경 전후 eval fixture 비교
- 기존 bad patch fixture가 여전히 reject되는지 확인
- guard weakening 여부 검증
- human approval 필수

## 9. PR/Token Policy

- PR 생성 token은 agent process에 직접 전달하지 않는다.
- PR 생성은 harness server가 수행한다.
- token scope는 repo 단위 fine-grained 권한만 사용한다.
- `contents: write`, `pull requests: write` 외 권한은 기본 금지다.

### 9.1 Server Agent Execution Surface

서버 API의 `agent_spec`은 신뢰 입력이 아니다. 단일 bearer token을 가진 호출자가 builder agent 종류를 임의로 바꿔 host shell을 실행하지 못하게 서버 정책으로 제한한다.

```text
- 허용 기본값: codex, mock:*
- allowlist 밖 agent_spec: 400 AGENT_SPEC_NOT_ALLOWED
- retry 경로도 이전 loop의 agent_spec을 현재 서버 정책으로 재검증한다.
- VIBELOOP_AGENT_SPEC 기본값도 서버 시작 시 같은 정책으로 검증한다.
- command: agent는 server API 경로에서 비활성이다.
  R1 격리형 command-agent adapter(network none + scrubbed env + bounded artifacts)가
  별도로 배선되기 전까지 VIBELOOP_ALLOW_COMMAND_AGENT/allowlist로도 열지 않는다.
```

`command:`는 로컬 CLI/UAT 하네스에서 신뢰한 사용자가 직접 실행하는 escape hatch로만 남긴다. production/autonomous server에서는 builder agent 실행 표면을 `codex` 또는 테스트용 `mock:*`로 좁히며, 실제 프로젝트 명령은 eval `execution.isolation` 정책을 따른다.

## 10. Autonomous Loop Guardrails (MVP-4)

자율 루프([AUTONOMOUS_LOOP_SPEC.md](./AUTONOMOUS_LOOP_SPEC.md))는 새 위협면을 만든다: 발견 입력을 통한 prompt injection, 무한 재시도, 예산 소진, PR 스팸.

```text
- 발견 입력은 untrusted: 로그/이슈 원문을 agent 프롬프트에 직접 넣지 않고
  구조화 필드(경로·테스트명·에러 코드)로만 candidate를 만든다.
- 기본 모드는 supervised: 자동 생성 task는 사람 승인 후 실행.
  auto 모드도 위험 영역 needs_human_review 판정은 커널이 그대로 수행.
- 자동 생성 task의 write_scope는 실패 위치 기반 최소 경로,
  limits 완화 금지, schema 검증 통과 필수.
- 강제 가드레일: kill switch, 일일 루프/토큰 예산, 동일 candidate 재시도 2회,
  연속 실패 5회 차단기, open draft PR 상한, 발견 폭주 제한.
- 자동 merge는 어떤 모드에서도 금지 — 산출물은 draft PR까지.
```

## 11. Candidate injection gap 보강

- 발견 입력은 구조화 필드로만 task에 들어간다. 원문은 agent instruction으로 승격하지 않는다.
- `injectionIndicators`가 있는 candidate는 auto 모드에서 low-risk로 취급하지 않고 human review 대상으로 남긴다. 이 휴리스틱은 보조 방어이며, 주 방어는 원문 비전달과 최소 write_scope다.
- `reproCommand`는 표시 전용 메타데이터다. 하네스는 이 문자열을 실행하지 않는다. 실행 지원이 필요하면 eval.yaml에 사전 정의된 명령 템플릿과 인자 allowlist를 별도 설계한다.
