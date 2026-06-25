# 자가개선 루프 실무 테스트·검증 Runbook

이 문서는 `vibeloop-harness`의 **자가개선 루프 시나리오를 누구나 다시 실행하고 직접 검증**할 수 있게 만든 재현 런북이다. "왜/무엇을" 설명은 [SKILL_SELF_IMPROVEMENT_LOOP_UAT.md](SKILL_SELF_IMPROVEMENT_LOOP_UAT.md), 설계 불변식은 [SELF_IMPROVEMENT_LOOP_DESIGN.md](SELF_IMPROVEMENT_LOOP_DESIGN.md)를 본다. 여기서는 **명령 → 기대 출력 → 수동 확인 방법**만 다룬다.

목적 경계: 이 런북의 핵심은 GitHub나 CI를 통과시키는 것이 아니라 **내부 개선 루프가 issue를 하나씩 처리하며 후보 생성→검증→선택→최종 재검증을 끝내는지 확인하는 것**이다. L3 GitHub 단계는 선택된 개선분을 draft PR로 출판해 diff/evidence를 사람이 확인하는 도구일 뿐이며, PR 생성 자체가 accept 근거가 아니다.

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

CI credentialed live workflow를 수동 실행하기 전에는 runner label도 별도로 확인한다.

```bash
node scripts/uat/ci-runner-preflight.mjs --runner-label <label> --repo <owner/repo>
```

기대: 일반 preflight에서 GitHub-hosted label은 `status=pass`지만, Codex ChatGPT login이 필요한 credentialed workflow는 `--require-codex-login-runner`를 넘기므로 GitHub-hosted label을 `status=blocked`, `reason=CODEX_LOGIN_RUNNER_REQUIRED`로 막는다. custom/self-hosted label은 matching online runner가 없으면 `status=blocked`, `reason=SELF_HOSTED_RUNNER_UNAVAILABLE`. GitHub Actions token이 runner 목록을 조회할 권한이 없으면 `reason=RUNNER_QUERY_TOKEN_UNAVAILABLE`로 차단한다. credentialed workflow는 같은 preflight를 먼저 실행하고 `*-live-runner-preflight-*` artifact를 남기므로, runner/token 부재는 live evidence PASS가 아니라 환경 차단으로 해석한다. 이때 live artifact audit job도 `ci-live-runner-block-audit` JSON을 업로드하므로 audit artifact에서 blocker reason을 직접 확인할 수 있다.

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

- Docker-compatible runtime이 있으면 preflight는 `status=pass`, `uat:adversary-live`는 controlled command adversary proposal을 M2 격리 confirm → M4 replay → freeze → N+1 `builtin:rulepack-semantic` good/pass, bad/fail, visible-only hardcode/fail, default-quantity hardcode/fail, zero-quantity truthiness hardcode/fail, discount hardcode/fail, tax hardcode/fail, rounding hardcode/fail, profile visibility hardcode/fail, profile suspension hardcode/fail, order approval hardcode/fail까지 실행한다.
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

2026-06-23 local run `adversary-live-real-reviewer-18472-1782167542594`은 이 설정으로 `ADVERSARY_LIVE_PASS`를 남겼고, Codex reviewer proposal과 supplemental discount/tax/rounding/profile visibility/profile suspension/order approval/inventory reservation/shipping eligibility/payment authorization/refund eligibility/coupon application semantic rule을 M2/M4/freeze/N+1로 고정했다. Evidence는 `real_llm=true`, `provider=codex`, M2 confirmed 12, M4 replay-safe 12/12, 17/17 attack scenario PASS를 포함한다. M2는 proposal별 staged copy에서 실행되어 이전 proposal test 파일이 다음 proposal 확인을 오염하지 않는다. 2026-06-24 기본 `adversary-live-uat` controlled lane은 `adversary-live-41241-1782280568782`로 gift-card redemption까지 포함한 15-rule corpus, M2 confirmed 15, M4 replay-safe 15/15, 20/20 attack scenario, explicit release audit PASS를 남겼다. CI run `28079085647` / ledger `adversary-live-2538-1782281588903`도 같은 15-rule corpus, 20/20 attack scenario, artifact-bound release audit PASS를 남겼다. `adversary-live-real-reviewer-uat`는 real reviewer lane의 CI artifact 감사를 위한 별도 scenario이며, `release-evidence-audit --scenario adversary-live-real-reviewer-uat`는 real LLM reviewer provenance를 필수로 요구한다. 이전 6-rule corpus는 credentialed CI run `27943361464` / ledger `adversary-live-real-reviewer-86899-1782121115050`에서도 PASS했고, live job과 downloaded artifact audit job이 모두 성공했다. 15-rule real reviewer/credentialed CI artifact 재현성은 아직 후속이다.

---

## L6. Controlled Repo Matrix 확인

P5 controlled corpus는 실제 외부 프로젝트가 아니라, toolchain·구조·상태를 대표하는 임시 git repo 셀을 생성해 `vibeloop discover`와 `vibeloop run`/`improve`를 돌린다. 결과는 PASS/blocked/unsupported로만 해석한다.

```bash
corepack pnpm uat:repo-matrix
```

기대:

