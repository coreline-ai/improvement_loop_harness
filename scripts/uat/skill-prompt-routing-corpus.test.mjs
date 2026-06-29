import { describe, expect, it } from 'vitest';
import {
  buildRoutingCorpusLedger,
  findPromptVariant,
  validateRoutingParsed
} from './skill-prompt-routing-corpus.mjs';
import { defaultCorpus } from './skill-real-user-prompt-corpus-live-uat.mjs';

describe('P1 prompt routing corpus dry-run', () => {
  it('resolves all live corpus variants from the shared built-in prompt registry', () => {
    const missing = defaultCorpus.filter(
      (testCase) => !findPromptVariant(testCase)
    );

    expect(defaultCorpus).toHaveLength(56);
    expect(missing).toEqual([]);
  });

  it('validates a user_issue non-execute prompt runner result', () => {
    const testCase = defaultCorpus.find((item) => item.mode === 'user_issue');
    const variant = findPromptVariant(testCase);
    const failures = validateRoutingParsed(
      testCase,
      variant,
      {
        mode: 'user_issue',
        classification: { mode: 'user_issue', confidence: 0.9 },
        accept_authority: 'deterministic_harness_only',
        generated: { task: '/tmp/task.yaml', eval: '/tmp/eval.yaml' },
        command: { kind: 'vibeloop_improve', argv: ['improve'] },
        execute_requested: false,
        executed: false
      },
      { code: 0 }
    );

    expect(failures).toEqual([]);
  });

  it('rejects a dry-run result that tries to execute or request GitHub PR publication', () => {
    const testCase = defaultCorpus.find(
      (item) => item.mode === 'auto_discovery'
    );
    const variant = findPromptVariant(testCase);
    const failures = validateRoutingParsed(
      testCase,
      variant,
      {
        mode: 'auto_discovery',
        classification: { mode: 'auto_discovery', confidence: 0.9 },
        accept_authority: 'deterministic_harness_only',
        command: {
          kind: 'vibeloop_orchestrate',
          argv: ['orchestrate', '--github-draft-pr']
        },
        execute_requested: true,
        executed: true
      },
      { code: 0 }
    );

    expect(failures).toEqual(
      expect.arrayContaining([
        'execute_requested',
        'executed',
        'github_draft_pr_arg'
      ])
    );
  });

  it('builds a non-live, non-GitHub evidence ledger for complete dry-run coverage', () => {
    const rows = defaultCorpus.map((testCase) => ({
      id: testCase.id,
      mode: testCase.mode,
      variant_id: testCase.variant,
      pass: true,
      failures: []
    }));
    const ledger = buildRoutingCorpusLedger(rows);

    expect(ledger.status).toBe('SKILL_PROMPT_ROUTING_CORPUS_DRY_RUN_PASS');
    expect(ledger.requested_variant_count).toBe(56);
    expect(ledger.passed_variant_count).toBe(56);
    expect(ledger.failed_variant_count).toBe(0);
    expect(ledger.exact_pre_codex_coverage).toBe(true);
    expect(ledger.builder_executed).toBe(false);
    expect(ledger.github_draft_pr_verified).toBe(false);
    expect(ledger.local_pr_like).toBe(false);
    expect(ledger.not_live_codex_or_github_pass).toBe(true);
  });
});
