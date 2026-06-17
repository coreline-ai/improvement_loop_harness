import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyPatch,
  isTestFile,
  type GuardChangedFile
} from '@vibeloop/guards';
import { runCommand } from '@vibeloop/shared';

export interface TestOnBaseCase {
  command: string;
  base_status: 'pass' | 'fail' | 'error';
  candidate_status: 'pass' | 'fail' | 'error';
  base_exit_code: number | null;
  candidate_exit_code: number | null;
}

export interface TestOnBaseReport {
  schema_version: '1.0';
  artifact_ref: 'reports/test-on-base.json';
  test_files: string[];
  cases: TestOnBaseCase[];
  base_failed_candidate_passed: boolean;
}

export interface VerifyTestOnBaseOptions {
  baseRepoPath: string;
  candidateRepoPath: string;
  candidatePatch: string;
  changedFiles: GuardChangedFile[];
  requiredTests: string[];
  artifactRoot: string;
  env?: NodeJS.ProcessEnv | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export function changedTestFiles(
  changedFiles: readonly GuardChangedFile[]
): string[] {
  return changedFiles
    .filter((file) => file.status !== 'deleted' && isTestFile(file.path))
    .map((file) => file.path)
    .sort();
}

export async function verifyTestOnBase(
  options: VerifyTestOnBaseOptions
): Promise<TestOnBaseReport> {
  const testFiles = changedTestFiles(options.changedFiles);
  if (testFiles.length > 0) {
    await applyPatch(options.baseRepoPath, options.candidatePatch, {
      includeOnly: testFiles
    });
  }

  const cases: TestOnBaseCase[] = [];
  for (const command of options.requiredTests) {
    const base = await runCommand(command, {
      cwd: options.baseRepoPath,
      env: options.env ?? process.env,
      signal: options.signal,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    });
    const candidate = await runCommand(command, {
      cwd: options.candidateRepoPath,
      env: options.env ?? process.env,
      signal: options.signal,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    });
    cases.push({
      command,
      base_status: base.status,
      candidate_status: candidate.status,
      base_exit_code: base.exitCode,
      candidate_exit_code: candidate.exitCode
    });
  }

  const report: TestOnBaseReport = {
    schema_version: '1.0',
    artifact_ref: 'reports/test-on-base.json',
    test_files: testFiles,
    cases,
    base_failed_candidate_passed: cases.some(
      (testCase) =>
        testCase.base_status === 'fail' && testCase.candidate_status === 'pass'
    )
  };

  const reportPath = path.join(
    options.artifactRoot,
    'reports',
    'test-on-base.json'
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