- `status=REPO_MATRIX_PASS`
- `cell_count=19`, `pass_count>=16`, `blocked_count=1`, `unsupported_count<=1`, `fail_count=0`
- broad controlled framework-like cells include React/Next-like, Django-like, Rails-like, and Android/Gradle-like repo shapes
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
- Broad framework: `status=BROAD_LIVE_REPRESENTATIVE_PASS`, `cell_count=4`, `pass_count=4`, `fail_count=0`
- `builder.real_llm=true`, `proxy_auth_header_seen=true`
- GitHub PR은 `OPEN` + `draft`, base=`main`
- Python 변경 파일은 `src/cart.py`, `tests/test_cart_quantity.py`
- Monorepo 변경 파일은 `packages/cart/src/index.cjs`, `packages/cart/tests/cart-quantity.test.cjs`; `packages/catalog/`는 변경되지 않아야 한다.
- Broad framework 변경 파일은 React-like `app/cart-view.cjs`/`tests/cart-view.test.cjs`(+ optional `tests/cart-view-base.test.cjs`), Django-like `shop/cart.py`/`tests/test_cart_base.py`/`tests/test_cart_view.py`, Rails-like `app/models/cart_line.rb`/`test/models/cart_line_test.rb`, Android-like `CartLine.java`/`CartLineTest.java`로 제한된다.
- `final_verification.passed=true`, hidden acceptance pass, `github.main_unchanged=true`
- evidence bundle은 `repo-matrix-*-codex-live-uat/<run-id>/ledger.json`과 candidate/reverify run manifest(`audit_keep=true`)를 포함한다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-python-codex-live-uat/python-realuser-live-89436-1781498088975/ledger.json
https://github.com/coreline-ai/vibeloop-python-live-89436-1781498088975/pull/1
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-monorepo-codex-live-uat/monorepo-realuser-live-34325-1781499102895/ledger.json
https://github.com/coreline-ai/vibeloop-monorepo-live-34325-1781499102895/pull/1
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-broad-codex-live-uat/broad-realuser-live-85151-1782100084935/ledger.json
https://github.com/coreline-ai/vibeloop-react-live-85151-1782100084935/pull/1
https://github.com/coreline-ai/vibeloop-django-live-85151-1782100084935/pull/1
https://github.com/coreline-ai/vibeloop-rails-live-85151-1782100084935/pull/1
https://github.com/coreline-ai/vibeloop-android-live-85151-1782100084935/pull/1
```

2026-06-22 R17 broad framework live rerun은 `BROAD_LIVE_REPRESENTATIVE_PASS`, `cell_count=4`, `pass_count=4`, `fail_count=0`, `proxy_auth_header_seen=true`를 남겼다. React/Django/Rails/Android-like 4개 private repo 모두 draft PR open/draft, hidden acceptance, final reverify, `main_unchanged=true`를 통과했고, evidence copied 431/missing 0(manifest copied 432)로 보존됐다. `corepack pnpm uat:release-evidence-audit -- --all-release-evidence`도 P2/P3/P4/P5 7개 scenario 전체 PASS로 새 broad evidence를 감사했다.

controlled corpus 밖의 기존 실제 로컬 repo를 read-only로 훑을 때는 별도 real-project corpus smoke를 사용한다. 이 명령은 repo를 수정하지 않고 git metadata/source marker/package metadata와 `vibeloop discover --test-command 'git ls-files > /dev/null'`만 확인한다.

```bash
corepack pnpm uat:repo-matrix:real-project-corpus -- \
  --repo /path/to/real/repo-a \
  --repo /path/to/real/repo-b \
  --min-repos 2

corepack pnpm uat:release-evidence-audit -- \
  --scenario repo-matrix-real-project-corpus-uat
```

기대:

- `status=REAL_PROJECT_CORPUS_PASS`
- `cell_count>=2`, `pass_count>=2`, `fail_count=0`
- 각 cell은 실제 git worktree, tracked source marker, language marker, read-only discover smoke를 통과해야 한다.
- 이 lane은 LLM 수정, hidden acceptance, draft PR 생성, 임의/대형 repo 전체 PASS를 의미하지 않는다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-corpus-uat/real-project-corpus-23713-1782101791183/ledger.json
```

2026-06-22 R19 real project corpus smoke는 기존 로컬 repo 4개에서 `REAL_PROJECT_CORPUS_PASS`, `cell_count=4`, `pass_count=4`, `fail_count=0`을 남겼다. 각 repo는 read-only git metadata, source/language markers, package/source marker smoke, `vibeloop discover` smoke를 통과했고, `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-corpus-uat`도 manifest-backed evidence를 PASS로 감사했다.

기존 실제 로컬 repo를 원본 read-only로 유지하면서 임시 clone 수정 가능성까지 확인할 때는 safe modifiable-copy smoke를 사용한다. 이 lane은 각 repo를 `/tmp` 아래로 clone하고 probe 파일 write/stage/diff-check/cleanup을 수행한 뒤 `vibeloop discover` smoke를 실행한다.

```bash
corepack pnpm uat:repo-matrix:real-project-modifiable-corpus -- \
  --repo /path/to/real/repo-a \
  --repo /path/to/real/repo-b \
  --min-repos 2

corepack pnpm uat:release-evidence-audit -- \
  --scenario repo-matrix-real-project-modifiable-corpus-uat
```

기대:

- `status=REAL_PROJECT_MODIFIABLE_CORPUS_PASS`
- `cell_count>=2`, `pass_count>=2`, `fail_count=0`
- 각 cell은 실제 git worktree, tracked source marker, language marker, temp-clone write probe, staged diff check, cleanup, discover smoke를 통과해야 한다.
- 이 lane도 아직 LLM 수정, hidden acceptance, draft PR 생성, 임의/대형 repo 전체 PASS를 의미하지 않는다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-modifiable-corpus-uat/real-project-corpus-55869-1782103100279/ledger.json
```

2026-06-22 R20 real project modifiable-copy smoke는 기존 로컬 repo 3개에서 `REAL_PROJECT_MODIFIABLE_CORPUS_PASS`, `cell_count=3`, `pass_count=3`, `fail_count=0`을 남겼다. 각 repo는 원본 read-only metadata/discover smoke와 temp-clone write/stage/diff-check/cleanup/discover smoke를 통과했고, `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-modifiable-corpus-uat`도 manifest-backed evidence를 PASS로 감사했다.

기존 실제 로컬 repo에서 실제 Codex가 수정 가능한지 보되 원본을 건드리지 않으려면 real Codex temp-clone smoke를 사용한다. 이 lane은 각 repo를 `/tmp` 아래로 clone하고, Codex CLI가 clone 내부에 `.vibeloop-codex-real-project-probe.json`만 작성하게 한 뒤 hidden verifier가 `git rev-parse HEAD`, `git ls-files` count, dirty-before flag, diff scope를 검증한다.

```bash
corepack pnpm uat:repo-matrix:real-project-codex-copy -- \
  --repo /path/to/real/repo-a \
  --repo /path/to/real/repo-b \
  --min-repos 2

corepack pnpm uat:release-evidence-audit -- \
  --scenario repo-matrix-real-project-codex-copy-uat
