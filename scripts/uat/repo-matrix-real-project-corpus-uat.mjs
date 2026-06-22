#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
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
const SCENARIO = 'repo-matrix-real-project-corpus-uat';
const PASS_STATUS = 'REAL_PROJECT_CORPUS_PASS';
const FAIL_STATUS = 'REAL_PROJECT_CORPUS_FAIL';
const BLOCKED_EXIT = 20;
const DEFAULT_TIMEOUT_MS = 30_000;

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
      stdio: ['ignore', 'pipe', 'pipe']
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

async function analyzeRepo(repoPath, index) {
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
    failures
  };
}

function parseArgs(argv, env = process.env) {
  const repos = [];
  let minRepos = Number(env.VIBELOOP_REAL_PROJECT_CORPUS_MIN_REPOS ?? 2);
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
    throw new Error(`unknown argument: ${arg}`);
  }
  const envRepos = (env.VIBELOOP_REAL_PROJECT_CORPUS_REPOS ?? '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    repos: [...repos, ...envRepos],
    minRepos: Number.isFinite(minRepos) && minRepos > 0 ? minRepos : 2
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.repos.length < options.minRepos) {
    const report = {
      status: 'blocked',
      scenario: SCENARIO,
      reason: 'REAL_PROJECT_CORPUS_REPOS_REQUIRED',
      required_repo_count: options.minRepos,
      provided_repo_count: options.repos.length,
      next_step:
        'Pass at least two real git repositories with --repo <path> or VIBELOOP_REAL_PROJECT_CORPUS_REPOS before claiming broad real project corpus evidence.'
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(BLOCKED_EXIT);
  }

  const runId = `real-project-corpus-${process.pid}-${Date.now()}`;
  const tmpRoot = path.join(os.tmpdir(), runId);
  await mkdir(tmpRoot, { recursive: true });
  const cells = [];
  for (const [index, repo] of options.repos.entries()) {
    cells.push(await analyzeRepo(repo, index + 1));
  }
  const passCount = cells.filter((cell) => cell.status === 'pass').length;
  const failCount = cells.filter((cell) => cell.status === 'fail').length;
  const ledger = {
    status: failCount === 0 && passCount >= options.minRepos ? PASS_STATUS : FAIL_STATUS,
    scenario: SCENARIO,
    run_id: runId,
    mode: 'read-only broad real project corpus smoke',
    scope:
      'operator-supplied existing git repositories; read-only metadata, git, and VibeLoop discover smoke only; not LLM modification or arbitrary-repo product PASS',
    read_only: true,
    min_repo_count: options.minRepos,
    cell_count: cells.length,
    pass_count: passCount,
    fail_count: failCount,
    cells,
    evidence_missing_count: 0
  };
  const bundle = await writeUatEvidenceBundle({
    scenario: SCENARIO,
    runId,
    tmpRoot,
    outputs: [],
    extraJson: {
      'real-project-corpus-cells': cells,
      'real-project-corpus-summary': {
        pass_count: passCount,
        fail_count: failCount,
        min_repo_count: options.minRepos
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
  process.exit(ledger.status === PASS_STATUS ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exit(1);
  });
}
