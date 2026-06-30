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
- `auto_discovery`: run `vibeloop orchestrate`; add `--promote-branch` for local cumulative rediscovery, and `--github-draft-pr` for stacked draft PR publishing. Bounded R11/R163/R164 evidence covers real Codex/GitHub prototype proof for the targeted paths; do not treat it as 56-variant GitHub final full, strict-best/full autonomous improvement, or arbitrary/large-repo product-wide PASS.
- `verify_only`: verify an existing patch; do not run builder edits.
- `fixture_full_uat`: fixture baseline only, not live Codex/GitHub proof.
- `codex_skill_prompt_uat`: verifies a live Codex Skill orchestrator reads `SKILL.md` and invokes `run-from-prompt`; default builder is fixture, while `:real-builder` variants prove real builder local flow only.
- `codex_live_uat`: requires real Codex/GitHub evidence.
- `adversarial_uat`: negative/adversarial lane.

## Run from a natural-language prompt

Use the prompt runner when the Skill receives a free-form user request and should
produce the concrete VibeLoop command path instead of leaving routing implicit:

```bash
node skills/vibeloop-harness/scripts/run-from-prompt.mjs \
  --prompt "src/cart.cjs quantity 버그를 고쳐줘. quantity가 없으면 기본값 1로 계산하고 테스트도 추가해." \
  --repo /path/to/repo \
  --out .vibeloop/task-eval \
  --test-command "npm test" \
  --agent '<builder-spec>'
```

For `user_issue`, it creates exactly one task/eval pair and returns a
`vibeloop improve` command. For `auto_discovery`, it returns a
`vibeloop orchestrate` command. The runner forwards core PR-candidate publish
flags (`--promote-branch`, `--github-draft-pr`, GitHub repo/token/base/branch
and title options) and generated-eval safety flags (`--eval-artifact-leak`,
`--eval-forbidden-literal`, `--eval-rulepack-lock`,
`--eval-rulepack-semantic`, `--eval-hidden-test`) so the
natural-language Skill route does not drop the core hardening options. Passing
`--execute` runs the generated command and embeds the parsed deterministic CLI
result. The runner is a Skill-layer routing helper only; accept/reject/selection
still come from VibeLoop reports. For an existing orchestrate eval, apply a
frozen semantic gate with the core CLI `--carry-rulepack <lock>
--carry-rulepack-image <image>` path; for a single improve loop use
`--rulepack-semantic <lock> --rulepack-semantic-image <image>`.

## Live Skill prompt UAT

Use this lane to close the gap between "helper works in fixture tests" and "a real Codex Skill session can call the helper". It starts `codex exec`, asks it to read `SKILL.md`, and requires the session to invoke `run-from-prompt.mjs --execute` against a temporary repo.

```bash
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-skill-prompt
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-skill-prompt:auto

# Same Skill prompt path + real Codex builder; still local/one-candidate only.
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-skill-prompt:real-builder
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-skill-prompt:auto:real-builder
```

Expected status is `SKILL_PROMPT_LIVE_UAT_PASS` for user_issue or `SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS` for auto_discovery. The default underlying builder is a deterministic command fixture. The `:real-builder` variants additionally prove the helper invoked a real Codex builder through the ChatGPT OAuth proxy, but they remain local branch/one-candidate evidence. Bounded GitHub auto-discovery proof exists in R11/R163/R164; strict best-fix/full autonomous improvement still requires its own qualifying evidence.

Prototype acceptance UAT:

```bash
corepack pnpm uat:prototype-acceptance
```

R164 on 2026-06-30 is the latest prototype P0/P1 hardening evidence. `corepack pnpm uat:prototype-acceptance` passed Gitea preflight, 2-variant real Codex Gitea PR-like, retry-loop, and targeted local-pr-like evidence audit checks (4/4 PASS). Durable Gitea evidence is recorded at `/Users/iriver/.vibeloop/uat-evidence/skill-real-user-prompt-corpus-live-uat/skill-prompt-corpus-live-13659-1782777198300/ledger.json`; retry evidence at `/Users/iriver/.vibeloop/uat-evidence/prototype-failure-retry-loop-uat/prototype-retry-loop-16333-1782777198765/ledger.json`; and acceptance evidence at `/Users/iriver/.vibeloop/uat-evidence/prototype-acceptance-uat/prototype-acceptance-12965-1782777025246/ledger.json`.