```

기대:

- `status=REAL_PROJECT_CODEX_COPY_PASS`
- `cell_count>=2`, `pass_count>=2`, `fail_count=0`
- ledger가 `codex_copy_smoke=true`, `llm_modification=true`, `hidden_acceptance=true`, `source_repos_read_only=true`, `draft_pr=false`, `builder.real_llm=true`, `builder.provider=codex`를 남긴다.
- 각 cell은 `codex_copy.status=pass`, `codex_copy.hidden_acceptance.status=pass`, `codex_copy.diff_scope.status=pass`여야 한다.
- 이 lane은 실제 Codex가 temp clone을 수정한다는 증거이며, 아직 실제 업무 source-code repair, GitHub draft PR, 임의/대형 repo 전체 PASS를 의미하지 않는다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-codex-copy-uat/real-project-corpus-84338-1782104805579/ledger.json
```

2026-06-22 R22 real project Codex temp-clone smoke는 기존 로컬 repo 2개에서 `REAL_PROJECT_CODEX_COPY_PASS`, `cell_count=2`, `pass_count=2`, `fail_count=0`을 남겼다. 각 repo는 원본 read-only metadata/discover smoke를 통과했고, temp clone에서 실제 Codex가 probe JSON만 작성했으며 hidden verifier가 repo-derived head/file-count/diff scope를 검증했다. `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-codex-copy-uat`도 manifest-backed evidence를 PASS로 감사했다.

기존 실제 로컬 repo의 임시 clone에서 실제 Codex가 소스 파일 repair까지 수행하는지 확인하려면 real Codex temp-clone source repair lane을 사용한다. 이 lane은 원본 repo를 수정하지 않고 각 temp clone에 dedicated fixture source/test commit을 만든 뒤, Codex CLI가 `.vibeloop-real-project-repair/invoice-total.mjs`만 수정하게 한다. Hidden verifier는 base visible/hidden fail, final visible/hidden pass, source-only diff, visible test unchanged, 원본 repo head/status unchanged를 확인한다.

```bash
corepack pnpm uat:repo-matrix:real-project-codex-repair -- \
  --repo /path/to/real/repo-a \
  --repo /path/to/real/repo-b \
  --min-repos 2

corepack pnpm uat:release-evidence-audit -- \
  --scenario repo-matrix-real-project-codex-repair-uat
```

기대:

- `status=REAL_PROJECT_CODEX_REPAIR_PASS`
- `cell_count>=2`, `pass_count>=2`, `fail_count=0`
- ledger가 `codex_repair_smoke=true`, `source_code_repair=true`, `llm_modification=true`, `hidden_acceptance=true`, `source_repos_read_only=true`, `draft_pr=false`, `builder.real_llm=true`, `builder.provider=codex`를 남긴다.
- 각 cell은 `codex_repair.status=pass`, `codex_repair.visible_acceptance.status=pass`, `codex_repair.hidden_acceptance.status=pass`, `codex_repair.diff_scope.status=pass`, `codex_repair.source_changed=true`, `codex_repair.visible_test_unchanged=true`, `codex_repair.source_repo_integrity.status=pass`여야 한다.
- 이 lane은 실제 repo shape의 temp clone에서 실제 Codex가 source repair를 수행한다는 증거이며, 아직 기존 업무 소스의 임의 버그 repair, GitHub draft PR, 임의/대형 repo 전체 PASS를 의미하지 않는다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-codex-repair-uat/real-project-corpus-41034-1782108095081/ledger.json
```

2026-06-22 R24 real project Codex temp-clone source repair는 기존 로컬 repo 2개(`audio-musicfx-mcp`, `build-server-cli`)에서 `REAL_PROJECT_CODEX_REPAIR_PASS`, `cell_count=2`, `pass_count=2`, `fail_count=0`을 남겼다. 각 repo는 원본 read-only metadata/discover smoke를 통과했고, temp clone에서 실제 Codex가 fixture source file만 수정했으며, base visible/hidden expected fail, final visible/hidden pass, source-only diff, 원본 repo integrity를 검증했다. `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-codex-repair-uat`도 manifest-backed evidence를 PASS로 감사했다.

기존 실제 로컬 repo의 임시 clone에서 업무 규칙 형태의 fixture bug를 실제 Codex가 고치는지 확인하려면 business repair lane을 사용한다. 이 lane은 원본 repo를 수정하지 않고 각 temp clone에 invoice-total business logic fixture를 커밋한 뒤, Codex CLI가 quantity, discountRate, taxRate, final rounding semantics를 `.vibeloop-real-project-repair/invoice-total.mjs` source-only로 고치게 한다. Hidden verifier는 base visible/hidden fail, final visible/hidden pass, business bug repair flag, source-only diff, visible test unchanged, 원본 repo head/status unchanged를 확인한다.

```bash
corepack pnpm uat:repo-matrix:real-project-business-repair -- \
  --repo /path/to/real/repo-a \
  --repo /path/to/real/repo-b \
  --min-repos 2

corepack pnpm uat:release-evidence-audit -- \
  --scenario repo-matrix-real-project-business-repair-uat
```

기대:

- `status=REAL_PROJECT_BUSINESS_REPAIR_PASS`
- `cell_count>=2`, `pass_count>=2`, `fail_count=0`
- ledger가 `codex_repair_smoke=true`, `business_repair_smoke=true`, `business_bug_repair=true`, `source_code_repair=true`, `llm_modification=true`, `hidden_acceptance=true`, `source_repos_read_only=true`, `draft_pr=false`, `builder.real_llm=true`, `builder.provider=codex`를 남긴다.
- 각 cell은 `codex_repair.status=pass`, `codex_repair.business_bug_repair=true`, `codex_repair.visible_acceptance.status=pass`, `codex_repair.hidden_acceptance.status=pass`, `codex_repair.diff_scope.status=pass`, `codex_repair.source_changed=true`, `codex_repair.visible_test_unchanged=true`, `codex_repair.source_repo_integrity.status=pass`여야 한다.
- 이 lane은 실제 repo shape의 temp clone에서 실제 Codex가 business logic fixture repair를 수행한다는 증거이며, 아직 기존 애플리케이션 업무 소스의 임의 버그 repair, GitHub draft PR, 임의/대형 repo 전체 PASS를 의미하지 않는다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-business-repair-uat/real-project-corpus-10526-1782122595998/ledger.json
```

