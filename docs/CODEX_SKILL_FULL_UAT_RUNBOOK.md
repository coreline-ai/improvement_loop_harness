# Codex Skill Full UAT Runbook

작성일: `2026-06-14 KST`  
대상: `vibeloop-harness` Codex Skill 제품화 검증

## 0. 목적

이 문서의 목적은 기존 runbook을 참고하는 것이 아니라, **실제 사용자가 Skill을 설치해서 외부 프로젝트에 적용하는 환경과 유사한 외부 설치본 UAT를 실행**하는 것이다. 단, 여기서의 `FULL_UAT_PASS`는 **fixture/command-agent 기반 deterministic baseline**이며, 실 Codex/LLM + 실 GitHub draft PR lane의 PASS가 아니다. 실사용자 live 증거는 [`SKILL_REAL_USER_SCENARIO.md`](./SKILL_REAL_USER_SCENARIO.md)의 RU-1/RU-2 Ledger로 분리한다.

최신 prototype P0/P1 hardening 증거는 2026-06-30 R164의 `corepack pnpm uat:prototype-acceptance` 4/4 PASS다. 이 증거는 Gitea preflight, 2-variant real Codex Gitea PR-like, retry-loop, targeted local-pr-like evidence audit 범위이며, 이 문서의 fixture baseline scope를 대체하지 않는다. 즉 R164는 prototype-targeted acceptance 증거이고, 56-variant GitHub final full, strict-best/full autonomous improvement, 임의/대형 repo product-wide PASS가 아니다.

검증해야 하는 핵심은 다음 4가지다.

1. Skill이 monorepo 내부 경로가 아니라 **복사된 외부 Skill 설치본 + bundled vendor CLI**로 동작한다.
2. Task/Eval은 사용자가 직접 손으로 만든 fixture가 아니라 **복사된 Skill의 template/script**로 생성된다.
3. 후보 생성은 in-memory mock이 아니라 **실제 command agent exec(fixture agent)** 로 수행된다. 실 Codex/LLM은 이 문서의 범위 밖이다.
4. PR 후보는 `selected + decision=accept + reason=ALL_PASS + qualified=true`일 때만 만들어진다.

## 1. 실행 명령

```bash
corepack pnpm uat:skill-loop:full
```

동일 명령은 내부적으로 다음을 수행한다.

```bash
corepack pnpm bundle:skill
node scripts/uat/skill-real-user-full-uat.mjs
```

release evidence까지 재감사하려면 full fixture evidence와 prompt live real-builder evidence를 함께 검사한다.

```bash
corepack pnpm uat:skill-loop:full:release-evidence-audit
```

실사용자 자연어 표현이 안전한 Skill 모드로 라우팅되는지 clean copied Skill install 기준으로 확인하려면 prompt matrix lane을 실행한다.

```bash
corepack pnpm uat:skill-loop:prompt-matrix
corepack pnpm uat:skill-loop:prompt-matrix:release-evidence-audit
```

실제 Codex login 환경에서 full fixture UAT, 자연어 user_issue live, 자연어 auto_discovery live, combined release audit을 한 번에 돌리는 heavy lane은 아래 명령이다.

```bash
corepack pnpm uat:skill-loop:full-live
```

반복/seed 지정:

```bash
VIBELOOP_FULL_UAT_SEED=20260614 \
VIBELOOP_FULL_UAT_ROUNDS=20 \
corepack pnpm uat:skill-loop:full
```

임시 산출물 보존:

```bash
VIBELOOP_UAT_KEEP_TMP=1 corepack pnpm uat:skill-loop:full
```

## 2. 실제 사용자 환경 재현 방식

`scripts/uat/skill-real-user-full-uat.mjs`는 기존 in-repo UAT를 호출하지 않는다. 매 실행마다 아래를 새로 만든다.

| 단계 | 실제 사용자 환경 대응                                        | 검증 내용                                     |
| ---- | ------------------------------------------------------------ | --------------------------------------------- |
| 1    | `/tmp/.../codex-skill-install/vibeloop-harness`에 Skill 복사 | monorepo 내부 `packages/cli` 없이 실행        |
| 2    | `vibeloop-harness/vendor/vibeloop.mjs` 사용                  | bundled vendor CLI 동작                       |
| 3    | `/tmp/.../real-user-project-*` 외부 git repo 생성            | 실제 사용자가 보유한 프로젝트 역할            |
| 4    | 복사된 Skill의 `scripts/create-task-eval.mjs` 실행           | template 기반 `task.yaml`/`eval.yaml` 생성    |
| 5    | fixture command agent 실행                                   | mock 없이 candidate patch 생성                |
| 6    | eval report / quality report / selection report 검증         | 고정 Verifier + 고정 Evaluator + Arbiter 증명 |
| 7    | 통과 후보만 `pr-candidate/*` branch 생성                     | PR 후보 생성 조건 검증                        |

## 3. 이번 full UAT가 실제로 찾아낸 문제

초기 full UAT에서 `vendor/vibeloop.mjs`는 외부 Skill 복사본에서 schema 파일을 찾지 못했다.

```text
ENOENT: no such file or directory, open '/tmp/.../schemas/task.schema.json'
```

이 오류는 기존 in-repo UAT로는 잡히지 않는다. 실제 사용자처럼 Skill 폴더만 복사해서 실행할 때만 드러난다.

해결 기준:

- `scripts/bundle-skill.mjs`가 `schemas/`를 Skill 제품 복사본에 포함해야 한다.
- task-protocol schema loader는 monorepo schema 경로와 bundled Skill schema 경로를 모두 지원해야 한다.
- full UAT는 이 vendor/schema 경로를 매번 외부 설치본에서 검증한다.

