import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface SkillLoopIteration {
  issueId: string;
  loopId: string;
  projectId: string;
  decision: string;
  reason: string;
  changedFiles: string[];
  summaryNextAction: string;
  prCandidateBranch: string;
  contextIsolated: boolean;
  artifactRoot: string;
  acceptedCommit: string;
}

interface SkillLoopOutput {
  status: string;
  scenario: string;
  stopReason: string;
  issueCount: number;
  acceptedIssueCount: number;
  remainingIssueCount: number;
  artifactRootsUnique: boolean;
  acceptedCommitsUnique: boolean;
  branches: string[];
  iterations: SkillLoopIteration[];
  finalUserTest: string;
}

function runScript(
  args: readonly string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe.sequential('vibeloop-harness real-user Skill loop UAT', () => {
  it('runs two isolated Skill invocations against a temporary git repo and stops when the queue is exhausted', async () => {
    const result = await runScript([
      'scripts/uat/skill-real-user-loop-uat.mjs'
    ]);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('SECRET_HIDDEN_EXPECTATION');

    const output = JSON.parse(result.stdout) as SkillLoopOutput;
    expect(output).toMatchObject({
      status: 'ALL_PASS',
      scenario: 'skill-real-user-loop-uat',
      stopReason: 'issue_queue_exhausted',
      issueCount: 2,
      acceptedIssueCount: 2,
      remainingIssueCount: 0,
      artifactRootsUnique: true,
      acceptedCommitsUnique: true,
      finalUserTest: 'npm test'
    });
    expect(output.iterations.map((iteration) => iteration.issueId)).toEqual([
      'skill-loop-cart-quantity',
      'skill-loop-sku-normalization'
    ]);
    expect(
      output.iterations.every(
        (iteration) =>
          iteration.decision === 'accept' &&
          iteration.reason === 'ALL_PASS' &&
          iteration.summaryNextAction === 'prepare_pr_candidate' &&
          iteration.contextIsolated
      )
    ).toBe(true);
    expect(output.iterations[0]?.changedFiles.sort()).toEqual([
      'src/cart.cjs',
      'tests/cart-quantity.test.cjs'
    ]);
    expect(output.iterations[1]?.changedFiles.sort()).toEqual([
      'src/cart.cjs',
      'tests/sku-normalization.test.cjs'
    ]);
    expect(output.branches).toEqual(
      expect.arrayContaining([
        'main',
        'pr-candidate/skill-loop-cart-quantity',
        'pr-candidate/skill-loop-sku-normalization'
      ])
    );
    expect(
      new Set(output.iterations.map((iteration) => iteration.artifactRoot)).size
    ).toBe(2);
    expect(
      new Set(output.iterations.map((iteration) => iteration.loopId)).size
    ).toBe(2);
  }, 120_000);
});
