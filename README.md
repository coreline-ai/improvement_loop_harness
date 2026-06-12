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
