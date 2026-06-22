# 자가개선 루프 실무 테스트·검증 Runbook

이 문서는 `vibeloop-harness`의 **자가개선 루프 시나리오를 누구나 다시 실행하고 직접 검증**할 수 있게 만든 재현 런북이다. "왜/무엇을" 설명은 [SKILL_SELF_IMPROVEMENT_LOOP_UAT.md](SKILL_SELF_IMPROVEMENT_LOOP_UAT.md), 설계 불변식은 [SELF_IMPROVEMENT_LOOP_DESIGN.md](SELF_IMPROVEMENT_LOOP_DESIGN.md)를 본다. 여기서는 **명령 → 기대 출력 → 수동 확인 방법**만 다룬다.

검증 레벨은 3단계다. 위에서 아래로 갈수록 신뢰도가 높아진다.

| 레벨           | 무엇을                                       | 네트워크   | 소요  |
| -------------- | -------------------------------------------- | ---------- | ----- |
| L1 자동        | UAT/회귀 통과 여부                           | 불필요     | ~30s  |
| L2 산출물 수동 | selection report·patch·branch·누설 직접 확인 | 불필요     | ~3min |
| L3 GitHub 실무 | 임시 repo에 draft PR까지                     | 필요(`gh`) | ~2min |
| 확장           | 내 repo/이슈에 직접 적용                     | 선택       | —     |

---

## 0. 사전 준비

- Node.js `>=22`, `corepack pnpm install` 완료
- (L3만) `gh` 로그인: `gh auth status`

```bash
cd <repo-root>     # improvement_loop_harness
corepack pnpm build
```

> 빌드는 각 `corepack pnpm uat:*` / `corepack pnpm test:*` 스크립트가 자동으로 한 번 더 수행한다. 수동 산출물 검증(L2) 전에는 위처럼 한 번 미리 빌드해 둔다.

---

## L1. 자동 검증 (1차 게이트)

### L1-1. UAT 실행

```bash
corepack pnpm uat:skill-loop:self-improvement
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
    {
      "issueId": "skill-loop-cart-quantity",
      "selectedCandidateId": "siloop-001-cart-quantity-c1",
      "builderScore": 68,
      "selectedScore": 84,
      "scoreImprovement": 16,
      "builderChangedFiles": 3,
      "selectedChangedFiles": 2,
      "summaryNextAction": "prepare_pr_candidate",
      "contextIsolated": true
    },
    {
      "issueId": "skill-loop-sku-normalization",
      "selectedCandidateId": "siloop-002-sku-normalization-c1",
      "builderScore": 68,
      "selectedScore": 84,
      "scoreImprovement": 16,
      "summaryNextAction": "prepare_pr_candidate",
      "contextIsolated": true
    }
  ],
  "adversarial": {
    "candidateCount": 2,
    "acceptedCount": 0,
    "selectedCandidateId": null,
    "allRejected": true,
    "prCandidateBlocked": true
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
corepack pnpm uat:skill-loop:self-improvement 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const ok=j.status==="SELF_IMPROVE_PASS"&&j.everyIterationImproved&&j.adversarial.prCandidateBlocked&&j.progression.every(p=>p.scoreImprovement>0&&p.selectedCandidateId.endsWith("-c1"));console.log(ok?"PASS":"FAIL");process.exit(ok?0:1)})'
```

### L1-2. 회귀(e2e) 실행

```bash
corepack pnpm test:skill-loop:self-improvement
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
{
  "selected": "siloop-001-cart-quantity-c1",
  "candidates": [
    {
      "id": "...-c0",
      "decision": "accept",
      "qualified": true,
      "score": 68,
      "files": 3,
      "lines": 17
    }, // verbose builder
    {
      "id": "...-c1",
      "decision": "accept",
      "qualified": true,
      "score": 84,
      "files": 2,
      "lines": 6
    } // tight challenger ← 선택
  ]
}
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
corepack pnpm uat:live-preflight                         # codex/gh/corepack pnpm 확인
VIBELOOP_UAT_GITHUB=1 corepack pnpm uat:skill-loop:self-improvement
```

`uat:live-preflight`는 live Codex/GitHub UAT 전에 실행환경을 먼저 판정한다. 필수 항목은 `codex --version`, `codex -c service_tier=fast login status`, `gh auth status`, `corepack pnpm --version`이며, 필수 항목 실패는 테스트 실패가 아니라 **blocked(exit 20)** 로 끝난다. 현재 검증된 복구 절차는 다음과 같다.

