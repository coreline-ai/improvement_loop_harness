#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL,
  buildCodexOAuthCommand,
  preflightExternalOAuthProxy,
  startCodexOAuthProxy
} from '../../packages/agent-adapters/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const scenarioRoot = path.join(repoRoot, 'tests/e2e/user-scenarios/cart-quantity');
const targetTemplate = path.join(scenarioRoot, 'target-template');
const defaultModel = 'gpt-5.5';
const defaultReasoningEffort = 'xhigh';

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
  await git(repoPath, ['config', 'user.email', 'codex-oauth-uat@example.test']);
  await git(repoPath, ['config', 'user.name', 'Codex OAuth UAT']);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'initial cart fixture']);
  const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  return { repoPath, baseCommit };
}

function blocked(reason, details = {}) {
  console.log(JSON.stringify({ status: 'blocked', reason, ...details }, null, 2));
}

async function main() {
  const model = process.env.VIBELOOP_UAT_MODEL || defaultModel;
  const reasoningEffort = process.env.VIBELOOP_UAT_REASONING_EFFORT || defaultReasoningEffort;
  const codeHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const externalProxyUrl = process.env.VIBELOOP_UAT_OAUTH_PROXY_URL;
  const upstreamBaseUrl = process.env.VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL || DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL;
  const provider = 'vibeloop-oauth-proxy';

  const codexVersion = await run('codex', ['--version']);
  if (codexVersion.code !== 0) {
    blocked('CODEX_CLI_NOT_AVAILABLE', { stderr: codexVersion.stderr.trim() });
    process.exitCode = 20;
    return;
  }

  const loginStatus = await run('codex', ['-c', 'service_tier=fast', 'login', 'status']);
  if (loginStatus.code !== 0) {
    blocked('CODEX_CHATGPT_LOGIN_NOT_AVAILABLE', {
      codex_version: codexVersion.stdout.trim() || codexVersion.stderr.trim(),
      stderr: loginStatus.stderr.trim()
    });
    process.exitCode = 20;
    return;
  }

  let proxy;
  let proxyBaseUrl = externalProxyUrl;
  let proxyMode = 'external-openai-oauth-compatible';
  let requiresOpenaiAuth = false;
  let externalPreflight = null;

  if (proxyBaseUrl) {
    externalPreflight = await preflightExternalOAuthProxy(proxyBaseUrl);
    if (!externalPreflight.ok) {
      blocked('EXTERNAL_OAUTH_PROXY_NOT_REACHABLE', {
        proxy_url: proxyBaseUrl,
        preflight: externalPreflight,
        expected: 'OpenAI-compatible OAuth proxy with /v1/models and /v1/responses'
      });
      process.exitCode = 20;
      return;
    }
  } else {
    proxy = await startCodexOAuthProxy({ model, upstreamBaseUrl });
    proxyBaseUrl = proxy.baseUrl;
    proxyMode = 'internal-codex-oauth-forwarder';
    requiresOpenaiAuth = true;
  }

  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-codex-oauth-uat-'));
  const dataDir = path.join(tmpRoot, 'data');
  await mkdir(dataDir, { recursive: true });
  const loopId = 'real-codex-oauth-proxy-uat-loop';
  const projectId = 'real-codex-oauth-proxy-uat';

  try {
    const { repoPath, baseCommit } = await createTargetRepo(tmpRoot);
    const agentSpec = buildCodexOAuthCommand({
      codeHome,
      proxyBaseUrl,
      provider,
      model,
      reasoningEffort,
      requiresOpenaiAuth
    });

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
    if (proxy) {
      await writeFile(path.join(tmpRoot, 'oauth-proxy.log.json'), `${JSON.stringify(proxy.logs, null, 2)}\n`);
    }

    const output = parseCliJson(cli.stdout);
    const report = JSON.parse(await readFile(output.report, 'utf8'));
    const proxyStats = proxy
      ? proxy.stats
      : {
          mode: proxyMode,
          external_preflight: externalPreflight,
          auth_header_seen: null,
          usage: null
        };

    const hiddenTextLeaked = JSON.stringify(report).includes('SECRET_HIDDEN_EXPECTATION');
    const allPass =
      output.status === 'accepted' &&
      output.decision === 'accept' &&
      report.decision_reasons?.[0]?.code === 'ALL_PASS' &&
      !hiddenTextLeaked;

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
            report.gate_runs?.map((gate) => [gate.name, gate.status, gate.type, gate.group ?? null]) ?? [],
          evidence: report.improvement_evidence ?? [],
          oauth_proxy: {
            mode: proxyMode,
            base_url: proxyBaseUrl,
            requires_openai_auth: requiresOpenaiAuth,
            stats: proxyStats
          },
          model,
          reasoning_effort: reasoningEffort,
          codex_version: codexVersion.stdout.trim() || codexVersion.stderr.trim(),
          login_status: loginStatus.stdout.trim() || loginStatus.stderr.trim(),
          cli_exit_code: cli.code,
          hidden_text_leaked: hiddenTextLeaked
        },
        null,
        2
      )
    );

    if (!allPass) {
      process.exitCode = 1;
    }
  } finally {
    if (proxy) {
      await proxy.close().catch(() => undefined);
    }
    if (process.env.VIBELOOP_UAT_KEEP_TMP === '0') {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
