# Usage reference

## Template selection

- Use `templates/task-minimal.yaml` for a bounded one-issue task.
- Use `templates/eval-node.yaml` for Node.js projects with `npm test`.
- Use `templates/eval-python.yaml` for Python projects with `python -m pytest`.
- Use `templates/eval-web.yaml` for web projects that need unit tests plus build checks.

## Classify a natural-language Skill prompt

Use this before running a builder when the user's request is free-form:

```bash
node skills/vibeloop-harness/scripts/classify-intent.mjs \
  --prompt "자동으로 문제 찾아서 하나씩 수정하고 검증 PR 후보 만들어줘"
```

The output is routing metadata only. It never decides accept/reject. Important modes:

- `user_issue`: create one task/eval, then run `vibeloop improve`.
- `auto_discovery`: run `vibeloop orchestrate`; add `--promote-branch` for local cumulative rediscovery. GitHub/live RU-3 remains unproven.
- `verify_only`: verify an existing patch; do not run builder edits.
- `fixture_full_uat`: fixture baseline only, not live Codex/GitHub proof.
- `codex_live_uat`: requires real Codex/GitHub evidence.
- `adversarial_uat`: negative/adversarial lane.

## Generate task/eval from templates

```bash
node skills/vibeloop-harness/scripts/create-task-eval.mjs \
  --template node \
  --out /tmp/vibeloop-task \
  --id cart-quantity-fix \
  --title "Cart total respects quantity" \
  --objective "Fix cart total calculation and add one regression test." \
  --project cart-quantity \
  --test-command "node tests/cart-quantity.test.cjs"
```

`--test-command` updates both `task.yaml` required tests and the selected template's primary test gate.

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

## Auto-discovery substrate

```bash
node packages/cli/bin/vibeloop --data-dir .vibeloop orchestrate \
  --repo /path/to/repo \
  --eval /path/to/eval.yaml \
  --agent 'command:<builder>' \
  --max-issues 1 \
  --promote-branch pr-candidate/vibeloop-auto
```

If `eval.yaml` is absent, a minimal visible-test eval can be generated:

```bash
node packages/cli/bin/vibeloop --data-dir .vibeloop orchestrate \
  --repo /path/to/repo \
  --generate-eval \
  --eval-command "npm test" \
  --agent 'command:<builder>'
```

`--promote-branch` gives local cumulative apply + rediscovery. Do not call this full live RU-3 yet: GitHub draft PR/push evidence and real Codex RU-3 UAT are still missing.

## Multi-candidate run (fix-and-improve)

Run several builder candidates for one problem; the deterministic Arbiter selects
the best-known accepted ∧ qualified candidate by a fixed score (never an LLM).
Pass `--agent` once per candidate, and `--challenger` for candidates that run
even after acceptance to search for a measurably better one.

```bash
node packages/cli/bin/vibeloop --data-dir .vibeloop improve \
  --repo /path/to/repo \
  --task task.yaml \
  --eval eval.yaml \
  --agent 'command:<builder-a>' \
  --agent 'command:<builder-b>' \
  --challenger 'command:<tighter-variant>' \
  --project-id <project> \
  --loop-id <loop>
```

Outputs `selected_candidate_id`, `selected_patch`, `final_verification`, `advisory_tie_break`, `limits`, and a `selection_report` path.
A PR candidate is only the `selected` candidate after final reverify/provenance pass; if none is selected, nothing cleared the bar.

Optional quality tie-break among score-equal accepted candidates:

```bash
node packages/cli/bin/vibeloop --data-dir .vibeloop improve \
  --repo /path/to/repo \
  --task task.yaml \
  --eval eval.yaml \
  --agent 'command:<builder-a>' \
  --challenger 'command:<builder-b>' \
  --quality-judge "node scripts/uat/quality-judge-best-patch.mjs"
```

`--quality-judge` is advisory only and cannot promote rejected candidates or change accept/reject.

## Quality gate and PR candidate

The `evaluator:` block in `eval.yaml` is a deterministic quality gate (fixed-rule
thresholds, never an LLM). A PR candidate requires BOTH:

- `decision = accept` (verifier: hidden/protected/scope guards passed, `ALL_PASS`), and
- quality met (`qualified`; `quality-report.json` status not `fail`).

An accepted-but-unqualified run is NOT a PR candidate → next action
`improve_quality_then_rerun`.

## Running the Skill outside the monorepo

`scripts/vibeloop-run.mjs` resolves the CLI in order: `VIBELOOP_CLI` env →
monorepo `packages/cli/bin/vibeloop` → skill `vendor/vibeloop.mjs` → PATH
`vibeloop`. For a self-contained product copy, run `pnpm bundle:skill` (emits
`vendor/vibeloop.mjs`) then copy the skill folder; or install the `vibeloop` CLI
on PATH; or point `VIBELOOP_CLI` at a CLI entry.

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

## Skill real-user loop UAT

```bash
pnpm uat:skill-loop
```

This creates a temporary git repo, runs two separate Skill wrapper invocations, applies each accepted candidate patch, creates `pr-candidate/<task-id>` local branches, and stops with `issue_queue_exhausted` only after final user-level tests pass.

Adversarial negative UAT:

```bash
pnpm uat:skill-loop:adversarial
```

This passes only when hidden bypass, protected path tampering, test-integrity cheating, and context leakage are detected before PR-candidate creation.

Self-improvement loop UAT (builder pool + challenger selected across an issue queue; proves each iteration selects a measurably-better candidate and a fully-bad pool yields no PR candidate):

```bash
pnpm uat:skill-loop:self-improvement
```

Optional environment:

- `VIBELOOP_UAT_KEEP_TMP=1`
- `VIBELOOP_UAT_GITHUB=1` (self-improvement UAT only: publish selected patches as draft PRs to a throwaway private repo, then clean up)

Real Codex live UAT lanes:

```bash
pnpm uat:skill-loop:codex-live
pnpm uat:skill-loop:codex-live:multi
```

The multi lane separates `verification_status` from `full_autonomous_improvement_pass`; if `strict_score_improvement_every_issue=false`, never call it full autonomous improvement PASS.

## Report summarizer

```bash
node skills/vibeloop-harness/scripts/summarize-report.mjs --report <eval-report.json>
```

## Report fields to summarize

- `decision`
- first `decision_reasons[].code`
- `changed_files[].path`
- failed required `gate_runs`
- `improvement_evidence`
- `risk.human_approval_required`
- `artifact_refs`
- `reports/eval-report.json` path
