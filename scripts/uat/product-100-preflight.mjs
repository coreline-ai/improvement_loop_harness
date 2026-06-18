#!/usr/bin/env node
import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildAdversaryLivePreflightReport,
  redact as redactAdversaryText
} from './adversary-live-preflight.mjs';
import { buildPostgresContractReport } from './postgres-contract-uat.mjs';
import { buildProduct100CorpusSpec } from './product-100-corpus.mjs';
import { buildProduct100IssueEvalArtifacts } from './product-100-eval-generator.mjs';

export const PRODUCT_100_PREFLIGHT_SCENARIO = 'product-100-preflight';
export const PRODUCT_100_PREFLIGHT_BLOCKED_EXIT = 20;
const DEFAULT_TIMEOUT_MS = 60_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function defaultProduct100ReviewerCommand() {
  return `node ${path.join(__dirname, 'product-100-codex-reviewer.mjs')} --live`;
}

function trimOutput(value) {
  return String(value ?? '').trim().slice(0, 8_000);
}

function redact(text) {
  return redactAdversaryText(
    String(text ?? '')
      .replace(/(sk-[A-Za-z0-9_-]{8,})/g, 'sk-[REDACTED]')
      .replace(/(ghp_[A-Za-z0-9_]+)/g, 'ghp_[REDACTED]')
      .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
  );
}

export function parseJsonTail(text) {
  const value = String(text ?? '');
  for (let index = value.lastIndexOf('{'); index >= 0; index = value.lastIndexOf('{', index - 1)) {
    const candidate = value.slice(index).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue searching for an earlier JSON object.
    }
  }
  return null;
}

export function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      cwd: options.cwd ?? process.cwd(),
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


export function normalizeAdversaryPreflightReport(report) {
  const normalized = structuredClone(report);
  const smoke = normalized.checks?.container_smoke;
  const smokeText = `${smoke?.stdout ?? ''}
${smoke?.stderr ?? ''}`;
  if (
    normalized.status === 'blocked' &&
    normalized.reason === 'CONTAINER_SMOKE_UNAVAILABLE' &&
    /no such image|not found|pull access denied|image.*missing/i.test(smokeText)
  ) {
    normalized.reason = 'CONTAINER_IMAGE_UNAVAILABLE';
    normalized.required_failures = ['container_image'];
    normalized.next_step =
      'Preload the configured image with docker pull, then rerun corepack pnpm uat:adversary-live-preflight before Product-100 live UAT.';
  }
  return normalized;
}

export function buildProduct100GithubPreflight(env = process.env) {
  const phase6Requested = env.VIBELOOP_PRODUCT_100_ENABLE_PHASE6_LIVE === '1';
  const autoProvision = env.VIBELOOP_PRODUCT_100_ENABLE_GITHUB_REPOS === '1';
  const explicitRepo = env.VIBELOOP_PRODUCT_100_GITHUB_REPO?.trim() ?? '';
  const allowSingleRepo = env.VIBELOOP_PRODUCT_100_ALLOW_SINGLE_GITHUB_REPO === '1';
  if (!phase6Requested) {
    return {
      ok: true,
      status: 'skipped',
      required: 'GitHub draft PR environment is required only when Phase6 live is requested',
      required_failures: [],
      phase6_requested: false,
      auto_provision: autoProvision,
      repository: explicitRepo ? '[configured]' : ''
    };
  }
  const ok = autoProvision || Boolean(explicitRepo && allowSingleRepo);
  const requiredFailures = [];
  if (!autoProvision && !explicitRepo) requiredFailures.push('github_repo_or_auto_provision');
  if (explicitRepo && !allowSingleRepo && !autoProvision) {
    requiredFailures.push('single_github_repo_requires_explicit_allow');
  }
  return {
    ok,
    status: ok ? 'pass' : 'blocked',
    required:
      'Phase6 live requires VIBELOOP_PRODUCT_100_ENABLE_GITHUB_REPOS=1 for one private repo per corpus repo, or an explicitly allowed single GitHub repo',
    required_failures: requiredFailures,
    phase6_requested: true,
    auto_provision: autoProvision,
    owner:
      env.VIBELOOP_PRODUCT_100_GITHUB_OWNER ??
      env.VIBELOOP_UAT_GITHUB_OWNER ??
      'coreline-ai',
    repository: explicitRepo ? '[configured]' : '',
    allow_single_repo: allowSingleRepo
  };
}

