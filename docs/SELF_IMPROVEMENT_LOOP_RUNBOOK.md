# 자가개선 루프 실무 테스트·검증 Runbook

이 문서는 `vibeloop-harness`의 **자가개선 루프 시나리오를 누구나 다시 실행하고 직접 검증**할 수 있게 만든 재현 런북이다. "왜/무엇을" 설명은 [SKILL_SELF_IMPROVEMENT_LOOP_UAT.md](SKILL_SELF_IMPROVEMENT_LOOP_UAT.md), 설계 불변식은 [SELF_IMPROVEMENT_LOOP_DESIGN.md](SELF_IMPROVEMENT_LOOP_DESIGN.md)를 본다. 여기서는 **명령 → 기대 출력 → 수동 확인 방법**만 다룬다.

검증 레벨은 3단계다. 위에서 아래로 갈수록 신뢰도가 높아진다.

| 레벨 | 무엇을 | 네트워크 | 소요 |
| --- | --- | --- | --- |
| L1 자동 | UAT/회귀 통과 여부 | 불필요 | ~30s |
| L2 산출물 수동 | selection report·patch·branch·누설 직접 확인 | 불필요 | ~3min |
| L3 GitHub 실무 | 임시 repo에 draft PR까지 | 필요(`gh`) | ~2min |
| 확장 | 내 repo/이슈에 직접 적용 | 선택 | — |

---

## 0. 사전 준비

- Node.js `>=22`, `pnpm install` 완료
- (L3만) `gh` 로그인: `gh auth status`

```bash
cd <repo-root>     # improvement_loop_harness
pnpm build
```

> 빌드는 각 `pnpm uat:*` / `pnpm test:*` 스크립트가 자동으로 한 번 더 수행한다. 수동 산출물 검증(L2) 전에는 위처럼 한 번 미리 빌드해 둔다.

---

## L1. 자동 검증 (1차 게이트)

### L1-1. UAT 실행

```bash
pnpm uat:skill-loop:self-improvement
```

stdout JSON의 아래 필드가 정확히 일치해야 한다(핵심만 발췌).

```jsonc
{
  "status": "SELF_IMPROVE_PASS",
  "scenario": "skill-self-improvement-loop-uat",
  "stopReason": "issue_queue_exhausted",
  "fixableIssueCount": 2,
  "acceptedIssueCount": 2,
  "adversarialIssueCount": 1,
  "everyIterationImproved": true,
  "artifactRootsUnique": true,
  "acceptedCommitsUnique": true,
  "progression": [
    { "issueId": "skill-loop-cart-quantity",
      "selectedCandidateId": "siloop-001-cart-quantity-c1",
      "builderScore": 68, "selectedScore": 84, "scoreImprovement": 16,
      "builderChangedFiles": 3, "selectedChangedFiles": 2,
      "summaryNextAction": "prepare_pr_candidate", "contextIsolated": true },
    { "issueId": "skill-loop-sku-normalization",
      "selectedCandidateId": "siloop-002-sku-normalization-c1",
      "builderScore": 68, "selectedScore": 84, "scoreImprovement": 16,
      "summaryNextAction": "prepare_pr_candidate", "contextIsolated": true }
  ],
  "adversarial": {
    "candidateCount": 2, "acceptedCount": 0,
    "selectedCandidateId": null, "allRejected": true, "prCandidateBlocked": true
  },
  "branches": [
    "main",
    "pr-candidate/skill-loop-cart-quantity",
    "pr-candidate/skill-loop-sku-normalization"
  ],
  "github": { "published": false, "reason": "disabled" }
}
```

한 줄 판정:

```bash
pnpm uat:skill-loop:self-improvement 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const ok=j.status==="SELF_IMPROVE_PASS"&&j.everyIterationImproved&&j.adversarial.prCandidateBlocked&&j.progression.every(p=>p.scoreImprovement>0&&p.selectedCandidateId.endsWith("-c1"));console.log(ok?"PASS":"FAIL");process.exit(ok?0:1)})'
```

### L1-2. 회귀(e2e) 실행

```bash
pnpm test:skill-loop:self-improvement
# Test Files 1 passed (1) / Tests 1 passed (1)
```

