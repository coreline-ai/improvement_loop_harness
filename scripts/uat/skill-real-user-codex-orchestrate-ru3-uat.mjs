#!/usr/bin/env node
// Real-user Codex LIVE orchestrate RU-3 UAT.
//
// Purpose: prove the automatic-discovery path with a real Codex builder and a
// real GitHub draft-PR target. Unlike RU-2, this does NOT use a scripted issue
// queue. It runs a single `vibeloop orchestrate` command that must:
//   1. discover one failing issue from the current repo state,
//   2. generate a task/eval from the discovery evidence,
//   3. run a real Codex builder through the ChatGPT OAuth proxy,
//   4. final-reverify/provenance-check the selected patch,
//   5. commit it to a local integration branch,
//   6. publish a stacked GitHub draft PR branch,
//   7. rediscover on the updated integration branch and repeat.
//
// Honest scope: this is RU-3 verification for auto-discovery + GitHub draft PR.
// It is still NOT full autonomous improvement PASS unless every issue reports
// `selection_quality.full_autonomous_improvement_eligible=true`.
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
const scenarioRoot = path.join(repoRoot, 'tests/e2e/user-scenarios/skill-loop');
const targetTemplate = path.join(scenarioRoot, 'target-template');
const model = process.env.VIBELOOP_UAT_MODEL || 'gpt-5.5';
const reasoningEffort = process.env.VIBELOOP_UAT_REASONING_EFFORT || 'xhigh';
const owner = process.env.VIBELOOP_UAT_GITHUB_OWNER || 'coreline-ai';
const keepRemote = process.env.VIBELOOP_UAT_KEEP_REMOTE === '1';
const keepTmp = process.env.VIBELOOP_UAT_KEEP_TMP === '1';
const maxIssues = Number(process.env.VIBELOOP_UAT_RU3_MAX_ISSUES || '2');
const maxCandidates = Number(process.env.VIBELOOP_UAT_RU3_MAX_CANDIDATES || '1');
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
  if (index < 0) {
    throw new Error(`no JSON in CLI stdout: ${stdout.slice(0, 300)}`);
  }
  return JSON.parse(stdout.slice(index));
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function assertNoHiddenLeak(label, value) {
  if (JSON.stringify(value).includes(hiddenSentinel)) {
    throw new Error(`${label} leaked hidden sentinel`);
  }
}

