#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLlmProxy } from '../../packages/agent-adapters/dist/proxy/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const scenarioRoot = path.join(
  repoRoot,
  'tests/e2e/user-scenarios/cart-quantity'
);
const targetTemplate = path.join(scenarioRoot, 'target-template');

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
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

async function git(cwd, args) {
  const result = await run('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function parseCliJson(stdout) {
  const lines = stdout.trim().split(/\n/).filter(Boolean);
  const start = lines.findIndex((line) => line.trim().startsWith('{'));
  if (start < 0) throw new Error(`CLI JSON output not found: ${stdout}`);
  return JSON.parse(lines.slice(start).join('\n'));
}

async function createTargetRepo(tmpRoot) {
  const repoPath = path.join(tmpRoot, 'target');
  await mkdir(repoPath, { recursive: true });
  await cp(targetTemplate, repoPath, { recursive: true });
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'codex-proxy-uat@example.test']);
  await git(repoPath, ['config', 'user.name', 'Codex Proxy UAT']);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'initial cart fixture']);
  const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  return { repoPath, baseCommit };
}

function blocked(reason, details = {}) {
  console.log(
    JSON.stringify(
      {
        status: 'blocked',
        reason,
        ...details
      },
      null,
      2
    )
  );
}

async function main() {
  const apiKey =
    process.env.VIBELOOP_UAT_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const upstreamBaseUrl =
    process.env.VIBELOOP_UAT_OPENAI_BASE_URL || 'https://api.openai.com';
  const model = process.env.VIBELOOP_UAT_MODEL;
  const codeHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  const codexVersion = await run('codex', ['--version']);
  if (codexVersion.code !== 0) {
    blocked('CODEX_CLI_NOT_AVAILABLE', { stderr: codexVersion.stderr.trim() });
    process.exitCode = 20;
    return;
  }

  if (!apiKey) {
    blocked('MISSING_PROXY_API_KEY', {
      required_env: ['VIBELOOP_UAT_OPENAI_API_KEY', 'OPENAI_API_KEY'],
      codex_version: codexVersion.stdout.trim() || codexVersion.stderr.trim()
    });
    process.exitCode = 20;
    return;
  }

  const tmpRoot = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-codex-proxy-uat-')
  );
  const dataDir = path.join(tmpRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  const loopId = 'real-codex-proxy-uat-loop';
  const projectId = 'real-codex-proxy-uat';
  const proxy = await startLlmProxy({ upstreamBaseUrl, apiKey, loopId });

  try {
    const { repoPath, baseCommit } = await createTargetRepo(tmpRoot);
    const provider = 'vibeloop-proxy';
    const codexParts = [
      'CODEX_HOME=' + shellQuote(codeHome),
      'codex',
      'exec',
      '-c',
      shellQuote('service_tier=fast'),
      '-c',
      shellQuote('approval_policy=never'),
      '-c',
      shellQuote(`model_provider=${JSON.stringify(provider)}`),
      '-c',
      shellQuote(
        `model_providers.${provider}.name=${JSON.stringify('VibeLoop Proxy')}`
      ),
      '-c',
      shellQuote(
        `model_providers.${provider}.base_url=${JSON.stringify(`${proxy.baseUrl}/v1`)}`
      ),
      '-c',
      shellQuote(
        `model_providers.${provider}.wire_api=${JSON.stringify('responses')}`
      ),
      '-c',
      shellQuote(
        `model_providers.${provider}.experimental_bearer_token=${JSON.stringify(
          'vibeloop-proxy-placeholder'
        )}`
      ),
      ...(model ? ['-m', shellQuote(model)] : []),
      '-s',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      '"$VIBELOOP_WORKTREE"',
      '-',
      '<',
      '"$VIBELOOP_TASK_FILE"'
    ];
    const agentSpec = `command:${codexParts.join(' ')}`;

    const cli = await run(
      process.execPath,
      [
        path.join(repoRoot, 'packages/cli/bin/vibeloop'),
        '--data-dir',
        dataDir,
        'run',
        '--repo',
        repoPath,
        '--task',
        path.join(scenarioRoot, 'task.yaml'),
        '--eval',
        path.join(scenarioRoot, 'eval.yaml'),
        '--agent',
        agentSpec,
        '--project-id',
        projectId,
        '--loop-id',
        loopId,
        '--base-commit',
        baseCommit,
        '--skip-dependency-install'
      ],
      { cwd: repoRoot }
    );
    await writeFile(path.join(tmpRoot, 'cli.stdout.log'), cli.stdout);
    await writeFile(path.join(tmpRoot, 'cli.stderr.log'), cli.stderr);
    const output = parseCliJson(cli.stdout);
    const report = JSON.parse(await readFile(output.report, 'utf8'));
    const proxyLogText = proxy.logs.join('\n');
    const keyLeaked = proxyLogText.includes(apiKey);

    console.log(
      JSON.stringify(
        {
          status: output.status,
          decision: output.decision,
          reason: report.decision_reasons?.[0]?.code ?? null,
          report: output.report,
          artifact_root: output.artifact_root,
          tmp_root: tmpRoot,
          changed_files: report.changed_files?.map((file) => file.path) ?? [],
          gates:
            report.gate_runs?.map((gate) => [
              gate.name,
              gate.status,
              gate.type,
              gate.group ?? null
            ]) ?? [],
          evidence: report.improvement_evidence ?? [],
          proxy_usage: proxy.getUsage(loopId),
          proxy_log_redacted: !keyLeaked,
          codex_version:
            codexVersion.stdout.trim() || codexVersion.stderr.trim(),
          cli_exit_code: cli.code
        },
        null,
        2
      )
    );
    if (
      output.status !== 'accepted' ||
      output.decision !== 'accept' ||
      keyLeaked
    ) {
      process.exitCode = 1;
    }
  } finally {
    await proxy.close().catch(() => undefined);
    if (process.env.VIBELOOP_UAT_KEEP_TMP === '0') {
      await rm(tmpRoot, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
