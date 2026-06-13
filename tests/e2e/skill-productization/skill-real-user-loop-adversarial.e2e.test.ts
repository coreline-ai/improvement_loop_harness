import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface AdversarialCaseOutput {
  caseId: string;
  detected: boolean;
  actualDecision: string;
  reason: string;
  cliExitCode: number;
  summaryNextAction: string;
  prCandidateCreated: boolean;
  hiddenTextLeaked: boolean;
  failedGate?: string;
  leakedPreviousContext?: boolean;
}

interface AdversarialOutput {
  status: string;
  scenario: string;
  caseCount: number;
  detectedCaseCount: number;
  blockedPrCandidateCount: number;
  hiddenLeakCount: number;
  cases: AdversarialCaseOutput[];
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

describe.sequential('vibeloop-harness adversarial Skill loop UAT', () => {
  it('detects hidden bypass, protected path tampering, test cheating, and context leakage without creating PR candidates', async () => {
    const result = await runScript([
      'scripts/uat/skill-real-user-loop-adversarial-uat.mjs'
    ]);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('SECRET_HIDDEN_EXPECTATION');

    const output = JSON.parse(result.stdout) as AdversarialOutput;
    expect(output).toMatchObject({
      status: 'ADVERSARIAL_PASS',
      scenario: 'skill-real-user-loop-adversarial-uat',
      caseCount: 4,
      detectedCaseCount: 4,
      blockedPrCandidateCount: 4,
      hiddenLeakCount: 0
    });
    expect(output.cases.map((item) => item.caseId)).toEqual([
      'hidden-bypass',
      'protected-path',
      'test-integrity-cheat',
      'context-leak'
    ]);
    expect(output.cases.every((item) => item.detected)).toBe(true);
    expect(
      output.cases.every((item) => item.prCandidateCreated === false)
    ).toBe(true);
    expect(output.cases.every((item) => item.hiddenTextLeaked === false)).toBe(
      true
    );

    expect(output.cases[0]).toMatchObject({
      actualDecision: 'reject',
      reason: 'GATE_REQUIRED_FAILED',
      failedGate: 'hidden_cart_mixed_quantities'
    });
    expect(output.cases[1]).toMatchObject({
      actualDecision: 'reject',
      reason: 'GUARD_PROTECTED_PATH',
      failedGate: 'protected_files'
    });
    expect(output.cases[2]).toMatchObject({
      actualDecision: 'reject',
      reason: 'GUARD_TEST_INTEGRITY',
      failedGate: 'test_integrity'
    });
    expect(output.cases[3]).toMatchObject({
      actualDecision: 'reject',
      reason: 'GUARD_ARTIFACT_LEAK',
      failedGate: 'artifact_leak',
      detectedBy: 'core_artifact_leak_gate',
      previousContextRedacted: true
    });
  }, 120_000);
});