> e2e는 `VIBELOOP_UAT_GITHUB=0`을 강제하므로 GitHub에 절대 접근하지 않는다.

---

## L2. 산출물 수동 검증 (증거 직접 확인)

자동 통과를 믿지 않고 **결정론적 산출물을 직접 열어** 확인한다. 임시 repo/artifact를 보존하며 실행한다.

```bash
OUT=$(VIBELOOP_UAT_KEEP_TMP=1 node scripts/uat/skill-self-improvement-loop-uat.mjs 2>/dev/null)
REPO=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).targetRepo))')
TMP=$(dirname "$REPO")
echo "REPO=$REPO"; echo "TMP=$TMP"
```

### L2-1. 자가개선(점수 상승) 확인 — selection report

```bash
node -e 'const j=require(process.argv[1]);console.log(JSON.stringify({selected:j.selected_candidate_id,candidates:j.candidates.map(c=>({id:c.candidate_id,decision:c.decision,qualified:c.qualified,score:c.score&&c.score.total,files:c.score&&c.score.changed_files,lines:c.score&&c.score.changed_lines}))},null,2))' \
  "$TMP/data-iteration-01/projects/siloop-cart-quantity/selections/siloop-001-cart-quantity.json"
```

기대:

```jsonc
{ "selected": "siloop-001-cart-quantity-c1",
  "candidates": [
    { "id": "...-c0", "decision": "accept", "qualified": true, "score": 68, "files": 3, "lines": 17 },  // verbose builder
    { "id": "...-c1", "decision": "accept", "qualified": true, "score": 84, "files": 2, "lines": 6 }   // tight challenger ← 선택
  ] }
```

확인 포인트: **두 후보 모두 정답(accept·qualified)인데 더 작은 diff(c1)가 선택**되고, 선택 점수(84) > 초기 builder 점수(68). 이것이 "같은 정답을 더 나은 방향으로 개선"의 결정론적 증거다. sku 이슈도 동일:

```bash
node -e 'const j=require(process.argv[1]);console.log(j.selected_candidate_id, j.candidates.map(c=>c.score&&c.score.total))' \
  "$TMP/data-iteration-02/projects/siloop-sku-normalization/selections/siloop-002-sku-normalization.json"
# siloop-002-sku-normalization-c1 [ 68, 84 ]
```

### L2-2. 적대적 풀이 통과를 막았는지 확인

```bash
node -e 'const j=require(process.argv[1]);console.log(JSON.stringify({selected:j.selected_candidate_id,accepted:j.accepted_count,decisions:j.candidates.map(c=>c.decision)}))' \
  "$TMP/data-adversarial/projects/siloop-adv-cart-quantity/selections/siloop-003-adv-cart-quantity.json"
# {"selected":null,"accepted":0,"decisions":["reject","reject"]}
```

확인 포인트: 후보가 전부 reject → **selected=null → PR 후보 0**. 합격선이 선택 경로(improve)에서도 그대로 작동.

### L2-3. PR 후보 branch / 커밋 / 깨끗한 트리

```bash
git -C "$REPO" log --oneline
# 9bd2577 vibeloop selected skill-loop-sku-normalization
# 2cdd517 vibeloop selected skill-loop-cart-quantity
# 6438e18 initial two-issue fixture
git -C "$REPO" branch --format='%(refname:short)'
# main / pr-candidate/skill-loop-cart-quantity / pr-candidate/skill-loop-sku-normalization
git -C "$REPO" status --short    # (출력 없음 = 클린)
```

확인 포인트: 고친 이슈 2건만 `pr-candidate/<id>` branch가 생기고, **적대적 이슈는 branch가 없다**.

### L2-4. 선택된 patch 직접 보기

```bash
P="$TMP/data-iteration-01/projects/siloop-cart-quantity/runs/siloop-001-cart-quantity-c1/patches/candidate.patch"
sed -n '1,40p' "$P"     # tight 후보의 최소 diff (src/cart.cjs + tests/cart-quantity.test.cjs)
```

### L2-5. hidden/secret 누설 0 확인

