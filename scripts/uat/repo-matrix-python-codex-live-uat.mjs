#!/usr/bin/env node
// Representative Python LIVE UAT for the repo-diversity matrix.
//
// Scope is deliberately narrow: one controlled Python stdlib repo is promoted
// from the local matrix into a real GitHub + real Codex lane. This proves the
// non-Node lane can reach draft-PR evidence, but it is not a broad corpus pass.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL,
  buildCodexOAuthCommand,
  startCodexOAuthProxy
} from '../../packages/agent-adapters/dist/index.js';
import {
  shouldPruneUatTmp,
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';
import { tokenBudgetCliArgs, tokenBudgetLedger } from './token-budget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const model = process.env.VIBELOOP_UAT_MODEL || 'gpt-5.5';
const reasoningEffort = process.env.VIBELOOP_UAT_REASONING_EFFORT || 'xhigh';
const owner = process.env.VIBELOOP_UAT_GITHUB_OWNER || 'coreline-ai';
const keepRemote = process.env.VIBELOOP_UAT_KEEP_REMOTE === '1';
const pruneTmp = shouldPruneUatTmp();
const HIDDEN = 'SECRET_HIDDEN_EXPECTATION';

function run(command, args, options = {}) {
  return new Promise((resolve) => {
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
    child.on('error', (error) => {
      resolve({ code: null, stdout, stderr: error.message, spawnError: true });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, spawnError: false });
    });
  });
}

async function git(cwd, args) {
  const result = await run('git', args, { cwd });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout;
}

function blocked(reason, details = {}) {
  console.log(JSON.stringify({ status: 'blocked', reason, ...details }, null, 2));
  process.exitCode = 20;
}

