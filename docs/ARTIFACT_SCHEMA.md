# ARTIFACT_SCHEMA.md

## 1. 목적

Artifact Archive는 “왜 이 patch가 accept/reject 되었는지”를 재현할 수 있게 만드는 증거 저장소다.

## 2. Run Directory Layout

Artifact root는 **대상 repo 밖** 하네스 데이터 디렉터리에 둔다 (예: `~/.vibeloop/projects/<project-id>/runs/<loop-id>/`). repo 내부에 두면 에이전트가 같은 파일시스템 경계 안에서 artifact를 변조할 수 있고 git status를 오염시킨다 ([SECURITY_MODEL.md](./SECURITY_MODEL.md) §3). 아래 `.runs/<loop-id>/` 표기는 이 root의 상대 표기다.

```text
.runs/<loop-id>/
├── manifest.json
├── input/
│   ├── task.yaml
│   ├── eval.yaml
│   ├── base_commit.txt
│   └── env-snapshot.json
├── workspace/
│   └── workspace-ref.json
├── patches/
│   ├── candidate.patch
│   ├── changed-files.json
│   └── diffstat.txt
├── logs/
│   ├── agent.stdout.log
│   ├── agent.stderr.log
│   ├── eval-runner.log
│   └── gates/
│       ├── unit_tests.stdout.log
│       └── unit_tests.stderr.log
├── reports/
│   ├── gate-report.json
│   ├── test-on-base.json
│   ├── adversarial-report.json
│   └── eval-report.json
├── metrics/
│   ├── baseline.json
│   ├── candidate.json
│   ├── baseline-gates/      # 구조화 metric (baseline gate별, gate가 기록)
│   │   └── <gate>.json
│   └── gates/               # 구조화 metric (candidate gate별, gate가 기록)
│       └── <gate>.json
└── integrity/
    ├── git-meta-before.json
    └── git-meta-after.json
```

- `metrics/gates/<gate>.json`, `metrics/baseline-gates/<gate>.json`: gate command가 `VIBELOOP_METRICS_FILE` env가 가리키는 경로에 기록하는 구조화 metric (N4). 하네스 제어 artifact root 하위(worktree·write_scope 밖)라 builder agent가 사전 주입할 수 없다. stdout regex 대비 우선이며, schema validation(알려진 key + finite number)을 통과한 값만 evidence에 쓰인다 ([EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §7.1).
- `test-on-base.json`: 신규 테스트의 fail-on-base → pass-on-candidate 검증 결과 ([EVAL_ENGINE_SPEC.md](./EVAL_ENGINE_SPEC.md) §7.2)
- `integrity/git-meta-*.json`: agent 실행 전후 `.git` config/hooks 해시 스냅샷 ([SECURITY_MODEL.md](./SECURITY_MODEL.md) §4)

## 3. manifest.json

```json
{
  "schema_version": "1.0",
  "loop_id": "loop-0018",
  "task_id": "auth-invalid-login-401",
  "project_id": "proj_123",
  "base_commit": "abc123",
  "created_at": "2026-06-10T12:00:00Z",
  "artifact_root": ".runs/loop-0018",
  "status": "completed"
}
```

## 4. changed-files.json

```json
{
  "base_commit": "abc123",
  "files": [
    {
      "path": "src/features/auth/login.ts",
      "status": "modified",
      "allowed_by_write_scope": true,
      "protected": false
    }
  ],
  "untracked_files": [],
  "renames": [],
  "symlinks": []
}
```

## 5. Retention Policy

| decision                         | 기본 보존 |
| -------------------------------- | --------: |
| accepted/approved (PR 생성 포함) |     180일 |
| needs_human_review               |     180일 |
| rejected                         |      30일 |
| failed                           |      30일 |
| cancelled                        |       7일 |

보안 로그와 secret scan output은 **artifact 기록 시점에 하네스가** redaction 후 저장한다 (gitleaks 등의 출력은 발견한 secret 원문을 포함하므로 기록 전 마스킹이 필수다).

retention 만료 시 하네스 cleanup job이 디스크 artifact와 DB의 `Artifact` row를 함께 삭제한다. 삭제도 audit 가능해야 하므로 manifest와 삭제 기록은 보존한다.

## 6. 불변성

- terminal run의 artifact는 수정하지 않는다.
- retry는 새 loop-id와 새 artifact root를 가진다.
- terminal run의 manifest에는 artifact별 sha256 checksum을 **필수로** 기록한다. checksum은 변조 탐지가 목적이므로 선택이 아니다.

## 7. Evidence Binding

`eval-report.json`의 모든 evidence는 artifact path를 참조해야 한다.

예:

```json
{
  "type": "adds_regression_test",
  "status": "present",
  "artifact_ref": "patches/candidate.patch",
  "supporting_gate": "unit_tests"
}
```

## 8. eval-report 1.1 provenance

`eval-report.json` schema_version `1.1`은 hash 기반 `provenance`를 필수로 가진다: harness/decision engine version, task/eval config hash, candidate patch hash, gate artifact hashes, `generated_by: "harness"`. 과거 `1.0` report는 provenance 부재를 하위 호환으로 허용하지만 신규 report는 1.1로 생성한다.

Hidden acceptance 테스트 내용은 artifact에 기록하지 않는다. manifest에는 생성된 결과 artifact의 checksum만 기록하며, hidden 테스트 원문은 대상 repo 밖 보관소에 남는다.