누설 검사는 **누설이 일어날 수 있는 산출물**(agent 로그·report·selection)만 본다. `input/eval.yaml`은 `forbidden_literals` 정의로 sentinel 문자열을 **의도적으로 포함**하므로(탐지 규칙 그 자체) 설정 복사본(`input/`)은 제외한다.

```bash
grep -rl "SECRET_HIDDEN_EXPECTATION" "$TMP" --include='*.json' --include='*.log' \
  | grep -v '/input/' \
  && echo "LEAK 발견 (비정상)" \
  || echo "NO LEAK (정상)"
```

기대: 출력 없음 → `NO LEAK (정상)`. 실제로 sentinel이 등장하는 유일한 위치는 `.../runs/*/input/eval.yaml`(탐지 규칙 정의)뿐이고, `logs/agent.*.log`·`reports/eval-report.json`·`reports/quality-report.json`·`selections/*.json`에는 0건이어야 한다.

확인 포인트: UAT stdout·selection report·eval-report 어디에도 hidden sentinel이 새지 않는다. (sku 이슈는 `artifact_leak` 게이트가 켜져 있어, 이전 이슈 id나 토큰류 문자열이 agent 로그로 새면 커널이 자동 reject 한다.)

### L2-6. 정리

```bash
rm -rf "$TMP"
```

---

## L3. GitHub 실무 검증 (선택)

검증된 patch를 실제 임시 private GitHub repo에 **draft PR**로 올려 실사용 흐름까지 확인한다.

```bash
gh auth status                                   # 로그인 확인
VIBELOOP_UAT_GITHUB=1 pnpm uat:skill-loop:self-improvement
```

stdout의 `github` 블록 기대:

```jsonc
"github": {
  "published": true,
  "repo": "coreline-ai/vibeloop-selfimprove-uat-<runTag>",
  "pullRequests": [
    { "issueId": "skill-loop-cart-quantity",     "prUrl": ".../pull/1" },
    { "issueId": "skill-loop-sku-normalization",  "prUrl": ".../pull/2" }
  ],
  "openDraftPrCount": 2,
  "remoteDeleted": false,   // 토큰에 delete_repo 스코프가 있으면 true
  "remoteArchived": true    // 스코프가 없으면 archive로 폴백
}
```

PR 직접 확인:

```bash
REPO=coreline-ai/vibeloop-selfimprove-uat-<runTag>
gh pr list --repo "$REPO" --state all --json number,title,isDraft,headRefName
```

옵션 환경 변수:

| 변수 | 효과 |
| --- | --- |
| `VIBELOOP_UAT_GITHUB=1` | GitHub 게시 단계 활성화 |
| `VIBELOOP_UAT_KEEP_REMOTE=1` | 정리(삭제/archive) 건너뛰고 repo 보존 |
| `VIBELOOP_UAT_GITHUB_OWNER=<owner>` | 대상 계정/조직 변경(기본 `coreline-ai`) |

정리: 토큰에 `delete_repo` 스코프가 있으면 UAT가 자동 hard delete. 없으면 archive(read-only)로 중화하므로, 완전 삭제는 수동으로:

```bash
gh auth refresh -s delete_repo
gh repo delete "$REPO" --yes
```

---

## 검증 체크리스트 (claim → 확인 → 기대)

| # | 주장 | 확인 위치 | 기대 |
| --- | --- | --- | --- |
| 1 | 루프가 이슈 큐를 순차 진행하고 정상 종료 | UAT `stopReason` | `issue_queue_exhausted` |
| 2 | 매 이슈마다 자가개선이 더 나은 방향 | `progression[*].scoreImprovement` | `> 0` (68→84, +16) |
| 3 | 더 나은 후보를 결정론적으로 선택 | selection report `selected_candidate_id` | challenger(`-c1`) |
| 4 | 후보 선택이 LLM이 아님 | Arbiter 점수 = `evidence*100 - files*5 - lines` | 고정 공식 |
| 5 | 통과 후 다음 이슈로 반복 | `acceptedIssueCount` / branches | `2` / pr-candidate 2개 |
| 6 | 컨텍스트 격리 | `progression[*].contextIsolated` | `true` |
| 7 | 나쁜 풀은 통과 0 | `adversarial.prCandidateBlocked` | `true` (selected=null) |
| 8 | hidden/secret 무누설 | `grep SECRET_HIDDEN_EXPECTATION` | 없음 |
| 9 | 실사용 PR까지 | `github.openDraftPrCount` (L3) | `2` |

