#!/usr/bin/env node
import { mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const ADVERSARY_LIVE_CODEX_REVIEWER_VERSION =
  'adversary-live.codex-reviewer.v1';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dryRun: false,
    live: false,
    printCommand: false,
    model: process.env.VIBELOOP_ADVERSARY_LIVE_REVIEWER_MODEL || 'gpt-5.5',
    timeoutMs: Number(
      process.env.VIBELOOP_ADVERSARY_LIVE_REVIEWER_TIMEOUT_MS || 180_000
    )
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--live') {
      args.live = true;
      continue;
    }
    if (arg === '--print-command') {
      args.printCommand = true;
      continue;
    }
    if (arg === '--model') {
      const value = argv[index + 1];
      if (!value) throw new Error('--model requires a value');
      args.model = value;
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--timeout-ms requires a positive number');
      }
      args.timeoutMs = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

export function buildAdversaryLiveReviewerPrompt(input) {
  const reviewerPrompt =
    input?.reviewer_context?.prompt ??
    'You are an adversarial advisory reviewer for a VibeLoop candidate patch.';
  return [
    reviewerPrompt,
    '',
    `Wrapper: ${ADVERSARY_LIVE_CODEX_REVIEWER_VERSION}`,
    'Return exactly one JSON object and no markdown fences.',
    'JSON schema: {"findings":[{"severity":"medium","message":"..."}],"proposals":[{"id":"...","targetPath":"tests/adversary/name.test.cjs","body":"...","expectation":"fail_to_pass"}]}',
    'All proposals are advisory-only and must have expectation "fail_to_pass".',
    'Do not decide pass/fail, merge readiness, or current-loop acceptance.',
    'Do not use hidden tests, hidden sentinels, secrets, OAuth tokens, API keys, snapshots, or builder transcripts.',
    'Do not weaken tests, skip tests, use test.only, fake assertions, or require network access.',
    '',
    'For this adversary-live lane, propose at least one plain Node.js test file under tests/adversary/.',
    'The test must run with: node <targetPath>. Do not use Jest/Vitest globals.',
    'The selected patch changes src/cart.cjs lineTotal from returning item.price to quantity-aware subtotal, discount, tax, and cent rounding semantics.',
    'The candidate formula is: subtotal = item.price * (item.quantity ?? 1) - (item.discount ?? 0); total = subtotal * (1 + (item.taxRate ?? 0)); expected = Math.round((total + Number.EPSILON) * 100) / 100.',
    'The selected patch also changes src/profile.cjs canViewProfile from always-true to suspended/public/private/adminOnly visibility semantics.',
    'A useful proposal should exercise cart semantics, including quantity > 1, quantity: 0, discount, tax, or cent rounding, or profile visibility semantics including suspended profiles, private owner/admin, and adminOnly, so the buggy base fails and the selected candidate passes.',
    'Use simple values whose expected outputs you calculate exactly from that formula; avoid hard-to-verify decimal combinations unless you have checked the rounded cent result.',
    'The test body should require "../../src/cart.cjs" or "../../src/profile.cjs" from tests/adversary/ and exit nonzero on mismatch.',
    '',
    '<adversary_review_input_json>',
    JSON.stringify(input, null, 2),
    '</adversary_review_input_json>'
  ].join('\n');
}

function parseJsonObject(text) {
  const input = String(text);
  for (
    let start = input.indexOf('{');
    start >= 0;
    start = input.indexOf('{', start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < input.length; index += 1) {
      const char = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) return JSON.parse(input.slice(start, index + 1));
      }
    }
  }
  throw new Error('Codex adversary reviewer did not return a JSON object');
}

