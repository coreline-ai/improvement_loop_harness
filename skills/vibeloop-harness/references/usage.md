# Usage reference

## Template selection

- Use `templates/task-minimal.yaml` for a bounded one-issue task.
- Use `templates/eval-node.yaml` for Node.js projects with `npm test`.
- Use `templates/eval-python.yaml` for Python projects with `python -m pytest`.
- Use `templates/eval-web.yaml` for web projects that need unit tests plus build checks.

## Standard run

```bash
pnpm build
node packages/cli/bin/vibeloop --data-dir .vibeloop run \
  --repo /path/to/repo \
  --task task.yaml \
  --eval eval.yaml \
  --agent 'command:<agent command>' \
  --project-id <project> \
  --loop-id <loop>
```

## Codex OAuth UAT

```bash
pnpm uat:codex-oauth
```

Optional environment:

- `VIBELOOP_UAT_MODEL`
- `VIBELOOP_UAT_REASONING_EFFORT`
- `VIBELOOP_UAT_OAUTH_PROXY_URL`
- `VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL`
- `VIBELOOP_UAT_KEEP_TMP=0`

## Report fields to summarize

- `decision`
- first `decision_reasons[].code`
- `changed_files[].path`
- failed required `gate_runs`
- `improvement_evidence`
- `risk.human_approval_required`
- `artifact_refs`
- `reports/eval-report.json` path
