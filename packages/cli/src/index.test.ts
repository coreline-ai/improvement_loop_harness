import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import { EXIT_CODES } from './exit-codes.js';
import { createProgram, VERSION } from './index.js';
import { renderLoopHtmlReport } from './commands/report.js';
import { retryLoop } from './commands/retry.js';
import {
  commandQualityJudge,
  resolveSameModelReview,
  runImprovementLoop,
  runKernel,
  verifySelectedCandidate
} from './run.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeFixtureTaskEval(options: {
  dir: string;
  taskId: string;
  allowed?: string[] | undefined;
  protectedPaths?: string[] | undefined;
  requiredTests?: string[] | undefined;
  gates?: string | undefined;
  evaluator?: string[] | undefined;
}): Promise<{ taskFile: string; evalFile: string }> {
  const taskFile = path.join(options.dir, `${options.taskId}.task.yaml`);
  const evalFile = path.join(options.dir, `${options.taskId}.eval.yaml`);
  const allowed = options.allowed ?? ['src/', 'tests/'];
  const requiredTests = options.requiredTests ?? [
    'node tests/regression.test.js'
  ];
  await writeFile(
    taskFile,
    [
      'schema_version: "1.0"',
      `id: ${options.taskId}`,
      'title: CLI kernel fixture',
      'objective: Verify the CLI kernel can fix one small problem',
      'base_branch: main',
      'risk_area: none',
      'write_scope:',
      '  allowed:',
      ...allowed.map((entry) => `    - ${entry}`),
      'required_evidence:',
      '  - adds_regression_test',
      'limits:',
      '  max_changed_files: 10',
      '  max_changed_lines: 200',
      'acceptance:',
      '  required_tests:',
      ...requiredTests.map((entry) => `    - ${entry}`),
      ''
    ].join('\n')
  );
  await writeFile(
    evalFile,
    options.gates ??
      [
        'schema_version: "1.0"',
        'project: cli-fixture',
        'protected_paths:',
        ...(
          options.protectedPaths ?? [
            '.env',
            '.env.*',
            'eval.yaml',
            'scripts/eval.sh'
          ]
        ).map((entry) => `  - ${entry}`),
        'risk_classification:',
        '  none:',
        '    - src/',
        '    - tests/',
        '    - .env.local',
        'limits:',
        '  max_changed_files: 10',
        '  max_changed_lines: 200',
        'test_integrity:',
        '  forbidden_patterns:',
        '    - test.skip',
        '    - it.only',
        '  suspicious_patterns:',
        '    - expect(true).toBe(true)',
        'gates:',
        '  - name: protected_files',
        '    type: scope',
        '    command: builtin:protected-files',
        '    required: true',
        '  - name: diff_scope',
        '    type: scope',
        '    command: builtin:diff-scope',
        '    required: true',
        '  - name: limits',
        '    type: integrity',
        '    command: builtin:limits',
        '    required: true',
        '  - name: test_integrity',
        '    type: integrity',
        '    command: builtin:test-integrity',
        '    required: true',
        '  - name: unit_tests',
        '    type: task_acceptance',
        '    command: node tests/regression.test.js',
        '    required: true',
        ...(options.evaluator
          ? ['evaluator:', ...options.evaluator.map((line) => `  ${line}`)]
          : []),
        ''
      ].join('\n')
  );
  return { taskFile, evalFile };
}

async function createValueRepo(): Promise<
  Awaited<ReturnType<typeof createTempGitRepo>>
> {
  const repo = await createTempGitRepo();
  await repo.write('src/value.cjs', 'module.exports = 1;\n');
  await repo.git(['add', 'src/value.cjs']);
  await repo.git(['commit', '-m', 'add value source']);
  return repo;
}

async function writeScenario(
  dir: string,
  name: string,
  actions: unknown[]
): Promise<string> {
  const scenario = path.join(dir, `${name}.json`);
  await writeFile(scenario, `${JSON.stringify({ actions }, null, 2)}\n`);
  return scenario;
}

describe('createProgram', () => {
  it('configures the vibeloop CLI version and Phase 10 commands', () => {
    const program = createProgram();

    expect(program.name()).toBe('vibeloop');
    expect(program.version()).toBe(VERSION);
    expect(program.commands.map((command) => command.name()).sort()).toEqual([
      'discover',
      'gc',
      'improve',
      'orchestrate',
      'report',
      'retry',
      'run'
    ]);
  });
});

it('runs discover dry-run and prints structured candidates without saving them', async () => {
  const repo = await createTempGitRepo();
  await repo.write(
    'tests/failing.test.js',
    "console.error('tests/failing.test.js'); process.exit(1);\n"
  );
  await repo.git(['add', 'tests/failing.test.js']);
  await repo.git(['commit', '-m', 'add failing test']);
  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'discover',
      '--repo',
      repo.repoPath,
      '--test-command',
      'node tests/failing.test.js'
    ]);
  } finally {
    spy.mockRestore();
  }
  const output = JSON.parse(logs.join('\n')) as {
    candidates: Array<{ source: string; location: { filePath: string } }>;
  };

  expect(output.candidates).toHaveLength(1);
  expect(output.candidates[0]).toMatchObject({
    source: 'test_failure',
    location: { filePath: 'tests/failing.test.js' }
  });
});

