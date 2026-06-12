# EVAL_ENGINE_SPEC.md

## 1. 핵심 원칙

`eval.yaml`이 평가 시스템의 단일 source of truth다. `scripts/eval.sh`는 하드코딩된 gate 목록을 실행하지 않고 eval runner를 호출하는 얇은 wrapper여야 한다.

```bash
#!/usr/bin/env bash
set -euo pipefail
# 수동 실행 시 LOOP_ID 미설정을 허용한다
LOOP_ID="${LOOP_ID:-manual-$(date +%Y%m%d%H%M%S)}"
vibeloop-eval run --config eval.yaml --task "$1" --out "${VIBELOOP_DATA_DIR:-$HOME/.vibeloop}/runs/$LOOP_ID/reports"
```

정식 JSON Schema는 [../schemas/eval.schema.json](../schemas/eval.schema.json)을 따른다.

가드(`scope`/`integrity` 타입)는 대상 repo의 스크립트가 아니라 **하네스 내장(builtin) 구현**으로 실행한다. 가드를 repo 스크립트에 위임하면 (1) 대상 repo에 언어 런타임 의존성이 생기고, (2) 가드 자체가 변조 대상이 되며, (3) 하네스 업그레이드로 가드를 일괄 개선할 수 없다. eval.yaml에서는 `command: builtin:<guard-name>`으로 참조한다.

## 2. Eval Runner 책임

1. eval.yaml parse/validate (게이트 순서 규범 위반 시 config error)
2. task.yaml parse/validate
3. baseline capture 수행 또는 캐시 조회 (§7)
4. gate 실행 순서 결정 (§3 규범 강제)
5. timeout/env/cwd 적용, 명령 변수 보간 (§6)
6. stdout/stderr를 파일로 저장
7. exit code와 duration 수집
8. required gate 실패 시 fail-fast 규칙 적용 (§3)
9. test-on-base evidence 검증 수행 (§7)
10. gate-report.json 생성
11. eval-report.json에 들어갈 structured result 반환

## 3. 실행 순서와 Fail-Fast 규범

**프로젝트 명령 게이트(`npm test` 등)는 에이전트가 방금 수정한 코드를 하네스 권한으로 실행하는 행위다.** 따라서 가드 통과 전에는 어떤 프로젝트 명령도 실행해서는 안 된다.

```text
Phase 0. baseline capture          (agent 실행 전, workspace_preparing 단계)
Phase 1. builtin guard gates       (git_meta_integrity → protected_files → diff_scope → limits → test_integrity)
Phase 2. test-on-base 검증          (evidence 검증, base workspace에서 실행)
Phase 3. 프로젝트 명령 게이트         (hard → task_acceptance → regression → security → performance)
Phase 4. advisory gates            (LLM critic 포함)
```

규칙:

- eval.yaml validation 시점에 `scope`/`integrity` 타입 게이트가 모든 프로젝트 명령 게이트(`hard`/`task_acceptance`/`regression`/`security`/`performance`)보다 앞에 위치해야 한다. 위반 시 config error.
- **Phase 1의 required 가드가 하나라도 실패하면 Phase 2~4를 실행하지 않는다.** 미실행 게이트는 `status: skipped`로 기록한다.
- Phase 3에서 required gate가 실패하면 같은 phase의 나머지 게이트와 Phase 4를 `skipped` 처리한다 (fail-fast 고정).
- `skipped`는 "선행 required 실패로 실행하지 않음"을 의미하는 status다. timeout/실행 불가는 `error`다.
- 어떤 경우에도 실행 결과는 decision engine으로 수렴하며 **eval-report.json은 항상 생성된다** ([LOOP_STATE_MACHINE.md](./LOOP_STATE_MACHINE.md) §3).

## 4. Gate 타입

| 타입 | 예 | required 기본값 | 실행 주체 |
|---|---|---|---|
| `scope` | diff_scope, protected_files | true | builtin |
| `integrity` | git_meta_integrity, test_integrity, limits, snapshot_delta | true | builtin |
| `hard` | typecheck, lint, unit test, build | true | 프로젝트 명령 |
| `security` | gitleaks, semgrep, dependency audit | true/false configurable | 프로젝트 명령 |
| `task_acceptance` | required behavior tests | true | 프로젝트 명령 |
| `regression` | contract, smoke e2e | true | 프로젝트 명령 |
| `performance` | latency, bundle size | false unless task requires | 프로젝트 명령 |
| `advisory` | LLM critic, static report | false | harness/LLM |

LLM critic은 별도 커널 단계가 아니라 `advisory` 게이트의 한 구현이다. eval.yaml 설정으로 on/off와 비용을 통제한다.

## 5. Gate Result 계약

