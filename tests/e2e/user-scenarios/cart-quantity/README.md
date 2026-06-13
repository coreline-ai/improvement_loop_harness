# Real user scenario: cart quantity bugfix

This scenario exercises the VibeLoop CLI with a real temporary git repository and a real shell command agent (`command:node agent-fix.cjs`). It does not use `mock:<scenario.json>`.

User story:

1. A target project has a cart total bug: quantity is ignored.
2. The task asks the agent to fix the calculation and add a regression test.
3. The harness checks write scope, protected paths, limits, visible acceptance, fail-on-base evidence, hidden acceptance, and final decision.
4. Expected result: `accept` with `ALL_PASS`.

Run via:

```bash
pnpm test:e2e -- tests/e2e/user-scenarios/real-user-flow.e2e.test.ts
```
