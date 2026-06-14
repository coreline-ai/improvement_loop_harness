#!/usr/bin/env node
// Real-user Codex strict best-fix UAT.
//
// Purpose: prove that the harness can separate "verification pass" from
// "best-fix/full-improvement proof" with fixed scoring. The run uses one
// intentionally-verbose deterministic builder and one real Codex challenger.
// PASS requires the real Codex challenger to be accepted, final-reverified, and
// selected with `selection_quality.strict_score_improvement=true` over the
// accepted-but-worse verbose builder. Advisory/LLM judge opinions are not used.
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL,
  buildCodexOAuthCommand,
  startCodexOAuthProxy
} from '../../packages/agent-adapters/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const scenarioRoot = path.join(
  repoRoot,
  'tests/e2e/user-scenarios/cart-quantity'
);
const targetTemplate = path.join(scenarioRoot, 'target-template');
const model = process.env.VIBELOOP_UAT_MODEL || 'gpt-5.5';
const reasoningEffort = process.env.VIBELOOP_UAT_REASONING_EFFORT || 'xhigh';
const keepTmp = process.env.VIBELOOP_UAT_KEEP_TMP === '1';
const hiddenSentinel = 'SECRET_HIDDEN_EXPECTATION';

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

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(
      /(access_token|refresh_token|api_key|OPENAI_API_KEY|GITHUB_TOKEN|password)\s*[:=]\s*[^\s"']+/gi,
      '$1=[REDACTED]'
    )
    .replaceAll(hiddenSentinel, '[REDACTED_HIDDEN]');
}