it('improve --challenger runs the challenger and selects the better candidate via the CLI', async () => {
  const repo = await createValueRepo();
  const dataDir = await tempDir('vibeloop-cli-challenger-data-');
  const fixtureDir = await tempDir('vibeloop-cli-challenger-fixture-');
  const { taskFile, evalFile } = await writeFixtureTaskEval({
    dir: fixtureDir,
    taskId: 'cli-challenger'
  });
  const regressionTest =
    "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
  const larger = await writeScenario(fixtureDir, 'cli-larger', [
    { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
    {
      type: 'create',
      path: 'tests/regression.test.js',
      content: regressionTest
    },
    {
      type: 'create',
      path: 'src/extra.cjs',
      content: 'module.exports = { extra: true };\n'
    }
  ]);
  const smaller = await writeScenario(fixtureDir, 'cli-smaller', [
    { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
    {
      type: 'create',
      path: 'tests/regression.test.js',
      content: regressionTest
    }
  ]);

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'improve',
      '--repo',
      repo.repoPath,
      '--task',
      taskFile,
      '--eval',
      evalFile,
      '--agent',
      `mock:${larger}`,
      '--challenger',
      `mock:${smaller}`,
      '--out',
      dataDir,
      '--loop-id',
      'cli-challenger-1',
      '--skip-dependency-install'
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    candidate_count: number;
    accepted_count: number;
    selected_candidate_id: string | null;
    selected_patch: string | null;
  };
  // The challenger (c1) ran despite the builder passing, and the Arbiter picked
  // the smaller-diff challenger through the real --challenger CLI wiring.
  expect(output.candidate_count).toBe(2);
  expect(output.accepted_count).toBe(2);
  expect(output.selected_candidate_id).toBe('cli-challenger-1-c1');
  expect(output.selected_patch).toContain('cli-challenger-1-c1');
  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
});

it('improve can promote the selected final-verified patch to a local PR-candidate branch', async () => {
  const repo = await createValueRepo();
  const dataDir = await tempDir('vibeloop-cli-promote-data-');
  const fixtureDir = await tempDir('vibeloop-cli-promote-fixture-');
  const { taskFile, evalFile } = await writeFixtureTaskEval({
    dir: fixtureDir,
    taskId: 'cli-promote'
  });
  const regressionTest =
    "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
  const scenario = await writeScenario(fixtureDir, 'cli-promote-agent', [
    { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
    {
      type: 'create',
      path: 'tests/regression.test.js',
      content: regressionTest
    }
  ]);

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'improve',
      '--repo',
      repo.repoPath,
      '--task',
      taskFile,
      '--eval',
      evalFile,
      '--agent',
      `mock:${scenario}`,
      '--out',
      dataDir,
      '--loop-id',
      'cli-promote-1',
      '--promote-branch',
      'pr-candidate/cli-promote-1',
      '--skip-dependency-install'
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    pr_candidate: boolean;
    promotion: {
      branch_name: string;
      head_sha: string;
      pushed: boolean;
    } | null;
  };
  expect(output.pr_candidate).toBe(true);
  expect(output.promotion).toMatchObject({
    branch_name: 'pr-candidate/cli-promote-1',
    pushed: false
  });
  expect(output.promotion?.head_sha).toMatch(/^[a-f0-9]{40}$/);
  await expect(repo.git(['show', 'main:src/value.cjs'])).resolves.toBe(
    'module.exports = 1;\n'
  );
  await expect(
    repo.git(['show', 'pr-candidate/cli-promote-1:src/value.cjs'])
  ).resolves.toBe('module.exports = 2;\n');
  await expect(
    repo.git(['show', 'pr-candidate/cli-promote-1:tests/regression.test.js'])
  ).resolves.toContain('value !== 2');
  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
});

describe('resolveSameModelReview', () => {
  it.each([
    ['mock:scenario.json', undefined, false],
    ['codex', undefined, true],
    ['codex exec --cd /tmp/worktree -', undefined, true],
    ['unknown-agent --flag', undefined, true],
    ['codex', { require_different_provider: true }, false],
    // provider-identity promotion: different known provider → independent
    ['codex', { reviewer_provider: 'anthropic' }, false],
    // same provider → not independent
    ['codex', { reviewer_provider: 'openai' }, true],
    // declared-but-unknown reviewer → conservative
    ['codex', { reviewer_provider: 'unknown' }, true],
    // builder provider unknown but reviewer known → cannot prove independence
    ['unknown-agent --flag', { reviewer_provider: 'anthropic' }, true]
  ] as const)(
    'maps %s with critic config %j to %s',
    (agentSpec, criticConfig, expected) => {
      expect(resolveSameModelReview(agentSpec, criticConfig)).toBe(expected);
    }
  );
});

describe('runImprovementLoop', () => {
  it('selects the best-known accepted candidate by deterministic score and ignores failed ones', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-iloop-data-');
    const fixtureDir = await tempDir('vibeloop-iloop-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'iloop'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const large = await writeScenario(fixtureDir, 'large', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      },
      {
        type: 'create',
        path: 'src/extra.cjs',
        content: 'module.exports = { extra: true, note: "larger diff" };\n'
      }
    ]);
    const small = await writeScenario(fixtureDir, 'small', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);
    const failing = await writeScenario(fixtureDir, 'failing', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
      // no regression test → required acceptance test fails → reject
    ]);

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'iloop-1',
      skipDependencyInstall: true,
      builders: [`mock:${large}`, `mock:${small}`, `mock:${failing}`]
    });

    expect(result.candidates).toHaveLength(3);
    expect(
      result.candidates
        .filter((c) => c.accepted)
        .map((c) => c.candidateId)
        .sort()
    ).toEqual(['iloop-1-c0', 'iloop-1-c1']);
    expect(result.candidates[2]?.accepted).toBe(false); // failing candidate
    // Arbiter prefers the smaller accepted candidate (c1) over the larger (c0).
    expect(result.selected?.candidateId).toBe('iloop-1-c1');
    expect(result.selected?.score?.changed_files).toBe(2);

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as { selected_candidate_id: string; accepted_count: number };
    expect(report.selected_candidate_id).toBe('iloop-1-c1');
    expect(report.accepted_count).toBe(2);
  });

  it('enforces the maxCandidates cost ceiling (B4) and records cap_hit', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cap-data-');
    const fixtureDir = await tempDir('vibeloop-cap-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cap'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const fix = await writeScenario(fixtureDir, 'cap-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'cap-1',
      skipDependencyInstall: true,
      // three builders requested, but the ceiling is two → the third never runs.
      builders: [`mock:${fix}`, `mock:${fix}`, `mock:${fix}`],
      maxCandidates: 2
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.limits?.cap_hit).toBe(true);
    expect(result.limits?.candidates_run).toBe(2);
    expect(result.limits?.max_candidates).toBe(2);

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as { limits: { cap_hit: boolean; candidates_run: number } };
    expect(report.limits.cap_hit).toBe(true);
    expect(report.limits.candidates_run).toBe(2);
  });

  it('re-verifies the selected patch on a fresh worktree before PR candidacy (B2/B3)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-reverify-data-');
    const fixtureDir = await tempDir('vibeloop-reverify-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'reverify'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const fix = await writeScenario(fixtureDir, 'rv-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'reverify-1',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`]
    });

    expect(result.selected?.candidateId).toBe('reverify-1-c0');
    const fv = result.finalVerification;
    expect(fv?.passed).toBe(true);
    expect(fv?.provenance_ok).toBe(true);
    expect(fv?.reverified).toBe(true);
    expect(fv?.reverify_decision).toBe('accept');
    expect(fv?.reverify_qualified).toBe(true);

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as {
      pr_candidate: boolean;
      final_verification: { passed: boolean; reverified: boolean };
    };
    expect(report.pr_candidate).toBe(true);
    expect(report.final_verification.passed).toBe(true);
    expect(report.final_verification.reverified).toBe(true);
  });

  it('skipFinalReverify keeps the provenance binding but skips re-execution', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-skiprv-data-');
    const fixtureDir = await tempDir('vibeloop-skiprv-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'skiprv'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const fix = await writeScenario(fixtureDir, 'sr-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'skiprv-1',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`],
      skipFinalReverify: true
    });

    expect(result.selected?.candidateId).toBe('skiprv-1-c0');
    expect(result.finalVerification?.provenance_ok).toBe(true);
    expect(result.finalVerification?.reverified).toBe(false);
    expect(result.finalVerification?.passed).toBe(true);
  });

  it('refuses a dirty source repo (auto base) but proceeds with allowDirty or a pinned base (#1)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-dirty-data-');
    const fixtureDir = await tempDir('vibeloop-dirty-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'dirty'
    });
    const fix = await writeScenario(fixtureDir, 'd-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content:
          "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
      }
    ]);
    // Dirty the SOURCE repo with an untracked file (does not touch the fix).
    await writeFile(path.join(repo.repoPath, 'UNCOMMITTED.txt'), 'wip\n');

    // auto base + dirty → refuse.
    await expect(
      runImprovementLoop({
        repoPath: repo.repoPath,
        taskFile,
        evalFile,
        dataDir,
        loopId: 'dirty-1',
        skipDependencyInstall: true,
        builders: [`mock:${fix}`]
      })
    ).rejects.toThrow(/uncommitted change/i);

    // allowDirty → proceed (caller opted in).
    const allowed = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'dirty-2',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`],
      allowDirty: true
    });
    expect(allowed.selected?.candidateId).toBe('dirty-2-c0');

    // pinned base commit → guard skipped → proceed.
    const head = (await repo.git(['rev-parse', 'HEAD'])).trim();
    const pinned = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'dirty-3',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`],
      baseCommit: head
    });
    expect(pinned.selected?.candidateId).toBe('dirty-3-c0');
  });

  it('rejects a selected patch whose hash no longer matches the report (B3 PROVENANCE_MISMATCH → no PR)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-prov-data-');
    const fixtureDir = await tempDir('vibeloop-prov-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'prov'
    });
    const fix = await writeScenario(fixtureDir, 'p-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content:
          "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
      }
    ]);
    // Produce a real accepted candidate (provenance-only mode keeps artifacts intact).
    const produced = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'prov-1',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`],
      skipFinalReverify: true
    });
    const cand = produced.selected!;
    expect(cand.candidateId).toBe('prov-1-c0');

    // Tamper the on-disk patch WITHOUT updating the recorded hash → binding breaks.
    const patchPath = path.join(cand.artifactRoot, 'patches/candidate.patch');
    await writeFile(
      patchPath,
      `${await readFile(patchPath, 'utf8')}\n// tamper\n`
    );

    const fv = await verifySelectedCandidate(cand, {
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      baseCommit: produced.baseCommit,
      baseLoopId: 'prov-1',
      skipDependencyInstall: true,
      skipFinalReverify: false
    });
    expect(fv.provenance_ok).toBe(false);
    expect(fv.passed).toBe(false);
    expect(fv.reason).toBe('PROVENANCE_MISMATCH');
    expect(fv.reverified).toBe(false); // never re-executed once provenance fails
  });

  it('rejects a selected patch that no longer applies on a clean base (B2 reverify → no PR)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-applyfail-data-');
    const fixtureDir = await tempDir('vibeloop-applyfail-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'applyfail'
    });
    const fix = await writeScenario(fixtureDir, 'af-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content:
          "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
      }
    ]);
    const produced = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'applyfail-1',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`],
      skipFinalReverify: true
    });
    const cand = produced.selected!;

    // Replace the patch with one that cannot apply on the clean base, and update
    // the recorded hash so provenance PASSES — the failure must surface at
    // re-execution (B2), not at the hash binding (B3).
    const badPatch =
      'diff --git a/src/value.cjs b/src/value.cjs\n' +
      '--- a/src/value.cjs\n' +
      '+++ b/src/value.cjs\n' +
      '@@ -1,1 +1,1 @@\n' +
      '-this line does not match the real file\n' +
      '+replacement\n';
    const patchPath = path.join(cand.artifactRoot, 'patches/candidate.patch');
    await writeFile(patchPath, badPatch);
    const reportPath = cand.reportPath!;
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      provenance: { candidate_patch_hash: string };
    };
    report.provenance.candidate_patch_hash = createHash('sha256')
      .update(badPatch)
      .digest('hex');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const fv = await verifySelectedCandidate(cand, {
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      baseCommit: produced.baseCommit,
      baseLoopId: 'applyfail-1',
      skipDependencyInstall: true,
      skipFinalReverify: false
    });
    expect(fv.provenance_ok).toBe(true); // hash now matches the (bad) patch
    expect(fv.passed).toBe(false); // but it does not reproduce on a clean base
    expect(fv.reason).toMatch(/REVERIFY/);
  });

  it('advisory judge reorders a score tie but the result is still verified (B1)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-tie-data-');
    const fixtureDir = await tempDir('vibeloop-tie-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'tie'
    });
    // Two builders with the IDENTICAL fix → identical diffs → identical score → tie.
    const fix = await writeScenario(fixtureDir, 't-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content:
          "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
      }
    ]);

    let judgeCalls = 0;
    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'tie-1',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`, `mock:${fix}`],
      // Deterministic pick would be c0 (lexicographic); the judge prefers the last.
      qualityJudge: async (input) => {
        judgeCalls += 1;
        const last = input.tied[input.tied.length - 1]!;
        return {
          winner_candidate_id: last.candidate_id,
          rationale: 'mock: last'
        };
      }
    });

    expect(judgeCalls).toBe(1);
    expect(result.advisoryTieBreak?.ran).toBe(true);
    expect(result.advisoryTieBreak?.tied_candidate_ids.sort()).toEqual([
      'tie-1-c0',
      'tie-1-c1'
    ]);
    expect(result.advisoryTieBreak?.deterministic_pick).toBe('tie-1-c0');
    expect(result.advisoryTieBreak?.winner_candidate_id).toBe('tie-1-c1');
    expect(result.advisoryTieBreak?.changed_pick).toBe(true);
    // Advisory moved the pick, but it is STILL gated by final verification.
    expect(result.selected?.candidateId).toBe('tie-1-c1');
    expect(result.finalVerification?.passed).toBe(true);

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as { advisory_tie_break: { changed_pick: boolean } | null };
    expect(report.advisory_tie_break?.changed_pick).toBe(true);
  });

  it('advisory judge cannot promote a non-tied (e.g. rejected) candidate (B1 safety)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-tiesafe-data-');
    const fixtureDir = await tempDir('vibeloop-tiesafe-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'tiesafe'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const fix = await writeScenario(fixtureDir, 'ts-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);
    const failing = await writeScenario(fixtureDir, 'ts-failing', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
      // no regression test → rejected
    ]);

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'tiesafe-1',
      skipDependencyInstall: true,
      // c0,c1 accepted+tied; c2 rejected.
      builders: [`mock:${fix}`, `mock:${fix}`, `mock:${failing}`],
      // Judge tries to crown the REJECTED candidate → must be ignored.
      qualityJudge: async () => ({ winner_candidate_id: 'tiesafe-1-c2' })
    });

    expect(result.advisoryTieBreak?.invalid).toBe(true);
    expect(result.advisoryTieBreak?.changed_pick).toBe(false);
    // Deterministic pick (c0) stands; the rejected candidate was never promotable.
    expect(result.selected?.candidateId).toBe('tiesafe-1-c0');
  });

  it('does not consult the judge when there is no score tie at the top (B1 no-op)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-notie-data-');
    const fixtureDir = await tempDir('vibeloop-notie-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'notie'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const large = await writeScenario(fixtureDir, 'n-large', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      },
      {
        type: 'create',
        path: 'src/extra.cjs',
        content: 'module.exports = { extra: true };\n'
      }
    ]);
    const small = await writeScenario(fixtureDir, 'n-small', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);

    let judgeCalls = 0;
    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'notie-1',
      skipDependencyInstall: true,
      builders: [`mock:${large}`, `mock:${small}`],
      qualityJudge: async () => {
        judgeCalls += 1;
        return { winner_candidate_id: 'notie-1-c0' };
      }
    });

    expect(judgeCalls).toBe(0); // unique top score → no tie → judge untouched
    expect(result.advisoryTieBreak).toBeUndefined();
    expect(result.selected?.candidateId).toBe('notie-1-c1'); // smaller diff wins
  });

  it('commandQualityJudge runs a separate process and parses its JSON verdict', async () => {
    const judge = commandQualityJudge(
      `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const i=JSON.parse(d);const w=i.tied[i.tied.length-1].candidate_id;process.stdout.write(JSON.stringify({winner_candidate_id:w,rationale:'sep-context'}))})"`
    );
    const res = await judge({
      tied: [
        { candidate_id: 'a', artifact_root: '/x', patch_ref: '/x/p' },
        { candidate_id: 'b', artifact_root: '/y', patch_ref: '/y/p' }
      ]
    });
    expect(res.winner_candidate_id).toBe('b');
    expect(res.rationale).toBe('sep-context');
  });

  it('runs a bounded refinement round only when round 0 produced no accepted candidate', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-refine-data-');
    const fixtureDir = await tempDir('vibeloop-refine-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'refine'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const failing = await writeScenario(fixtureDir, 'r-failing', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
      // no regression test → round 0 rejects
    ]);
    const fixed = await writeScenario(fixtureDir, 'r-fixed', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'refine-1',
      skipDependencyInstall: true,
      builders: [`mock:${failing}`],
      refinementRounds: [[`mock:${fixed}`]]
    });

    // round 0 (c0) failed → refinement round 1 (c1) ran and passed.
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.round).toBe(0);
    expect(result.candidates[0]?.accepted).toBe(false);
    expect(result.candidates[1]?.round).toBe(1);
    expect(result.candidates[1]?.accepted).toBe(true);
    expect(result.selected?.candidateId).toBe('refine-1-c1');
  });

  it('does not run refinement rounds once an accepted candidate exists', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-refine2-data-');
    const fixtureDir = await tempDir('vibeloop-refine2-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'refine2'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const ok = await writeScenario(fixtureDir, 'r2-ok', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);
    const unused = await writeScenario(fixtureDir, 'r2-unused', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
    ]);

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'refine2-1',
      skipDependencyInstall: true,
      builders: [`mock:${ok}`],
      refinementRounds: [[`mock:${unused}`]]
    });

    // round 0 accepted → refinement round is skipped entirely.
    expect(result.candidates).toHaveLength(1);
    expect(result.selected?.candidateId).toBe('refine2-1-c0');
  });

  it('runs challenger rounds even after acceptance and selects the better candidate', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-challenger-data-');
    const fixtureDir = await tempDir('vibeloop-challenger-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'challenger'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    // round 0: accepted but larger (extra file)
    const larger = await writeScenario(fixtureDir, 'ch-larger', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      },
      {
        type: 'create',
        path: 'src/extra.cjs',
        content: 'module.exports = { extra: true, note: "larger" };\n'
      }
    ]);
    // challenger: accepted and smaller → should win even though round 0 passed
    const smaller = await writeScenario(fixtureDir, 'ch-smaller', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'challenger-1',
      skipDependencyInstall: true,
      builders: [`mock:${larger}`],
      challengerRounds: [[`mock:${smaller}`]]
    });

    // challenger ran despite round 0 acceptance; Arbiter picked the smaller one.
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[1]?.round).toBe(1);
    expect(result.selected?.candidateId).toBe('challenger-1-c1');
    expect(result.selected?.score?.changed_files).toBe(2);
  });
});

