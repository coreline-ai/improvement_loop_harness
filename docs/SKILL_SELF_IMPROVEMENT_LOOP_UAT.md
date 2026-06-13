# Skill Self-Improvement Loop UAT

이 문서는 `pnpm uat:skill-loop:self-improvement`가 검증하는 실사용형 self-improvement loop 시나리오를 설명한다.

## 목적

이 UAT는 루프가 단순히 “한 번 수정하고 통과”에서 멈추지 않고, 동일한 문제에 대해 더 나은 후보를 탐색한 뒤 deterministic Arbiter가 더 좋은 후보를 선택하는지 확인한다.

핵심 검증식:

```text
builder candidate accepted
+ challenger candidate accepted
+ challenger fixed score > builder fixed score
+ selected_candidate = challenger
+ selected patch passes deterministic verifier gates
= self-improvement progressed
```

LLM이 자기 결과를 평가하지 않는다. 후보 생성은 agent가 하지만, 통과와 선택은 커널 gate와 고정 Arbiter score로 결정된다.

## 고정 적합도(fitness)와 "더 좋은 방향"

"자가 개선이 더 좋은 방향으로 갔다"는 것을 **절대 LLM이 바꾸지 못하는 고정 공식** 위의 점수 증가로 정의한다.

```text
score = evidence_present * 100 - changed_files * 5 - changed_lines
```

- `evidence_present`: 재현 가능한 개선 증거(base에서 실패하고 candidate에서 통과하는 회귀 테스트 등) 개수 — 클수록 좋다.
- `changed_files`, `changed_lines`: diff 크기 — 작을수록 좋다.

즉 "정답은 같지만 더 작고 깔끔한 변경"이 더 높은 점수를 받는다. UAT는 매 issue마다 두 후보를 만든다.

| 후보               | 플래그         | 정답      | diff                              | 기대                         |
| ------------------ | -------------- | --------- | --------------------------------- | ---------------------------- |
| `verbose` builder  | `--agent`      | gate 통과 | 큼(불필요 주석 + 별도 notes 파일) | 채택되나 점수 낮음           |
| `tight` challenger | `--challenger` | gate 통과 | 작음(최소 변경)                   | **선택, 점수 strictly 높음** |

challenger round는 통과 후보가 있어도 **항상** 실행되어 더 나은 후보를 탐색한다(복구가 아니라 탐색). 실패한 challenger는 통과 후보를 끌어내리지 못한다.

### 실측 점수 (2026-06-13)

```text
skill-loop-cart-quantity
  c0 verbose : evidence=1 files=3 lines=17 -> 68
  c1 tight   : evidence=1 files=2 lines=6  -> 84   <- 선택 (+16)
skill-loop-sku-normalization
  c0 verbose -> 68
  c1 tight   -> 84                                 <- 선택 (+16)
```

## 실행 명령

```bash
pnpm uat:skill-loop:self-improvement
```

E2E 단축 명령:

```bash
pnpm test:skill-loop:self-improvement
```

## 시나리오

| 단계 | 내용                            | 기대 결과                                              |
| ---- | ------------------------------- | ------------------------------------------------------ |
| 1    | cart quantity 문제 실행         | verbose builder와 tight challenger 모두 통과           |
| 2    | Arbiter 선택                    | 더 작은 diff의 tight challenger 선택                   |
| 3    | 선택 patch 적용/commit          | `pr-candidate/skill-loop-cart-quantity` 생성           |
| 4    | sku normalization 문제 실행     | 이전 문제 context 누설 없이 동일 루프 반복             |
| 5    | Arbiter 선택                    | 더 작은 diff의 tight challenger 선택                   |
| 6    | 선택 patch 적용/commit          | `pr-candidate/skill-loop-sku-normalization` 생성       |
| 7    | fully-bad adversarial pool 실행 | accepted 후보 0, selected 후보 없음, PR 후보 생성 금지 |

## 통과 기준

