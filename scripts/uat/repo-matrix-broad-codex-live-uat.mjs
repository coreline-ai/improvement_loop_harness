#!/usr/bin/env node
// Broad representative LIVE UAT for framework-like repo-diversity cells.
//
// This promotes four controlled framework-shaped matrix cells into real
// GitHub + real Codex lanes: React/Next-like, Django-like, Rails-like, and
// Android/Gradle-like.
// It is broader than the single Python/monorepo representative lanes, but it is
// still a representative controlled corpus, not an arbitrary-user-repo PASS.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const SCENARIO = 'repo-matrix-broad-codex-live-uat';
const PASS_STATUS = 'BROAD_LIVE_REPRESENTATIVE_PASS';
const NO_PR_STATUS = 'BROAD_LIVE_REPRESENTATIVE_NO_PR';

function javaTool(name) {
  const override = process.env[name === 'javac' ? 'JAVAC' : 'JAVA'];
  if (override) return override;
  if (process.env.JAVA_HOME) return path.join(process.env.JAVA_HOME, 'bin', name);
  return name;
}

const CELL_IDS = [
  'react-next-like',
  'django-like-service',
  'rails-like-service',
  'android-gradle-like'
];

const requestedCells = (
  process.env.VIBELOOP_REPO_MATRIX_BROAD_LIVE_CELLS || CELL_IDS.join(',')
)
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

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

async function writeFiles(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
}

function djangoScenario() {
  const visibleCommand = 'python3 tests/test_cart_view.py';
  return {
    id: 'django-like-service',
    label: 'Django-like Python service',
    repoPrefix: 'vibeloop-django-live',
    projectId: 'broad-django-live',
    runtimeChecks: [{ command: 'python3', args: ['--version'] }],
    branchSlug: 'django-cart-render',
    commitMessage: 'vibeloop: real-codex verified fix (django-like cart render)',
    prTitle: '[VibeLoop] real-codex verified fix: Django-like cart render',
    mode: 'representative broad live cell (django-like python service)',
    expectedPrFiles: [
      'shop/cart.py',
      'tests/test_cart_base.py',
      'tests/test_cart_view.py'
    ],
    files: {
      'README.md': [
        '# Django-like Cart Render Scenario',
        '',
        'A small Django-shaped Python service with a cart rendering bug.',
        'Missing quantity means 1, and quantity 0 is a valid zero total.',
        ''
      ].join('\n'),
      'manage.py': [
        '#!/usr/bin/env python3',
        'import sys',
        '',
        'if __name__ == "__main__":',
        '    print("django-like fixture", " ".join(sys.argv[1:]))',
        ''
      ].join('\n'),
      'shop/__init__.py': '',
      'shop/cart.py': [
        'def render_line(item):',
        '    return f"{item[\'name\']}: ${item[\'price\']}"',
        ''
      ].join('\n'),
      'tests/test_cart_base.py': [
        'import sys',
        "sys.path.insert(0, '.')",
        'from shop.cart import render_line',
        '',
        'assert render_line({"name": "Widget", "price": 4}) == "Widget: $4"',
        ''
      ].join('\n'),
      'hidden/cart_view.hidden.py': [
        `# ${HIDDEN}`,
        'import sys',
        "sys.path.insert(0, '.')",
        'from shop.cart import render_line',
        '',
        'rendered = render_line({"name": "Widget", "price": 4, "quantity": 3})',
        'assert "x3" in rendered',
        'assert "$12" in rendered',
        'zero = render_line({"name": "Zero", "price": 5, "quantity": 0})',
        'assert "x0" in zero',
        'assert "$0" in zero',
        ''
      ].join('\n')
    },
    task: {
      id: 'real-user-django-like-cart-render',
      title: 'Django-like cart line render respects quantity',
      objective:
        'Fix the Django-like cart renderer so item quantity is included, missing quantity defaults to 1, quantity 0 is valid, and add tests/test_cart_view.py that fails on the base commit and passes on the candidate.',
      writeScope: ['shop/', 'tests/'],
      requiredTest: visibleCommand,
      maxChangedFiles: 6,
      maxChangedLines: 180
    },
    eval: {
      project: 'real-user-django-like-cart-render',
      targetPaths: ['shop/cart.py'],
      visibleCommand,
      hidden: {
        name: 'hidden_django_cart_view_mixed_quantities',
        sourcePath: 'hidden/cart_view.hidden.py',
        targetPath: 'tests/hidden/test_cart_view_hidden.py',
        command: 'python3 tests/hidden/test_cart_view_hidden.py'
      }
    }
  };
}