async function writeFailingDiscoveryTests(localRepo) {
  await mkdir(path.join(localRepo, 'src'), { recursive: true });
  await mkdir(path.join(localRepo, 'tests'), { recursive: true });
  await writeFile(
    path.join(localRepo, 'src/cart-total.cjs'),
    [
      'function calculateTotal(items) {',
      '  return items.reduce((sum, item) => sum + item.price, 0);',
      '}',
      '',
      'module.exports = { calculateTotal };',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(localRepo, 'src/sku.cjs'),
    [
      'function normalizeSku(value) {',
      '  return String(value);',
      '}',
      '',
      'module.exports = { normalizeSku };',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(localRepo, 'tests/base.test.cjs'),
    [
      "const assert = require('node:assert/strict');",
      "const { calculateTotal } = require('../src/cart-total.cjs');",
      "const { normalizeSku } = require('../src/sku.cjs');",
      '',
      'assert.equal(calculateTotal([{ price: 7, quantity: 1 }]), 7);',
      "assert.equal(normalizeSku('ABC-123'), 'ABC-123');",
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(localRepo, 'tests/cart-quantity.test.cjs'),
    [
      "const assert = require('node:assert/strict');",
      "const { calculateTotal } = require('../src/cart-total.cjs');",
      'try {',
      '  assert.equal(calculateTotal([{ price: 5, quantity: 3 }]), 15);',
      '} catch (error) {',
      "  console.error('FAIL src/cart-total.cjs: calculateTotal must multiply price by quantity');",
      '  throw error;',
      '}',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(localRepo, 'tests/sku-normalization.test.cjs'),
    [
      "const assert = require('node:assert/strict');",
      "const { normalizeSku } = require('../src/sku.cjs');",
      'try {',
      "  assert.equal(normalizeSku('  abc-123  '), 'ABC-123');",
      '} catch (error) {',
      "  console.error('FAIL src/sku.cjs: normalizeSku must trim and uppercase values');",
      '  throw error;',
      '}',
      ''
    ].join('\n')
  );
}

async function githubToken() {
  if (process.env.VIBELOOP_GITHUB_TOKEN) return process.env.VIBELOOP_GITHUB_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const token = await run('gh', ['auth', 'token']);
  if (token.code !== 0 || token.stdout.trim().length === 0) return null;
  return token.stdout.trim();
}

function issueStrictStatus(issue) {
  const quality = issue.selection_quality ?? null;
  return {
    issue_index: issue.index,
    task_id: issue.task_id,
    pr_candidate: issue.pr_candidate === true,
    draft_pr_url: issue.draft_pr?.pr_url ?? null,
    draft_pr_pushed: issue.draft_pr?.pushed === true,
    promotion_branch: issue.promotion?.branch_name ?? null,
    final_verification_passed: issue.final_verification?.passed === true,
    selection_quality_status: quality?.status ?? null,
    strict_score_improvement: quality?.strict_score_improvement === true,
    full_autonomous_improvement_eligible:
      quality?.full_autonomous_improvement_eligible === true
  };
}

async function main() {
  if (!Number.isInteger(maxIssues) || maxIssues < 1) {
    throw new Error('VIBELOOP_UAT_RU3_MAX_ISSUES must be a positive integer');
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    throw new Error('VIBELOOP_UAT_RU3_MAX_CANDIDATES must be a positive integer');
  }

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
  if ((await run('gh', ['auth', 'status'])).code !== 0) {
    return blocked('GH_NOT_AUTHENTICATED');
  }
  const token = await githubToken();
  if (!token) return blocked('GH_TOKEN_NOT_AVAILABLE');

  const tag = `${process.pid}-${Date.now()}`;
  const repoName = `vibeloop-realuser-ru3-${tag}`;
  const fullRepo = `${owner}/${repoName}`;
  const tmpRoot = await mkdtemp(path.join(os.homedir(), '.vibeloop-realuser-ru3-'));
  const dataDir = path.join(tmpRoot, 'data');
  const localRepo = path.join(tmpRoot, 'project');
  await mkdir(dataDir, { recursive: true });

  let proxy;
  try {
    await cp(targetTemplate, localRepo, { recursive: true });
    await writeFailingDiscoveryTests(localRepo);
    await git(localRepo, ['init', '-b', 'main']);
    await git(localRepo, ['config', 'user.email', 'realuser-ru3@example.test']);
    await git(localRepo, ['config', 'user.name', 'VibeLoop Real User RU3']);
    await git(localRepo, ['add', '-A']);
    await git(localRepo, ['commit', '-m', 'seed: ru3 auto-discovery bugs + failing tests']);
    const baseCommit = (await git(localRepo, ['rev-parse', 'HEAD'])).stdout.trim();

    const created = await run('gh', [
      'repo',
      'create',
      fullRepo,
      '--private',
      '--source',
      localRepo,
      '--remote',
      'origin',
      '--push'
    ]);
    if (created.code !== 0) {
      return blocked('GH_REPO_CREATE_FAILED', { stderr: created.stderr.trim() });
    }

    proxy = await startCodexOAuthProxy({
      model,
      upstreamBaseUrl:
        process.env.VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL ||
        DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL
    });
    const agentSpec = buildCodexOAuthCommand({
      codeHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      proxyBaseUrl: proxy.baseUrl,
      provider: 'vibeloop-oauth-proxy',
      model,
      reasoningEffort,
      requiresOpenaiAuth: true
    });

    const env = {
      ...process.env,
      VIBELOOP_GITHUB_TOKEN: token
    };
    const cli = await run(
      process.execPath,
      [
        path.join(repoRoot, 'packages/cli/bin/vibeloop'),
        '--data-dir',
        dataDir,
        'orchestrate',
        '--repo',
        localRepo,
        '--generate-eval',
        '--eval-command',
        'npm test',
        '--agent',
        agentSpec,
        '--project-id',
        'realuser-ru3',
        '--loop-id',
        `realuser-ru3-${tag}`,
        '--base-commit',
        baseCommit,
        '--max-issues',
        String(maxIssues),
        '--max-candidates',
        String(maxCandidates),
        '--promote-branch',
        'vibeloop/ru3-integration',
        '--promote-commit-message-prefix',
        'vibeloop ru3 selected patch',
        '--github-draft-pr',
        '--github-repo',
        fullRepo,
        '--github-token-env',
        'VIBELOOP_GITHUB_TOKEN',
        '--github-base',
        'main',
        '--github-branch-prefix',
        `pr-candidate/ru3-${tag}`,
        '--skip-dependency-install'
      ],
      { env }
    );
    await writeFile(
      path.join(tmpRoot, 'orchestrate.stdout.log'),
      redact(cli.stdout)
    );
    await writeFile(
      path.join(tmpRoot, 'orchestrate.stderr.log'),
      redact(cli.stderr)
    );
    const out = parseCliJson(cli.stdout);

    await git(localRepo, ['checkout', 'vibeloop/ru3-integration']);
    const finalTest = await run('npm', ['test'], { cwd: localRepo });
    await writeFile(
      path.join(tmpRoot, 'final-test.stdout.log'),
      redact(finalTest.stdout)
    );
    await writeFile(
      path.join(tmpRoot, 'final-test.stderr.log'),
      redact(finalTest.stderr)
    );

    const issues = out.issues ?? [];
    const issueStatus = issues.map(issueStrictStatus);
    const everyIssuePrCandidate =
      issues.length === maxIssues &&
      issueStatus.every(
        (issue) =>
          issue.pr_candidate &&
          issue.draft_pr_pushed &&
          !!issue.draft_pr_url &&
          issue.final_verification_passed
      );
    const strictImprovementEveryIssue =
      issues.length === maxIssues &&
      issueStatus.every((issue) => issue.strict_score_improvement);
    const hiddenLeak = JSON.stringify(out).includes(hiddenSentinel);

    const discoveryReports = [];
    for (const reportPath of out.discovery_reports ?? []) {
      if (existsSync(reportPath)) {
        discoveryReports.push(await readJson(reportPath));
      }
    }
    const rediscoveryAfterEachFix =
      out.cumulative_promotion?.rediscovery_after_each_fix === true &&
      (out.discovery_reports ?? []).length >= maxIssues;
    const cliSucceeded = cli.code === 0;
    const finalTestPassed = finalTest.code === 0;
    const proxyAuthHeaderSeen = proxy?.stats?.auth_header_seen === true;
    const verificationPass =
      cliSucceeded &&
      everyIssuePrCandidate &&
      rediscoveryAfterEachFix &&
      finalTestPassed &&
      proxyAuthHeaderSeen &&
      !hiddenLeak;
    const fullAutonomousImprovementPass =
      verificationPass && strictImprovementEveryIssue;

    const ledger = {
      status:
        verificationPass
          ? 'REAL_USER_RU3_ORCHESTRATE_VERIFICATION_PASS'
          : 'REAL_USER_RU3_ORCHESTRATE_FAIL',
      scenario: 'skill-real-user-codex-orchestrate-ru3-uat',
      mode: 'auto-discovery orchestrate with real Codex builder and GitHub draft PRs',
      orchestrator:
        'vibeloop orchestrate --generate-eval --promote-branch --github-draft-pr',
      builder: { real_llm: true, model, via: 'chatgpt-oauth-proxy' },
      github: {
        repo: fullRepo,
        url: `https://github.com/${fullRepo}`,
        seeded_buggy_base: true,
        draft_prs: issueStatus.map((issue) => ({
          task_id: issue.task_id,
          url: issue.draft_pr_url,
          pushed: issue.draft_pr_pushed
        }))
      },
      initial_commit: baseCommit,
      final_commit: (await git(localRepo, ['rev-parse', 'HEAD'])).stdout.trim(),
      discovered: out.discovered ?? null,
      processed: out.processed ?? null,
      max_issues: maxIssues,
      pr_candidates: out.pr_candidates ?? null,
      issue_count: issues.length,
      every_issue_pr_candidate: everyIssuePrCandidate,
      rediscovery_after_each_fix: rediscoveryAfterEachFix,
      final_test_passed: finalTestPassed,
      verification_status: verificationPass ? 'pass' : 'fail',
      strict_score_improvement_every_issue: strictImprovementEveryIssue,
      full_autonomous_improvement_pass: fullAutonomousImprovementPass,
      strict_full_pass_invariant: {
        verification_required: true,
        strict_score_required: true,
        advisory_support_is_not_enough: true,
        satisfied: fullAutonomousImprovementPass
      },
      issue_status: issueStatus,
      false_pass: 0,
      leak: hiddenLeak ? 1 : 0,
      cli_exit: cli.code,
      proxy_auth_header_seen: proxy?.stats?.auth_header_seen ?? null,
      verification_predicate: {
        cli_succeeded: cliSucceeded,
        every_issue_pr_candidate: everyIssuePrCandidate,
        rediscovery_after_each_fix: rediscoveryAfterEachFix,
        final_test_passed: finalTestPassed,
        proxy_auth_header_seen: proxyAuthHeaderSeen,
        no_hidden_leak: !hiddenLeak
      },
      evidence: {
        tmp_root: tmpRoot,
        data_dir: dataDir,
        local_repo: localRepo,
        orchestrate_stdout: path.join(tmpRoot, 'orchestrate.stdout.log'),
        orchestrate_stderr: path.join(tmpRoot, 'orchestrate.stderr.log'),
        final_test_stdout: path.join(tmpRoot, 'final-test.stdout.log'),
        final_test_stderr: path.join(tmpRoot, 'final-test.stderr.log'),
        discovery_reports: out.discovery_reports ?? [],
        selection_reports: issues.map((issue) => issue.selection_report).filter(Boolean)
      },
      discovery_report_summaries: discoveryReports.map((report) => ({
        iteration: report.iteration,
        discovered: report.discovered,
        titles: (report.candidates ?? []).map((candidate) => candidate.title)
      })),
      limitations: [
        'proves real Codex/GitHub RU-3 verification only when status is REAL_USER_RU3_ORCHESTRATE_VERIFICATION_PASS',
        'does not prove full autonomous improvement unless full_autonomous_improvement_pass is true',
        'generated eval is visible-test/minimal; hidden/adversary semantic eval generation remains future work'
      ]
    };

    if (
      ledger.status === 'REAL_USER_RU3_ORCHESTRATE_VERIFICATION_PASS' &&
      ledger.full_autonomous_improvement_pass &&
      !strictImprovementEveryIssue
    ) {
      throw new Error('strict full-pass invariant violated');
    }
    if (
      ledger.full_autonomous_improvement_pass !==
      (verificationPass && strictImprovementEveryIssue)
    ) {
      throw new Error(
        'strict full-pass invariant violated: full_autonomous_improvement_pass must equal verificationPass && strictImprovementEveryIssue'
      );
    }
    assertNoHiddenLeak('ledger', ledger);
    console.log(JSON.stringify(ledger, null, 2));
    if (ledger.status !== 'REAL_USER_RU3_ORCHESTRATE_VERIFICATION_PASS') {
      process.exitCode = 1;
    }
  } finally {
    if (proxy) await proxy.close().catch(() => undefined);
    if (!keepRemote) {
      const del = await run('gh', ['repo', 'delete', fullRepo, '--yes']);
      if (del.code !== 0) await run('gh', ['repo', 'archive', fullRepo, '--yes']);
    }
    if (!keepTmp) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : String(error)
    );
    process.exitCode = 1;
  })
  .finally(() => {
    // The Codex OAuth proxy and upstream fetch stack can leave keep-alive
    // handles around after cleanup. This UAT script has already flushed its
    // ledger, so exit explicitly to avoid a false hang after a conclusive PASS
    // or FAIL.
    setImmediate(() => process.exit(process.exitCode ?? 0));
  });
