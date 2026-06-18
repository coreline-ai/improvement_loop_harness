import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isContainerRuntimeAvailable } from '@vibeloop/shared';
import { hashRuleSpec, type RulepackRuleSpec } from './rulepack-shadow.js';
import {
  runFrozenRulepack,
  type FrozenRulepackForRunner
} from './rulepack-runner.js';

const cleanup: string[] = [];
const dockerUp = await isContainerRuntimeAvailable();

async function tempWorktree(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-rulepack-runner-')
  );
  cleanup.push(root);
  return root;
}

async function dockerWorktree(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.homedir(), '.vibeloop-rulepack-runner-')
  );
  cleanup.push(root);
  return root;
}

function frozenWithSpec(spec: RulepackRuleSpec): FrozenRulepackForRunner {
  const rule = {
    id: 'adversary:p-edge',
    hash: hashRuleSpec(spec),
    spec
  };
  return {
    kind: 'frozen_rulepack',
    authority: 'fixed_next_loop_gate',
    decision_impact: 'next_loop_only',
    rules: [{ id: 'baseline:rule', hash: 'sha256:base' }, rule],
    added_rules: [rule],
    diff: { appendOnly: true },
    replay: { replaySafe: true }
  };
}

describe('runFrozenRulepack', () => {
  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('runs executable semantic rules against the candidate worktree and restores staged files', async () => {
    const worktree = await tempWorktree();
    const targetPath = path.join(
      worktree,
      'tests/adversary/fixed-edge.test.cjs'
    );
    const spec: RulepackRuleSpec = {
      kind: 'command_test',
      target_path: 'tests/adversary/fixed-edge.test.cjs',
      body: 'process.exit(0);\n',
      command: 'node tests/adversary/fixed-edge.test.cjs',
      expect: 'pass_to_pass',
      network: 'none'
    };

    const result = await runFrozenRulepack(frozenWithSpec(spec), {
      worktreePath: worktree,
      image: 'node:22',
      runtimeAvailable: async () => true,
      commandRunner: async () => {
        expect(await readFile(targetPath, 'utf8')).toBe(spec.body);
        return { status: 'pass', stdout: '', stderr: '' };
      }
    });

    expect(result).toMatchObject({
      allPass: true,
      status: 'pass',
      total: 1,
      passed: 1
    });
    await expect(readFile(targetPath, 'utf8')).rejects.toThrow();
  });

  it('reports a semantic failure for known-bad candidates', async () => {
    const worktree = await tempWorktree();
    const spec: RulepackRuleSpec = {
      kind: 'command_test',
      target_path: 'tests/adversary/fixed-edge.test.cjs',
      body: 'process.exit(1);\n',
      command: 'node tests/adversary/fixed-edge.test.cjs',
      expect: 'fail_to_pass',
      network: 'none'
    };

    const result = await runFrozenRulepack(frozenWithSpec(spec), {
      worktreePath: worktree,
      image: 'node:22',
      runtimeAvailable: async () => true,
      commandRunner: async () => ({ status: 'fail', stdout: '', stderr: '' })
    });

    expect(result.allPass).toBe(false);
    expect(result.status).toBe('fail');
    expect(result.results[0]).toMatchObject({
      ruleId: 'adversary:p-edge',
      status: 'fail',
      expected: 'pass',
      actual: 'fail'
    });
  });

  it('fails closed when runtime is unavailable and does not run commands', async () => {
    const worktree = await tempWorktree();
    let ran = false;
    const spec: RulepackRuleSpec = {
      kind: 'command_test',
      target_path: 'tests/adversary/fixed-edge.test.cjs',
      body: 'process.exit(0);\n',
      command: 'node tests/adversary/fixed-edge.test.cjs',
      expect: 'pass_to_pass',
      network: 'none'
    };

    const result = await runFrozenRulepack(frozenWithSpec(spec), {
      worktreePath: worktree,
      image: 'node:22',
      runtimeAvailable: async () => false,
      commandRunner: async () => {
        ran = true;
        return { status: 'pass', stdout: '', stderr: '' };
      }
    });

    expect(ran).toBe(false);
    expect(result).toMatchObject({
      allPass: false,
      status: 'error',
      errors: [
        expect.objectContaining({ code: 'CONTAINER_RUNTIME_UNAVAILABLE' })
      ]
    });
  });

  it('fails closed on rule spec hash mismatch before running', async () => {
    const worktree = await tempWorktree();
    let ran = false;
    const spec: RulepackRuleSpec = {
      kind: 'command_test',
      target_path: 'tests/adversary/fixed-edge.test.cjs',
      body: 'process.exit(0);\n',
      command: 'node tests/adversary/fixed-edge.test.cjs',
      expect: 'pass_to_pass',
      network: 'none'
    };
    const frozen = frozenWithSpec(spec);
    frozen.added_rules![0] = {
      ...frozen.added_rules![0]!,
      spec: { ...spec, body: 'process.exit(1);\n' }
    };
    frozen.rules[1] = frozen.added_rules![0]!;

    const result = await runFrozenRulepack(frozen, {
      worktreePath: worktree,
      image: 'node:22',
      runtimeAvailable: async () => true,
      commandRunner: async () => {
        ran = true;
        return { status: 'pass', stdout: '', stderr: '' };
      }
    });

    expect(ran).toBe(false);
    expect(result.status).toBe('error');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'RULE_SPEC_HASH_MISMATCH' })
    );
  });

  it('fails closed when a current loop tries to apply its own frozen rules', async () => {
    const worktree = await tempWorktree();
    let ran = false;
    const spec: RulepackRuleSpec = {
      kind: 'command_test',
      target_path: 'tests/adversary/fixed-edge.test.cjs',
      body: 'process.exit(0);\n',
      command: 'node tests/adversary/fixed-edge.test.cjs',
      expect: 'pass_to_pass',
      network: 'none'
    };
    const frozen = frozenWithSpec(spec);
    frozen.source_loop_id = 'loop-current';

    const result = await runFrozenRulepack(frozen, {
      worktreePath: worktree,
      image: 'node:22',
      currentLoopId: 'loop-current',
      runtimeAvailable: async () => true,
      commandRunner: async () => {
        ran = true;
        return { status: 'pass', stdout: '', stderr: '' };
      }
    });

    expect(ran).toBe(false);
    expect(result.status).toBe('error');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'RULEPACK_CURRENT_LOOP_APPLICATION' })
    );
  });

  it('restores an existing file after semantic execution', async () => {
    const worktree = await tempWorktree();
    const targetPath = path.join(worktree, 'existing.test.cjs');
    await writeFile(targetPath, 'original\n');
    const spec: RulepackRuleSpec = {
      kind: 'command_test',
      target_path: 'existing.test.cjs',
      body: 'temporary\n',
      command: 'node existing.test.cjs',
      expect: 'pass_to_pass',
      network: 'none'
    };

    await runFrozenRulepack(frozenWithSpec(spec), {
      worktreePath: worktree,
      image: 'node:22',
      runtimeAvailable: async () => true,
      commandRunner: async () => ({ status: 'pass', stdout: '', stderr: '' })
    });

    expect(await readFile(targetPath, 'utf8')).toBe('original\n');
  });

  it('fails closed when a rule spec contains a forbidden artifact literal', async () => {
    const worktree = await tempWorktree();
    let ran = false;
    const spec: RulepackRuleSpec = {
      kind: 'command_test',
      target_path: 'tests/adversary/fixed-edge.test.cjs',
      body: 'console.log("SECRET_RULE_MARKER");\n',
      command: 'node tests/adversary/fixed-edge.test.cjs',
      expect: 'pass_to_pass',
      network: 'none'
    };

    const result = await runFrozenRulepack(frozenWithSpec(spec), {
      worktreePath: worktree,
      image: 'node:22',
      runtimeAvailable: async () => true,
      artifactLeak: {
        forbidden_literals: [
          { label: 'rule-marker', value: 'SECRET_RULE_MARKER' }
        ]
      },
      commandRunner: async () => {
        ran = true;
        return { status: 'pass', stdout: '', stderr: '' };
      }
    });

    expect(ran).toBe(false);
    expect(result.status).toBe('error');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'RULE_SPEC_ARTIFACT_LEAK' })
    );
  });

  it('fails closed when rule output contains a forbidden artifact literal', async () => {
    const worktree = await tempWorktree();
    const spec: RulepackRuleSpec = {
      kind: 'command_test',
      target_path: 'tests/adversary/fixed-edge.test.cjs',
      body: 'process.exit(0);\n',
      command: 'node tests/adversary/fixed-edge.test.cjs',
      expect: 'pass_to_pass',
      network: 'none'
    };

    const result = await runFrozenRulepack(frozenWithSpec(spec), {
      worktreePath: worktree,
      image: 'node:22',
      runtimeAvailable: async () => true,
      artifactLeak: {
        forbidden_literals: [
          { label: 'rule-marker', value: 'SECRET_RULE_MARKER' }
        ]
      },
      commandRunner: async () => ({
        status: 'pass',
        stdout: 'SECRET_RULE_MARKER\n',
        stderr: ''
      })
    });

    expect(result.status).toBe('error');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'RULE_OUTPUT_ARTIFACT_LEAK' })
    );
  });
});

