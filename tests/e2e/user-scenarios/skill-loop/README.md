# Skill real-user loop UAT scenario

This scenario is a deterministic stand-in for a real user asking the `vibeloop-harness` Skill to fix multiple issues one by one.

## Target repo

The UAT script creates a temporary git repo from `target-template/` with two independent defects:

1. `calculateTotal()` ignores `quantity`.
2. `normalizeSku()` does not trim and uppercase SKU values.

The base repo intentionally has only shallow tests that pass before the fixes. Each loop iteration introduces one visible regression test and one hidden acceptance test.

## Loop contract

- Run exactly one issue per Skill invocation.
- Use a unique `loopId`, `projectId`, `dataDir`, and task/eval pair per issue.
- Keep hidden acceptance files outside the builder agent context.
- Accept only `decision=accept` with first reason `ALL_PASS`.
- Apply the accepted candidate patch to the temporary git repo, commit it, and create a local `pr-candidate/<task-id>` branch.
- Stop only when the issue queue is exhausted and final user-level tests pass.
