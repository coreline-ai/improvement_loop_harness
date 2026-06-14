---
name: vibeloop-harness
description: Run VibeLoop Harness verification for one AI code change from Codex. Use when a user asks to route a natural-language VibeLoop request, fix one issue with guarded acceptance gates, auto-discover one issue, verify an existing patch, run Codex OAuth UAT, run Skill real-user loop UAT, run adversarial failure UAT, run the self-improvement loop UAT (candidate pool + challenger selection across an issue queue), create task/eval YAML, summarize eval-report.json, or prepare a PR candidate only after deterministic VibeLoop accept/ALL_PASS.
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

1. Classify the user's natural-language intent before running anything. Use the routing table below or `scripts/classify-intent.mjs --prompt "<user prompt>"`.
2. Identify the target repo, single objective, base branch, write scope, and fixed acceptance commands.
3. Create or reuse `task.yaml` and `eval.yaml`. Use templates in `templates/` when starting from scratch; use generated eval only as minimal visible-test baseline.
4. Run one of the modes below.
5. Summarize only from `eval-report.json`; include report path and failed gates.
6. Prepare a PR candidate only when deterministic reports say it is a PR candidate.

## Intent routing

The Skill may interpret the user's prompt, but it must not invent acceptance criteria or decide pass/fail. Intent routing only selects the safest command path.

```bash
node skills/vibeloop-harness/scripts/classify-intent.mjs --prompt "<user prompt>"
```

| User intent signal | Route | Hard rule |
| --- | --- | --- |
| Specific bug/path/symptom: "fix this", "src/... fails", "quantity bug" | `user_issue` → create one task/eval then `vibeloop improve` | Exactly one issue per task/eval |
| "auto-discover", "자율 개선", "문제 찾아서 하나씩" | `auto_discovery` → `vibeloop orchestrate` | Default is substrate; add `--promote-branch` for local cumulative rediscovery, still no GitHub/live RU-3 |
| "verify only", "패치 검증만" | `verify_only` | Do not run builder edits |
| "FULL UAT", fixture baseline/catalog | `fixture_full_uat` | `FULL_UAT_PASS` is fixture baseline only |
| "real Codex", "실사용자", GitHub draft PR UAT | `codex_live_uat` | Requires real auth/repo evidence; no auto-merge |
| "적대적", "failure case", "hidden leak/tamper" | `adversarial_uat` | Fixture/advisarial lane unless live adversary is explicitly configured |
| eval-report/report summary | `report` | Summarize deterministic report only |

If classification is `unknown`, ask for: repo path, one issue vs auto-discovery, and the fixed acceptance command.

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

The command prints `selected_candidate_id` and a `selection_report` path. A PR candidate is only the `selected` candidate; if none is selected, nothing cleared the bar (no PR candidate). Do not override the selection with an LLM opinion. Quality thresholds live in `eval.yaml`'s `evaluator` block (fixed rules). If `--quality-judge` is configured, it is advisory only: it may choose among already accepted, score-tied candidates, never override accept/reject, and never makes `strict_score_improvement_every_issue=true`.

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

### self-improvement-loop-uat

Use the project script to prove the loop selects a measurably-better candidate each iteration and accumulates across an issue queue:

```bash
pnpm uat:skill-loop:self-improvement
```

For each issue it runs a verbose builder and a tight challenger; the deterministic Arbiter must select the challenger with a strictly higher fixed score (smaller, cleaner diff at equal correctness). It advances issue-by-issue, and a final fully-bad pool must yield no selection and no PR candidate. Selection is never an LLM opinion. With `VIBELOOP_UAT_GITHUB=1` it also publishes each selected patch as a draft PR against a throwaway private GitHub repo and then deletes (or archives, if the token lacks `delete_repo`) it; the default run is hermetic.

### discover / auto-discovery

Use discovery only to create candidate tasks. `vibeloop orchestrate` can discover failures, create a task, and run `improve` for bounded issues. With `--promote-branch`, it commits each selected/final-verified patch to a local integration branch and rediscovers on the updated branch. It is still not full live RU-3 until GitHub draft PR/push evidence and live Codex run are added.

```bash
vibeloop orchestrate \
  --repo <repo> \
  --eval <eval.yaml> \
  --agent <builder-spec> \
  --max-issues 1 \
  --promote-branch pr-candidate/vibeloop-auto
```

If no `eval.yaml` exists, `--generate-eval` may create a minimal visible-test eval from package scripts or `--eval-command`; do not call that hidden/adversary/policy-rich eval.

### report

Summarize `eval-report.json` with `scripts/summarize-report.mjs`; never infer acceptance without the deterministic report.

### pr-candidate

Create a PR candidate only when ALL hold (the summarizer's `prCandidate` is true):

- `decision` is `accept`
- first decision reason is `ALL_PASS`
- `quality-report.json` `status` is not `fail` (i.e. `qualified` / quality gate met)
- hidden acceptance did not leak
- `final_verification.passed` is true when using `improve`/selection flows
- protected file, diff-scope, and (when configured) `artifact-leak` gates passed
- the decision reason is not `GUARD_ARTIFACT_LEAK` (agent/artifact context·secret leak rejects at the kernel; surface as `remove_leaked_context_then_rerun`)
- human review is not required, or the user explicitly approved it

An accepted-but-unqualified run (correctness passed, quality gate failed) is NOT a PR candidate — surface it as `improve_quality_then_rerun`.

## References

- Read `references/safety.md` before handling hidden tests, OAuth, API keys, protected files, or PR candidates.
- Read `references/usage.md` for exact command patterns, intent routing examples, and template selection.
- Read `references/agents.md` for the agent-spec contract (command/mock/codex), the env/write-scope the harness gives an agent, provider independence, and Codex OAuth setup.