각 gate는 다음 구조로 기록된다.

```json
{
  "name": "unit_tests",
  "type": "hard",
  "required": true,
  "command": "npm test",
  "status": "pass",
  "exit_code": 0,
  "started_at": "2026-06-10T12:00:00Z",
  "finished_at": "2026-06-10T12:01:03Z",
  "duration_ms": 63000,
  "stdout_ref": "logs/gates/unit_tests.stdout.log",
  "stderr_ref": "logs/gates/unit_tests.stderr.log",
  "summary": "142 tests passed"
}
```

status 의미: `pass`(exit 0), `fail`(exit != 0), `error`(timeout/실행 불가), `skipped`(선행 required 실패로 미실행).

Gate executor는 stdout/stderr를 기본 16MB까지 보존하고 초과분은 절단 마커(`…[output truncated at 16MB]`)로 대체한다. Timeout 시 process group에 SIGTERM→SIGKILL을 보내며, SIGKILL 이후에도 종료 이벤트가 오지 않는 극단 케이스에서는 5초 safety resolve로 하네스 hang 방지를 우선한다(호스트가 잔존 프로세스 정리를 책임).

## 6. 명령 변수 보간

| 변수 | 의미 |
|---|---|
| `${TASK_FILE}` | 검증된 task.yaml 절대 경로 |
| `${BASE_COMMIT}` | base commit SHA |
| `${LOOP_ID}` | 현재 loop id |
| `${WORKTREE_ROOT}` | candidate worktree 절대 경로 |
| `${ARTIFACT_ROOT}` | 이 run의 artifact root 절대 경로 |

규칙:

- runner가 명령 실행 전에 문자열 치환한다. 변수 값은 모두 하네스가 생성한 값이며 사용자/에이전트 입력을 포함하지 않는다.
- 위 표에 없는 `${VAR}` 참조는 validation error다.
- 치환 후 명령은 `cwd=${WORKTREE_ROOT}`(또는 gate별 `cwd`)에서 scrubbed env로 실행한다.

## 7. Baseline Capture와 Test-on-Base

개선 증거는 비교 없이는 판정할 수 없다. 두 메커니즘이 evidence 판정의 입력을 만든다.

### 7.1 Baseline Capture

- 시점: `workspace_preparing` 단계, agent 실행 전의 clean worktree.
- 대상: 비교형 타입 게이트(`performance`, `security`)와 coverage 산출 게이트만 실행한다. 일반 `hard`/`task_acceptance` 테스트 게이트는 baseline에서 제외한다. hard gate는 base가 green이라는 전제로 생략 가능하되, base가 red인 경우 그 사실은 별도 재현/acceptance 경로에서 기록한다.
- 캐시: 동일 `(project, base_commit, eval.yaml content hash)` 조합의 baseline은 재사용한다 (`baseline.mode: cached_per_base_commit` 기본). 캐시 hit 시 `generated_at`은 명령 재실행 시각이 아니라 해당 loop가 캐시된 baseline을 검증·재사용한 시각이다.
- 산출: `metrics/baseline.json` (artifact).

### 7.2 Test-on-Base 검증

`adds_regression_test`/`fixes_reproduced_failure` evidence는 **"새 테스트가 base에서 실패하고 candidate에서 통과한다"**를 확인해야 인정된다. 이 검증이 없으면 base에서도 통과하는 무의미한 테스트 추가로 게이밍할 수 있다.

```text
1. candidate.patch에서 테스트 파일 변경만 추출 (test path/패턴 기준)
2. base 상태 workspace에 테스트 변경만 적용
3. task.acceptance.required_tests 실행 → 기대: fail
4. full candidate 상태에서 동일 테스트 실행 → 기대: pass
5. 결과를 reports/test-on-base.json에 기록
```

### 7.3 Evidence Detector

evidence 판정은 LLM이 아니라 detector가 수행한다. 각 detector는 artifact를 입력으로 `present | missing | inconclusive`를 산출한다.

| evidence type | detector 입력 | present 조건 |
|---|---|---|
| `fixes_reproduced_failure` | baseline 실패 기록 + candidate gate 결과 | base에서 fail이던 테스트가 candidate에서 pass |
| `adds_regression_test` | diff의 신규 테스트 + test-on-base 결과 | 신규 테스트 존재 ∧ base fail ∧ candidate pass |
| `increases_coverage` | baseline/candidate coverage | candidate > baseline ∧ test integrity pass |
| `improves_latency` | baseline/candidate benchmark | 목표치 이상 개선 ∧ 동일 benchmark 설정 |
| `reduces_security_risk` | baseline/candidate scan 결과 | finding 감소 ∧ 신규 critical 없음 |
| `removes_duplicate_code` | 중복 측정 도구 결과 + 동작 보존 테스트 | 중복 감소 ∧ regression gate pass |

