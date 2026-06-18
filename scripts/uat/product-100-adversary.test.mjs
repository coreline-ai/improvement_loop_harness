import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {
  assertProduct100ReviewerInputSafe,
  buildProduct100AdversaryReviewReport,
  buildProduct100FrozenRulepack,
  buildProduct100M2Handoff,
  buildProduct100ReviewerInput,
  defaultProduct100ReviewerCommand,
  evaluateProduct100Phase5,
  filterProduct100ReviewerProposal,
  materializeProduct100CounterexampleTests,
  product100RepairableCounterexamples,
  runProduct100CounterexampleRepairLoop,
  runProduct100Phase5LiveForIssues,
  writeProduct100CounterexampleRepairArtifacts,
  runProduct100Phase5Live
} from './product-100-adversary.mjs';

const execFile = promisify(execFileCallback);

const goodProposal = {
  id: 'edge-case',
  targetPath: 'tests/adversary/edge-case.test.cjs',
  body: "const assert = require('node:assert/strict');\nassert.equal(2 + 2, 4);\n",
  expectation: 'fail_to_pass'
};

async function git(cwd, args) {
  return execFile('git', args, { cwd });
}

async function createRepairRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'p100-repair-repo-'));
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'value.cjs'), 'module.exports = 1;\n');
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'product-100@example.test']);
  await git(repo, ['config', 'user.name', 'Product 100 Test']);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'seed repair repo']);
  return repo;
}

async function writeMockScenario(dir, name, actions) {
  const scenario = path.join(dir, `${name}.json`);
  await writeFile(scenario, `${JSON.stringify({ actions }, null, 2)}\n`);
  return scenario;
}

function validReports() {
  const reviewReport = buildProduct100AdversaryReviewReport({
    reviewerOutput: { findings: [], proposals: [goodProposal] },
    provider: 'codex',
    realLlm: true,
    reviewerCommand: 'codex-reviewer',
    builderCommand: 'codex-builder',
    separateContext: true
  });
  const handoff = buildProduct100M2Handoff({
    reviewReport,
    loopId: 'loop-n',
    baseCommit: 'base',
    selectedCandidateId: 'candidate-1',
    selectedPatch: 'diff --git sample'
  });
  const m2Report = {
    authority: 'deterministic_isolated_execution',
    executed: true,
    all_confirmed: true,
    execution: { network: 'none' }
  };
  const m4Report = {
    authority: 'deterministic_m4_replay',
    executed: true,
    replaySafe: true,
    network: 'none',
    total: 1,
    matched: 1,
    mismatches: []
  };
  const frozenRulepack = buildProduct100FrozenRulepack({ handoff, m2Report, m4Report });
  return { reviewReport, handoff, m2Report, m4Report, frozenRulepack, semanticGateReport: { status: 'pass', allPass: true } };
}