2026-06-22 R32 real project Codex temp-clone business fixture repair는 실제 로컬 repo 2개(`html-skills-doc`, `coreline-auth-module`)에서 `REAL_PROJECT_BUSINESS_REPAIR_PASS`, `cell_count=2`, `pass_count=2`, `fail_count=0`을 남겼다. 각 repo는 원본 read-only metadata/discover smoke를 통과했고, temp clone에서 실제 Codex가 invoice-total fixture source file만 수정했으며, base visible/hidden expected fail, final visible/hidden pass, source-only diff, business bug flag, 원본 repo integrity를 검증했다. Evidence는 `/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-business-repair-uat/real-project-corpus-10526-1782122595998`에 copied 22/missing 0(manifest copied 23)으로 보존됐고, `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-business-repair-uat`도 PASS했다. 단 이 증거는 dedicated business fixture repair이며, 기존 애플리케이션 업무 소스의 임의 버그 repair·GitHub draft PR·임의/대형 repo 전체 PASS가 아니다.

기존 실제 로컬 repo의 임시 clone에서 실제 Codex가 기존 tracked source file을 고치는지 확인하려면 real Codex existing-source repair lane을 사용한다. 이 lane은 원본 repo를 수정하지 않고 각 temp clone의 기존 JS/Python source file에 syntactic regression을 커밋한 뒤, Codex CLI가 해당 기존 source file만 수정하게 한다. Hidden verifier는 original parse pass, regressed visible/hidden expected fail, final visible/hidden pass, existing-source-only diff, 원본 repo head/status unchanged를 확인한다.

```bash
corepack pnpm uat:repo-matrix:real-project-existing-source-repair -- \
  --repo /path/to/real/repo-a \
  --repo /path/to/real/repo-b \
  --repo /path/to/real/repo-c \
  --repo /path/to/real/repo-d \
  --repo /path/to/real/repo-e \
  --repo /path/to/real/repo-f \
  --repo /path/to/real/repo-g \
  --repo /path/to/real/repo-h \
  --min-repos 8

corepack pnpm uat:release-evidence-audit -- \
  --scenario repo-matrix-real-project-existing-source-repair-uat
```

기대:

- `status=REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS`
- `cell_count>=8`, `pass_count>=8`, `fail_count=0`
- ledger가 `codex_repair_smoke=true`, `existing_source_repair=true`, `source_code_repair=true`, `llm_modification=true`, `hidden_acceptance=true`, `source_repos_read_only=true`, `draft_pr=false`, `builder.real_llm=true`, `builder.provider=codex`를 남긴다.
- 각 cell은 `codex_repair.status=pass`, `codex_repair.existing_source=true`, `codex_repair.visible_acceptance.status=pass`, `codex_repair.hidden_acceptance.status=pass`, `codex_repair.diff_scope.status=pass`, `codex_repair.source_changed=true`, `codex_repair.source_repo_integrity.status=pass`여야 한다.
- 이 lane은 기존 tracked source file repair 증거이며, 아직 임의 업무 bug repair, GitHub draft PR, 임의/대형 repo 전체 PASS를 의미하지 않는다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-existing-source-repair-uat/real-project-corpus-91734-1782166010157/ledger.json
```

2026-06-22 R27 real project Codex existing-source repair는 기존 로컬 repo 2개(`improvement_loop_harness`, `build-server-cli`)에서 `REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS`, `cell_count=2`, `pass_count=2`, `fail_count=0`을 남겼다. 각 repo는 원본 read-only metadata/discover smoke를 통과했고, temp clone에서 실제 Codex가 기존 tracked source file(`apps/server/scripts/postgres-connection-check.mjs`, `web/help-content.js`)만 수정했으며, original parse pass, regressed visible/hidden expected fail, final visible/hidden pass, existing-source-only diff, 원본 repo integrity를 검증했다. `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-existing-source-repair-uat`도 manifest-backed evidence를 PASS로 감사했다.

2026-06-22 R29 public broad real project existing-source repair는 public 실제 repo 4개(`pypa/sampleproject`, `pallets/click`, `expressjs/express`, `nodeca/js-yaml`)에서 `REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS`, `cell_count=4`, `pass_count=4`, `fail_count=0`을 남겼다. 각 repo는 원본 read-only metadata/discover smoke를 통과했고, temp clone에서 실제 Codex가 기존 tracked source file(`noxfile.py`, `docs/conf.py`, `examples/auth/index.js`, `benchmark/benchmark.mjs`)만 수정했으며, original parse pass, regressed visible/hidden expected fail, final visible/hidden pass, existing-source-only diff, 원본 repo integrity를 검증했다. Evidence는 `/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-existing-source-repair-uat/real-project-corpus-53414-1782118179984`에 copied 42/missing 0(manifest copied 43)으로 보존됐고, `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-existing-source-repair-uat`도 manifest-backed evidence를 PASS로 감사했다. 단 이 증거는 syntactic regression repair smoke이며, GitHub draft PR·임의 업무 bug repair·임의/대형 repo 전체 PASS를 의미하지 않는다.

2026-06-23 R49 public broad real project existing-source repair는 public 실제 repo 8개(`pypa/sampleproject`, `pallets/click`, `expressjs/express`, `nodeca/js-yaml`, `psf/requests`, `urllib3/urllib3`, `pallets/itsdangerous`, `pypa/packaging`)에서 `REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS`, `cell_count=8`, `pass_count=8`, `fail_count=0`을 남겼다. 각 repo는 원본 read-only metadata/discover smoke를 통과했고, temp clone에서 실제 Codex가 기존 tracked source file(`noxfile.py`, `docs/conf.py`, `examples/auth/index.js`, `benchmark/benchmark.mjs`, `docs/_themes/flask_theme_support.py`, `src/urllib3/contrib/emscripten/emscripten_fetch_worker.js`, `docs/conf.py`, `benchmarks/__init__.py`)만 수정했으며, original parse pass, regressed visible/hidden expected fail, final visible/hidden pass, existing-source-only diff, 원본 repo integrity를 검증했다. Evidence는 `/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-existing-source-repair-uat/real-project-corpus-91734-1782166010157`에 copied 82/missing 0(manifest copied 83)으로 보존됐고, `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-existing-source-repair-uat`도 manifest-backed evidence를 PASS로 감사했다. Release-grade non-PR existing-source audit 기준은 8셀로 상향됐다. 단 이 증거는 syntactic regression repair smoke이며, GitHub draft PR·임의 업무 bug repair·임의/대형 repo 전체 PASS를 의미하지 않는다.

기존 source의 curated semantic behavior regression을 실제 Codex가 고치는지 확인하려면 semantic source repair lane을 사용한다. 이 lane은 원본 repo를 수정하지 않고 temp clone에서 registry에 등록된 기존 tracked source target만 고른다. 원본 visible/hidden verifier가 먼저 PASS해야 하며, behavioral regression 주입 뒤 visible/hidden이 expected fail이어야 한다. 이후 실제 Codex는 해당 기존 source file만 수정해야 하고, final visible/hidden acceptance, existing-source-only diff, source repo integrity가 모두 PASS해야 한다.

```bash
corepack pnpm uat:repo-matrix:real-project-semantic-source-repair -- \
  --repo /path/to/real/repo-a \
  --repo /path/to/real/repo-b \
  --repo /path/to/real/repo-c \
  --repo /path/to/real/repo-d \
  --repo /path/to/real/repo-e \
  --repo /path/to/real/repo-f \
  --repo /path/to/real/repo-g \
  --repo /path/to/real/repo-h \
  --min-repos 8

