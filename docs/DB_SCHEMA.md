# DB_SCHEMA.md

## 1. 목적

DB는 orchestration state를 저장하고, 대용량 artifact는 파일/object storage에 저장한다. DB에는 artifact metadata와 refs만 둔다.

## 2. 권장 Prisma 모델

```prisma
model Project {
  id             String   @id @default(cuid())
  name           String
  repoUrl        String?
  localPath      String?
  defaultBranch  String   @default("main")
  evalConfigPath String   @default("eval.yaml")
  status         String   @default("active")
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  tasks          Task[]
  orchestratorState  OrchestratorState?
  orchestratorEvents OrchestratorEvent[]
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
  taskYaml    Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  project     Project  @relation(fields: [projectId], references: [id])
  loops       LoopRun[]
}

model LoopRun {
  id              String   @id @default(cuid())
  taskId          String
  iteration       Int
  status          String   @default("queued")
  decision        String?
  decisionReasons Json?
  baseCommit      String?
  candidateCommit String?
  artifactRoot    String?
  idempotencyKey  String?
  requestHash     String?
  startedAt       DateTime?
  finishedAt      DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  task            Task     @relation(fields: [taskId], references: [id])
  events          LoopEvent[]
  agentRuns       AgentRun[]
  workspaces      WorkspaceRun[]
  gateRuns        GateRun[]
  reports         EvalReport[]
  approvals       Approval[]
  artifacts       Artifact[]
  pullRequests    PullRequest[]

  @@unique([taskId, idempotencyKey])
}

model LoopEvent {
  id        String   @id @default(cuid())
  loopRunId String
  seq       Int
  type      String
  payload   Json?
  createdAt DateTime @default(now())

  loopRun   LoopRun  @relation(fields: [loopRunId], references: [id])

  @@unique([loopRunId, seq])
}

model WorkspaceRun {
  id          String   @id @default(cuid())
  loopRunId   String
  kind        String   // git_worktree | temp_clone | docker
  path        String
  baseCommit  String
  status      String   @default("active")
  createdAt   DateTime @default(now())
  cleanedAt   DateTime?

  loopRun     LoopRun  @relation(fields: [loopRunId], references: [id])
}

model AgentRun {
  id          String   @id @default(cuid())
  loopRunId   String
  agentType   String
  command     String
  model       String?
  status      String
  exitCode    Int?
  stdoutRef   String?
  stderrRef   String?
  startedAt   DateTime @default(now())
  finishedAt  DateTime?

  loopRun     LoopRun  @relation(fields: [loopRunId], references: [id])
}

model GateRun {
  id          String   @id @default(cuid())
  loopRunId   String
  name        String
  type        String
  required    Boolean
  command     String
  status      String
  exitCode    Int?
  durationMs  Int?
  stdoutRef   String?
  stderrRef   String?
  summary     String?
  startedAt   DateTime @default(now())
  finishedAt  DateTime?

  loopRun     LoopRun  @relation(fields: [loopRunId], references: [id])
}

model EvalReport {
  id          String   @id @default(cuid())
  loopRunId   String
  type        String
  status      String
  reportJson  Json
  summary     String?
  artifactRef String?
  createdAt   DateTime @default(now())

  loopRun     LoopRun  @relation(fields: [loopRunId], references: [id])
}

model Artifact {
  id          String   @id @default(cuid())
  loopRunId   String
  kind        String
  path        String
  sha256      String?
  sizeBytes   Int?
  redacted    Boolean  @default(false)
  createdAt   DateTime @default(now())

  loopRun     LoopRun  @relation(fields: [loopRunId], references: [id])
}

model Approval {
  id              String   @id @default(cuid())
  loopRunId       String
  reason          String
  status          String   @default("pending")
  reviewerId      String?
  decisionReason  String?
  requestedChanges Json?
  approvedAt      DateTime?
  rejectedAt      DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  loopRun         LoopRun  @relation(fields: [loopRunId], references: [id])
}

model PullRequest {
  id          String   @id @default(cuid())
  loopRunId   String
  provider    String   @default("github")
  branchName  String
  prUrl       String?
  prNumber    Int?
  status      String   @default("draft")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  loopRun     LoopRun  @relation(fields: [loopRunId], references: [id])
}

model ImprovementCandidate {
  id           String   @id @default(cuid())
  projectId    String
  source       String   // test_failure | typecheck | lint | security_scan | manual
  fingerprint  String
  title        String
  evidenceRefs Json?
  riskAreaHint String?
  priority     Int      @default(0)
  status       String   @default("proposed") // proposed|approved|queued|running|processed|dismissed
  dismissReason String?
  taskId       String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@unique([projectId, fingerprint])
}

model OrchestratorState {
  id                       String   @id @default(cuid())
  projectId                String   @unique
  mode                     String   @default("supervised") // supervised|auto
  status                   String   @default("stopped") // stopped|running|paused|stopping
  dailyLoopBudget          Int      @default(20)
  loopsStartedToday        Int      @default(0)
  budgetDay                String
  tokenBudgetDaily         Int?
  tokenUsedToday           Int      @default(0)
  openDraftPrLimit         Int      @default(5)
  discoveryIntervalMinutes Int      @default(30)
  consecutiveFailures      Int      @default(0)
  currentCandidateId       String?
  currentLoopId            String?
  nextDiscoveryAt          DateTime?
  pausedReason             String?
  lastStartedAt            DateTime?
  stoppedAt                DateTime?
  createdAt                DateTime @default(now())
  updatedAt                DateTime @updatedAt

  project                  Project  @relation(fields: [projectId], references: [id])
}

model OrchestratorEvent {
  id        String   @id @default(cuid())
  projectId String
  seq       Int
  type      String
  payload   Json?
  createdAt DateTime @default(now())

  project   Project  @relation(fields: [projectId], references: [id])

  @@unique([projectId, seq])
}

model SkillVersion {
  id          String   @id @default(cuid())
  name        String
  version     String
  path        String
  contentHash String
  enabled     Boolean  @default(true)
  createdAt   DateTime @default(now())
}

model Learning {
  id          String   @id @default(cuid())
  projectId   String?
  sourceLoopId String?
  status      String   @default("proposed")
  title       String
  body        String
  evidenceRefs Json?
  createdAt   DateTime @default(now())
  reviewedAt  DateTime?
}
```

