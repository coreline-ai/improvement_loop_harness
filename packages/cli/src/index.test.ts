import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTempGitRepo } from '../../../tests/helpers/repo.js';
import { hashRuleSpec } from '../../eval-engine/src/rulepack-shadow.js';
import { EXIT_CODES } from './exit-codes.js';
import { createProgram, VERSION } from './index.js';
import { renderLoopHtmlReport } from './commands/report.js';
import { retryLoop } from './commands/retry.js';
import {
  commandQualityJudge,
  FIXED_ADVERSARY_REVIEW_PROMPT,
  FIXED_ADVERSARY_REVIEW_PROMPT_VERSION,
  resolveAdversaryReviewIndependence,
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
  agentTimeoutSeconds?: number | undefined;
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
      ...(options.agentTimeoutSeconds
        ? [`  agent_timeout_seconds: ${options.agentTimeoutSeconds}`]
        : []),
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
        'execution:',
        '  isolation: none',
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

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function frozenRulepackFixture(): Record<string, unknown> {
  const lockInput = {
    source_candidate_ref: 'adversary-rulepack-candidate.json',
    source_replay_ref: 'm4-replay-result.json',
    source_loop_id: 'source-loop',
    source_base_commit: 'abc123',
    rules: [
      { id: 'baseline:rule', hash: 'sha256:base' },
      { id: 'adversary:p-fixed-edge', hash: 'sha256:edge' }
    ],
    added_rules: [{ id: 'adversary:p-fixed-edge', hash: 'sha256:edge' }],
    diff: {
      added: ['adversary:p-fixed-edge'],
      removed: [],
      changed: [],
      appendOnly: true
    },
    replay: {
      replaySafe: true,
      total: 2,
      matched: 2,
      mismatches: []
    }
  };
  return {
    schema_version: '1.0',
    kind: 'frozen_rulepack',
    authority: 'fixed_next_loop_gate',
    decision_impact: 'next_loop_only',
    ...lockInput,
    frozen_at: new Date(0).toISOString(),
    lock_hash: sha256(lockInput)
  };
}

describe('createProgram', () => {
  it('configures the vibeloop CLI version and Phase 10 commands', () => {
    const program = createProgram();

    expect(program.name()).toBe('vibeloop');
    expect(program.version()).toBe(VERSION);
    expect(program.commands.map((command) => command.name()).sort()).toEqual([
      'adversary-confirm',
      'adversary-rulepack-candidate',
      'adversary-rulepack-freeze',
      'adversary-rulepack-replay',
      'adversary-rulepack-replay-corpus',
      'discover',
      'gc',
      'improve',
      'orchestrate',
      'report',
      'retry',
      'rulepack',
      'run'
    ]);
  });
});

it('rulepack inspect reports semantic readiness for executable frozen rulepacks', async () => {
  const dir = await tempDir('vibeloop-rulepack-inspect-');
  const rulepackFile = path.join(dir, 'rulepack.lock.json');
  const spec = {
    kind: 'command_test' as const,
    target_path: 'tests/adversary/value.test.cjs',
    body: 'process.exit(0);\n',
    command: 'node tests/adversary/value.test.cjs',
    expect: 'pass_to_pass' as const,
    network: 'none' as const
  };
  const rule = {
    id: 'adversary:p-value',
    hash: hashRuleSpec(spec),
    spec
  };
  const lockInput = {
    source_candidate_ref: 'rulepack-candidate.json',
    source_replay_ref: 'm4-replay.json',
    source_loop_id: 'loop-n',
    source_base_commit: 'base-before-learning',
    rules: [{ id: 'baseline:rule', hash: 'sha256:base' }, rule],
    added_rules: [rule],
    diff: {
      added: ['adversary:p-value'],
      removed: [],
      changed: [],
      appendOnly: true
    },
    replay: {
      replaySafe: true,
      total: 1,
      matched: 1,
      mismatches: []
    }
  };
  await writeFile(
    rulepackFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'frozen_rulepack',
        authority: 'fixed_next_loop_gate',
        decision_impact: 'next_loop_only',
        ...lockInput,
        frozen_at: new Date(0).toISOString(),
        lock_hash: sha256(lockInput)
      },
      null,
      2
    )}\n`
  );

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'rulepack',
      'inspect',
      rulepackFile
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    valid: boolean;
    semantic_ready: boolean;
    status: string;
    executable_rule_count: number;
    violations: unknown[];
    semantic_violations: unknown[];
  };
  expect(output).toMatchObject({
    valid: true,
    semantic_ready: true,
    status: 'semantic_ready',
    executable_rule_count: 1,
    violations: [],
    semantic_violations: []
  });
  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
});

it('rulepack inspect rejects replay-unsafe or tampered frozen rulepacks', async () => {
  const dir = await tempDir('vibeloop-rulepack-inspect-invalid-');
  const rulepackFile = path.join(dir, 'rulepack.lock.json');
  const tampered = frozenRulepackFixture();
  (tampered.replay as { replaySafe: boolean }).replaySafe = false;
  await writeFile(rulepackFile, `${JSON.stringify(tampered, null, 2)}\n`);

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'rulepack',
      'inspect',
      rulepackFile
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    valid: boolean;
    status: string;
    violations: Array<{ code: string }>;
  };
  expect(output.valid).toBe(false);
  expect(output.status).toBe('invalid');
  expect(output.violations.map((entry) => entry.code)).toEqual(
    expect.arrayContaining([
      'RULEPACK_REPLAY_UNSAFE',
      'RULEPACK_LOCK_HASH_MISMATCH'
    ])
  );
  expect(process.exitCode).toBe(EXIT_CODES.reject);
  process.exitCode = 0;
});

it('adversary-rulepack-replay-corpus builds replay cases from M2-confirmed proposals', async () => {
  const dir = await tempDir('vibeloop-adversary-replay-corpus-');
  const handoffFile = path.join(dir, 'adversary-m2-handoff.json');
  const candidateFile = path.join(dir, 'rulepack-candidate.json');
  const outFile = path.join(dir, 'adversary-replay-corpus.json');
  await writeFile(
    handoffFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_m2_handoff',
        authority: 'advisory_only',
        decision_impact: 'none',
        loop_id: 'handoff-loop',
        base_commit: 'abc123',
        selected_candidate_id: 'handoff-c0',
        selected_patch: '/tmp/candidate.patch',
        next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
        proposals: [
          {
            proposal: {
              id: 'p-fixed-edge',
              targetPath: 'tests/adversary/fixed-edge.test.cjs',
              body: '// fixed edge guard\nprocess.exit(0);\n',
              expectation: 'pass_to_pass'
            },
            next_step: 'm2_execution_required'
          }
        ]
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    candidateFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_rulepack_candidate',
        authority: 'candidate_only',
        decision_impact: 'none',
        candidate_created: true,
        status: 'candidate_created_m4_required',
        reasons: [],
        selected_candidate_id: 'handoff-c0',
        source_loop_id: 'handoff-loop',
        source_base_commit: 'abc123',
        source_handoff_ref: handoffFile,
        source_confirmation_ref: path.join(dir, 'm2-confirmation.json'),
        current_rules: [{ id: 'baseline:rule', hash: 'sha256:base' }],
        proposed_rules: [
          { id: 'baseline:rule', hash: 'sha256:base' },
          { id: 'adversary:p-fixed-edge', hash: 'sha256:edge' }
        ],
        added_rules: [{ id: 'adversary:p-fixed-edge', hash: 'sha256:edge' }],
        diff: {
          added: ['adversary:p-fixed-edge'],
          removed: [],
          changed: [],
          appendOnly: true
        },
        next_step: 'm4_replay_freeze_required'
      },
      null,
      2
    )}\n`
  );

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'adversary-rulepack-replay-corpus',
      '--handoff',
      handoffFile,
      '--candidate',
      candidateFile,
      '--test-command',
      'node tests/adversary/fixed-edge.test.cjs',
      '--out',
      outFile
    ]);
  } finally {
    spy.mockRestore();
  }

  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
  const output = JSON.parse(logs.join('\n')) as {
    kind: string;
    authority: string;
    decision_impact: string;
    case_count: number;
    cases: Array<{ id: string; command: string; expect: string }>;
    next_step: string;
  };
  const persisted = JSON.parse(
    await readFile(outFile, 'utf8')
  ) as typeof output;
  expect(output).toMatchObject({
    kind: 'adversary_replay_corpus',
    authority: 'm2_confirmed_proposal_replay_corpus',
    decision_impact: 'none',
    case_count: 1,
    cases: [
      expect.objectContaining({
        id: 'adversary:p-fixed-edge',
        expect: 'pass'
      })
    ],
    next_step: 'run_adversary_rulepack_replay'
  });
  expect(output.cases[0].command).toContain(
    "cat > 'tests/adversary/fixed-edge.test.cjs'"
  );
  expect(output.cases[0].command).toContain(
    'node tests/adversary/fixed-edge.test.cjs'
  );
  expect(persisted).toMatchObject(output);
});