async function mustRun(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.code})\nstdout:\n${redact(result.stdout)}\nstderr:\n${redact(result.stderr)}`
    );
  }
  return result;
}

async function git(cwd, args) {
  return mustRun('git', args, { cwd });
}

function blocked(reason, details = {}) {
  console.log(JSON.stringify({ status: 'blocked', reason, ...details }, null, 2));
  process.exitCode = 20;
}

function parseCliJson(stdout) {
  const index = stdout.indexOf('{');
  if (index < 0) throw new Error(`no JSON in CLI stdout: ${stdout.slice(0, 300)}`);
  return JSON.parse(stdout.slice(index));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeVerboseAcceptedAgent(file) {
  await writeFile(
    file,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.mkdirSync('src', { recursive: true });",
      "fs.mkdirSync('tests', { recursive: true });",
      "fs.writeFileSync(path.join('src', 'cart.cjs'), [",
      "  'function calculateTotal(items) {',",
      "  '  // Verbose but correct implementation intentionally kept worse than the tight real-Codex fix.',",
      "  '  return items.reduce((sum, item) => {',",
      "  '    const quantity = item.quantity === undefined ? 1 : item.quantity;',",
      "  '    return sum + item.price * quantity;',",
      "  '  }, 0);',",
      "  '}',",
      "  '',",
      "  'module.exports = { calculateTotal };',",
      "  ''",
      "].join('\\n'));",
      "fs.writeFileSync(path.join('tests', 'cart-quantity.test.cjs'), [",
      "  \"const assert = require('node:assert/strict');\",",
      "  \"const { calculateTotal } = require('../src/cart.cjs');\",",
      "  '',",
      "  'assert.equal(calculateTotal([{ price: 5, quantity: 2 }]), 10);',",
      "  ''",
      "].join('\\n'));",
      "fs.writeFileSync(path.join('src', 'vibeloop-extra-note.cjs'), \"module.exports = 'verbose accepted comparator';\\n\");",
      "console.log('strict-best-fix verbose comparator produced accepted but worse patch');",
      ''
    ].join('\n'),
    { mode: 0o755 }
  );
}

async function main() {
  if ((await run('codex', ['--version'])).code !== 0) {
    return blocked('CODEX_CLI_NOT_AVAILABLE');
  }
  const login = await run('codex', ['-c', 'service_tier=fast', 'login', 'status']);
  const loginText = `${login.stdout}${login.stderr}`;
  if (login.code !== 0 || !/Logged in/i.test(loginText)) {
    return blocked('CODEX_CHATGPT_LOGIN_NOT_AVAILABLE', {
      code: login.code,
      out: loginText.trim().slice(0, 200)
    });
  }

  const tag = `${process.pid}-${Date.now()}`;
  const tmpRoot = await mkdtemp(path.join(os.homedir(), '.vibeloop-strict-best-'));
  const dataDir = path.join(tmpRoot, 'data');
  const localRepo = path.join(tmpRoot, 'project');
  const verboseAgent = path.join(tmpRoot, 'verbose-accepted-agent.cjs');
  await mkdir(dataDir, { recursive: true });

  let proxy;
  try {
    await cp(targetTemplate, localRepo, { recursive: true });
    await git(localRepo, ['init', '-b', 'main']);
    await git(localRepo, ['config', 'user.email', 'strict-best@example.test']);
    await git(localRepo, ['config', 'user.name', 'VibeLoop Strict Best UAT']);
    await git(localRepo, ['add', '-A']);
    await git(localRepo, ['commit', '-m', 'seed: cart quantity strict-best fixture']);
    const baseCommit = (await git(localRepo, ['rev-parse', 'HEAD'])).stdout.trim();
    await writeVerboseAcceptedAgent(verboseAgent);

    proxy = await startCodexOAuthProxy({
      model,
      upstreamBaseUrl:
        process.env.VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL ||
        DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL
    });
    const codexAgent = buildCodexOAuthCommand({
      codeHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      proxyBaseUrl: proxy.baseUrl,
      provider: 'vibeloop-oauth-proxy',
      model,
      reasoningEffort,
      requiresOpenaiAuth: true
    });
    const verboseAgentSpec = `command:node ${verboseAgent}`;
    const loopId = `strict-best-${tag}`;
    const cli = await run(process.execPath, [
      path.join(repoRoot, 'packages/cli/bin/vibeloop'),
      '--data-dir', dataDir,
      'improve',
      '--repo', localRepo,
      '--task', path.join(scenarioRoot, 'task.yaml'),
      '--eval', path.join(scenarioRoot, 'eval.yaml'),
      '--agent', verboseAgentSpec,
      '--challenger', codexAgent,
      '--project-id', 'strict-best-live',
      '--loop-id', loopId,
      '--base-commit', baseCommit,
      '--max-candidates', '2',
      '--promote-branch', 'pr-candidate/strict-best-live',
      '--promote-commit-message', 'vibeloop strict best selected patch',
      '--skip-dependency-install'
    ]);
    await writeFile(path.join(tmpRoot, 'improve.stdout.log'), redact(cli.stdout));
    await writeFile(path.join(tmpRoot, 'improve.stderr.log'), redact(cli.stderr));
    const out = parseCliJson(cli.stdout);
    const selection = out.selection_report && existsSync(out.selection_report)
      ? await readJson(out.selection_report)
      : null;
    const quality = selection?.selection_quality ?? null;
    const candidates = selection?.candidates ?? [];
    const selected = out.selected_candidate_id ?? null;
    const selectedCandidate = candidates.find((candidate) => candidate.candidate_id === selected) ?? null;
    const comparator = candidates.find((candidate) => candidate.candidate_id?.endsWith('-c0')) ?? null;
    const selectedIsRealCodexChallenger = typeof selected === 'string' && selected.endsWith('-c1');
    const strictBestFixPass =
      cli.code === 0 &&
      selectedIsRealCodexChallenger &&
      out.pr_candidate === true &&
      out.final_verification?.passed === true &&
      quality?.strict_score_improvement === true &&
      quality?.full_autonomous_improvement_eligible === true &&
      candidates.filter((candidate) => candidate.accepted).length >= 2 &&
      proxy?.stats?.auth_header_seen === true;

    await git(localRepo, ['checkout', 'pr-candidate/strict-best-live']);
    const finalTest = await run('npm', ['test'], { cwd: localRepo });
    await writeFile(path.join(tmpRoot, 'final-test.stdout.log'), redact(finalTest.stdout));
    await writeFile(path.join(tmpRoot, 'final-test.stderr.log'), redact(finalTest.stderr));

    const ledger = {
      status:
        strictBestFixPass && finalTest.code === 0
          ? 'REAL_USER_STRICT_BEST_FIX_PASS'
          : 'REAL_USER_STRICT_BEST_FIX_FAIL',
      scenario: 'skill-real-user-codex-strict-best-fix-uat',
      mode: 'verbose deterministic builder vs real Codex challenger',
      builder: { real_llm: false, role: 'accepted_verbose_comparator' },
      challenger: { real_llm: true, model, via: 'chatgpt-oauth-proxy' },
      selected_candidate_id: selected,
      selected_is_real_codex_challenger: selectedIsRealCodexChallenger,
      candidate_count: out.candidate_count ?? null,
      accepted_count: out.accepted_count ?? null,
      pr_candidate: out.pr_candidate === true,
      final_verification_passed: out.final_verification?.passed === true,
      final_test_passed: finalTest.code === 0,
      proxy_auth_header_seen: proxy?.stats?.auth_header_seen ?? null,
      strict_score_improvement: quality?.strict_score_improvement === true,
      full_autonomous_improvement_eligible:
        quality?.full_autonomous_improvement_eligible === true,
      controlled_strict_best_fix_pass: strictBestFixPass && finalTest.code === 0,
      // Reserved for broad multi-issue autonomous runs. This controlled one-issue
      // lane proves the strict best-fix selector, not the full product claim.
      full_autonomous_improvement_pass: false,
      full_autonomous_improvement_scope: 'not_claimed_controlled_single_issue',
      selection_quality: quality,
      score_comparison: {
        selected: selectedCandidate
          ? {
              id: selectedCandidate.candidate_id,
              score: selectedCandidate.score
            }
          : null,
        verbose_comparator: comparator
          ? { id: comparator.candidate_id, score: comparator.score }
          : null
      },
      evidence: {
        tmp_root: tmpRoot,
        data_dir: dataDir,
        local_repo: localRepo,
        improve_stdout: path.join(tmpRoot, 'improve.stdout.log'),
        improve_stderr: path.join(tmpRoot, 'improve.stderr.log'),
        final_test_stdout: path.join(tmpRoot, 'final-test.stdout.log'),
        final_test_stderr: path.join(tmpRoot, 'final-test.stderr.log'),
        selection_report: out.selection_report ?? null,
        selected_report: out.selected_report ?? null
      },
      limitations: [
        'proves strict best-fix selection for a controlled one-issue live-Codex challenger scenario',
        'does not prove broad multi-issue full autonomous improvement by itself',
        'builder comparator is deterministic/verbose; the selected candidate must be real Codex challenger for PASS'
      ]
    };
    if (
      ledger.controlled_strict_best_fix_pass !==
      (ledger.status === 'REAL_USER_STRICT_BEST_FIX_PASS' &&
        ledger.strict_score_improvement)
    ) {
      throw new Error('strict best-fix invariant violated');
    }
    if (ledger.full_autonomous_improvement_pass !== false) {
      throw new Error(
        'strict best-fix invariant violated: controlled lane must not claim full autonomous improvement PASS'
      );
    }
    console.log(JSON.stringify(ledger, null, 2));
    if (ledger.status !== 'REAL_USER_STRICT_BEST_FIX_PASS') process.exitCode = 1;
  } finally {
    if (proxy) await proxy.close().catch(() => undefined);
    if (!keepTmp) await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    setImmediate(() => process.exit(process.exitCode ?? 0));
  });