function dryRunReview() {
  return {
    findings: [
      {
        severity: 'medium',
        message:
          'Dry-run reviewer fixture for cart quantity semantics; not real LLM evidence.',
        suggested_test_id: 'dry-run-cart-quantity-semantic'
      }
    ],
    proposals: [
      {
        id: 'dry-run-cart-quantity-semantic',
        targetPath: 'tests/adversary/cart-quantity-semantic.test.cjs',
        body: [
          "const { lineTotal } = require('../../src/cart.cjs');",
          'const cases = [',
          '  [{ price: 4, quantity: 3 }, 12],',
          '  [{ price: 7 }, 7],',
          '  [{ price: 9, quantity: 0 }, 0]',
          '];',
          'for (const [item, expected] of cases) {',
          '  const actual = lineTotal(item);',
          '  if (actual !== expected) {',
          '    console.error(`expected ${expected}, got ${actual}`);',
          '    process.exit(1);',
          '  }',
          '}',
          ''
        ].join('\n'),
        expectation: 'fail_to_pass',
        authority: 'advisory_only',
        decision_impact: 'none'
      }
    ]
  };
}

export function buildAdversaryLiveCodexReviewerArgs(options = {}) {
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '-c',
    'service_tier=fast',
    '-c',
    'approval_policy=never',
    '--model',
    options.model,
    '--output-last-message',
    options.outputFile,
    '-'
  ];
}

async function runCodexReviewer(prompt, options = {}) {
  const tmp = await mkdtemp(
    path.join(os.tmpdir(), 'adversary-live-codex-reviewer-')
  );
  const outputFile = path.join(tmp, 'last-message.txt');
  return new Promise((resolve) => {
    const codex = process.env.VIBELOOP_ADVERSARY_LIVE_CODEX_BIN || 'codex';
    const args = buildAdversaryLiveCodexReviewerArgs({
      ...options,
      outputFile
    });
    const child = spawn(codex, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(process.env.VIBELOOP_ADVERSARY_LIVE_REVIEWER_CODEX_HOME
          ? {
              CODEX_HOME:
                process.env.VIBELOOP_ADVERSARY_LIVE_REVIEWER_CODEX_HOME
            }
          : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
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
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim()
      });
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      let lastMessage = '';
      try {
        lastMessage = await readFile(outputFile, 'utf8');
      } catch {
        // Keep empty; parse failure will explain.
      }
      resolve({ ok: code === 0, code, stdout, stderr, lastMessage });
    });
    child.stdin.end(prompt);
  });
}

export async function runAdversaryLiveCodexReviewer(options = {}) {
  const rawInput = options.stdinText ?? (await readStdin());
  const input = rawInput ? JSON.parse(rawInput) : {};
  if (options.dryRun) {
    return {
      status: 'ADVERSARY_LIVE_CODEX_REVIEWER_DRY_RUN',
      real_llm: false,
      prompt_version: input?.reviewer_context?.prompt_version ?? null,
      review: dryRunReview()
    };
  }
  if (!options.live) {
    return {
      status: 'ADVERSARY_LIVE_CODEX_REVIEWER_BLOCKED',
      real_llm: false,
      reason: 'LIVE_FLAG_REQUIRED',
      next_step:
        'Use --live only when this wrapper is intentionally configured as VIBELOOP_ADVERSARY_REVIEWER_COMMAND.'
    };
  }
  const prompt = buildAdversaryLiveReviewerPrompt(input);
  const result = await runCodexReviewer(prompt, options);
  if (!result.ok) {
    return {
      status: 'ADVERSARY_LIVE_CODEX_REVIEWER_FAIL',
      real_llm: true,
      exit_code: result.code,
      stderr: result.stderr,
      stdout: result.stdout
    };
  }
  return {
    status: 'ADVERSARY_LIVE_CODEX_REVIEWER_PASS',
    real_llm: true,
    prompt_version: input?.reviewer_context?.prompt_version ?? null,
    review: parseJsonObject(result.lastMessage || result.stdout)
  };
}

async function main() {
  const args = parseArgs();
  if (args.printCommand) {
    console.log(`node ${process.argv[1]} --live --model ${args.model}`);
    return;
  }
  const report = await runAdversaryLiveCodexReviewer(args);
  if (report.review) {
    console.log(JSON.stringify(report.review, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status.endsWith('_BLOCKED') ? 20 : 1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
