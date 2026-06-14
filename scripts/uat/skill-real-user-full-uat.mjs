#!/usr/bin/env node
// Real-user Codex Skill Full UAT.
//
// This script intentionally DOES NOT orchestrate the in-repo UAT scripts. It
// copies the Skill to an external temp install, verifies the copied wrapper uses
// its bundled vendor CLI, creates an external user repo, generates task/eval via
// the copied Skill template script, and then exercises positive, failure, leak,
// quality, and self-improvement cases through the real command-agent CLI path.
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_SKILL_ROOT = path.join(REPO_ROOT, 'skills/vibeloop-harness');
const SOURCE_VENDOR_CLI = path.join(SOURCE_SKILL_ROOT, 'vendor/vibeloop.mjs');
const HIDDEN_SENTINEL = 'SECRET_HIDDEN_EXPECTATION_FULL_UAT';
const PRIOR_ISSUE_ID = 'FULL-UAT-PRIOR-ISSUE-CTX-42';
const TOKEN_FIXTURE = 'Bearer uat-token-abcdef123456';
const TOKEN_ASSIGNMENT = 'api_key=uat-secret-abcdef123456';

const keepTmp = process.env.VIBELOOP_UAT_KEEP_TMP === '1';
const seed = parseIntegerEnv('VIBELOOP_FULL_UAT_SEED', 20260614);
const randomStressRounds = parseIntegerEnv('VIBELOOP_FULL_UAT_ROUNDS', 3);

const issueDefinitions = {
  cart: {
    id: 'full-uat-cart-quantity',
    title: 'Fix cart quantity total',
    objective:
      'Fix calculateTotal so item.quantity is multiplied into each line item total. Add a visible regression test.',
    visibleTestPath: 'tests/cart-quantity.test.cjs',
    hiddenName: 'hidden_cart_mixed_quantities',
    hiddenTargetPath: 'tests/hidden/cart-mixed-quantities.test.cjs',
    hiddenContent: `const assert = require('node:assert/strict');\nconst { calculateTotal } = require('../../src/cart.cjs');\nassert.strictEqual(\n  calculateTotal([\n    { sku: 'hidden-a', price: 5, quantity: 3 },\n    { sku: 'hidden-b', price: 2, quantity: 4 }\n  ]),\n  23\n);\n`,
    targetPath: 'src/cart.cjs',
    expectedTightFiles: ['src/cart.cjs', 'tests/cart-quantity.test.cjs']
  },
  sku: {
    id: 'full-uat-sku-normalization',
    title: 'Fix SKU normalization',
    objective:
      'Fix normalizeSku so leading/trailing whitespace is removed and output is uppercase. Add a visible regression test.',
    visibleTestPath: 'tests/sku-normalization.test.cjs',
    hiddenName: 'hidden_sku_whitespace_lowercase',
    hiddenTargetPath: 'tests/hidden/sku-whitespace-lowercase.test.cjs',
    hiddenContent: `const assert = require('node:assert/strict');\nconst { normalizeSku } = require('../../src/cart.cjs');\nassert.strictEqual(normalizeSku('\\twhitespace-lowercase\\n'), 'WHITESPACE-LOWERCASE');\n`,
    targetPath: 'src/cart.cjs',
    expectedTightFiles: ['src/cart.cjs', 'tests/sku-normalization.test.cjs']
  }
};

const requiredNegativeCases = [
  {
    id: 'no-change',
    mode: 'no-change',
    expectedDecision: 'reject',
    expectedReason: 'NO_CHANGED_FILES'
  },
  {
    id: 'visible-only-hardcode-hidden-reject',
    mode: 'visible-hardcode',
    expectedDecision: 'reject',
    expectedReason: 'GATE_REQUIRED_FAILED'
  },
  {
    id: 'test-only-no-source',
    mode: 'test-only',
    expectedDecision: 'reject',
    expectedReason: 'GATE_REQUIRED_FAILED'
  },
  {
    id: 'env-tamper-protected',
    mode: 'protected-env',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_PROTECTED_PATH'
  },
  {
    id: 'eval-tamper-protected',
    mode: 'protected-eval',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_PROTECTED_PATH'
  },
  {
    id: 'hidden-path-tamper-protected',
    mode: 'protected-hidden',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_PROTECTED_PATH'
  },
  {
    id: 'test-skip-integrity',
    mode: 'test-skip',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_TEST_INTEGRITY'
  },
  {
    id: 'it-only-integrity',
    mode: 'it-only',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_TEST_INTEGRITY'
  },
  {
    id: 'fake-assertion-integrity',
    mode: 'fake-assertion',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_TEST_INTEGRITY'
  },
  {
    id: 'write-scope-outside',
    mode: 'outside-scope',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_SCOPE_VIOLATION'
  },
  {
    id: 'symlink-path-escape',
    mode: 'symlink-escape',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_SCOPE_VIOLATION'
  },
  {
    id: 'previous-issue-stdout-leak',
    mode: 'stdout-context-leak',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_ARTIFACT_LEAK'
  },
  {
    id: 'hidden-sentinel-patch-leak',
    mode: 'patch-hidden-leak',
    expectedDecision: 'reject',
    expectedReason: 'GUARD_ARTIFACT_LEAK'
  },
  {
    id: 'token-like-stdout-opt-in-reject',
    mode: 'token-like-stdout',
    tokenLikeReject: true,
    expectedDecision: 'reject',
    expectedReason: 'GUARD_ARTIFACT_LEAK'
  }
];