```bash
npm install -g --prefix ~/.local/node @openai/codex@0.139.0
codex --version
codex -c service_tier=fast login status
corepack pnpm uat:live-preflight
```

기대: `codex-cli 0.139.0`, `Logged in using ChatGPT`, preflight JSON `status=pass`, `required_failures=[]`. 직접 `pnpm` shim이 없다는 경고(`pnpm_shim`)는 `corepack pnpm`이 통과하면 필수 실패가 아니다.

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

| 변수                                | 효과                                    |
| ----------------------------------- | --------------------------------------- |
| `VIBELOOP_UAT_GITHUB=1`             | GitHub 게시 단계 활성화                 |
| `VIBELOOP_UAT_KEEP_REMOTE=1`        | 정리(삭제/archive) 건너뛰고 repo 보존   |
| `VIBELOOP_UAT_GITHUB_OWNER=<owner>` | 대상 계정/조직 변경(기본 `coreline-ai`) |

정리: 토큰에 `delete_repo` 스코프가 있으면 UAT가 자동 hard delete. 없으면 archive(read-only)로 중화하므로, 완전 삭제는 수동으로:

```bash
gh auth refresh -s delete_repo
gh repo delete "$REPO" --yes
```

---

## L4. Live Codex UAT 증거 번들 확인

실 Codex/GitHub UAT(`uat:skill-loop:codex-*`)는 기본으로 감사 증거를 내구 경로에 복사한다. `VIBELOOP_UAT_KEEP_TMP=1`을 붙이지 않아도 stdout ledger의 `evidence.evidence_bundle`이 `~/.vibeloop/uat-evidence/<scenario>/<run-id>/`를 가리켜야 한다.

```bash
corepack pnpm uat:live-preflight
OUT=$(corepack pnpm uat:skill-loop:codex-live 2>/dev/null)
BUNDLE=$(printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).evidence.evidence_bundle))')
MANIFEST="$BUNDLE/uat-evidence-manifest.json"
test -f "$MANIFEST" && echo "$MANIFEST"
```

필수 확인:

```bash
node -e 'const j=require(process.argv[1]);console.log({copied:j.copied.length,missing:j.missing.length,proxy:j.proxy_stats_ref,ledger:j.ledger_ref})' "$MANIFEST"
find "$BUNDLE/reports" -maxdepth 1 -type f
find "$BUNDLE/runs" -maxdepth 6 -name manifest.json -print
test -f "$BUNDLE/proxy/proxy-stats.json"
test -f "$BUNDLE/ledger.json"
```

운영 옵션:

| 변수                              | 효과                                                        |
| --------------------------------- | ----------------------------------------------------------- |
| `VIBELOOP_UAT_EVIDENCE_DIR=<dir>` | evidence bundle 기본 위치를 바꿈(CI artifact 업로드용 권장) |
| `VIBELOOP_UAT_PRUNE=1`            | evidence bundle을 만든 뒤 임시 `tmp_root`를 삭제            |
| `VIBELOOP_UAT_KEEP_TMP=1`         | 하위 호환 override. `PRUNE=1`과 같이 있어도 tmp를 보존      |

복사된 run manifest에는 `audit_keep: true`가 들어가므로 retention 스캔 대상 루트에 evidence directory를 넣어도 감사 run이 보호된다.

---

## L5. Adversary Live 전제 확인

M2/M4 live adversary와 `builtin:rulepack-semantic` live 검증은 미신뢰 테스트를 R1 격리 컨테이너에서 실행해야 한다. 이 전제는 일반 Codex/GitHub live preflight와 분리해서 확인한다.

```bash
corepack pnpm uat:adversary-live-preflight
corepack pnpm uat:adversary-live
```

기대:

- Docker-compatible runtime이 있으면 preflight는 `status=pass`, `uat:adversary-live`는 controlled command adversary proposal을 M2 격리 confirm → M4 replay → freeze → N+1 `builtin:rulepack-semantic` good/pass, bad/fail, visible-only hardcode/fail, default-quantity hardcode/fail, zero-quantity truthiness hardcode/fail까지 실행한다.
- `docker`가 없으면 둘 다 `status=blocked`, `reason=CONTAINER_RUNTIME_UNAVAILABLE`, exit 20. 이 경우 P4 live adversary PASS를 선언하지 않는다.