describe('Product-100 adversary reviewer Phase5 contract', () => {
  it('ships a built-in live Codex reviewer command for Product-100 Phase5', () => {
    expect(defaultProduct100ReviewerCommand()).toContain(
      'scripts/uat/product-100-codex-reviewer.mjs --live'
    );
  });

  it('builds reviewer input without hidden source, hidden sentinel, or builder transcript', () => {
    const { input, safety } = buildProduct100ReviewerInput({
      publicTask: { id: 'ISSUE-1', objective: 'public only' },
      selectedPatch: 'diff --git public',
      selectedCandidateId: 'candidate-1'
    });
    expect(safety.ok).toBe(true);
    expect(assertProduct100ReviewerInputSafe(input).ok).toBe(true);
    expect(JSON.stringify(input)).not.toContain('HIDDEN_PRODUCT_100');
  });

  it('rejects hidden leaks and test weakening in reviewer proposals', () => {
    const hidden = filterProduct100ReviewerProposal({
      ...goodProposal,
      body: 'console.log("HIDDEN_PRODUCT_100_SECRET")'
    });
    expect(hidden.accepted).toBe(false);
    expect(hidden.failed_filters).toContain('no_hidden_leak');

    const weak = filterProduct100ReviewerProposal({
      ...goodProposal,
      body: 'test.skip("skip", () => {}); expect(true).toBe(true);'
    });
    expect(weak.accepted).toBe(false);
    expect(weak.failed_filters).toContain('no_test_weakening');
  });

  it('accepts a safe proposal into advisory-only M2 handoff without current-loop authority', () => {
    const reviewReport = buildProduct100AdversaryReviewReport({
      reviewerOutput: { findings: [], proposals: [goodProposal] },
      provider: 'codex',
      realLlm: true,
      reviewerCommand: 'codex-reviewer',
      builderCommand: 'codex-builder',
      separateContext: true
    });
    expect(reviewReport.accepted_proposal_count).toBe(1);
    expect(reviewReport.current_loop_decision_impact).toBe('none');
    expect(reviewReport.reviewer_provenance.same_model_review).toBe(false);
    const handoff = buildProduct100M2Handoff({ reviewReport, loopId: 'loop-n' });
    expect(handoff.authority).toBe('advisory_only');
    expect(handoff.decision_impact).toBe('none');
    expect(handoff.proposal_count).toBe(1);
  });

  it('freezes only after M2 and M4 R1-safe reports and rejects same-loop application', () => {
    const { handoff, m2Report, m4Report } = validReports();
    const frozen = buildProduct100FrozenRulepack({ handoff, m2Report, m4Report });
    expect(frozen.frozen).toBe(true);
    expect(frozen.authority).toBe('fixed_next_loop_gate');
    expect(frozen.decision_impact).toBe('next_loop_only');

    const sameLoop = buildProduct100FrozenRulepack({
      handoff,
      m2Report,
      m4Report,
      appliedToCurrentLoop: true
    });
    expect(sameLoop.frozen).toBe(false);
    expect(sameLoop.reasons).toContain('same_loop_application');
  });

  it('maps Phase5 evidence into Product-100 fixed requirements', () => {
    const reports = validReports();
    const evaluation = evaluateProduct100Phase5(reports);
    expect(evaluation.phase5_pass).toBe(true);
    expect(evaluation.real_codex_adversary_reviewer_used).toBe(true);
    expect(evaluation.accepted_review_proposal_count_at_least_one).toBe(true);
    expect(evaluation.same_model_review_false).toBe(true);
    expect(evaluation.m2_confirmed_under_r1).toBe(true);
    expect(evaluation.m4_replay_safe_under_r1).toBe(true);
    expect(evaluation.frozen_rulepack_semantic_gate_passed_next_loop).toBe(true);
  });

  it('does not pass Phase5 for controlled or same-context reviewer provenance', () => {
    const reports = validReports();
    reports.reviewReport.reviewer_provenance.real_llm = false;
    reports.reviewReport.reviewer_provenance.same_model_review = true;
    const evaluation = evaluateProduct100Phase5(reports);
    expect(evaluation.phase5_pass).toBe(false);
    expect(evaluation.real_codex_adversary_reviewer_used).toBe(false);
    expect(evaluation.same_model_review_false).toBe(false);
  });

  it('converts M2 base=fail/candidate=fail counterexamples into repair task/eval artifacts', async () => {
    const reviewReport = buildProduct100AdversaryReviewReport({
      reviewerOutput: { findings: [], proposals: [goodProposal] },
      provider: 'openai',
      realLlm: true,
      reviewerCommand: 'reviewer',
      builderCommand: 'builder',
      separateContext: true
    });
    const m2Report = {
      confirmations: [
        {
          proposalId: 'edge-case',
          confirmed: false,
          reason:
            'expected fail-on-base/pass-on-candidate, got base=fail candidate=fail',
          base: 'fail',
          candidate: 'fail'
        }
      ]
    };
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), 'p100-repair-artifacts-')
    );
    const artifacts = await writeProduct100CounterexampleRepairArtifacts({
      publicTask: {
        id: 'nm-001',
        title: 'quantity bug',
        objective: 'Fix quantity',
        acceptance: {
          required_tests: ['node packages/cart/tests/quantity.test.cjs'],
          required_behaviors: [],
          must_not: []
        },
        metadata: { product_100: { source_issue_id: 'NM-001' } },
        limits: { agent_timeout_seconds: 900 }
      },
      evalConfig: {
        protected_paths: ['hidden/**'],
        risk_classification: { eval_system: ['hidden/'] },
        limits: { agent_timeout_seconds: 900 },
        gates: []
      },
      reviewReport,
      m2Report,
      outputDir
    });

    expect(product100RepairableCounterexamples(reviewReport, m2Report)).toHaveLength(1);
    expect(artifacts.task.acceptance.required_tests).toContain(
      'node tests/adversary/edge-case.test.cjs'
    );
    expect(artifacts.eval.protected_paths).toContain(
      'tests/adversary/edge-case.test.cjs'
    );
    expect(artifacts.eval.gates).toContainEqual(
      expect.objectContaining({
        name: 'adversary_counterexample_1',
        command: 'node tests/adversary/edge-case.test.cjs',
        required: true
      })
    );
    expect(artifacts.task.limits.agent_timeout_seconds).toBe(360);
    expect(artifacts.eval.limits.agent_timeout_seconds).toBe(360);
  });

  it('rebases hidden acceptance source paths when writing repair eval beside Phase5 artifacts', async () => {
    const reviewReport = buildProduct100AdversaryReviewReport({
      reviewerOutput: { findings: [], proposals: [goodProposal] },
      provider: 'openai',
      realLlm: true,
      reviewerCommand: 'reviewer',
      builderCommand: 'builder',
      separateContext: true
    });
    const m2Report = {
      confirmations: [
        {
          proposalId: 'edge-case',
          confirmed: false,
          base: 'fail',
          candidate: 'fail'
        }
      ]
    };
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p100-repair-rebase-'));
    const originalEvalFile = path.join(tmp, 'runs', 'c1', 'input', 'eval.yaml');
    const hiddenFile = path.join(tmp, 'runs', 'hidden', 'nm-001.hidden.cjs');
    const outputDir = path.join(tmp, 'phase5');
    await mkdir(path.dirname(originalEvalFile), { recursive: true });
    await mkdir(path.dirname(hiddenFile), { recursive: true });
    await writeFile(hiddenFile, 'module.exports = true;\n');
    await writeProduct100CounterexampleRepairArtifacts({
      publicTask: { id: 'nm-001', objective: 'Fix' },
      evalConfig: {
        hidden_acceptance: {
          tests: [
            {
              name: 'hidden',
              source_path: '../../hidden/nm-001.hidden.cjs',
              target_path: 'hidden/test.cjs'
            }
          ]
        },
        gates: []
      },
      reviewReport,
      m2Report,
      outputDir,
      evalFile: originalEvalFile
    });
    const repairEval = JSON.parse(
      await readFile(path.join(outputDir, 'counterexample-repair.eval.json'), 'utf8')
    );
    const rebased = repairEval.hidden_acceptance.tests[0].source_path;
    expect(path.resolve(outputDir, rebased)).toBe(hiddenFile);
  });

  it('materializes adversary counterexample tests as a committed next-loop base', async () => {
    const repo = await createRepairRepo();
    const result = await materializeProduct100CounterexampleTests({
      repoPath: repo,
      counterexamples: [
        {
          id: 'value-edge',
          targetPath: 'tests/adversary/value-edge.test.cjs',
          body:
            "const assert = require('node:assert/strict');\nconst value = require('../../src/value.cjs');\nassert.equal(value, 2);\n"
        }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.written_paths).toEqual(['tests/adversary/value-edge.test.cjs']);
    const { stdout } = await git(repo, ['show', 'HEAD:tests/adversary/value-edge.test.cjs']);
    expect(stdout).toContain('assert.equal(value, 2)');
  });

  it('allows M2-staged untracked adversary test dirs during materialization', async () => {
    const repo = await createRepairRepo();
    await mkdir(path.join(repo, 'tests/adversary'), { recursive: true });
    await writeFile(
      path.join(repo, 'tests/adversary/value-edge.test.cjs'),
      "const assert = require('node:assert/strict');\nassert.equal(1, 1);\n"
    );

    const result = await materializeProduct100CounterexampleTests({
      repoPath: repo,
      counterexamples: [
        {
          id: 'value-edge',
          targetPath: 'tests/adversary/value-edge.test.cjs',
          body:
            "const assert = require('node:assert/strict');\nconst value = require('../../src/value.cjs');\nassert.equal(value, 2);\n"
        }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    const { stdout } = await git(repo, [
      'show',
      'HEAD:tests/adversary/value-edge.test.cjs'
    ]);
    expect(stdout).toContain('assert.equal(value, 2)');
  });

  it('cleans stale generated adversary tests from prior Phase5 attempts', async () => {
    const repo = await createRepairRepo();
    await mkdir(path.join(repo, 'tests/adversary'), { recursive: true });
    await writeFile(
      path.join(repo, 'tests/adversary/stale.test.cjs'),
      'throw new Error("old committed generated proposal");\n'
    );
    await git(repo, ['add', 'tests/adversary/stale.test.cjs']);
    await git(repo, ['commit', '-m', 'seed adversary test dir']);
    await writeFile(
      path.join(repo, 'tests/adversary/stale.test.cjs'),
      'throw new Error("stale generated proposal");\n'
    );

    const result = await materializeProduct100CounterexampleTests({
      repoPath: repo,
      counterexamples: [
        {
          id: 'value-edge',
          targetPath: 'tests/adversary/value-edge.test.cjs',
          body:
            "const assert = require('node:assert/strict');\nconst value = require('../../src/value.cjs');\nassert.equal(value, 2);\n"
        }
      ]
    });

    expect(result.ok).toBe(true);
    await expect(
      readFile(path.join(repo, 'tests/adversary/stale.test.cjs'), 'utf8')
    ).rejects.toThrow();
  });

  it('runs a counterexample repair loop and commits the selected repair patch', async () => {
    const repo = await createRepairRepo();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p100-repair-loop-'));
    const taskFile = path.join(tmp, 'repair.task.json');
    const evalFile = path.join(tmp, 'repair.eval.json');
    const testsFile = path.join(tmp, 'repair.tests.json');
    const scenario = await writeMockScenario(tmp, 'repair-agent', [
      { type: 'modify', path: 'src/value.cjs', content: 'module.exports = 2;\n' }
    ]);
    await writeFile(
      taskFile,
      `${JSON.stringify({
        id: 'repair',
        title: 'Repair adversary counterexample',
        objective: 'Repair adversary counterexample',
        write_scope: { allowed: ['src/'], forbidden: ['tests/adversary/'] },
        required_evidence: ['fixes_reproduced_failure'],
        acceptance: {
          required_tests: ['node tests/adversary/value-edge.test.cjs']
        },
        limits: {
          max_changed_files: 5,
          max_changed_lines: 100,
          agent_timeout_seconds: 60
        }
      }, null, 2)}\n`
    );
    await writeFile(
      evalFile,
      `${JSON.stringify({
        schema_version: '1.0',
        project: 'repair',
        protected_paths: ['tests/adversary/value-edge.test.cjs'],
        risk_classification: { none: ['src/'], eval_system: ['tests/adversary/'] },
        limits: { max_changed_files: 5, max_changed_lines: 100 },
        execution: { isolation: 'none', network: 'none' },
        gates: [
          { name: 'protected_files', type: 'scope', command: 'builtin:protected-files', required: true },
          { name: 'diff_scope', type: 'scope', command: 'builtin:diff-scope', required: true },
          { name: 'limits', type: 'integrity', command: 'builtin:limits', required: true },
          {
            name: 'adversary_counterexample_1',
            type: 'task_acceptance',
            group: 'fail_to_pass',
            command: 'node tests/adversary/value-edge.test.cjs',
            required: true
          }
        ]
      }, null, 2)}\n`
    );
    await writeFile(
      testsFile,
      `${JSON.stringify([
        {
          id: 'value-edge',
          targetPath: 'tests/adversary/value-edge.test.cjs',
          body:
            "const assert = require('node:assert/strict');\nconst value = require('../../src/value.cjs');\nassert.equal(value, 2);\n"
        }
      ], null, 2)}\n`
    );

    const report = await runProduct100CounterexampleRepairLoop({
      repoPath: repo,
      dataDir: path.join(tmp, 'data'),
      repairTaskFile: taskFile,
      repairEvalFile: evalFile,
      repairTestsFile: testsFile,
      agents: [`mock:${scenario}`],
      challengers: [`mock:${scenario}`],
      outputDir: tmp,
      loopId: 'repair-loop-1'
    });

    expect(report.executed).toBe(true);
    expect(report.repair_pass).toBe(true);
    expect(report.committed_to_integration_branch).toBe(true);
    const { stdout } = await execFile(process.execPath, [
      'tests/adversary/value-edge.test.cjs'
    ], { cwd: repo });
    expect(stdout).toBe('');
    await expect(git(repo, ['show', 'HEAD:src/value.cjs'])).resolves.toMatchObject({
      stdout: 'module.exports = 2;\n'
    });
  });

  it('uses a default real-Codex repair agent set when no repair agent env is configured', async () => {
    const repo = await createRepairRepo();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p100-default-repair-agent-'));
    const taskFile = path.join(tmp, 'repair.task.json');
    const evalFile = path.join(tmp, 'repair.eval.json');
    await writeFile(taskFile, '{"id":"repair","acceptance":{"required_tests":[]}}\n');
    await writeFile(evalFile, '{"schema_version":"1.0","gates":[]}\n');
    let closed = false;
    let args = [];

    const report = await runProduct100CounterexampleRepairLoop({
      repoPath: repo,
      dataDir: path.join(tmp, 'data'),
      repairTaskFile: taskFile,
      repairEvalFile: evalFile,
      materializeTests: false,
      outputDir: tmp,
      loopId: 'default-repair-agent-loop',
      defaultRepairAgentFactory: async () => ({
        agents: ['agent-default'],
        challengers: ['challenger-default'],
        proxy: {
          stats: { response_requests: 3 },
          close: async () => {
            closed = true;
          }
        }
      }),
      runImprove: async (invocation) => {
        args = invocation.args;
        return {
          ok: true,
          code: 0,
          stdout: JSON.stringify({
            pr_candidate: true,
            final_verification: { passed: true },
            selection_quality: { strict_score_improvement: true },
            selected_candidate_id: 'repair-candidate'
          }),
          stderr: ''
        };
      }
    });

    expect(args).toEqual(
      expect.arrayContaining([
        '--agent',
        'agent-default',
        '--challenger',
        'challenger-default',
        '--max-candidates',
        '4'
      ])
    );
    expect(args.filter((arg) => arg === '--agent')).toHaveLength(2);
    expect(args.filter((arg) => arg === '--challenger')).toHaveLength(2);
    expect(closed).toBe(true);
    expect(report.default_repair_agent_used).toBe(true);
    expect(report.proxy_stats).toEqual({ response_requests: 3 });
    expect(report.repair_pass).toBe(true);
  });

  it('automatically reruns M2/M4/freeze/N+1 after a successful counterexample repair', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p100-phase5-auto-repair-'));
    const repo = await createRepairRepo();
    const runRoot = path.join(tmp, 'runs', 'candidate');
    await mkdir(path.join(runRoot, 'input'), { recursive: true });
    await mkdir(path.join(runRoot, 'workspace'), { recursive: true });
    await mkdir(path.join(runRoot, 'patches'), { recursive: true });
    await writeFile(
      path.join(runRoot, 'input', 'task.yaml'),
      JSON.stringify({
        id: 'nm-001',
        title: 'quantity bug',
        objective: 'Fix quantity',
        acceptance: { required_tests: [] },
        required_evidence: ['fixes_reproduced_failure']
      })
    );
    await writeFile(
      path.join(runRoot, 'workspace', 'workspace-ref.json'),
      JSON.stringify({
        repo_path: repo,
        worktree_path: repo,
        base_commit: 'base-sha'
      })
    );
    await writeFile(path.join(runRoot, 'patches', 'candidate.patch'), 'diff');
    await writeFile(path.join(runRoot, 'patches', 'changed-files.json'), '[]');

    let confirmCalls = 0;
    let candidateCalls = 0;
    const evaluation = await runProduct100Phase5Live({
      phase4: {
        tmp_root: tmp,
        issues: [
          {
            repo_id: 'node-monorepo-scope',
            issue_id: 'NM-001',
            loop_id: 'loop-n',
            pr_candidate: true,
            selected_candidate_id: 'candidate-1',
            selected_patch: path.join(runRoot, 'patches', 'candidate.patch')
          }
        ]
      },
      reviewerOutput: { findings: [], proposals: [goodProposal] },
      provider: 'openai',
      realLlm: true,
      reviewerCommand: 'separate-reviewer',
      builderCommand: 'builder',
      separateContext: true,
      candidateWorktree: repo,
      baseWorktree: path.join(tmp, 'base'),
      repairRepoPath: repo,
      enableCounterexampleRepair: true,
      repairAgents: ['mock:repair-agent'],
      repairChallengers: ['mock:repair-challenger'],
      confirmHandoff: async () => {
        confirmCalls += 1;
        return confirmCalls === 1
          ? {
              authority: 'deterministic_isolated_execution',
              executed: true,
              all_confirmed: false,
              execution: { network: 'none' },
              confirmations: [
                {
                  proposalId: 'edge-case',
                  executed: true,
                  confirmed: false,
                  reason: 'expected fail-on-base/pass-on-candidate, got base=fail candidate=fail',
                  base: 'fail',
                  candidate: 'fail'
                }
              ]
            }
          : {
              authority: 'deterministic_isolated_execution',
              executed: true,
              all_confirmed: true,
              execution: { network: 'none' },
              confirmations: [
                {
                  proposalId: 'edge-case',
                  executed: true,
                  confirmed: true,
                  reason: 'fail-on-base, pass-on-candidate confirmed under isolation',
                  base: 'fail',
                  candidate: 'pass'
                }
              ]
            };
      },
      buildRulepackCandidate: async () => {
        candidateCalls += 1;
        return candidateCalls === 1
          ? { candidate_created: false }
          : { candidate_created: true, frozen_rulepack: null };
      },
      buildReplayCorpus: async () => ({ case_count: 1 }),
      replayRulepack: async (options) => ({
        authority: 'deterministic_m4_replay',
        executed: true,
        replaySafe: true,
        network: options.network,
        total: 1,
        matched: 1,
        mismatches: []
      }),
      freezeRulepack: async () => ({
        frozen: true,
        frozen_rulepack: {
          schema_version: '1.0',
          kind: 'frozen_rulepack',
          authority: 'fixed_next_loop_gate',
          decision_impact: 'next_loop_only',
          applied_to_current_loop: false,
          rules: [goodProposal],
          added_rules: [goodProposal],
          diff: { appendOnly: true, added: ['edge-case'], removed: [], changed: [] },
          replay: { replaySafe: true }
        }
      }),
      runSemanticRulepack: async () => ({ status: 'pass', allPass: true }),
      runCounterexampleRepairImprove: async () => {
        const patchFile = path.join(tmp, 'repair.patch');
        await writeFile(
          patchFile,
          [
            'diff --git a/src/value.cjs b/src/value.cjs',
            '--- a/src/value.cjs',
            '+++ b/src/value.cjs',
            '@@ -1 +1 @@',
            '-module.exports = 1;',
            '+module.exports = 2;',
            ''
          ].join('\n')
        );
        return {
          ok: true,
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            selected_candidate_id: 'repair-c1',
            selected_patch: patchFile,
            selected_report: path.join(tmp, 'repair-report.json'),
            pr_candidate: true,
            final_verification: { passed: true },
            selection_quality: {
              strict_score_improvement: true,
              status: 'strict_fixed_score_win'
            }
          })
        };
      }
    });

    expect(evaluation.phase5_pass).toBe(true);
    expect(evaluation.initial_m2_report.all_confirmed).toBe(false);
    expect(evaluation.m2_report.all_confirmed).toBe(true);
    expect(evaluation.counterexample_repair_loop_pass).toBe(true);
    expect(evaluation.counterexample_repair_resolved).toBe(true);
    expect(evaluation.improvement_required).toBe(false);
    expect(evaluation.handoff_file).toContain('post-repair-m2-handoff.json');
    expect(evaluation.semantic_gate_file).toContain(
      'post-repair-n-plus-one-semantic.json'
    );
  });

  it('aggregates Phase5 over every Product-100 Phase4 PR candidate issue', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p100-phase5-aggregate-'));
    const calls = [];
    const aggregate = await runProduct100Phase5LiveForIssues({
      phase4: {
        tmp_root: tmp,
        issue_count: 2,
        expected_issue_count: 2,
        issues: [
          {
            repo_id: 'repo-a',
            issue_id: 'A-1',
            loop_id: 'loop-a',
            pr_candidate: true,
            selected_candidate_id: 'candidate-a',
            selected_patch: '/tmp/a.patch'
          },
          {
            repo_id: 'repo-b',
            issue_id: 'B-1',
            loop_id: 'loop-b',
            pr_candidate: true,
            selected_candidate_id: 'candidate-b',
            selected_patch: '/tmp/b.patch'
          }
        ]
      },
      issueRunner: async ({ issue, outputDir }) => {
        calls.push({ issue, outputDir });
        return {
          phase5_pass: true,
          real_codex_adversary_reviewer_used: true,
          accepted_review_proposal_count_at_least_one: true,
          same_model_review_false: true,
          m2_confirmed_under_r1: true,
          m4_replay_safe_under_r1: true,
          frozen_rulepack_ready_next_loop: true,
          frozen_rulepack_semantic_gate_passed_next_loop: true,
          phase5_artifact_dir: outputDir
        };
      }
    });

    expect(calls).toHaveLength(2);
    expect(aggregate.phase5_pass).toBe(true);
    expect(aggregate.issue_count).toBe(2);
    expect(aggregate.all_issues_covered).toBe(true);
    expect(aggregate.real_codex_adversary_reviewer_used).toBe(true);
    expect(aggregate.m2_confirmed_under_r1).toBe(true);
    expect(aggregate.frozen_rulepack_semantic_gate_passed_next_loop).toBe(true);
    expect(aggregate.next_step).toBe(
      'continue_product_100_phase6_draft_pr_evidence_audit'
    );
  });

  it('keeps aggregate Phase5 failing when any Product-100 issue is missing Phase5 proof', async () => {
    const aggregate = await runProduct100Phase5LiveForIssues({
      phase4: {
        issue_count: 2,
        expected_issue_count: 2,
        issues: [
          {
            repo_id: 'repo-a',
            issue_id: 'A-1',
            loop_id: 'loop-a',
            pr_candidate: true,
            selected_candidate_id: 'candidate-a',
            selected_patch: '/tmp/a.patch'
          }
        ]
      },
      issueRunner: async () => ({
        phase5_pass: true,
        real_codex_adversary_reviewer_used: true,
        accepted_review_proposal_count_at_least_one: true,
        same_model_review_false: true,
        m2_confirmed_under_r1: true,
        m4_replay_safe_under_r1: true,
        frozen_rulepack_ready_next_loop: true,
        frozen_rulepack_semantic_gate_passed_next_loop: true
      })
    });

    expect(aggregate.phase5_pass).toBe(false);
    expect(aggregate.all_issues_covered).toBe(false);
    expect(aggregate.issue_count).toBe(1);
    expect(aggregate.expected_issue_count).toBe(2);
    expect(aggregate.m2_confirmed_under_r1).toBe(false);
    expect(aggregate.next_step).toBe(
      'complete_phase5_for_every_product_100_issue'
    );
  });

  it('runs the Phase5 pipeline from a selected Product-100 issue with injected deterministic hooks', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p100-phase5-'));
    const runRoot = path.join(tmp, 'runs', 'candidate');
    const candidateWorktree = path.join(tmp, 'candidate-worktree');
    await mkdir(path.join(runRoot, 'input'), { recursive: true });
    await mkdir(path.join(runRoot, 'workspace'), { recursive: true });
    await mkdir(path.join(runRoot, 'patches'), { recursive: true });
    await mkdir(path.join(runRoot, 'reports'), { recursive: true });
    await writeFile(
      path.join(runRoot, 'input', 'task.yaml'),
      JSON.stringify({ id: 'nm-001', objective: 'Fix quantity clamp' })
    );
    await writeFile(
      path.join(runRoot, 'workspace', 'workspace-ref.json'),
      JSON.stringify({
        worktree_path: candidateWorktree,
        base_commit: 'base-sha'
      })
    );
    await writeFile(
      path.join(runRoot, 'patches', 'candidate.patch'),
      'diff --git a/src/value.cjs b/src/value.cjs\n'
    );
    await writeFile(
      path.join(runRoot, 'patches', 'changed-files.json'),
      JSON.stringify(['src/value.cjs'])
    );
    await writeFile(
      path.join(runRoot, 'reports', 'eval-report.json'),
      JSON.stringify({
        decision: 'accept',
        gate_runs: [{ name: 'visible', status: 'pass' }]
      })
    );

    const evaluation = await runProduct100Phase5Live({
      phase4: {
        tmp_root: tmp,
        issues: [
          {
            repo_id: 'node-monorepo-scope',
            issue_id: 'NM-001',
            loop_id: 'loop-n',
            pr_candidate: true,
            selected_candidate_id: 'candidate-1',
            selected_patch: path.join(runRoot, 'patches', 'candidate.patch'),
            selected_report: path.join(runRoot, 'reports', 'eval-report.json')
          }
        ]
      },
      provider: 'openai',
      realLlm: true,
      reviewerCommand: 'separate-reviewer',
      builderCommand: 'builder',
      separateContext: true,
      reviewerOutput: { findings: [], proposals: [goodProposal] },
      candidateWorktree,
      baseWorktree: path.join(tmp, 'base-worktree'),
      confirmHandoff: async (options) => ({
        authority: 'deterministic_isolated_execution',
        executed: true,
        all_confirmed: true,
        execution: { network: options.execution.network },
        confirmations: [{ proposalId: 'edge-case', executed: true, confirmed: true }]
      }),
      buildRulepackCandidate: async () => ({
        candidate_created: true,
        frozen_rulepack: null
      }),
      buildReplayCorpus: async () => ({ case_count: 1 }),
      replayRulepack: async (options) => ({
        authority: 'deterministic_m4_replay',
        executed: true,
        replaySafe: true,
        network: options.network,
        total: 1,
        matched: 1,
        mismatches: []
      }),
      freezeRulepack: async () => ({
        frozen_rulepack: {
          schema_version: '1.0',
          kind: 'frozen_rulepack',
          authority: 'fixed_next_loop_gate',
          decision_impact: 'next_loop_only',
          source_loop_id: 'loop-n',
          rules: [goodProposal],
          added_rules: [goodProposal],
          diff: { appendOnly: true, added: ['edge-case'], removed: [], changed: [] },
          replay: { replaySafe: true }
        }
      }),
      runSemanticRulepack: async () => ({
        status: 'pass',
        allPass: true
      })
    });

    expect(evaluation.phase5_pass).toBe(true);
    expect(evaluation.real_codex_adversary_reviewer_used).toBe(true);
    expect(evaluation.phase5_artifact_dir).toContain('product-100-phase5');
    expect(evaluation.handoff_file).toContain('m2-handoff.json');
  });

  it('returns improvement_required instead of throwing when M2 finds a counterexample the candidate still fails', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p100-phase5-fail-'));
    const runRoot = path.join(tmp, 'runs', 'candidate');
    const evalRoot = path.join(tmp, 'product-100-artifacts');
    const originalEvalFile = path.join(
      evalRoot,
      'private/evals/node-monorepo-scope/nm-001.eval.json'
    );
    const originalHiddenFile = path.join(
      evalRoot,
      'private/hidden/node-monorepo-scope/nm-001/nm-001-h1.hidden.cjs'
    );
    await mkdir(path.join(runRoot, 'input'), { recursive: true });
    await mkdir(path.join(runRoot, 'workspace'), { recursive: true });
    await mkdir(path.join(runRoot, 'patches'), { recursive: true });
    await mkdir(path.dirname(originalEvalFile), { recursive: true });
    await mkdir(path.dirname(originalHiddenFile), { recursive: true });
    await writeFile(originalHiddenFile, 'module.exports = true;\n');
    await writeFile(
      originalEvalFile,
      JSON.stringify({
        hidden_acceptance: {
          tests: [
            {
              name: 'nm_001_h1',
              source_path: '../../hidden/node-monorepo-scope/nm-001/nm-001-h1.hidden.cjs',
              target_path: 'hidden/cart-boundary.test.cjs'
            }
          ]
        },
        gates: []
      })
    );
    await writeFile(
      path.join(runRoot, 'input', 'task.yaml'),
      JSON.stringify({ id: 'nm-001', objective: 'Fix quantity clamp' })
    );
    await writeFile(
      path.join(runRoot, 'workspace', 'workspace-ref.json'),
      JSON.stringify({ worktree_path: path.join(tmp, 'candidate'), base_commit: 'base' })
    );
    await writeFile(path.join(runRoot, 'patches', 'candidate.patch'), 'diff');
    await writeFile(path.join(runRoot, 'patches', 'changed-files.json'), '[]');

    const evaluation = await runProduct100Phase5Live({
      phase4: {
        tmp_root: tmp,
        eval_root: evalRoot,
        issues: [
          {
            repo_id: 'node-monorepo-scope',
            issue_id: 'NM-001',
            loop_id: 'loop-n',
            pr_candidate: true,
            selected_candidate_id: 'candidate-1',
            selected_patch: path.join(runRoot, 'patches', 'candidate.patch')
          }
        ]
      },
      reviewerOutput: { findings: [], proposals: [goodProposal] },
      provider: 'openai',
      realLlm: true,
      reviewerCommand: 'separate-reviewer',
      builderCommand: 'builder',
      separateContext: true,
      candidateWorktree: path.join(tmp, 'candidate'),
      baseWorktree: path.join(tmp, 'base'),
      confirmHandoff: async () => ({
        authority: 'deterministic_isolated_execution',
        executed: true,
        all_confirmed: false,
        execution: { network: 'none' },
        confirmations: [
          {
            proposalId: 'edge-case',
            executed: true,
            confirmed: false,
            reason: 'expected fail-on-base/pass-on-candidate, got base=fail candidate=fail',
            base: 'fail',
            candidate: 'fail'
          }
        ]
      }),
      buildRulepackCandidate: async () => ({
        candidate_created: false
      })
    });

    expect(evaluation.phase5_pass).toBe(false);
    expect(evaluation.improvement_required).toBe(true);
    expect(evaluation.m2_confirmed_under_r1).toBe(false);
    expect(evaluation.next_step).toContain('run_builder_again');
    expect(evaluation.counterexample_repair_task_file).toContain(
      'counterexample-repair.task.json'
    );
    const repairEval = JSON.parse(
      await readFile(evaluation.counterexample_repair_eval_file, 'utf8')
    );
    expect(
      path.resolve(
        path.dirname(evaluation.counterexample_repair_eval_file),
        repairEval.hidden_acceptance.tests[0].source_path
      )
    ).toBe(originalHiddenFile);
  });
});