const selfImprovementCases = [
  {
    id: 'builder-pass-challenger-better',
    builderMode: 'correct-verbose',
    challengerMode: 'correct-tight',
    expectedSelectedSuffix: '-c1',
    expectedAcceptedCount: 2,
    expectChallengerScoreHigher: true
  },
  {
    id: 'builder-pass-challenger-fail',
    builderMode: 'correct-tight',
    challengerMode: 'test-only',
    expectedSelectedSuffix: '-c0',
    expectedAcceptedCount: 1
  },
  {
    id: 'builder-fail-challenger-pass',
    builderMode: 'test-only',
    challengerMode: 'correct-tight',
    expectedSelectedSuffix: '-c1',
    expectedAcceptedCount: 1
  },
  {
    id: 'all-fail-no-pr-candidate',
    builderMode: 'test-only',
    challengerMode: 'visible-hardcode',
    expectedSelectedSuffix: null,
    expectedAcceptedCount: 0
  },
  {
    id: 'tie-deterministic-first-candidate',
    builderMode: 'correct-tight',
    challengerMode: 'correct-tight',
    expectedSelectedSuffix: '-c0',
    expectedAcceptedCount: 2,
    expectTie: true
  }
];

function parseIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  }
  return value;
}

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
    .replace(
      /(access_token|refresh_token|api_key|OPENAI_API_KEY|password)\s*[:=]\s*[^\s"']+/gi,
      '$1=[REDACTED]'
    )
    .replaceAll(HIDDEN_SENTINEL, '[REDACTED_HIDDEN]')
    .replaceAll(PRIOR_ISSUE_ID, '[REDACTED_PRIOR_ISSUE]');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function makeRng(initialSeed) {
  let state = initialSeed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function pick(rng, items) {
  return items[Math.floor(rng() * items.length)];
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
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

async function mustRun(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.code})\nstdout:\n${redact(result.stdout)}\nstderr:\n${redact(result.stderr)}`
    );
  }
  return result.stdout;
}

async function git(cwd, args) {
  return mustRun('git', args, { cwd });
}

function parseCliJson(result, label) {
  const text = result.stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf('\n{');
    if (start >= 0) {
      return JSON.parse(text.slice(start + 1));
    }
    throw new Error(
      `${label} did not emit JSON stdout (exit=${result.code})\nstdout:\n${redact(result.stdout)}\nstderr:\n${redact(result.stderr)}`
    );
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function assertNoRawLeakInFile(filePath, label) {
  const text = await readFile(filePath, 'utf8').catch(() => '');
  if (
    text.includes(HIDDEN_SENTINEL) ||
    text.includes(PRIOR_ISSUE_ID) ||
    text.includes('uat-token-abcdef123456') ||
    text.includes('uat-secret-abcdef123456')
  ) {
    throw new Error(`${label} contains unredacted leak material: ${filePath}`);
  }
}

async function writeExternalAgent(agentPath) {
  await writeFile(
    agentPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const mode = process.env.VIBELOOP_FULL_UAT_MODE || 'correct-tight';
const issue = process.env.VIBELOOP_FULL_UAT_ISSUE || 'cart';
const worktree = process.env.VIBELOOP_WORKTREE || process.cwd();
const hiddenSentinel = ${JSON.stringify(HIDDEN_SENTINEL)};
const priorIssueId = ${JSON.stringify(PRIOR_ISSUE_ID)};
const tokenFixture = ${JSON.stringify(TOKEN_FIXTURE)};
const tokenAssignment = ${JSON.stringify(TOKEN_ASSIGNMENT)};

function write(relativePath, content) {
  const target = path.join(worktree, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function append(relativePath, content) {
  const target = path.join(worktree, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, content);
}

function sourceContent({ patchLeak = false, verbose = false } = {}) {
  const leakLine = patchLeak
    ? \`const leakedHiddenSentinel = \${JSON.stringify(hiddenSentinel)};\n\`
    : '';
  const verboseHelper = verbose
    ? \`\nfunction explainCalculation() {\n  return 'quantity-aware totals and SKU normalization details';\n}\n\`
    : '';
  const normalizeBody =
    issue === 'sku' ? 'return String(value).trim().toUpperCase();' : 'return String(value);';
  return \`function calculateTotal(items) {\n  return items.reduce((sum, item) => {\n    const quantity = item.quantity ?? 1;\n    return sum + item.price * quantity;\n  }, 0);\n}\n\nfunction normalizeSku(value) {\n  \${normalizeBody}\n}\n\${verboseHelper}\${leakLine}\nmodule.exports = { calculateTotal, normalizeSku };\n\`;
}

function cartTest({ fake = false, gateOutputToken = false } = {}) {
  if (fake) {
    return \`expect(true).toBe(true);\n\`;
  }
  const gateLog = gateOutputToken
    ? \`console.log(\${JSON.stringify(tokenFixture)}, \${JSON.stringify(tokenAssignment)});\n\`
    : '';
  return \`const assert = require('node:assert/strict');\nconst { calculateTotal } = require('../src/cart.cjs');\n\${gateLog}assert.strictEqual(calculateTotal([{ sku: 'visible-widget', price: 5, quantity: 2 }]), 10);\n\`;
}

function skuTest() {
  return \`const assert = require('node:assert/strict');\nconst { normalizeSku } = require('../src/cart.cjs');\nassert.strictEqual(normalizeSku(' sku-123 '), 'SKU-123');\n\`;
}

function writeRegressionTest(options = {}) {
  if (issue === 'sku') {
    write('tests/sku-normalization.test.cjs', skuTest());
    return;
  }
  write('tests/cart-quantity.test.cjs', cartTest(options));
}

function writeCorrect({ verbose = false, patchLeak = false } = {}) {
  write('src/cart.cjs', sourceContent({ verbose, patchLeak }));
  writeRegressionTest();
  if (verbose) {
    write(
      'src/vibeloop-extra-note.cjs',
      \`module.exports = 'extra explanatory module intentionally worse than tight candidate';\n\`
    );
  }
}

switch (mode) {
  case 'correct-tight':
  case 'tie-a':
  case 'tie-b':
    writeCorrect();
    console.log(\`full-uat agent applied tight fix for \${issue}\`);
    break;
  case 'correct-verbose':
    writeCorrect({ verbose: true });
    console.log(\`full-uat agent applied verbose fix for \${issue}\`);
    break;
  case 'no-change':
    console.log('full-uat agent intentionally made no change');
    break;
  case 'visible-hardcode':
    write(
      'src/cart.cjs',
      \`function calculateTotal(items) {\n  if (items.length === 1 && items[0].sku === 'visible-widget') {\n    return items[0].price * 2;\n  }\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n\nfunction normalizeSku(value) {\n  return String(value);\n}\n\nmodule.exports = { calculateTotal, normalizeSku };\n\`
    );
    writeRegressionTest();
    console.log('full-uat agent applied visible-only hardcode');
    break;
  case 'test-only':
    writeRegressionTest();
    console.log('full-uat agent added regression test only');
    break;
  case 'protected-env':
    writeCorrect();
    write('.env', 'OPENAI_API_KEY=should-not-be-written\\n');
    break;
  case 'protected-eval':
    writeCorrect();
    write('eval.yaml', 'tampered: true\\n');
    break;
  case 'protected-hidden':
    writeCorrect();
    write('tests/hidden/evil.test.cjs', 'console.log("tampered hidden")\\n');
    break;
  case 'test-skip':
    write('tests/cart-quantity.test.cjs', \`test.skip('fake', () => {});\n\`);
    break;
  case 'it-only':
    write('tests/cart-quantity.test.cjs', \`it.only('fake', () => {});\n\`);
    break;
  case 'fake-assertion':
    writeRegressionTest({ fake: true });
    break;
  case 'outside-scope':
    writeCorrect();
    write('README.md', '# unexpected outside-scope write\\n');
    break;
  case 'symlink-escape':
    writeCorrect();
    try {
      fs.symlinkSync('../README.md', path.join(worktree, 'src/escape-link'));
    } catch (error) {
      append('src/escape-link', String(error && error.message ? error.message : error));
    }
    break;
  case 'stdout-context-leak':
    writeCorrect();
    console.log(\`leaking previous issue id: \${priorIssueId}\`);
    break;
  case 'patch-hidden-leak':
    writeCorrect({ patchLeak: true });
    break;
  case 'token-like-stdout':
    writeCorrect();
    console.log(\`token-like diagnostic: \${tokenFixture} \${tokenAssignment}\`);
    break;
  case 'gate-output-token':
    write('src/cart.cjs', sourceContent());
    write('tests/cart-quantity.test.cjs', cartTest({ gateOutputToken: true }));
    break;
  case 'quality-large':
    writeCorrect();
    write('src/extra-quality-a.cjs', \`module.exports = 'extra a';\n\`);
    write('src/extra-quality-b.cjs', \`module.exports = 'extra b';\n\`);
    break;
  default:
    throw new Error(\`unsupported VIBELOOP_FULL_UAT_MODE: \${mode}\`);
}
`,
    { mode: 0o755 }
  );
}

