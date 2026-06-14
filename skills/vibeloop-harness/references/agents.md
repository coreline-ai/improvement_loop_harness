# Agent reference (builder / challenger / adversary specs)

The harness runs an agent in an isolated git worktree, then judges the result
deterministically. The agent only proposes a change; it never decides
accept/reject or selection. This doc is the contract for wiring your own agent.

## Agent spec forms

Pass a spec to `--agent` (and `--challenger` for `improve`). Four forms:

| Spec                    | Use                                          | Example                     |
| ----------------------- | -------------------------------------------- | --------------------------- |
| `command:<shell>`       | Any local CLI/script that edits the worktree | `command:node fix-agent.js` |
| `mock:<scenario.json>`  | Deterministic fixture for tests/UATs         | `mock:/tmp/scenario.json`   |
| `codex`                 | Codex CLI (ChatGPT) — must be logged in      | `codex`                     |
| `codex exec --cd ... -` | Explicit Codex command form                  | (auto-built from `codex`)   |

`improve` takes `--agent` once per candidate and `--challenger` once per
challenger candidate. Selection across accepted ∧ qualified candidates is done
by the deterministic Arbiter (fixed score), never an LLM.

## What the harness gives the agent

The agent runs with `cwd` = the candidate worktree (a clean checkout at the base
commit) and these env vars:

| Env                   | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `VIBELOOP_WORKTREE`   | absolute path of the worktree the agent must edit          |
| `VIBELOOP_TASK_FILE`  | absolute path to the validated `task.yaml` (the objective) |
| `VIBELOOP_LOOP_ID`    | this candidate's loop id                                   |
| `VIBELOOP_PROJECT_ID` | project id                                                 |

The agent reads the task from `VIBELOOP_TASK_FILE`, edits files under the
worktree, and exits 0. It does NOT commit — the harness extracts the diff.

## What the agent MUST respect

- **write_scope**: edit only paths allowed by `task.yaml` `write_scope.allowed`.
  Anything outside (or a `protected_paths` hit) fails `diff_scope` /
  `protected_files`.
- **One bounded issue**: stay within `limits` (changed files/lines). Larger
  diffs fail `limits` and score worse.
- **Evidence**: produce the `required_evidence` (e.g. add a regression test that
  fails on base and passes on the candidate) or the run is rejected.
- **Never print secrets or prior-issue context**: agent stdout/stderr is scanned
  by the artifact-leak guard. A forbidden literal (or opted-in token) → reject;
  token-like content is always redacted. With `scan_patch`, the same applies to
  the patch. See `references/safety.md`.
- **Never read hidden tests**: hidden acceptance is injected by the harness after
  the agent runs; it is not in the worktree the agent sees.

## Bring-your-own agent (command spec)

A minimal command agent:

```bash
#!/usr/bin/env bash
set -euo pipefail
task="$VIBELOOP_TASK_FILE"            # read the objective
cd "$VIBELOOP_WORKTREE"               # edit here, within write_scope
# ...apply your fix + add a regression test...
# do NOT print tokens / prior issue ids; exit 0 on success
```

Inline env in a command spec works (the command runs via a shell), e.g. to
parameterize one script into variants:

```text
--agent     'command:VARIANT=verbose node agent.js'
--challenger 'command:VARIANT=tight   node agent.js'
```

## Provider independence (builder vs adversary)

For the adversary/refiner lanes the harness prefers a **different provider** from
the builder so one model does not grade its own work. `codex` resolves to the
`openai` provider; set the reviewer/adversary to a different known provider (or
`require_different_provider`) so the independence check passes. Provider identity
is resolved deterministically from the spec — see
`docs/SELF_IMPROVEMENT_LOOP_DESIGN.md` §7.

## Codex OAuth (ChatGPT login, no token text)

Codex specs can run through a local/external OpenAI-compatible proxy. Point the
CLI at it and never print token text — only auth-header presence is recorded.

```bash
vibeloop run ... --agent codex --llm-proxy-url http://127.0.0.1:<port>
```

The bundled OAuth UAT proves this end to end (records header presence only):

```bash
pnpm uat:codex-oauth
```

Relevant env (UAT): `VIBELOOP_UAT_OAUTH_PROXY_URL`,
`VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL`, `VIBELOOP_UAT_MODEL`,
`VIBELOOP_UAT_REASONING_EFFORT`. See `references/usage.md` and
`references/safety.md`.
