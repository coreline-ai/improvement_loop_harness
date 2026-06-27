---
name: vibeloop-harness
description: Run VibeLoop Harness verification for one AI code change from Codex. Use when a user asks to route a natural-language VibeLoop request, fix one issue with guarded acceptance gates, auto-discover one issue, verify an existing patch, run Codex OAuth UAT, run Skill real-user loop UAT, run adversarial failure UAT, run the self-improvement loop UAT (candidate pool + challenger selection across an issue queue), create task/eval YAML, summarize eval-report.json, or prepare a PR candidate only after deterministic VibeLoop accept/ALL_PASS.
---

# VibeLoop Harness

Use this skill to run VibeLoop as a thin wrapper around the project SDK/CLI. Do not reimplement gate decisions inside the skill.

## Core rules

- Treat the deterministic reports as the source of truth. A PR candidate requires ALL of: selected candidate, `decision=accept`, first reason `ALL_PASS`, `qualified=true`, and `final_verification.passed=true`. `decision=accept` already implies hidden/protected/scope guards passed; quality and final reverify are separate fixed gates. Never call an accepted-but-unqualified or unreverified run a PR candidate.
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

For a full deterministic Skill-layer route, prefer the prompt runner. It classifies the prompt, generates one task/eval for `user_issue`, and prints the exact `vibeloop improve` or `orchestrate` command. It forwards PR-candidate publish flags (`--promote-branch`, `--github-draft-pr`, GitHub repo/token/base/branch/title options) to the underlying core command. Generated-eval safety flags (`--eval-artifact-leak`, `--eval-rulepack-lock`, `--eval-rulepack-semantic`, `--eval-hidden-test`) apply only to `auto_discovery` / `vibeloop orchestrate --generate-eval`, not to `vibeloop improve`. For an existing orchestrate eval, use the core CLI `--carry-rulepack <lock> --carry-rulepack-image <image>` path; for a single improve loop, use `--rulepack-semantic <lock> --rulepack-semantic-image <image>`. Add `--execute` only when repo path, fixed test command, and agent spec are explicit:

The prompt runner refuses `--skip-final-reverify` when `--promote-branch` or `--github-draft-pr` is present, because Skill PR candidates require fresh final re-execution.

```bash
node skills/vibeloop-harness/scripts/run-from-prompt.mjs \
  --prompt "src/cart.cjs quantity 버그를 고쳐줘. 테스트도 추가해." \
  --repo /path/to/repo \
  --out .vibeloop/task-eval \
  --test-command "npm test" \
  --agent '<builder-spec>'
```

| User intent signal                                                     | Route                                                       | Hard rule                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Specific bug/path/symptom: "fix this", "src/... fails", "quantity bug" | `user_issue` → create one task/eval then `vibeloop improve` | Exactly one issue per task/eval                                                                                                                                              |
| "auto-discover", "자율 개선", "문제 찾아서 하나씩"                     | `auto_discovery` → `vibeloop orchestrate`                   | Core supports local cumulative rediscovery and stacked draft PR publishing; real Codex/GitHub live RU-3 is still unproven                                                    |
| "verify only", "패치 검증만"                                           | `verify_only`                                               | Do not run builder edits                                                                                                                                                     |
| "FULL UAT", fixture baseline/catalog                                   | `fixture_full_uat`                                          | `FULL_UAT_PASS` is fixture baseline only                                                                                                                                     |
| "Skill prompt live", "스킬 프롬프트 실환경", SKILL.md 호출 검증        | `codex_skill_prompt_uat`                                    | Proves live Codex Skill orchestrator invokes `run-from-prompt`; `:real-builder` variants also prove real builder local flow, but still not GitHub RU-3/full improvement PASS |
| "real Codex", "실사용자", GitHub draft PR UAT                          | `codex_live_uat`                                            | Requires real auth/repo evidence; no auto-merge                                                                                                                              |
| "적대적", "failure case", "hidden leak/tamper"                         | `adversarial_uat`                                           | Fixture/advisarial lane unless live adversary is explicitly configured                                                                                                       |
| "skip final reverify", "테스트 생략", "weaken tests", "hidden 무시"    | `unknown`                                                   | Do not run a builder or create a PR candidate; ask for a safe acceptance command and keep final reverify/hidden/protected gates enabled                                      |
| eval-report/report summary                                             | `report`                                                    | Summarize deterministic report only                                                                                                                                          |