GitHub auto-discovery single-smoke evidence is a prototype PASS for repo `coreline-ai/vibeloop-skill-prompt-auto-discovery-19396-1782777457900`: PR #1 is OPEN draft, auto-merge is null, and the selected patch hash is bound to the PR diff hash with normalized diff match true. This is prototype-targeted evidence only, not 56-variant GitHub final full, not strict-best/full autonomous improvement, and not arbitrary/large-repo product-wide PASS.

For live RU-3 auto-discovery with real Codex builder and real GitHub stacked draft PRs:

```bash
VIBELOOP_UAT_KEEP_TMP=1 VIBELOOP_UAT_KEEP_REMOTE=1 pnpm uat:skill-loop:codex-live:orchestrate

# Controlled strict best-fix proof(1 issue): accepted verbose comparator vs real Codex challenger.
VIBELOOP_UAT_KEEP_TMP=1 pnpm uat:skill-loop:codex-live:strict-best

# Broad RU-3 strict-best proof lane: auto-discovery + verbose comparator + real Codex challenger.
# R13 confirmed controlled full improvement PASS; rulepack semantic core exists, live adversary/broad corpus remain future work.
VIBELOOP_UAT_KEEP_TMP=1 VIBELOOP_UAT_KEEP_REMOTE=1 pnpm uat:skill-loop:codex-live:orchestrate-strict-best
```

Expected verification status is `REAL_USER_RU3_ORCHESTRATE_VERIFICATION_PASS` (confirmed by R11). This proves live RU-3 verification only; it is still not broad full autonomous improvement unless `full_autonomous_improvement_pass=true` and each issue reports strict fixed-score improvement. For controlled one-issue strict best-fix proof, run `pnpm uat:skill-loop:codex-live:strict-best`; R12 confirmed `REAL_USER_STRICT_BEST_FIX_PASS` for one issue with a real Codex challenger.

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

For a natural-language user issue, keep the prompt as the task objective while
still producing exactly one task/eval pair:

```bash
node skills/vibeloop-harness/scripts/create-task-eval.mjs \
  --template node \
  --out .vibeloop/task-eval \
  --prompt "src/cart.cjs quantity 버그를 고쳐줘. quantity가 없으면 기본값 1로 계산하고 테스트도 추가해." \
  --test-command "npm test"
```

This is deterministic scaffolding, not LLM acceptance. The generated JSON marks
`single_issue_policy=true`; the harness gates still decide pass/fail.

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
  --eval-artifact-leak \
  --eval-forbidden-literal issue_id=ISSUE-123 \
  --eval-scan-patch \
  --eval-redact-gate-logs \
  --eval-rulepack-lock policy/rulepack.lock.json \
  --eval-rulepack-semantic policy/rulepack.lock.json \
  --eval-rulepack-semantic-image node:22-alpine \
  --eval-hidden-test hidden_cart=/secure/hidden/cart.hidden.cjs:tests/hidden/cart.hidden.cjs:"node tests/hidden/cart.hidden.cjs" \
  --agent 'command:<builder>'
```

`--generate-eval` creates only a minimal visible-test contract from detected package scripts or `--eval-command`. The `--eval-artifact-leak` options add deterministic leak policy guards to the generated eval. `--eval-rulepack-lock <path>` adds a `builtin:rulepack-lock` lock/provenance gate and `rulepack_lock` config for a pre-existing frozen next-loop rulepack; relative lock paths are added to `protected_paths`. `--eval-rulepack-semantic <path> --eval-rulepack-semantic-image <image>` adds a required `builtin:rulepack-semantic` gate that executes hash-bound frozen rule specs in R1 isolation and fails closed on same-loop application, missing runtime, hash mismatch, or artifact leak. If an eval already exists, use `orchestrate --carry-rulepack <path> --carry-rulepack-image <image>` instead; it writes an overlay eval without changing the source eval file. `--eval-hidden-test name=source:target:command` adds an explicit hidden acceptance test whose source is supplied by the operator and copied into the worktree only during verification. It still does not invent hidden/adversary tests, broad M4 replay corpora, or project semantic policy; M2-confirmed proposal replay corpus generation is handled by `adversary-rulepack-replay-corpus`.

`--promote-branch` gives local cumulative apply + rediscovery. Adding `--github-draft-pr` publishes stacked draft PR branches from the selected/final-verified patches. R11 proves the same orchestrate path with real Codex and a real GitHub repo for verification; do not call it full autonomous improvement until strict best-fix fields are true.

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

Optional adversary advisory review for the selected patch:

```bash
node packages/cli/bin/vibeloop improve \
  --repo /path/to/repo \
  --task task.yaml \
  --eval eval.yaml \
  --agent '<builder-spec>' \
  --adversary-review '<separate-context-reviewer-command>' \
  --adversary-reviewer-provider anthropic \
  --adversary-require-different-provider
