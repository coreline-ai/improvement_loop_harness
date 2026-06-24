#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HOSTED_LABELS = new Set([
  'ubuntu-latest',
  'ubuntu-24.04',
  'ubuntu-22.04',
  'macos-latest',
  'macos-15',
  'macos-14',
  'macos-13',
  'windows-latest',
  'windows-2025',
  'windows-2022'
]);

function normalizeRunnerLabel(value) {
  return String(value ?? '').trim();
}

function parseArgs(argv) {
  const options = {
    runnerLabel: process.env.VIBELOOP_CI_RUNNER_LABEL || '',
    repo: process.env.GITHUB_REPOSITORY || '',
    output: '',
    githubOutput: process.env.GITHUB_OUTPUT || '',
    requireCodexLoginRunner: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runner-label') {
      options.runnerLabel = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--repo') {
      options.repo = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--output') {
      options.output = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--github-output') {
      options.githubOutput = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--require-codex-login-runner') {
      options.requireCodexLoginRunner = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function isGitHubHostedRunnerLabel(label) {
  return HOSTED_LABELS.has(normalizeRunnerLabel(label));
}

function matchingOnlineRunners(runners, runnerLabel) {
  const label = normalizeRunnerLabel(runnerLabel);
  return (runners ?? []).filter((runner) => {
    const labels = Array.isArray(runner.labels)
      ? runner.labels.map((item) => item.name)
      : [];
    return runner.status === 'online' && labels.includes(label);
  });
}

function buildRunnerPreflightReport({
  runnerLabel,
  repo,
  runners,
  fetchError,
  requireCodexLoginRunner = false
}) {
  const label = normalizeRunnerLabel(runnerLabel);
  if (!label) {
    return {
      status: 'blocked',
      can_run_live: false,
      runner_label: label,
      runner_kind: 'unknown',
      reason: 'RUNNER_LABEL_REQUIRED',
      next_step: requireCodexLoginRunner
        ? 'Dispatch the live workflow with an online self-hosted/custom runner label that has Codex ChatGPT login available.'
        : 'Dispatch the live workflow with a GitHub-hosted label or an online self-hosted runner label.'
    };
  }
  if (isGitHubHostedRunnerLabel(label)) {
    if (requireCodexLoginRunner) {
      return {
        status: 'blocked',
        can_run_live: false,
        runner_label: label,
        runner_kind: 'github-hosted',
        reason: 'CODEX_LOGIN_RUNNER_REQUIRED',
        matching_online_runner_count: null,
        next_step:
          'Dispatch this live evidence workflow with an online self-hosted/custom runner that has Codex ChatGPT login available.'
      };
    }
    return {
      status: 'pass',
      can_run_live: true,
      runner_label: label,
      runner_kind: 'github-hosted',
      reason: 'GITHUB_HOSTED_RUNNER_LABEL',
      matching_online_runner_count: null,
      next_step:
        'Proceed to the live job; Codex login is checked inside the live job.'
    };
  }
  if (fetchError) {
    const tokenUnavailable =
      /HTTP (401|403)|Requires authentication|Resource not accessible by integration/i.test(
        fetchError
      );
    return {
      status: 'blocked',
      can_run_live: false,
      runner_label: label,
      runner_kind: 'self-hosted-or-custom',
      reason: tokenUnavailable
        ? 'RUNNER_QUERY_TOKEN_UNAVAILABLE'
        : 'RUNNER_QUERY_FAILED',
      error: fetchError,
      next_step: requireCodexLoginRunner
        ? 'Provide a token that can list repository self-hosted runners, or register an online self-hosted/custom runner with Codex ChatGPT login before claiming CI live artifact reproducibility.'
        : 'Provide a token that can list repository self-hosted runners, register an online runner for this label, or rerun with a GitHub-hosted label before claiming CI live artifact reproducibility.'
    };
  }
  const matches = matchingOnlineRunners(runners, label);
  if (matches.length > 0) {
    return {
      status: 'pass',
      can_run_live: true,
      runner_label: label,
      runner_kind: 'self-hosted-or-custom',
      reason: 'SELF_HOSTED_RUNNER_AVAILABLE',
      repo,
      matching_online_runner_count: matches.length,
      matching_runners: matches.map((runner) => ({
        name: runner.name,
        status: runner.status,
        busy: runner.busy,
        labels: Array.isArray(runner.labels)
          ? runner.labels.map((item) => item.name)
          : []
      })),
      next_step: 'Proceed to the live job.'
    };
  }
  return {
    status: 'blocked',
    can_run_live: false,
    runner_label: label,
    runner_kind: 'self-hosted-or-custom',
    reason: 'SELF_HOSTED_RUNNER_UNAVAILABLE',
    repo,
    matching_online_runner_count: 0,
    total_runner_count: Array.isArray(runners) ? runners.length : 0,
    next_step:
      'Register an online self-hosted runner with the requested label, then rerun the live evidence workflow.'
  };
}

function requestJson(url, token) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'vibeloop-ci-runner-preflight',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `GitHub runner query failed with HTTP ${response.statusCode}: ${body.slice(0, 300)}`
              )
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('error', reject);
    request.end();
  });
}

async function fetchRepoRunners(repo, token) {
  const runners = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `https://api.github.com/repos/${repo}/actions/runners?per_page=100&page=${page}`;
    const payload = await requestJson(url, token);
    runners.push(...(payload.runners ?? []));
    if (!payload.runners || payload.runners.length < 100) break;
  }
  return runners;
}

async function resolveGitHubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 10_000
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function writeGitHubOutput(filePath, report) {
  if (!filePath) return;
  await writeFile(
    filePath,
    [
      `can_run_live=${report.can_run_live ? 'true' : 'false'}`,
      `runner_preflight_status=${report.status}`,
      `runner_preflight_reason=${report.reason}`,
      ''
    ].join('\n'),
    { flag: 'a' }
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const label = normalizeRunnerLabel(options.runnerLabel);
  let runners = null;
  let fetchError = null;

  if (label && !isGitHubHostedRunnerLabel(label)) {
    if (!options.repo) {
      fetchError = 'GITHUB_REPOSITORY_UNAVAILABLE';
    } else {
      try {
        runners = await fetchRepoRunners(
          options.repo,
          await resolveGitHubToken()
        );
      } catch (error) {
        fetchError = error.message;
      }
    }
  }

  const report = buildRunnerPreflightReport({
    runnerLabel: label,
    repo: options.repo,
    runners,
    fetchError,
    requireCodexLoginRunner: options.requireCodexLoginRunner
  });

  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  await writeGitHubOutput(options.githubOutput, report);
  console.log(JSON.stringify(report, null, 2));
}

export {
  buildRunnerPreflightReport,
  isGitHubHostedRunnerLabel,
  matchingOnlineRunners,
  normalizeRunnerLabel,
  parseArgs
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