function reactNextScenario() {
  const visibleCommand = 'node tests/cart-view.test.cjs';
  return {
    id: 'react-next-like',
    label: 'React/Next-like frontend utility',
    repoPrefix: 'vibeloop-react-live',
    projectId: 'broad-react-live',
    runtimeChecks: [{ command: process.execPath, args: ['--version'] }],
    branchSlug: 'react-cart-view',
    commitMessage: 'vibeloop: real-codex verified fix (react-like cart view)',
    prTitle: '[VibeLoop] real-codex verified fix: React-like cart view',
    mode: 'representative broad live cell (react-next-like frontend utility)',
    expectedPrFiles: ['app/cart-view.cjs', 'tests/cart-view.test.cjs'],
    optionalPrFiles: ['tests/cart-view-base.test.cjs'],
    files: {
      'README.md': [
        '# React/Next-like Cart View Scenario',
        '',
        'A tiny frontend-shaped Node utility with a cart line rendering bug.',
        'Missing quantity means 1, and quantity 0 is a valid zero total.',
        ''
      ].join('\n'),
      'package.json': [
        '{',
        '  "scripts": {',
        '    "test": "node tests/cart-view.test.cjs"',
        '  }',
        '}',
        ''
      ].join('\n'),
      'app/cart-view.cjs': [
        'function renderLine(item) {',
        '  return `${item.name}: $${item.price}`;',
        '}',
        '',
        'module.exports = { renderLine };',
        ''
      ].join('\n'),
      'tests/cart-view-base.test.cjs': [
        "const { renderLine } = require('../app/cart-view.cjs');",
        '',
        "if (renderLine({ name: 'Widget', price: 4 }) !== 'Widget: $4') {",
        "  throw new Error('base render changed unexpectedly');",
        '}',
        ''
      ].join('\n'),
      'hidden/cart-view.hidden.cjs': [
        `// ${HIDDEN}`,
        "const { renderLine } = require('../../app/cart-view.cjs');",
        '',
        "const quantity = renderLine({ name: 'Widget', price: 4, quantity: 3 });",
        "if (!quantity.includes('x3')) throw new Error('quantity missing');",
        "if (!quantity.includes('$12')) throw new Error('line total missing');",
        '',
        "const zero = renderLine({ name: 'Zero', price: 5, quantity: 0 });",
        "if (!zero.includes('x0')) throw new Error('zero quantity missing');",
        "if (!zero.includes('$0')) throw new Error('zero total missing');",
        '',
        "const fallback = renderLine({ name: 'Solo', price: 7 });",
        "if (!fallback.includes('x1')) throw new Error('default quantity missing');",
        "if (!fallback.includes('$7')) throw new Error('default total missing');",
        ''
      ].join('\n')
    },
    task: {
      id: 'real-user-react-like-cart-view',
      title: 'React-like cart view render respects quantity',
      objective:
        'Fix the React/Next-like cart renderer so item quantity is included in the rendered line, missing quantity defaults to 1, quantity 0 is valid, line total uses price * quantity, and add tests/cart-view.test.cjs that fails on the base commit and passes on the candidate.',
      writeScope: ['app/', 'tests/'],
      requiredTest: visibleCommand,
      maxChangedFiles: 6,
      maxChangedLines: 180
    },
    eval: {
      project: 'real-user-react-like-cart-view',
      targetPaths: ['app/cart-view.cjs'],
      visibleCommand,
      hidden: {
        name: 'hidden_react_cart_view_mixed_quantities',
        sourcePath: 'hidden/cart-view.hidden.cjs',
        targetPath: 'tests/hidden/cart-view.hidden.cjs',
        command: 'node tests/hidden/cart-view.hidden.cjs'
      }
    }
  };
}