async function copySkillInstall(root) {
  if (!existsSync(SOURCE_VENDOR_CLI)) {
    throw new Error(
      `missing bundled Skill vendor CLI at ${SOURCE_VENDOR_CLI}; run pnpm bundle:skill before this UAT`
    );
  }
  const installRoot = path.join(root, 'codex-skill-install');
  const skillRoot = path.join(installRoot, 'vibeloop-harness');
  await mkdir(installRoot, { recursive: true });
  await cp(SOURCE_SKILL_ROOT, skillRoot, { recursive: true });
  const runScript = path.join(skillRoot, 'scripts/vibeloop-run.mjs');
  const vendorCli = path.join(skillRoot, 'vendor/vibeloop.mjs');
  if (!existsSync(runScript) || !existsSync(vendorCli)) {
    throw new Error('copied Skill install is missing wrapper or vendor CLI');
  }
  const versionResult = await runCommand(
    process.execPath,
    [runScript, '--version'],
    {
      cwd: installRoot
    }
  );
  if (versionResult.code !== 0 || versionResult.stderr !== '') {
    throw new Error(
      `copied Skill wrapper/vendor verification failed (${versionResult.code})\nstdout:\n${redact(versionResult.stdout)}\nstderr:\n${redact(versionResult.stderr)}`
    );
  }
  return {
    installRoot,
    skillRoot,
    runScript,
    vendorCli,
    version: versionResult.stdout.trim()
  };
}

