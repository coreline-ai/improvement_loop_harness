#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildReleaseEvidenceAuditReport,
  releaseEvidenceAuditExitCode
} from './release-evidence-audit.mjs';

export const BLOCKED_EXIT = 20;
const DEFAULT_TIMEOUT_MS = 120_000;

function trimOutput(value) {
  return String(value).trim().slice(0, 4_000);
}

export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        status: 'timeout',
        exit_code: null,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr)
      });
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        status: 'spawn_error',
        exit_code: null,
        stdout: trimOutput(stdout),
        stderr: trimOutput(`${stderr}\n${error.message}`)
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        status: code === 0 ? 'pass' : 'fail',
        exit_code: code,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr)
      });
    });
  });
}

function commandSummary(result) {
  return {
    ok: result.ok,
    status: result.status,
    exit_code: result.exit_code,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function globPatternToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`);
}

export function artifactNameMatchesPattern(name, pattern) {
  return globPatternToRegExp(pattern).test(String(name));
}

function normalizeArtifactDigest(value) {
  const digest = String(value ?? '').trim();
  return /^sha256:[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : null;
}

export function artifactReplayReadiness(artifact, options = {}) {
  const requireDigest = options.requireArtifactDigest !== false;
  const blockers = [];
  const size = Number(artifact?.size_in_bytes);
  if (artifact?.expired === true) blockers.push('expired');
  if (!Number.isFinite(size) || size <= 0) blockers.push('invalid_size');
  if (requireDigest && !normalizeArtifactDigest(artifact?.digest)) {
    blockers.push('missing_sha256_digest');
  }
  return {
    ok: blockers.length === 0,
    blockers
  };
}

function summarizeArtifact(artifact, options = {}) {
  const summary = {
    id: artifact?.id ?? null,
    name: artifact?.name ?? null,
    expired: artifact?.expired ?? null,
    size_in_bytes: artifact?.size_in_bytes ?? null,
    digest: normalizeArtifactDigest(artifact?.digest),
    created_at: artifact?.created_at ?? null,
    expires_at: artifact?.expires_at ?? null
  };
  const readiness = artifactReplayReadiness(summary, options);
  return {
    ...summary,
    replay_ready: readiness.ok,
    replay_blockers: readiness.blockers
  };
}

function defaultRunId(env = process.env) {
  return env.VIBELOOP_GITHUB_RUN_ID ?? env.GITHUB_RUN_ID;
}

function defaultRunAttempt(env = process.env) {
  return env.VIBELOOP_GITHUB_RUN_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT;
}

export function artifactPattern(options) {
  if (options.artifactPattern) return options.artifactPattern;
  const runId = options.runId;
  const attempt = options.runAttempt;
  return `*evidence-${runId}-${attempt ?? '*'}`;
}

async function listRunArtifacts(candidate, pattern, options, runCommand) {
  if (!options.repo || options.artifactLookup === false) {
    return null;
  }
  const args = [
    'api',
    `repos/${options.repo}/actions/runs/${candidate.run_id}/artifacts`
  ];
  const result = await runCommand('gh', args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs
  });
  const command = ['gh', ...args];
  if (!result.ok) {
    return {
      ok: false,
      reason: 'GH_RELEASE_ARTIFACT_LIST_FAILED',
      command,
      ...commandSummary(result)
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '{}');
  } catch (error) {
    return {
      ok: false,
      reason: 'GH_RELEASE_ARTIFACT_LIST_INVALID_JSON',
      command,
      ...commandSummary(result),
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const artifacts = (
    Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.artifacts)
        ? parsed.artifacts
        : []
  ).map((artifact) => summarizeArtifact(artifact, options));
  const matchingArtifacts = artifacts.filter((artifact) =>
    artifact.name ? artifactNameMatchesPattern(artifact.name, pattern) : false
  );
  const replayReadyArtifacts = matchingArtifacts.filter(
    (artifact) => artifact.replay_ready
  );
  const replayBlockedArtifacts = matchingArtifacts.filter(
    (artifact) => !artifact.replay_ready
  );
  return {
    ok: true,
    command,
    artifact_count: artifacts.length,
    matching_count: matchingArtifacts.length,
    replay_ready_matching_count: replayReadyArtifacts.length,
    replay_blocked_matching_count: replayBlockedArtifacts.length,
    all_matching_replay_ready:
      matchingArtifacts.length > 0 && replayBlockedArtifacts.length === 0,
    artifacts,
    matching_artifacts: matchingArtifacts,
    replay_ready_matching_artifacts: replayReadyArtifacts,
    replay_blocked_matching_artifacts: replayBlockedArtifacts
  };
}

function runIdFromGhRun(runInfo) {
  return runInfo?.databaseId ?? runInfo?.id ?? runInfo?.number ?? null;
}

async function candidateRuns(options, runCommand) {
  if (options.runId && options.latest) {
    throw new Error('--latest cannot be combined with --run-id');
  }
  const selectedRunId = options.runId ?? defaultRunId(options.env);
  if (selectedRunId && !options.latest) {
    return {
      ok: true,
      source: options.runId ? 'explicit' : 'environment',
      runs: [
        {
          run_id: String(selectedRunId),
          run_attempt:
            options.runAttempt ?? defaultRunAttempt(options.env) ?? null
        }
      ]
    };
  }
  if (!options.latest) {
    throw new Error(
      '--run-id is required unless --latest, GITHUB_RUN_ID, or VIBELOOP_GITHUB_RUN_ID is set'
    );
  }

  const args = [
    'run',
    'list',
    '--limit',
    String(options.latestLimit ?? 10),
    '--status',
    options.runStatus ?? 'completed',
    '--json',
    'databaseId,attempt,status,conclusion,headBranch,workflowName,displayTitle,createdAt'
  ];
  if (options.workflow) {
    args.push('--workflow', options.workflow);
  }
  if (options.branch) {
    args.push('--branch', options.branch);
  }
  if (options.repo) {
    args.push('--repo', options.repo);
  }

  const result = await runCommand('gh', args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs
  });
  const command = ['gh', ...args];
  if (!result.ok) {
    return {
      ok: false,
      reason: 'GH_RELEASE_RUN_SELECTION_FAILED',
      command,
      ...commandSummary(result)
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch (error) {
    return {
      ok: false,
      reason: 'GH_RELEASE_RUN_SELECTION_INVALID_JSON',
      command,
      ...commandSummary(result),
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const runs = (Array.isArray(parsed) ? parsed : [])
    .map((runInfo) => ({
      run_id: runIdFromGhRun(runInfo),
      run_attempt: runInfo?.attempt ?? null,
      status: runInfo?.status ?? null,
      conclusion: runInfo?.conclusion ?? null,
      head_branch: runInfo?.headBranch ?? null,
      workflow_name: runInfo?.workflowName ?? null,
      display_title: runInfo?.displayTitle ?? null,
      created_at: runInfo?.createdAt ?? null
    }))
    .filter((runInfo) => runInfo.run_id !== null)
    .map((runInfo) => ({
      ...runInfo,
      run_id: String(runInfo.run_id),
      run_attempt:
        runInfo.run_attempt === null ? null : String(runInfo.run_attempt)
    }));

  if (runs.length === 0) {
    return {
      ok: false,
      reason: 'GH_RELEASE_RUN_SELECTION_EMPTY',
      command,
      ...commandSummary(result)
    };
  }

  return {
    ok: true,
    source: 'latest',
    command,
    workflow: options.workflow ?? null,
    branch: options.branch ?? null,
    latest_limit: options.latestLimit ?? 10,
    runs
  };
}

export async function buildGitHubReleaseEvidenceAuditReport(options = {}) {
  const runCommand = options.runCommand ?? run;
  const candidates = await candidateRuns(options, runCommand);
  if (!candidates.ok) {
    return {
      status: 'blocked',
      scenario: 'release-evidence-audit-gh',
      mode: 'github-actions-artifact-evidence-only',
      reason: candidates.reason,
      github: {
        repo: options.repo ?? null,
        run_selection: candidates
      },
      next_step:
        'Verify gh auth and workflow run visibility, then rerun this command before claiming GitHub artifact-backed release evidence.'
    };
  }

  const downloadDir = path.resolve(
    options.outputDir ??
      (await mkdtemp(path.join(os.tmpdir(), 'vibeloop-ci-release-evidence-')))
  );
  const attemptedDownloads = [];
  let selected = null;
  let download = null;
  let downloadArgs = null;

  for (const candidate of candidates.runs) {
    const pattern = artifactPattern({
      artifactPattern: options.artifactPattern,
      runId: candidate.run_id,
      runAttempt: candidate.run_attempt
    });
    const args = [
      'run',
      'download',
      candidate.run_id,
      '--pattern',
      pattern,
      '--dir',
      downloadDir
    ];
    if (options.repo) {
      args.push('--repo', options.repo);
    }
    const artifactLookup = await listRunArtifacts(
      candidate,
      pattern,
      options,
      runCommand
    );
    if (artifactLookup?.ok && artifactLookup.matching_count === 0) {
      attemptedDownloads.push({
        run_id: candidate.run_id,
        run_attempt: candidate.run_attempt,
        artifact_pattern: pattern,
        command: ['gh', ...args],
        artifact_lookup: artifactLookup,
        skipped_download: true,
        ok: false,
        status: 'missing_artifacts',
        exit_code: null,
        stdout: '',
        stderr: 'no matching evidence artifacts listed by GitHub Actions API'
      });
      continue;
    }
    if (artifactLookup?.ok && !artifactLookup.all_matching_replay_ready) {
      attemptedDownloads.push({
        run_id: candidate.run_id,
        run_attempt: candidate.run_attempt,
        artifact_pattern: pattern,
        command: ['gh', ...args],
        artifact_lookup: artifactLookup,
        skipped_download: true,
        ok: false,
        status: 'unreplayable_artifacts',
        exit_code: null,
        stdout: '',
        stderr:
          'matching evidence artifacts are expired, empty, or missing sha256 digest metadata'
      });
      continue;
    }
    const result = await runCommand('gh', args, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs
    });
    attemptedDownloads.push({
      run_id: candidate.run_id,
      run_attempt: candidate.run_attempt,
      artifact_pattern: pattern,
      command: ['gh', ...args],
      ...(artifactLookup ? { artifact_lookup: artifactLookup } : {}),
      ...commandSummary(result)
    });
    if (result.ok) {
      selected = { ...candidate, artifact_pattern: pattern };
      download = result;
      downloadArgs = args;
      break;
    }
  }

  const github = {
    run_id: selected?.run_id ?? null,
    run_attempt: selected?.run_attempt ?? null,
    repo: options.repo ?? null,
    artifact_pattern: selected?.artifact_pattern ?? null,
    run_selection: {
      source: candidates.source,
      ...(candidates.command ? { command: candidates.command } : {}),
      ...(candidates.workflow ? { workflow: candidates.workflow } : {}),
      ...(candidates.branch ? { branch: candidates.branch } : {}),
      ...(candidates.latest_limit
        ? { latest_limit: candidates.latest_limit }
        : {}),
      candidates: candidates.runs.map((candidate) => ({
        run_id: candidate.run_id,
        run_attempt: candidate.run_attempt,
        status: candidate.status ?? null,
        conclusion: candidate.conclusion ?? null,
        head_branch: candidate.head_branch ?? null,
        workflow_name: candidate.workflow_name ?? null,
        display_title: candidate.display_title ?? null,
        created_at: candidate.created_at ?? null
      }))
    }
  };

  if (!download || !selected || !downloadArgs) {
    return {
      status: 'blocked',
      scenario: 'release-evidence-audit-gh',
      mode: 'github-actions-artifact-evidence-only',
      reason: 'GH_RELEASE_EVIDENCE_DOWNLOAD_FAILED',
      github,
      download: {
        directory: downloadDir,
        attempts: attemptedDownloads
      },
      next_step:
        'Verify gh auth, the workflow run id, and uploaded evidence artifacts, then rerun this command before claiming GitHub artifact-backed release evidence.'
    };
  }

  const audit = await buildReleaseEvidenceAuditReport({
    evidenceRoots: [downloadDir],
    scenarioNames: options.scenarioNames,
    allReleaseEvidence: options.allReleaseEvidence
  });

  return {
    status: audit.status,
    scenario: 'release-evidence-audit-gh',
    mode: 'github-actions-artifact-evidence-only',
    github,
    download: {
      directory: downloadDir,
      command: ['gh', ...downloadArgs],
      attempts: attemptedDownloads,
      ...commandSummary(download)
    },
    audit,
    next_step:
      audit.status === 'pass'
        ? undefined
        : 'Inspect the downloaded evidence artifact contents and rerun the CI jobs that produced missing or invalid scenario evidence.'
  };
}

export function githubReleaseEvidenceAuditExitCode(report) {
  if (report.status === 'blocked') return BLOCKED_EXIT;
  return releaseEvidenceAuditExitCode(report.audit ?? report);
}

export function parseArgs(argv, env = process.env) {
  const scenarioNames = [];
  const options = {
    allReleaseEvidence: false,
    latest: false,
    latestLimit: Number.parseInt(env.VIBELOOP_GITHUB_RUN_LIMIT ?? '10', 10),
    workflow: env.VIBELOOP_GITHUB_WORKFLOW ?? 'CI',
    branch: env.VIBELOOP_GITHUB_BRANCH ?? env.GITHUB_REF_NAME,
    repo: env.VIBELOOP_GITHUB_REPOSITORY ?? env.GITHUB_REPOSITORY,
    requireArtifactDigest: env.VIBELOOP_GITHUB_REQUIRE_ARTIFACT_DIGEST !== '0',
    env
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--run-id') {
      const value = argv[index + 1];
      if (!value) throw new Error('--run-id requires a GitHub Actions run id');
      options.runId = value;
      index += 1;
      continue;
    }
    if (arg === '--run-attempt') {
      const value = argv[index + 1];
      if (!value)
        throw new Error('--run-attempt requires a run attempt number');
      options.runAttempt = value;
      index += 1;
      continue;
    }
    if (arg === '--latest') {
      options.latest = true;
      continue;
    }
    if (arg === '--latest-limit') {
      const value = argv[index + 1];
      if (!value) throw new Error('--latest-limit requires a positive integer');
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error('--latest-limit requires a positive integer');
      }
      options.latestLimit = parsed;
      index += 1;
      continue;
    }
    if (arg === '--workflow') {
      const value = argv[index + 1];
      if (!value)
        throw new Error('--workflow requires a workflow name or file');
      options.workflow = value;
      index += 1;
      continue;
    }
    if (arg === '--branch') {
      const value = argv[index + 1];
      if (!value) throw new Error('--branch requires a branch name');
      options.branch = value;
      index += 1;
      continue;
    }
    if (arg === '--repo') {
      const value = argv[index + 1];
      if (!value) throw new Error('--repo requires OWNER/REPO');
      options.repo = value;
      index += 1;
      continue;
    }
    if (arg === '--output-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--output-dir requires a path');
      options.outputDir = value;
      index += 1;
      continue;
    }
    if (arg === '--artifact-pattern') {
      const value = argv[index + 1];
      if (!value) throw new Error('--artifact-pattern requires a glob pattern');
      options.artifactPattern = value;
      index += 1;
      continue;
    }
    if (arg === '--no-artifact-list') {
      options.artifactLookup = false;
      continue;
    }
    if (arg === '--no-require-artifact-digest') {
      options.requireArtifactDigest = false;
      continue;
    }
    if (arg === '--scenario') {
      const value = argv[index + 1];
      if (!value) throw new Error('--scenario requires a scenario name');
      scenarioNames.push(
        ...value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      );
      index += 1;
      continue;
    }
    if (arg === '--all-release-evidence') {
      options.allReleaseEvidence = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (scenarioNames.length > 0) {
    options.scenarioNames = scenarioNames;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildGitHubReleaseEvidenceAuditReport(options);
  console.log(JSON.stringify(report, null, 2));
  process.exit(githubReleaseEvidenceAuditExitCode(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