function railsScenario() {
  const visibleCommand = 'ruby test/models/cart_line_test.rb';
  return {
    id: 'rails-like-service',
    label: 'Rails-like Ruby service',
    repoPrefix: 'vibeloop-rails-live',
    projectId: 'broad-rails-live',
    runtimeChecks: [{ command: 'ruby', args: ['--version'] }],
    branchSlug: 'rails-cart-line',
    commitMessage: 'vibeloop: real-codex verified fix (rails-like cart line)',
    prTitle: '[VibeLoop] real-codex verified fix: Rails-like cart line',
    mode: 'representative broad live cell (rails-like ruby service)',
    expectedPrFiles: [
      'app/models/cart_line.rb',
      'test/models/cart_line_test.rb'
    ],
    files: {
      'README.md': [
        '# Rails-like Cart Line Scenario',
        '',
        'A tiny Rails-shaped Ruby service with a cart line total bug.',
        ''
      ].join('\n'),
      'app/models/cart_line.rb': [
        'class CartLine',
        '  def self.total(price:, quantity: nil)',
        '    price',
        '  end',
        'end',
        ''
      ].join('\n'),
      'config/application.rb': [
        'module CartApp',
        '  class Application',
        '  end',
        'end',
        ''
      ].join('\n'),
      'test/models/cart_line_base_test.rb': [
        "require_relative '../../app/models/cart_line'",
        "abort('base default failed') unless CartLine.total(price: 4) == 4",
        ''
      ].join('\n'),
      'hidden/cart_line.hidden.rb': [
        `# ${HIDDEN}`,
        "require_relative '../../app/models/cart_line'",
        "abort('quantity not applied') unless CartLine.total(price: 4, quantity: 3) == 12",
        "abort('zero quantity broken') unless CartLine.total(price: 5, quantity: 0) == 0",
        "abort('default quantity broken') unless CartLine.total(price: 4) == 4",
        ''
      ].join('\n')
    },
    task: {
      id: 'real-user-rails-like-cart-line',
      title: 'Rails-like cart line total respects quantity',
      objective:
        'Fix the Rails-like CartLine.total so quantity is applied, nil quantity defaults to 1, quantity 0 is valid, and add test/models/cart_line_test.rb that fails on the base commit and passes on the candidate.',
      writeScope: ['app/models/', 'test/'],
      requiredTest: visibleCommand,
      maxChangedFiles: 6,
      maxChangedLines: 180
    },
    eval: {
      project: 'real-user-rails-like-cart-line',
      targetPaths: ['app/models/cart_line.rb'],
      visibleCommand,
      hidden: {
        name: 'hidden_rails_cart_line_mixed_quantities',
        sourcePath: 'hidden/cart_line.hidden.rb',
        targetPath: 'test/hidden/cart_line_hidden_test.rb',
        command: 'ruby test/hidden/cart_line_hidden_test.rb'
      }
    }
  };
}