it('adversary-rulepack-replay validates a replay corpus without changing accept authority', async () => {
  const dir = await tempDir('vibeloop-adversary-rulepack-replay-');
  const corpusFile = path.join(dir, 'adversary-replay-corpus.json');
  const outFile = path.join(dir, 'm4-replay.json');
  await writeFile(
    corpusFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_replay_corpus',
        cases: [
          {
            id: 'known-good',
            command: 'npm test',
            expect: 'pass'
          }
        ]
      },
      null,
      2
    )}\n`
  );

  await createProgram().parseAsync([
    'node',
    'vibeloop',
    'adversary-rulepack-replay',
    '--corpus',
    corpusFile,
    '--out',
    outFile
  ]);

  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
  const output = JSON.parse(await readFile(outFile, 'utf8')) as {
    kind: string;
    authority: string;
    decision_impact: string;
    execute_requested: boolean;
    executed: boolean;
    replaySafe: boolean;
    total: number;
    next_step: string;
  };
  expect(output).toMatchObject({
    kind: 'adversary_rulepack_replay',
    authority: 'deterministic_m4_replay',
    decision_impact: 'none',
    execute_requested: false,
    executed: false,
    replaySafe: false,
    total: 1,
    next_step: 'execute_required'
  });
});

it('adversary-confirm consumes an M2 handoff in dry-run mode without changing accept authority', async () => {
  const dir = await tempDir('vibeloop-adversary-confirm-');
  const handoffFile = path.join(dir, 'adversary-m2-handoff.json');
  const outFile = path.join(dir, 'm2-confirmation.json');
  await writeFile(
    handoffFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_m2_handoff',
        authority: 'advisory_only',
        decision_impact: 'none',
        loop_id: 'handoff-loop',
        base_commit: 'abc123',
        selected_candidate_id: 'handoff-c0',
        selected_patch: '/tmp/candidate.patch',
        next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
        proposals: [
          {
            proposal: {
              id: 'p-fixed-edge',
              targetPath: 'tests/adversary/fixed-edge.test.cjs',
              body: '// fixed edge guard\nprocess.exit(0);\n',
              expectation: 'pass_to_pass'
            },
            next_step: 'm2_execution_required'
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'adversary-confirm',
      '--handoff',
      handoffFile,
      '--objective-term',
      'fixed',
      '--out',
      outFile
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    kind: string;
    authority: string;
    decision_impact: string;
    executed: boolean;
    next_step: string;
    confirmations: Array<{ executed: boolean; confirmed: boolean }>;
  };
  const persisted = JSON.parse(
    await readFile(outFile, 'utf8')
  ) as typeof output;
  expect(output).toMatchObject({
    kind: 'adversary_m2_confirmation',
    authority: 'deterministic_isolated_execution',
    decision_impact: 'none',
    executed: false,
    next_step: 'execute_required'
  });
  expect(output.confirmations).toEqual([
    expect.objectContaining({ executed: false, confirmed: false })
  ]);
  expect(persisted).toMatchObject(output);
  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
});

it('adversary-rulepack-candidate emits candidate-only rules after confirmed M2 execution', async () => {
  const dir = await tempDir('vibeloop-adversary-rulepack-candidate-');
  const handoffFile = path.join(dir, 'adversary-m2-handoff.json');
  const confirmationFile = path.join(dir, 'm2-confirmation.json');
  const outFile = path.join(dir, 'rulepack-candidate.json');
  const currentRulepackFile = path.join(dir, 'current-rulepack.json');
  await writeFile(
    handoffFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_m2_handoff',
        authority: 'advisory_only',
        decision_impact: 'none',
        loop_id: 'handoff-loop',
        base_commit: 'abc123',
        selected_candidate_id: 'handoff-c0',
        selected_patch: '/tmp/candidate.patch',
        next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
        proposals: [
          {
            proposal: {
              id: 'p-fixed-edge',
              targetPath: 'tests/adversary/fixed-edge.test.cjs',
              body: '// fixed edge guard\nprocess.exit(0);\n',
              expectation: 'pass_to_pass'
            },
            next_step: 'm2_execution_required'
          }
        ]
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    confirmationFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_m2_confirmation',
        handoff_ref: handoffFile,
        authority: 'deterministic_isolated_execution',
        decision_impact: 'none',
        execute_requested: true,
        executed: true,
        runtime_available: true,
        selected_candidate_id: 'handoff-c0',
        proposal_count: 1,
        confirmed_count: 1,
        all_confirmed: true,
        execution: {
          image: 'node:22',
          test_command: 'node tests/adversary/fixed-edge.test.cjs',
          network: 'none'
        },
        next_step: 'm4_replay_freeze_required',
        confirmations: [
          {
            proposalId: 'p-fixed-edge',
            executed: true,
            confirmed: true,
            reason: 'confirmed in isolated fixture'
          }
        ]
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    currentRulepackFile,
    `${JSON.stringify({ rules: [{ id: 'baseline:rule', hash: 'sha256:base' }] })}\n`
  );

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'adversary-rulepack-candidate',
      '--handoff',
      handoffFile,
      '--confirmation',
      confirmationFile,
      '--current-rulepack',
      currentRulepackFile,
      '--out',
      outFile
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    kind: string;
    authority: string;
    decision_impact: string;
    candidate_created: boolean;
    next_step: string;
    source_loop_id: string;
    source_base_commit: string;
    added_rules: Array<{
      id: string;
      hash: string;
      spec: {
        kind: 'command_test';
        target_path: string;
        body: string;
        command: string;
        expect: 'fail_to_pass' | 'pass_to_pass';
        network: 'none';
      };
    }>;
    diff: { added: string[]; removed: string[]; changed: string[] };
  };
  const persisted = JSON.parse(
    await readFile(outFile, 'utf8')
  ) as typeof output;
  expect(output).toMatchObject({
    kind: 'adversary_rulepack_candidate',
    authority: 'candidate_only',
    decision_impact: 'none',
    candidate_created: true,
    next_step: 'm4_replay_freeze_required',
    source_loop_id: 'handoff-loop',
    source_base_commit: 'abc123',
    diff: {
      added: ['adversary:p-fixed-edge'],
      removed: [],
      changed: []
    }
  });
  expect(output.added_rules).toEqual([
    expect.objectContaining({
      id: 'adversary:p-fixed-edge',
      hash: expect.stringMatching(/^sha256:/),
      spec: {
        kind: 'command_test',
        target_path: 'tests/adversary/fixed-edge.test.cjs',
        body: '// fixed edge guard\nprocess.exit(0);\n',
        command: 'node tests/adversary/fixed-edge.test.cjs',
        expect: 'pass_to_pass',
        network: 'none'
      }
    })
  ]);
  expect(output.added_rules[0]?.hash).toBe(
    hashRuleSpec(output.added_rules[0]!.spec)
  );
  expect(persisted).toMatchObject(output);
  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
});

it('adversary-rulepack-candidate rejects dry-run M2 reports and keeps them out of fixed gates', async () => {
  const dir = await tempDir('vibeloop-adversary-rulepack-reject-');
  const handoffFile = path.join(dir, 'adversary-m2-handoff.json');
  const confirmationFile = path.join(dir, 'm2-confirmation.json');
  await writeFile(
    handoffFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_m2_handoff',
        authority: 'advisory_only',
        decision_impact: 'none',
        loop_id: 'handoff-loop',
        base_commit: 'abc123',
        selected_candidate_id: 'handoff-c0',
        selected_patch: '/tmp/candidate.patch',
        next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
        proposals: [
          {
            proposal: {
              id: 'p-fixed-edge',
              targetPath: 'tests/adversary/fixed-edge.test.cjs',
              body: '// fixed edge guard\nprocess.exit(0);\n',
              expectation: 'pass_to_pass'
            },
            next_step: 'm2_execution_required'
          }
        ]
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    confirmationFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_m2_confirmation',
        handoff_ref: handoffFile,
        authority: 'deterministic_isolated_execution',
        decision_impact: 'none',
        execute_requested: false,
        executed: false,
        runtime_available: null,
        selected_candidate_id: 'handoff-c0',
        proposal_count: 1,
        confirmed_count: 0,
        all_confirmed: false,
        next_step: 'execute_required',
        confirmations: [
          {
            proposalId: 'p-fixed-edge',
            executed: false,
            confirmed: false,
            reason: 'dry-run'
          }
        ]
      },
      null,
      2
    )}\n`
  );

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'adversary-rulepack-candidate',
      '--handoff',
      handoffFile,
      '--confirmation',
      confirmationFile
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    authority: string;
    decision_impact: string;
    candidate_created: boolean;
    reasons: string[];
    next_step: string;
  };
  expect(output).toMatchObject({
    authority: 'candidate_only',
    decision_impact: 'none',
    candidate_created: false,
    next_step: 'discard_or_revise_proposals'
  });
  expect(output.reasons).toContain('m2_not_executed');
  expect(output.reasons).toContain('m2_not_confirmed');
  expect(output.reasons).toContain('no_confirmed_proposals');
  expect(process.exitCode).toBe(EXIT_CODES.reject);
  process.exitCode = 0;
});

it('adversary-rulepack-freeze freezes replay-safe candidates as next-loop-only fixed gate artifacts', async () => {
  const dir = await tempDir('vibeloop-adversary-rulepack-freeze-');
  const candidateFile = path.join(dir, 'rulepack-candidate.json');
  const replayFile = path.join(dir, 'm4-replay.json');
  const outFile = path.join(dir, 'freeze-report.json');
  const rulepackOutFile = path.join(dir, 'rulepack.lock.json');
  const fixedEdgeSpec = {
    kind: 'command_test' as const,
    target_path: 'tests/adversary/fixed-edge.test.cjs',
    body: '// fixed edge guard\nprocess.exit(0);\n',
    command: 'node tests/adversary/fixed-edge.test.cjs',
    expect: 'pass_to_pass' as const,
    network: 'none' as const
  };
  const fixedEdgeRule = {
    id: 'adversary:p-fixed-edge',
    hash: hashRuleSpec(fixedEdgeSpec),
    spec: fixedEdgeSpec
  };
  await writeFile(
    candidateFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_rulepack_candidate',
        authority: 'candidate_only',
        decision_impact: 'none',
        candidate_created: true,
        status: 'candidate_created_m4_required',
        reasons: [],
        selected_candidate_id: 'handoff-c0',
        source_loop_id: 'handoff-loop',
        source_base_commit: 'abc123',
        source_handoff_ref: '/tmp/handoff.json',
        source_confirmation_ref: '/tmp/confirmation.json',
        current_rules: [{ id: 'baseline:rule', hash: 'sha256:base' }],
        proposed_rules: [
          { id: 'baseline:rule', hash: 'sha256:base' },
          fixedEdgeRule
        ],
        added_rules: [fixedEdgeRule],
        diff: {
          added: ['adversary:p-fixed-edge'],
          removed: [],
          changed: [],
          appendOnly: true
        },
        next_step: 'm4_replay_freeze_required'
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    replayFile,
    `${JSON.stringify(
      { replaySafe: true, total: 2, matched: 2, mismatches: [] },
      null,
      2
    )}\n`
  );

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'adversary-rulepack-freeze',
      '--candidate',
      candidateFile,
      '--replay',
      replayFile,
      '--rulepack-out',
      rulepackOutFile,
      '--out',
      outFile
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    kind: string;
    authority: string;
    decision_impact: string;
    frozen: boolean;
    next_step: string;
    rulepack_ref: string;
    frozen_rulepack: {
      authority: string;
      decision_impact: string;
      source_loop_id: string;
      source_base_commit: string;
      lock_hash: string;
      rules: Array<{ id: string; hash: string; spec?: unknown }>;
    };
  };
  const persisted = JSON.parse(
    await readFile(outFile, 'utf8')
  ) as typeof output;
  const frozenRulepack = JSON.parse(
    await readFile(rulepackOutFile, 'utf8')
  ) as typeof output.frozen_rulepack;
  expect(output).toMatchObject({
    kind: 'adversary_rulepack_freeze',
    authority: 'deterministic_m4_freeze',
    decision_impact: 'next_loop_only',
    frozen: true,
    next_step: 'use_as_next_loop_fixed_gate',
    rulepack_ref: rulepackOutFile,
    frozen_rulepack: {
      authority: 'fixed_next_loop_gate',
      decision_impact: 'next_loop_only',
      source_loop_id: 'handoff-loop',
      source_base_commit: 'abc123',
      rules: [{ id: 'baseline:rule', hash: 'sha256:base' }, fixedEdgeRule]
    }
  });
  expect(output.frozen_rulepack.lock_hash).toMatch(/^sha256:/);
  expect(persisted).toMatchObject(output);
  expect(frozenRulepack).toMatchObject(output.frozen_rulepack);
  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
});