export function buildReviewerPreflight(env = process.env) {
  const configuredCommand = env.VIBELOOP_ADVERSARY_REVIEWER_COMMAND?.trim() ?? '';
  const configuredProvider = env.VIBELOOP_ADVERSARY_REVIEWER_PROVIDER?.trim() ?? '';
  const configuredRealLlm = env.VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM === '1';
  const command = configuredCommand || defaultProduct100ReviewerCommand();
  const provider = configuredProvider || 'codex';
  const realLlm = configuredCommand ? configuredRealLlm : true;
  const builderCommand = env.VIBELOOP_PRODUCT_100_BUILDER_COMMAND?.trim() ?? '';
  const separateContext =
    env.VIBELOOP_PRODUCT_100_REVIEWER_SEPARATE_CONTEXT === '1' ||
    !configuredCommand;
  const sameCommand = Boolean(builderCommand && command && builderCommand === command);
  const ok = Boolean(command && provider && realLlm && !sameCommand);
  const requiredFailures = [];
  if (!command) requiredFailures.push('reviewer_command');
  if (!provider) requiredFailures.push('reviewer_provider');
  if (!realLlm) requiredFailures.push('reviewer_real_llm');
  if (sameCommand) requiredFailures.push('reviewer_same_command_as_builder');

  return {
    ok,
    status: ok ? 'pass' : 'blocked',
    required:
      'separate real Codex adversary reviewer command/provider with VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM=1',
    required_failures: requiredFailures,
    command: command ? '[configured]' : '',
    provider: provider ? '[configured]' : '',
    real_llm: realLlm,
    default_wrapper_used: !configuredCommand,
    wrapper: !configuredCommand ? 'product-100-codex-reviewer.mjs --live' : undefined,
    same_builder_command: sameCommand,
    separate_context_declared: separateContext
  };
}

function imageProbeCommand(image) {
  if (String(image).includes('python')) {
    return 'python3 --version';
  }
  return 'node -e "console.log(JSON.stringify({ok:true,runtime:process.version}))"';
}

export async function buildProduct100ExecutionImagePreflight(options = {}) {
  const artifacts =
    options.artifacts ??
    buildProduct100IssueEvalArtifacts(
      options.corpus ?? buildProduct100CorpusSpec()
    );
  const images = [
    ...new Set(
      artifacts
        .map((artifact) => artifact.eval?.execution?.image)
        .filter((image) => typeof image === 'string' && image.length > 0)
    )
  ].sort();
  const run = options.runCommand ?? runCommand;
  const checks = {};
  for (const image of images) {
    const result = await run('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      image,
      'sh',
      '-lc',
      imageProbeCommand(image)
    ], {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    });
    checks[image] = {
      ok: result.ok,
      status: result.status,
      exit_code: result.exit_code,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr)
    };
  }
  const failures = Object.entries(checks)
    .filter(([, check]) => check.ok !== true)
    .map(([image]) => image);
  return {
    status: failures.length === 0 ? 'pass' : 'blocked',
    scenario: 'product-100-execution-images',
    required_failures: failures.map((image) => `execution_image:${image}`),
    images,
    checks
  };
}

async function livePreflightReport(options = {}) {
  if (options.liveReport) return options.liveReport;
  const run = options.runCommand ?? runCommand;
  const result = await run('node', ['scripts/uat/live-preflight.mjs'], {
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });
  const parsed = parseJsonTail(result.stdout);
  return parsed ?? {
    status: result.ok ? 'pass' : 'fail',
    required_failures: ['live_preflight_parse'],
    checks: {},
    raw_result: {
      status: result.status,
      exit_code: result.exit_code,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr)
    }
  };
}