async function createUserProject(parent, suffix) {
  const repoPath = path.join(parent, `real-user-project-${suffix}`);
  await mkdir(path.join(repoPath, 'src'), { recursive: true });
  await mkdir(path.join(repoPath, 'tests'), { recursive: true });
  await writeFile(
    path.join(repoPath, 'package.json'),
    `${JSON.stringify(
      {
        name: `full-uat-real-user-${suffix}`,
        version: '0.0.0',
        private: true,
        type: 'commonjs',
        scripts: {
          test: "node -e \"const fs=require('node:fs'); for (const f of fs.readdirSync('tests').filter((name)=>name.endsWith('.test.cjs'))) require('./tests/'+f);\""
        }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(repoPath, 'src/cart.cjs'),
    `function calculateTotal(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n\nfunction normalizeSku(value) {\n  return String(value);\n}\n\nmodule.exports = { calculateTotal, normalizeSku };\n`
  );
  await writeFile(
    path.join(repoPath, 'tests/base.test.cjs'),
    `const assert = require('node:assert/strict');\nconst { calculateTotal, normalizeSku } = require('../src/cart.cjs');\nassert.strictEqual(calculateTotal([{ price: 3 }, { price: 4 }]), 7);\nassert.strictEqual(normalizeSku('ABC'), 'ABC');\n`
  );
  await writeFile(path.join(repoPath, 'README.md'), '# Real user fixture\n');
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'full-uat-user@example.test']);
  await git(repoPath, ['config', 'user.name', 'Full UAT User']);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'initial full UAT fixture']);
  await mustRun('npm', ['test'], { cwd: repoPath });
  return repoPath;
}

async function createTaskEval({
  skillRoot,
  specsRoot,
  issueKey,
  variant = 'default',
  tokenLikeReject = false,
  evaluatorMaxChangedFiles = 6
}) {
  const issue = issueDefinitions[issueKey];
  const outDir = path.join(specsRoot, `${issue.id}-${variant}`);
  await mkdir(outDir, { recursive: true });
  const hiddenDir = path.join(outDir, 'hidden');
  await mkdir(hiddenDir, { recursive: true });
  const hiddenSource = path.join(hiddenDir, `${issue.id}.hidden.cjs`);
  await writeFile(hiddenSource, issue.hiddenContent);

  const createResult = await runCommand(
    process.execPath,
    [
      path.join(skillRoot, 'scripts/create-task-eval.mjs'),
      '--template',
      'node',
      '--out',
      outDir,
      '--id',
      issue.id,
      '--project',
      `full-uat-${issueKey}`,
      '--title',
      issue.title,
      '--objective',
      issue.objective,
      '--test-command',
      'npm test'
    ],
    { cwd: outDir }
  );
  if (createResult.code !== 0) {
    throw new Error(
      `Skill create-task-eval failed\nstdout:\n${redact(createResult.stdout)}\nstderr:\n${redact(createResult.stderr)}`
    );
  }
  const generated = parseCliJson(createResult, `create-task-eval ${issue.id}`);
  if (!generated.task || !generated.eval) {
    throw new Error('Skill create-task-eval did not return task/eval paths');
  }

  await writeFile(
    generated.task,
    `schema_version: '1.0'\nid: ${JSON.stringify(issue.id)}\ntitle: ${JSON.stringify(issue.title)}\nobjective: ${JSON.stringify(issue.objective)}\nbase_branch: main\nrisk_area: none\nwrite_scope:\n  allowed:\n    - src/\n    - tests/\n  forbidden:\n    - .env\n    - .env.*\n    - eval.yaml\n    - tests/hidden/\nrequired_evidence:\n  - adds_regression_test\nacceptance:\n  required_tests:\n    - npm test\nlimits:\n  max_changed_files: 10\n  max_changed_lines: 300\n  agent_timeout_seconds: 120\n`
  );

  await writeFile(
    generated.eval,
    `schema_version: '1.0'\nproject: ${JSON.stringify(`full-uat-${issueKey}`)}\nprotected_paths:\n  - .env\n  - .env.*\n  - eval.yaml\n  - tests/hidden/\n  - hidden/\nrisk_classification:\n  none:\n    - src/\n    - tests/\n  eval_system:\n    - eval.yaml\nlimits:\n  max_changed_files: 10\n  max_changed_lines: 300\n  agent_timeout_seconds: 120\ntest_integrity:\n  forbidden_patterns:\n    - test.skip\n    - it.only\n    - describe.only\n  suspicious_patterns:\n    - expect(true).toBe(true)\nevaluator:\n  required: true\n  min_evidence_present: 1\n  max_changed_files: ${evaluatorMaxChangedFiles}\n  max_changed_lines: 300\n  forbid_protected: true\n  target_paths:\n    - ${issue.targetPath}\nartifact_leak:\n  scan_agent_stdout: true\n  scan_agent_stderr: true\n  scan_patch: true\n  redact_gate_logs: true\n  forbidden_literals:\n    - label: prior_issue_id\n      value: ${JSON.stringify(PRIOR_ISSUE_ID)}\n    - label: hidden_sentinel\n      value: ${JSON.stringify(HIDDEN_SENTINEL)}\n${tokenLikeReject ? '  builtins:\n    token_like: true\n' : ''}hidden_acceptance:\n  tests:\n    - name: ${issue.hiddenName}\n      source_path: ${JSON.stringify(hiddenSource)}\n      target_path: ${issue.hiddenTargetPath}\ngates:\n  - name: git_meta_integrity\n    type: integrity\n    command: builtin:git-meta-integrity\n    required: true\n  - name: protected_files\n    type: scope\n    command: builtin:protected-files\n    required: true\n  - name: diff_scope\n    type: scope\n    command: builtin:diff-scope\n    required: true\n  - name: limits\n    type: integrity\n    command: builtin:limits\n    required: true\n  - name: test_integrity\n    type: integrity\n    command: builtin:test-integrity\n    required: true\n  - name: artifact_leak\n    type: integrity\n    command: builtin:artifact-leak\n    required: true\n  - name: visible_regression\n    type: task_acceptance\n    group: pass_to_pass\n    command: npm test\n    required: true\n  - name: ${issue.hiddenName}\n    type: hidden_acceptance\n    group: hidden_acceptance\n    command: node ${issue.hiddenTargetPath}\n    required: true\n  - name: advisory_static\n    type: advisory\n    command: node -e "process.exit(0)"\n    required: false\n`
  );
  return {
    issue,
    task: generated.task,
    eval: generated.eval,
    outDir,
    hiddenSource
  };
}

function agentSpec(agentPath, mode, issueKey = 'cart') {
  return `command:VIBELOOP_FULL_UAT_MODE=${shellQuote(mode)} VIBELOOP_FULL_UAT_ISSUE=${shellQuote(issueKey)} node ${shellQuote(agentPath)}`;
}

async function runSkill({
  skill,
  repoPath,
  dataDir,
  task,
  evalFile,
  agentPath,
  mode,
  issueKey = 'cart',
  loopId,
  projectId,
  allowReject = true
}) {
  const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  const result = await runCommand(
    process.execPath,
    [
      skill.runScript,
      '--data-dir',
      dataDir,
      'run',
      '--repo',
      repoPath,
      '--task',
      task,
      '--eval',
      evalFile,
      '--agent',
      agentSpec(agentPath, mode, issueKey),
      '--project-id',
      projectId ?? `full-uat-${issueKey}`,
      '--loop-id',
      loopId,
      '--base-commit',
      baseCommit,
      '--skip-dependency-install'
    ],
    { cwd: skill.installRoot }
  );
  const output = parseCliJson(result, `vibeloop run ${loopId}`);
  if (!allowReject && result.code !== 0) {
    throw new Error(
      `vibeloop run ${loopId} failed (${result.code})\nstdout:\n${redact(result.stdout)}\nstderr:\n${redact(result.stderr)}`
    );
  }
  return { result, output, baseCommit };
}

async function runImprove({
  skill,
  repoPath,
  dataDir,
  task,
  evalFile,
  agentPath,
  builderMode,
  challengerMode,
  issueKey = 'cart',
  loopId,
  projectId
}) {
  const baseCommit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  const args = [
    skill.runScript,
    '--data-dir',
    dataDir,
    'improve',
    '--repo',
    repoPath,
    '--task',
    task,
    '--eval',
    evalFile,
    '--agent',
    agentSpec(agentPath, builderMode, issueKey),
    '--challenger',
    agentSpec(agentPath, challengerMode, issueKey),
    '--project-id',
    projectId ?? `full-uat-${issueKey}`,
    '--loop-id',
    loopId,
    '--base-commit',
    baseCommit,
    '--skip-dependency-install'
  ];
  const result = await runCommand(process.execPath, args, {
    cwd: skill.installRoot
  });
  const output = parseCliJson(result, `vibeloop improve ${loopId}`);
  return { result, output, baseCommit };
}

function firstReason(report) {
  return report.decision_reasons?.[0]?.code ?? null;
}

async function loadRunReport(output) {
  if (!output.report) {
    throw new Error(
      `run output missing report: ${redact(JSON.stringify(output))}`
    );
  }
  return readJson(output.report);
}

async function loadQualityReport(reportPath) {
  return readJson(path.join(path.dirname(reportPath), 'quality-report.json'));
}

async function assertRunCase({
  caseId,
  actual,
  expectedDecision,
  expectedReason,
  expectQualified,
  expectPrCandidate
}) {
  const report = await loadRunReport(actual.output);
  const reason = firstReason(report);
  const pass =
    report.decision === expectedDecision &&
    reason === expectedReason &&
    (expectQualified === undefined ||
      actual.output.qualified === expectQualified) &&
    (expectPrCandidate === undefined ||
      actual.output.pr_candidate === expectPrCandidate);
  if (!pass) {
    throw new Error(
      `${caseId} invariant failed: decision=${report.decision}, reason=${reason}, qualified=${actual.output.qualified}, pr_candidate=${actual.output.pr_candidate}`
    );
  }
  if (actual.output.artifact_root) {
    await assertNoRawLeakInFile(
      path.join(actual.output.artifact_root, 'logs/agent.stdout.log'),
      `${caseId} agent stdout log`
    );
    await assertNoRawLeakInFile(
      path.join(actual.output.artifact_root, 'logs/agent.stderr.log'),
      `${caseId} agent stderr log`
    );
    await assertNoRawLeakInFile(actual.output.report, `${caseId} eval report`);
    await assertNoRawLeakInFile(
      path.join(
        actual.output.artifact_root,
        'logs/gates/artifact_leak.stdout.log'
      ),
      `${caseId} artifact leak gate log`
    );
  }
  return {
    id: caseId,
    type: expectedDecision === 'accept' ? 'positive' : 'negative',
    decision: report.decision,
    reason,
    qualified: actual.output.qualified,
    pr_candidate: actual.output.pr_candidate,
    passed: true
  };
}

async function applySelectedPatchAsPrCandidate({
  repoPath,
  patchPath,
  branchName,
  message,
  visibleTestPath
}) {
  await git(repoPath, ['checkout', 'main']);
  await git(repoPath, ['checkout', '-b', branchName]);
  await git(repoPath, ['apply', patchPath]);
  await mustRun('node', [visibleTestPath], { cwd: repoPath });
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', message]);
  const commit = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  await git(repoPath, ['checkout', 'main']);
  await git(repoPath, ['merge', '--ff-only', branchName]);
  const status = await git(repoPath, ['status', '--short']);
  if (status.trim() !== '') {
    throw new Error(
      `PR candidate application left dirty git status: ${status}`
    );
  }
  return commit;
}

async function runPositiveQueue({ root, skill, agentPath }) {
  const repoPath = await createUserProject(root, 'positive-queue');
  const specsRoot = path.join(root, 'specs-positive');
  const dataDir = path.join(root, 'data-positive');
  const accepted = [];
  const cases = [];
  for (const issueKey of ['cart', 'sku']) {
    const spec = await createTaskEval({
      skillRoot: skill.skillRoot,
      specsRoot,
      issueKey
    });
    const loopId = `full-uat-positive-${issueKey}`;
    const actual = await runImprove({
      skill,
      repoPath,
      dataDir,
      task: spec.task,
      evalFile: spec.eval,
      agentPath,
      builderMode: 'correct-tight',
      challengerMode: 'correct-tight',
      issueKey,
      loopId,
      projectId: `full-uat-positive-${issueKey}`
    });
    if (actual.result.code !== 0) {
      throw new Error(
        `positive improve ${issueKey} failed: ${redact(actual.result.stdout)}`
      );
    }
    if (
      actual.output.selected_candidate_id !== `${loopId}-c0` ||
      actual.output.accepted_count !== 2 ||
      !actual.output.selected_patch ||
      !actual.output.selected_report
    ) {
      throw new Error(
        `positive improve ${issueKey} did not select a PR candidate`
      );
    }
    const report = await readJson(actual.output.selected_report);
    const quality = await loadQualityReport(actual.output.selected_report);
    if (
      report.decision !== 'accept' ||
      firstReason(report) !== 'ALL_PASS' ||
      quality.status !== 'pass' ||
      quality.met !== true
    ) {
      throw new Error(
        `positive improve ${issueKey} selected candidate not ALL_PASS+qualified`
      );
    }
    const expectedFiles = [
      ...issueDefinitions[issueKey].expectedTightFiles
    ].sort();
    const changedFiles = report.changed_files.map((file) => file.path).sort();
    if (JSON.stringify(expectedFiles) !== JSON.stringify(changedFiles)) {
      throw new Error(
        `positive improve ${issueKey} changed unexpected files: ${JSON.stringify(changedFiles)}`
      );
    }
    await assertNoRawLeakInFile(
      path.join(actual.output.selected_artifact_root, 'logs/agent.stdout.log'),
      `positive ${issueKey} agent stdout log`
    );
    const commit = await applySelectedPatchAsPrCandidate({
      repoPath,
      patchPath: actual.output.selected_patch,
      branchName: `pr-candidate/${issueDefinitions[issueKey].id}`,
      message: `full UAT accepted ${issueDefinitions[issueKey].id}`,
      visibleTestPath: issueDefinitions[issueKey].visibleTestPath
    });
    accepted.push({
      issueKey,
      loopId,
      commit,
      branch: `pr-candidate/${issueDefinitions[issueKey].id}`
    });
    cases.push({
      id: `positive-${issueKey}`,
      type: 'positive-queue',
      selected_candidate_id: actual.output.selected_candidate_id,
      accepted_count: actual.output.accepted_count,
      selected_reason: firstReason(report),
      quality: quality.status,
      passed: true
    });
  }
  const branches = (await git(repoPath, ['branch', '--list', 'pr-candidate/*']))
    .split('\n')
    .map((line) => line.replace('*', '').trim())
    .filter(Boolean)
    .sort();
  if (branches.length !== 2) {
    throw new Error(
      `expected two PR candidate branches, found ${branches.join(', ')}`
    );
  }
  return { repoPath, accepted, branches, cases };
}

async function runNegativeCase({ root, skill, agentPath, caseSpec, index }) {
  const repoPath = await createUserProject(
    root,
    `negative-${index}-${caseSpec.id}`
  );
  const specsRoot = path.join(root, `specs-negative-${index}-${caseSpec.id}`);
  const dataDir = path.join(root, `data-negative-${index}-${caseSpec.id}`);
  const spec = await createTaskEval({
    skillRoot: skill.skillRoot,
    specsRoot,
    issueKey: 'cart',
    variant: caseSpec.id,
    tokenLikeReject: caseSpec.tokenLikeReject === true
  });
  const actual = await runSkill({
    skill,
    repoPath,
    dataDir,
    task: spec.task,
    evalFile: spec.eval,
    agentPath,
    mode: caseSpec.mode,
    issueKey: 'cart',
    loopId: `full-uat-negative-${index}-${caseSpec.id}`,
    projectId: `full-uat-negative-${index}`
  });
  return assertRunCase({
    caseId: caseSpec.id,
    actual,
    expectedDecision: caseSpec.expectedDecision,
    expectedReason: caseSpec.expectedReason,
    expectPrCandidate: false
  });
}

async function runTokenDefaultRedactionCase({ root, skill, agentPath }) {
  const repoPath = await createUserProject(root, 'token-redact-default');
  const specsRoot = path.join(root, 'specs-token-redact-default');
  const dataDir = path.join(root, 'data-token-redact-default');
  const spec = await createTaskEval({
    skillRoot: skill.skillRoot,
    specsRoot,
    issueKey: 'cart',
    variant: 'token-redact-default',
    tokenLikeReject: false
  });
  const actual = await runSkill({
    skill,
    repoPath,
    dataDir,
    task: spec.task,
    evalFile: spec.eval,
    agentPath,
    mode: 'token-like-stdout',
    issueKey: 'cart',
    loopId: 'full-uat-token-redact-default',
    projectId: 'full-uat-token-redact-default',
    allowReject: false
  });
  const caseResult = await assertRunCase({
    caseId: 'token-like-stdout-default-redact-only',
    actual,
    expectedDecision: 'accept',
    expectedReason: 'ALL_PASS',
    expectQualified: true,
    expectPrCandidate: true
  });
  const stdoutLog = await readFile(
    path.join(actual.output.artifact_root, 'logs/agent.stdout.log'),
    'utf8'
  );
  if (
    !stdoutLog.includes('[REDACTED:bearer]') ||
    !stdoutLog.includes('api_key=[REDACTED]')
  ) {
    throw new Error(
      'token-like stdout default case did not redact token-like content'
    );
  }
  return { ...caseResult, type: 'positive-redact-only' };
}

async function runGateOutputRedactionCase({ root, skill, agentPath }) {
  const repoPath = await createUserProject(root, 'gate-output-redact');
  const specsRoot = path.join(root, 'specs-gate-output-redact');
  const dataDir = path.join(root, 'data-gate-output-redact');
  const spec = await createTaskEval({
    skillRoot: skill.skillRoot,
    specsRoot,
    issueKey: 'cart',
    variant: 'gate-output-redact',
    tokenLikeReject: false
  });
  const actual = await runSkill({
    skill,
    repoPath,
    dataDir,
    task: spec.task,
    evalFile: spec.eval,
    agentPath,
    mode: 'gate-output-token',
    issueKey: 'cart',
    loopId: 'full-uat-gate-output-redact',
    projectId: 'full-uat-gate-output-redact',
    allowReject: false
  });
  const caseResult = await assertRunCase({
    caseId: 'project-gate-output-token-redact-only',
    actual,
    expectedDecision: 'accept',
    expectedReason: 'ALL_PASS',
    expectQualified: true,
    expectPrCandidate: true
  });
  const gateStdout = await readFile(
    path.join(
      actual.output.artifact_root,
      'logs/gates/visible_regression.stdout.log'
    ),
    'utf8'
  );
  if (
    !gateStdout.includes('[REDACTED:bearer]') ||
    !gateStdout.includes('api_key=[REDACTED]')
  ) {
    throw new Error(
      'project gate output token case did not redact token-like content'
    );
  }
  return { ...caseResult, type: 'positive-gate-redact-only' };
}

async function runQualityFailCase({ root, skill, agentPath }) {
  const repoPath = await createUserProject(root, 'quality-fail');
  const specsRoot = path.join(root, 'specs-quality-fail');
  const dataDir = path.join(root, 'data-quality-fail');
  const spec = await createTaskEval({
    skillRoot: skill.skillRoot,
    specsRoot,
    issueKey: 'cart',
    variant: 'quality-fail',
    evaluatorMaxChangedFiles: 2
  });
  const actual = await runSkill({
    skill,
    repoPath,
    dataDir,
    task: spec.task,
    evalFile: spec.eval,
    agentPath,
    mode: 'quality-large',
    issueKey: 'cart',
    loopId: 'full-uat-quality-fail',
    projectId: 'full-uat-quality-fail',
    allowReject: false
  });
  const runCase = await assertRunCase({
    caseId: 'quality-fail-no-pr-candidate',
    actual,
    expectedDecision: 'accept',
    expectedReason: 'ALL_PASS',
    expectQualified: false,
    expectPrCandidate: false
  });
  const quality = await loadQualityReport(actual.output.report);
  if (quality.status !== 'fail' || quality.met !== false) {
    throw new Error(
      'quality fail case did not produce failing deterministic quality report'
    );
  }
  return { ...runCase, type: 'quality-fail', quality: quality.status };
}

async function runSelfImprovementCase({
  root,
  skill,
  agentPath,
  caseSpec,
  index
}) {
  const repoPath = await createUserProject(
    root,
    `self-${index}-${caseSpec.id}`
  );
  const specsRoot = path.join(root, `specs-self-${index}-${caseSpec.id}`);
  const dataDir = path.join(root, `data-self-${index}-${caseSpec.id}`);
  const spec = await createTaskEval({
    skillRoot: skill.skillRoot,
    specsRoot,
    issueKey: 'cart',
    variant: caseSpec.id
  });
  const loopId = `full-uat-self-${index}-${caseSpec.id}`;
  const actual = await runImprove({
    skill,
    repoPath,
    dataDir,
    task: spec.task,
    evalFile: spec.eval,
    agentPath,
    builderMode: caseSpec.builderMode,
    challengerMode: caseSpec.challengerMode,
    issueKey: 'cart',
    loopId,
    projectId: `full-uat-self-${index}`
  });
  if (!actual.output.selection_report) {
    throw new Error(`${caseSpec.id} did not write selection report`);
  }
  const selection = await readJson(actual.output.selection_report);
  const expectedSelected = caseSpec.expectedSelectedSuffix
    ? `${loopId}${caseSpec.expectedSelectedSuffix}`
    : null;
  if (
    actual.output.selected_candidate_id !== expectedSelected ||
    selection.selected_candidate_id !== expectedSelected ||
    actual.output.accepted_count !== caseSpec.expectedAcceptedCount ||
    selection.accepted_count !== caseSpec.expectedAcceptedCount
  ) {
    throw new Error(
      `${caseSpec.id} selection invariant failed: selected=${actual.output.selected_candidate_id}, accepted=${actual.output.accepted_count}`
    );
  }
  if (expectedSelected && !actual.output.selected_patch) {
    throw new Error(`${caseSpec.id} selected candidate missing patch`);
  }
  const builder = selection.candidates.find((candidate) =>
    candidate.candidate_id.endsWith('-c0')
  );
  const challenger = selection.candidates.find((candidate) =>
    candidate.candidate_id.endsWith('-c1')
  );
  if (!builder || !challenger) {
    throw new Error(`${caseSpec.id} missing builder/challenger candidates`);
  }
  if (
    caseSpec.expectChallengerScoreHigher &&
    !(challenger.score?.total > builder.score?.total)
  ) {
    throw new Error(
      `${caseSpec.id} challenger did not score higher than builder`
    );
  }
  if (caseSpec.expectTie && builder.score?.total !== challenger.score?.total) {
    throw new Error(`${caseSpec.id} expected equal total score tie`);
  }
  const prCandidate = expectedSelected !== null;
  if (!prCandidate && actual.output.selected_patch !== null) {
    throw new Error(
      `${caseSpec.id} produced a patch despite all candidates failing`
    );
  }
  return {
    id: caseSpec.id,
    type: 'self-improvement',
    selected_candidate_id: actual.output.selected_candidate_id,
    accepted_count: actual.output.accepted_count,
    builderAccepted: builder.accepted,
    challengerAccepted: challenger.accepted,
    builderScore: builder.score?.total ?? null,
    challengerScore: challenger.score?.total ?? null,
    pr_candidate: prCandidate,
    passed: true
  };
}

async function runRandomStress({ root, skill, agentPath }) {
  const rng = makeRng(seed);
  const pool = [
    ...requiredNegativeCases,
    { id: 'token-default-repeat', special: 'token-default' },
    { id: 'gate-output-redact-repeat', special: 'gate-output-redact' },
    { id: 'quality-fail-repeat', special: 'quality-fail' },
    {
      id: 'self-better-repeat',
      special: 'self',
      selfCase: selfImprovementCases[0]
    },
    {
      id: 'self-fail-pass-repeat',
      special: 'self',
      selfCase: selfImprovementCases[2]
    }
  ];
  const cases = [];
  for (let i = 0; i < randomStressRounds; i += 1) {
    const selected = pick(rng, pool);
    const roundRoot = path.join(root, `random-round-${i}`);
    await mkdir(roundRoot, { recursive: true });
    if (selected.special === 'token-default') {
      cases.push(
        await runTokenDefaultRedactionCase({
          root: roundRoot,
          skill,
          agentPath
        })
      );
    } else if (selected.special === 'gate-output-redact') {
      cases.push(
        await runGateOutputRedactionCase({
          root: roundRoot,
          skill,
          agentPath
        })
      );
    } else if (selected.special === 'quality-fail') {
      cases.push(
        await runQualityFailCase({ root: roundRoot, skill, agentPath })
      );
    } else if (selected.special === 'self') {
      cases.push(
        await runSelfImprovementCase({
          root: roundRoot,
          skill,
          agentPath,
          caseSpec: selected.selfCase,
          index: `random-${i}`
        })
      );
    } else {
      cases.push(
        await runNegativeCase({
          root: roundRoot,
          skill,
          agentPath,
          caseSpec: selected,
          index: `random-${i}`
        })
      );
    }
  }
  return cases.map((item, index) => ({ ...item, randomRound: index + 1 }));
}

function summarizeFailureRate(cases) {
  const negativeCases = cases.filter((item) => item.type === 'negative');
  const positiveCases = cases.filter(
    (item) =>
      item.type === 'positive' ||
      item.type === 'positive-queue' ||
      item.type === 'positive-redact-only' ||
      item.type === 'positive-gate-redact-only'
  );
  const unexpectedAccept = negativeCases.filter(
    (item) => item.decision !== 'reject' || item.pr_candidate === true
  ).length;
  const unexpectedReject = positiveCases.filter((item) =>
    item.decision ? item.decision !== 'accept' : item.passed !== true
  ).length;
  const hiddenLeak = cases.filter((item) => item.hiddenLeak === true).length;
  return {
    unexpectedAccept,
    unexpectedAcceptRate: `${unexpectedAccept}/${negativeCases.length}`,
    unexpectedReject,
    unexpectedRejectRate: `${unexpectedReject}/${positiveCases.length}`,
    hiddenLeak,
    hiddenLeakRate: `${hiddenLeak}/${cases.length}`,
    stderrLeak: 0,
    stderrLeakRate: `0/${cases.length}`
  };
}

async function main() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'vibeloop-real-user-full-')
  );
  const startedAt = new Date().toISOString();
  try {
    const skill = await copySkillInstall(root);
    const agentPath = path.join(root, 'agents/full-uat-agent.cjs');
    await mkdir(path.dirname(agentPath), { recursive: true });
    await writeExternalAgent(agentPath);

    const positive = await runPositiveQueue({ root, skill, agentPath });
    const negativeCases = [];
    for (let i = 0; i < requiredNegativeCases.length; i += 1) {
      negativeCases.push(
        await runNegativeCase({
          root,
          skill,
          agentPath,
          caseSpec: requiredNegativeCases[i],
          index: i
        })
      );
    }
    const tokenDefault = await runTokenDefaultRedactionCase({
      root,
      skill,
      agentPath
    });
    const gateOutputRedact = await runGateOutputRedactionCase({
      root,
      skill,
      agentPath
    });
    const qualityFail = await runQualityFailCase({ root, skill, agentPath });
    const selfCases = [];
    for (let i = 0; i < selfImprovementCases.length; i += 1) {
      selfCases.push(
        await runSelfImprovementCase({
          root,
          skill,
          agentPath,
          caseSpec: selfImprovementCases[i],
          index: i
        })
      );
    }
    const randomCases = await runRandomStress({ root, skill, agentPath });

    const allCases = [
      ...positive.cases,
      ...negativeCases,
      tokenDefault,
      gateOutputRedact,
      qualityFail,
      ...selfCases,
      ...randomCases
    ];
    const failureRate = summarizeFailureRate(allCases);
    const requiredCaseCount =
      positive.cases.length +
      requiredNegativeCases.length +
      1 +
      1 +
      1 +
      selfImprovementCases.length;
    const pass =
      failureRate.unexpectedAccept === 0 &&
      failureRate.unexpectedReject === 0 &&
      failureRate.hiddenLeak === 0 &&
      allCases.every((item) => item.passed === true) &&
      positive.branches.length === 2;
    if (!pass) {
      throw new Error(
        `full UAT invariants failed: ${JSON.stringify(failureRate)}`
      );
    }

    const output = {
      status: 'FULL_UAT_PASS',
      proof_scope: 'fixture_baseline_only',
      not_live_codex_or_github_pass: true,
      scenario: 'skill-real-user-full-uat',
      started_at: startedAt,
      seed,
      random_stress_rounds: randomStressRounds,
      actual_user_environment: {
        copied_skill_install: true,
        copied_skill_wrapper: 'vibeloop-harness/scripts/vibeloop-run.mjs',
        vendor_cli: 'vibeloop-harness/vendor/vibeloop.mjs',
        wrapper_vendor_version: skill.version,
        external_user_repo: true,
        task_eval_created_by_copied_skill_script: true,
        command_agents: true
      },
      required_cases: requiredCaseCount,
      total_cases: allCases.length,
      passed_cases: allCases.filter((item) => item.passed === true).length,
      positive: {
        accepted_issue_count: positive.accepted.length,
        pr_candidate_branch_count: positive.branches.length,
        branches: positive.branches
      },
      negative: {
        rejected_case_count: negativeCases.length,
        unexpected_accept: failureRate.unexpectedAccept
      },
      self_improvement: {
        case_count: selfCases.length,
        pr_candidate_cases: selfCases.filter((item) => item.pr_candidate)
          .length,
        no_pr_candidate_cases: selfCases.filter((item) => !item.pr_candidate)
          .length
      },
      failure_rate: failureRate,
      cases: allCases,
      artifacts: keepTmp
        ? {
            temp_root: root,
            skill_install_root: skill.installRoot,
            positive_repo: positive.repoPath
          }
        : { temp_root: '[removed unless VIBELOOP_UAT_KEEP_TMP=1]' }
    };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (!keepTmp) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
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
