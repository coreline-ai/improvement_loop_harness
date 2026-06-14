#!/usr/bin/env node
// Live Skill-prompt UAT for the natural-language Skill/LLM layer.
//
// This is intentionally narrower than full GitHub RU-3 / full-improvement UAT:
//   - REAL top-level Codex CLI session = the Skill orchestrator.
//   - The Codex session must read SKILL.md and invoke run-from-prompt.mjs.
//   - The underlying builder defaults to a deterministic command fixture to
//     isolate Skill routing, but VIBELOOP_SKILL_PROMPT_UAT_BUILDER=codex uses a
//     real Codex builder through the ChatGPT OAuth proxy in the same run.
//
// Modes:
//   VIBELOOP_SKILL_PROMPT_UAT_MODE=user_issue      (default, RU-0.5/RU-0.7)
//   VIBELOOP_SKILL_PROMPT_UAT_MODE=auto_discovery  (RU-0.6/RU-0.8)
//   VIBELOOP_SKILL_PROMPT_UAT_BUILDER=fixture|codex
//
// Honest scope: PASS here proves Skill-layer live invocation + deterministic
// helper execution. With BUILDER=codex it also proves real builder invocation,
// but still only local branch / one-candidate evidence — not GitHub RU-3 and
// not full autonomous improvement PASS.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
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
const skillFile = path.join(repoRoot, 'skills/vibeloop-harness/SKILL.md');
const promptRunner = path.join(
  repoRoot,
  'skills/vibeloop-harness/scripts/run-from-prompt.mjs'
);
const scenarioRoot = path.join(
  repoRoot,
  'tests/e2e/user-scenarios/cart-quantity'
);
const targetTemplate = path.join(scenarioRoot, 'target-template');
const fixtureAgent = path.join(scenarioRoot, 'agent-fix.cjs');
const builderMode = process.env.VIBELOOP_SKILL_PROMPT_UAT_BUILDER ?? 'fixture';
const model = process.env.VIBELOOP_SKILL_PROMPT_UAT_MODEL;
const builderModel = process.env.VIBELOOP_UAT_MODEL || 'gpt-5.5';
const builderReasoningEffort =
  process.env.VIBELOOP_UAT_REASONING_EFFORT || 'xhigh';
const timeoutMs = Number(
  process.env.VIBELOOP_SKILL_PROMPT_UAT_TIMEOUT_MS ?? 10 * 60 * 1000
);
const keepTmp = process.env.VIBELOOP_UAT_KEEP_TMP === '1';
const requestedMode =
  process.env.VIBELOOP_SKILL_PROMPT_UAT_MODE ?? 'user_issue';
const hiddenSentinel = 'SECRET_HIDDEN_EXPECTATION';

const scenarios = {
  user_issue: {
    ledgerPassStatus: 'SKILL_PROMPT_LIVE_UAT_PASS',
    modeLabel: 'natural-language user_issue via live Codex Skill orchestrator',
    defaultPrompt:
      'src/cart.cjs quantity 버그를 고쳐줘. quantity를 곱해서 합계를 계산하고 회귀 테스트도 추가해.',
    expectedHelperMode: 'user_issue',
    expectedCommandKind: 'vibeloop_improve',
    projectId: 'skill-prompt-live',
    loopPrefix: 'skill-prompt-live',
    promotionBranch: 'pr-candidate/skill-prompt-uat',
    promotionFlag: '--promote-commit-message',
    promotionMessage: 'vibeloop: skill prompt UAT selected patch',
    finalStatus: 'SKILL_PROMPT_UAT_PASS',
    setupPackageJson: false,
    extraHelperArgs: [],
    proofLabel: 'user_issue Skill routing',
    limitations: [
      'top-level Codex Skill orchestrator is live',
      builderMode === 'codex'
        ? 'underlying builder is real Codex via ChatGPT OAuth proxy'
        : 'underlying builder is deterministic command fixture in this lane',
      'not RU-3 auto-discovery and not full autonomous improvement PASS'
    ]
  },
  auto_discovery: {
    ledgerPassStatus: 'SKILL_PROMPT_AUTO_DISCOVERY_LIVE_UAT_PASS',
    modeLabel:
      'natural-language auto_discovery via live Codex Skill orchestrator',
    defaultPrompt: '자동으로 문제 찾아서 하나씩 수정하고 검증 PR 후보 만들어줘',
    expectedHelperMode: 'auto_discovery',
    expectedCommandKind: 'vibeloop_orchestrate',
    projectId: 'skill-prompt-auto-live',
    loopPrefix: 'skill-prompt-auto-live',
    promotionBranch: 'pr-candidate/skill-prompt-auto-uat',
    promotionFlag: '--promote-commit-message-prefix',
    promotionMessage: 'vibeloop skill prompt auto',
    finalStatus: 'SKILL_PROMPT_AUTO_DISCOVERY_UAT_PASS',
    setupPackageJson: true,
    extraHelperArgs: ['--max-issues', '1', '--max-candidates', '1'],
    proofLabel: 'auto_discovery Skill routing',
    limitations: [
      'top-level Codex Skill orchestrator is live',
      builderMode === 'codex'
        ? 'underlying builder is real Codex via ChatGPT OAuth proxy'
        : 'underlying builder is deterministic command fixture in this lane',
      'local auto-discovery promotion only; no GitHub draft PR in this lane',
      'not full autonomous improvement PASS'
    ]
  }
};