corepack pnpm uat:release-evidence-audit -- \
  --scenario repo-matrix-real-project-semantic-source-repair-uat
```

기대:

- `status=REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_PASS`
- `cell_count>=8`, `pass_count>=8`, `fail_count=0`
- ledger가 `codex_repair_smoke=true`, `existing_source_repair=true`, `semantic_source_repair=true`, `semantic_bug_repair=true`, `source_code_repair=true`, `llm_modification=true`, `hidden_acceptance=true`, `source_repos_read_only=true`, `draft_pr=false`, `builder.real_llm=true`, `builder.provider=codex`를 남긴다.
- 각 cell은 `codex_repair.status=pass`, `codex_repair.existing_source=true`, `codex_repair.semantic_source_repair=true`, `codex_repair.semantic_bug_repair=true`, `codex_repair.semantic_domain` non-empty, `codex_repair.visible_acceptance.status=pass`, `codex_repair.hidden_acceptance.status=pass`, `codex_repair.diff_scope.status=pass`, `codex_repair.source_changed=true`, `codex_repair.source_repo_integrity.status=pass`여야 한다.
- 이 lane은 curated semantic target registry 범위의 existing-source repair 증거이며, 아직 임의 업무 bug repair, GitHub draft PR, 임의/대형 repo 전체 PASS를 의미하지 않는다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-semantic-source-repair-uat/real-project-corpus-65706-1782142270237/ledger.json
```

2026-06-23 R41 real project semantic existing-source repair는 current repo `improvement_loop_harness`와 public `pypa/sampleproject`, `pallets/markupsafe`, `pallets/click`, `psf/requests`, `tartley/colorama`, `expressjs/express`, `nodeca/js-yaml` 8개에서 `REAL_PROJECT_SEMANTIC_SOURCE_REPAIR_PASS`, `cell_count=8`, `pass_count=8`, `fail_count=0`을 남겼다. 각 repo는 원본 read-only metadata/discover smoke를 통과했고, temp clone에서 실제 Codex가 curated semantic target(`scripts/uat/product-100-corpus.mjs` issue count summary, `src/sample/simple.py` add_one, `src/markupsafe/__init__.py` escape_silent None handling, `src/click/_compat.py` ANSI stripping, `src/requests/structures.py` HTTP header case-insensitive lookup, `colorama/ansi.py` ANSI escape sequence generation, `lib/utils.js` HTTP content-type normalization, `src/tag/scalar/int_core.ts` YAML integer resolution)만 수정했으며, original visible/hidden pass, regressed visible/hidden expected fail, final visible/hidden pass, semantic flags, existing-source-only diff, 원본 repo integrity를 검증했다. Evidence copied 98/missing 0(manifest copied 99, copied integrity checked 99)이며 `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-semantic-source-repair-uat`도 manifest-backed evidence를 PASS로 감사했다. 단 이 증거는 curated semantic target repair smoke이며, GitHub draft PR·임의 업무 bug repair·임의/대형 repo 전체 PASS를 의미하지 않는다.

기존 source repair 결과를 GitHub private evidence repo + draft PR까지 publish하려면 existing-source repair PR smoke lane을 사용한다. 이 lane은 원본 repo를 수정하지 않고 temp clone의 regressed base를 GitHub private repo `main`으로 push한 뒤, 실제 Codex가 복구한 기존 source file만 candidate branch에 commit하고 draft PR을 만든다. Shallow source clone은 publish 전에 upstream `fetch --unshallow`로 보강한다.

```bash
corepack pnpm uat:repo-matrix:real-project-existing-source-repair-pr -- \
  --repo /path/to/real/repo-a \
  --repo /path/to/real/repo-b \
  --min-repos 2 \
  --github-owner coreline-ai \
  --github-repo-prefix vibeloop-real-pr \
  --keep-remote

corepack pnpm uat:release-evidence-audit -- \
  --scenario repo-matrix-real-project-existing-source-repair-pr-uat
```

기대:

- `status=REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_PASS`
- `cell_count>=2`, `pass_count>=2`, `fail_count=0`
- ledger가 `existing_source_repair_pr_smoke=true`, `github_draft_pr=true`, `github_draft_pr_verified=true`, `draft_pr=true`, `source_repos_read_only=true`, `builder.real_llm=true`, `builder.provider=codex`를 남긴다.
- 각 cell은 `codex_repair.status=pass`, `codex_repair.github.draft_pr_verified=true`, `codex_repair.github.main_unchanged=true`, `codex_repair.github.pr_url`을 남겨야 한다.
- 이 lane은 syntactic regression repair + GitHub draft PR smoke이며, 임의 업무 bug repair나 임의/대형 repo 전체 PASS를 의미하지 않는다.