async function postgresPreflightReport(options = {}) {
  if (options.postgresReport) return options.postgresReport;
  return buildPostgresContractReport({
    preflightOnly: true,
    env: options.env ?? process.env,
    runCommand: options.runCommand
  });
}

export async function buildProduct100PreflightReport(options = {}) {
  const env = options.env ?? process.env;
  const requirePostgres =
    options.requirePostgres ?? env.VIBELOOP_PRODUCT_100_REQUIRE_POSTGRES === '1';
  const live = await livePreflightReport(options);
  const adversary = normalizeAdversaryPreflightReport(
    options.adversaryReport ??
      (await buildAdversaryLivePreflightReport({
        runCommand: options.runCommand,
        image: options.image,
        timeoutMs: options.timeoutMs
      }))
  );
  const postgres = await postgresPreflightReport(options);
  const reviewer = options.reviewerReport ?? buildReviewerPreflight(env);
  const github = options.githubReport ?? buildProduct100GithubPreflight(env);
  const executionImages =
    options.executionImageReport ??
    (await buildProduct100ExecutionImagePreflight({
      runCommand: options.runCommand,
      timeoutMs: options.timeoutMs
    }));

  const requiredFailures = [];
  const blockedRequirements = [];
  const optionalWarnings = [];

  if (live.status !== 'pass') {
    requiredFailures.push('live_preflight');
    blockedRequirements.push('live_preflight_pass');
  }
  if (adversary.status !== 'pass') {
    requiredFailures.push('r1_container_preflight');
    blockedRequirements.push('r1_container_preflight_pass');
  }
  if (!reviewer.ok) {
    requiredFailures.push(...reviewer.required_failures);
    blockedRequirements.push('real_codex_adversary_reviewer_used');
  }
  if (!github.ok) {
    requiredFailures.push(...github.required_failures);
    blockedRequirements.push('github_draft_prs_open');
  }
  if (executionImages.status !== 'pass') {
    requiredFailures.push(...executionImages.required_failures);
    blockedRequirements.push('product_100_execution_images_pass');
  }
  if (postgres.status !== 'pass') {
    if (requirePostgres) {
      requiredFailures.push('postgres_contract_preflight');
      blockedRequirements.push('release_evidence_audit_pass');
    } else {
      optionalWarnings.push('postgres_contract_preflight');
    }
  }

  const hasHardFail = [live, adversary, postgres, executionImages].some(
    (report) => report.status === 'fail'
  );
  const status =
    requiredFailures.length === 0 ? 'pass' : hasHardFail ? 'fail' : 'blocked';

  return {
    status,
    scenario: PRODUCT_100_PREFLIGHT_SCENARIO,
    required_failures: [...new Set(requiredFailures)],
    blocked_requirements: [...new Set(blockedRequirements)],
    optional_warnings: optionalWarnings,
    require_postgres: requirePostgres,
    checks: {
      live,
      r1_adversary_container: adversary,
      postgres_contract: postgres,
      product_100_execution_images: executionImages,
      real_adversary_reviewer: reviewer,
      github_phase6_environment: github
    },
    next_step:
      status === 'pass'
        ? 'Run Product-100 corpus generation, then the real Codex Builder/Challenger loop.'
        : `Unblock Product-100 preflight requirements: ${[...new Set(requiredFailures)].join(', ')}`
  };
}

export function product100PreflightExitCode(report) {
  if (report.status === 'pass') return 0;
  if (report.status === 'blocked') return PRODUCT_100_PREFLIGHT_BLOCKED_EXIT;
  return 1;
}

async function main() {
  const report = await buildProduct100PreflightReport({
    requirePostgres:
      process.argv.includes('--require-postgres') ||
      process.env.VIBELOOP_PRODUCT_100_REQUIRE_POSTGRES === '1'
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(product100PreflightExitCode(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