real Codex adversary reviewer command lane을 의도적으로 켤 때는 P4 전용 wrapper를 사용한다. 이 lane은 current-loop accept/selection에 영향을 주지 않는 advisory-only proposal만 만들고, release gate는 reviewer provenance(`real_llm=true`, `provider=codex`, `proposal_source=accepted_review_proposal`, `same_model_review=false`, fixed prompt hash/version)를 확인한다.

```bash
export VIBELOOP_ADVERSARY_REVIEWER_COMMAND='node scripts/uat/adversary-live-codex-reviewer.mjs --live'
export VIBELOOP_ADVERSARY_REVIEWER_PROVIDER=codex
export VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM=1
corepack pnpm uat:adversary-live

# 별도 evidence scenario로 보존하려면:
corepack pnpm uat:adversary-live:real-reviewer
corepack pnpm uat:release-evidence-audit -- --scenario adversary-live-real-reviewer-uat
```

2026-06-22 local run `adversary-live-39896-1782094414571`은 이 설정으로 `ADVERSARY_LIVE_PASS`를 남겼고, Codex proposal `cart-line-total-quantity-semantics`를 M2/M4/freeze/N+1과 6/6 attack scenario까지 통과시켰다. `adversary-live-real-reviewer-uat`는 이 lane의 CI artifact 감사를 위한 별도 scenario이며, `release-evidence-audit --scenario adversary-live-real-reviewer-uat`는 real LLM reviewer provenance를 필수로 요구한다. 이 증거는 단일 P4 cart semantic local lane PASS이며, CI에서 같은 real-reviewer env를 켠 artifact PASS나 더 큰 project-specific semantic/M4 corpus PASS는 아니다.

---

## L6. Controlled Repo Matrix 확인

P5 controlled corpus는 실제 외부 프로젝트가 아니라, toolchain·구조·상태를 대표하는 임시 git repo 셀을 생성해 `vibeloop discover`와 `vibeloop run`/`improve`를 돌린다. 결과는 PASS/blocked/unsupported로만 해석한다.

```bash
corepack pnpm uat:repo-matrix
```

기대:

- `status=REPO_MATRIX_PASS`
- `cell_count=19`, `pass_count>=16`, `blocked_count=1`, `unsupported_count<=1`, `fail_count=0`
- broad controlled framework-like cells include Django-like, Rails-like, and Android/Gradle-like repo shapes
- `dirty-worktree`는 `dirty_source_guard`로 blocked
- `network-restricted-r1`은 Docker/R1 smoke가 가능하면 `pass`, Docker가 없으면 `unsupported`
- stdout의 `evidence_bundle` 아래 `ledger.json`과 각 supported cell의 `eval-report.json`이 남는다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-uat/repo-matrix-63259-1781497152210/ledger.json
```

대표 셀을 실제 Codex + GitHub draft PR lane으로 승격할 때는 별도 live UAT를 실행한다. 이 명령은 private GitHub repo를 만들고, 실 Codex builder/challenger를 ChatGPT OAuth proxy로 실행하며, hidden acceptance/final reverify 통과 후 draft PR만 만든다.

```bash
VIBELOOP_UAT_KEEP_REMOTE=1 corepack pnpm uat:repo-matrix:codex-python-live
VIBELOOP_UAT_KEEP_REMOTE=1 corepack pnpm uat:repo-matrix:codex-monorepo-live
VIBELOOP_UAT_KEEP_REMOTE=1 corepack pnpm uat:repo-matrix:codex-broad-live
```

기대:

- Python: `status=PYTHON_LIVE_REPRESENTATIVE_PASS`
- Monorepo: `status=MONOREPO_LIVE_REPRESENTATIVE_PASS`
- Broad framework: `status=BROAD_LIVE_REPRESENTATIVE_PASS`, `cell_count=3`, `pass_count=3`, `fail_count=0`
- `builder.real_llm=true`, `proxy_auth_header_seen=true`
- GitHub PR은 `OPEN` + `draft`, base=`main`
- Python 변경 파일은 `src/cart.py`, `tests/test_cart_quantity.py`
- Monorepo 변경 파일은 `packages/cart/src/index.cjs`, `packages/cart/tests/cart-quantity.test.cjs`; `packages/catalog/`는 변경되지 않아야 한다.
- Broad framework 변경 파일은 Django-like `shop/cart.py`/`tests/test_cart_base.py`/`tests/test_cart_view.py`, Rails-like `app/models/cart_line.rb`/`test/models/cart_line_test.rb`, Android-like `CartLine.java`/`CartLineTest.java`로 제한된다.
- `final_verification.passed=true`, hidden acceptance pass, `github.main_unchanged=true`
- evidence bundle은 `repo-matrix-*-codex-live-uat/<run-id>/ledger.json`과 candidate/reverify run manifest(`audit_keep=true`)를 포함한다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-python-codex-live-uat/python-realuser-live-89436-1781498088975/ledger.json
https://github.com/coreline-ai/vibeloop-python-live-89436-1781498088975/pull/1
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-monorepo-codex-live-uat/monorepo-realuser-live-34325-1781499102895/ledger.json
https://github.com/coreline-ai/vibeloop-monorepo-live-34325-1781499102895/pull/1
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-broad-codex-live-uat/broad-realuser-live-16608-1782091851845/ledger.json
https://github.com/coreline-ai/vibeloop-django-live-16608-1782091851845/pull/1
https://github.com/coreline-ai/vibeloop-rails-live-16608-1782091851845/pull/1
https://github.com/coreline-ai/vibeloop-android-live-16608-1782091851845/pull/1
```