function parseCliJson(stdout) {
  const index = stdout.indexOf('{');
  if (index < 0) throw new Error(`no JSON: ${stdout.slice(0, 300)}`);
  return JSON.parse(stdout.slice(index));
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(
      /(access_token|refresh_token|api_key|OPENAI_API_KEY|GITHUB_TOKEN|password)\s*[:=]\s*[^\s"']+/gi,
      '$1=[REDACTED]'
    )
    .replaceAll(HIDDEN, '[REDACTED_HIDDEN]');
}

async function writePythonScenario(localRepo) {
  const files = {
    'README.md': [
      '# Python Cart Quantity Scenario',
      '',
      'A small stdlib-only Python project with a cart line-total bug.',
      'Missing quantity means 1, and quantity 0 is a valid zero total.',
      ''
    ].join('\n'),
    'src/cart.py': ['def line_total(item):', '    return item["price"]', ''].join(
      '\n'
    ),
    'tests/test_cart_base.py': [
      'import sys',
      "sys.path.insert(0, 'src')",
      'from cart import line_total',
      '',
      'assert line_total({"price": 7, "quantity": 1}) == 7',
      'assert line_total({"price": 7}) == 7',
      ''
    ].join('\n'),
    'hidden/cart_mixed_quantities.hidden.py': [
      'import sys',
      "sys.path.insert(0, 'src')",
      'from cart import line_total',
      '',
      'assert line_total({"price": 7, "quantity": 2}) == 14',
      'assert line_total({"price": 5, "quantity": 0}) == 0',
      'assert line_total({"price": 3}) == 3',
      ''
    ].join('\n'),
    'task.yaml': [
      "schema_version: '1.0'",
      'id: real-user-python-cart-quantity',
      'title: Python cart line total respects item quantity',
      'objective: Fix the Python cart line total so item quantity is included, missing quantity defaults to 1, quantity 0 is valid, and add a regression test that fails on the base commit and passes on the candidate.',
      'base_branch: main',
      'risk_area: none',
      'write_scope:',
      '  allowed:',
      '    - src/',
      '    - tests/',
      'required_evidence:',
      '  - adds_regression_test',
      'acceptance:',
      '  required_tests:',
      '    - python3 tests/test_cart_quantity.py',
      'limits:',
      '  max_changed_files: 6',
      '  max_changed_lines: 160',
      '  agent_timeout_seconds: 120',
      ''
    ].join('\n'),
    'eval.yaml': [
      "schema_version: '1.0'",
      'project: real-user-python-cart-quantity',
      'protected_paths:',
      '  - .env',
      '  - .env.*',
      '  - eval.yaml',
      'risk_classification:',
      '  none:',
      '    - src/',
      '    - tests/',
      'limits:',
      '  max_changed_files: 6',
      '  max_changed_lines: 160',
      '  agent_timeout_seconds: 120',
      'test_integrity:',
      '  forbidden_patterns:',
      '    - test.skip',
      '    - pytest.mark.skip',
      '    - unittest.skip',
      '  suspicious_patterns:',
      '    - assert True',
      'evaluator:',
      '  min_evidence_present: 1',
      '  max_changed_files: 6',
      '  max_changed_lines: 160',
      '  forbid_protected: true',
      '  target_paths:',
      '    - src/cart.py',
      'execution:',
      '  isolation: none',
      'hidden_acceptance:',
      '  tests:',
      '    - name: hidden_python_cart_mixed_quantities',
      '      source_path: hidden/cart_mixed_quantities.hidden.py',
      '      target_path: tests/hidden/test_cart_mixed_quantities.py',
      'gates:',
      '  - name: git_meta_integrity',
      '    type: integrity',
      '    command: builtin:git-meta-integrity',
      '    required: true',
      '  - name: protected_files',
      '    type: scope',
      '    command: builtin:protected-files',
      '    required: true',
      '  - name: diff_scope',
      '    type: scope',
      '    command: builtin:diff-scope',
      '    required: true',
      '  - name: limits',
      '    type: integrity',
      '    command: builtin:limits',
      '    required: true',
      '  - name: test_integrity',
      '    type: integrity',
      '    command: builtin:test-integrity',
      '    required: true',
      '  - name: visible_python_cart_regression',
      '    type: task_acceptance',
      '    command: python3 tests/test_cart_quantity.py',
      '    required: true',
      '  - name: hidden_python_cart_mixed_quantities',
      '    type: hidden_acceptance',
      '    group: hidden_acceptance',
      '    command: python3 tests/hidden/test_cart_mixed_quantities.py',
      '    required: true',
      ''
    ].join('\n')
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(localRepo, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

async function loadSelectedReport(output) {
  if (!output.selected_report || !existsSync(output.selected_report)) {
    return {
      selectedDecision: null,
      selectedReason: null,
      qualityMet: null,
      prCandidate: false,
      leak: false
    };
  }

  const report = JSON.parse(await readFile(output.selected_report, 'utf8'));
  const qualityPath = path.join(
    path.dirname(output.selected_report),
    'quality-report.json'
  );
  const quality = existsSync(qualityPath)
    ? JSON.parse(await readFile(qualityPath, 'utf8'))
    : null;
  const selectedDecision = report.decision ?? null;
  const selectedReason = report.decision_reasons?.[0]?.code ?? null;
  return {
    selectedDecision,
    selectedReason,
    qualityMet: quality ? quality.met : null,
    prCandidate:
      !!output.selected_candidate_id &&
      selectedDecision === 'accept' &&
      selectedReason === 'ALL_PASS' &&
      quality?.met === true &&
      quality?.status !== 'fail',
    leak: JSON.stringify(report).includes(HIDDEN)
  };
}

async function verifyDraftPr({ fullRepo, prUrl, branch, expectedFiles }) {
  if (!prUrl || prUrl.startsWith('pr_create_failed:')) {
    return { confirmed: false, reason: prUrl ?? 'missing_pr_url' };
  }

  const view = await run('gh', [
    'pr',
    'view',
    prUrl,
    '--repo',
    fullRepo,
    '--json',
    'url,state,isDraft,headRefName,baseRefName,files'
  ]);
  if (view.code !== 0) {
    return { confirmed: false, reason: view.stderr.trim() };
  }

  const parsed = JSON.parse(view.stdout);
  const files = Array.isArray(parsed.files)
    ? parsed.files.map((file) => file.path).sort()
    : [];
  const expected = [...expectedFiles].sort();
  const filesMatch = JSON.stringify(files) === JSON.stringify(expected);
  const confirmed =
    parsed.url === prUrl &&
    parsed.state === 'OPEN' &&
    parsed.isDraft === true &&
    parsed.headRefName === branch &&
    parsed.baseRefName === 'main' &&
    filesMatch;
  return {
    confirmed,
    url: parsed.url,
    state: parsed.state,
    is_draft: parsed.isDraft,
    head_ref: parsed.headRefName,
    base_ref: parsed.baseRefName,
    files,
    files_match: filesMatch,
    expected_files: expected
  };
}

async function main() {
  if ((await run('codex', ['--version'])).code !== 0) {
    return blocked('CODEX_CLI_NOT_AVAILABLE');
  }
  const login = await run('codex', [
    '-c',
    'service_tier=fast',
    'login',
    'status'
  ]);
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
  if ((await run('python3', ['--version'])).code !== 0) {
    return blocked('PYTHON3_NOT_AVAILABLE');
  }

  const tag = `${process.pid}-${Date.now()}`;
  const repoName = `vibeloop-python-live-${tag}`;
  const fullRepo = `${owner}/${repoName}`;
  const tmpRoot = await mkdtemp(path.join(os.homedir(), '.vibeloop-python-live-'));
  const dataDir = path.join(tmpRoot, 'data');
  const localRepo = path.join(tmpRoot, 'project');
  await mkdir(dataDir, { recursive: true });
  await mkdir(localRepo, { recursive: true });

  let proxy;
  try {
    await writePythonScenario(localRepo);
    await git(localRepo, ['init', '-b', 'main']);
    await git(localRepo, ['config', 'user.email', 'realuser-python@example.test']);
    await git(localRepo, ['config', 'user.name', 'VibeLoop Python Real User']);
    await git(localRepo, ['add', '-A']);
    await git(localRepo, [
      'commit',
      '-m',
      'seed: python cart quantity bug + base test'
    ]);
    const baseCommit = (await git(localRepo, ['rev-parse', 'HEAD'])).trim();

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
      return blocked('GH_REPO_CREATE_FAILED', {
        stderr: created.stderr.trim()
      });
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
    const tokenBudgetArgs = tokenBudgetCliArgs(proxy.baseUrl);

    const cli = await run(process.execPath, [
      path.join(repoRoot, 'packages/cli/bin/vibeloop'),
      '--data-dir',
      dataDir,
      'improve',
      '--repo',
      localRepo,
      '--task',
      path.join(localRepo, 'task.yaml'),
      '--eval',
      path.join(localRepo, 'eval.yaml'),
      '--agent',
      agentSpec,
      '--challenger',
      agentSpec,
      '--project-id',
      'python-realuser-live',
      '--loop-id',
      `python-realuser-live-${tag}`,
      '--base-commit',
      baseCommit,
      ...tokenBudgetArgs,
      '--skip-dependency-install'
    ]);
    await writeFile(path.join(tmpRoot, 'improve.stdout.log'), redact(cli.stdout));
    await writeFile(path.join(tmpRoot, 'improve.stderr.log'), redact(cli.stderr));
    const out = parseCliJson(cli.stdout);
    const selectionOutput =
      out.selection_report && existsSync(out.selection_report)
        ? JSON.parse(await readFile(out.selection_report, 'utf8'))
        : null;
    const selected = await loadSelectedReport(out);

    let prUrl = null;
    let branch = null;
    const expectedPrFiles = ['src/cart.py', 'tests/test_cart_quantity.py'];
    if (selected.prCandidate && out.selected_patch && existsSync(out.selected_patch)) {
      branch = `pr-candidate/python-cart-quantity-${tag}`;
      await git(localRepo, ['checkout', '-b', branch, baseCommit]);
      await git(localRepo, ['apply', out.selected_patch]);
      await git(localRepo, ['add', '-A']);
      await git(localRepo, [
        'commit',
        '-m',
        'vibeloop: real-codex verified fix (python cart quantity)'
      ]);
      await git(localRepo, ['push', '-u', 'origin', branch]);
      const pr = await run('gh', [
        'pr',
        'create',
        '--repo',
        fullRepo,
        '--draft',
        '--base',
        'main',
        '--head',
        branch,
        '--title',
        '[VibeLoop] real-codex verified fix: Python cart quantity',
        '--body',
        `Generated by a real Codex (${model}) builder and selected by the deterministic Arbiter.\nVerified: accept / ALL_PASS / qualified, including Python hidden acceptance. Opened by repo-matrix-python-codex-live-uat.`
      ]);
      prUrl =
        pr.code === 0
          ? pr.stdout.trim()
          : `pr_create_failed: ${pr.stderr.trim()}`;
    }

    const prVerification = await verifyDraftPr({
      fullRepo,
      prUrl,
      branch,
      expectedFiles: expectedPrFiles
    });
    const mainHead = (
      await git(localRepo, ['ls-remote', 'origin', 'refs/heads/main'])
    )
      .trim()
      .split(/\s+/)[0];
    const mainUnchanged = mainHead === baseCommit;
    const status =
      selected.prCandidate && prVerification.confirmed && mainUnchanged
        ? 'PYTHON_LIVE_REPRESENTATIVE_PASS'
        : 'PYTHON_LIVE_REPRESENTATIVE_NO_PR';

    const ledger = {
      status,
      scenario: 'repo-matrix-python-codex-live-uat',
      mode: 'representative repo-diversity live cell (python stdlib)',
      scope:
        'controlled single Python repo; not a broad product-level corpus pass',
      builder: { real_llm: true, model, via: 'chatgpt-oauth-proxy' },
      token_budget: tokenBudgetLedger(),
      github: {
        repo: fullRepo,
        url: `https://github.com/${fullRepo}`,
        seeded_buggy_base: true,
        base_commit: baseCommit,
        pr_url: prUrl,
        branch,
        draft_pr_verified: prVerification.confirmed,
        main_unchanged: mainUnchanged
      },
      selected_candidate_id: out.selected_candidate_id ?? null,
      candidate_count: out.candidate_count ?? null,
      accepted_count: out.accepted_count ?? null,
      selected_decision: selected.selectedDecision,
      selected_reason: selected.selectedReason,
      quality_met: selected.qualityMet,
      pr_candidate: selected.prCandidate,
      final_verification: out.final_verification ?? null,
      limits: out.limits ?? null,
      advisory_tie_break: out.advisory_tie_break ?? null,
      expected_pr_files: expectedPrFiles,
      draft_pr_view: prVerification,
      false_pass: 0,
      leak: selected.leak ? 1 : 0,
      cli_exit: cli.code,
      proxy_auth_header_seen: proxy?.stats?.auth_header_seen ?? null,
      evidence: {
        selection_report: out.selection_report,
        selected_report: out.selected_report,
        tmp_root: tmpRoot
      }
    };

    const evidenceBundle = await writeUatEvidenceBundle({
      scenario: ledger.scenario,
      runId: `python-realuser-live-${tag}`,
      tmpRoot,
      dataDir,
      outputs: selectionOutput ? [selectionOutput] : [],
      output: out,
      proxyStats: proxy?.stats,
      extraFiles: [
        { label: 'improve_stdout', path: path.join(tmpRoot, 'improve.stdout.log') },
        { label: 'improve_stderr', path: path.join(tmpRoot, 'improve.stderr.log') }
      ],
      extraJson: {
        github: ledger.github,
        draft_pr_view: prVerification,
        verification: {
          pr_candidate: selected.prCandidate,
          selected_decision: selected.selectedDecision,
          selected_reason: selected.selectedReason,
          quality_met: selected.qualityMet,
          draft_pr_verified: prVerification.confirmed,
          main_unchanged: mainUnchanged
        }
      }
    });
    ledger.evidence = {
      ...ledger.evidence,
      evidence_bundle: evidenceBundle.bundle_dir,
      evidence_manifest: evidenceBundle.manifest_path,
      evidence_ledger: path.join(evidenceBundle.bundle_dir, 'ledger.json'),
      evidence_copied_count: evidenceBundle.copied_count,
      evidence_missing_count: evidenceBundle.missing_count,
      tmp_prune_requested: pruneTmp
    };
    await writeUatEvidenceLedger(evidenceBundle, ledger);
    if (JSON.stringify(ledger).includes(HIDDEN)) {
      throw new Error('hidden sentinel leaked to output');
    }
    console.log(JSON.stringify(ledger, null, 2));
    if (status !== 'PYTHON_LIVE_REPRESENTATIVE_PASS') process.exitCode = 1;
  } finally {
    if (proxy) await proxy.close().catch(() => undefined);
    if (!keepRemote) {
      const deleted = await run('gh', ['repo', 'delete', fullRepo, '--yes']);
      if (deleted.code !== 0) {
        await run('gh', ['repo', 'archive', fullRepo, '--yes']);
      }
    }
    if (pruneTmp) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