describe('runKernel', () => {
  it('runs the mock happy path, writes fixed inputs/workspace ref, and exits 0 with eval-report.json', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-data-');
    const fixtureDir = await tempDir('vibeloop-cli-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cli-happy'
    });
    const scenario = await writeScenario(fixtureDir, 'happy', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content:
          "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
      }
    ]);

    const result = await runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-happy',
      skipDependencyInstall: true
    });
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8')) as {
      decision: string;
      improvement_evidence: Array<{ status: string }>;
      artifact_refs: string[];
    };

    expect(result.exitCode).toBe(EXIT_CODES.accept);
    expect(result.status).toBe('accepted');
    expect(report.decision).toBe('accept');
    // No evaluator configured → quality gate is a no-op (qualified = true).
    expect(result.qualified).toBe(true);
    expect(report.improvement_evidence[0]?.status).toBe('present');
    await expect(
      fileExists(path.join(result.layout.input, 'task.yaml'))
    ).resolves.toBe(true);
    await expect(
      fileExists(path.join(result.layout.input, 'eval.yaml'))
    ).resolves.toBe(true);
    await expect(
      fileExists(path.join(result.layout.input, 'base_commit.txt'))
    ).resolves.toBe(true);
    await expect(
      fileExists(path.join(result.layout.input, 'env-snapshot.json'))
    ).resolves.toBe(true);
    await expect(
      fileExists(path.join(result.layout.workspace, 'workspace-ref.json'))
    ).resolves.toBe(true);
    expect(report.artifact_refs).toContain('workspace/workspace-ref.json');
    const html = await renderLoopHtmlReport({ dataDir, loopId: result.loopId });
    expect(html.fileUrl).toMatch(/^file:\/\//);
    expect(await readFile(html.path, 'utf8')).toContain('VibeLoop Eval Report');
  });

  it('computes deterministic quality (qualified) as a separate gate without changing the correctness decision', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-quality-data-');
    const fixtureDir = await tempDir('vibeloop-cli-quality-fixture-');
    // Tight quality bar the happy candidate (2 changed files) cannot meet.
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cli-quality',
      evaluator: ['max_changed_files: 1']
    });
    const scenario = await writeScenario(fixtureDir, 'quality', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content:
          "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
      }
    ]);

    const result = await runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-quality',
      skipDependencyInstall: true
    });

    // Correctness decision is unchanged: the change still verifies (ALL_PASS).
    expect(result.status).toBe('accepted');
    expect(result.decision).toBe('accept');
    // But the deterministic Evaluator gate is not met → not a PR candidate.
    expect(result.qualified).toBe(false);
    const quality = JSON.parse(
      await readFile(
        path.join(result.layout.root, 'reports', 'quality-report.json'),
        'utf8'
      )
    ) as {
      status: string;
      met: boolean;
      rules: Array<{ id: string; status: string }>;
    };
    expect(quality.met).toBe(false);
    expect(quality.status).toBe('fail');
    expect(quality.rules.find((rule) => rule.id === 'Q4_files')?.status).toBe(
      'fail'
    );
  });

  it('rejects guard failures, still writes eval-report.json, and skips project gates', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-guard-data-');
    const fixtureDir = await tempDir('vibeloop-cli-guard-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cli-guard',
      allowed: ['.env.local'],
      requiredTests: [
        "node -e \"require('node:fs').writeFileSync('project-gate-ran','yes')\""
      ]
    });
    const scenario = await writeScenario(fixtureDir, 'guard', [
      { type: 'create', path: '.env.local', content: 'token=secret\n' }
    ]);

    const result = await runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-guard',
      skipDependencyInstall: true
    });
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8')) as {
      decision: string;
      gate_runs: Array<{ name: string; status: string }>;
      decision_reasons: Array<{ code: string }>;
    };

    expect(result.exitCode).toBe(EXIT_CODES.reject);
    expect(result.status).toBe('rejected');
    expect(report.decision).toBe('reject');
    expect(report.decision_reasons[0]?.code).toBe('GUARD_PROTECTED_PATH');
    expect(
      report.gate_runs.find((gate) => gate.name === 'unit_tests')?.status
    ).toBe('skipped');
  });

  it('retry_eval_only creates a new loop and reevaluates stored candidate.patch without rerunning the agent', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-retry-data-');
    const fixtureDir = await tempDir('vibeloop-cli-retry-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cli-retry'
    });
    const scenario = await writeScenario(fixtureDir, 'retry-source', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content:
          "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
      }
    ]);

    const first = await runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-retry-source',
      skipDependencyInstall: true
    });
    const retried = await retryLoop({
      dataDir,
      previousLoopId: first.loopId,
      mode: 'retry_eval_only',
      newLoopId: 'loop-cli-retry-eval-only',
      skipDependencyInstall: true
    });
    const retryReport = JSON.parse(
      await readFile(retried.reportPath!, 'utf8')
    ) as { decision: string };
    const agentLog = await readFile(
      path.join(retried.layout.logs, 'agent.stdout.log'),
      'utf8'
    );
    const workspaceRef = JSON.parse(
      await readFile(
        path.join(retried.layout.workspace, 'workspace-ref.json'),
        'utf8'
      )
    ) as { retry_of: string; retry_mode: string };

    expect(retried.loopId).not.toBe(first.loopId);
    expect(retried.loopId).toBe('loop-cli-retry-eval-only');
    expect(retryReport.decision).toBe('accept');
    expect(agentLog).toContain('agent skipped for retry_eval_only');
    expect(workspaceRef).toMatchObject({
      retry_of: first.loopId,
      retry_mode: 'retry_eval_only'
    });
  });

  it('cancels gracefully through the SIGINT abort path and removes git worktrees', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-cancel-data-');
    const fixtureDir = await tempDir('vibeloop-cli-cancel-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cli-cancel'
    });
    const scenario = await writeScenario(fixtureDir, 'sleep', [
      { type: 'sleep', ms: 2_000 }
    ]);
    const controller = new AbortController();
    const running = runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-cancel',
      signal: controller.signal,
      skipDependencyInstall: true
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const result = await running;
    const worktreeList = await repo.git(['worktree', 'list', '--porcelain']);

    expect(result.exitCode).toBe(EXIT_CODES.cancelled);
    expect(result.status).toBe('cancelled');
    await expect(fileExists(result.reportPath!)).resolves.toBe(true);
    expect(worktreeList).not.toContain('loop-cli-cancel');
  });
});