최근 확인 evidence:

```text
/Users/iriver/.vibeloop/uat-evidence/repo-matrix-real-project-existing-source-repair-pr-uat/real-project-corpus-44206-1782116705806/ledger.json
```

2026-06-22 R28 real project existing-source repair PR smoke는 기존 git repo 2개(`improvement_loop_harness`, public `pypa/sampleproject`)에서 `REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_PASS`, `cell_count=2`, `pass_count=2`, `fail_count=0`을 남겼다. 각 repo는 원본 read-only metadata/discover smoke를 통과했고, temp clone에서 실제 Codex가 기존 tracked source file(`apps/server/scripts/postgres-connection-check.mjs`, `noxfile.py`)만 수정했으며, original parse pass, regressed visible/hidden expected fail, final visible/hidden pass, existing-source-only diff, 원본 repo integrity를 검증했다. GitHub private evidence repo 2개와 open draft PR 2개도 생성/검증됐고, `main_unchanged=true`였다. `corepack pnpm uat:release-evidence-audit -- --scenario repo-matrix-real-project-existing-source-repair-pr-uat`도 manifest-backed evidence를 PASS로 감사했다.

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
| UAT가 stderr로 실패                        | 빌드 누락/오염된 stdout   | `corepack pnpm build` 후 재실행                       |
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

Product-100은 fixture PASS나 representative PASS를 제품 전체 PASS로 부르는 것을 막기 위한 최상위 UAT 계약이다. 현재 구현 상태는 **2026-06-23 local finalization run `product-100-83865-1782157755473` 기준 controlled Product-100 corpus `PRODUCT_100_CODEX_LIVE_PASS`**다. 이 PASS는 5개 controlled repo/10개 seeded issue, real Codex Builder/Challenger/Reviewer, Phase4 strict-best, Phase5 M2/M4/freeze/N+1 aggregate, Phase6 GitHub draft PR/evidence/audit, Phase7 docs truth checker 범위에 한정된다. 임의의 모든 사용자 repo에 대한 제품 전체 100% PASS가 아니다.

### Product-100 real Codex adversary reviewer 기본 wrapper

`uat:product-100:preflight`와 Phase5 runner는 별도 설정이 없으면 기본으로 `node scripts/uat/product-100-codex-reviewer.mjs --live`를 사용한다. 이 wrapper는 Codex CLI를 `exec --ephemeral --ignore-rules --sandbox read-only`로 호출해 Builder 세션과 분리된 advisory reviewer JSON만 받는다. 필요하면 아래 env로 명시 override한다.

```bash
export VIBELOOP_ADVERSARY_REVIEWER_COMMAND='node scripts/uat/product-100-codex-reviewer.mjs --live'
export VIBELOOP_ADVERSARY_REVIEWER_PROVIDER=codex
export VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM=1
```

`product-100-codex-reviewer.mjs --dry-run`은 schema/배선 확인용이며 `real_llm=false`라 Product-100 PASS 증거가 아니다. `--live`는 Codex CLI를 별도 non-interactive reviewer로 호출한다. 현재 reviewer preflight와 R1 Colima smoke는 통과 가능하다. 2026-06-23 finalization run `product-100-83865-1782157755473`에서는 Phase4 10/10 issue strict-best, Phase5 aggregate 10/10 issue real Codex reviewer proposal, M2 R1 confirmation, M4 replay, frozen rulepack, N+1 semantic gate를 통과했다. Phase6도 GitHub private corpus repo 5개와 draft PR 10개, evidence bundle + release audit을 통과했고, Phase7도 final PASS ledger가 README/Run Ledger/Runbook에 반영됐는지 결정론 checker로 확인했다.

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

실제 GitHub Actions artifact까지 재현하려면 `Product-100 Live Evidence`, `P4 Real Reviewer Live Evidence`, 또는 `Real Project Repair Evidence` workflow를 수동 실행한다. 세 workflow는 opt-in일 때만 live Codex/GitHub, live Codex reviewer, 또는 real-project repair run을 수행하고, 같은 run에서 업로드된 artifact를 다시 다운로드해 명시 scenario로 감사한다.

사전 조건:

- repository secret `PRODUCT100_GH_TOKEN`: private corpus repo 생성, branch push, draft PR 생성을 할 수 있는 PAT.
- 선택적 repository secret `REAL_PROJECT_CORPUS_GH_TOKEN`: R27/R28/R29/R32 CI workflow가 current repo 밖의 private secondary/additional repo를 clone하거나 R28 draft PR evidence용 private GitHub repo를 생성해야 할 때 사용한다. Public secondary/additional repo만 읽는 non-PR replay면 기본 `github.token`으로 충분할 수 있지만, R28 `publish_draft_prs=true` live run은 private repo 생성/branch push/draft PR 생성 권한이 있는 token이 필요하다.
- Codex CLI/OAuth 또는 해당 환경의 live Codex 인증. 이 인증이 없으면 preflight 또는 live runner가 fail-closed한다.
- Docker runtime with `node:22-alpine` and `python:3.12-alpine`.

P4 real reviewer CI artifact는 Codex ChatGPT login이 있는 runner가 필요하다. 기본 `ubuntu-latest`에 로그인 상태가 없다면 `runner_label`을 self-hosted runner로 지정한다. macOS self-hosted runner에서는 Docker bind mount가 가능한 `$HOME/.vibeloop/uat-worktrees-actions/<run>` 아래로 worktree root를 고정해야 한다. workflow는 `VIBELOOP_ADVERSARY_LIVE_WORK_ROOT`를 이 경로로 자동 설정해 `/tmp`/`/var/folders` bind mount 불일치를 피한다.

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

최신 credentialed PASS artifact는 다음 명령으로 직접 재감사할 수 있다.

```bash
corepack pnpm uat:release-evidence-audit:gh -- \
  --run-id 27943361464 \
  --run-attempt 1 \
  --repo coreline-ai/improvement_loop_harness \
  --artifact-pattern adversary-real-reviewer-evidence-27943361464-1 \
  --scenario adversary-live-real-reviewer-uat
```

