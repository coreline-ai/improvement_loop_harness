import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface ProgressionEntry {
  issueId: string;
  selectedCandidateId: string;
  builderScore: number;
  selectedScore: number;
  scoreImprovement: number;
  builderChangedFiles: number;
  selectedChangedFiles: number;
  summaryNextAction: string;
  prCandidateBranch: string;
  contextIsolated: boolean;
}

interface SelfImproveOutput {
  status: string;
  scenario: string;
  stopReason: string;
  fixableIssueCount: number;
  acceptedIssueCount: number;
  adversarialIssueCount: number;
  everyIterationImproved: boolean;
  artifactRootsUnique: boolean;
  acceptedCommitsUnique: boolean;
  progression: ProgressionEntry[];
  adversarial: {
    candidateCount: number;
    acceptedCount: number;
    selectedCandidateId: string | null;
    allRejected: boolean;
    prCandidateBlocked: boolean;
  };
  branches: string[];
  github: { published: boolean; reason?: string };
}

function runScript(
  args: readonly string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.resolve('.'),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Force the hermetic path: never touch GitHub from the e2e suite.
      env: { ...process.env, VIBELOOP_UAT_GITHUB: '0' }
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

describe.sequential('vibeloop-harness self-improvement Skill loop UAT', () => {
  it('selects a measurably-better candidate each iteration and blocks a fully-bad pool', async () => {
    const result = await runScript([
      'scripts/uat/skill-self-improvement-loop-uat.mjs'
    ]);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('SECRET_HIDDEN_EXPECTATION');

    const output = JSON.parse(result.stdout) as SelfImproveOutput;
    expect(output).toMatchObject({
      status: 'SELF_IMPROVE_PASS',
      scenario: 'skill-self-improvement-loop-uat',
      stopReason: 'issue_queue_exhausted',
      fixableIssueCount: 2,
      acceptedIssueCount: 2,
      adversarialIssueCount: 1,
      everyIterationImproved: true,
      artifactRootsUnique: true,
      acceptedCommitsUnique: true
    });

    // Each iteration must show the challenger strictly improving on the builder.
    expect(output.progression).toHaveLength(2);
    for (const entry of output.progression) {
      expect(entry.selectedCandidateId.endsWith('-c1')).toBe(true);
      expect(entry.scoreImprovement).toBeGreaterThan(0);
      expect(entry.selectedScore).toBeGreaterThan(entry.builderScore);
      expect(entry.selectedChangedFiles).toBeLessThanOrEqual(
        entry.builderChangedFiles
      );
      expect(entry.summaryNextAction).toBe('prepare_pr_candidate');
      expect(entry.contextIsolated).toBe(true);
    }

    // The fully-bad pool clears nothing: no selection, no PR candidate.
    expect(output.adversarial).toMatchObject({
      candidateCount: 2,
      acceptedCount: 0,
      selectedCandidateId: null,
      allRejected: true,
      prCandidateBlocked: true
    });

    // Only the two accepted issues produced PR-candidate branches.
    expect(output.branches).toEqual([
      'main',
      'pr-candidate/skill-loop-cart-quantity',
      'pr-candidate/skill-loop-sku-normalization'
    ]);

    // The e2e path never publishes to GitHub.
    expect(output.github.published).toBe(false);
  }, 180_000);
});