describe('orchestrate (auto mode)', () => {
  async function seedRepoWithFailingTest(): Promise<{
    repoPath: string;
    evalFile: string;
    git: (args: readonly string[]) => Promise<string>;
  }> {
    const repo = await createTempGitRepo();
    await repo.write('src/value.cjs', 'module.exports = 1;\n');
    // A committed test that FAILS on base with a generic message (no file path),
    // so discovery's filePath falls back to 'project' → write_scope '.' (the fix
    // touches src, which a test-file-only scope would forbid).
    await repo.write(
      'tests/value.test.cjs',
      // Name the source file in the failure so discovery scopes the task to it
      // (a generic message would fall back to 'project' → write_scope '.').
      "const v = require('../src/value.cjs');\nif (v !== 2) { console.error('FAIL src/value.cjs: expected 2 got ' + v); process.exit(1); }\n"
    );
    await repo.write(
      'eval.yaml',
      [
        'schema_version: "1.0"',
        'project: orchestrate-fixture',
        'protected_paths:',
        '  - .env',
        '  - eval.yaml',
        'risk_classification:',
        '  none:',
        '    - src/',
        '    - tests/',
        'limits:',
        '  max_changed_files: 10',
        '  max_changed_lines: 200',
        'gates:',
        '  - name: protected_files',
        '    type: scope',
        '    command: builtin:protected-files',
        '    required: true',
        '  - name: diff_scope',
        '    type: scope',
        '    command: builtin:diff-scope',
        '    required: true',
        '  - name: limits',
        '    type: integrity',
        '    command: builtin:limits',
        '    required: true',
        '  - name: unit_tests',
        '    type: task_acceptance',
        '    command: node tests/value.test.cjs',
        '    required: true',
        ''
      ].join('\n')
    );
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'seed bug + failing test + eval']);
    return {
      repoPath: repo.repoPath,
      evalFile: path.join(repo.repoPath, 'eval.yaml'),
      git: repo.git
    };
  }

  it('discovers a failing test, auto-generates a task, and runs the loop to a PR candidate', async () => {
    const repo = await seedRepoWithFailingTest();
    const fixtureDir = await tempDir('vibeloop-orch-fixture-');
    const fix = await writeScenario(fixtureDir, 'orch-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
    ]);
    const dataDir = await tempDir('vibeloop-orch-data-');

    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((value: string) => logs.push(value));
    try {
      await createProgram().parseAsync([
        'node',
        'vibeloop',
        '--data-dir',
        dataDir,
        'orchestrate',
        '--repo',
        repo.repoPath,
        '--eval',
        repo.evalFile,
        '--agent',
        `mock:${fix}`,
        '--skip-dependency-install'
      ]);
    } finally {
      spy.mockRestore();
    }

    const output = JSON.parse(logs[logs.length - 1]!) as {
      mode: string;
      discovered: number;
      processed: number;
      pr_candidates: number;
      discovery_report: string;
      issues: Array<{
        source: string;
        task_id: string;
        pr_candidate: boolean;
        selected_candidate_id: string | null;
        final_verification: { passed: boolean } | null;
      }>;
    };

    expect(output.mode).toBe('auto');
    expect(output.discovered).toBeGreaterThanOrEqual(1);
    expect(output.processed).toBe(1);
    expect(output.issues).toHaveLength(1);
    expect(output.issues[0]?.source).toBe('test_failure');
    expect(output.issues[0]?.pr_candidate).toBe(true);
    expect(output.issues[0]?.final_verification?.passed).toBe(true);
    expect(output.pr_candidates).toBe(1);
    // discovery report persisted to disk (step 6).
    await expect(fileExists(output.discovery_report)).resolves.toBe(true);
    expect(process.exitCode).toBe(EXIT_CODES.accept);
  });

  it('can cumulatively promote selected patches and rediscover the next issue on a local branch (RU-3 substrate)', async () => {
    const repo = await createTempGitRepo();
    await repo.write('src/a.cjs', 'module.exports = 1;\n');
    await repo.write('src/b.cjs', 'module.exports = 1;\n');
    await repo.write(
      'tests/a.test.cjs',
      "const v = require('../src/a.cjs');\nif (v !== 2) { console.error('FAIL src/a.cjs: expected 2 got ' + v); process.exit(1); }\n"
    );
    await repo.write(
      'tests/b.test.cjs',
      "const v = require('../src/b.cjs');\nif (v !== 2) { console.error('FAIL src/b.cjs: expected 2 got ' + v); process.exit(1); }\n"
    );
    await repo.write(
      'eval.yaml',
      [
        'schema_version: "1.0"',
        'project: orchestrate-ru3-fixture',
        'protected_paths:',
        '  - .env',
        '  - eval.yaml',
        'risk_classification:',
        '  none:',
        '    - src/',
        '    - tests/',
        'limits:',
        '  max_changed_files: 10',
        '  max_changed_lines: 200',
        'gates:',
        '  - name: protected_files',
        '    type: scope',
        '    command: builtin:protected-files',
        '    required: true',
        '  - name: diff_scope',
        '    type: scope',
        '    command: builtin:diff-scope',
        '    required: true',
        '  - name: limits',
        '    type: integrity',
        '    command: builtin:limits',
        '    required: true',
        '  - name: a_tests',
        '    type: task_acceptance',
        '    command: node tests/a.test.cjs',
        '    required: false',
        '  - name: b_tests',
        '    type: task_acceptance',
        '    command: node tests/b.test.cjs',
        '    required: false',
        ''
      ].join('\n')
    );
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'seed two independent failing tests']);

    const fixtureDir = await tempDir('vibeloop-orch-ru3-fixture-');
    const agent = path.join(fixtureDir, 'ru3-agent.cjs');
    await writeFile(
      agent,
      [
        "const fs = require('node:fs');",
        "const task = fs.readFileSync(process.env.VIBELOOP_TASK_FILE, 'utf8');",
        "if (task.includes('src/a.cjs')) {",
        "  fs.writeFileSync('src/a.cjs', 'module.exports = 2;\\n');",
        "  process.exit(0);",
        '}',
        "if (task.includes('src/b.cjs')) {",
        "  fs.writeFileSync('src/b.cjs', 'module.exports = 2;\\n');",
        "  process.exit(0);",
        '}',
        "throw new Error('unknown generated task: ' + task);",
        ''
      ].join('\n')
    );
    const dataDir = await tempDir('vibeloop-orch-ru3-data-');

    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((value: string) => logs.push(value));
    try {
      await createProgram().parseAsync([
        'node',
        'vibeloop',
        '--data-dir',
        dataDir,
        'orchestrate',
        '--repo',
        repo.repoPath,
        '--eval',
        path.join(repo.repoPath, 'eval.yaml'),
        '--agent',
        `command:node ${agent}`,
        '--max-issues',
        '2',
        '--promote-branch',
        'pr-candidate/orchestrate-ru3',
        '--skip-dependency-install'
      ]);
    } finally {
      spy.mockRestore();
    }

    const output = JSON.parse(logs[logs.length - 1]!) as {
      processed: number;
      pr_candidates: number;
      discovery_reports: string[];
      cumulative_promotion: {
        branch_name: string;
        applied_issue_count: number;
        rediscovery_after_each_fix: boolean;
      } | null;
      issues: Array<{
        title: string;
        pr_candidate: boolean;
        promotion: { head_sha: string } | null;
      }>;
    };
    const firstDiscovery = JSON.parse(
      await readFile(output.discovery_reports[0]!, 'utf8')
    ) as { candidates: Array<{ location: { filePath: string } }> };
    const secondDiscovery = JSON.parse(
      await readFile(output.discovery_reports[1]!, 'utf8')
    ) as { candidates: Array<{ location: { filePath: string } }> };

    expect(output.processed).toBe(2);
    expect(output.pr_candidates).toBe(2);
    expect(output.cumulative_promotion).toMatchObject({
      branch_name: 'pr-candidate/orchestrate-ru3',
      applied_issue_count: 2,
      rediscovery_after_each_fix: true
    });
    expect(output.issues.map((issue) => issue.pr_candidate)).toEqual([
      true,
      true
    ]);
    expect(firstDiscovery.candidates[0]?.location.filePath).toBe('src/a.cjs');
    expect(secondDiscovery.candidates[0]?.location.filePath).toBe('src/b.cjs');
    await expect(
      repo.git(['show', 'pr-candidate/orchestrate-ru3:src/a.cjs'])
    ).resolves.toBe('module.exports = 2;\n');
    await expect(
      repo.git(['show', 'pr-candidate/orchestrate-ru3:src/b.cjs'])
    ).resolves.toBe('module.exports = 2;\n');
    await expect(
      repo.git(['rev-list', '--count', 'main..pr-candidate/orchestrate-ru3'])
    ).resolves.toBe('2\n');
    expect(process.exitCode).toBe(EXIT_CODES.accept);
  });

  it('can generate a minimal visible-test eval contract when no eval.yaml exists', async () => {
    const repo = await createTempGitRepo();
    await repo.write('src/value.cjs', 'module.exports = 1;\n');
    await repo.write(
      'tests/value.test.cjs',
      "const v = require('../src/value.cjs');\nif (v !== 2) { console.error('FAIL src/value.cjs: expected 2 got ' + v); process.exit(1); }\n"
    );
    await repo.write(
      'package.json',
      `${JSON.stringify({ scripts: { test: 'node tests/value.test.cjs' } }, null, 2)}\n`
    );
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'seed package test bug']);

    const fixtureDir = await tempDir('vibeloop-orch-geneval-fixture-');
    const fix = await writeScenario(fixtureDir, 'orch-geneval-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
    ]);
    const dataDir = await tempDir('vibeloop-orch-geneval-data-');

    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((value: string) => logs.push(value));
    try {
      await createProgram().parseAsync([
        'node',
        'vibeloop',
        '--data-dir',
        dataDir,
        'orchestrate',
        '--repo',
        repo.repoPath,
        '--generate-eval',
        '--agent',
        `mock:${fix}`,
        '--skip-dependency-install'
      ]);
    } finally {
      spy.mockRestore();
    }

    const output = JSON.parse(logs[logs.length - 1]!) as {
      generated_eval: boolean;
      eval_file: string;
      pr_candidates: number;
      issues: Array<{ pr_candidate: boolean }>;
    };
    const generatedEval = JSON.parse(
      await readFile(output.eval_file, 'utf8')
    ) as {
      gates: Array<{ name: string; command: string }>;
      evaluator: { require_test_on_base_pass: boolean };
    };

    expect(output.generated_eval).toBe(true);
    expect(output.pr_candidates).toBe(1);
    expect(output.issues[0]?.pr_candidate).toBe(true);
    expect(generatedEval.gates.map((gate) => gate.name)).toContain(
      'unit_tests'
    );
    expect(
      generatedEval.gates.find((gate) => gate.name === 'unit_tests')?.command
    ).toBe('npm test');
    expect(generatedEval.evaluator.require_test_on_base_pass).toBe(true);
    expect(process.exitCode).toBe(EXIT_CODES.accept);
  });

  it('errors when no eval contract is available', async () => {
    const repo = await createTempGitRepo();
    await repo.write('src/value.cjs', 'module.exports = 1;\n');
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'seed']);
    const dataDir = await tempDir('vibeloop-orch-noeval-');

    await expect(
      createProgram().parseAsync([
        'node',
        'vibeloop',
        '--data-dir',
        dataDir,
        'orchestrate',
        '--repo',
        repo.repoPath,
        '--agent',
        'mock:does-not-matter.json',
        '--skip-dependency-install'
      ])
    ).rejects.toThrow(/eval\.yaml/i);
  });
});