2026-06-22 R17 broad framework live run은 `BROAD_LIVE_REPRESENTATIVE_PASS`, `cell_count=3`, `pass_count=3`, `fail_count=0`, `proxy_auth_header_seen=true`를 남겼다. `corepack pnpm uat:release-evidence-audit -- --all-release-evidence`도 P2/P3/P4/P5 7개 scenario 전체 PASS로 새 broad evidence를 감사했다.

---

## 검증 체크리스트 (claim → 확인 → 기대)

| #   | 주장                                     | 확인 위치                                       | 기대                    |
| --- | ---------------------------------------- | ----------------------------------------------- | ----------------------- |
| 1   | 루프가 이슈 큐를 순차 진행하고 정상 종료 | UAT `stopReason`                                | `issue_queue_exhausted` |
| 2   | 매 이슈마다 자가개선이 더 나은 방향      | `progression[*].scoreImprovement`               | `> 0` (68→84, +16)      |
| 3   | 더 나은 후보를 결정론적으로 선택         | selection report `selected_candidate_id`        | challenger(`-c1`)       |
| 4   | 후보 선택이 LLM이 아님                   | Arbiter 점수 = `evidence*100 - files*5 - lines` | 고정 공식               |
| 5   | 통과 후 다음 이슈로 반복                 | `acceptedIssueCount` / branches                 | `2` / pr-candidate 2개  |
| 6   | 컨텍스트 격리                            | `progression[*].contextIsolated`                | `true`                  |
| 7   | 나쁜 풀은 통과 0                         | `adversarial.prCandidateBlocked`                | `true` (selected=null)  |
| 8   | hidden/secret 무누설                     | `grep SECRET_HIDDEN_EXPECTATION`                | 없음                    |
| 9   | 실사용 PR까지                            | `github.openDraftPrCount` (L3)                  | `2`                     |

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

| 증상                                       | 원인                      | 조치                                                  |
| ------------------------------------------ | ------------------------- | ----------------------------------------------------- |
| UAT가 stderr로 실패                        | 빌드 누락/오염된 stdout   | `corepack pnpm build` 후 재실행                                |
| `github.reason = gh_not_authenticated`     | `gh` 미로그인             | `gh auth login` 후 재실행(core UAT는 그대로 통과)     |
| `remoteDeleted=false, remoteArchived=true` | 토큰에 `delete_repo` 없음 | `gh auth refresh -s delete_repo` 후 수동 삭제         |
| `git apply --3way` 실패(L3)                | 대상 트리 불일치          | 임시 publish repo가 fixture base와 동일해야 함(자동)  |
| 선택이 `-c0`(verbose)                      | Arbiter 가중치/agent 변경 | `agent-candidate.cjs`의 verbose가 더 큰 diff인지 확인 |

## 관련 파일

- UAT: [scripts/uat/skill-self-improvement-loop-uat.mjs](../scripts/uat/skill-self-improvement-loop-uat.mjs)
- 회귀: [tests/e2e/skill-productization/skill-self-improvement-loop.e2e.test.ts](../tests/e2e/skill-productization/skill-self-improvement-loop.e2e.test.ts)
- 후보 agent: [tests/e2e/user-scenarios/skill-loop/agent-candidate.cjs](../tests/e2e/user-scenarios/skill-loop/agent-candidate.cjs), [agent-regression.cjs](../tests/e2e/user-scenarios/skill-loop/agent-regression.cjs)
- CLI: [packages/cli/src/commands/improve.ts](../packages/cli/src/commands/improve.ts) (`--challenger`)
- 선택 엔진: [packages/sdk/src/improvement-loop.ts](../packages/sdk/src/improvement-loop.ts) (`scoreFor` / `compareAccepted`)

