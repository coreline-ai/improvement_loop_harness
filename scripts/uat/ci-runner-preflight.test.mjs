import { describe, expect, it } from 'vitest';
import {
  buildRunnerPreflightReport,
  isGitHubHostedRunnerLabel,
  matchingOnlineRunners,
  parseArgs
} from './ci-runner-preflight.mjs';

describe('CI live runner preflight', () => {
  it('allows known GitHub-hosted runner labels without a self-hosted query', () => {
    const report = buildRunnerPreflightReport({
      runnerLabel: 'ubuntu-latest',
      repo: 'coreline-ai/improvement_loop_harness',
      runners: []
    });

    expect(isGitHubHostedRunnerLabel('ubuntu-latest')).toBe(true);
    expect(report).toMatchObject({
      status: 'pass',
      can_run_live: true,
      runner_kind: 'github-hosted',
      reason: 'GITHUB_HOSTED_RUNNER_LABEL'
    });
  });

  it('allows a custom runner label only when an online runner has that label', () => {
    const runners = [
      {
        name: 'codex-runner-1',
        status: 'online',
        busy: true,
        labels: [{ name: 'self-hosted' }, { name: 'codex-live' }]
      },
      {
        name: 'offline-runner',
        status: 'offline',
        busy: false,
        labels: [{ name: 'codex-live' }]
      }
    ];

    const report = buildRunnerPreflightReport({
      runnerLabel: 'codex-live',
      repo: 'coreline-ai/improvement_loop_harness',
      runners
    });

    expect(matchingOnlineRunners(runners, 'codex-live')).toHaveLength(1);
    expect(report).toMatchObject({
      status: 'pass',
      can_run_live: true,
      runner_kind: 'self-hosted-or-custom',
      reason: 'SELF_HOSTED_RUNNER_AVAILABLE',
      matching_online_runner_count: 1
    });
  });

  it('blocks a custom runner label when no matching online runner exists', () => {
    const report = buildRunnerPreflightReport({
      runnerLabel: 'codex-live',
      repo: 'coreline-ai/improvement_loop_harness',
      runners: []
    });

    expect(report).toMatchObject({
      status: 'blocked',
      can_run_live: false,
      runner_kind: 'self-hosted-or-custom',
      reason: 'SELF_HOSTED_RUNNER_UNAVAILABLE',
      matching_online_runner_count: 0
    });
  });

  it('parses workflow arguments', () => {
    expect(
      parseArgs([
        '--runner-label',
        'codex-live',
        '--repo',
        'coreline-ai/improvement_loop_harness',
        '--output',
        '.ci/runner.json',
        '--github-output',
        '.ci/output'
      ])
    ).toMatchObject({
      runnerLabel: 'codex-live',
      repo: 'coreline-ai/improvement_loop_harness',
      output: '.ci/runner.json',
      githubOutput: '.ci/output'
    });
  });
});