## 4. 최종 통과 공식 — fixture baseline 한정

```text
FIXTURE_FULL_UAT_PASS =
  copied_skill_vendor_cli_ok
  ∧ positive_queue_all_selected_and_qualified
  ∧ negative_false_pass_count == 0
  ∧ artifact_leak_false_negative_count == 0
  ∧ quality_fail_never_creates_pr_candidate
  ∧ self_improvement_selection_matches_fixed_arbiter
  ∧ deterministic_tie_selects_first_candidate
```

PR 후보 생성 조건은 더 엄격하다.

```text
PR_CANDIDATE = selected_candidate_id != null
               ∧ selected_report.decision == accept
               ∧ selected_report.decision_reasons[0].code == ALL_PASS
               ∧ quality_report.met == true
```

## 5. 필수 케이스 세트

상시 검증용 상세 케이스 카탈로그는 [CODEX_SKILL_FULL_UAT_CASE_CATALOG.md](CODEX_SKILL_FULL_UAT_CASE_CATALOG.md)를 기준으로 한다.

현재 full UAT는 seed 기반 random stress 이전에 아래 필수 케이스를 모두 실행한다. 필수 케이스만 각각 1회씩 확인하려면 `VIBELOOP_FULL_UAT_ROUNDS=0 corepack pnpm uat:skill-loop:full`을 사용한다.

| 그룹             | 케이스                              | 기대                                                       |
| ---------------- | ----------------------------------- | ---------------------------------------------------------- |
| Positive queue   | cart quantity fix                   | selected, `ALL_PASS`, `qualified=true`, PR branch 생성     |
| Positive queue   | SKU normalization fix               | selected, `ALL_PASS`, `qualified=true`, PR branch 생성     |
| No-op            | no change                           | `reject / NO_CHANGED_FILES`                                |
| Hidden bypass    | visible-only hardcode               | visible pass 후 hidden gate fail, PR 차단                  |
| Source omission  | test-only no source                 | required gate fail, PR 차단                                |
| Protected path   | `.env` tamper                       | `GUARD_PROTECTED_PATH`                                     |
| Protected path   | `eval.yaml` tamper                  | `GUARD_PROTECTED_PATH`                                     |
| Protected path   | `tests/hidden/` tamper              | `GUARD_PROTECTED_PATH`                                     |
| Test integrity   | `test.skip`                         | `GUARD_TEST_INTEGRITY`                                     |
| Test integrity   | `it.only`                           | `GUARD_TEST_INTEGRITY`                                     |
| Test integrity   | fake assertion                      | `GUARD_TEST_INTEGRITY`                                     |
| Scope            | README/outside write                | `GUARD_SCOPE_VIOLATION`                                    |
| Scope            | symlink/path escape                 | `GUARD_SCOPE_VIOLATION`                                    |
| Artifact leak    | previous issue id in agent stdout   | `GUARD_ARTIFACT_LEAK`                                      |
| Artifact leak    | hidden sentinel in candidate patch  | `GUARD_ARTIFACT_LEAK`                                      |
| Token policy     | token-like agent stdout default     | redact-only + accept                                       |
| Token policy     | token-like agent stdout opt-in      | `GUARD_ARTIFACT_LEAK`                                      |
| Gate log policy  | token-like project gate stdout      | redact-only + accept                                       |
| Quality gate     | correctness accept but quality fail | `decision=accept`, `qualified=false`, `pr_candidate=false` |
| Self-improvement | builder pass + challenger better    | challenger selected                                        |
| Self-improvement | builder pass + challenger fail      | builder remains selected                                   |
| Self-improvement | builder fail + challenger pass      | challenger selected                                        |
| Self-improvement | all fail                            | selected null, no PR candidate                             |
| Arbiter tie      | equal score tie                     | first candidate selected deterministically                 |

## 6. 성공 JSON 핵심 필드

예상 출력 구조:

```jsonc
{
  "status": "FULL_UAT_PASS", // fixture baseline status; not real Codex/GitHub PASS
  "proof_scope": "fixture_baseline_only",
  "not_live_codex_or_github_pass": true,
  "scenario": "skill-real-user-full-uat",
  "evidence_bundle": "~/.vibeloop/uat-evidence/skill-real-user-full-uat/...",
  "evidence_manifest": "~/.vibeloop/uat-evidence/skill-real-user-full-uat/.../uat-evidence-manifest.json",
  "evidence_missing_count": 0,
  "actual_user_environment": {
    "copied_skill_install": true,
    "vendor_cli": "vibeloop-harness/vendor/vibeloop.mjs",
    "external_user_repo": true,
    "task_eval_created_by_copied_skill_script": true,
    "command_agents": true
  },
  "positive": {
    "accepted_issue_count": 2,
    "pr_candidate_branch_count": 2
  },
  "negative": {
    "unexpected_accept": 0
  },
  "failure_rate": {
    "unexpectedAccept": 0,
    "unexpectedReject": 0,
    "hiddenLeak": 0,
    "stderrLeak": 0
  }
}
```

## 7. Codex 판정 기준

Codex는 이 문서에 대해 아래처럼 보고한다.

```text
FULL_UAT: PASS|FAIL
actual_skill_path: PASS|FAIL
external_user_repo: PASS|FAIL
skill_template_task_eval: PASS|FAIL
positive_pr_candidate_rule: PASS|FAIL
negative_false_pass: 0/N
self_improvement: PASS|FAIL
quality_gate: PASS|FAIL
artifact_leak: PASS|FAIL
random_stress_rounds: N
remaining_blockers:
- ...
```

`FULL_UAT: PASS`는 `corepack pnpm uat:skill-loop:full` 실제 실행 성공 없이는 선언할 수 없다.