## 3. 설계 이유

- `LoopEvent`는 SSE `Last-Event-ID` 재전송의 source of truth다. `seq`는 loop 단위 단조 증가 값이며, cuid는 정렬 순서를 보장하지 않으므로 event id로 쓰지 않는다.
- `LoopRun.requestHash`는 idempotency replay(동일 key+동일 hash)와 conflict(동일 key+다른 hash, 409)를 구분하는 근거다. key unique 제약만으로는 구분할 수 없다.
- `GateRun`을 분리해야 UI에서 gate별 상태와 logs를 빠르게 조회할 수 있다.
- `Artifact`를 분리해야 report JSON에 대용량 로그를 넣지 않는다.
- `WorkspaceRun`은 cleanup, retry, forensic debugging에 필요하다.
- `PullRequest`는 approval 이후 PR lifecycle을 추적한다.
- `Learning`은 learnings.md/SKILL.md에 바로 쓰기 전 검토 queue 역할을 한다.
- `ImprovementCandidate`는 자율 루프(MVP-4)의 발견 큐다. `@@unique([projectId, fingerprint])`가 같은 문제의 중복 발견을 차단하고, `dismissed` 상태 행이 "다시 제안하지 말 것" 기억 역할을 한다 ([AUTONOMOUS_LOOP_SPEC.md](./AUTONOMOUS_LOOP_SPEC.md) §3).
- `OrchestratorState`는 프로젝트당 1개 자율 루프 실행 상태, 일일 loop/token 예산, 현재 candidate/loop, pause 사유와 discovery 대기 시각을 영속화한다. 재시작 시 `current*`와 `running` candidate를 복구하는 기준이다.
- `OrchestratorEvent`는 loop가 아직 없거나 guardrail이 loop 외부에서 발동된 경우에도 `orchestrator.started/paused/stopped`, `candidate.picked/dismissed` 같은 프로젝트 단위 이벤트를 단조 증가 `seq`로 기록한다.