function androidScenario() {
  const javac = javaTool('javac');
  const java = javaTool('java');
  const visibleCommand = [
    'rm -rf out',
    'mkdir -p out',
    `${javac} -d out app/src/main/java/com/example/cart/CartLine.java app/src/test/java/com/example/cart/CartLineTest.java`,
    `${java} -cp out com.example.cart.CartLineTest`
  ].join(' && ');
  const hiddenCommand = [
    'rm -rf out-hidden',
    'mkdir -p out-hidden',
    `${javac} -d out-hidden app/src/main/java/com/example/cart/CartLine.java app/src/test/java/com/example/cart/hidden/CartLineHiddenTest.java`,
    `${java} -cp out-hidden com.example.cart.CartLineHiddenTest`
  ].join(' && ');
  return {
    id: 'android-gradle-like',
    label: 'Android/Gradle-like Java module',
    repoPrefix: 'vibeloop-android-live',
    projectId: 'broad-android-live',
    runtimeChecks: [
      { command: javac, args: ['-version'] },
      { command: java, args: ['-version'] }
    ],
    branchSlug: 'android-cart-line',
    commitMessage: 'vibeloop: real-codex verified fix (android-like cart line)',
    prTitle: '[VibeLoop] real-codex verified fix: Android-like cart line',
    mode: 'representative broad live cell (android-gradle-like java module)',
    expectedPrFiles: [
      'app/src/main/java/com/example/cart/CartLine.java',
      'app/src/test/java/com/example/cart/CartLineTest.java'
    ],
    files: {
      'README.md': [
        '# Android/Gradle-like Cart Line Scenario',
        '',
        'A tiny Android-shaped Java module with a cart line total bug.',
        'The UAT compiles with javac to avoid requiring the Android SDK.',
        ''
      ].join('\n'),
      'settings.gradle':
        'pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\n',
      'build.gradle':
        'plugins { id "com.android.application" version "8.7.0" apply false }\n',
      'app/build.gradle': 'plugins { id "com.android.application" }\n',
      'app/src/main/AndroidManifest.xml':
        '<manifest xmlns:android="http://schemas.android.com/apk/res/android" />\n',
      'app/src/main/java/com/example/cart/CartLine.java': [
        'package com.example.cart;',
        '',
        'public final class CartLine {',
        '  private CartLine() {}',
        '',
        '  public static int total(int price, int quantity) {',
        '    return price;',
        '  }',
        '}',
        ''
      ].join('\n'),
      'hidden/CartLineHiddenTest.java': [
        `// ${HIDDEN}`,
        'package com.example.cart;',
        '',
        'public final class CartLineHiddenTest {',
        '  public static void main(String[] args) {',
        '    assertEquals(12, CartLine.total(4, 3), "quantity not applied");',
        '    assertEquals(0, CartLine.total(5, 0), "zero quantity broken");',
        '    assertEquals(4, CartLine.total(4), "default quantity broken");',
        '  }',
        '',
        '  private static void assertEquals(int expected, int actual, String message) {',
        '    if (expected != actual) {',
        '      throw new AssertionError(message + ": expected " + expected + ", got " + actual);',
        '    }',
        '  }',
        '}',
        ''
      ].join('\n')
    },
    task: {
      id: 'real-user-android-like-cart-line',
      title: 'Android-like cart line total respects quantity',
      objective:
        'Fix the Android-like Java CartLine.total so quantity is applied, add an overload where missing quantity defaults to 1, quantity 0 is valid, and add app/src/test/java/com/example/cart/CartLineTest.java that fails on the base commit and passes on the candidate.',
      writeScope: ['app/src/main/java/', 'app/src/test/java/'],
      requiredTest: visibleCommand,
      maxChangedFiles: 7,
      maxChangedLines: 220
    },
    eval: {
      project: 'real-user-android-like-cart-line',
      targetPaths: ['app/src/main/java/com/example/cart/CartLine.java'],
      visibleCommand,
      hidden: {
        name: 'hidden_android_cart_line_mixed_quantities',
        sourcePath: 'hidden/CartLineHiddenTest.java',
        targetPath:
          'app/src/test/java/com/example/cart/hidden/CartLineHiddenTest.java',
        command: hiddenCommand
      }
    }
  };
}

const SCENARIOS = new Map(
  [
    reactNextScenario(),
    djangoScenario(),
    railsScenario(),
    androidScenario()
  ].map((scenario) => [scenario.id, scenario])
);

function yamlSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function taskYaml(scenario) {
  return [
    "schema_version: '1.0'",
    `id: ${scenario.task.id}`,
    `title: ${scenario.task.title}`,
    `objective: ${scenario.task.objective}`,
    'base_branch: main',
    'risk_area: none',
    'write_scope:',
    '  allowed:',
    ...scenario.task.writeScope.map((scope) => `    - ${scope}`),
    'required_evidence:',
    '  - adds_regression_test',
    'acceptance:',
    '  required_tests:',
    `    - ${yamlSingleQuote(scenario.task.requiredTest)}`,
    'limits:',
    `  max_changed_files: ${scenario.task.maxChangedFiles}`,
    `  max_changed_lines: ${scenario.task.maxChangedLines}`,
    '  agent_timeout_seconds: 180',
    ''
  ].join('\n');
}

function evalYaml(scenario) {
  return [
    "schema_version: '1.0'",
    `project: ${scenario.eval.project}`,
    'protected_paths:',
    '  - .env',
    '  - .env.*',
    '  - eval.yaml',
    'risk_classification:',
    '  none:',
    ...scenario.task.writeScope.map((scope) => `    - ${scope}`),
    'limits:',
    `  max_changed_files: ${scenario.task.maxChangedFiles}`,
    `  max_changed_lines: ${scenario.task.maxChangedLines}`,
    '  agent_timeout_seconds: 180',
    'test_integrity:',
    '  forbidden_patterns:',
    '    - test.skip',
    '    - it.only',
    '    - describe.only',
    '    - pytest.mark.skip',
    '    - unittest.skip',
    '  suspicious_patterns:',
    '    - assert True',
    '    - expect(true).toBe(true)',
    'evaluator:',
    '  min_evidence_present: 1',
    `  max_changed_files: ${scenario.task.maxChangedFiles}`,
    `  max_changed_lines: ${scenario.task.maxChangedLines}`,
    '  forbid_protected: true',
    '  target_paths:',
    ...scenario.eval.targetPaths.map((targetPath) => `    - ${targetPath}`),
    'execution:',
    '  isolation: none',
    'hidden_acceptance:',
    '  tests:',
    `    - name: ${scenario.eval.hidden.name}`,
    `      source_path: ${scenario.eval.hidden.sourcePath}`,
    `      target_path: ${scenario.eval.hidden.targetPath}`,
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
    '  - name: visible_regression',
    '    type: task_acceptance',
    `    command: ${yamlSingleQuote(scenario.eval.visibleCommand)}`,
    '    required: true',
    `  - name: ${scenario.eval.hidden.name}`,
    '    type: hidden_acceptance',
    '    group: hidden_acceptance',
    `    command: ${yamlSingleQuote(scenario.eval.hidden.command)}`,
    '    required: true',
    ''
  ].join('\n');
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

async function verifyDraftPr({
  fullRepo,
  prUrl,
  branch,
  expectedFiles,
  optionalFiles = []
}) {
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
  const allowed = [...new Set([...expectedFiles, ...optionalFiles])].sort();
  const requiredFilesPresent = expected.every((file) => files.includes(file));
  const noUnexpectedFiles = files.every((file) => allowed.includes(file));
  const filesMatch = requiredFilesPresent && noUnexpectedFiles;
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
    expected_files: expected,
    optional_files: [...optionalFiles].sort(),
    allowed_files: allowed,
    required_files_present: requiredFilesPresent,
    no_unexpected_files: noUnexpectedFiles
  };
}

async function seedScenarioRepo({ scenario, localRepo }) {
  await writeFiles(localRepo, scenario.files);
  await writeFile(path.join(localRepo, 'task.yaml'), taskYaml(scenario));
  await writeFile(path.join(localRepo, 'eval.yaml'), evalYaml(scenario));
  await git(localRepo, ['init', '-b', 'main']);
  await git(localRepo, [
    'config',
    'user.email',
    `realuser-${scenario.id}@example.test`
  ]);
  await git(localRepo, [
    'config',
    'user.name',
    `VibeLoop ${scenario.label} Real User`
  ]);
  await git(localRepo, ['add', '-A']);
  await git(localRepo, [
    'commit',
    '-m',
    `seed: ${scenario.id} quantity bug + base test`
  ]);
  return (await git(localRepo, ['rev-parse', 'HEAD'])).trim();
}