```

`--adversary-review` receives a fixed adversarial prompt (“do not approve; try to break it”), only public task/acceptance metadata, and the selected patch. The prompt version/hash are recorded in `adversary_review`. The reviewer returns findings/proposed tests, which are statically filtered and saved as `adversary_review`; static-filter accepted proposals are also written to `adversary_review.m2_handoff_ref` as `adversary-m2-handoff.json`. It cannot change `decision`, `qualified`, `selected_candidate_id`, or PR-candidate status.

Provider independence is an observability signal, not an accept gate. If `--adversary-reviewer-provider` is missing, unknown, or the same as the selected builder provider, `adversary_review.same_model_review=true` means reviewer independence is not guaranteed. `--adversary-require-different-provider` records the intended contract; if identity still cannot prove separation, the report keeps `same_model_review=true` and raises the advisory review signal.

To inspect or execute the M2 handoff separately:

```bash
node packages/cli/bin/vibeloop adversary-confirm \
  --handoff <adversary-m2-handoff.json> \
  --objective-term <task-term> \
  --out m2-confirmation.json
```

Actual R1-isolated execution is opt-in:

```bash
node packages/cli/bin/vibeloop adversary-confirm \
  --handoff <adversary-m2-handoff.json> \
  --execute \
  --candidate-worktree /path/to/candidate-worktree \
  --base-worktree /path/to/base-worktree \
  --image node:22-alpine \
  --test-command "node tests/adversary/example.test.cjs" \
  --objective-term <task-term>
```

If the container runtime is unavailable, `adversary-confirm --execute` reports `runtime_available=false`, `executed=false`, `all_confirmed=false`, and exits nonzero; it must never be treated as confirmed. Handoff proposals still require M2 isolation and M4 replay/freeze before they can become a next-loop fixed gate.

After a real executed M2 confirmation reports `all_confirmed=true`, create only a next-step rulepack candidate:

```bash
node packages/cli/bin/vibeloop adversary-rulepack-candidate \
  --handoff <adversary-m2-handoff.json> \
  --confirmation m2-confirmation.json \
  --current-rulepack policy/rulepack.json \
  --out adversary-rulepack-candidate.json
```

`adversary-rulepack-candidate` is candidate-only: `authority=candidate_only`, `decision_impact=none`, and `next_step=m4_replay_freeze_required`. It rejects dry-run or unconfirmed M2 reports. Do not use this artifact as a fixed gate. After M4 replay/freeze, use `orchestrate --generate-eval --eval-rulepack-semantic <lock> --eval-rulepack-semantic-image <image>`, `orchestrate --carry-rulepack <lock> --carry-rulepack-image <image>`, or `improve --rulepack-semantic <lock> --rulepack-semantic-image <image>` on a later loop to execute frozen rule bodies as a required next-loop quality gate; this still does not affect the current loop accept.

After a real executed M2 confirmation is converted into a rulepack candidate,
you can generate an operator-reviewable replay corpus from the confirmed
adversary proposal bodies:

```bash
node packages/cli/bin/vibeloop adversary-rulepack-replay-corpus \
  --handoff <adversary-m2-handoff.json> \
  --candidate adversary-rulepack-candidate.json \
  --test-command "node tests/adversary/example.test.cjs" \
  --out adversary-replay-corpus.json
```

This is still not LLM authority and not current-loop accept. It packages
M2-confirmed proposals into deterministic replay cases so M4 can execute them
under isolation. Operators should review/extend the corpus before freezing
rules; project semantic policy and broad known-good/known-bad corpora are still
future work.

Then run M4 replay under R1 isolation. Without `--execute`, this command only
validates the corpus shape and emits `execute_required`; it is not replay-safe
and cannot be frozen.

```bash
node packages/cli/bin/vibeloop adversary-rulepack-replay \
  --corpus adversary-replay-corpus.json \
  --execute \
  --worktree /path/to/replay-corpus-worktree \
  --image node:22-alpine \
  --out m4-replay-result.json
