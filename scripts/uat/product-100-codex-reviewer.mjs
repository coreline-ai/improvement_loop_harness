#!/usr/bin/env node
import { mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  PRODUCT_100_REVIEWER_PROMPT_VERSION,
  buildProduct100ReviewerContext
} from './product-100-adversary.mjs';

export const PRODUCT_100_CODEX_REVIEWER_VERSION =
  'product-100.codex-reviewer.v1';

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    dryRun: false,
    live: false,
    printCommand: false,
    model: process.env.VIBELOOP_PRODUCT_100_REVIEWER_MODEL || 'gpt-5.5',
    timeoutMs: Number(process.env.VIBELOOP_PRODUCT_100_REVIEWER_TIMEOUT_MS || 180_000)
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

export function buildProduct100ReviewerPrompt(input) {
  const context = buildProduct100ReviewerContext();
  return [
    context.prompt,
    '',
    'You must inspect only the public task/eval summary and selected patch below.',
    'Return exactly one JSON object and no markdown fences.',
    'JSON schema: {"findings":[],"proposals":[{"id":"...","targetPath":"tests/adversary/name.test.cjs","body":"...","expectation":"fail_to_pass"}]}',
    'All targetPath values must stay under tests/adversary/.',
    'Never include hidden markers, secrets, OAuth tokens, raw hidden tests, or builder transcripts.',
    'Do not ask for current-loop accept/reject authority; proposals are advisory-only.',
    '',
    '<product_100_reviewer_input_json>',
    JSON.stringify(input, null, 2),
    '</product_100_reviewer_input_json>'
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
  throw new Error('Codex reviewer did not return a JSON object');
}

function dryRunReview() {
  return {
    findings: [
      {
        id: 'dry-run-edge-review',
        severity: 'info',
        summary: 'Dry-run reviewer fixture; not real LLM evidence.'
      }
    ],
    proposals: [
      {
        id: 'dry-run-visible-edge',
        targetPath: 'tests/adversary/dry-run-visible-edge.test.cjs',
        body: "const assert = require('node:assert/strict');\nassert.equal(2 + 2, 4);\n",
        expectation: 'fail_to_pass',
        authority: 'advisory_only',
        decision_impact: 'none'
      }
    ]
  };
}

export function buildProduct100CodexReviewerArgs(options = {}) {
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
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'product-100-codex-reviewer-'));
  const outputFile = path.join(tmp, 'last-message.txt');
  return new Promise((resolve) => {
    const codex = process.env.VIBELOOP_PRODUCT_100_CODEX_BIN || 'codex';
    const args = buildProduct100CodexReviewerArgs({
      ...options,
      outputFile
    });
    const child = spawn(codex, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(process.env.VIBELOOP_PRODUCT_100_REVIEWER_CODEX_HOME
          ? { CODEX_HOME: process.env.VIBELOOP_PRODUCT_100_REVIEWER_CODEX_HOME }
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
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}`.trim() });
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

export async function runProduct100CodexReviewer(options = {}) {
  const rawInput = options.stdinText ?? (await readStdin());
  const input = rawInput ? JSON.parse(rawInput) : {};
  if (options.dryRun) {
    return {
      status: 'PRODUCT_100_CODEX_REVIEWER_DRY_RUN',
      real_llm: false,
      prompt_version: PRODUCT_100_REVIEWER_PROMPT_VERSION,
      review: dryRunReview()
    };
  }
  if (!options.live) {
    return {
      status: 'PRODUCT_100_CODEX_REVIEWER_BLOCKED',
      real_llm: false,
      reason: 'LIVE_FLAG_REQUIRED',
      next_step:
        'Use --live only when this wrapper is intentionally configured as VIBELOOP_ADVERSARY_REVIEWER_COMMAND.'
    };
  }
  const prompt = buildProduct100ReviewerPrompt(input);
  const result = await runCodexReviewer(prompt, options);
  if (!result.ok) {
    return {
      status: 'PRODUCT_100_CODEX_REVIEWER_FAIL',
      real_llm: true,
      exit_code: result.code,
      stderr: result.stderr,
      stdout: result.stdout
    };
  }
  return {
    status: 'PRODUCT_100_CODEX_REVIEWER_PASS',
    real_llm: true,
    prompt_version: PRODUCT_100_REVIEWER_PROMPT_VERSION,
    prompt_hash: buildProduct100ReviewerContext().prompt_hash,
    review: parseJsonObject(result.lastMessage || result.stdout)
  };
}

async function main() {
  const args = parseArgs();
  if (args.printCommand) {
    console.log(`node ${process.argv[1]} --live --model ${args.model}`);
    return;
  }
  const report = await runProduct100CodexReviewer(args);
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