## Product-100 Codex Live UAT 실행/감사 절차

Product-100은 fixture PASS나 representative PASS를 제품 전체 PASS로 부르는 것을 막기 위한 최상위 UAT 계약이다. 현재 구현 상태는 **2026-06-22 local finalization 기준 controlled Product-100 corpus `PRODUCT_100_CODEX_LIVE_PASS`**다. 이 PASS는 5개 controlled repo/10개 seeded issue, real Codex Builder/Challenger/Reviewer, Phase4 strict-best, Phase5 M2/M4/freeze/N+1 aggregate, Phase6 GitHub draft PR/evidence/audit, Phase7 docs truth checker 범위에 한정된다. 임의의 모든 사용자 repo에 대한 제품 전체 100% PASS가 아니다.

### Product-100 real Codex adversary reviewer 기본 wrapper

`uat:product-100:preflight`와 Phase5 runner는 별도 설정이 없으면 기본으로 `node scripts/uat/product-100-codex-reviewer.mjs --live`를 사용한다. 이 wrapper는 Codex CLI를 `exec --ephemeral --ignore-rules --sandbox read-only`로 호출해 Builder 세션과 분리된 advisory reviewer JSON만 받는다. 필요하면 아래 env로 명시 override한다.

```bash
export VIBELOOP_ADVERSARY_REVIEWER_COMMAND='node scripts/uat/product-100-codex-reviewer.mjs --live'
export VIBELOOP_ADVERSARY_REVIEWER_PROVIDER=codex
export VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM=1
```

`product-100-codex-reviewer.mjs --dry-run`은 schema/배선 확인용이며 `real_llm=false`라 Product-100 PASS 증거가 아니다. `--live`는 Codex CLI를 별도 non-interactive reviewer로 호출한다. 현재 reviewer preflight와 R1 Colima smoke는 통과 가능하다. 2026-06-22 finalization run에서는 Phase5 aggregate가 10/10 issue에서 real Codex reviewer proposal, M2 R1 confirmation, M4 replay, frozen rulepack, N+1 semantic gate를 통과했다. Phase6도 GitHub private corpus repo 5개와 draft PR 10개를 만들고 evidence bundle + release audit을 통과해야 하며, Phase7도 final PASS ledger가 README/Run Ledger/Runbook에 반영됐는지 결정론 checker로 확인한다.

### 실행 순서

```bash
corepack pnpm uat:product-100:preflight
corepack pnpm uat:product-100:corpus
corepack pnpm uat:product-100:evals
corepack pnpm uat:product-100:scaffold
corepack pnpm uat:product-100:codex-live
corepack pnpm uat:release-evidence-audit -- --scenario product-100-codex-live-uat
```

`codex-live` 실행은 Phase4가 시작된 경우 기본적으로 `summary.phase4.tmp_root/product-100-live-report.json`에 최종 ledger를 저장한다. 경로를 고정해야 하면 `VIBELOOP_PRODUCT_100_REPORT_FILE=/path/to/ledger.json`을 지정한다.

### Phase6 GitHub draft PR 환경

Phase6 live까지 실행하려면 GitHub draft PR을 만들 수 있는 remote가 필요하다. Product-100 corpus는 5개 독립 repo fixture이므로 단일 GitHub repo 하나에 모든 issue branch를 밀어 넣지 않는다. 기본 권장값은 **run마다 private GitHub repo를 corpus repo별로 자동 생성**하는 것이다.

```bash
export VIBELOOP_PRODUCT_100_ENABLE_PHASE6_LIVE=1
export VIBELOOP_PRODUCT_100_ENABLE_GITHUB_REPOS=1
export VIBELOOP_PRODUCT_100_GITHUB_OWNER=coreline-ai
export VIBELOOP_UAT_KEEP_REMOTE=1

corepack pnpm uat:product-100:preflight
```

위 설정이 없는데 `VIBELOOP_PRODUCT_100_ENABLE_PHASE6_LIVE=1`만 켜면 preflight는 `github_draft_prs_open` blocker로 fail-closed한다. 생성되는 private repo 이름은 `vibeloop-p100-<run>-<corpus-repo>` 형식이다.

### CI artifact 재현성