```

If the container runtime is unavailable, `adversary-rulepack-replay --execute`
reports `runtime_available=false`, `executed=false`, `replaySafe=false`, and exits
nonzero. The emitted replay result is freeze-compatible but fails closed.

After M4 replay has produced a replay-safe corpus result, freeze the candidate
for the **next loop only**:

```bash
node packages/cli/bin/vibeloop adversary-rulepack-freeze \
  --candidate adversary-rulepack-candidate.json \
  --replay m4-replay-result.json \
  --rulepack-out policy/rulepack.lock.json \
  --out adversary-rulepack-freeze.json
```

`adversary-rulepack-freeze` writes `authority=fixed_next_loop_gate` / `decision_impact=next_loop_only` only when the candidate is append-only, M4 replay is safe, and the rules did not affect the current loop. It rejects `--applied-to-current-loop`, replay-unsafe, missing source loop metadata, or mutated/non-append-only candidates. A frozen rulepack is still a next-loop artifact; current-loop `decision` and `selected_candidate_id` remain unchanged. `builtin:rulepack-semantic` executes its frozen rule specs only as a later-loop required gate and fails closed on same-loop application, unavailable runtime, hash mismatch, or artifact leak.

Use `vibeloop rulepack inspect <frozen.json>` before wiring a lock into a next loop. It reports lock validity, executable rule count, and `semantic_ready`; invalid locks exit nonzero.

## Quality gate and PR candidate

The `evaluator:` block in `eval.yaml` is a deterministic quality gate (fixed-rule
thresholds, never an LLM). A PR candidate requires BOTH:

- `decision = accept` (verifier: hidden/protected/scope guards passed, `ALL_PASS`), and
- quality met (`qualified`; `quality-report.json` status not `fail`).

An accepted-but-unqualified run is NOT a PR candidate → next action
`improve_quality_then_rerun`.

Optional single-issue GitHub draft PR publish after deterministic selection:

```bash
node packages/cli/bin/vibeloop improve \
  --repo /path/to/repo \
  --task task.yaml \
  --eval eval.yaml \
  --agent '<builder-spec>' \
  --github-draft-pr \
  --github-repo owner/repo \
  --github-token-env GITHUB_TOKEN \
  --github-base main \
  --github-branch pr-candidate/<loop-id>
```

`--github-draft-pr` only runs when a candidate is selected after final reverify/provenance. It pushes one remote branch and creates or reuses a draft PR; it never merges and never changes the deterministic selection.

Optional auto-discovery stacked draft PR publish:

```bash
node packages/cli/bin/vibeloop orchestrate \
  --repo /path/to/repo \
  --eval eval.yaml \
  --agent '<builder-spec>' \
  --max-issues 2 \
  --promote-branch pr-candidate/vibeloop-auto \
  --github-draft-pr \
  --github-repo owner/repo \
  --github-token-env GITHUB_TOKEN \
  --github-base main \
  --github-branch-prefix pr-candidate
```

`orchestrate --promote-branch --github-draft-pr` publishes one stacked draft PR per selected/final-verified issue. It is core/fixture verified. The live RU-3 lane is `pnpm uat:skill-loop:codex-live:orchestrate`; R11 produced `REAL_USER_RU3_ORCHESTRATE_VERIFICATION_PASS` with real Codex + real GitHub evidence. This remains verification-only unless strict best-fix/full improvement fields are true.

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

The multi lane separates `verification_status` from `full_autonomous_improvement_pass`; if `strict_score_improvement_every_issue=false` or `selection_quality.full_autonomous_improvement_eligible=false`, never call it full autonomous improvement PASS.

## Report summarizer

```bash
node skills/vibeloop-harness/scripts/summarize-report.mjs \
  --report <eval-report.json> \
  --selection-report <selection-report.json>
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
- optional `selection_report` path
- optional advisory review signal: `advisoryReviewRecommended` / `reviewAdvisoryBeforePr`

When `--selection-report` contains `adversary_review.requires_human_review_signal=true`, the summarizer keeps `nextAction=prepare_pr_candidate` if deterministic gates passed, but also sets `reviewAdvisoryBeforePr=true`. This is disclosure, not an accept/reject gate.