const scenario = scenarios[requestedMode];
if (!scenario) {
  throw new Error(
    `unsupported VIBELOOP_SKILL_PROMPT_UAT_MODE=${requestedMode}; expected user_issue or auto_discovery`
  );
}
if (!['fixture', 'codex'].includes(builderMode)) {
  throw new Error(
    `unsupported VIBELOOP_SKILL_PROMPT_UAT_BUILDER=${builderMode}; expected fixture or codex`
  );
}
const userPrompt =
  process.env.VIBELOOP_SKILL_PROMPT_UAT_PROMPT ?? scenario.defaultPrompt;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2500).unref();
    }, options.timeoutMs ?? timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

async function git(cwd, args) {
  const result = await run('git', args, { cwd, timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
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

function blocked(reason, details = {}) {
  console.log(
    JSON.stringify(
      {
        status: 'blocked',
        scenario: 'skill-real-user-codex-skill-prompt-uat',
        mode: requestedMode,
        reason,
        ...details
      },
      null,
      2
    )
  );
  process.exitCode = 20;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function printableCommand(parts) {
  return parts.map(shellQuote).join(' ');
}

async function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeOutputSchema(file) {
  await writeFile(
    file,
    JSON.stringify(
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'status',
          'skill_file_read',
          'skill_name',
          'helper_invoked',
          'helper_result_path',
          'helper_mode',
          'helper_command_kind',
          'pr_candidate',
          'notes',
          'limitations'
        ],
        properties: {
          status: {
            type: 'string',
            enum: [scenario.finalStatus, 'SKILL_PROMPT_UAT_FAIL']
          },
          skill_file_read: { type: 'boolean' },
          skill_name: { type: 'string' },
          helper_invoked: { type: 'boolean' },
          helper_result_path: { type: 'string' },
          helper_mode: { type: 'string' },
          helper_command_kind: { type: 'string' },
          pr_candidate: { type: 'boolean' },
          notes: { type: 'string' },
          limitations: { type: 'array', items: { type: 'string' } }
        }
      },
      null,
      2
    )
  );
}

function parseFinalJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function selectedIssue(parsed) {
  return Array.isArray(parsed?.issues) ? parsed.issues[0] : null;
}

function selectedCandidateId(helper) {
  const parsed = helper?.execution?.parsed;
  return (
    parsed?.selected_candidate_id ??
    selectedIssue(parsed)?.selected_candidate_id ??
    null
  );
}

function finalVerification(helper) {
  const parsed = helper?.execution?.parsed;
  return (
    parsed?.final_verification ??
    selectedIssue(parsed)?.final_verification ??
    null
  );
}

function promotion(helper) {
  const parsed = helper?.execution?.parsed;
  return (
    parsed?.promotion ??
    selectedIssue(parsed)?.promotion ??
    parsed?.cumulative_promotion ??
    null
  );
}

function prCandidate(helper) {
  const parsed = helper?.execution?.parsed;
  if (scenario.expectedHelperMode === 'auto_discovery') {
    return (
      parsed?.pr_candidates === 1 &&
      selectedIssue(parsed)?.pr_candidate === true
    );
  }
  return parsed?.pr_candidate === true;
}

function passReasons({
  codexResult,
  helper,
  finalMessage,
  helperStat,
  startedAt
}) {
  const parsed = helper?.execution?.parsed;
  const currentPromotion = promotion(helper);
  const reasons = [];
  if (codexResult.code !== 0) reasons.push(`codex_exit_${codexResult.code}`);
  if (!helper) reasons.push('helper_result_missing_or_invalid');
  if (helperStat && helperStat.mtimeMs < startedAt) {
    reasons.push('helper_result_not_created_by_this_run');
  }
  if (helper?.mode !== scenario.expectedHelperMode) {
    reasons.push(`helper_mode_not_${scenario.expectedHelperMode}`);
  }
  if (helper?.command?.kind !== scenario.expectedCommandKind) {
    reasons.push(`helper_command_not_${scenario.expectedCommandKind}`);
  }
  if (helper?.executed !== true) reasons.push('helper_not_executed');
  if (helper?.execution?.code !== 0) reasons.push('helper_execution_nonzero');
  if (!selectedCandidateId(helper)) reasons.push('no_selected_candidate');
  if (!prCandidate(helper)) reasons.push('not_pr_candidate');
  if (finalVerification(helper)?.passed !== true) {
    reasons.push('final_reverify_not_passed');
  }
  if (currentPromotion?.branch_name !== scenario.promotionBranch) {
    reasons.push('promotion_branch_missing');
  }
  if (scenario.expectedHelperMode === 'auto_discovery') {
    if (parsed?.mode !== 'auto') reasons.push('orchestrate_mode_not_auto');
    if (parsed?.processed !== 1) reasons.push('orchestrate_processed_not_1');
    if (parsed?.cumulative_promotion?.applied_issue_count !== 1) {
      reasons.push('cumulative_promotion_count_not_1');
    }
    if (parsed?.cumulative_promotion?.rediscovery_after_each_fix !== true) {
      reasons.push('rediscovery_not_recorded');
    }
  }
  if (finalMessage?.skill_file_read !== true) {
    reasons.push('codex_final_did_not_report_skill_read');
  }
  if (finalMessage?.skill_name !== 'vibeloop-harness') {
    reasons.push('codex_final_skill_name_mismatch');
  }
  if (finalMessage?.helper_invoked !== true) {
    reasons.push('codex_final_did_not_report_helper_invoked');
  }
  return reasons;
}

async function prepareRepo(targetRepo) {
  await cp(targetTemplate, targetRepo, { recursive: true });
  if (scenario.setupPackageJson) {
    await writeFile(
      path.join(targetRepo, 'package.json'),
      `${JSON.stringify(
        {
          name: 'skill-prompt-auto-live-fixture',
          version: '1.0.0',
          private: true,
          type: 'commonjs',
          scripts: {
            test: 'for f in tests/*.test.cjs; do node "$f"; done'
          }
        },
        null,
        2
      )}\n`
    );
  }
  await git(targetRepo, ['init', '-b', 'main']);
  await git(targetRepo, ['config', 'user.email', 'skill-prompt@example.test']);
  await git(targetRepo, ['config', 'user.name', 'VibeLoop Skill Prompt UAT']);
  await git(targetRepo, ['add', '-A']);
  await git(targetRepo, [
    'commit',
    '-m',
    `seed: ${requestedMode} skill prompt fixture`
  ]);
  return git(targetRepo, ['rev-parse', 'HEAD']);
}

async function main() {
  if (!existsSync(skillFile)) return blocked('SKILL_FILE_NOT_FOUND');
  if (!existsSync(promptRunner)) return blocked('PROMPT_RUNNER_NOT_FOUND');
  if ((await run('codex', ['--version'], { timeoutMs: 30_000 })).code !== 0) {
    return blocked('CODEX_CLI_NOT_AVAILABLE');
  }
  const login = await run(
    'codex',
    ['-c', 'service_tier=fast', 'login', 'status'],
    { timeoutMs: 30_000 }
  );
  const loginText = `${login.stdout}${login.stderr}`;
  if (login.code !== 0 || !/Logged in/i.test(loginText)) {
    return blocked('CODEX_CHATGPT_LOGIN_NOT_AVAILABLE', {
      code: login.code,
      out: redact(loginText).trim().slice(0, 300)
    });
  }

  const tag = `${process.pid}-${Date.now()}`;
  const tmpRoot = await mkdtemp(
    path.join(os.tmpdir(), `vibeloop-skill-prompt-${requestedMode}-live-`)
  );
  const targetRepo = path.join(tmpRoot, 'target-repo');
  const dataDir = path.join(tmpRoot, 'data');
  const taskEvalDir = path.join(tmpRoot, 'task-eval');
  const helperResultPath = path.join(tmpRoot, 'helper-result.json');
  const helperStderrPath = path.join(tmpRoot, 'helper.stderr.log');
  const finalMessagePath = path.join(tmpRoot, 'codex-final.json');
  const outputSchemaPath = path.join(tmpRoot, 'codex-final.schema.json');
  const codexStdoutPath = path.join(tmpRoot, 'codex.stdout.log');
  const codexStderrPath = path.join(tmpRoot, 'codex.stderr.log');

  let pass = false;
  let proxy;
  try {
    await mkdir(dataDir, { recursive: true });
    const baseCommit = await prepareRepo(targetRepo);
    await writeOutputSchema(outputSchemaPath);

    let agentSpec = `command:node ${fixtureAgent}`;
    if (builderMode === 'codex') {
      proxy = await startCodexOAuthProxy({
        model: builderModel,
        upstreamBaseUrl:
          process.env.VIBELOOP_UAT_OAUTH_UPSTREAM_BASE_URL ||
          DEFAULT_CODEX_OAUTH_UPSTREAM_BASE_URL
      });
      agentSpec = buildCodexOAuthCommand({
        codeHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
        proxyBaseUrl: proxy.baseUrl,
        provider: 'vibeloop-oauth-proxy',
        model: builderModel,
        reasoningEffort: builderReasoningEffort,
        requiresOpenaiAuth: true
      });
    }

    const helperArgs = [
      process.execPath,
      promptRunner,
      '--execute',
      '--prompt',
      userPrompt,
      '--template',
      'node',
      '--out',
      taskEvalDir,
      '--repo',
      targetRepo,
      '--test-command',
      'node tests/cart-quantity.test.cjs',
      '--agent',
      agentSpec,
      '--data-dir',
      dataDir,
      '--project-id',
      scenario.projectId,
      '--loop-id',
      `${scenario.loopPrefix}-${tag}`,
      '--base-commit',
      baseCommit,
      '--skip-dependency-install',
      '--promote-branch',
      scenario.promotionBranch,
      scenario.promotionFlag,
      scenario.promotionMessage,
      ...scenario.extraHelperArgs
    ];
    const helperShell = `${printableCommand(helperArgs)} > ${shellQuote(
      helperResultPath
    )} 2> ${shellQuote(helperStderrPath)}`;
    const finalShape = {
      status: scenario.finalStatus,
      skill_file_read: true,
      skill_name: 'vibeloop-harness',
      helper_invoked: true,
      helper_result_path: helperResultPath,
      helper_mode: scenario.expectedHelperMode,
      helper_command_kind: scenario.expectedCommandKind,
      pr_candidate: true,
      notes: 'short note only',
      limitations: scenario.limitations
    };
    const prompt = `
You are running a VibeLoop Harness live Skill-layer UAT.

User request to route:
${userPrompt}

Mandatory actions:
1. Read this exact Skill file before doing anything else: ${skillFile}
2. Do not directly edit files in the target repo.
3. Invoke the Skill prompt runner exactly as the execution path for the user request. Use this shell command from ${repoRoot}:
${helperShell}
4. Open ${helperResultPath}, confirm it is JSON, and use it for your final answer.
5. Final answer MUST be JSON only, matching this shape:
${JSON.stringify(finalShape, null, 2)}

Target repo: ${targetRepo}
Base commit: ${baseCommit}
Acceptance authority: deterministic VibeLoop reports only.
`;

    const codexArgs = [
      '-c',
      'service_tier=fast',
      '--cd',
      repoRoot,
      '--add-dir',
      targetRepo,
      '--sandbox',
      'danger-full-access',
      '-a',
      'never',
      ...(model ? ['--model', model] : []),
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--output-schema',
      outputSchemaPath,
      '--output-last-message',
      finalMessagePath,
      '-'
    ];

    const startedAt = Date.now();
    const codexResult = await run('codex', codexArgs, {
      cwd: repoRoot,
      stdin: prompt,
      timeoutMs
    });
    await writeFile(codexStdoutPath, redact(codexResult.stdout));
    await writeFile(codexStderrPath, redact(codexResult.stderr));

    const helper = await readJsonIfExists(helperResultPath);
    const helperStat = existsSync(helperResultPath)
      ? await stat(helperResultPath)
      : null;
    const finalMessage = existsSync(finalMessagePath)
      ? parseFinalJson(await readFile(finalMessagePath, 'utf8'))
      : parseFinalJson(codexResult.stdout);
    const reasons = passReasons({
      codexResult,
      helper,
      finalMessage,
      helperStat,
      startedAt
    });
    pass = reasons.length === 0;
    const parsed = helper?.execution?.parsed ?? null;
    const firstIssue = selectedIssue(parsed);
    const currentBranch = await git(targetRepo, [
      'branch',
      '--show-current'
    ]).catch(() => null);
    const statusShort = await git(targetRepo, ['status', '--short']).catch(
      () => null
    );
    const ledger = {
      status: pass ? scenario.ledgerPassStatus : 'SKILL_PROMPT_LIVE_UAT_FAIL',
      scenario: 'skill-real-user-codex-skill-prompt-uat',
      mode: scenario.modeLabel,
      requested_mode: requestedMode,
      orchestrator: {
        real_llm: true,
        codex_cli: true,
        model: model ?? 'codex-config-default',
        skill_file: skillFile,
        reported_skill_file_read: finalMessage?.skill_file_read === true,
        reported_skill_name: finalMessage?.skill_name ?? null
      },
      builder: {
        real_llm: builderMode === 'codex',
        via: builderMode === 'codex' ? 'chatgpt-oauth-proxy' : 'command fixture',
        model: builderMode === 'codex' ? builderModel : null,
        reason:
          builderMode === 'codex'
            ? 'same run combines live Skill orchestrator with real Codex builder'
            : 'this lane isolates Skill/LLM routing; RU-1/RU-2 cover real builder Codex candidates',
        proxy_auth_header_seen:
          builderMode === 'codex' ? (proxy?.stats?.auth_header_seen ?? null) : null
      },
      helper: {
        invoked: !!helper,
        result_path: helperResultPath,
        stderr_path: helperStderrPath,
        mode: helper?.mode ?? null,
        command_kind: helper?.command?.kind ?? null,
        executed: helper?.executed ?? null,
        execution_code: helper?.execution?.code ?? null
      },
      selected_candidate_id: selectedCandidateId(helper),
      pr_candidate: prCandidate(helper),
      final_verification: finalVerification(helper),
      promotion: promotion(helper),
      auto_discovery:
        requestedMode === 'auto_discovery'
          ? {
              processed: parsed?.processed ?? null,
              pr_candidates: parsed?.pr_candidates ?? null,
              cumulative_promotion: parsed?.cumulative_promotion ?? null,
              first_issue: firstIssue
                ? {
                    issue_id: firstIssue.issue_id ?? null,
                    pr_candidate: firstIssue.pr_candidate ?? null,
                    selection_quality: firstIssue.selection_quality ?? null
                  }
                : null
            }
          : null,
      target_repo: {
        path: targetRepo,
        base_commit: baseCommit,
        current_branch: currentBranch,
        status_short: statusShort
      },
      false_pass: 0,
      leak: JSON.stringify({ helper, finalMessage }).includes(hiddenSentinel)
        ? 1
        : 0,
      failure_reasons: reasons,
      limitations: [
        `proves live Codex Skill orchestrator invokes the prompt runner for ${scenario.proofLabel}`,
        builderMode === 'codex'
          ? 'does prove a real Codex builder was invoked through the helper, but with one candidate only'
          : 'does not prove real builder model quality because this lane uses a deterministic command builder',
        ...(requestedMode === 'auto_discovery'
          ? [
              'does not prove GitHub draft PR RU-3 because promotion is local only'
            ]
          : ['does not prove auto-discovery RU-3']),
        'does not prove full autonomous improvement PASS'
      ],
      evidence: {
        tmp_root: tmpRoot,
        helper_result: helperResultPath,
        helper_stderr: helperStderrPath,
        codex_final: finalMessagePath,
        codex_stdout: codexStdoutPath,
        codex_stderr: codexStderrPath,
        selected_report:
          parsed?.selected_report ?? firstIssue?.selected_report ?? null,
        selection_report:
          parsed?.selection_report ?? firstIssue?.selection_report ?? null
      }
    };
    if (ledger.leak !== 0) {
      ledger.status = 'SKILL_PROMPT_LIVE_UAT_FAIL';
      ledger.failure_reasons.push('hidden_sentinel_leak');
      pass = false;
    }
    console.log(JSON.stringify(ledger, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    if (proxy) await proxy.close().catch(() => undefined);
    if (!keepTmp && pass) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

main().catch((error) => {
  console.error(
    redact(
      error instanceof Error ? error.stack || error.message : String(error)
    )
  );
  process.exitCode = 1;
});