UAT stdout JSON은 아래 조건을 모두 만족해야 한다.

| 필드                     | 기대값                            |
| ------------------------ | --------------------------------- |
| `status`                 | `SELF_IMPROVE_PASS`               |
| `scenario`               | `skill-self-improvement-loop-uat` |
| `stopReason`             | `issue_queue_exhausted`           |
| `fixableIssueCount`      | `2`                               |
| `acceptedIssueCount`     | `2`                               |
| `adversarialIssueCount`  | `1`                               |
| `everyIterationImproved` | `true`                            |
| `artifactRootsUnique`    | `true`                            |
| `acceptedCommitsUnique`  | `true`                            |
| `github.published`       | 기본값 `false`                    |

각 progression entry는 아래 조건을 만족해야 한다.

- `selectedCandidateId`가 challenger 후보(`-c1`)다.
- `scoreImprovement > 0`이다.
- `selectedScore > builderScore`다.
- `selectedChangedFiles <= builderChangedFiles`다.
- `summaryNextAction = prepare_pr_candidate`다.
- `contextIsolated = true`다.

Adversarial pool은 아래 조건을 만족해야 한다.

- `candidateCount = 2`
- `acceptedCount = 0`
- `selectedCandidateId = null`
- `allRejected = true`
- `prCandidateBlocked = true`

## GitHub draft PR 옵션

기본 실행은 hermetic local UAT이며 GitHub에 접근하지 않는다.

GitHub draft PR까지 확인하려면 다음 환경 변수를 사용한다.

```bash
VIBELOOP_UAT_GITHUB=1 pnpm uat:skill-loop:self-improvement
```

동작:

1. throwaway private GitHub repo를 생성한다.
2. harness-selected patch를 issue별 draft PR branch로 push한다.
3. draft PR을 생성한다.
4. 기본적으로 repo를 삭제한다.
5. token에 `delete_repo` 권한이 없으면 archive를 시도한다.

원격 repo를 남기려면 다음을 사용한다.

```bash
VIBELOOP_UAT_GITHUB=1 VIBELOOP_UAT_KEEP_REMOTE=1 pnpm uat:skill-loop:self-improvement
```

## 지식 축적 (다음 개선에 활용)

각 issue의 `improve` 실행은 결정론적 selection report를 남긴다.

```text
<dataDir>/projects/<projectId>/selections/<loopId>.json
```

후보별 `decision`, `qualified`, `score`(evidence/files/lines/total), 선택된 후보 id가 기록된다. 이 report들이 누적되는 것이 "다음 개선에 활용 가능한 경험"의 결정론적 원장이다. 점수 프로파일과 선택 근거가 영구 기록되므로 생성기(builder 풀)는 "어떤 형태의 변경이 더 높은 점수를 받았는지"를 학습/개선할 수 있다.

핵심 불변식: **합격선(커널 gate + Arbiter 공식)은 절대 변하지 않는다.** 학습은 생성기를 개선할 뿐, 통과 기준을 느슨하게 만들지 못한다. 자율 개선은 고정된 엄격한 검증/평가 _안에서_ 편입된다. 자세한 설계는 `SELF_IMPROVEMENT_LOOP_DESIGN.md` 참조.

## 신뢰 경계

- Builder/Challenger는 patch 후보만 생성한다.
- Verifier gate가 correctness를 결정한다.
- Arbiter는 고정 score로 후보를 선택한다.
- LLM output은 accept/selection authority가 아니다.
- fully-bad pool은 통과 후보가 없으므로 selection과 PR candidate가 모두 없어야 한다.

## 관련 파일

- `scripts/uat/skill-self-improvement-loop-uat.mjs`
- `tests/e2e/skill-productization/skill-self-improvement-loop.e2e.test.ts`
- `tests/e2e/user-scenarios/skill-loop/agent-candidate.cjs`
- `tests/e2e/user-scenarios/skill-loop/agent-regression.cjs`
- `packages/cli/src/commands/improve.ts`
