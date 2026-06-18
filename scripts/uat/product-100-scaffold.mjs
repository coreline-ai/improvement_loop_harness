#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  buildProduct100CorpusSpec,
  publicProduct100CorpusView
} from './product-100-corpus.mjs';
import { buildProduct100IssueEvalArtifacts } from './product-100-eval-generator.mjs';

export const PRODUCT_100_SCAFFOLD_VERSION = 'product-100.scaffold.v1';

async function write(root, rel, content) {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

export async function writeProduct100Scaffold(root, spec = buildProduct100CorpusSpec()) {
  await mkdir(root, { recursive: true });
  const publicSpec = publicProduct100CorpusView(spec);
  for (const repo of spec.repos) {
    const repoRoot = path.join(root, repo.repo_id);
    const publicRepo = publicSpec.repos.find((item) => item.repo_id === repo.repo_id);
    await mkdir(repoRoot, { recursive: true });
    await write(repoRoot, 'README.md', `# ${repo.repo_id}\n\nProduct-100 executable base fixture.\n`);
    await write(repoRoot, 'package.json', JSON.stringify({ type: 'commonjs', private: true }, null, 2) + '\n');
    await writeRepoFixture(repoRoot, repo.repo_id);
    await write(repoRoot, 'product-100-issues.json', JSON.stringify(publicRepo?.issues ?? [], null, 2) + '\n');
  }
  return {
    version: PRODUCT_100_SCAFFOLD_VERSION,
    root,
    repo_count: spec.repos.length,
    issue_count: spec.repos.reduce((count, repo) => count + repo.issues.length, 0)
  };
}

async function writeRepoFixture(repoRoot, repoId) {
  switch (repoId) {
    case 'node-monorepo-scope':
      await writeNodeMonorepo(repoRoot);
      break;
    case 'python-service-quantity':
      await writePythonService(repoRoot);
      break;
    case 'react-next-form':
      await writeReactNextLike(repoRoot);
      break;
    case 'cli-args':
      await writeCliArgs(repoRoot);
      break;
    case 'security-artifact-leak':
      await writeSecurityArtifactLeak(repoRoot);
      break;
    default:
      throw new Error(`unsupported Product-100 repo fixture: ${repoId}`);
  }
}

async function writeNodeMonorepo(root) {
  await write(root, 'packages/cart/src/quantity.cjs', `function normalizeQuantity(value) {\n  return Number(value);\n}\nmodule.exports = { normalizeQuantity };\n`);
  await write(root, 'packages/cart/tests/quantity.test.cjs', `const assert = require('node:assert/strict');\nconst { normalizeQuantity } = require('../src/quantity.cjs');\nassert.equal(normalizeQuantity(-3), 1);\nassert.equal(normalizeQuantity('2'), 2);\n`);
  await write(root, 'packages/shared/src/private.cjs', `function privateNormalizeSku(value) {\n  return String(value).trim().toUpperCase();\n}\nmodule.exports = { privateNormalizeSku };\n`);
  await write(root, 'packages/shared/src/index.cjs', `function publicNormalizeSku(value) {\n  return String(value).trim().toUpperCase();\n}\nmodule.exports = { publicNormalizeSku };\n`);
  await write(root, 'packages/shared/package.json', `${JSON.stringify({
    name: 'shared',
    private: true,
    type: 'commonjs',
    main: './src/index.cjs',
    exports: { '.': './src/index.cjs' }
  }, null, 2)}\n`);
  await write(root, 'packages/cart/src/import-boundary.cjs', `const { privateNormalizeSku } = require('../../shared/src/private.cjs');\nmodule.exports = { publicNormalizeSku: privateNormalizeSku };\n`);
  await write(root, 'packages/cart/tests/import-boundary.test.cjs', `const assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst source = fs.readFileSync('packages/cart/src/import-boundary.cjs', 'utf8');\nassert.equal(source.includes('private.cjs'), false);\n`);
}

async function writePythonService(root) {
  await write(root, '.gitignore', `__pycache__/\n*.pyc\n`);
  await write(root, 'service/__init__.py', '');
  await write(root, 'service/cart.py', `def reserve_quantity(value):\n    return round(float(value))\n`);
  await write(root, 'tests/test_cart.py', `import os, sys\nsys.path.insert(0, os.getcwd())\nfrom service.cart import reserve_quantity\nassert reserve_quantity('2.9') == 2\nassert reserve_quantity('0.4') == 1\n`);
  await write(root, 'service/api.py', `def apply_coupon(payload):\n    try:\n        coupon = payload.get('coupon')\n        if not isinstance(coupon, str):\n            raise ValueError('internal coupon parser failed')\n        return {'status': 200, 'body': coupon.upper()}\n    except Exception as exc:\n        return {'status': 500, 'body': repr(exc)}\n`);
  await write(root, 'tests/test_api.py', `import os, sys\nsys.path.insert(0, os.getcwd())\nfrom service.api import apply_coupon\nresponse = apply_coupon({'coupon': object()})\nassert response['status'] == 400, response\nassert 'ValueError' not in response['body'], response\n`);
}

async function writeReactNextLike(root) {
  await write(root, 'app/cart/page.cjs', `function createCheckoutController(onSubmit) {\n  return {\n    submit() { onSubmit(); },\n    keyboardSubmit() { onSubmit(); },\n    ariaDisabled: false\n  };\n}\nmodule.exports = { createCheckoutController };\n`);
  await write(root, 'app/cart/cart-form.test.cjs', `const assert = require('node:assert/strict');\nconst { createCheckoutController } = require('./page.cjs');\nlet count = 0;\nconst controller = createCheckoutController(() => { count += 1; });\ncontroller.submit();\ncontroller.submit();\nassert.equal(count, 1);\nassert.equal(controller.ariaDisabled, true);\n`);
  await write(root, 'lib/sku.cjs', `function normalizeSku(value) {\n  return String(value);\n}\nmodule.exports = { normalizeSku };\n`);
  await write(root, 'tests/sku.test.cjs', `const assert = require('node:assert/strict');\nconst { normalizeSku } = require('../lib/sku.cjs');\nassert.equal(normalizeSku(' abc-123 '), 'ABC-123');\n`);
}

async function writeCliArgs(root) {
  await write(root, 'src/cli.cjs', `const args = process.argv.slice(2);\nif (args.includes('--help')) { console.log('help'); process.exit(0); }\nconsole.log('ok');\nprocess.exit(0);\n`);
  await write(root, 'src/cli.test.cjs', `const assert = require('node:assert/strict');\nconst { spawnSync } = require('node:child_process');\nconst result = spawnSync(process.execPath, ['src/cli.cjs', '--unknown'], { encoding: 'utf8' });\nassert.notEqual(result.status, 0);\nassert.match(result.stderr, /unknown/i);\n`);
  await write(root, 'src/evidence.cjs', `const path = require('node:path');\nfunction resolveEvidencePath(workspace, requested) {\n  return path.resolve(workspace, requested);\n}\nmodule.exports = { resolveEvidencePath };\n`);
  await write(root, 'tests/evidence-path.test.cjs', `const assert = require('node:assert/strict');\nconst { resolveEvidencePath } = require('../src/evidence.cjs');\nassert.throws(() => resolveEvidencePath('/tmp/workspace', '../escape.json'), /outside workspace/i);\n`);
}

async function writeSecurityArtifactLeak(root) {
  await write(root, 'src/redact.cjs', `function redactArtifact(value) {\n  return String(value);\n}\nmodule.exports = { redactArtifact };\n`);
  await write(root, 'src/redact.test.cjs', `const assert = require('node:assert/strict');\nconst { redactArtifact } = require('./redact.cjs');\nassert.equal(redactArtifact('token SECRET_VISIBLE').includes('SECRET_VISIBLE'), false);\n`);
  await write(root, 'src/pr-body.cjs', `function buildPrBody(input) {\n  return 'Reviewer prompt: ' + input.reviewerPrompt;\n}\nmodule.exports = { buildPrBody };\n`);
  await write(root, 'tests/pr-body-redaction.test.cjs', `const assert = require('node:assert/strict');\nconst { buildPrBody } = require('../src/pr-body.cjs');\nassert.equal(buildPrBody({ reviewerPrompt: 'raw prompt text' }).includes('raw prompt text'), false);\n`);
}

function splitCommand(command) {
  return String(command).trim().split(/\s+/).filter(Boolean);
}

export function runCommand(command, options = {}) {
  const [bin, ...args] = splitCommand(command);
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ ok: false, code: null, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

export async function validateProduct100BaseFailures(root, spec = buildProduct100CorpusSpec()) {
  const artifacts = buildProduct100IssueEvalArtifacts(spec);
  const results = [];
  for (const repo of spec.repos) {
    const repoRoot = path.join(root, repo.repo_id);
    for (const issue of repo.issues) {
      const artifact = artifacts.find((item) => item.repo_id === repo.repo_id && item.issue_id === issue.id);
      const visibleRuns = [];
      for (const test of issue.visible_tests) {
        const result = await runCommand(test.command, { cwd: repoRoot });
        visibleRuns.push({ command: test.command, exit_code: result.code, failed_on_base: result.ok === false });
      }
      const hiddenRuns = [];
      for (let index = 0; index < artifact.hidden_sources.length; index += 1) {
        const source = artifact.hidden_sources[index];
        const target = artifact.hidden_target_paths[index];
        const targetFile = path.join(repoRoot, target);
        await mkdir(path.dirname(targetFile), { recursive: true });
        await writeFile(targetFile, source.content);
        const command = artifact.eval.gates.find((gate) => gate.type === 'hidden_acceptance')?.command ?? issue.hidden_tests[index].command;
        const result = await runCommand(command, { cwd: repoRoot });
        hiddenRuns.push({ command, exit_code: result.code, failed_on_base: result.ok === false });
        await rm(targetFile, { force: true });
      }
      results.push({
        repo_id: repo.repo_id,
        issue_id: issue.id,
        visible_failed_on_base: visibleRuns.every((run) => run.failed_on_base),
        hidden_failed_on_base: hiddenRuns.every((run) => run.failed_on_base),
        visible_runs: visibleRuns,
        hidden_runs: hiddenRuns
      });
    }
  }
  return {
    version: PRODUCT_100_SCAFFOLD_VERSION,
    repo_count: spec.repos.length,
    issue_count: results.length,
    visible_base_fail_every_issue: results.every((item) => item.visible_failed_on_base),
    hidden_base_fail_every_issue: results.every((item) => item.hidden_failed_on_base),
    results
  };
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const validateBase = args.includes('--validate-base');
  const root = outIndex >= 0 && args[outIndex + 1]
    ? args[outIndex + 1]
    : await mkdtemp(path.join(os.tmpdir(), 'product-100-scaffold-'));
  const spec = buildProduct100CorpusSpec();
  const scaffold = await writeProduct100Scaffold(root, spec);
  const report = validateBase
    ? { scaffold, base_validation: await validateProduct100BaseFailures(root, spec) }
    : { scaffold };
  console.log(JSON.stringify(report, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
