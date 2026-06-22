import { describe, expect, it } from 'vitest';
import {
  buildLiveRunnerBlockAuditReport,
  parseArgs
} from './ci-live-runner-block-audit.mjs';

describe('CI live runner blocked audit report', () => {
  it('preserves the runner preflight blocker as the audit reason', () => {
    const report = buildLiveRunnerBlockAuditReport({
      workflowName: 'Real Project Repair Evidence',
      evidenceScenario: 'repo-matrix-real-project-semantic-source-repair-uat',
      runId: '123',
      runAttempt: '1',
      preflight: {
        status: 'blocked',
        can_run_live: false,
        runner_label: 'codex-live',
        reason: 'SELF_HOSTED_RUNNER_UNAVAILABLE',
        matching_online_runner_count: 0
      }
    });

    expect(report).toMatchObject({
      status: 'blocked',
      scenario: 'ci-live-runner-block-audit',
      mode: 'runner-preflight-evidence-only',
      workflow_name: 'Real Project Repair Evidence',
      evidence_scenario: 'repo-matrix-real-project-semantic-source-repair-uat',
      reason: 'SELF_HOSTED_RUNNER_UNAVAILABLE',
      live_evidence_ran: false,
      live_evidence_pass: false,
      runner_preflight: {
        runner_label: 'codex-live',
        matching_online_runner_count: 0
      }
    });
  });

  it('uses a generic next step for token/query blockers', () => {
    const report = buildLiveRunnerBlockAuditReport({
      workflowName: 'P4 Real Reviewer Live Evidence',
      evidenceScenario: 'adversary-live-real-reviewer-uat',
      preflight: {
        status: 'blocked',
        can_run_live: false,
        reason: 'RUNNER_QUERY_TOKEN_UNAVAILABLE'
      }
    });

    expect(report.reason).toBe('RUNNER_QUERY_TOKEN_UNAVAILABLE');
    expect(report.next_step).toContain(
      'Resolve the live runner preflight blocker'
    );
  });

  it('parses CLI arguments', () => {
    expect(
      parseArgs([
        '--preflight-file',
        'runner.json',
        '--output',
        'audit.json',
        '--workflow-name',
        'workflow',
        '--evidence-scenario',
        'scenario',
        '--run-id',
        '123',
        '--run-attempt',
        '2'
      ])
    ).toMatchObject({
      preflightFile: 'runner.json',
      output: 'audit.json',
      workflowName: 'workflow',
      evidenceScenario: 'scenario',
      runId: '123',
      runAttempt: '2'
    });
  });
});
