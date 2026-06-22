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
const READ_ONLY_PASS_STATUS = 'REAL_PROJECT_CORPUS_PASS';
const READ_ONLY_FAIL_STATUS = 'REAL_PROJECT_CORPUS_FAIL';
const MODIFIABLE_COPY_PASS_STATUS = 'REAL_PROJECT_MODIFIABLE_CORPUS_PASS';
const MODIFIABLE_COPY_FAIL_STATUS = 'REAL_PROJECT_MODIFIABLE_CORPUS_FAIL';
const CODEX_COPY_PASS_STATUS = 'REAL_PROJECT_CODEX_COPY_PASS';
const CODEX_COPY_FAIL_STATUS = 'REAL_PROJECT_CODEX_COPY_FAIL';
const BLOCKED_EXIT = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_TIMEOUT_MS = 180_000;
const CODEX_PROBE_FILE = '.vibeloop-codex-real-project-probe.json';

function redact(text) {
  return String(text)
    .replace(/https:\/\/([^/\s:@]+):([^@\s]+)@/g, 'https://[REDACTED]@')
    .replace(/(Token|Authorization|Bearer)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [REDACTED]');
}

function slug(value) {
  return String(value)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'repo';
}

function pathHash(value) {
  return createHash('sha256').update(path.resolve(value)).digest('hex').slice(0, 12);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: [options.stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
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
    if (file.endsWith('.ts') || file.endsWith('.tsx')) languages.add('typescript');
    else if (file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.mjs') || file.endsWith('.jsx')) languages.add('javascript');
    else if (file.endsWith('.py')) languages.add('python');
    else if (file.endsWith('.rb')) languages.add('ruby');
    else if (file.endsWith('.java')) languages.add('java');
    else if (file.endsWith('.kt') || file.endsWith('.kts')) languages.add('kotlin');
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
  if (files.some((file) => file.startsWith('packages/'))) markers.push('packages/');
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
    const result = await runCommand(command[0], command.slice(1), { cwd: repoPath });
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
    write_probe_detected: statusAfterWrite.code === 0 && Boolean(statusAfterWrite.stdout.trim()),
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

async function runCodexProbe({ clonePath, probeId, model, timeoutMs, logDir }) {
  const outputFile = path.join(logDir, `${probeId}-last-message.txt`);
  const prompt = buildCodexProbePrompt({ probeId });
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
    path.join(logDir, `${probeId}-stdout.log`),
    redact(result.stdout)
  );
  const stderrFile = await writeTextFile(
    path.join(logDir, `${probeId}-stderr.log`),
    redact(result.stderr)
  );
  return {
    ...result,
    output_file: outputFile,
    stdout_file: stdoutFile,
    stderr_file: stderrFile
  };
}

async function runCodexCopySmoke(sourceRepoPath, cellId, tmpRoot, options = {}) {
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
    probeJson?.notes !==
    'real Codex wrote this file in a temporary copy only'
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
  if (checks.some((check) => check.status !== 'pass')) failures.push('metadata_smoke_failed');

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
  if (candidateCount !== 0) failures.push('discover_smoke_expected_zero_candidates');
  const modifiableCopy = options.modifiableCopySmoke
    ? await runModifiableCopySmoke(resolved, `${index}-${id}`, options.tmpRoot)
    : null;
  if (modifiableCopy && modifiableCopy.status !== 'pass') {
    failures.push('modifiable_copy_smoke_failed');
  }
  const codexCopy = options.codexCopySmoke
    ? await runCodexCopySmoke(resolved, `${index}-${id}`, options.tmpRoot, options)
    : null;
  if (codexCopy && codexCopy.status !== 'pass') {
    failures.push('codex_copy_smoke_failed');
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
    markers.includes('pyproject.toml') || markers.includes('requirements.txt') ? 'python-project' : null,
    markers.includes('Cargo.toml') ? 'rust-project' : null,
    markers.includes('go.mod') ? 'go-project' : null,
    markers.includes('build.gradle') || markers.includes('build.gradle.kts') ? 'gradle-project' : null,
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenario = options.codexCopySmoke
    ? CODEX_COPY_SCENARIO
    : options.modifiableCopySmoke
    ? MODIFIABLE_COPY_SCENARIO
    : READ_ONLY_SCENARIO;
  const passStatus = options.codexCopySmoke
    ? CODEX_COPY_PASS_STATUS
    : options.modifiableCopySmoke
    ? MODIFIABLE_COPY_PASS_STATUS
    : READ_ONLY_PASS_STATUS;
  const failStatus = options.codexCopySmoke
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
  if (options.codexCopySmoke) {
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
        codexModel: options.codexModel,
        codexTimeoutMs: options.codexTimeoutMs,
        tmpRoot
      })
    );
  }
  const passCount = cells.filter((cell) => cell.status === 'pass').length;
  const failCount = cells.filter((cell) => cell.status === 'fail').length;
  const ledger = {
    status: failCount === 0 && passCount >= options.minRepos ? passStatus : failStatus,
    scenario,
    run_id: runId,
    mode: options.codexCopySmoke
      ? 'real Codex temp-clone broad real project corpus smoke'
      : options.modifiableCopySmoke
      ? 'safe modifiable-copy broad real project corpus smoke'
      : 'read-only broad real project corpus smoke',
    scope:
      options.codexCopySmoke
        ? 'operator-supplied existing git repositories; source repositories remain read-only; real Codex writes a probe file only inside each temp clone; hidden verifier checks repo-derived values and diff scope; not source-code repair, GitHub draft PR, or arbitrary-repo product PASS'
        : options.modifiableCopySmoke
        ? 'operator-supplied existing git repositories; source repositories remain read-only; each temp clone must accept a write/stage/diff-check/cleanup probe and VibeLoop discover smoke; not LLM modification, hidden acceptance, draft PR, or arbitrary-repo product PASS'
        : 'operator-supplied existing git repositories; read-only metadata, git, and VibeLoop discover smoke only; not LLM modification or arbitrary-repo product PASS',
    read_only: !options.modifiableCopySmoke && !options.codexCopySmoke,
    source_repos_read_only: true,
    modifiable_copy_smoke: options.modifiableCopySmoke,
    codex_copy_smoke: options.codexCopySmoke,
    llm_modification: options.codexCopySmoke,
    hidden_acceptance: options.codexCopySmoke,
    draft_pr: false,
    builder: options.codexCopySmoke
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
    extraFiles: cells.flatMap((cell) =>
      cell.codex_copy
        ? [
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
          ]
        : []
    ),
    extraJson: {
      'real-project-corpus-cells': cells,
      'real-project-corpus-summary': {
        pass_count: passCount,
        fail_count: failCount,
        min_repo_count: options.minRepos,
        codex_copy_smoke: options.codexCopySmoke,
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
    console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exit(1);
  });
}