R27/R28/R29/R32/R48/R49 real-project repair CI artifact는 Codex ChatGPT login이 있는 runner와 실제 git repo corpus가 필요하다. `secondary_repo`와 `additional_repos`는 `OWNER/REPO` 또는 URL을 받으며, private repo면 `REAL_PROJECT_CORPUS_GH_TOKEN` secret이 그 repo를 읽을 수 있어야 한다. 기본 `repair_mode=existing-source` non-PR 설정은 release-grade audit에서 `min_repos>=8`을 요구한다. `publish_draft_prs=true`를 주면 R28 `repo-matrix-real-project-existing-source-repair-pr-uat` artifact로 전환하고, private evidence repo 생성 + branch push + draft PR verification까지 포함한다. `include_current_repo=false`, `additional_repos`, `min_repos=8`을 쓰면 R49 public broad corpus처럼 current repo 없이 public repo 8개 이상으로 non-PR existing-source repair artifact를 만들 수 있다. `repair_mode=business-fixture`를 쓰면 R32 `repo-matrix-real-project-business-repair-uat` artifact와 downloaded artifact audit을 만든다. `repair_mode=semantic-source`는 현재 release-grade audit에서 `min_repos>=12`를 요구하며 R48 `repo-matrix-real-project-semantic-source-repair-uat` artifact와 downloaded artifact audit을 만든다. 최신 credentialed PASS artifact는 R29 non-PR public broad workflow run `27947984264`, R28 draft PR workflow run `27949790976`, R33 business fixture workflow run `27946183282`다. R49 8셀 existing-source와 semantic-source 12셀 credentialed artifact는 2026-06-23 현재 repo self-hosted runner 등록 0개라 후속 runner 가동 후 재실행/감사가 필요하다. 단 이 CI evidence도 syntactic regression repair, dedicated business fixture repair, 또는 curated semantic target repair 범위이며, 기존 애플리케이션 업무 source 임의 bug repair PASS는 아니다.

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=true \
  -f repair_mode=existing-source \
  -f runner_label=self-hosted \
  -f include_current_repo=true \
  -f secondary_repo=pypa/sampleproject \
  -f secondary_repo_ref=main \
  -f additional_repos='pallets/click,expressjs/express,nodeca/js-yaml,psf/requests,urllib3/urllib3,pallets/itsdangerous,pypa/packaging' \
  -f min_repos=8 \
  -f publish_draft_prs=false \
  -f codex_model=gpt-5.5 \
  -f codex_timeout_ms=180000
```

R49 public broad artifact를 current repo 없이 재현할 때는 public repo 8개를 `additional_repos`로 넘기고 `min_repos=8`을 강제한다.

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=true \
  -f repair_mode=existing-source \
  -f runner_label=self-hosted \
  -f include_current_repo=false \
  -f additional_repos='pypa/sampleproject
pallets/click
expressjs/express
nodeca/js-yaml
psf/requests
urllib3/urllib3
pallets/itsdangerous
pypa/packaging' \
  -f min_repos=8 \
  -f publish_draft_prs=false \
  -f codex_model=gpt-5.5 \
  -f codex_timeout_ms=180000
```

R28 draft PR artifact까지 만들 때는 `publish_draft_prs=true`와 임시 repo owner/prefix를 지정한다. 임시 repo를 증거로 남기려면 `keep_remote=true`, repo sprawl을 줄이려면 `keep_remote=false`를 사용한다.

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=true \
  -f repair_mode=existing-source \
  -f runner_label=self-hosted \
  -f include_current_repo=true \
  -f secondary_repo=pypa/sampleproject \
  -f secondary_repo_ref=main \
  -f min_repos=2 \
  -f publish_draft_prs=true \
  -f github_owner=coreline-ai \
  -f github_repo_prefix=vibeloop-real-pr-ci \
  -f keep_remote=true \
  -f codex_model=gpt-5.5 \
  -f codex_timeout_ms=180000
```

2026-06-22 R34 credentialed CI 재현성에서는 R29 public broad non-PR lane과 R28 draft PR lane을 각각 self-hosted Codex runner에서 실행했다. R29 run `27947984264`는 public 실제 repo 4개(`pypa/sampleproject`, `pallets/click`, `expressjs/express`, `nodeca/js-yaml`)로 `REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS`, `cell_count=4`, `pass_count=4`, `fail_count=0`, evidence copied 42/missing 0(manifest copied 43), downloaded artifact audit PASS를 남겼다. R28 run `27949790976`는 current repo + public `pypa/sampleproject` 2셀로 `REAL_PROJECT_EXISTING_SOURCE_REPAIR_PR_PASS`, `cell_count=2`, `pass_count=2`, `fail_count=0`, GitHub draft PR verified 2/2, `main_unchanged=true`, evidence copied 22/missing 0(manifest copied 23), downloaded artifact audit PASS를 남겼다. R28 PR URLs: [improvement_loop_harness#1](https://github.com/coreline-ai/vibeloop-real-pr-ci-r28c-1-improvement_loop_harness-11ba1471c-e2a747eef064/pull/1), [sampleproject#1](https://github.com/coreline-ai/vibeloop-real-pr-ci-r28c-2-1-sampleproject-691d2ff8e0e8-b9a40db4d5cc/pull/1).

```bash
corepack pnpm uat:release-evidence-audit -- \
  --evidence-root /tmp/vibeloop-r29-ci-evidence-27947984264 \
  --scenario repo-matrix-real-project-existing-source-repair-uat

corepack pnpm uat:release-evidence-audit -- \
  --evidence-root /tmp/vibeloop-r28c-ci-evidence-27949790976 \
  --scenario repo-matrix-real-project-existing-source-repair-pr-uat
```

R32 business fixture artifact를 재현할 때는 `repair_mode=business-fixture`를 지정한다. 이 모드는 GitHub draft PR publish를 하지 않으므로 `publish_draft_prs=false`를 사용한다.

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=true \
  -f repair_mode=business-fixture \
  -f runner_label=self-hosted \
  -f include_current_repo=true \
  -f secondary_repo=<owner>/<repo> \
  -f secondary_repo_ref=main \
  -f min_repos=2 \
  -f publish_draft_prs=false \
  -f codex_model=gpt-5.5 \
  -f codex_timeout_ms=180000
```

