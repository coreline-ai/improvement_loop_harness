#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(skillRoot, '..', '..');
const classifyScript = path.join(__dirname, 'classify-intent.mjs');
const createTaskEvalScript = path.join(__dirname, 'create-task-eval.mjs');
const summarizeReportScript = path.join(__dirname, 'summarize-report.mjs');

const multiValueKeys = new Set([
  'agent',
  'challenger',
  'eval_command',
  'eval_forbidden_literal',
  'eval_hidden_test'
]);

function collectValue(out, key, value) {
  if (multiValueKeys.has(key)) {
    out[key] = [...(out[key] ?? []), value];
    return;
  }
  out[key] = value;
}

function parseArgs(argv) {
  const out = {
    agent: [],
    challenger: [],
    eval_command: [],
    eval_forbidden_literal: [],
    eval_hidden_test: []
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replaceAll('-', '_');
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      out[key] = true;
    } else {
      collectValue(out, key, value);
      i += 1;
    }
  }
  return out;
}

function requireString(args, key) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`missing --${key.replaceAll('_', '-')}`);
  }
  return value.trim();
}

function optionalString(args, key) {
  const value = args[key];
  if (Array.isArray(value)) {
    return value.find(
      (item) => typeof item === 'string' && item.trim().length > 0
    );
  }
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalStrings(args, key) {
  const value = args[key];
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function bool(args, key) {
  return args[key] === true;
}

function assertFinalReverifyCompatibleWithPublication(args) {
  if (!bool(args, 'skip_final_reverify')) return;
  const publishFlags = [];
  if (optionalString(args, 'promote_branch')) {
    publishFlags.push('--promote-branch');
  }
  if (bool(args, 'github_draft_pr')) {
    publishFlags.push('--github-draft-pr');
  }
  if (publishFlags.length === 0) return;
  throw new Error(
    `--skip-final-reverify cannot be used with ${publishFlags.join(
      '/'
    )}; Skill PR candidates require final re-execution`
  );
}

function resolveCli() {
  const override = process.env.VIBELOOP_CLI;
  if (override)
    return { runner: process.execPath, prefix: [override], source: 'env' };
  const devBin = path.join(repoRoot, 'packages/cli/bin/vibeloop');
  if (existsSync(devBin))
    return { runner: process.execPath, prefix: [devBin], source: 'monorepo' };
  const vendor = path.join(skillRoot, 'vendor/vibeloop.mjs');
  if (existsSync(vendor))
    return { runner: process.execPath, prefix: [vendor], source: 'vendor' };
  return { runner: 'vibeloop', prefix: [], source: 'path' };
}

function runProcess(runner, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(runner, argv, {
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `${label} did not print JSON (exit=${result.code}): ${result.stderr || result.stdout}`
    );
  }
}

function addOptional(argv, flag, value) {
  if (value !== undefined) argv.push(flag, value);
}

function addBoolean(argv, flag, enabled) {
  if (enabled) argv.push(flag);
}

function addRepeated(argv, flag, values) {
  for (const value of values) argv.push(flag, value);
}

function buildGlobalPrefix(args) {
  const argv = [];
  addOptional(argv, '--data-dir', optionalString(args, 'data_dir'));
  return argv;
}

function buildImproveCommand(args, generated) {
  assertFinalReverifyCompatibleWithPublication(args);
  const argv = [
    ...buildGlobalPrefix(args),
    'improve',
    '--repo',
    requireString(args, 'repo'),
    '--task',
    generated.task,
    '--eval',
    generated.eval
  ];
  const agents = args.agent.length > 0 ? args.agent : [];
  for (const agent of agents) argv.push('--agent', agent);
  for (const challenger of args.challenger)
    argv.push('--challenger', challenger);
  addOptional(argv, '--project-id', optionalString(args, 'project_id'));
  addOptional(argv, '--loop-id', optionalString(args, 'loop_id'));
  addOptional(argv, '--base-commit', optionalString(args, 'base_commit'));
  addOptional(argv, '--llm-proxy-url', optionalString(args, 'llm_proxy_url'));
  addOptional(argv, '--quality-judge', optionalString(args, 'quality_judge'));
  addOptional(
    argv,
    '--adversary-review',
    optionalString(args, 'adversary_review')
  );
  addOptional(
    argv,
    '--adversary-reviewer-provider',
    optionalString(args, 'adversary_reviewer_provider')
  );
  addOptional(argv, '--promote-branch', optionalString(args, 'promote_branch'));
  addOptional(
    argv,
    '--promote-commit-message',
    optionalString(args, 'promote_commit_message')
  );
  addOptional(argv, '--max-candidates', optionalString(args, 'max_candidates'));
  addBoolean(argv, '--github-draft-pr', bool(args, 'github_draft_pr'));
  addOptional(argv, '--github-repo', optionalString(args, 'github_repo'));
  addOptional(
    argv,
    '--github-token-env',
    optionalString(args, 'github_token_env')
  );
  addOptional(argv, '--github-base', optionalString(args, 'github_base'));
  addOptional(argv, '--github-branch', optionalString(args, 'github_branch'));
  addOptional(
    argv,
    '--github-push-url',
    optionalString(args, 'github_push_url')
  );
  addOptional(
    argv,
    '--github-api-base-url',
    optionalString(args, 'github_api_base_url')
  );
  addOptional(argv, '--github-title', optionalString(args, 'github_title'));
  addBoolean(
    argv,
    '--adversary-require-different-provider',
    bool(args, 'adversary_require_different_provider')
  );
  addBoolean(
    argv,
    '--skip-dependency-install',
    bool(args, 'skip_dependency_install')
  );
  addBoolean(argv, '--skip-final-reverify', bool(args, 'skip_final_reverify'));
  addBoolean(argv, '--allow-dirty', bool(args, 'allow_dirty'));
  return argv;
}

function buildOrchestrateCommand(args) {
  assertFinalReverifyCompatibleWithPublication(args);
  const argv = [
    ...buildGlobalPrefix(args),
    'orchestrate',
    '--repo',
    requireString(args, 'repo')
  ];
  const evalFile = optionalString(args, 'eval');
  if (evalFile) {
    argv.push('--eval', evalFile);
  } else {
    argv.push('--generate-eval');
    const evalCommands =
      optionalStrings(args, 'eval_command').length > 0
        ? optionalStrings(args, 'eval_command')
        : optionalString(args, 'test_command')
          ? [optionalString(args, 'test_command')]
          : [];
    addRepeated(argv, '--eval-command', evalCommands);
    addBoolean(argv, '--eval-artifact-leak', bool(args, 'eval_artifact_leak'));
    addRepeated(
      argv,
      '--eval-forbidden-literal',
      optionalStrings(args, 'eval_forbidden_literal')
    );
    addBoolean(argv, '--eval-scan-patch', bool(args, 'eval_scan_patch'));
    addBoolean(
      argv,
      '--eval-redact-gate-logs',
      bool(args, 'eval_redact_gate_logs')
    );
    addBoolean(
      argv,
      '--eval-token-like-reject',
      bool(args, 'eval_token_like_reject')
    );
    addOptional(
      argv,
      '--eval-max-scan-bytes',
      optionalString(args, 'eval_max_scan_bytes')
    );
    addOptional(
      argv,
      '--eval-rulepack-lock',
      optionalString(args, 'eval_rulepack_lock')
    );
    addOptional(
      argv,
      '--eval-rulepack-semantic',
      optionalString(args, 'eval_rulepack_semantic')
    );
    addOptional(
      argv,
      '--eval-rulepack-semantic-image',
      optionalString(args, 'eval_rulepack_semantic_image')
    );
    addOptional(
      argv,
      '--eval-rulepack-semantic-timeout-ms',
      optionalString(args, 'eval_rulepack_semantic_timeout_ms')
    );
    addRepeated(
      argv,
      '--eval-hidden-test',
      optionalStrings(args, 'eval_hidden_test')
    );
  }
  const agents = args.agent.length > 0 ? args.agent : [];
  for (const agent of agents) argv.push('--agent', agent);
  for (const challenger of args.challenger)
    argv.push('--challenger', challenger);
  addOptional(argv, '--project-id', optionalString(args, 'project_id'));
  addOptional(argv, '--loop-id', optionalString(args, 'loop_id'));
  addOptional(argv, '--base-commit', optionalString(args, 'base_commit'));
  addOptional(argv, '--llm-proxy-url', optionalString(args, 'llm_proxy_url'));
  addOptional(argv, '--max-issues', optionalString(args, 'max_issues') ?? '1');
  addOptional(argv, '--max-candidates', optionalString(args, 'max_candidates'));
  addOptional(argv, '--promote-branch', optionalString(args, 'promote_branch'));
  addOptional(
    argv,
    '--promote-commit-message-prefix',
    optionalString(args, 'promote_commit_message_prefix')
  );
  addOptional(argv, '--quality-judge', optionalString(args, 'quality_judge'));
  addOptional(
    argv,
    '--adversary-review',
    optionalString(args, 'adversary_review')
  );
  addOptional(
    argv,
    '--adversary-reviewer-provider',
    optionalString(args, 'adversary_reviewer_provider')
  );
  addBoolean(
    argv,
    '--adversary-require-different-provider',
    bool(args, 'adversary_require_different_provider')
  );
  addBoolean(argv, '--github-draft-pr', bool(args, 'github_draft_pr'));
  addOptional(argv, '--github-repo', optionalString(args, 'github_repo'));
  addOptional(
    argv,
    '--github-token-env',
    optionalString(args, 'github_token_env')
  );
  addOptional(argv, '--github-base', optionalString(args, 'github_base'));
  addOptional(
    argv,
    '--github-branch-prefix',
    optionalString(args, 'github_branch_prefix')
  );
  addOptional(
    argv,
    '--github-push-url',
    optionalString(args, 'github_push_url')
  );
  addOptional(
    argv,
    '--github-api-base-url',
    optionalString(args, 'github_api_base_url')
  );
  addOptional(
    argv,
    '--github-title-prefix',
    optionalString(args, 'github_title_prefix')
  );
  addBoolean(
    argv,
    '--skip-dependency-install',
    bool(args, 'skip_dependency_install')
  );
  addBoolean(argv, '--skip-final-reverify', bool(args, 'skip_final_reverify'));
  addBoolean(argv, '--allow-dirty', bool(args, 'allow_dirty'));
  return argv;
}

function buildReportCommand(args) {
  return [
    summarizeReportScript,
    '--report',
    requireString(args, 'report'),
    ...(optionalString(args, 'selection_report')
      ? ['--selection-report', optionalString(args, 'selection_report')]
      : [])
  ];
}

async function classifyPrompt(prompt) {
  const result = await runProcess(process.execPath, [
    classifyScript,
    '--prompt',
    prompt
  ]);
  if (result.code !== 0) {
    throw new Error(
      `classify-intent failed: ${result.stderr || result.stdout}`
    );
  }
  return parseJsonOutput(result, 'classify-intent');
}

async function createTaskEval(args, prompt) {
  const outDir = path.resolve(
    optionalString(args, 'out') ?? '.vibeloop/task-eval'
  );
  await mkdir(outDir, { recursive: true });
  const argv = [
    createTaskEvalScript,
    '--template',
    optionalString(args, 'template') ?? 'node',
    '--out',
    outDir,
    '--prompt',
    prompt,
    '--test-command',
    optionalString(args, 'test_command') ??
      optionalString(args, 'eval_command') ??
      'npm test'
  ];
  addOptional(argv, '--id', optionalString(args, 'id'));
  addOptional(argv, '--title', optionalString(args, 'title'));
  addOptional(argv, '--objective', optionalString(args, 'objective'));
  addOptional(argv, '--project', optionalString(args, 'project'));
  const result = await runProcess(process.execPath, argv);
  if (result.code !== 0) {
    throw new Error(
      `create-task-eval failed: ${result.stderr || result.stdout}`
    );
  }
  return parseJsonOutput(result, 'create-task-eval');
}

function printableCommand(cli, argv) {
  return [cli.runner, ...cli.prefix, ...argv]
    .map((part) => (/[\s"'\\$]/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

const args = parseArgs(process.argv.slice(2));
const prompt = requireString(args, 'prompt');
const classification = await classifyPrompt(prompt);
const cli = resolveCli();
let generated = null;
let command = null;
let executeWith = null;
let execution = null;

if (classification.mode === 'user_issue') {
  assertFinalReverifyCompatibleWithPublication(args);
  generated = await createTaskEval(args, prompt);
  const argv = buildImproveCommand(args, generated);
  command = {
    kind: 'vibeloop_improve',
    argv,
    printable: printableCommand(cli, argv)
  };
  executeWith = { runner: cli.runner, argv: [...cli.prefix, ...argv] };
} else if (classification.mode === 'auto_discovery') {
  const argv = buildOrchestrateCommand(args);
  command = {
    kind: 'vibeloop_orchestrate',
    argv,
    printable: printableCommand(cli, argv)
  };
  executeWith = { runner: cli.runner, argv: [...cli.prefix, ...argv] };
} else if (classification.mode === 'report') {
  const argv = buildReportCommand(args);
  command = {
    kind: 'summarize_report',
    argv,
    printable: printableCommand(
      { runner: process.execPath, prefix: [], source: 'node' },
      argv
    )
  };
  executeWith = { runner: process.execPath, argv };
}

if (bool(args, 'execute')) {
  if (!executeWith) {
    execution = {
      code: 20,
      blocked: true,
      reason: 'unsupported_execute_mode',
      mode: classification.mode,
      message: `--execute is not supported for mode ${classification.mode}`
    };
    process.exitCode = 20;
  } else {
    const result = await runProcess(executeWith.runner, executeWith.argv);
    let parsed = null;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = null;
    }
    execution = {
      code: result.code,
      parsed,
      stdout: parsed ? undefined : result.stdout,
      stderr: result.stderr
    };
    process.exitCode = result.code ?? 1;
  }
}

console.log(
  JSON.stringify(
    {
      schema_version: '1.0',
      prompt_present: true,
      mode: classification.mode,
      classification,
      single_issue_policy: classification.single_issue_policy,
      accept_authority: 'deterministic_harness_only',
      generated,
      command,
      execute_requested: bool(args, 'execute'),
      executed: bool(args, 'execute') && execution?.blocked !== true,
      execution
    },
    null,
    2
  )
);
