import { describe, expect, it } from 'vitest';
import { EXIT_CODES, runOnce, verifyPatch } from './index.js';
import type { RunOnceOptions, RunOnceResult, VerifyPatchOptions, VerifyPatchResult } from './index.js';

describe('sdk public surface', () => {
  it('exports run/verify functions and stable public result types', () => {
    const run: typeof runOnce = runOnce;
    const verify: typeof verifyPatch = verifyPatch;
    const result: RunOnceResult = {
      loopId: 'loop-1',
      projectId: 'project-1',
      status: 'accepted',
      decision: 'accept',
      reportPath: '/tmp/report.json',
      artifactRoot: '/tmp/artifacts',
      exitCode: EXIT_CODES.accept
    };
    const verifyResult: VerifyPatchResult = result;
    const runOptions = {} as RunOnceOptions;
    const verifyOptions = {} as VerifyPatchOptions;

    expect(typeof run).toBe('function');
    expect(typeof verify).toBe('function');
    expect(verifyResult.decision).toBe('accept');
    expect(runOptions).toBeDefined();
    expect(verifyOptions).toBeDefined();
  });
});