2026-06-22 R33 credentialed CI 재현성에서는 위 모드를 self-hosted Codex runner에서 current repo + public `coreline-ai/skills-html-showcase` 2셀로 실행했다.

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=true \
  -f repair_mode=business-fixture \
  -f runner_label=self-hosted \
  -f include_current_repo=true \
  -f secondary_repo=coreline-ai/skills-html-showcase \
  -f secondary_repo_ref=main \
  -f min_repos=2 \
  -f publish_draft_prs=false \
  -f codex_model=gpt-5.5 \
  -f codex_timeout_ms=240000
```

이 run은 `27946183282`에서 live job과 downloaded artifact audit job이 모두 PASS했다. Audit artifact는 `real-project-repair-artifact-audit-27946183282-1`, evidence artifact는 `real-project-business-repair-evidence-27946183282-1`이며, 재다운로드 후 다음 로컬 감사도 PASS해야 한다.

```bash
corepack pnpm uat:release-evidence-audit -- \
  --evidence-root /tmp/vibeloop-r32-ci-evidence-27946183282/real-project-business-repair-evidence-27946183282-1 \
  --scenario repo-matrix-real-project-business-repair-uat
```

R48 semantic source repair artifact를 재현할 때는 `repair_mode=semantic-source`를 지정한다. 이 모드는 curated semantic target registry에 매칭되는 repo가 필요하며, GitHub draft PR publish를 하지 않으므로 `publish_draft_prs=false`를 사용한다. Release-grade audit은 12셀 broad semantic corpus를 요구하므로 current repo + public `pypa/sampleproject`, `pallets/markupsafe`, `pallets/click`, `psf/requests`, `urllib3/urllib3`, `tartley/colorama`, `pallets/itsdangerous`, `pypa/packaging`, `expressjs/express`, `nodeca/js-yaml`, `sindresorhus/escape-string-regexp` 예시처럼 `min_repos=12`와 `additional_repos`를 같이 지정한다.

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=true \
  -f repair_mode=semantic-source \
  -f runner_label=self-hosted \
  -f include_current_repo=true \
  -f secondary_repo=pypa/sampleproject \
  -f secondary_repo_ref=main \
  -f additional_repos='pallets/markupsafe,pallets/click,psf/requests,tartley/colorama,expressjs/express,nodeca/js-yaml' \
  -f min_repos=8 \
  -f publish_draft_prs=false \
  -f codex_model=gpt-5.5 \
  -f codex_timeout_ms=240000
```

기존 non-PR artifact를 재감사할 때는 replay input만 지정한다. R28 artifact는 replay에도 `repair_mode=existing-source`, `publish_draft_prs=true`를 같이 넘겨 PR scenario로 감사한다. R32 artifact는 replay에도 `repair_mode=business-fixture`를 같이 넘긴다. R41 artifact는 replay에도 `repair_mode=semantic-source`, `publish_draft_prs=false`를 같이 넘긴다.

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=false \
  -f repair_mode=existing-source \
  -f replay_run_id=<run_id> \
  -f replay_run_attempt=1 \
  -f replay_repo=coreline-ai/improvement_loop_harness
```

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=false \
  -f repair_mode=existing-source \
  -f publish_draft_prs=true \
  -f replay_run_id=<run_id> \
  -f replay_run_attempt=1 \
  -f replay_repo=coreline-ai/improvement_loop_harness
```

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=false \
  -f repair_mode=business-fixture \
  -f replay_run_id=<run_id> \
  -f replay_run_attempt=1 \
  -f replay_repo=coreline-ai/improvement_loop_harness
```

```bash
gh workflow run real-project-existing-source-repair-live.yml \
  --repo coreline-ai/improvement_loop_harness \
  -f run_live=false \
  -f repair_mode=semantic-source \
  -f publish_draft_prs=false \
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

현재 이 머신에서는 R1/reviewer preflight가 통과하고, 2026-06-23 finalization 기준 Product-100 controlled corpus ledger가 `PRODUCT_100_CODEX_LIVE_PASS`로 닫힌다. 핵심 증거는 final report `/Users/iriver/.vibeloop/product-100-real-loop-St3cnO/product-100-live-report.json`, final evidence bundle `~/.vibeloop/uat-evidence/product-100-codex-live-uat/product-100-83865-1782157755473`, GitHub draft PR 10개 `coreline-ai/vibeloop-p100-product-100-83865-1782157755473-*`다. P4 semantic/M4 latest local controlled lane은 R74 evidence `~/.vibeloop/uat-evidence/adversary-live-uat/adversary-live-4729-1782367241733`로 cart+profile+order approval+inventory reservation+shipping eligibility+payment authorization+refund eligibility+coupon application+loyalty points+subscription renewal+entitlement access+gift-card redemption+seller payout+appointment cancellation 18-rule corpus, M2 confirmed 18, M4 replay-safe 18/18, 23/23 attack scenario PASS를 남겼다. Latest artifact-bound replay는 R58 workflow run `28079085647`, ledger `adversary-live-2538-1782281588903`의 15-rule P4 corpus 범위다. Latest local real reviewer evidence는 R50 `~/.vibeloop/uat-evidence/adversary-live-real-reviewer-uat/adversary-live-real-reviewer-18472-1782167542594`이며 12-rule corpus, M2 confirmed 12, M4 replay-safe 12/12, 17/17 attack scenario PASS 기준이다. 18-rule real reviewer/credentialed artifact 재현성은 아직 후속이다. Broad real project corpus는 R49에서 public 실제 repo 8개 existing-source repair + hidden verifier, R28에서 GitHub draft PR smoke, R32에서 실제 로컬 repo 2개 business fixture repair + hidden verifier, R48에서 public 실제 repo 12개 curated semantic existing-source repair + hidden verifier, R73에서 targeted business-source aggregate 5셀까지 통과했다. 다만 R28/R29/R34/R49는 syntactic regression repair smoke, R32/R33은 dedicated business fixture repair, R40/R41/R43/R45/R46/R48은 curated semantic target repair, R73은 targeted business-source repair이므로, 기존 애플리케이션 업무 source의 임의 bug repair나 임의 사용자 repo 전체에 대한 제품 전체 100% PASS는 아니다.
