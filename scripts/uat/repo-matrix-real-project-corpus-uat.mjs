#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(REPO_ROOT, 'packages/cli/bin/vibeloop');
const READ_ONLY_SCENARIO = 'repo-matrix-real-project-corpus-uat';
const MODIFIABLE_COPY_SCENARIO =
  'repo-matrix-real-project-modifiable-corpus-uat';
const CODEX_COPY_SCENARIO = 'repo-matrix-real-project-codex-copy-uat';
const CODEX_REPAIR_SCENARIO = 'repo-matrix-real-project-codex-repair-uat';
const EXISTING_SOURCE_REPAIR_SCENARIO =
  'repo-matrix-real-project-existing-source-repair-uat';
const READ_ONLY_PASS_STATUS = 'REAL_PROJECT_CORPUS_PASS';
const READ_ONLY_FAIL_STATUS = 'REAL_PROJECT_CORPUS_FAIL';
const MODIFIABLE_COPY_PASS_STATUS = 'REAL_PROJECT_MODIFIABLE_CORPUS_PASS';
const MODIFIABLE_COPY_FAIL_STATUS = 'REAL_PROJECT_MODIFIABLE_CORPUS_FAIL';
const CODEX_COPY_PASS_STATUS = 'REAL_PROJECT_CODEX_COPY_PASS';
const CODEX_COPY_FAIL_STATUS = 'REAL_PROJECT_CODEX_COPY_FAIL';
const CODEX_REPAIR_PASS_STATUS = 'REAL_PROJECT_CODEX_REPAIR_PASS';
const CODEX_REPAIR_FAIL_STATUS = 'REAL_PROJECT_CODEX_REPAIR_FAIL';
const EXISTING_SOURCE_REPAIR_PASS_STATUS =
  'REAL_PROJECT_EXISTING_SOURCE_REPAIR_PASS';
const EXISTING_SOURCE_REPAIR_FAIL_STATUS =
  'REAL_PROJECT_EXISTING_SOURCE_REPAIR_FAIL';
const BLOCKED_EXIT = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_TIMEOUT_MS = 180_000;
const CODEX_PROBE_FILE = '.vibeloop-codex-real-project-probe.json';
const REPAIR_DIR = '.vibeloop-real-project-repair';
const REPAIR_SOURCE_FILE = `${REPAIR_DIR}/invoice-total.mjs`;
const REPAIR_VISIBLE_TEST_FILE = `${REPAIR_DIR}/visible-repair.test.mjs`;
const EXISTING_SOURCE_REGRESSION_SENTINEL =
  'VIBELOOP_EXISTING_SOURCE_REGRESSION';

function redact(text) {
  return String(text)
    .replace(/https:\/\/([^/\s:@]+):([^@\s]+)@/g, 'https://[REDACTED]@')
    .replace(
      /(Token|Authorization|Bearer)\s+[A-Za-z0-9._~+/=-]+/g,
      '$1 [REDACTED]'
    );
}

function slug(value) {
  return (
    String(value)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'repo'
  );
}

function pathHash(value) {
  return createHash('sha256')
    .update(path.resolve(value))
    .digest('hex')
    .slice(0, 12);
}

async function fileHash(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: [
        options.stdinText === undefined ? 'ignore' : 'pipe',
        'pipe',
        'pipe'
      ]
    });
    let stdout = '';
    let stderr = '';
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    if (options.stdinText !== undefined) {
      child.stdin.end(options.stdinText);
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: error.message,
        timedOut: false,
        spawnError: true
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut: signal === 'SIGTERM',
        spawnError: false
      });
    });
  });
}

async function git(cwd, args, options = {}) {
  return runCommand('git', args, { cwd, ...options });
}