async function runScenario({ scenario, tag, tmpRoot, dataDir, agentSpec, tokenBudgetArgs }) {
  const repoName = `${scenario.repoPrefix}-${tag}`;
  const fullRepo = `${owner}/${repoName}`;
  const cellRoot = path.join(tmpRoot, scenario.id);
  const localRepo = path.join(cellRoot, 'project');
  const logs = {
    stdout: path.join(cellRoot, 'improve.stdout.log'),
    stderr: path.join(cellRoot, 'improve.stderr.log')
  };
  await mkdir(localRepo, { recursive: true });

  const baseCommit = await seedScenarioRepo({ scenario, localRepo });
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
    return {
      id: scenario.id,
      status: 'blocked',
      reason: 'GH_REPO_CREATE_FAILED',
      stderr: created.stderr.trim(),
      github: { repo: fullRepo, url: `https://github.com/${fullRepo}` },
      logs
    };
  }

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
    scenario.projectId,
    '--loop-id',
    `${scenario.projectId}-${tag}`,
    '--base-commit',
    baseCommit,
    ...tokenBudgetArgs,
    '--skip-dependency-install'
  ]);
  await writeFile(logs.stdout, redact(cli.stdout));
  await writeFile(logs.stderr, redact(cli.stderr));
  const out = parseCliJson(cli.stdout);
  const selectionOutput =
    out.selection_report && existsSync(out.selection_report)
      ? JSON.parse(await readFile(out.selection_report, 'utf8'))
      : null;
  const selected = await loadSelectedReport(out);

  let prUrl = null;
  let branch = null;
  if (selected.prCandidate && out.selected_patch && existsSync(out.selected_patch)) {
    branch = `pr-candidate/${scenario.branchSlug}-${tag}`;
    await git(localRepo, ['checkout', '-b', branch, baseCommit]);
    await git(localRepo, ['apply', out.selected_patch]);
    await git(localRepo, ['add', '-A']);
    await git(localRepo, ['commit', '-m', scenario.commitMessage]);
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
      scenario.prTitle,
      '--body',
      `Generated by a real Codex (${model}) builder and selected by the deterministic Arbiter.\nVerified: accept / ALL_PASS / qualified, including hidden acceptance for ${scenario.label}. Opened by ${SCENARIO}.`
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
    expectedFiles: scenario.expectedPrFiles,
    optionalFiles: scenario.optionalPrFiles ?? []
  });
  const mainHead = (
    await git(localRepo, ['ls-remote', 'origin', 'refs/heads/main'])
  )
    .trim()
    .split(/\s+/)[0];
  const mainUnchanged = mainHead === baseCommit;
  const passed = selected.prCandidate && prVerification.confirmed && mainUnchanged;

  return {
    id: scenario.id,
    label: scenario.label,
    status: passed ? 'pass' : 'no_pr',
    mode: scenario.mode,
    builder: { real_llm: true, model, via: 'chatgpt-oauth-proxy' },
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
    expected_pr_files: scenario.expectedPrFiles,
    optional_pr_files: scenario.optionalPrFiles ?? [],
    draft_pr_view: prVerification,
    false_pass: 0,
    leak: selected.leak ? 1 : 0,
    cli_exit: cli.code,
    evidence: {
      selection_report: out.selection_report,
      selected_report: out.selected_report,
      local_repo: localRepo
    },
    outputs: selectionOutput ? [selectionOutput] : [],
    output: out,
    logs
  };
}

function publicCellResult(cell) {
  const publicCell = { ...cell };
  delete publicCell.outputs;
  delete publicCell.output;
  delete publicCell.logs;
  return publicCell;
}