baseline이 없거나 샘플이 부족하면 `inconclusive`로 기록한다. 모든 evidence 항목은 `artifact_ref`로 근거 artifact를 참조해야 한다 ([ARTIFACT_SCHEMA.md](./ARTIFACT_SCHEMA.md) §7).

### 7.3 테스트 그룹

| group | 의미 | 구현 |
|---|---|---|
| `fail_to_pass` | 새/수정 테스트가 base에서 fail, candidate에서 pass해야 evidence 인정 | 기존 test-on-base 검증 |
| `pass_to_pass` | 기존 required gate가 candidate에서도 계속 pass해야 함 | required gate + test-integrity |
| `hidden_acceptance` | agent에게 노출하지 않는 held-out 테스트 | agent 종료 후 worktree에 임시 주입, gate type `hidden_acceptance`, 실패 시 기존 `GATE_REQUIRED_FAILED` |

Hidden acceptance 테스트의 보관 위치는 대상 repo 밖 하네스 설정/입력 디렉터리다. 주입 시점은 agent 종료 후 eval 단계이며, artifact에는 테스트 내용 원문을 기록하지 않고 gate 이름·상태·로그 ref만 기록한다.

`test_integrity.forbidden_patterns`와 `suspicious_patterns`는 diff/테스트 파일 내용에 대한 보수적 substring 매칭이다. 정규식 해석이 아니므로 오탐은 가능하지만, 명시된 약화 패턴 누락을 줄이는 쪽을 우선한다.

## 8. Decision 규칙

decision engine은 아래 우선순위 표를 위에서부터 평가해 **첫 번째로 일치하는 규칙**으로 판정한다 (first-match-wins). 같은 입력은 항상 같은 출력을 내는 순수 함수여야 한다.

| 순위 | 조건 | decision | reason code |
|---:|---|---|---|
| 1 | changed files 없음 | reject | `NO_CHANGED_FILES` |
| 2 | git metadata 변조 감지 | reject | `GUARD_GIT_META_TAMPER` |
| 3 | protected path 변경 ∧ (meta-eval 비활성 ∨ task.risk_area ≠ eval_system) | reject | `GUARD_PROTECTED_PATH` |
| 4 | protected path 변경 ∧ meta-eval 활성 ∧ task.risk_area = eval_system | needs_human_review | `META_EVAL_REQUIRED` |
| 5 | write_scope 위반 또는 symlink 우회 | reject | `GUARD_SCOPE_VIOLATION` |
| 6 | test integrity 실패 | reject | `GUARD_TEST_INTEGRITY` |
| 7 | limits 초과 | reject | `GUARD_LIMIT_EXCEEDED` |
| 8 | eval-report provenance hash 불일치 | reject | `ARTIFACT_PROVENANCE_MISMATCH` |
| 9 | required gate fail/error (`hidden_acceptance` 포함) | reject | `GATE_REQUIRED_FAILED` |
| 10 | required evidence 전부 missing | reject | `EVIDENCE_MISSING` |
| 11 | evidence inconclusive | needs_more_tests | `EVIDENCE_INCONCLUSIVE` |
| 12 | risk area가 human approval 대상 또는 unknown | needs_human_review | `RISK_HUMAN_APPROVAL` |
| 13 | verifier lane의 decision/required gate status가 local과 불일치 | needs_human_review | `VERIFIER_MISMATCH` |
| 14 | 위 어디에도 해당 없음 (전부 통과) | accept | `ALL_PASS` |

- `decision_reasons`는 자유 문자열이 아니라 `{code, message, ref?}` 구조로 기록한다 ([../schemas/eval-report.schema.json](../schemas/eval-report.schema.json)).
- LLM critic은 final authority가 아니다. critic output은 `advisory_findings`로만 들어가며 위 표의 어떤 조건에도 참여하지 않는다.

### 8.1 고정 통과 의미

| 항목 | 통과 의미 | 최종 authority |
|---|---|---|
| 수정 생성 | Agent/LLM이 후보 patch 생성 | 아님 |
| 비판/적대적 리뷰 | LLM critic 또는 static reviewer가 문제 제기 | 아님, advisory |
| 테스트 실행 | 지정 gate command 결과 수집 | 부분 authority |
| 증거 검증 | 신규 테스트·보안 개선·성능 개선 evidence 탐지 | deterministic detector |
| 보호 경로 검증 | eval/schema/guard/protected file 변조 차단 | builtin guard |
| 최종 판정 | `decision: accept`, `reason: ALL_PASS` 산출 | deterministic decision engine |
| PR 생성 | accepted 또는 human approved 후보만 draft PR 생성 | orchestrator policy |