describe.skipIf(!dockerUp)(
  'runFrozenRulepack with real R1 container execution',
  () => {
    afterEach(async () => {
      await Promise.all(
        cleanup
          .splice(0)
          .map((root) => rm(root, { recursive: true, force: true }))
      );
    });

    it('passes a known-good candidate and fails a known-bad candidate inside Docker', async () => {
      const goodWorktree = await dockerWorktree();
      const badWorktree = await dockerWorktree();
      const spec: RulepackRuleSpec = {
        kind: 'command_test',
        target_path: 'tests/adversary/semantic.test.cjs',
        body: [
          "const value = require('../../src/value.cjs');",
          'if (value !== 2) process.exit(1);',
          ''
        ].join('\n'),
        command: 'node tests/adversary/semantic.test.cjs',
        expect: 'fail_to_pass',
        network: 'none'
      };
      await writeFile(path.join(goodWorktree, 'package.json'), '{}\n');
      await writeFile(path.join(badWorktree, 'package.json'), '{}\n');
      await mkdir(path.join(goodWorktree, 'src'), { recursive: true });
      await mkdir(path.join(badWorktree, 'src'), { recursive: true });
      await writeFile(
        path.join(goodWorktree, 'src/value.cjs'),
        'module.exports = 2;\n'
      );
      await writeFile(
        path.join(badWorktree, 'src/value.cjs'),
        'module.exports = 1;\n'
      );

      const good = await runFrozenRulepack(frozenWithSpec(spec), {
        worktreePath: goodWorktree,
        image: 'node:22-alpine',
        timeoutMs: 30_000
      });
      const bad = await runFrozenRulepack(frozenWithSpec(spec), {
        worktreePath: badWorktree,
        image: 'node:22-alpine',
        timeoutMs: 30_000
      });

      expect(good).toMatchObject({ allPass: true, status: 'pass' });
      expect(bad).toMatchObject({ allPass: false, status: 'fail' });
    }, 60_000);
  }
);