If classification is `unknown`, ask for: repo path, one issue vs auto-discovery, and the fixed acceptance command.

## Modes

### fix-once

Run one builder agent against one task.

If the user gave a specific natural-language issue and no task/eval exists yet,
create exactly one task/eval pair first:

```bash
node skills/vibeloop-harness/scripts/create-task-eval.mjs \
  --template node \
  --out .vibeloop/task-eval \
  --prompt "<specific user issue prompt>" \
  --test-command "<acceptance command>"
```

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

The command prints `selected_candidate_id` and a `selection_report` path. A PR candidate is only the `selected` candidate; if none is selected, nothing cleared the bar (no PR candidate). Do not override the selection with an LLM opinion. Quality thresholds live in `eval.yaml`'s `evaluator` block (fixed rules). If `--quality-judge` is configured, it is advisory only: it may choose among already accepted, score-tied candidates, never override accept/reject, and never makes `strict_score_improvement_every_issue=true`. If `--adversary-review` is configured, it is also advisory only: it records separate-context findings/proposed tests for M2/M4 and writes static-filter accepted proposals to `adversary-m2-handoff.json`, but never changes `decision`, `qualified`, `selected_candidate_id`, or PR-candidate status. Also pass `--adversary-reviewer-provider <provider>` when known; missing/unknown/same provider records `adversary_review.same_model_review=true` as an independence warning only. Use `vibeloop adversary-confirm --handoff ...` to inspect or explicitly execute that handoff under R1 isolation; this still does not affect the current loop accept. If M2 is actually executed and confirmed, `vibeloop adversary-rulepack-candidate --handoff ... --confirmation ...` may create a candidate-only rulepack artifact. After M4 replay is safe, `vibeloop adversary-rulepack-freeze --candidate ... --replay ... --rulepack-out ...` can freeze a `fixed_next_loop_gate` lock artifact; it is next-loop-only and never changes the current loop. Use `vibeloop rulepack inspect <lock>` before applying it. `orchestrate --generate-eval --eval-rulepack-semantic <lock> --eval-rulepack-semantic-image <image>`, `orchestrate --carry-rulepack <lock> --carry-rulepack-image <image>`, or `improve --rulepack-semantic <lock> --rulepack-semantic-image <image>` can run executable frozen rule specs as a required next-loop semantic gate; same-loop application, runtime absence, hash mismatch, and artifact leaks fail closed. Use `selection_report.selection_quality.full_autonomous_improvement_eligible=true` as the fixed evidence for a full improvement claim; advisory support alone is not enough.

### verify-only

Verify a stored patch through SDK/CLI support. Do not ask the builder agent to edit again.

### oauth-uat

Use the project script after building:

```bash
pnpm uat:codex-oauth
```

This must use ChatGPT/Codex OAuth through a local or external compatible proxy. It records only auth-header presence, never token text.

### skill-prompt-live-uat

Use this when you need to verify the natural-language Skill/LLM layer itself: a real `codex exec` session must read `SKILL.md`, invoke `scripts/run-from-prompt.mjs --execute`, and leave deterministic helper evidence. The default lane uses a command fixture builder to isolate Skill routing. The `:real-builder` variants set `VIBELOOP_SKILL_PROMPT_UAT_BUILDER=codex` and prove the same Skill prompt flow with a real Codex builder, but still only local branch/one-candidate proof — not GitHub RU-3 or full-autonomous PASS.

```bash
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-skill-prompt
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-skill-prompt:auto

# Same Skill prompt path + real Codex builder; still local/one-candidate only.
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-skill-prompt:real-builder
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-skill-prompt:auto:real-builder
```

PASS requires either `SKILL_PROMPT_LIVE_UAT_PASS` for `user_issue` or `SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS` for `auto_discovery`. In both cases the helper must execute, produce `pr_candidate=true`, pass final reverify, and create the expected local promotion branch. The `:auto` lane proves `run-from-prompt` routes to `vibeloop orchestrate --generate-eval --promote-branch`; `:real-builder` additionally proves a real Codex builder was invoked through the helper (`proxy_auth_header_seen=true`). None of these lanes proves GitHub draft PR RU-3, multi-issue auto-discovery, or strict best-fix/full improvement.

For the live RU-3 auto-discovery/GitHub lane, use the dedicated orchestrate UAT script:

```bash
VIBELOOP_UAT_KEEP_TMP=1 VIBELOOP_UAT_KEEP_REMOTE=1 pnpm uat:skill-loop:codex-live:orchestrate

# Controlled one-issue strict best-fix proof: real Codex challenger must beat
# an accepted-but-verbose comparator by fixed score.
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-live:strict-best

# Broad RU-3 strict-best proof lane: auto-discovery + verbose comparator + real Codex challenger.
# R13 confirmed controlled full improvement PASS; rulepack semantic core exists, live adversary/broad corpus remain future work.
VIBELOOP_UAT_KEEP_TMP=1 VIBELOOP_UAT_KEEP_REMOTE=1 pnpm uat:skill-loop:codex-live:orchestrate-strict-best
```

R11 reported `REAL_USER_RU3_ORCHESTRATE_VERIFICATION_PASS`, so live RU-3 verification is proven for the checked fixture scenario. R12 reported `REAL_USER_STRICT_BEST_FIX_PASS`, proving controlled one-issue strict fixed-score selection with a real Codex challenger. R13 confirmed the controlled RU-3 strict-best proof lane: every issue had `selection_quality.full_autonomous_improvement_eligible=true` and `real_codex_challenger_selected_every_issue=true`. This closes the controlled multi-issue best-fix proof, but live adversary semantic evidence and broad project corpus remain future work.

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

Use discovery only to create candidate tasks. `vibeloop orchestrate` can discover failures, create a task, and run `improve` for bounded issues. With `--promote-branch`, it commits each selected/final-verified patch to a local integration branch and rediscovers on the updated branch. With `--promote-branch --github-draft-pr`, the core can publish stacked draft PR branches. R11 proves this live RU-3 verification path with real Codex + a real GitHub repo; still do not call it full autonomous improvement until strict fixed-score improvement is proven for every issue.

```bash
vibeloop orchestrate \
  --repo <repo> \
  --eval <eval.yaml> \
  --agent <builder-spec> \
  --max-issues 1 \
  --promote-branch pr-candidate/vibeloop-auto
```

If no `eval.yaml` exists, `--generate-eval` may create a minimal visible-test eval from package scripts or `--eval-command`. Add `--eval-artifact-leak` / `--eval-forbidden-literal label=value` / `--eval-scan-patch` / `--eval-redact-gate-logs` when a deterministic leak policy can be declared. Do not call this hidden/adversary/rulepack-freeze eval generation.

### report

Summarize `eval-report.json` with `scripts/summarize-report.mjs`; pass `--selection-report <selection-report.json>` when available to surface advisory review signals. Never infer acceptance without the deterministic report.

### pr-candidate

Create a PR candidate only when ALL hold (the summarizer's `prCandidate` is true):

- `decision` is `accept`
- first decision reason is `ALL_PASS`
- `final_verification.passed=true`
- `quality-report.json` `status` is not `fail` (i.e. `qualified` / quality gate met)
- hidden acceptance did not leak
- `final_verification.passed` is true when using `improve`/selection flows
- protected file, diff-scope, and (when configured) `artifact-leak` gates passed
- the decision reason is not `GUARD_ARTIFACT_LEAK` (agent/artifact context·secret leak rejects at the kernel; surface as `remove_leaked_context_then_rerun`)
- deterministic risk policy does not require human approval, or the user explicitly approved it. Advisory review signals (`reviewAdvisoryBeforePr`) do not change `prCandidate`; they only require clear disclosure before PR publication.

An accepted-but-unqualified run (correctness passed, quality gate failed) is NOT a PR candidate — surface it as `improve_quality_then_rerun`. For single-issue publish, `improve --github-draft-pr` may push the selected/final-verified patch to a remote branch and create/reuse a GitHub draft PR. For auto-discovery, `orchestrate --promote-branch --github-draft-pr` may publish stacked draft PRs after each selected/final-verified issue. Neither path merges automatically, and neither changes deterministic selection.

## References

- Read `references/safety.md` before handling hidden tests, OAuth, API keys, protected files, or PR candidates.
- Read `references/usage.md` for exact command patterns, intent routing examples, and template selection.
- Read `references/agents.md` for the agent-spec contract (command/mock/codex), the env/write-scope the harness gives an agent, provider independence, and Codex OAuth setup.
