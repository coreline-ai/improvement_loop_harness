---
name: vibeloop-harness
description: Run VibeLoop Harness verification for one AI code change from Codex. Use when a user asks to fix one issue with guarded acceptance gates, verify an existing patch, run Codex OAuth UAT, run Skill real-user loop UAT, run adversarial failure UAT, create task/eval YAML, summarize eval-report.json, or prepare a PR candidate only after deterministic VibeLoop accept/ALL_PASS.
---

# VibeLoop Harness

Use this skill to run VibeLoop as a thin wrapper around the project SDK/CLI. Do not reimplement gate decisions inside the skill.

## Core rules

- Treat the deterministic reports as the source of truth. A PR candidate requires ALL of: `decision=accept`, first reason `ALL_PASS`, and `quality-report.json` `status` not `fail` (i.e. `qualified`). `decision=accept` already implies hidden/protected/scope guards passed; quality is the separate fixed gate. Never call an accepted-but-unqualified run a PR candidate.
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

### fix-and-improve

Run several builder candidates for one problem and let the harness deterministically select the best-known accepted candidate. Pass `--agent` once per candidate. Selection is done by the deterministic Arbiter (fixed score + tie-break), never by an LLM, and only candidates that are `accept` AND quality-`qualified` are considered.

```bash
vibeloop improve \
  --repo <repo> \
  --task <task.yaml> \
  --eval <eval.yaml> \
  --agent '<builder-spec-a>' \
  --agent '<builder-spec-b>' \
  --project-id <project> \
  --loop-id <loop>
```

The command prints `selected_candidate_id` and a `selection_report` path. A PR candidate is only the `selected` candidate; if none is selected, nothing cleared the bar (no PR candidate). Do not override the selection with an LLM opinion. Quality thresholds live in `eval.yaml`'s `evaluator` block (fixed rules). See `docs/SELF_IMPROVEMENT_LOOP_DESIGN.md`.

### verify-only

Verify a stored patch through SDK/CLI support. Do not ask the builder agent to edit again.

### oauth-uat

Use the project script after building:

```bash
pnpm uat:codex-oauth
```

This must use ChatGPT/Codex OAuth through a local or external compatible proxy. It records only auth-header presence, never token text.

### loop-uat

Use the project script to prove multiple isolated Skill invocations against a temporary git repo:

```bash
pnpm uat:skill-loop
```

This uses a deterministic issue queue, not autonomous discovery. Each accepted iteration must have `decision=accept`, first reason `ALL_PASS`, unique artifacts, and a local `pr-candidate/<task-id>` branch in the temporary repo.

### adversarial-loop-uat

Use the project script to prove bad candidates are blocked or surfaced before PR-candidate creation:

```bash
pnpm uat:skill-loop:adversarial
```

It intentionally exercises hidden-test bypass, protected path tampering, test-integrity cheating, and context leakage. The script passes only when all failures are detected and no PR candidate is created.

### discover

Use discovery only to create candidate tasks. Do not auto-implement feature suggestions without human approval.

### report

Summarize `eval-report.json` with `scripts/summarize-report.mjs`; never infer acceptance without the deterministic report.

### pr-candidate

Create a PR candidate only when ALL hold (the summarizer's `prCandidate` is true):

- `decision` is `accept`
- first decision reason is `ALL_PASS`
- `quality-report.json` `status` is not `fail` (i.e. `qualified` / quality gate met)
- hidden acceptance did not leak
- protected file and diff-scope gates passed
- human review is not required, or the user explicitly approved it

An accepted-but-unqualified run (correctness passed, quality gate failed) is NOT a PR candidate — surface it as `improve_quality_then_rerun`.

## References

- Read `references/safety.md` before handling hidden tests, OAuth, API keys, protected files, or PR candidates.
- Read `references/usage.md` for exact command patterns and template selection.