async function isDirectory(filePath) {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function parseJsonTail(text) {
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
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(input.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function classifyLanguages(files) {
  const languages = new Set();
  for (const file of files) {
    if (file.endsWith('.ts') || file.endsWith('.tsx'))
      languages.add('typescript');
    else if (
      file.endsWith('.js') ||
      file.endsWith('.cjs') ||
      file.endsWith('.mjs') ||
      file.endsWith('.jsx')
    )
      languages.add('javascript');
    else if (file.endsWith('.py')) languages.add('python');
    else if (file.endsWith('.rb')) languages.add('ruby');
    else if (file.endsWith('.java')) languages.add('java');
    else if (file.endsWith('.kt') || file.endsWith('.kts'))
      languages.add('kotlin');
    else if (file.endsWith('.swift')) languages.add('swift');
    else if (file.endsWith('.rs')) languages.add('rust');
    else if (file.endsWith('.go')) languages.add('go');
  }
  return [...languages].sort();
}

function detectMarkers(files) {
  const fileSet = new Set(files);
  const markers = [];
  for (const marker of [
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'pyproject.toml',
    'requirements.txt',
    'Gemfile',
    'go.mod',
    'Cargo.toml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'pom.xml',
    'tsconfig.json'
  ]) {
    if (fileSet.has(marker)) markers.push(marker);
  }
  if (files.some((file) => file.startsWith('src/'))) markers.push('src/');
  if (files.some((file) => file.startsWith('app/'))) markers.push('app/');
  if (files.some((file) => file.startsWith('packages/')))
    markers.push('packages/');
  if (files.some((file) => /(^|\/)(test|tests|spec|__tests__)\//i.test(file))) {
    markers.push('tests/');
  }
  return [...new Set(markers)].sort();
}

async function smokeChecks(repoPath, files) {
  const checks = [];
  const packageJson = path.join(repoPath, 'package.json');
  if (files.includes('package.json')) {
    const parsed = await readJsonIfPresent(packageJson);
    checks.push({
      id: 'package_json_parse',
      status: parsed ? 'pass' : 'fail',
      package_name: parsed?.name ?? null,
      has_scripts: parsed?.scripts && Object.keys(parsed.scripts).length > 0
    });
  }
  if (files.includes('pyproject.toml')) {
    const command = [
      'python3',
      '-c',
      "import pathlib, tomllib; tomllib.loads(pathlib.Path('pyproject.toml').read_text()); print('pyproject-ok')"
    ];
    const result = await runCommand(command[0], command.slice(1), {
      cwd: repoPath
    });
    checks.push({
      id: 'pyproject_toml_parse',
      status: result.code === 0 ? 'pass' : 'fail',
      stderr: redact(result.stderr).slice(0, 400)
    });
  }
  if (files.includes('Cargo.toml')) {
    checks.push({ id: 'cargo_manifest_present', status: 'pass' });
  }
  if (files.includes('go.mod')) {
    checks.push({ id: 'go_mod_present', status: 'pass' });
  }
  if (files.includes('Gemfile')) {
    checks.push({ id: 'gemfile_present', status: 'pass' });
  }
  if (checks.length === 0) {
    checks.push({ id: 'source_marker_present', status: 'pass' });
  }
  return checks;
}

async function runModifiableCopySmoke(sourceRepoPath, cellId, tmpRoot) {
  const cloneRoot = path.join(tmpRoot, 'modifiable-copies');
  const clonePath = path.join(cloneRoot, cellId);
  const probeFile = '.vibeloop-real-project-modification-probe.txt';
  const failures = [];
  await mkdir(cloneRoot, { recursive: true });

  const clone = await git(
    REPO_ROOT,
    ['clone', '--quiet', '--no-hardlinks', '--', sourceRepoPath, clonePath],
    { timeoutMs: 120_000 }
  );
  if (clone.code !== 0) {
    return {
      status: 'fail',
      failures: ['clone_failed'],
      clone_exit_code: clone.code,
      clone_stderr: redact(clone.stderr).slice(0, 800)
    };
  }

  await writeFile(
    path.join(clonePath, probeFile),
    [
      'VibeLoop real project modifiable-copy smoke.',
      `source_path_hash=${pathHash(sourceRepoPath)}`,
      ''
    ].join('\n')
  );
  const statusAfterWrite = await git(clonePath, [
    'status',
    '--porcelain=v1',
    '--',
    probeFile
  ]);
  const add = await git(clonePath, ['add', '--', probeFile]);
  const diffCheck = await git(clonePath, ['diff', '--cached', '--check']);
  const reset = await git(clonePath, ['reset', '--hard', 'HEAD']);
  const clean = await git(clonePath, ['clean', '-fd', '--', probeFile]);
  const finalStatus = await git(clonePath, ['status', '--porcelain=v1']);
  const discover = await runCommand(
    process.execPath,
    [
      CLI,
      'discover',
      '--repo',
      clonePath,
      '--test-command',
      'git ls-files > /dev/null'
    ],
    { cwd: REPO_ROOT, timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const discoverJson = parseJsonTail(discover.stdout);

  if (statusAfterWrite.code !== 0 || !statusAfterWrite.stdout.trim()) {
    failures.push('write_probe_not_detected');
  }
  if (add.code !== 0) failures.push('write_probe_stage_failed');
  if (diffCheck.code !== 0) failures.push('diff_check_failed');
  if (reset.code !== 0 || clean.code !== 0 || finalStatus.stdout.trim()) {
    failures.push('cleanup_failed');
  }
  if (discover.code !== 0 || !discoverJson) {
    failures.push('clone_discover_failed');
  }

  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    source_repo_path_hash: pathHash(sourceRepoPath),
    clone_path_hash: pathHash(clonePath),
    write_probe_detected:
      statusAfterWrite.code === 0 && Boolean(statusAfterWrite.stdout.trim()),
    staged_diff_check_status: diffCheck.code === 0 ? 'pass' : 'fail',
    cleanup_status:
      reset.code === 0 && clean.code === 0 && !finalStatus.stdout.trim()
        ? 'pass'
        : 'fail',
    discover: {
      status: discover.code === 0 && discoverJson ? 'pass' : 'fail',
      exit_code: discover.code,
      candidate_count: Array.isArray(discoverJson?.candidates)
        ? discoverJson.candidates.length
        : null,
      stderr: redact(discover.stderr).slice(0, 800),
      timed_out: discover.timedOut
    },
    failures,
    stderr: {
      add: redact(add.stderr).slice(0, 400),
      diff_check: redact(diffCheck.stderr).slice(0, 400),
      reset: redact(reset.stderr).slice(0, 400),
      clean: redact(clean.stderr).slice(0, 400)
    }
  };
}

function buildCodexProbePrompt({ probeId }) {
  return [
    'You are operating in a temporary clone of an existing real user project.',
    'Create or replace only this file: .vibeloop-codex-real-project-probe.json',
    'Do not edit source files, tests, package files, lockfiles, configuration, git history, or any other file.',
    'Inspect the checkout yourself with git commands and write exactly one JSON object to the probe file.',
    '',
    'Required JSON schema:',
    '{',
    '  "schema_version": "1.0",',
    '  "kind": "vibeloop-real-project-codex-copy-probe",',
    `  "probe_id": "${probeId}",`,
    '  "head_sha": "<exact output of: git rev-parse HEAD>",',
    '  "tracked_file_count": <number of non-empty lines from: git ls-files>,',
    '  "dirty_before_probe": <true if git status --porcelain=v1 had entries before writing this file, otherwise false>,',
    '  "notes": "real Codex wrote this file in a temporary copy only"',
    '}',
    '',
    'Do not print markdown fences. Finish after the file is written.'
  ].join('\n');
}

function buildRepairSource() {
  return [
    'export function computeInvoiceTotal(items, options = {}) {',
    '  let subtotal = 0;',
    '  for (const item of items) {',
    '    subtotal += Number(item.price ?? 0);',
    '  }',
    '  return Math.round(subtotal * 100) / 100;',
    '}',
    ''
  ].join('\n');
}

function buildVisibleRepairTest() {
  return [
    "import { computeInvoiceTotal } from './invoice-total.mjs';",
    '',
    'const cases = [',
    '  {',
    "    name: 'quantity with discount and tax',",
    '    items: [',
    '      { price: 12.25, quantity: 2 },',
    '      { price: 5, quantity: 3 }',
    '    ],',
    '    options: { discountRate: 0.1, taxRate: 0.0825 },',
    '    expected: 38.48',
    '  },',
    '  {',
    "    name: 'round only after tax is applied',",
    '    items: [{ price: 0.105 }, { price: 1.005, quantity: 2 }],',
    '    options: { taxRate: 0.075 },',
    '    expected: 2.27',
    '  }',
    '];',
    '',
    'for (const testCase of cases) {',
    '  const actual = computeInvoiceTotal(testCase.items, testCase.options);',
    '  if (actual !== testCase.expected) {',
    '    throw new Error(`${testCase.name}: expected ${testCase.expected}, got ${actual}`);',
    '  }',
    '}',
    ''
  ].join('\n');
}

function buildHiddenRepairVerifier({ sourcePath }) {
  return [
    "import { pathToFileURL } from 'node:url';",
    '',
    `const sourceUrl = pathToFileURL(${JSON.stringify(sourcePath)}).href;`,
    'const { computeInvoiceTotal } = await import(sourceUrl);',
    '',
    'function expectedTotal(items, options = {}) {',
    '  let subtotal = 0;',
    '  for (const item of items) {',
    "    const quantity = Object.hasOwn(item, 'quantity') ? Number(item.quantity) : 1;",
    '    subtotal += Number(item.price ?? 0) * quantity;',
    '  }',
    '  const discountRate = Number(options.discountRate ?? 0);',
    '  const taxRate = Number(options.taxRate ?? 0);',
    '  const total = subtotal * (1 - discountRate) * (1 + taxRate);',
    '  return Math.round((total + Number.EPSILON) * 100) / 100;',
    '}',
    '',
    'const cases = [',
    '  {',
    "    name: 'default quantity participates in discount and tax rounding',",
    '    items: [{ price: 0.105 }, { price: 1.2, quantity: 2 }],',
    '    options: { taxRate: 0.075 }',
    '  },',
    '  {',
    "    name: 'zero quantity stays zero instead of falling back to one',",
    '    items: [{ price: 99, quantity: 0 }, { price: 10, quantity: 1 }],',
    '    options: { discountRate: 0.1 }',
    '  },',
    '  {',
    "    name: 'fractional subtotal rounds only after discount and tax',",
    '    items: [{ price: 19.995, quantity: 2 }],',
    '    options: { discountRate: 0.125, taxRate: 0.0825 }',
    '  }',
    '];',
    '',
    'for (const testCase of cases) {',
    '  const actual = computeInvoiceTotal(testCase.items, testCase.options);',
    '  const expected = expectedTotal(testCase.items, testCase.options);',
    '  if (actual !== expected) {',
    '    throw new Error(`${testCase.name}: expected ${expected}, got ${actual}`);',
    '  }',
    '}',
    ''
  ].join('\n');
}

function buildCodexRepairPrompt() {
  return [
    'You are operating in a temporary clone of an existing real user project.',
    `Only edit this source file: ${REPAIR_SOURCE_FILE}`,
    `Do not edit ${REPAIR_VISIBLE_TEST_FILE} or any other file.`,
    '',
    'Task: fix computeInvoiceTotal so invoice totals use item quantity, optional discountRate, optional taxRate, default quantity 1, valid quantity 0, and cent rounding only once after discount and tax are both applied.',
    'Do not round subtotal, discounted subtotal, or any intermediate value. Compute the full total first, then round the final result to cents.',
    `Run this visible test: node ${REPAIR_VISIBLE_TEST_FILE}`,
    'The visible test is not the full acceptance suite. Implement the general behavior, not a hardcoded answer.',
    '',
    'Finish after the source file is fixed.'
  ].join('\n');
}

function existingSourceLanguage(relativePath) {
  if (
    relativePath.endsWith('.js') ||
    relativePath.endsWith('.mjs') ||
    relativePath.endsWith('.cjs')
  ) {
    return 'javascript';
  }
  if (relativePath.endsWith('.py')) return 'python';
  return null;
}

function isIgnoredExistingSource(relativePath) {
  return (
    relativePath.startsWith('.') ||
    relativePath.includes('/.') ||
    /(^|\/)(node_modules|vendor|dist|build|coverage|tmp|temp|logs)\//.test(
      relativePath
    ) ||
    /(^|\/)(test|tests|spec|__tests__|fixtures?|mocks?)\//i.test(
      relativePath
    ) ||
    /\.min\.js$/.test(relativePath)
  );
}

function existingSourceCheckCommand(relativePath, language) {
  if (language === 'javascript') {
    return { command: process.execPath, args: ['--check', relativePath] };
  }
  if (language === 'python') {
    return {
      command: 'python3',
      args: ['-m', 'py_compile', relativePath]
    };
  }
  return null;
}

function existingSourceRegressionLine(language) {
  if (language === 'javascript') {
    return `const ${EXISTING_SOURCE_REGRESSION_SENTINEL} = ;`;
  }
  if (language === 'python') {
    return `${EXISTING_SOURCE_REGRESSION_SENTINEL} =`;
  }
  return `${EXISTING_SOURCE_REGRESSION_SENTINEL}`;
}

function injectExistingSourceRegression(sourceText, language) {
  const regressionLine = existingSourceRegressionLine(language);
  if (sourceText.startsWith('#!')) {
    const newlineIndex = sourceText.indexOf('\n');
    if (newlineIndex >= 0) {
      return `${sourceText.slice(0, newlineIndex + 1)}${regressionLine}\n${sourceText.slice(newlineIndex + 1)}`;
    }
  }
  return `${regressionLine}\n${sourceText}`;
}

function listExistingSourceRepairCandidates(files) {
  return files
    .map((relativePath) => ({
      relativePath,
      language: existingSourceLanguage(relativePath)
    }))
    .filter(
      (candidate) =>
        candidate.language && !isIgnoredExistingSource(candidate.relativePath)
    )
    .sort((a, b) => {
      const languageRank = { javascript: 0, python: 1 };
      const rankDelta = languageRank[a.language] - languageRank[b.language];
      return rankDelta || a.relativePath.localeCompare(b.relativePath);
    });
}

function buildExistingSourceRepairPrompt({ targetFile, visibleCommand }) {
  return [
    'You are operating in a temporary clone of an existing real user project.',
    `Only edit this existing tracked source file: ${targetFile}`,
    'Do not edit tests, fixtures, package files, lockfiles, configuration, generated files, git history, or any other file.',
    '',
    `The file contains a deliberately introduced regression sentinel: ${EXISTING_SOURCE_REGRESSION_SENTINEL}`,
    'Repair the existing source file by removing the regression and restoring syntactic validity without changing unrelated behavior.',
    `Run this visible check: ${visibleCommand}`,
    'The visible check is not the full acceptance suite. Keep the change minimal and limited to the target file.',
    '',
    'Finish after the existing source file is fixed.'
  ].join('\n');
}

function buildExistingSourceHiddenVerifier({ sourcePath }) {
  return [
    "import { readFile } from 'node:fs/promises';",
    '',
    `const text = await readFile(${JSON.stringify(sourcePath)}, 'utf8');`,
    `if (text.includes(${JSON.stringify(EXISTING_SOURCE_REGRESSION_SENTINEL)})) {`,
    "  throw new Error('existing source regression sentinel still present');",
    '}',
    ''
  ].join('\n');
}

function parseCodexProbe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeTextFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
  return filePath;
}

async function writeCommandResultLog(filePath, result) {
  return writeTextFile(
    filePath,
    `${JSON.stringify(
      {
        exit_code: result.code,
        timed_out: result.timedOut,
        stdout: redact(result.stdout),
        stderr: redact(result.stderr)
      },
      null,
      2
    )}\n`
  );
}

async function runCodexPrompt({
  clonePath,
  requestId,
  prompt,
  model,
  timeoutMs,
  logDir
}) {
  const outputFile = path.join(logDir, `${requestId}-last-message.txt`);
  const result = await runCommand(
    process.env.VIBELOOP_REAL_PROJECT_CODEX_BIN || 'codex',
    [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'workspace-write',
      '--cd',
      clonePath,
      '-c',
      'service_tier=fast',
      '-c',
      'approval_policy=never',
      '--model',
      model,
      '--output-last-message',
      outputFile,
      '-'
    ],
    {
      cwd: REPO_ROOT,
      timeoutMs,
      stdinText: prompt,
      env: {
        ...process.env,
        ...(process.env.VIBELOOP_REAL_PROJECT_CODEX_HOME
          ? { CODEX_HOME: process.env.VIBELOOP_REAL_PROJECT_CODEX_HOME }
          : {})
      }
    }
  );
  const stdoutFile = await writeTextFile(
    path.join(logDir, `${requestId}-stdout.log`),
    redact(result.stdout)
  );
  const stderrFile = await writeTextFile(
    path.join(logDir, `${requestId}-stderr.log`),
    redact(result.stderr)
  );
  return {
    ...result,
    output_file: outputFile,
    stdout_file: stdoutFile,
    stderr_file: stderrFile
  };
}

async function runCodexProbe({ clonePath, probeId, model, timeoutMs, logDir }) {
  return runCodexPrompt({
    clonePath,
    requestId: probeId,
    prompt: buildCodexProbePrompt({ probeId }),
    model,
    timeoutMs,
    logDir
  });
}

async function runCodexCopySmoke(
  sourceRepoPath,
  cellId,
  tmpRoot,
  options = {}
) {
  const cloneRoot = path.join(tmpRoot, 'codex-copies');
  const clonePath = path.join(cloneRoot, cellId);
  const logDir = path.join(tmpRoot, 'codex-logs', cellId);
  const probeId = `real-project-codex-${cellId}`;
  const failures = [];
  await mkdir(cloneRoot, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const clone = await git(
    REPO_ROOT,
    ['clone', '--quiet', '--no-hardlinks', '--', sourceRepoPath, clonePath],
    { timeoutMs: 120_000 }
  );
  if (clone.code !== 0) {
    return {
      status: 'fail',
      failures: ['clone_failed'],
      clone_exit_code: clone.code,
      clone_stderr: redact(clone.stderr).slice(0, 800)
    };
  }

  const [headBefore, filesBefore, statusBefore] = await Promise.all([
    git(clonePath, ['rev-parse', 'HEAD']),
    git(clonePath, ['ls-files']),
    git(clonePath, ['status', '--porcelain=v1'])
  ]);
  const trackedFiles = filesBefore.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const dirtyBefore = Boolean(statusBefore.stdout.trim());

  const codex = await runCodexProbe({
    clonePath,
    probeId,
    model: options.codexModel,
    timeoutMs: options.codexTimeoutMs,
    logDir
  });
  if (codex.code !== 0) failures.push('codex_exec_failed');
  if (codex.timedOut) failures.push('codex_exec_timeout');

  const probePath = path.join(clonePath, CODEX_PROBE_FILE);
  let probeJson = null;
  try {
    probeJson = parseCodexProbe(await readFile(probePath, 'utf8'));
  } catch {
    failures.push('probe_file_missing');
  }
  if (!probeJson) failures.push('probe_json_invalid');

  const statusAfter = await git(clonePath, ['status', '--porcelain=v1']);
  await git(clonePath, ['add', '--intent-to-add', '--', CODEX_PROBE_FILE]);
  const diffNameOnly = await git(clonePath, ['diff', '--name-only', '--']);
  const diffCheck = await git(clonePath, ['diff', '--check']);
  const changedFiles = statusAfter.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();

  const expectedChangedFiles = [CODEX_PROBE_FILE];
  if (JSON.stringify(changedFiles) !== JSON.stringify(expectedChangedFiles)) {
    failures.push('diff_scope_not_probe_only');
  }
  if (diffNameOnly.code !== 0) failures.push('diff_name_only_failed');
  if (diffCheck.code !== 0) failures.push('diff_check_failed');

  const hiddenAcceptanceFailures = [];
  const expectedHead = headBefore.stdout.trim();
  if (headBefore.code !== 0 || !expectedHead) {
    hiddenAcceptanceFailures.push('expected_head_unavailable');
  }
  if (filesBefore.code !== 0) {
    hiddenAcceptanceFailures.push('expected_files_unavailable');
  }
  if (statusBefore.code !== 0) {
    hiddenAcceptanceFailures.push('expected_status_unavailable');
  }
  if (probeJson?.schema_version !== '1.0') {
    hiddenAcceptanceFailures.push('schema_version');
  }
  if (probeJson?.kind !== 'vibeloop-real-project-codex-copy-probe') {
    hiddenAcceptanceFailures.push('kind');
  }
  if (probeJson?.probe_id !== probeId) {
    hiddenAcceptanceFailures.push('probe_id');
  }
  if (probeJson?.head_sha !== expectedHead) {
    hiddenAcceptanceFailures.push('head_sha');
  }
  if (probeJson?.tracked_file_count !== trackedFiles.length) {
    hiddenAcceptanceFailures.push('tracked_file_count');
  }
  if (probeJson?.dirty_before_probe !== dirtyBefore) {
    hiddenAcceptanceFailures.push('dirty_before_probe');
  }
  if (
    probeJson?.notes !== 'real Codex wrote this file in a temporary copy only'
  ) {
    hiddenAcceptanceFailures.push('notes');
  }
  if (hiddenAcceptanceFailures.length > 0) {
    failures.push('hidden_acceptance_failed');
  }

  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    source_repo_path_hash: pathHash(sourceRepoPath),
    clone_path_hash: pathHash(clonePath),
    provider: 'codex',
    real_llm: true,
    model: options.codexModel,
    probe_file: CODEX_PROBE_FILE,
    hidden_acceptance: {
      status: hiddenAcceptanceFailures.length === 0 ? 'pass' : 'fail',
      checked: true,
      failure_count: hiddenAcceptanceFailures.length,
      failures: hiddenAcceptanceFailures
    },
    diff_scope: {
      status:
        JSON.stringify(changedFiles) === JSON.stringify(expectedChangedFiles)
          ? 'pass'
          : 'fail',
      changed_files: changedFiles,
      expected_files: expectedChangedFiles
    },
    diff_check_status: diffCheck.code === 0 ? 'pass' : 'fail',
    codex: {
      status: codex.code === 0 && !codex.timedOut ? 'pass' : 'fail',
      exit_code: codex.code,
      timed_out: codex.timedOut,
      stdout_file: codex.stdout_file,
      stderr_file: codex.stderr_file,
      output_file: codex.output_file
    },
    failures
  };
}

async function runCodexRepairSmoke(
  sourceRepoPath,
  cellId,
  tmpRoot,
  options = {}
) {
  const cloneRoot = path.join(tmpRoot, 'codex-repair-copies');
  const clonePath = path.join(cloneRoot, cellId);
  const logDir = path.join(tmpRoot, 'codex-repair-logs', cellId);
  const repairId = `real-project-codex-repair-${cellId}`;
  const failures = [];
  await mkdir(cloneRoot, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const [sourceHeadBefore, sourceStatusBefore] = await Promise.all([
    git(sourceRepoPath, ['rev-parse', 'HEAD']),
    git(sourceRepoPath, ['status', '--porcelain=v1'])
  ]);

  const clone = await git(
    REPO_ROOT,
    ['clone', '--quiet', '--no-hardlinks', '--', sourceRepoPath, clonePath],
    { timeoutMs: 120_000 }
  );
  if (clone.code !== 0) {
    return {
      status: 'fail',
      failures: ['clone_failed'],
      clone_exit_code: clone.code,
      clone_stderr: redact(clone.stderr).slice(0, 800)
    };
  }

  const sourcePath = path.join(clonePath, REPAIR_SOURCE_FILE);
  const visibleTestPath = path.join(clonePath, REPAIR_VISIBLE_TEST_FILE);
  const hiddenVerifierFile = await writeTextFile(
    path.join(logDir, `${repairId}-hidden-verifier.mjs`),
    buildHiddenRepairVerifier({ sourcePath })
  );

  await writeTextFile(sourcePath, buildRepairSource());
  await writeTextFile(visibleTestPath, buildVisibleRepairTest());
  const seedAdd = await git(clonePath, ['add', '--', REPAIR_DIR]);
  const seedCommit = await git(clonePath, [
    '-c',
    'user.name=VibeLoop UAT',
    '-c',
    'user.email=vibeloop-uat@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-m',
    'seed vibeloop real project source repair fixture'
  ]);
  const seedStatus = await git(clonePath, ['status', '--porcelain=v1']);
  if (seedAdd.code !== 0) failures.push('seed_fixture_add_failed');
  if (seedCommit.code !== 0) failures.push('seed_fixture_commit_failed');
  if (seedStatus.code !== 0 || seedStatus.stdout.trim()) {
    failures.push('seed_fixture_dirty');
  }
  if (failures.length > 0) {
    return {
      status: 'fail',
      source_repo_path_hash: pathHash(sourceRepoPath),
      clone_path_hash: pathHash(clonePath),
      repair_source: REPAIR_SOURCE_FILE,
      visible_test: REPAIR_VISIBLE_TEST_FILE,
      failures,
      seed: {
        add_exit_code: seedAdd.code,
        commit_exit_code: seedCommit.code,
        status: redact(seedStatus.stdout).slice(0, 400),
        stderr: {
          add: redact(seedAdd.stderr).slice(0, 400),
          commit: redact(seedCommit.stderr).slice(0, 800)
        }
      }
    };
  }

  const sourceHashBefore = await fileHash(sourcePath);
  const visibleHashBefore = await fileHash(visibleTestPath);
  const baseVisible = await runCommand(
    process.execPath,
    [REPAIR_VISIBLE_TEST_FILE],
    { cwd: clonePath, timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const baseHidden = await runCommand(process.execPath, [hiddenVerifierFile], {
    cwd: clonePath,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
  const baseVisibleLog = await writeCommandResultLog(
    path.join(logDir, `${repairId}-base-visible.json`),
    baseVisible
  );
  const baseHiddenLog = await writeCommandResultLog(
    path.join(logDir, `${repairId}-base-hidden.json`),
    baseHidden
  );
  if (baseVisible.code === 0) failures.push('base_visible_unexpected_pass');
  if (baseHidden.code === 0) failures.push('base_hidden_unexpected_pass');

  const codex = await runCodexPrompt({
    clonePath,
    requestId: repairId,
    prompt: buildCodexRepairPrompt(),
    model: options.codexModel,
    timeoutMs: options.codexTimeoutMs,
    logDir
  });
  if (codex.code !== 0) failures.push('codex_exec_failed');
  if (codex.timedOut) failures.push('codex_exec_timeout');

  const finalVisible = await runCommand(
    process.execPath,
    [REPAIR_VISIBLE_TEST_FILE],
    { cwd: clonePath, timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const finalHidden = await runCommand(process.execPath, [hiddenVerifierFile], {
    cwd: clonePath,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
  const finalVisibleLog = await writeCommandResultLog(
    path.join(logDir, `${repairId}-final-visible.json`),
    finalVisible
  );
  const finalHiddenLog = await writeCommandResultLog(
    path.join(logDir, `${repairId}-final-hidden.json`),
    finalHidden
  );
  if (finalVisible.code !== 0) failures.push('visible_acceptance_failed');
  if (finalHidden.code !== 0) failures.push('hidden_acceptance_failed');

  const sourceHashAfter = await fileHash(sourcePath);
  const visibleHashAfter = await fileHash(visibleTestPath);
  if (sourceHashBefore === sourceHashAfter) failures.push('source_not_changed');
  if (visibleHashBefore !== visibleHashAfter)
    failures.push('visible_test_modified');

  const statusAfter = await git(clonePath, ['status', '--porcelain=v1']);
  const diffCheck = await git(clonePath, ['diff', '--check']);
  const changedFiles = statusAfter.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();
  const expectedChangedFiles = [REPAIR_SOURCE_FILE];
  if (JSON.stringify(changedFiles) !== JSON.stringify(expectedChangedFiles)) {
    failures.push('diff_scope_not_source_only');
  }
  if (diffCheck.code !== 0) failures.push('diff_check_failed');

  const [sourceHeadAfter, sourceStatusAfter] = await Promise.all([
    git(sourceRepoPath, ['rev-parse', 'HEAD']),
    git(sourceRepoPath, ['status', '--porcelain=v1'])
  ]);
  const sourceRepoIntegrity =
    sourceHeadBefore.code === 0 &&
    sourceHeadAfter.code === 0 &&
    sourceHeadBefore.stdout.trim() === sourceHeadAfter.stdout.trim() &&
    sourceStatusBefore.code === 0 &&
    sourceStatusAfter.code === 0 &&
    sourceStatusBefore.stdout === sourceStatusAfter.stdout;
  if (!sourceRepoIntegrity) failures.push('source_repo_integrity_failed');

  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    source_repo_path_hash: pathHash(sourceRepoPath),
    clone_path_hash: pathHash(clonePath),
    provider: 'codex',
    real_llm: true,
    model: options.codexModel,
    repair_source: REPAIR_SOURCE_FILE,
    visible_test: REPAIR_VISIBLE_TEST_FILE,
    base_acceptance: {
      visible_status:
        baseVisible.code === 0 ? 'unexpected_pass' : 'expected_fail',
      hidden_status:
        baseHidden.code === 0 ? 'unexpected_pass' : 'expected_fail',
      visible_log: baseVisibleLog,
      hidden_log: baseHiddenLog
    },
    visible_acceptance: {
      status: finalVisible.code === 0 ? 'pass' : 'fail',
      log: finalVisibleLog
    },
    hidden_acceptance: {
      status: finalHidden.code === 0 ? 'pass' : 'fail',
      checked: true,
      verifier_file: hiddenVerifierFile,
      log: finalHiddenLog
    },
    diff_scope: {
      status:
        JSON.stringify(changedFiles) === JSON.stringify(expectedChangedFiles)
          ? 'pass'
          : 'fail',
      changed_files: changedFiles,
      expected_files: expectedChangedFiles
    },
    source_changed: sourceHashBefore !== sourceHashAfter,
    visible_test_unchanged: visibleHashBefore === visibleHashAfter,
    source_repo_integrity: {
      status: sourceRepoIntegrity ? 'pass' : 'fail',
      head_unchanged:
        sourceHeadBefore.stdout.trim() === sourceHeadAfter.stdout.trim(),
      status_unchanged: sourceStatusBefore.stdout === sourceStatusAfter.stdout
    },
    diff_check_status: diffCheck.code === 0 ? 'pass' : 'fail',
    codex: {
      status: codex.code === 0 && !codex.timedOut ? 'pass' : 'fail',
      exit_code: codex.code,
      timed_out: codex.timedOut,
      stdout_file: codex.stdout_file,
      stderr_file: codex.stderr_file,
      output_file: codex.output_file
    },
    evidence_files: {
      final_source: sourcePath,
      visible_test: visibleTestPath,
      hidden_verifier: hiddenVerifierFile,
      base_visible_log: baseVisibleLog,
      base_hidden_log: baseHiddenLog,
      final_visible_log: finalVisibleLog,
      final_hidden_log: finalHiddenLog
    },
    failures
  };
}

async function selectExistingSourceRepairTarget(clonePath) {
  const filesResult = await git(clonePath, ['ls-files']);
  if (filesResult.code !== 0) {
    return {
      target: null,
      failures: ['tracked_files_unavailable'],
      stderr: redact(filesResult.stderr).slice(0, 800)
    };
  }
  const candidates = listExistingSourceRepairCandidates(
    filesResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  for (const candidate of candidates.slice(0, 50)) {
    const filePath = path.join(clonePath, candidate.relativePath);
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > 200_000) {
      continue;
    }
    const check = existingSourceCheckCommand(
      candidate.relativePath,
      candidate.language
    );
    if (!check) continue;
    const result = await runCommand(check.command, check.args, {
      cwd: clonePath,
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
    if (result.code === 0) {
      return {
        target: {
          ...candidate,
          filePath,
          check
        },
        failures: []
      };
    }
  }
  return {
    target: null,
    failures: ['no_parseable_existing_source_target']
  };
}

async function runCodexExistingSourceRepairSmoke(
  sourceRepoPath,
  cellId,
  tmpRoot,
  options = {}
) {
  const cloneRoot = path.join(tmpRoot, 'existing-source-repair-copies');
  const clonePath = path.join(cloneRoot, cellId);
  const logDir = path.join(tmpRoot, 'existing-source-repair-logs', cellId);
  const repairId = `real-project-existing-source-repair-${cellId}`;
  const failures = [];
  await mkdir(cloneRoot, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const [sourceHeadBefore, sourceStatusBefore] = await Promise.all([
    git(sourceRepoPath, ['rev-parse', 'HEAD']),
    git(sourceRepoPath, ['status', '--porcelain=v1'])
  ]);

  const clone = await git(
    REPO_ROOT,
    ['clone', '--quiet', '--no-hardlinks', '--', sourceRepoPath, clonePath],
    { timeoutMs: 120_000 }
  );
  if (clone.code !== 0) {
    return {
      status: 'fail',
      failures: ['clone_failed'],
      clone_exit_code: clone.code,
      clone_stderr: redact(clone.stderr).slice(0, 800)
    };
  }

  const targetSelection = await selectExistingSourceRepairTarget(clonePath);
  const target = targetSelection.target;
  if (!target) {
    return {
      status: 'fail',
      source_repo_path_hash: pathHash(sourceRepoPath),
      clone_path_hash: pathHash(clonePath),
      failures: targetSelection.failures,
      target_selection_stderr: targetSelection.stderr ?? null
    };
  }

  const visibleCommandText = [
    target.check.command,
    ...target.check.args.map((arg) => JSON.stringify(arg))
  ].join(' ');
  const hiddenVerifierFile = await writeTextFile(
    path.join(logDir, `${repairId}-hidden-verifier.mjs`),
    buildExistingSourceHiddenVerifier({ sourcePath: target.filePath })
  );
  const originalText = await readFile(target.filePath, 'utf8');
  const originalHash = await fileHash(target.filePath);
  const originalVisible = await runCommand(
    target.check.command,
    target.check.args,
    {
      cwd: clonePath,
      timeoutMs: DEFAULT_TIMEOUT_MS
    }
  );
  const originalVisibleLog = await writeCommandResultLog(
    path.join(logDir, `${repairId}-original-visible.json`),
    originalVisible
  );
  if (originalVisible.code !== 0) {
    failures.push('original_existing_source_check_failed');
  }

  await writeFile(
    target.filePath,
    injectExistingSourceRegression(originalText, target.language)
  );
  const seedAdd = await git(clonePath, ['add', '--', target.relativePath]);
  const seedCommit = await git(clonePath, [
    '-c',
    'user.name=VibeLoop UAT',
    '-c',
    'user.email=vibeloop-uat@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-m',
    'seed vibeloop existing source regression'
  ]);
  const seedStatus = await git(clonePath, ['status', '--porcelain=v1']);
  if (seedAdd.code !== 0) failures.push('seed_regression_add_failed');
  if (seedCommit.code !== 0) failures.push('seed_regression_commit_failed');
  if (seedStatus.code !== 0 || seedStatus.stdout.trim()) {
    failures.push('seed_regression_dirty');
  }
  if (failures.length > 0) {
    return {
      status: 'fail',
      source_repo_path_hash: pathHash(sourceRepoPath),
      clone_path_hash: pathHash(clonePath),
      repair_source: target.relativePath,
      existing_source: true,
      failures,
      seed: {
        add_exit_code: seedAdd.code,
        commit_exit_code: seedCommit.code,
        status: redact(seedStatus.stdout).slice(0, 400),
        stderr: {
          add: redact(seedAdd.stderr).slice(0, 400),
          commit: redact(seedCommit.stderr).slice(0, 800)
        }
      }
    };
  }

  const regressedHash = await fileHash(target.filePath);
  const regressedVisible = await runCommand(
    target.check.command,
    target.check.args,
    { cwd: clonePath, timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const regressedHidden = await runCommand(
    process.execPath,
    [hiddenVerifierFile],
    {
      cwd: clonePath,
      timeoutMs: DEFAULT_TIMEOUT_MS
    }
  );
  const regressedVisibleLog = await writeCommandResultLog(
    path.join(logDir, `${repairId}-regressed-visible.json`),
    regressedVisible
  );
  const regressedHiddenLog = await writeCommandResultLog(
    path.join(logDir, `${repairId}-regressed-hidden.json`),
    regressedHidden
  );
  if (regressedVisible.code === 0) {
    failures.push('regressed_visible_unexpected_pass');
  }
  if (regressedHidden.code === 0) {
    failures.push('regressed_hidden_unexpected_pass');
  }

  const codex = await runCodexPrompt({
    clonePath,
    requestId: repairId,
    prompt: buildExistingSourceRepairPrompt({
      targetFile: target.relativePath,
      visibleCommand: visibleCommandText
    }),
    model: options.codexModel,
    timeoutMs: options.codexTimeoutMs,
    logDir
  });
  if (codex.code !== 0) failures.push('codex_exec_failed');
  if (codex.timedOut) failures.push('codex_exec_timeout');

  const finalVisible = await runCommand(
    target.check.command,
    target.check.args,
    { cwd: clonePath, timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const finalHidden = await runCommand(process.execPath, [hiddenVerifierFile], {
    cwd: clonePath,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
  const finalVisibleLog = await writeCommandResultLog(
    path.join(logDir, `${repairId}-final-visible.json`),
    finalVisible
  );
  const finalHiddenLog = await writeCommandResultLog(
    path.join(logDir, `${repairId}-final-hidden.json`),
    finalHidden
  );
  if (finalVisible.code !== 0) failures.push('visible_acceptance_failed');
  if (finalHidden.code !== 0) failures.push('hidden_acceptance_failed');

  const finalHash = await fileHash(target.filePath);
  if (regressedHash === finalHash) failures.push('source_not_changed');
  const statusAfter = await git(clonePath, ['status', '--porcelain=v1']);
  const diffCheck = await git(clonePath, ['diff', '--check']);
  const changedFiles = statusAfter.stdout
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();
  const expectedChangedFiles = [target.relativePath];
  if (JSON.stringify(changedFiles) !== JSON.stringify(expectedChangedFiles)) {
    failures.push('diff_scope_not_existing_source_only');
  }
  if (diffCheck.code !== 0) failures.push('diff_check_failed');

  const [sourceHeadAfter, sourceStatusAfter] = await Promise.all([
    git(sourceRepoPath, ['rev-parse', 'HEAD']),
    git(sourceRepoPath, ['status', '--porcelain=v1'])
  ]);
  const sourceRepoIntegrity =
    sourceHeadBefore.code === 0 &&
    sourceHeadAfter.code === 0 &&
    sourceHeadBefore.stdout.trim() === sourceHeadAfter.stdout.trim() &&
    sourceStatusBefore.code === 0 &&
    sourceStatusAfter.code === 0 &&
    sourceStatusBefore.stdout === sourceStatusAfter.stdout;
  if (!sourceRepoIntegrity) failures.push('source_repo_integrity_failed');

  return {
    status: failures.length === 0 ? 'pass' : 'fail',
    source_repo_path_hash: pathHash(sourceRepoPath),
    clone_path_hash: pathHash(clonePath),
    provider: 'codex',
    real_llm: true,
    model: options.codexModel,
    repair_source: target.relativePath,
    existing_source: true,
    existing_source_language: target.language,
    visible_check_command: [target.check.command, ...target.check.args],
    regression_sentinel: EXISTING_SOURCE_REGRESSION_SENTINEL,
    base_acceptance: {
      original_status: originalVisible.code === 0 ? 'pass' : 'fail',
      visible_status:
        regressedVisible.code === 0 ? 'unexpected_pass' : 'expected_fail',
      hidden_status:
        regressedHidden.code === 0 ? 'unexpected_pass' : 'expected_fail',
      original_log: originalVisibleLog,
      visible_log: regressedVisibleLog,
      hidden_log: regressedHiddenLog
    },
    visible_acceptance: {
      status: finalVisible.code === 0 ? 'pass' : 'fail',
      log: finalVisibleLog
    },
    hidden_acceptance: {
      status: finalHidden.code === 0 ? 'pass' : 'fail',
      checked: true,
      verifier_file: hiddenVerifierFile,
      log: finalHiddenLog
    },
    diff_scope: {
      status:
        JSON.stringify(changedFiles) === JSON.stringify(expectedChangedFiles)
          ? 'pass'
          : 'fail',
      changed_files: changedFiles,
      expected_files: expectedChangedFiles
    },
    source_changed: regressedHash !== finalHash,
    original_source_hash: originalHash,
    regressed_source_hash: regressedHash,
    final_source_hash: finalHash,
    visible_test_unchanged: true,
    source_repo_integrity: {
      status: sourceRepoIntegrity ? 'pass' : 'fail',
      head_unchanged:
        sourceHeadBefore.stdout.trim() === sourceHeadAfter.stdout.trim(),
      status_unchanged: sourceStatusBefore.stdout === sourceStatusAfter.stdout
    },
    diff_check_status: diffCheck.code === 0 ? 'pass' : 'fail',
    codex: {
      status: codex.code === 0 && !codex.timedOut ? 'pass' : 'fail',
      exit_code: codex.code,
      timed_out: codex.timedOut,
      stdout_file: codex.stdout_file,
      stderr_file: codex.stderr_file,
      output_file: codex.output_file
    },
    evidence_files: {
      final_source: target.filePath,
      hidden_verifier: hiddenVerifierFile,
      original_visible_log: originalVisibleLog,
      regressed_visible_log: regressedVisibleLog,
      regressed_hidden_log: regressedHiddenLog,
      final_visible_log: finalVisibleLog,
      final_hidden_log: finalHiddenLog
    },
    failures
  };
}

async function analyzeRepo(repoPath, index, options = {}) {
  const resolved = path.resolve(repoPath);
  const id = `${slug(path.basename(resolved))}-${pathHash(resolved)}`;
  const failures = [];

  if (!(await isDirectory(resolved))) {
    return {
      id,
      index,
      status: 'fail',
      repo_path: resolved,
      failures: ['repo_directory_missing']
    };
  }

  const inside = await git(resolved, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return {
      id,
      index,
      status: 'fail',
      repo_path: resolved,
      failures: ['not_a_git_worktree'],
      git_error: redact(inside.stderr).slice(0, 800)
    };
  }

  const [head, branch, status, remotes, filesResult] = await Promise.all([
    git(resolved, ['rev-parse', 'HEAD']),
    git(resolved, ['branch', '--show-current']),
    git(resolved, ['status', '--porcelain=v1']),
    git(resolved, ['remote', '-v']),
    git(resolved, ['ls-files'])
  ]);

  if (head.code !== 0) failures.push('head_sha_unavailable');
  if (filesResult.code !== 0) failures.push('tracked_files_unavailable');

  const files = filesResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const markers = detectMarkers(files);
  const languages = classifyLanguages(files);
  const checks = await smokeChecks(resolved, files);
  if (files.length < 5) failures.push('too_few_tracked_files');
  if (markers.length === 0) failures.push('no_project_markers_detected');
  if (languages.length === 0) failures.push('no_source_languages_detected');
  if (checks.some((check) => check.status !== 'pass'))
    failures.push('metadata_smoke_failed');

  const discover = await runCommand(
    process.execPath,
    [
      CLI,
      'discover',
      '--repo',
      resolved,
      '--test-command',
      'git ls-files > /dev/null'
    ],
    { cwd: REPO_ROOT, timeoutMs: DEFAULT_TIMEOUT_MS }
  );
  const discoverJson = parseJsonTail(discover.stdout);
  const candidateCount = Array.isArray(discoverJson?.candidates)
    ? discoverJson.candidates.length
    : null;
  if (discover.code !== 0) failures.push('discover_command_failed');
  if (!discoverJson) failures.push('discover_json_missing');
  if (candidateCount !== 0)
    failures.push('discover_smoke_expected_zero_candidates');
  const modifiableCopy = options.modifiableCopySmoke
    ? await runModifiableCopySmoke(resolved, `${index}-${id}`, options.tmpRoot)
    : null;
  if (modifiableCopy && modifiableCopy.status !== 'pass') {
    failures.push('modifiable_copy_smoke_failed');
  }
  const codexCopy = options.codexCopySmoke
    ? await runCodexCopySmoke(
        resolved,
        `${index}-${id}`,
        options.tmpRoot,
        options
      )
    : null;
  if (codexCopy && codexCopy.status !== 'pass') {
    failures.push('codex_copy_smoke_failed');
  }
  const codexRepair = options.codexRepairSmoke
    ? await runCodexRepairSmoke(
        resolved,
        `${index}-${id}`,
        options.tmpRoot,
        options
      )
    : options.existingSourceRepairSmoke
      ? await runCodexExistingSourceRepairSmoke(
          resolved,
          `${index}-${id}`,
          options.tmpRoot,
          options
        )
      : null;
  if (codexRepair && codexRepair.status !== 'pass') {
    failures.push('codex_repair_smoke_failed');
  }

  const remoteLines = remotes.stdout
    .split(/\r?\n/)
    .map((line) => redact(line.trim()))
    .filter(Boolean)
    .slice(0, 8);
  const dirtyEntries = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const corpusAxis = [
    ...languages,
    markers.includes('package.json') ? 'node-project' : null,
    markers.includes('pyproject.toml') || markers.includes('requirements.txt')
      ? 'python-project'
      : null,
    markers.includes('Cargo.toml') ? 'rust-project' : null,
    markers.includes('go.mod') ? 'go-project' : null,
    markers.includes('build.gradle') || markers.includes('build.gradle.kts')
      ? 'gradle-project'
      : null,
    markers.includes('tests/') ? 'has-tests' : null,
    dirtyEntries.length > 0 ? 'dirty-readonly' : 'clean'
  ].filter(Boolean);

  return {
    id,
    index,
    status: failures.length === 0 ? 'pass' : 'fail',
    repo_path: resolved,
    repo_path_hash: pathHash(resolved),
    branch: branch.stdout.trim() || null,
    head_sha: head.stdout.trim() || null,
    dirty_count: dirtyEntries.length,
    remote_count: remoteLines.length,
    remotes: remoteLines,
    file_count: files.length,
    languages,
    markers,
    corpus_axis: [...new Set(corpusAxis)].sort(),
    checks,
    discover: {
      status: discover.code === 0 && discoverJson ? 'pass' : 'fail',
      exit_code: discover.code,
      candidate_count: candidateCount,
      discovery_report: discoverJson?.discovery_report ?? null,
      stderr: redact(discover.stderr).slice(0, 800),
      timed_out: discover.timedOut
    },
    ...(modifiableCopy ? { modifiable_copy: modifiableCopy } : {}),
    ...(codexCopy ? { codex_copy: codexCopy } : {}),
    ...(codexRepair ? { codex_repair: codexRepair } : {}),
    failures
  };
}

function parseArgs(argv, env = process.env) {
  const repos = [];
  let minRepos = Number(env.VIBELOOP_REAL_PROJECT_CORPUS_MIN_REPOS ?? 2);
  let modifiableCopySmoke =
    env.VIBELOOP_REAL_PROJECT_CORPUS_MODIFIABLE_COPY_SMOKE === '1';
  let codexCopySmoke =
    env.VIBELOOP_REAL_PROJECT_CORPUS_CODEX_COPY_SMOKE === '1';
  let codexRepairSmoke =
    env.VIBELOOP_REAL_PROJECT_CORPUS_CODEX_REPAIR_SMOKE === '1';
  let existingSourceRepairSmoke =
    env.VIBELOOP_REAL_PROJECT_CORPUS_EXISTING_SOURCE_REPAIR_SMOKE === '1';
  let codexModel = env.VIBELOOP_REAL_PROJECT_CODEX_MODEL || 'gpt-5.5';
  let codexTimeoutMs = Number(
    env.VIBELOOP_REAL_PROJECT_CODEX_TIMEOUT_MS || DEFAULT_CODEX_TIMEOUT_MS
  );
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--repo') {
      const value = argv[index + 1];
      if (!value) throw new Error('--repo requires a path');
      repos.push(value);
      index += 1;
      continue;
    }
    if (arg === '--min-repos') {
      const value = argv[index + 1];
      if (!value) throw new Error('--min-repos requires a number');
      minRepos = Number(value);
      index += 1;
      continue;
    }
    if (arg === '--modifiable-copy-smoke') {
      modifiableCopySmoke = true;
      continue;
    }
    if (arg === '--codex-copy-smoke') {
      codexCopySmoke = true;
      continue;
    }
    if (arg === '--codex-repair-smoke') {
      codexRepairSmoke = true;
      continue;
    }
    if (arg === '--existing-source-repair-smoke') {
      existingSourceRepairSmoke = true;
      continue;
    }
    if (arg === '--codex-model') {
      const value = argv[index + 1];
      if (!value) throw new Error('--codex-model requires a value');
      codexModel = value;
      index += 1;
      continue;
    }
    if (arg === '--codex-timeout-ms') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error('--codex-timeout-ms requires a positive number');
      }
      codexTimeoutMs = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  const envRepos = (env.VIBELOOP_REAL_PROJECT_CORPUS_REPOS ?? '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    repos: [...repos, ...envRepos],
    minRepos: Number.isFinite(minRepos) && minRepos > 0 ? minRepos : 2,
    modifiableCopySmoke,
    codexCopySmoke,
    codexRepairSmoke,
    existingSourceRepairSmoke,
    codexModel,
    codexTimeoutMs
  };
}

async function codexCopyPreflight(options) {
  const codexEnv = {
    ...process.env,
    ...(process.env.VIBELOOP_REAL_PROJECT_CODEX_HOME
      ? { CODEX_HOME: process.env.VIBELOOP_REAL_PROJECT_CODEX_HOME }
      : {})
  };
  const version = await runCommand(
    process.env.VIBELOOP_REAL_PROJECT_CODEX_BIN || 'codex',
    ['--version'],
    { timeoutMs: 30_000, env: codexEnv }
  );
  if (version.code !== 0) {
    return {
      ok: false,
      reason: 'CODEX_CLI_NOT_AVAILABLE',
      version: {
        exit_code: version.code,
        stderr: redact(version.stderr).slice(0, 400)
      }
    };
  }
  const login = await runCommand(
    process.env.VIBELOOP_REAL_PROJECT_CODEX_BIN || 'codex',
    ['-c', 'service_tier=fast', 'login', 'status'],
    { timeoutMs: 30_000, env: codexEnv }
  );
  const loginText = `${login.stdout}${login.stderr}`;
  if (login.code !== 0 || !/Logged in/i.test(loginText)) {
    return {
      ok: false,
      reason: 'CODEX_CHATGPT_LOGIN_NOT_AVAILABLE',
      version: { stdout: version.stdout.trim() },
      login: {
        exit_code: login.code,
        output: redact(loginText).trim().slice(0, 400)
      }
    };
  }
  return {
    ok: true,
    version: { stdout: version.stdout.trim() },
    login: { status: 'pass' },
    model: options.codexModel
  };
}

function cellExtraFiles(cell) {
  const files = [];
  if (cell.codex_copy?.codex) {
    files.push(
      {
        label: `${cell.id}_codex_stdout`,
        path: cell.codex_copy.codex.stdout_file
      },
      {
        label: `${cell.id}_codex_stderr`,
        path: cell.codex_copy.codex.stderr_file
      },
      {
        label: `${cell.id}_codex_last_message`,
        path: cell.codex_copy.codex.output_file
      }
    );
  }
  if (cell.codex_repair?.codex) {
    files.push(
      {
        label: `${cell.id}_codex_repair_stdout`,
        path: cell.codex_repair.codex.stdout_file
      },
      {
        label: `${cell.id}_codex_repair_stderr`,
        path: cell.codex_repair.codex.stderr_file
      },
      {
        label: `${cell.id}_codex_repair_last_message`,
        path: cell.codex_repair.codex.output_file
      }
    );
  }
  const evidenceFiles = cell.codex_repair?.evidence_files ?? {};
  for (const [key, filePath] of Object.entries(evidenceFiles)) {
    files.push({
      label: `${cell.id}_codex_repair_${key}`,
      path: filePath
    });
  }
  return files;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const codexModeCount = [
    options.codexCopySmoke,
    options.codexRepairSmoke,
    options.existingSourceRepairSmoke
  ].filter(Boolean).length;
  if (codexModeCount > 1) {
    throw new Error(
      '--codex-copy-smoke, --codex-repair-smoke, and --existing-source-repair-smoke are mutually exclusive'
    );
  }
  const scenario = options.existingSourceRepairSmoke
    ? EXISTING_SOURCE_REPAIR_SCENARIO
    : options.codexRepairSmoke
      ? CODEX_REPAIR_SCENARIO
      : options.codexCopySmoke
        ? CODEX_COPY_SCENARIO
        : options.modifiableCopySmoke
          ? MODIFIABLE_COPY_SCENARIO
          : READ_ONLY_SCENARIO;
  const passStatus = options.existingSourceRepairSmoke
    ? EXISTING_SOURCE_REPAIR_PASS_STATUS
    : options.codexRepairSmoke
      ? CODEX_REPAIR_PASS_STATUS
      : options.codexCopySmoke
        ? CODEX_COPY_PASS_STATUS
        : options.modifiableCopySmoke
          ? MODIFIABLE_COPY_PASS_STATUS
          : READ_ONLY_PASS_STATUS;
  const failStatus = options.existingSourceRepairSmoke
    ? EXISTING_SOURCE_REPAIR_FAIL_STATUS
    : options.codexRepairSmoke
      ? CODEX_REPAIR_FAIL_STATUS
      : options.codexCopySmoke
        ? CODEX_COPY_FAIL_STATUS
        : options.modifiableCopySmoke
          ? MODIFIABLE_COPY_FAIL_STATUS
          : READ_ONLY_FAIL_STATUS;
  if (options.repos.length < options.minRepos) {
    const report = {
      status: 'blocked',
      scenario,
      reason: 'REAL_PROJECT_CORPUS_REPOS_REQUIRED',
      required_repo_count: options.minRepos,
      provided_repo_count: options.repos.length,
      next_step:
        'Pass at least two real git repositories with --repo <path> or VIBELOOP_REAL_PROJECT_CORPUS_REPOS before claiming broad real project corpus evidence.'
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(BLOCKED_EXIT);
  }
  let codexPreflight = null;
  if (
    options.codexCopySmoke ||
    options.codexRepairSmoke ||
    options.existingSourceRepairSmoke
  ) {
    codexPreflight = await codexCopyPreflight(options);
    if (codexPreflight.ok !== true) {
      const report = {
        status: 'blocked',
        scenario,
        reason: codexPreflight.reason,
        preflight: codexPreflight,
        next_step:
          'Run this lane on a machine with Codex CLI and ChatGPT login, or point VIBELOOP_REAL_PROJECT_CODEX_HOME at an authenticated CODEX_HOME.'
      };
      console.log(JSON.stringify(report, null, 2));
      process.exit(BLOCKED_EXIT);
    }
  }

  const runId = `real-project-corpus-${process.pid}-${Date.now()}`;
  const tmpRoot = path.join(os.tmpdir(), runId);
  await mkdir(tmpRoot, { recursive: true });
  const cells = [];
  for (const [index, repo] of options.repos.entries()) {
    cells.push(
      await analyzeRepo(repo, index + 1, {
        modifiableCopySmoke: options.modifiableCopySmoke,
        codexCopySmoke: options.codexCopySmoke,
        codexRepairSmoke: options.codexRepairSmoke,
        existingSourceRepairSmoke: options.existingSourceRepairSmoke,
        codexModel: options.codexModel,
        codexTimeoutMs: options.codexTimeoutMs,
        tmpRoot
      })
    );
  }
  const passCount = cells.filter((cell) => cell.status === 'pass').length;
  const failCount = cells.filter((cell) => cell.status === 'fail').length;
  const ledger = {
    status:
      failCount === 0 && passCount >= options.minRepos
        ? passStatus
        : failStatus,
    scenario,
    run_id: runId,
    mode: options.existingSourceRepairSmoke
      ? 'real Codex temp-clone broad real project existing source-code repair smoke'
      : options.codexRepairSmoke
        ? 'real Codex temp-clone broad real project source-code repair smoke'
        : options.codexCopySmoke
          ? 'real Codex temp-clone broad real project corpus smoke'
          : options.modifiableCopySmoke
            ? 'safe modifiable-copy broad real project corpus smoke'
            : 'read-only broad real project corpus smoke',
    scope: options.existingSourceRepairSmoke
      ? 'operator-supplied existing git repositories; source repositories remain read-only; each temp clone receives a regression inside an existing tracked JS/Python source file; real Codex must repair that existing source file only; hidden verifier checks sentinel removal, parse/compile pass, diff scope, and source repo integrity; not GitHub draft PR or arbitrary-repo product PASS'
      : options.codexRepairSmoke
        ? 'operator-supplied existing git repositories; source repositories remain read-only; each temp clone receives a dedicated fixture source/test commit; real Codex must repair source code only; hidden verifier checks generalized quantity/discount/tax/rounding behavior, diff scope, and source repo integrity; not GitHub draft PR or arbitrary-repo product PASS'
        : options.codexCopySmoke
          ? 'operator-supplied existing git repositories; source repositories remain read-only; real Codex writes a probe file only inside each temp clone; hidden verifier checks repo-derived values and diff scope; not source-code repair, GitHub draft PR, or arbitrary-repo product PASS'
          : options.modifiableCopySmoke
            ? 'operator-supplied existing git repositories; source repositories remain read-only; each temp clone must accept a write/stage/diff-check/cleanup probe and VibeLoop discover smoke; not LLM modification, hidden acceptance, draft PR, or arbitrary-repo product PASS'
            : 'operator-supplied existing git repositories; read-only metadata, git, and VibeLoop discover smoke only; not LLM modification or arbitrary-repo product PASS',
    read_only:
      !options.modifiableCopySmoke &&
      !options.codexCopySmoke &&
      !options.codexRepairSmoke &&
      !options.existingSourceRepairSmoke,
    source_repos_read_only: true,
    modifiable_copy_smoke: options.modifiableCopySmoke,
    codex_copy_smoke: options.codexCopySmoke,
    codex_repair_smoke:
      options.codexRepairSmoke || options.existingSourceRepairSmoke,
    existing_source_repair_smoke: options.existingSourceRepairSmoke,
    source_code_repair:
      options.codexRepairSmoke || options.existingSourceRepairSmoke,
    existing_source_repair: options.existingSourceRepairSmoke,
    llm_modification:
      options.codexCopySmoke ||
      options.codexRepairSmoke ||
      options.existingSourceRepairSmoke,
    hidden_acceptance:
      options.codexCopySmoke ||
      options.codexRepairSmoke ||
      options.existingSourceRepairSmoke,
    draft_pr: false,
    builder:
      options.codexCopySmoke ||
      options.codexRepairSmoke ||
      options.existingSourceRepairSmoke
        ? {
            real_llm: true,
            provider: 'codex',
            model: options.codexModel,
            via: 'codex-cli'
          }
        : null,
    ...(codexPreflight ? { codex_preflight: codexPreflight } : {}),
    min_repo_count: options.minRepos,
    cell_count: cells.length,
    pass_count: passCount,
    fail_count: failCount,
    cells,
    evidence_missing_count: 0
  };
  const bundle = await writeUatEvidenceBundle({
    scenario,
    runId,
    tmpRoot,
    outputs: [],
    extraFiles: cells.flatMap((cell) => cellExtraFiles(cell)),
    extraJson: {
      'real-project-corpus-cells': cells,
      'real-project-corpus-summary': {
        pass_count: passCount,
        fail_count: failCount,
        min_repo_count: options.minRepos,
        codex_copy_smoke: options.codexCopySmoke,
        codex_repair_smoke: options.codexRepairSmoke,
        existing_source_repair_smoke: options.existingSourceRepairSmoke,
        modifiable_copy_smoke: options.modifiableCopySmoke
      }
    }
  });
  ledger.evidence = {
    evidence_bundle: bundle.bundle_dir,
    evidence_manifest: bundle.manifest_path,
    evidence_copied_count: bundle.copied_count,
    evidence_missing_count: bundle.missing_count
  };
  ledger.evidence_copied_count = bundle.copied_count;
  ledger.evidence_missing_count = bundle.missing_count;
  ledger.ledger = await writeUatEvidenceLedger(bundle, ledger);
  console.log(JSON.stringify(ledger, null, 2));
  process.exit(ledger.status === passStatus ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      redact(
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      )
    );
    process.exit(1);
  });
}