`accept`는 builtin guards, required gates(`hidden_acceptance` 포함), required evidence, fail-to-pass evidence, pass-to-pass regression, protected path/write_scope, risk policy, provenance hash, verifier policy가 모두 만족될 때만 가능하다.

`advisory_findings[].same_model_review`는 "동일 모델임이 확증됨"이 아니라 **reviewer provider independence not guaranteed**(리뷰어 provider 독립성이 보장되지 않음)를 뜻한다. Mock adapter처럼 LLM provider 독립성 논점이 없는 경우는 `false`이며, LLM 계열 또는 판별 불가 agent spec은 보수적으로 `true`다. `critic.require_different_provider: true`는 별도 provider 사용 계약을 선언하므로 `false`로 기록한다. 이 의미는 schema_version `1.1` 이후 신규 생성 report 기준이다.

## 9. `needs_more_tests` 기준

다음 경우 reject보다 `needs_more_tests`가 적합하다.

- patch는 목표와 관련 있어 보이나 required regression test가 없음
- performance 개선 주장은 있으나 baseline/candidate 샘플이 부족 (`inconclusive`)
- behavior는 수정됐으나 edge case evidence가 부족
- critic이 추가 테스트를 요구했고 deterministic gate는 아직 실패하지 않음

required evidence가 **전부 missing**이면 reject(`EVIDENCE_MISSING`), **일부 present이거나 inconclusive가 섞여 있으면** needs_more_tests(`EVIDENCE_INCONCLUSIVE`)다.

## 10. eval.yaml 예시

```yaml
schema_version: "1.0"
project: vibeloop-web
mode: autonomous-improvement-loop

protected_paths:
  - .env
  - .env.*
  - eval.yaml
  - scripts/eval.sh
  - .github/workflows/

human_approval_risk_areas:
  - auth
  - permission
  - billing
  - database_schema
  - deployment
  - ci_cd
  - eval_system
  - secrets
  - admin
  - security_policy

risk_classification:
  auth:
    - src/features/auth/
    - src/app/api/auth/
  database_schema:
    - prisma/
  ci_cd:
    - .github/

limits:
  max_changed_files: 20
  max_changed_lines: 500
  agent_timeout_seconds: 1800

test_integrity:
  forbidden_patterns:
    - "test.skip"
    - "describe.skip"
    - "it.only"
    - "describe.only"
    - "@ts-ignore"
    - "eslint-disable"
  suspicious_patterns:
    - "expect(true).toBe(true)"
    - "expect(1).toBe(1)"

baseline:
  mode: cached_per_base_commit

improvement_evidence:
  required_any:
    - fixes_reproduced_failure
    - adds_regression_test

gates:
  - name: git_meta_integrity
    type: integrity
    command: builtin:git-meta-integrity
    required: true
    timeout_seconds: 30

  - name: protected_files
    type: scope
    command: builtin:protected-files
    required: true
    timeout_seconds: 30

  - name: diff_scope
    type: scope
    command: builtin:diff-scope
    required: true
    timeout_seconds: 30

  - name: limits
    type: integrity
    command: builtin:limits
    required: true
    timeout_seconds: 30

  - name: test_integrity
    type: integrity
    command: builtin:test-integrity
    required: true
    timeout_seconds: 60

  - name: typecheck
    type: hard
    command: npm run typecheck
    required: true
    timeout_seconds: 300

  - name: unit_tests
    type: hard
    command: npm test
    required: true
    timeout_seconds: 600
```

`risk_classification`은 harness가 변경 파일 경로로 risk area를 재분류할 때 쓰는 매핑이다. 어떤 매핑에도 해당하지 않으면서 task의 allowed 경로 밖 위험 신호가 있는 변경은 `unknown`으로 분류하고 보수적으로 `needs_human_review` 처리한다 ([TASK_PROTOCOL.md](./TASK_PROTOCOL.md) §4).

## 11. eval-report

최종 report schema는 [../schemas/eval-report.schema.json](../schemas/eval-report.schema.json)을 따른다. 현재 생성 버전은 schema_version: `1.1`이며, `provenance`가 required다. 검증기는 과거 `1.0` report의 provenance 부재를 하위 호환으로 허용한다.

### 11.1 Verifier 비교 의미론

Verifier lane의 독립성은 판정 로직 독립이 아니라 **환경 독립**이다. 비교 대상은 `decision`과 required gate의 `name/status`뿐이며, duration·timestamp·log 내용 차이는 mismatch로 보지 않는다. MVP 기본 정책은 `local` required이고, `strict` 정책은 CI/external lane 일치가 필요하다. CI artifact 자동 수집은 후속이며 현재 계약은 artifact 첨부/수동 회수 가능 형태다.
