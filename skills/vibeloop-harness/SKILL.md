---
name: vibeloop-harness
description: Run VibeLoop Harness verification for one AI code change from Codex. Use when a user asks to fix one issue with guarded acceptance gates, verify an existing patch, run Codex OAuth UAT, create task/eval YAML, summarize eval-report.json, or prepare a PR candidate only after deterministic VibeLoop accept/ALL_PASS.
---

# VibeLoop Harness

Use this skill to run VibeLoop as a thin wrapper around the project SDK/CLI. Do not reimplement gate decisions inside the skill.

## Core rules

- Treat the deterministic eval report as the source of truth: `decision=accept` and `ALL_PASS` are required for an auto PR candidate.
- Handle one problem per run. If multiple issues exist, create one task/eval pair per issue.
- Never expose hidden acceptance tests to the builder agent.
- Never print OAuth tokens, API keys, `auth.json`, or token-like strings.
- Keep Skill logic thin: call `vibeloop run`, SDK helpers, or bundled scripts; do not duplicate decision rules.
- If risk is auth, permission, billing, database schema, deployment, secrets, admin, eval system, or unknown, require human review even if local checks pass.

## Workflow

1. Identify the target repo, single objective, base branch, write scope, and fixed acceptance commands.
2. Create or reuse `task.yaml` and `eval.yaml`. Use templates in `templates/` when starting from scratch.
3. Run one of the modes below.
4. Summarize only from `eval-report.json`; include report path and failed gates.
5. Prepare a PR candidate only when the report is accepted or the user explicitly approves human-review output.

## Modes

### fix-once

Run one builder agent against one task.

```bash
vibeloop run \
  --repo <repo> \
  --task <task.yaml> \
  --eval <eval.yaml> \
  --agent '<agent-spec>' \
  --project-id <project> \
  --loop-id <loop>
```

Use `command:<shell command>` for local/Skill-provided commands, `mock:<scenario.json>` for tests, or `codex`/Codex OAuth command specs when configured.

### verify-only

Verify a stored patch through SDK/CLI support. Do not ask the builder agent to edit again.

### oauth-uat

Use the project script after building:

```bash
pnpm uat:codex-oauth
```

This must use ChatGPT/Codex OAuth through a local or external compatible proxy. It records only auth-header presence, never token text.

### discover

Use discovery only to create candidate tasks. Do not auto-implement feature suggestions without human approval.

### report

Summarize `eval-report.json` with `scripts/summarize-report.mjs`; never infer acceptance without the deterministic report.

### pr-candidate

Create a PR candidate only when:

- `decision` is `accept`
- first decision reason is `ALL_PASS`
- hidden acceptance did not leak
- protected file and diff-scope gates passed
- human review is not required, or the user explicitly approved it

## References

- Read `references/safety.md` before handling hidden tests, OAuth, API keys, protected files, or PR candidates.
- Read `references/usage.md` for exact command patterns and template selection.