---

## 실무 확장: 내 repo·내 이슈에 직접 적용

위 시나리오는 고정 fixture지만, 동일한 루프를 **실제 작업 repo에 그대로** 쓸 수 있다. 핵심은 한 이슈에 builder 1개 이상 + challenger 1개 이상을 주고, 선택을 하네스에 맡기는 것이다.

```bash
vibeloop improve \
  --repo /path/to/your-repo \
  --task your-task.yaml \
  --eval your-eval.yaml \
  --agent     '<builder-spec-A>' \     # 후보 1 (예: 보수적 수정)
  --agent     '<builder-spec-B>' \     # 후보 2 (다른 접근, 선택)
  --challenger '<challenger-spec>' \   # 통과 후보가 있어도 항상 도는 개선 탐색
  --project-id your-project \
  --loop-id   your-issue-001
```

- agent spec: `command:<shell>` (로컬 스크립트/CLI), `mock:<scenario.json>`(테스트), 또는 설정된 `codex`/Codex OAuth.
- 출력의 `selected_patch`만 PR로 올린다. `selected_candidate_id`가 `null`이면 **이 풀에서 합격이 없었던 것**이므로 PR을 만들지 않는다.
- 품질 합격선은 `your-eval.yaml`의 `evaluator:` 블록(고정 룰)에서 정한다. 자세한 키는 [SELF_IMPROVEMENT_LOOP_DESIGN.md](SELF_IMPROVEMENT_LOOP_DESIGN.md).
- task/eval 초안은 `node skills/vibeloop-harness/scripts/create-task-eval.mjs ...`로 생성할 수 있다([SKILL_PRODUCTIZATION_RUNBOOK.md](SKILL_PRODUCTIZATION_RUNBOOK.md) §4).

검증 자동화가 필요하면 위 명령을 감싸 `selected_candidate_id`/`selected_patch`와 selection report의 점수를 단언하면 된다 — UAT [skill-self-improvement-loop-uat.mjs](../scripts/uat/skill-self-improvement-loop-uat.mjs)의 `runImproveIteration`이 그 참조 구현이다.

---

## 트러블슈팅

| 증상 | 원인 | 조치 |
| --- | --- | --- |
| UAT가 stderr로 실패 | 빌드 누락/오염된 stdout | `pnpm build` 후 재실행 |
| `github.reason = gh_not_authenticated` | `gh` 미로그인 | `gh auth login` 후 재실행(core UAT는 그대로 통과) |
| `remoteDeleted=false, remoteArchived=true` | 토큰에 `delete_repo` 없음 | `gh auth refresh -s delete_repo` 후 수동 삭제 |
| `git apply --3way` 실패(L3) | 대상 트리 불일치 | 임시 publish repo가 fixture base와 동일해야 함(자동) |
| 선택이 `-c0`(verbose) | Arbiter 가중치/agent 변경 | `agent-candidate.cjs`의 verbose가 더 큰 diff인지 확인 |

## 관련 파일

- UAT: [scripts/uat/skill-self-improvement-loop-uat.mjs](../scripts/uat/skill-self-improvement-loop-uat.mjs)
- 회귀: [tests/e2e/skill-productization/skill-self-improvement-loop.e2e.test.ts](../tests/e2e/skill-productization/skill-self-improvement-loop.e2e.test.ts)
- 후보 agent: [tests/e2e/user-scenarios/skill-loop/agent-candidate.cjs](../tests/e2e/user-scenarios/skill-loop/agent-candidate.cjs), [agent-regression.cjs](../tests/e2e/user-scenarios/skill-loop/agent-regression.cjs)
- CLI: [packages/cli/src/commands/improve.ts](../packages/cli/src/commands/improve.ts) (`--challenger`)
- 선택 엔진: [packages/sdk/src/improvement-loop.ts](../packages/sdk/src/improvement-loop.ts) (`scoreFor` / `compareAccepted`)