async function main() {
  const selectedScenarios = requestedCells.map((id) => {
    const scenario = SCENARIOS.get(id);
    if (!scenario) {
      throw new Error(`unknown broad live cell: ${id}; known: ${CELL_IDS.join(', ')}`);
    }
    return scenario;
  });

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
  for (const scenario of selectedScenarios) {
    for (const check of scenario.runtimeChecks) {
      if ((await run(check.command, check.args)).code !== 0) {
        return blocked('RUNTIME_NOT_AVAILABLE', {
          cell: scenario.id,
          command: check.command
        });
      }
    }
  }

  const tag = `${process.pid}-${Date.now()}`;
  const tmpRoot = await mkdtemp(path.join(os.homedir(), '.vibeloop-broad-live-'));
  const dataDir = path.join(tmpRoot, 'data');
  await mkdir(dataDir, { recursive: true });

  let proxy;
  const remoteRepos = [];
  try {
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

    const cells = [];
    for (const scenario of selectedScenarios) {
      const result = await runScenario({
        scenario,
        tag,
        tmpRoot,
        dataDir,
        agentSpec,
        tokenBudgetArgs
      });
      if (result.github?.repo) remoteRepos.push(result.github.repo);
      cells.push(result);
    }

    const passed = cells.every((cell) => cell.status === 'pass');
    const leakCount = cells.filter((cell) => cell.leak).length;
    const status = passed && leakCount === 0 ? PASS_STATUS : NO_PR_STATUS;
    const ledger = {
      status,
      scenario: SCENARIO,
      run_id: `broad-realuser-live-${tag}`,
      mode: 'broad representative repo-diversity live cells',
      scope:
        'controlled React/Next-like/Django-like/Rails-like/Android-like repos promoted to real GitHub + real Codex lanes; not arbitrary-user-repo PASS',
      requested_cells: selectedScenarios.map((scenario) => scenario.id),
      cell_count: cells.length,
      pass_count: cells.filter((cell) => cell.status === 'pass').length,
      fail_count: cells.filter((cell) => cell.status !== 'pass').length,
      builder: { real_llm: true, model, via: 'chatgpt-oauth-proxy' },
      token_budget: tokenBudgetLedger(),
      proxy_auth_header_seen: proxy?.stats?.auth_header_seen ?? null,
      cells: cells.map((cell) => publicCellResult(cell)),
      false_pass: 0,
      leak: leakCount,
      evidence: {
        tmp_root: tmpRoot
      }
    };

    const extraFiles = cells.flatMap((cell) => [
      { label: `${cell.id}_improve_stdout`, path: cell.logs.stdout },
      { label: `${cell.id}_improve_stderr`, path: cell.logs.stderr }
    ]);
    const evidenceBundle = await writeUatEvidenceBundle({
      scenario: SCENARIO,
      runId: ledger.run_id,
      tmpRoot,
      dataDir,
      outputs: cells.flatMap((cell) => cell.outputs ?? []),
      output: ledger,
      proxyStats: proxy?.stats,
      extraFiles,
      extraJson: {
        github: cells.map((cell) => cell.github),
        verification: cells.map((cell) => ({
          id: cell.id,
          status: cell.status,
          pr_candidate: cell.pr_candidate,
          selected_decision: cell.selected_decision,
          selected_reason: cell.selected_reason,
          quality_met: cell.quality_met,
          draft_pr_verified: cell.github?.draft_pr_verified,
          main_unchanged: cell.github?.main_unchanged
        }))
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
    if (status !== PASS_STATUS) process.exitCode = 1;
  } finally {
    if (proxy) await proxy.close().catch(() => undefined);
    if (!keepRemote) {
      for (const fullRepo of remoteRepos) {
        const deleted = await run('gh', ['repo', 'delete', fullRepo, '--yes']);
        if (deleted.code !== 0) {
          await run('gh', ['repo', 'archive', fullRepo, '--yes']);
        }
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
