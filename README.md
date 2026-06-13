# VibeLoop Harness

[![CI](https://github.com/coreline-ai/improvement_loop_harness/actions/workflows/ci.yml/badge.svg)](https://github.com/coreline-ai/improvement_loop_harness/actions/workflows/ci.yml)

VibeLoop Harness는 AI가 만든 코드 변경을 **한 번에 하나씩** 격리 worktree에서 실행하고, 고정된 `eval.yaml`/`task.yaml` 기준으로 검증한 뒤, 통과한 변경만 draft PR로 넘기는 자율 개선 루프 하네스다.

## Quickstart

```bash
pnpm install
pnpm exec prisma generate
cp .env.example .env  # 없으면 아래 env를 직접 export
```

필수/권장 환경 변수:

```bash
export VIBELOOP_API_TOKEN="dev-token"
export VIBELOOP_STORE="memory"              # 로컬 임시 실행. 운영은 DATABASE_URL 사용
export VIBELOOP_DATA_DIR="$PWD/.vibeloop"
export VIBELOOP_AGENT_SPEC="codex"          # 테스트에서는 mock:/path/to/scenario.json 사용 가능
# export DATABASE_URL="postgresql://vibeloop:vibeloop@127.0.0.1:54329/vibeloop"
```

PostgreSQL 사용 시:

```bash
docker compose up -d postgres
export DATABASE_URL="postgresql://vibeloop:vibeloop@127.0.0.1:54329/vibeloop"
pnpm exec prisma migrate deploy
```

서버 기동:

```bash
pnpm build
pnpm start:server
```

헬스 확인 예시:

```bash
curl -H "Authorization: Bearer $VIBELOOP_API_TOKEN" http://127.0.0.1:3001/api/projects
```

## Skill 제품 사용 (vibeloop-harness)

위 Quickstart는 개발 셋업이다. `skills/vibeloop-harness`는 단일 이슈를 결정론적 게이트로 **수정→검증→PR 후보화**하는 제품 채널이며, 모노레포 밖에서도 쓸 수 있다.

```bash
# 1) 단일 파일 CLI 번들 생성(자체 완결, 모노레포 불필요)
pnpm bundle:skill            # → skills/vibeloop-harness/vendor/vibeloop.mjs

# 2) skills/vibeloop-harness 폴더를 사용 환경(예: .claude/skills)에 복사.
#    래퍼는 CLI를 VIBELOOP_CLI → 모노레포 dev bin → vendor/vibeloop.mjs → PATH 순으로 찾는다.

# 3) task/eval 생성 후 한 이슈 실행
node skills/vibeloop-harness/scripts/create-task-eval.mjs \
  --template node --out /tmp/vt --id my-fix --title "Fix X" --objective "Fix X and add a regression test."
node skills/vibeloop-harness/scripts/vibeloop-run.mjs run \
  --repo /path/to/your-repo --task /tmp/vt/task.yaml --eval /tmp/vt/eval.yaml \
  --agent 'command:<your-agent>' --project-id my --loop-id my-1
```

PR 후보는 `decision=accept ∧ qualified`(고정 품질 게이트 통과)일 때만이다. 여러 후보를 두고 더 나은 것을 고르려면 `vibeloop improve --agent ... --challenger ...`. 모드/계약 상세는 [SKILL.md](./skills/vibeloop-harness/SKILL.md), [usage.md](./skills/vibeloop-harness/references/usage.md).

## 검증 명령

로컬 전체 검증:

```bash
pnpm exec prisma generate
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
pnpm build:web
pnpm test:smoke
```

PrismaStore 계약 테스트:

```bash
docker compose up -d postgres
TEST_DATABASE_URL="postgresql://vibeloop:vibeloop@127.0.0.1:54329/vibeloop" pnpm --filter @vibeloop/server test
```

## 핵심 문서

- [문서 인덱스](./docs/README.md)
- [자율 루프 명세](./docs/AUTONOMOUS_LOOP_SPEC.md)
- [Eval Engine 명세](./docs/EVAL_ENGINE_SPEC.md)
- [Security Model](./docs/SECURITY_MODEL.md)
- [3차 검토 반영 개발 계획](./dev-plan/implement_20260612_061653.md)