실제 GitHub Actions artifact까지 재현하려면 `Product-100 Live Evidence` 또는 `P4 Real Reviewer Live Evidence` workflow를 수동 실행한다. 두 workflow는 opt-in일 때만 live Codex/GitHub 또는 live Codex reviewer run을 수행하고, 같은 run에서 업로드된 artifact를 다시 다운로드해 명시 scenario로 감사한다.

사전 조건:

- repository secret `PRODUCT100_GH_TOKEN`: private corpus repo 생성, branch push, draft PR 생성을 할 수 있는 PAT.
- Codex CLI/OAuth 또는 해당 환경의 live Codex 인증. 이 인증이 없으면 preflight 또는 live runner가 fail-closed한다.
- Docker runtime with `node:22-alpine` and `python:3.12-alpine`.

P4 real reviewer CI artifact는 Codex ChatGPT login이 있는 runner가 필요하다. 기본 `ubuntu-latest`에 로그인 상태가 없다면 `runner_label`을 self-hosted runner로 지정한다.

```bash
gh workflow run adversary-real-reviewer-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=true \
  -f runner_label=self-hosted \
  -f reviewer_model=gpt-5.5 \
  -f reviewer_timeout_ms=240000
```

기존 P4 real reviewer artifact를 재감사할 때는 replay input만 지정한다.

```bash
gh workflow run adversary-real-reviewer-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=false \
  -f replay_run_id=<run_id> \
  -f replay_run_attempt=1 \
  -f replay_repo=coreline-ai/improvement_loop_harness
```

```bash
gh workflow run product-100-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=true \
  -f github_owner=coreline-ai \
  -f keep_remote=true \
  -f require_postgres=false
```

기존 Product-100 artifact를 재감사할 때는 live run 없이 replay input만 지정한다.

```bash
gh workflow run product-100-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=false \
  -f replay_run_id=<run_id> \
  -f replay_run_attempt=<attempt> \
  -f replay_repo=coreline-ai/improvement_loop_harness
```

진행 상태는 stdout을 기다리지 말고 run root의 heartbeat 파일을 본다.

```bash
cat ~/.vibeloop/product-100-real-loop-*/product-100-progress.json
```

이 파일은 현재 issue, 완료 issue 수, issue별 `strict_score_improvement`/`pr_candidate` 상태를 갱신한다.

### PASS 금지 조건

- `corepack pnpm uat:product-100:codex-live`가 `PRODUCT_100_CODEX_LIVE_BLOCKED` 또는 `PRODUCT_100_CODEX_LIVE_FAIL`이면 PASS가 아니다.
- R1 Docker/Colima가 없으면 M2/M4/freeze/N+1 semantic live가 불가능하므로 PASS가 아니다.
- 기본 reviewer wrapper가 비활성화되거나 override command가 `real_llm=true`/provider provenance를 남기지 못하면 real adversary reviewer 증거가 없으므로 PASS가 아니다.
- Phase6 live 요청 시 `VIBELOOP_PRODUCT_100_ENABLE_GITHUB_REPOS=1` 또는 명시적으로 허용된 GitHub repo 환경이 없으면 `github_draft_prs_open=false`라 PASS가 아니다.
- `release-evidence-audit --scenario product-100-codex-live-uat`가 `PRODUCT_100_CODEX_LIVE_PASS` ledger와 manifest를 찾지 못하면 PASS가 아니다.
- 문서/Run Ledger/README가 blocked/fail 상태를 숨기면 `docs_run_ledger_readme_truthful=false`로 PASS가 아니다.

### 현재 로컬 기준 기대 결과

현재 이 머신에서는 R1/reviewer preflight가 통과하고, 2026-06-22 finalization 기준 Product-100 controlled corpus ledger가 `PRODUCT_100_CODEX_LIVE_PASS`로 닫힌다. 핵심 증거는 Phase4 full report `/Users/iriver/.vibeloop/product-100-phase4-full-20260619165620.json`, Phase5 aggregate report `/Users/iriver/.vibeloop/product-100-phase5-full-rerun-20260621231906.json`, Phase6 draft PR report `/Users/iriver/.vibeloop/product-100-phase6-20260622-001250/phase6-draft-pr-report.json`, final evidence bundle `~/.vibeloop/uat-evidence/product-100-codex-live-uat/product-100-phase6-20260622-001250`다. 이 결과는 Product-100 controlled corpus PASS이며, broad project corpus나 임의 사용자 repo 전체에 대한 제품 전체 100% PASS가 아니다.