it('adversary-rulepack-freeze rejects replay-unsafe or current-loop-applied candidates', async () => {
  const dir = await tempDir('vibeloop-adversary-rulepack-freeze-reject-');
  const candidateFile = path.join(dir, 'rulepack-candidate.json');
  const replayFile = path.join(dir, 'm4-replay.json');
  await writeFile(
    candidateFile,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        kind: 'adversary_rulepack_candidate',
        authority: 'candidate_only',
        decision_impact: 'none',
        candidate_created: true,
        status: 'candidate_created_m4_required',
        reasons: [],
        selected_candidate_id: 'handoff-c0',
        source_loop_id: 'handoff-loop',
        source_base_commit: 'abc123',
        source_handoff_ref: '/tmp/handoff.json',
        source_confirmation_ref: '/tmp/confirmation.json',
        current_rules: [],
        proposed_rules: [{ id: 'adversary:p-fixed-edge', hash: 'sha256:edge' }],
        added_rules: [{ id: 'adversary:p-fixed-edge', hash: 'sha256:edge' }],
        diff: {
          added: ['adversary:p-fixed-edge'],
          removed: [],
          changed: [],
          appendOnly: true
        },
        next_step: 'm4_replay_freeze_required'
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    replayFile,
    `${JSON.stringify(
      {
        replaySafe: false,
        total: 1,
        matched: 0,
        mismatches: [{ id: 'known-good', expected: 'pass', actual: 'fail' }]
      },
      null,
      2
    )}\n`
  );

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  try {
    await createProgram().parseAsync([
      'node',
      'vibeloop',
      'adversary-rulepack-freeze',
      '--candidate',
      candidateFile,
      '--replay',
      replayFile,
      '--applied-to-current-loop'
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    frozen: boolean;
    reasons: string[];
    next_step: string;
    frozen_rulepack: unknown;
  };
  expect(output).toMatchObject({
    frozen: false,
    next_step: 'discard_or_replay',
    frozen_rulepack: null
  });
  expect(output.reasons).toContain('replay_unsafe');
  expect(output.reasons).toContain('applied_to_current_loop');
  expect(process.exitCode).toBe(EXIT_CODES.reject);
  process.exitCode = 0;
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
    discovery_report: {
      selected_count: number;
      dropped_count: number;
      cap_applied: boolean;
    };
  };

  expect(output.candidates).toHaveLength(1);
  expect(output.discovery_report).toMatchObject({
    selected_count: 1,
    dropped_count: 0,
    cap_applied: false
  });
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

it('improve does not promote when final reverify is skipped', async () => {
  const repo = await createValueRepo();
  const dataDir = await tempDir('vibeloop-cli-skiprv-promote-data-');
  const fixtureDir = await tempDir('vibeloop-cli-skiprv-promote-fixture-');
  const { taskFile, evalFile } = await writeFixtureTaskEval({
    dir: fixtureDir,
    taskId: 'cli-skiprv-promote'
  });
  const scenario = await writeScenario(fixtureDir, 'cli-skiprv-agent', [
    { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
    {
      type: 'create',
      path: 'tests/regression.test.js',
      content:
        "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
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
      'cli-skiprv-promote-1',
      '--promote-branch',
      'pr-candidate/cli-skiprv-promote-1',
      '--skip-dependency-install',
      '--skip-final-reverify'
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    selected_candidate_id: string | null;
    pr_candidate: boolean;
    promotion: unknown;
    final_verification: {
      passed: boolean;
      reverified: boolean;
      reverify_attempted: boolean;
    };
  };
  expect(output.selected_candidate_id).toBe('cli-skiprv-promote-1-c0');
  expect(output.final_verification).toMatchObject({
    passed: true,
    reverified: false,
    reverify_attempted: false
  });
  expect(output.pr_candidate).toBe(false);
  expect(output.promotion).toBeNull();
  await expect(
    repo.git(['rev-parse', '--verify', 'pr-candidate/cli-skiprv-promote-1'])
  ).rejects.toThrow();
  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
});

it('improve can push the selected final-verified patch and create a GitHub draft PR', async () => {
  const repo = await createValueRepo();
  const bareRemote = await tempDir('vibeloop-cli-draft-remote-');
  await repo.git(['init', '--bare', bareRemote]);
  await repo.git(['remote', 'add', 'origin', bareRemote]);
  await repo.git(['push', 'origin', 'main']);

  const dataDir = await tempDir('vibeloop-cli-draft-data-');
  const fixtureDir = await tempDir('vibeloop-cli-draft-fixture-');
  const { taskFile, evalFile } = await writeFixtureTaskEval({
    dir: fixtureDir,
    taskId: 'cli-draft'
  });
  const scenario = await writeScenario(fixtureDir, 'cli-draft-agent', [
    { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
    {
      type: 'create',
      path: 'tests/regression.test.js',
      content:
        "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
    }
  ]);

  const apiRequests: Array<{ method: string; path: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    const requestBody = await readRequestBody(req);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    apiRequests.push({
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body: requestBody
    });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && url.pathname.endsWith('/pulls')) {
      res.end('[]');
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/pulls')) {
      const payload = JSON.parse(requestBody) as {
        title: string;
        head: string;
        base: string;
        draft: boolean;
        body: string;
      };
      expect(payload).toMatchObject({
        title: 'VibeLoop: cli-draft-1',
        head: 'pr-candidate/cli-draft-1',
        base: 'main',
        draft: true
      });
      expect(payload.body).toContain('VibeLoop eval summary');
      expect(payload.body).toContain('`ALL_PASS`');
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          html_url:
            'https://github.com/coreline-ai/improvement_loop_harness/pull/9',
          number: 9,
          draft: true,
          auto_merge: null
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server failed');

  const logs: string[] = [];
  const spy = vi
    .spyOn(console, 'log')
    .mockImplementation((value: string) => logs.push(value));
  process.env.VIBELOOP_TEST_GITHUB_TOKEN = 'fixture-token';
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
      'cli-draft-1',
      '--skip-dependency-install',
      '--github-draft-pr',
      '--github-repo',
      'coreline-ai/improvement_loop_harness',
      '--github-token-env',
      'VIBELOOP_TEST_GITHUB_TOKEN',
      '--github-base',
      'main',
      '--github-branch',
      'pr-candidate/cli-draft-1',
      '--github-push-url',
      bareRemote,
      '--github-api-base-url',
      `http://127.0.0.1:${address.port}`
    ]);
  } finally {
    spy.mockRestore();
    delete process.env.VIBELOOP_TEST_GITHUB_TOKEN;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  const output = JSON.parse(logs.join('\n')) as {
    pr_candidate: boolean;
    draft_pr: {
      branch_name: string;
      pushed: boolean;
      pr_url: string;
      pr_number: number;
      pr_reused: boolean;
    } | null;
  };
  expect(output.pr_candidate).toBe(true);
  expect(output.draft_pr).toMatchObject({
    branch_name: 'pr-candidate/cli-draft-1',
    pushed: true,
    pr_url: 'https://github.com/coreline-ai/improvement_loop_harness/pull/9',
    pr_number: 9,
    pr_reused: false
  });
  const remoteHead = (
    await repo.git([
      'ls-remote',
      bareRemote,
      'refs/heads/pr-candidate/cli-draft-1'
    ])
  ).trim();
  expect(remoteHead).toMatch(
    /^[a-f0-9]{40}\s+refs\/heads\/pr-candidate\/cli-draft-1$/
  );
  expect(apiRequests.map((request) => request.method)).toEqual(['GET', 'POST']);
  expect(process.exitCode).toBe(EXIT_CODES.accept);
  process.exitCode = 0;
});

it('improve refuses GitHub draft PR creation when final reverify is skipped', async () => {
  await expect(
    createProgram().parseAsync([
      'node',
      'vibeloop',
      'improve',
      '--repo',
      '.',
      '--task',
      'task.yaml',
      '--eval',
      'eval.yaml',
      '--agent',
      'mock:scenario.json',
      '--skip-final-reverify',
      '--github-draft-pr',
      '--github-repo',
      'coreline-ai/improvement_loop_harness'
    ])
  ).rejects.toThrow(/requires final re-execution/);
});

it('improve warns to stderr for risky local-only flags', async () => {
  const warnings: string[] = [];
  const spy = vi
    .spyOn(console, 'error')
    .mockImplementation((value: string) => warnings.push(value));
  try {
    await expect(
      createProgram().parseAsync([
        'node',
        'vibeloop',
        'improve',
        '--repo',
        '.',
        '--task',
        'missing-task.yaml',
        '--eval',
        'missing-eval.yaml',
        '--agent',
        'mock:scenario.json',
        '--skip-final-reverify',
        '--allow-dirty'
      ])
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }

  expect(warnings.join('\n')).toContain('--skip-final-reverify skips B2');
  expect(warnings.join('\n')).toContain('--allow-dirty permits auto-base');
});

it('improve requires an image when overlaying a semantic rulepack gate', async () => {
  await expect(
    createProgram().parseAsync([
      'node',
      'vibeloop',
      'improve',
      '--repo',
      '.',
      '--task',
      'task.yaml',
      '--eval',
      'eval.yaml',
      '--agent',
      'mock:scenario.json',
      '--rulepack-semantic',
      'policy/rulepack.lock.json'
    ])
  ).rejects.toThrow(/--rulepack-semantic requires --rulepack-semantic-image/);
});

it('improve overlays a semantic rulepack gate and fails closed on an invalid lock', async () => {
  const repo = await createTempGitRepo();
  await repo.write('src/value.cjs', 'module.exports = 1;\n');
  const tampered = frozenRulepackFixture();
  (tampered.replay as { replaySafe: boolean }).replaySafe = false;
  await repo.write(
    'policy/rulepack.lock.json',
    `${JSON.stringify(tampered, null, 2)}\n`
  );
  await repo.git(['add', '-A']);
  await repo.git(['commit', '-m', 'seed tampered semantic rulepack lock']);

  const fixtureDir = await tempDir('vibeloop-cli-semantic-fixture-');
  const dataDir = await tempDir('vibeloop-cli-semantic-data-');
  const { taskFile, evalFile } = await writeFixtureTaskEval({
    dir: fixtureDir,
    taskId: 'cli-rulepack-semantic'
  });
  const fix = await writeScenario(fixtureDir, 'cli-semantic-fix', [
    { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' },
    {
      type: 'create',
      path: 'tests/regression.test.js',
      content:
        "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n"
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
      `mock:${fix}`,
      '--out',
      dataDir,
      '--loop-id',
      'cli-semantic-loop',
      '--skip-dependency-install',
      '--rulepack-semantic',
      'policy/rulepack.lock.json',
      '--rulepack-semantic-image',
      'node:22-alpine'
    ]);
  } finally {
    spy.mockRestore();
  }

  const output = JSON.parse(logs.join('\n')) as {
    accepted_count: number;
    selected_candidate_id: string | null;
    selection_report: string;
  };
  expect(output.accepted_count).toBe(0);
  expect(output.selected_candidate_id).toBeNull();

  const overlayEvalPath = path.join(
    dataDir,
    'projects',
    'default',
    'improve',
    'cli-semantic-loop',
    'eval.rulepack-semantic.json'
  );
  const overlayEval = JSON.parse(await readFile(overlayEvalPath, 'utf8')) as {
    gates: Array<{ name: string; command: string; required: boolean }>;
    protected_paths: string[];
    rulepack_semantic?: {
      file: string;
      image: string;
      network: string;
      current_loop_id: string;
      required_authority: string;
      required_decision_impact: string;
    };
  };
  expect(overlayEval.gates).toContainEqual(
    expect.objectContaining({
      name: 'rulepack_semantic',
      command: 'builtin:rulepack-semantic',
      required: true
    })
  );
  expect(overlayEval.protected_paths).toContain('policy/rulepack.lock.json');
  expect(overlayEval.rulepack_semantic).toMatchObject({
    file: 'policy/rulepack.lock.json',
    image: 'node:22-alpine',
    network: 'none',
    current_loop_id: 'cli-semantic-loop',
    required_authority: 'fixed_next_loop_gate',
    required_decision_impact: 'next_loop_only'
  });

  const selection = JSON.parse(
    await readFile(output.selection_report, 'utf8')
  ) as {
    accepted_count: number;
    candidates: Array<{ report_path?: string }>;
  };
  expect(selection.accepted_count).toBe(0);
  const report = JSON.parse(
    await readFile(selection.candidates[0]!.report_path!, 'utf8')
  ) as {
    decision: string;
    gate_runs: Array<{ name: string; status: string; stdout_ref: string }>;
    rulepack_semantic?: Array<{
      file: string;
      image: string;
      current_loop_id: string;
      status: string;
    }>;
  };
  expect(report.decision).toBe('reject');
  const semanticGate = report.gate_runs.find(
    (entry) => entry.name === 'rulepack_semantic'
  );
  expect(semanticGate?.status).toBe('fail');
  expect(report.rulepack_semantic?.[0]).toMatchObject({
    file: 'policy/rulepack.lock.json',
    image: 'node:22-alpine',
    current_loop_id: 'cli-semantic-loop',
    status: 'fail'
  });
  const stdout = await readFile(
    path.join(
      path.dirname(selection.candidates[0]!.report_path!),
      '..',
      semanticGate!.stdout_ref
    ),
    'utf8'
  );
  expect(stdout).toContain('RULEPACK_LOCK_REPLAY_UNSAFE');
  expect(stdout).toContain('RULEPACK_LOCK_HASH_MISMATCH');
  expect(process.exitCode).toBe(EXIT_CODES.reject);
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

describe('resolveAdversaryReviewIndependence', () => {
  it.each([
    [
      { builderAgentSpec: 'mock:scenario.json' },
      {
        builder_provider: 'mock',
        reviewer_provider: 'undeclared',
        same_model_review: false,
        require_different_provider: false
      }
    ],
    [
      { builderAgentSpec: 'codex', reviewerProvider: 'anthropic' },
      {
        builder_provider: 'openai',
        reviewer_provider: 'anthropic',
        same_model_review: false,
        require_different_provider: false
      }
    ],
    [
      { builderAgentSpec: 'codex', reviewerProvider: 'openai' },
      {
        builder_provider: 'openai',
        reviewer_provider: 'openai',
        same_model_review: true,
        require_different_provider: false
      }
    ],
    [
      { builderAgentSpec: 'codex', requireDifferentProvider: true },
      {
        builder_provider: 'openai',
        reviewer_provider: 'undeclared',
        same_model_review: true,
        require_different_provider: true
      }
    ]
  ] as const)(
    'records adversary reviewer independence for %j',
    (input, expected) => {
      expect(resolveAdversaryReviewIndependence(input)).toEqual(expected);
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
    expect(result.limits?.kernel_runs).toBe(3);
    expect(result.limits?.reverify_runs).toBe(1);
    expect(result.limits?.test_on_base_runs).toBe(3);
    expect(result.limits?.max_candidates).toBe(2);

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as {
      limits: {
        cap_hit: boolean;
        candidates_run: number;
        kernel_runs: number;
        reverify_runs: number;
        test_on_base_runs: number;
      };
    };
    expect(report.limits.cap_hit).toBe(true);
    expect(report.limits.candidates_run).toBe(2);
    expect(report.limits.kernel_runs).toBe(3);
    expect(report.limits.reverify_runs).toBe(1);
    expect(report.limits.test_on_base_runs).toBe(3);
  });

  it('enforces the provider token budget hook (B4) and records token_budget_hit', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-token-budget-data-');
    const fixtureDir = await tempDir('vibeloop-token-budget-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'token-budget'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const fix = await writeScenario(fixtureDir, 'token-budget-fix', [
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
    const usageSamples = [0, 20, 20];

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'token-budget-1',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`, `mock:${fix}`],
      tokenBudgetTotal: 10,
      getTokenUsage: () => ({
        total_tokens: usageSamples.shift() ?? 20
      })
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.limits).toMatchObject({
      token_budget_total: 10,
      token_usage_total: 20,
      token_budget_hit: true,
      candidates_run: 1
    });

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as {
      limits: {
        token_budget_total: number;
        token_usage_total: number;
        token_budget_hit: boolean;
      };
    };
    expect(report.limits).toMatchObject({
      token_budget_total: 10,
      token_usage_total: 20,
      token_budget_hit: true
    });
  });

  it('exposes the provider token budget through the improve CLI (B4)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-token-budget-data-');
    const fixtureDir = await tempDir('vibeloop-cli-token-budget-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cli-token-budget'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const fix = await writeScenario(fixtureDir, 'cli-token-budget-fix', [
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
    const usageSamples = [0, 20, 20];
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        `${JSON.stringify({
          usage: { total_tokens: usageSamples.shift() ?? 20 }
        })}\n`
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('server failed');

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
        `mock:${fix}`,
        '--agent',
        `mock:${fix}`,
        '--out',
        dataDir,
        '--loop-id',
        'cli-token-budget-1',
        '--skip-dependency-install',
        '--token-budget-total',
        '10',
        '--llm-proxy-url',
        `http://127.0.0.1:${address.port}`
      ]);
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }

    const output = JSON.parse(logs.join('\n')) as {
      candidate_count: number;
      limits: {
        token_budget_total: number;
        token_usage_total: number;
        token_budget_hit: boolean;
        candidates_run: number;
      };
    };
    expect(output.candidate_count).toBe(1);
    expect(output.limits).toMatchObject({
      token_budget_total: 10,
      token_usage_total: 20,
      token_budget_hit: true,
      candidates_run: 1
    });
    expect(process.exitCode).toBe(EXIT_CODES.accept);
    process.exitCode = 0;
  });

  it('exposes the deadline cost ceiling through the improve CLI (B4)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-deadline-data-');
    const fixtureDir = await tempDir('vibeloop-deadline-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'deadline'
    });
    const fix = await writeScenario(fixtureDir, 'deadline-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
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
        `mock:${fix}`,
        '--out',
        dataDir,
        '--loop-id',
        'deadline-1',
        '--skip-dependency-install',
        '--deadline',
        '0'
      ]);
    } finally {
      spy.mockRestore();
    }

    const output = JSON.parse(logs.join('\n')) as {
      candidate_count: number;
      limits: {
        deadline_ms: number;
        deadline_hit: boolean;
        candidates_run: number;
        kernel_runs: number;
        reverify_runs: number;
        test_on_base_runs: number;
      };
    };
    expect(output.candidate_count).toBe(0);
    expect(output.limits).toMatchObject({
      deadline_ms: 0,
      deadline_hit: true,
      candidates_run: 0,
      kernel_runs: 0,
      reverify_runs: 0,
      test_on_base_runs: 0
    });
    expect(process.exitCode).toBe(EXIT_CODES.reject);
    process.exitCode = 0;
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
    expect(fv?.reverify_attempted).toBe(true);
    expect(fv?.reverified).toBe(true);
    expect(fv?.reverify_decision).toBe('accept');
    expect(fv?.reverify_qualified).toBe(true);

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as {
      pr_candidate: boolean;
      final_verification: {
        passed: boolean;
        reverify_attempted: boolean;
        reverified: boolean;
      };
      limits: {
        candidates_run: number;
        kernel_runs: number;
        reverify_runs: number;
        test_on_base_runs: number;
      };
    };
    expect(report.pr_candidate).toBe(true);
    expect(report.final_verification.passed).toBe(true);
    expect(report.final_verification.reverify_attempted).toBe(true);
    expect(report.final_verification.reverified).toBe(true);
    expect(report.limits).toMatchObject({
      candidates_run: 1,
      kernel_runs: 2,
      reverify_runs: 1,
      test_on_base_runs: 2
    });
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
    expect(result.finalVerification?.candidate_patch_hash).toMatch(
      /^[a-f0-9]{64}$/
    );
    expect(result.finalVerification?.provenance_ok).toBe(true);
    expect(result.finalVerification?.reverify_attempted).toBe(false);
    expect(result.finalVerification?.reverified).toBe(false);
    expect(result.finalVerification?.passed).toBe(true);
    expect(result.limits).toMatchObject({
      candidates_run: 1,
      kernel_runs: 1,
      reverify_runs: 0,
      test_on_base_runs: 1
    });
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
    // Two accepted fixes with equal fixed scores but different patch content →
    // advisory may reorder them, but it cannot create full-improvement evidence.
    const fixA = await writeScenario(fixtureDir, 't-fix-a', [
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
    const fixB = await writeScenario(fixtureDir, 't-fix-b', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content:
          "const value = require('../src/value.cjs');\nif (Number(value) !== 2) process.exit(1);\n"
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
      builders: [`mock:${fixA}`, `mock:${fixB}`],
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
    expect(result.selectionQuality).toMatchObject({
      status: 'fixed_tie_advisory_supported',
      strict_score_improvement: false,
      advisory_supported: true,
      best_choice_supported: true,
      full_autonomous_improvement_eligible: false
    });

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as {
      advisory_tie_break: { changed_pick: boolean } | null;
      selection_quality: {
        status: string;
        full_autonomous_improvement_eligible: boolean;
      };
    };
    expect(report.advisory_tie_break?.changed_pick).toBe(true);
    expect(report.selection_quality).toMatchObject({
      status: 'fixed_tie_advisory_supported',
      full_autonomous_improvement_eligible: false
    });
  });

  it('treats identical accepted patch convergence as fixed full-improvement evidence', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-converge-data-');
    const fixtureDir = await tempDir('vibeloop-converge-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'converge'
    });
    const fix = await writeScenario(fixtureDir, 'converged-fix', [
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

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'converge-1',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`, `mock:${fix}`]
    });

    expect(result.selected?.candidateId).toBe('converge-1-c0');
    expect(result.finalVerification?.passed).toBe(true);
    expect(result.selectionQuality).toMatchObject({
      status: 'fixed_equivalent_patch_convergence',
      strict_score_improvement: true,
      equivalent_patch_convergence: true,
      advisory_supported: false,
      best_choice_supported: true,
      full_autonomous_improvement_eligible: true,
      evidence: 'equivalent_patch_hash_convergence'
    });

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as {
      selection_quality: {
        status: string;
        equivalent_patch_convergence: boolean;
        full_autonomous_improvement_eligible: boolean;
      };
      candidates: Array<{ patch_hash?: string }>;
    };
    expect(report.selection_quality).toMatchObject({
      status: 'fixed_equivalent_patch_convergence',
      equivalent_patch_convergence: true,
      full_autonomous_improvement_eligible: true
    });
    expect(
      new Set(report.candidates.map((candidate) => candidate.patch_hash)).size
    ).toBe(1);
  });

  it('uses a converged top-score patch group when another top candidate ties', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-converged-subset-data-');
    const fixtureDir = await tempDir('vibeloop-converged-subset-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'converged-subset'
    });
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value !== 2) process.exit(1);\n";
    const variant = await writeScenario(fixtureDir, 'variant-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = Number(2);\n'
      },
      {
        type: 'create',
        path: 'tests/regression.test.js',
        content: regressionTest
      }
    ]);
    const converged = await writeScenario(fixtureDir, 'converged-fix', [
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
      loopId: 'converged-subset-1',
      skipDependencyInstall: true,
      builders: [`mock:${variant}`, `mock:${converged}`, `mock:${converged}`]
    });

    expect(result.selected?.candidateId).toBe('converged-subset-1-c1');
    expect(result.selectionQuality).toMatchObject({
      status: 'fixed_equivalent_patch_convergence',
      strict_score_improvement: true,
      equivalent_patch_convergence: true,
      full_autonomous_improvement_eligible: true
    });

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as {
      selection_quality: {
        selected_candidate_id: string;
        equivalent_patch_convergence: boolean;
      };
      candidates: Array<{ patch_hash?: string }>;
    };
    expect(report.selection_quality).toMatchObject({
      selected_candidate_id: 'converged-subset-1-c1',
      equivalent_patch_convergence: true
    });
    expect(
      new Set(report.candidates.map((candidate) => candidate.patch_hash)).size
    ).toBe(2);
  }, 30000);

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
    expect(result.selectionQuality).toMatchObject({
      status: 'strict_fixed_score_win',
      strict_score_improvement: true,
      advisory_supported: false,
      best_choice_supported: true,
      full_autonomous_improvement_eligible: true,
      evidence: 'strict_fixed_score_spread'
    });
  });

  it('uses deterministic Q5 metric deltas to choose the better accepted candidate', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-q5-score-data-');
    const fixtureDir = await tempDir('vibeloop-q5-score-fixture-');
    const taskFile = path.join(fixtureDir, 'q5-score.task.yaml');
    const evalFile = path.join(fixtureDir, 'q5-score.eval.yaml');
    const metricCommand =
      "node -e \"const fs=require('node:fs'); const v=require('./src/value.cjs'); fs.writeFileSync(process.env.VIBELOOP_METRICS_FILE, JSON.stringify({coverage_percent:v})); if (v < 2) process.exit(1);\"";
    await writeFile(
      taskFile,
      [
        'schema_version: "1.0"',
        'id: q5-score',
        'title: Q5 score fixture',
        'objective: Prefer the accepted fix with the stronger fixed metric delta',
        'base_branch: main',
        'risk_area: none',
        'write_scope:',
        '  allowed:',
        '    - src/',
        '    - tests/',
        'required_evidence:',
        '  - adds_regression_test',
        'limits:',
        '  max_changed_files: 10',
        '  max_changed_lines: 200',
        'acceptance:',
        '  required_tests:',
        '    - node tests/regression.test.js',
        ''
      ].join('\n')
    );
    await writeFile(
      evalFile,
      [
        'schema_version: "1.0"',
        'project: q5-score-fixture',
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
        'test_integrity:',
        '  forbidden_patterns:',
        '    - test.skip',
        '    - it.only',
        'execution:',
        '  isolation: none',
        'gates:',
        '  - name: unit_tests',
        '    type: task_acceptance',
        '    command: node tests/regression.test.js',
        '    required: true',
        '  - name: coverage_metric',
        '    type: performance',
        `    command: ${JSON.stringify(metricCommand)}`,
        '    required: true',
        'evaluator:',
        '  min_evidence_present: 1',
        '  min_coverage_delta: 1',
        '  max_changed_files: 2',
        '  max_changed_lines: 10',
        ''
      ].join('\n')
    );
    const regressionTest =
      "const value = require('../src/value.cjs');\nif (value < 2) process.exit(1);\n";
    const minPass = await writeScenario(fixtureDir, 'q5-min-pass', [
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
    const strongerMetric = await writeScenario(fixtureDir, 'q5-stronger', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 3;\n'
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
      loopId: 'q5-score-1',
      skipDependencyInstall: true,
      builders: [`mock:${minPass}`, `mock:${strongerMetric}`],
      qualityJudge: async () => {
        judgeCalls += 1;
        return { winner_candidate_id: 'q5-score-1-c0' };
      }
    });

    expect(judgeCalls).toBe(0);
    expect(result.selected?.candidateId).toBe('q5-score-1-c1');
    expect(
      result.candidates.find((c) => c.candidateId.endsWith('-c0'))?.score
    ).toMatchObject({
      evidence_present: 1,
      changed_files: 2,
      quality_metric_score: 1
    });
    expect(
      result.candidates.find((c) => c.candidateId.endsWith('-c1'))?.score
    ).toMatchObject({
      evidence_present: 1,
      changed_files: 2,
      quality_metric_score: 2
    });
    expect(result.selectionQuality).toMatchObject({
      status: 'strict_fixed_score_win',
      strict_score_improvement: true,
      advisory_supported: false,
      best_choice_supported: true,
      full_autonomous_improvement_eligible: true,
      evidence: 'strict_fixed_score_spread'
    });
    expect(result.selectionQuality?.score_spread).toBe(1);
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

  it('default quality judge prefers a defensive fix among score-tied candidates', async () => {
    const dir = await tempDir('vibeloop-default-quality-judge-');
    const basicPatch = path.join(dir, 'basic.patch');
    const defensivePatch = path.join(dir, 'defensive.patch');
    await writeFile(
      basicPatch,
      [
        'diff --git a/src/cart.cjs b/src/cart.cjs',
        '--- a/src/cart.cjs',
        '+++ b/src/cart.cjs',
        '@@ -1 +1 @@',
        '-return item.price;',
        '+return item.price * item.quantity;',
        ''
      ].join('\n')
    );
    await writeFile(
      defensivePatch,
      [
        'diff --git a/src/cart.cjs b/src/cart.cjs',
        '--- a/src/cart.cjs',
        '+++ b/src/cart.cjs',
        '@@ -1 +1 @@',
        '-return item.price;',
        '+return item.price * (item.quantity ?? 1);',
        ''
      ].join('\n')
    );
    const judge = commandQualityJudge(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(
        path.join(process.cwd(), 'scripts/uat/quality-judge-best-patch.mjs')
      )}`
    );
    const verdict = await judge({
      tied: [
        { candidate_id: 'c0', artifact_root: dir, patch_ref: basicPatch },
        { candidate_id: 'c1', artifact_root: dir, patch_ref: defensivePatch }
      ]
    });
    expect(verdict.winner_candidate_id).toBe('c1');
    expect(verdict.rationale).toContain('handles missing cart quantity');
  });

  it('runs an adversary reviewer as advisory-only and filters proposed tests without changing selection (M2 entry)', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-adversary-review-data-');
    const fixtureDir = await tempDir('vibeloop-adversary-review-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'adversary-review'
    });
    const fix = await writeScenario(fixtureDir, 'ar-fix', [
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

    let reviewerPrompt: string | undefined;
    let reviewerPromptVersion: string | undefined;
    let reviewerDecisionImpact: string | undefined;
    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'adversary-review-1',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`],
      adversaryReviewer: async (input) => {
        reviewerPrompt = input.reviewer_context.prompt;
        reviewerPromptVersion = input.reviewer_context.prompt_version;
        reviewerDecisionImpact = input.reviewer_context.decision_impact;
        return {
          findings: [
            {
              severity: 'high',
              message: `try edge case against ${input.selected.candidate_id}`,
              suggested_test_id: 'adv-value-edge'
            }
          ],
          proposals: [
            {
              id: 'adv-value-edge',
              targetPath:
                'tests/adversary/adversary-review-value-edge.test.cjs',
              body: "// adversary-review objective edge\nconst value = require('../../src/value.cjs');\nif (value !== 2) process.exit(1);\n",
              expectation: 'pass_to_pass'
            },
            {
              id: 'adv-hidden-leak',
              targetPath: 'tests/adversary/hidden.test.cjs',
              body: 'console.log("SECRET_HIDDEN_EXPECTATION");',
              expectation: 'pass_to_pass'
            }
          ]
        };
      }
    });

    expect(reviewerPrompt).toBe(FIXED_ADVERSARY_REVIEW_PROMPT);
    expect(reviewerPrompt).toContain('Do not approve the change');
    expect(reviewerPromptVersion).toBe(FIXED_ADVERSARY_REVIEW_PROMPT_VERSION);
    expect(reviewerDecisionImpact).toBe('none');
    expect(result.selected?.candidateId).toBe('adversary-review-1-c0');
    expect(result.finalVerification?.passed).toBe(true);
    expect(result.selectionQuality).toMatchObject({
      status: 'single_accepted_no_comparator',
      strict_score_improvement: false,
      best_choice_supported: false,
      full_autonomous_improvement_eligible: false
    });
    expect(result.adversaryReview).toMatchObject({
      ran: true,
      authority: 'advisory_only',
      decision_impact: 'none',
      selected_candidate_id: 'adversary-review-1-c0',
      builder_provider: 'mock',
      reviewer_provider: 'undeclared',
      same_model_review: false,
      require_different_provider: false,
      prompt_version: FIXED_ADVERSARY_REVIEW_PROMPT_VERSION,
      prompt_hash: expect.stringMatching(/^sha256:/),
      accepted_proposal_count: 1,
      requires_human_review_signal: true,
      next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop'
    });
    expect(result.adversaryReview?.proposals[0]?.filter.accepted).toBe(true);
    expect(result.adversaryReview?.proposals[0]?.next_step).toBe(
      'm2_execution_required'
    );
    expect(result.adversaryReview?.proposals[1]?.filter.accepted).toBe(false);
    expect(
      result.adversaryReview?.proposals[1]?.filter.failedFilters
    ).toContain('no_hidden_leak');

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as {
      selected_candidate_id: string;
      pr_candidate: boolean;
      adversary_review: {
        decision_impact: string;
        builder_provider: string;
        reviewer_provider: string;
        same_model_review: boolean;
        prompt_version: string;
        prompt_hash: string;
        accepted_proposal_count: number;
        m2_handoff_ref?: string;
      } | null;
    };
    expect(report.selected_candidate_id).toBe('adversary-review-1-c0');
    expect(report.pr_candidate).toBe(true);
    expect(report.adversary_review).toMatchObject({
      decision_impact: 'none',
      builder_provider: 'mock',
      reviewer_provider: 'undeclared',
      same_model_review: false,
      prompt_version: FIXED_ADVERSARY_REVIEW_PROMPT_VERSION,
      prompt_hash: expect.stringMatching(/^sha256:/),
      accepted_proposal_count: 1
    });
    expect(report.adversary_review?.m2_handoff_ref).toBe(
      result.adversaryReview?.m2_handoff_ref
    );
    const handoff = JSON.parse(
      await readFile(result.adversaryReview!.m2_handoff_ref!, 'utf8')
    ) as {
      authority: string;
      decision_impact: string;
      selected_candidate_id: string;
      proposals: Array<{ proposal: { id: string; body: string } }>;
      next_step: string;
    };
    expect(handoff).toMatchObject({
      authority: 'advisory_only',
      decision_impact: 'none',
      selected_candidate_id: 'adversary-review-1-c0',
      next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop'
    });
    expect(handoff.proposals).toHaveLength(1);
    expect(handoff.proposals[0]!.proposal.id).toBe('adv-value-edge');
    expect(JSON.stringify(handoff)).not.toContain('SECRET_HIDDEN_EXPECTATION');
  });

  it('keeps deterministic selection when adversary reviewer fails', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-adversary-fail-data-');
    const fixtureDir = await tempDir('vibeloop-adversary-fail-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'adversary-fail'
    });
    const fix = await writeScenario(fixtureDir, 'ar-fail-fix', [
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

    const result = await runImprovementLoop({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      loopId: 'adversary-fail-1',
      skipDependencyInstall: true,
      builders: [`mock:${fix}`],
      adversaryReviewer: async () => {
        throw new Error('reviewer unavailable');
      }
    });

    expect(result.selected?.candidateId).toBe('adversary-fail-1-c0');
    expect(result.finalVerification?.passed).toBe(true);
    expect(result.adversaryReview).toMatchObject({
      ran: true,
      authority: 'advisory_only',
      decision_impact: 'none',
      selected_candidate_id: 'adversary-fail-1-c0',
      accepted_proposal_count: 0,
      requires_human_review_signal: true,
      next_step: 'none',
      error: 'reviewer unavailable'
    });

    const report = JSON.parse(
      await readFile(result.selectionReportPath!, 'utf8')
    ) as {
      selected_candidate_id: string;
      pr_candidate: boolean;
      adversary_review: { decision_impact: string; error: string } | null;
    };
    expect(report.selected_candidate_id).toBe('adversary-fail-1-c0');
    expect(report.pr_candidate).toBe(true);
    expect(report.adversary_review).toMatchObject({
      decision_impact: 'none',
      error: 'reviewer unavailable'
    });
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

    const previousSnapshotValue = process.env.VIBELOOP_ENV_SNAPSHOT_TEST_VALUE;
    process.env.VIBELOOP_ENV_SNAPSHOT_TEST_VALUE = 'do-not-persist-this-value';
    const result = await runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-happy',
      skipDependencyInstall: true
    });
    if (previousSnapshotValue === undefined) {
      delete process.env.VIBELOOP_ENV_SNAPSHOT_TEST_VALUE;
    } else {
      process.env.VIBELOOP_ENV_SNAPSHOT_TEST_VALUE = previousSnapshotValue;
    }
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8')) as {
      decision: string;
      improvement_evidence: Array<{ status: string }>;
      artifact_refs: string[];
    };
    const envSnapshot = JSON.parse(
      await readFile(
        path.join(result.layout.input, 'env-snapshot.json'),
        'utf8'
      )
    ) as { keys: string[]; values_redacted: boolean; env?: unknown };

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
    expect(envSnapshot.values_redacted).toBe(true);
    expect(envSnapshot.keys).toContain('VIBELOOP_ENV_SNAPSHOT_TEST_VALUE');
    expect(envSnapshot.env).toBeUndefined();
    expect(JSON.stringify(envSnapshot)).not.toContain(
      'do-not-persist-this-value'
    );
    await expect(
      fileExists(path.join(result.layout.workspace, 'workspace-ref.json'))
    ).resolves.toBe(true);
    expect(report.artifact_refs).toContain('workspace/workspace-ref.json');
    const html = await renderLoopHtmlReport({ dataDir, loopId: result.loopId });
    expect(html.fileUrl).toMatch(/^file:\/\//);
    expect(await readFile(html.path, 'utf8')).toContain('VibeLoop Eval Report');
  });

  it('keeps optional gate errors as report trust signals without changing accept decisions', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-optional-gate-data-');
    const fixtureDir = await tempDir('vibeloop-cli-optional-gate-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cli-optional-gate-error',
      gates: [
        'schema_version: "1.0"',
        'project: cli-fixture',
        'protected_paths:',
        '  - .env',
        '  - .env.*',
        '  - eval.yaml',
        '  - scripts/eval.sh',
        'risk_classification:',
        '  none:',
        '    - src/',
        '    - tests/',
        'limits:',
        '  max_changed_files: 10',
        '  max_changed_lines: 200',
        'test_integrity:',
        '  forbidden_patterns:',
        '    - test.skip',
        '    - it.only',
        '  suspicious_patterns:',
        '    - expect(true).toBe(true)',
        'execution:',
        '  isolation: none',
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
        '  - name: optional_timeout',
        '    type: hard',
        '    command: node -e "setInterval(()=>{},1000)"',
        '    required: false',
        '    timeout_seconds: 1',
        ''
      ].join('\n')
    });
    const scenario = await writeScenario(fixtureDir, 'optional-gate-error', [
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
      loopId: 'loop-cli-optional-gate-error',
      skipDependencyInstall: true
    });
    const report = JSON.parse(await readFile(result.reportPath!, 'utf8')) as {
      decision: string;
      gate_runs: Array<{ name: string; status: string; summary?: string }>;
      trust_summary?: {
        advisory_findings_count?: number;
        optional_gate_errors_count?: number;
      };
      advisory_findings?: Array<{
        source?: string;
        gate?: string;
        authority?: string;
      }>;
    };

    expect(result.status).toBe('accepted');
    expect(report.decision).toBe('accept');
    expect(
      report.gate_runs.find((gate) => gate.name === 'optional_timeout')
    ).toMatchObject({ status: 'error', summary: 'gate timed out' });
    expect(report.trust_summary?.optional_gate_errors_count).toBe(1);
    expect(report.trust_summary?.advisory_findings_count).toBe(1);
    expect(report.advisory_findings).toContainEqual(
      expect.objectContaining({
        source: 'optional_gate_error',
        gate: 'optional_timeout',
        authority: 'trust_signal'
      })
    );
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

  it('fails a hanging agent at the task agent_timeout_seconds limit', async () => {
    const repo = await createValueRepo();
    const dataDir = await tempDir('vibeloop-cli-agent-timeout-data-');
    const fixtureDir = await tempDir('vibeloop-cli-agent-timeout-fixture-');
    const { taskFile, evalFile } = await writeFixtureTaskEval({
      dir: fixtureDir,
      taskId: 'cli-agent-timeout',
      agentTimeoutSeconds: 1
    });
    const scenario = await writeScenario(fixtureDir, 'slow-agent', [
      { type: 'sleep', ms: 5_000 }
    ]);

    const started = Date.now();
    const result = await runKernel({
      repoPath: repo.repoPath,
      taskFile,
      evalFile,
      dataDir,
      agentSpec: `mock:${scenario}`,
      loopId: 'loop-cli-agent-timeout',
      skipDependencyInstall: true
    });

    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(EXIT_CODES.failed);
    const agentStderr = await readFile(
      path.join(result.layout.root, 'logs/agent.stderr.log'),
      'utf8'
    );
    expect(agentStderr).toContain('timed out');
  });
});

describe('orchestrate (auto mode)', () => {
  async function seedRepoWithFailingTest(): Promise<{
    repoPath: string;
    evalFile: string;
    git: (args: readonly string[]) => Promise<string>;
    write: (filePath: string, content: string) => Promise<void>;
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
        'execution:',
        '  isolation: none',
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
      git: repo.git,
      write: repo.write
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
      raw_discovered: number;
      dropped_by_discovery_cap: number;
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
    expect(output.raw_discovered).toBeGreaterThanOrEqual(output.discovered);
    expect(output.dropped_by_discovery_cap).toBe(0);
    expect(output.processed).toBe(1);
    expect(output.issues).toHaveLength(1);
    expect(output.issues[0]?.source).toBe('test_failure');
    expect(output.issues[0]?.pr_candidate).toBe(true);
    expect(output.issues[0]?.final_verification?.passed).toBe(true);
    expect(output.pr_candidates).toBe(1);
    // discovery report persisted to disk (step 6).
    await expect(fileExists(output.discovery_report)).resolves.toBe(true);
    const discoveryReport = JSON.parse(
      await readFile(output.discovery_report, 'utf8')
    ) as {
      discovery_cap: { selected_count: number; dropped_count: number };
    };
    expect(discoveryReport.discovery_cap).toMatchObject({
      selected_count: output.discovered,
      dropped_count: 0
    });
    expect(process.exitCode).toBe(EXIT_CODES.accept);
  });

  it('requires --carry-rulepack-image when carrying a frozen semantic rulepack', async () => {
    const repo = await seedRepoWithFailingTest();
    await expect(
      createProgram().parseAsync([
        'node',
        'vibeloop',
        'orchestrate',
        '--repo',
        repo.repoPath,
        '--eval',
        repo.evalFile,
        '--agent',
        'mock:scenario.json',
        '--carry-rulepack',
        'policy/rulepack.lock.json'
      ])
    ).rejects.toThrow(/--carry-rulepack requires --carry-rulepack-image/);
  });

  it('surfaces issue execution errors as failed when no PR candidate exists', async () => {
    const repo = await seedRepoWithFailingTest();
    await repo.write('UNCOMMITTED.md', 'dirty source\n');
    const fixtureDir = await tempDir('vibeloop-orch-failed-fixture-');
    const fix = await writeScenario(fixtureDir, 'orch-failed-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
    ]);
    const dataDir = await tempDir('vibeloop-orch-failed-data-');
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
      status: string;
      pr_candidates: number;
      error_count: number;
      issues: Array<{ pr_candidate: boolean; error?: string }>;
    };
    expect(output.status).toBe('failed');
    expect(output.pr_candidates).toBe(0);
    expect(output.error_count).toBe(1);
    expect(output.issues[0]).toMatchObject({ pr_candidate: false });
    expect(output.issues[0]?.error).toContain('uncommitted change');
    expect(process.exitCode).toBe(EXIT_CODES.failed);
    process.exitCode = 0;
  });

  it('carries a frozen semantic rulepack into an existing eval and fails closed on an invalid lock', async () => {
    const repo = await seedRepoWithFailingTest();
    const tampered = frozenRulepackFixture();
    (tampered.replay as { replaySafe: boolean }).replaySafe = false;
    await repo.write(
      'policy/rulepack.lock.json',
      `${JSON.stringify(tampered, null, 2)}\n`
    );
    await repo.git(['add', 'policy/rulepack.lock.json']);
    await repo.git(['commit', '-m', 'add tampered carried rulepack']);

    const fixtureDir = await tempDir('vibeloop-orch-carry-fixture-');
    const fix = await writeScenario(fixtureDir, 'orch-carry-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
    ]);
    const dataDir = await tempDir('vibeloop-orch-carry-data-');
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
        '--loop-id',
        'carry-loop-n1',
        '--carry-rulepack',
        'policy/rulepack.lock.json',
        '--carry-rulepack-image',
        'node:22-alpine',
        '--agent',
        `mock:${fix}`,
        '--skip-dependency-install'
      ]);
    } finally {
      spy.mockRestore();
    }

    const output = JSON.parse(logs[logs.length - 1]!) as {
      eval_file: string;
      generated_eval: boolean;
      carried_rulepack: {
        file: string;
        image: string;
        current_loop_id: string;
      } | null;
      pr_candidates: number;
      issues: Array<{
        pr_candidate: boolean;
        selected_candidate_id: string | null;
        selection_report: string;
      }>;
    };
    expect(output.generated_eval).toBe(false);
    expect(output.eval_file).toContain('eval.carry-rulepack.json');
    expect(output.carried_rulepack).toMatchObject({
      file: 'policy/rulepack.lock.json',
      image: 'node:22-alpine',
      current_loop_id: 'carry-loop-n1'
    });

    const carriedEval = JSON.parse(
      await readFile(output.eval_file, 'utf8')
    ) as {
      protected_paths: string[];
      gates: Array<{ name: string; command: string; required: boolean }>;
      rulepack_semantic?: {
        file: string;
        image: string;
        current_loop_id: string;
      };
    };
    expect(carriedEval.protected_paths).toContain('policy/rulepack.lock.json');
    expect(carriedEval.gates).toContainEqual(
      expect.objectContaining({
        name: 'rulepack_semantic',
        command: 'builtin:rulepack-semantic',
        required: true
      })
    );
    expect(carriedEval.rulepack_semantic).toMatchObject({
      file: 'policy/rulepack.lock.json',
      image: 'node:22-alpine',
      current_loop_id: 'carry-loop-n1'
    });

    expect(output.pr_candidates).toBe(0);
    expect(output.issues[0]).toMatchObject({
      pr_candidate: false,
      selected_candidate_id: null
    });
    const selection = JSON.parse(
      await readFile(output.issues[0]!.selection_report, 'utf8')
    ) as {
      accepted_count: number;
      candidates: Array<{ report_path?: string }>;
    };
    expect(selection.accepted_count).toBe(0);
    const report = JSON.parse(
      await readFile(selection.candidates[0]!.report_path!, 'utf8')
    ) as {
      decision: string;
      gate_runs: Array<{ name: string; status: string }>;
      rulepack_semantic?: Array<{
        file: string;
        image: string;
        current_loop_id: string;
        status: string;
      }>;
    };
    expect(report.decision).toBe('reject');
    expect(
      report.gate_runs.find((entry) => entry.name === 'rulepack_semantic')
        ?.status
    ).toBe('fail');
    expect(report.rulepack_semantic?.[0]).toMatchObject({
      file: 'policy/rulepack.lock.json',
      image: 'node:22-alpine',
      current_loop_id: 'carry-loop-n1',
      status: 'fail'
    });
    expect(process.exitCode).toBe(EXIT_CODES.reject);
  });

  it('can cumulatively promote selected patches, rediscover the next issue, and publish stacked draft PRs (RU-3 substrate)', async () => {
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
        'execution:',
        '  isolation: none',
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
    const bareRemote = await tempDir('vibeloop-orch-ru3-remote-');
    await repo.git(['init', '--bare', bareRemote]);
    await repo.git(['remote', 'add', 'origin', bareRemote]);
    await repo.git(['push', 'origin', 'main']);

    const fixtureDir = await tempDir('vibeloop-orch-ru3-fixture-');
    const agent = path.join(fixtureDir, 'ru3-agent.cjs');
    await writeFile(
      agent,
      [
        "const fs = require('node:fs');",
        "const task = fs.readFileSync(process.env.VIBELOOP_TASK_FILE, 'utf8');",
        "if (task.includes('src/a.cjs')) {",
        "  fs.writeFileSync('src/a.cjs', 'module.exports = 2;\\n');",
        '  process.exit(0);',
        '}',
        "if (task.includes('src/b.cjs')) {",
        "  fs.writeFileSync('src/b.cjs', 'module.exports = 2;\\n');",
        '  process.exit(0);',
        '}',
        "throw new Error('unknown generated task: ' + task);",
        ''
      ].join('\n')
    );
    const dataDir = await tempDir('vibeloop-orch-ru3-data-');
    const apiRequests: Array<{ method: string; path: string; body: string }> =
      [];
    let prNumber = 20;
    const server = createServer(async (req, res) => {
      const requestBody = await readRequestBody(req);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      apiRequests.push({
        method: req.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        body: requestBody
      });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && url.pathname.endsWith('/pulls')) {
        res.end('[]');
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/pulls')) {
        prNumber += 1;
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            html_url: `https://github.com/coreline-ai/improvement_loop_harness/pull/${prNumber}`,
            number: prNumber,
            draft: true,
            auto_merge: null
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'not found' }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('server failed');

    const logs: string[] = [];
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((value: string) => logs.push(value));
    process.env.VIBELOOP_TEST_GITHUB_TOKEN = 'fixture-token';
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
        '--github-draft-pr',
        '--github-repo',
        'coreline-ai/improvement_loop_harness',
        '--github-token-env',
        'VIBELOOP_TEST_GITHUB_TOKEN',
        '--github-base',
        'main',
        '--github-branch-prefix',
        'pr-candidate',
        '--github-push-url',
        bareRemote,
        '--github-api-base-url',
        `http://127.0.0.1:${address.port}`,
        '--skip-dependency-install'
      ]);
    } finally {
      spy.mockRestore();
      delete process.env.VIBELOOP_TEST_GITHUB_TOKEN;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
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
        task_id: string;
        pr_candidate: boolean;
        promotion: { head_sha: string } | null;
        draft_pr: {
          branch_name: string;
          base_ref: string;
          pr_url: string;
        } | null;
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
    expect(output.issues.map((issue) => issue.draft_pr?.base_ref)).toEqual([
      'main',
      output.issues[0]!.draft_pr!.branch_name
    ]);
    expect(output.issues[0]!.draft_pr!.branch_name).toContain('-i0/');
    expect(output.issues[1]!.draft_pr!.branch_name).toContain('-i1/');
    expect(output.issues.map((issue) => issue.draft_pr?.pr_url)).toEqual([
      'https://github.com/coreline-ai/improvement_loop_harness/pull/21',
      'https://github.com/coreline-ai/improvement_loop_harness/pull/22'
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
    const remoteBranches = (
      await repo.git(['ls-remote', bareRemote, 'refs/heads/pr-candidate/*'])
    )
      .trim()
      .split(/\n/)
      .filter(Boolean);
    expect(remoteBranches).toHaveLength(2);
    const postPayloads = apiRequests
      .filter((request) => request.method === 'POST')
      .map(
        (request) =>
          JSON.parse(request.body) as {
            head: string;
            base: string;
            draft: boolean;
          }
      );
    expect(postPayloads).toHaveLength(2);
    expect(postPayloads[0]).toMatchObject({
      head: output.issues[0]!.draft_pr!.branch_name,
      base: 'main',
      draft: true
    });
    expect(postPayloads[1]).toMatchObject({
      head: output.issues[1]!.draft_pr!.branch_name,
      base: output.issues[0]!.draft_pr!.branch_name,
      draft: true
    });
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
    await repo.write(
      'policy/rulepack.lock.json',
      `${JSON.stringify(frozenRulepackFixture(), null, 2)}\n`
    );
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'seed package test bug']);

    const fixtureDir = await tempDir('vibeloop-orch-geneval-fixture-');
    const hiddenDir = await tempDir('vibeloop-orch-geneval-hidden-');
    const hiddenSource = path.join(hiddenDir, 'hidden-value.test.cjs');
    await writeFile(
      hiddenSource,
      "const v = require('../../src/value.cjs');\nif (v !== 2) process.exit(1);\n"
    );
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
        '--eval-artifact-leak',
        '--eval-forbidden-literal',
        'fixture_cart_id=cart-fixture-123',
        '--eval-scan-patch',
        '--eval-redact-gate-logs',
        '--eval-rulepack-lock',
        'policy/rulepack.lock.json',
        '--eval-hidden-test',
        `hidden_value=${hiddenSource}:tests/hidden/value-hidden.test.cjs:node tests/hidden/value-hidden.test.cjs`,
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
      protected_paths: string[];
      rulepack_lock?: {
        file: string;
        required_authority: string;
        required_decision_impact: string;
      };
      hidden_acceptance?: {
        tests: Array<{
          name: string;
          source_path: string;
          target_path: string;
        }>;
      };
      artifact_leak?: {
        scan_patch?: boolean;
        redact_gate_logs?: boolean;
        forbidden_literals?: Array<{ label: string; value: string }>;
      };
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
    expect(generatedEval.gates.map((gate) => gate.name)).toContain(
      'artifact_leak'
    );
    expect(generatedEval.gates.map((gate) => gate.name)).toContain(
      'rulepack_lock'
    );
    expect(
      generatedEval.gates.find((gate) => gate.name === 'rulepack_lock')?.command
    ).toBe('builtin:rulepack-lock');
    expect(generatedEval.protected_paths).toContain(
      'policy/rulepack.lock.json'
    );
    expect(generatedEval.protected_paths).toContain(
      'tests/hidden/value-hidden.test.cjs'
    );
    expect(generatedEval.rulepack_lock).toMatchObject({
      file: 'policy/rulepack.lock.json',
      required_authority: 'fixed_next_loop_gate',
      required_decision_impact: 'next_loop_only'
    });
    expect(generatedEval.hidden_acceptance?.tests).toEqual([
      {
        name: 'hidden_value',
        source_path: hiddenSource,
        target_path: 'tests/hidden/value-hidden.test.cjs'
      }
    ]);
    expect(generatedEval.gates).toContainEqual(
      expect.objectContaining({
        name: 'hidden_value',
        type: 'hidden_acceptance',
        group: 'hidden_acceptance',
        command: 'node tests/hidden/value-hidden.test.cjs',
        required: true
      })
    );
    expect(generatedEval.artifact_leak).toMatchObject({
      scan_patch: true,
      redact_gate_logs: true,
      forbidden_literals: [
        { label: 'fixture_cart_id', value: 'cart-fixture-123' }
      ]
    });
    expect(generatedEval.evaluator.require_test_on_base_pass).toBe(true);
    expect(process.exitCode).toBe(EXIT_CODES.accept);
  });

  it('fails closed when generated eval references a tampered frozen rulepack lock', async () => {
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
    const tampered = frozenRulepackFixture();
    (tampered.replay as { replaySafe: boolean }).replaySafe = false;
    await repo.write(
      'policy/rulepack.lock.json',
      `${JSON.stringify(tampered, null, 2)}\n`
    );
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'seed tampered rulepack lock']);

    const fixtureDir = await tempDir('vibeloop-orch-lockfail-fixture-');
    const fix = await writeScenario(fixtureDir, 'orch-lockfail-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
    ]);
    const dataDir = await tempDir('vibeloop-orch-lockfail-data-');
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
        '--eval-rulepack-lock',
        'policy/rulepack.lock.json',
        '--agent',
        `mock:${fix}`,
        '--skip-dependency-install'
      ]);
    } finally {
      spy.mockRestore();
    }

    const output = JSON.parse(logs[logs.length - 1]!) as {
      pr_candidates: number;
      false_pass: number;
      issues: Array<{
        pr_candidate: boolean;
        selected_candidate_id: string | null;
        selection_report: string;
      }>;
    };
    expect(output.pr_candidates).toBe(0);
    expect(output.false_pass).toBe(0);
    expect(output.issues[0]).toMatchObject({
      pr_candidate: false,
      selected_candidate_id: null
    });
    const selection = JSON.parse(
      await readFile(output.issues[0]!.selection_report, 'utf8')
    ) as {
      accepted_count: number;
      candidates: Array<{ report_path?: string }>;
    };
    expect(selection.accepted_count).toBe(0);
    const report = JSON.parse(
      await readFile(selection.candidates[0]!.report_path!, 'utf8')
    ) as {
      decision: string;
      gate_runs: Array<{ name: string; status: string; stdout_ref: string }>;
    };
    expect(report.decision).toBe('reject');
    const gate = report.gate_runs.find(
      (entry) => entry.name === 'rulepack_lock'
    );
    expect(gate?.status).toBe('fail');
    const stdout = await readFile(
      path.join(
        path.dirname(selection.candidates[0]!.report_path!),
        '..',
        gate!.stdout_ref
      ),
      'utf8'
    );
    expect(stdout).toContain('RULEPACK_LOCK_REPLAY_UNSAFE');
    expect(stdout).toContain('RULEPACK_LOCK_HASH_MISMATCH');
    expect(process.exitCode).toBe(EXIT_CODES.reject);
  });

  it('generates a semantic rulepack gate and fails closed before execution on an invalid lock', async () => {
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
    const tampered = frozenRulepackFixture();
    (tampered.replay as { replaySafe: boolean }).replaySafe = false;
    await repo.write(
      'policy/rulepack.lock.json',
      `${JSON.stringify(tampered, null, 2)}\n`
    );
    await repo.git(['add', '-A']);
    await repo.git(['commit', '-m', 'seed tampered semantic rulepack lock']);

    const fixtureDir = await tempDir('vibeloop-orch-semantic-fixture-');
    const fix = await writeScenario(fixtureDir, 'orch-semantic-fix', [
      {
        type: 'modify',
        path: 'src/value.cjs',
        content: 'module.exports = 2;\n'
      }
    ]);
    const dataDir = await tempDir('vibeloop-orch-semantic-data-');
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
        '--loop-id',
        'semantic-loop-n1',
        '--generate-eval',
        '--eval-rulepack-semantic',
        'policy/rulepack.lock.json',
        '--eval-rulepack-semantic-image',
        'node:22-alpine',
        '--agent',
        `mock:${fix}`,
        '--skip-dependency-install'
      ]);
    } finally {
      spy.mockRestore();
    }

    const output = JSON.parse(logs[logs.length - 1]!) as {
      eval_file: string;
      pr_candidates: number;
      issues: Array<{
        pr_candidate: boolean;
        selected_candidate_id: string | null;
        selection_report: string;
      }>;
    };
    const generatedEval = JSON.parse(
      await readFile(output.eval_file, 'utf8')
    ) as {
      gates: Array<{ name: string; command: string }>;
      protected_paths: string[];
      rulepack_semantic?: {
        file: string;
        image: string;
        network: string;
        current_loop_id: string;
        required_authority: string;
        required_decision_impact: string;
      };
    };
    expect(generatedEval.gates).toContainEqual(
      expect.objectContaining({
        name: 'rulepack_semantic',
        command: 'builtin:rulepack-semantic',
        required: true
      })
    );
    expect(generatedEval.rulepack_semantic).toMatchObject({
      file: 'policy/rulepack.lock.json',
      image: 'node:22-alpine',
      network: 'none',
      current_loop_id: 'semantic-loop-n1',
      required_authority: 'fixed_next_loop_gate',
      required_decision_impact: 'next_loop_only'
    });
    expect(generatedEval.protected_paths).toContain(
      'policy/rulepack.lock.json'
    );
    expect(output.pr_candidates).toBe(0);
    expect(output.issues[0]).toMatchObject({
      pr_candidate: false
    });
    const selection = JSON.parse(
      await readFile(output.issues[0]!.selection_report, 'utf8')
    ) as {
      accepted_count: number;
      candidates: Array<{ report_path?: string }>;
    };
    expect(selection.accepted_count).toBe(0);
    const report = JSON.parse(
      await readFile(selection.candidates[0]!.report_path!, 'utf8')
    ) as {
      decision: string;
      gate_runs: Array<{ name: string; status: string; stdout_ref: string }>;
      rulepack_semantic?: Array<{
        file: string;
        image: string;
        current_loop_id: string;
        status: string;
      }>;
    };
    expect(report.decision).toBe('reject');
    const semanticGate = report.gate_runs.find(
      (entry) => entry.name === 'rulepack_semantic'
    );
    expect(semanticGate?.status).toBe('fail');
    expect(report.rulepack_semantic?.[0]).toMatchObject({
      file: 'policy/rulepack.lock.json',
      image: 'node:22-alpine',
      current_loop_id: 'semantic-loop-n1',
      status: 'fail'
    });
    expect(process.exitCode).toBe(EXIT_CODES.reject);
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
