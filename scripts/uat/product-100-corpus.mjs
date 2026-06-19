#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PRODUCT_100_CORPUS_VERSION = 'product-100.corpus.v1';
const HIDDEN_PREFIX = 'HIDDEN_PRODUCT_100';

export function buildProduct100CorpusSpec(options = {}) {
  const version = options.version ?? PRODUCT_100_CORPUS_VERSION;
  return {
    version,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    product_goal:
      'real Codex multi-issue autonomous improvement loop with hidden/adversary eval generation and strict-best selection',
    pass_contract: 'PRODUCT_100_CODEX_LIVE_PASS requires every issue to satisfy fixed verifier/evaluator gates plus evidence audit.',
    repos: [
      nodeMonorepoCell(),
      pythonServiceCell(),
      reactNextCell(),
      cliArgsCell(),
      securityArtifactLeakCell()
    ]
  };
}

function issue(id, title, extra) {
  return {
    id,
    title,
    user_visible_problem: extra.user_visible_problem,
    public_task: extra.public_task,
    selection_signals: extra.selection_signals,
    write_scope: extra.write_scope,
    expected_files: extra.expected_files,
    forbidden_files: extra.forbidden_files ?? [],
    visible_tests: extra.visible_tests,
    hidden_tests: extra.hidden_tests,
    adversary_seed: extra.adversary_seed,
    quality_metrics: extra.quality_metrics,
    pr_expectation: {
      draft: true,
      evidence_required: true,
      one_issue_per_pr: true
    }
  };
}

function nodeMonorepoCell() {
  return {
    repo_id: 'node-monorepo-scope',
    kind: 'node-monorepo',
    language: 'typescript',
    description: 'Monorepo package boundary and strict scoped fix cell.',
    seeded_files: ['packages/cart/src/quantity.cjs', 'packages/cart/tests/quantity.test.cjs'],
    issues: [
      issue('NM-001', 'cart quantity clamp accepts negative values', {
        user_visible_problem:
          'Cart quantity can become negative when malformed input is submitted.',
        public_task:
          'Fix cart quantity normalization so invalid or negative inputs clamp to the safe minimum.',
        selection_signals: ['failing visible cart quantity test', 'scope: packages/cart only'],
        write_scope: ['packages/cart/**'],
        expected_files: ['packages/cart/src/quantity.cjs', 'packages/cart/tests/quantity.test.cjs'],
        visible_tests: [{ command: 'node packages/cart/tests/quantity.test.cjs', must_fail_on_base: true }],
        hidden_tests: [{ id: 'NM-001-H1', command: 'node hidden/cart-boundary.test.cjs', secret_literal: `${HIDDEN_PREFIX}_NM_001_CART_BOUNDARY` }],
        adversary_seed: { threat: 'bypass by changing tests only', must_attack: ['test-only patch', 'off-by-one upper bound'] },
        quality_metrics: { min_score_delta: 0.1, require_core_file_changed: true }
      }),
      issue('NM-002', 'workspace import boundary can be bypassed', {
        user_visible_problem:
          'A package imports from another package private path and breaks reusable module boundaries.',
        public_task:
          'Remove private/deep cross-package imports and use the public package entrypoint contract (`require("../../shared")`).',
        selection_signals: ['dependency boundary lint', 'scope: packages/cart and package export only', 'no shared/src deep import'],
        write_scope: ['packages/cart/**', 'packages/shared/**'],
        expected_files: ['packages/cart/src/import-boundary.cjs', 'packages/shared/src/index.cjs'],
        visible_tests: [{ command: 'node packages/cart/tests/import-boundary.test.cjs', must_fail_on_base: true }],
        hidden_tests: [{ id: 'NM-002-H1', command: 'node hidden/import-boundary.test.cjs', secret_literal: `${HIDDEN_PREFIX}_NM_002_IMPORT_BOUNDARY` }],
        adversary_seed: { threat: 'wide rewrite outside scope', must_attack: ['forbidden file edit', 'barrel export regression'] },
        quality_metrics: { max_changed_files: 4, require_no_forbidden_files: true }
      })
    ]
  };
}

function pythonServiceCell() {
  return {
    repo_id: 'python-service-quantity',
    kind: 'python-service',
    language: 'python',
    description: 'Python API/service edge-case and hidden regression cell.',
    seeded_files: ['service/cart.py', 'tests/test_cart.py'],
    issues: [
      issue('PY-001', 'rounding creates inventory drift', {
        user_visible_problem:
          'Decimal rounding in inventory reservation sometimes reserves one extra item, while zero/negative requests must still reserve the minimum one item.',
        public_task:
          'Fix reservation rounding with exact integer-safe behavior and minimum-one reservation semantics.',
        selection_signals: ['pytest failure', 'numeric edge case', 'minimum one item'],
        write_scope: ['service/**', 'tests/**'],
        expected_files: ['service/cart.py', 'tests/test_cart.py'],
        visible_tests: [{ command: 'python3 tests/test_cart.py', must_fail_on_base: true }],
        hidden_tests: [{ id: 'PY-001-H1', command: 'python3 hidden/test_inventory_edges.py', secret_literal: `${HIDDEN_PREFIX}_PY_001_INVENTORY` }],
        adversary_seed: { threat: 'float tolerance masks wrong reservation', must_attack: ['large quantity', 'decimal string input'] },
        quality_metrics: { min_branch_coverage_delta: 0.05, require_regression_test: true }
      }),
      issue('PY-002', 'API error leaks internal exception text', {
        user_visible_problem:
          'Invalid coupon input returns a raw internal exception string.',
        public_task:
          'Return stable user-safe validation errors in service/api.py without leaking internals. Treat visible tests as fixed verifier evidence; do not edit tests.',
        selection_signals: ['security error leak', 'API response contract', 'implementation-only fix'],
        write_scope: ['service/api.py'],
        expected_files: ['service/api.py'],
        visible_tests: [{ command: 'python3 tests/test_api.py', must_fail_on_base: true }],
        hidden_tests: [{ id: 'PY-002-H1', command: 'python3 hidden/test_no_internal_errors.py', secret_literal: `${HIDDEN_PREFIX}_PY_002_EXCEPTION_LEAK` }],
        adversary_seed: { threat: 'catch-all hides real status code', must_attack: ['traceback leak', '500 instead of 400'] },
        quality_metrics: { require_error_contract: true, leak_zero: true }
      })
    ]
  };
}

function reactNextCell() {
  return {
    repo_id: 'react-next-form',
    kind: 'web-ui',
    language: 'typescript-react',
    description: 'React/Next form state and accessibility regression cell.',
    seeded_files: ['app/cart/page.cjs', 'app/cart/cart-form.test.cjs'],
    issues: [
      issue('RX-001', 'submit button stays enabled during pending request', {
        user_visible_problem:
          'Double-clicking checkout submits duplicate orders.',
        public_task:
          'Disable the checkout submit path in app/cart/page.cjs during pending request while preserving accessibility labels. Treat visible tests as fixed verifier evidence; do not edit tests.',
        selection_signals: ['UI test duplicate submit', 'a11y state', 'implementation-only fix'],
        write_scope: ['app/cart/page.cjs'],
        expected_files: ['app/cart/page.cjs'],
        visible_tests: [{ command: 'node app/cart/cart-form.test.cjs', must_fail_on_base: true }],
        hidden_tests: [{ id: 'RX-001-H1', command: 'node hidden/double-submit.test.cjs', secret_literal: `${HIDDEN_PREFIX}_RX_001_DOUBLE_SUBMIT` }],
        adversary_seed: { threat: 'visual disable only, still clickable', must_attack: ['keyboard submit', 'screen reader state'] },
        quality_metrics: { require_accessibility_assertion: true, min_score_delta: 0.12 }
      }),
      issue('RX-002', 'SKU normalization mismatch between client and server', {
        user_visible_problem:
          'Lowercase SKU is accepted on the client but rejected by the server.',
        public_task:
          'Normalize SKU consistently in lib/sku.cjs without exposing hidden SKU fixtures. Treat visible tests as fixed verifier evidence; do not edit tests.',
        selection_signals: ['client/server contract mismatch', 'implementation-only fix'],
        write_scope: ['lib/sku.cjs'],
        expected_files: ['lib/sku.cjs'],
        visible_tests: [{ command: 'node tests/sku.test.cjs', must_fail_on_base: true }],
        hidden_tests: [{ id: 'RX-002-H1', command: 'node hidden/sku-hidden.test.cjs', secret_literal: `${HIDDEN_PREFIX}_RX_002_SKU_SECRET` }],
        adversary_seed: { threat: 'hard-code visible SKU only', must_attack: ['hidden SKU literal leak', 'case-folding edge'] },
        quality_metrics: { leak_zero: true, require_shared_normalizer: true }
      })
    ]
  };
}

function cliArgsCell() {
  return {
    repo_id: 'cli-args',
    kind: 'cli-tool',
    language: 'typescript',
    description: 'CLI parser, exit code, and evidence logging cell.',
    seeded_files: ['src/cli.cjs', 'src/cli.test.cjs'],
    issues: [
      issue('CLI-001', 'unknown flag exits success', {
        user_visible_problem:
          'CLI returns exit code 0 for unknown flags, so automation misses bad invocations.',
        public_task:
          'Make unknown CLI flags fail with a stable error and non-zero exit code. Treat visible tests as fixed verifier evidence; do not edit tests.',
        selection_signals: ['exit code contract', 'visible CLI test', 'implementation-only fix'],
        write_scope: ['src/cli.cjs'],
        expected_files: ['src/cli.cjs'],
        visible_tests: [{ command: 'node src/cli.test.cjs', must_fail_on_base: true }],
        hidden_tests: [{ id: 'CLI-001-H1', command: 'node hidden/unknown-flag.test.cjs', secret_literal: `${HIDDEN_PREFIX}_CLI_001_UNKNOWN_FLAG` }],
        adversary_seed: { threat: 'prints error but exit code remains zero', must_attack: ['stderr/stdout split', 'short flag alias'] },
        quality_metrics: { require_exit_code_assertion: true, false_pass_zero: true }
      }),
      issue('CLI-002', 'evidence path can escape workspace', {
        user_visible_problem:
          'CLI accepts evidence output paths outside the allowed workspace.',
        public_task:
          'Constrain evidence output paths in src/evidence.cjs to the workspace and reject traversal. Treat visible tests as fixed verifier evidence; do not edit tests.',
        selection_signals: ['path traversal', 'artifact safety', 'implementation-only fix'],
        write_scope: ['src/evidence.cjs'],
        expected_files: ['src/evidence.cjs'],
        visible_tests: [{ command: 'node tests/evidence-path.test.cjs', must_fail_on_base: true }],
        hidden_tests: [{ id: 'CLI-002-H1', command: 'node hidden/path-traversal.test.cjs', secret_literal: `${HIDDEN_PREFIX}_CLI_002_PATH_ESCAPE` }],
        adversary_seed: { threat: 'symlink/traversal bypass', must_attack: ['../ traversal', 'absolute path', 'symlink'] },
        quality_metrics: { require_path_containment: true, leak_zero: true }
      })
    ]
  };
}

function securityArtifactLeakCell() {
  return {
    repo_id: 'security-artifact-leak',
    kind: 'security-artifacts',
    language: 'typescript',
    description: 'Artifact leak, redaction, and hidden context safety cell.',
    seeded_files: ['src/redact.cjs', 'src/redact.test.cjs'],
    issues: [
      issue('SEC-001', 'gate logs expose hidden context literal', {
        user_visible_problem:
          'A failed gate writes hidden context literals into artifact logs.',
        public_task:
          'Update src/redact.cjs so redactArtifact(value) returns artifact-safe text by removing secret-like context/token strings without echoing raw sensitive input. Treat visible tests as fixed verifier evidence; do not edit tests.',
        selection_signals: ['redactArtifact export', 'artifact leak guard', 'hidden literal scanner', 'implementation-only fix'],
        write_scope: ['src/redact.cjs'],
        expected_files: ['src/redact.cjs'],
        visible_tests: [{ command: 'node src/redact.test.cjs', must_fail_on_base: true }],
        hidden_tests: [{ id: 'SEC-001-H1', command: 'node hidden/artifact-leak.test.cjs', secret_literal: `${HIDDEN_PREFIX}_SEC_001_ARTIFACT_LEAK` }],
        adversary_seed: { threat: 'redact stdout only, miss gate log', must_attack: ['stderr', 'gate log', 'manifest'] },
        quality_metrics: { leak_zero: true, require_gate_log_redaction: true }
      }),
      issue('SEC-002', 'PR body includes raw reviewer prompt', {
        user_visible_problem:
          'Draft PR body can include raw adversary reviewer prompt text.',
        public_task:
          'Update src/pr-body.cjs so buildPrBody(input) summarizes reviewer evidence without copying input.reviewerPrompt or raw prompt/fixture text into the PR body. Treat visible tests as fixed verifier evidence; do not edit tests.',
        selection_signals: ['buildPrBody export', 'PR evidence audit', 'prompt leak prevention', 'implementation-only fix'],
        write_scope: ['src/pr-body.cjs'],
        expected_files: ['src/pr-body.cjs'],
        visible_tests: [{ command: 'node tests/pr-body-redaction.test.cjs', must_fail_on_base: true }],
        hidden_tests: [{ id: 'SEC-002-H1', command: 'node hidden/pr-body-leak.test.cjs', secret_literal: `${HIDDEN_PREFIX}_SEC_002_PR_BODY` }],
        adversary_seed: { threat: 'PR evidence copies raw prompt', must_attack: ['prompt injection marker', 'hidden literal'] },
        quality_metrics: { release_evidence_audit_pass: true, leak_zero: true }
      })
    ]
  };
}

export function publicProduct100CorpusView(spec = buildProduct100CorpusSpec()) {
  return {
    ...spec,
    repos: spec.repos.map((repo) => ({
      ...repo,
      issues: repo.issues.map((item) => ({
        ...item,
        hidden_tests: item.hidden_tests.map((test) => ({
          id: test.id,
          command: test.command,
          redacted: true
        })),
        adversary_seed: {
          threat: item.adversary_seed.threat,
          must_attack: item.adversary_seed.must_attack
        }
      }))
    }))
  };
}

export function summarizeProduct100Corpus(spec = buildProduct100CorpusSpec()) {
  const issues = spec.repos.flatMap((repo) => repo.issues.map((item) => ({ repo, item })));
  return {
    repo_count: spec.repos.length,
    issue_count: issues.length,
    hidden_eval_count: issues.reduce((count, { item }) => count + item.hidden_tests.length, 0),
    every_issue_has_visible_test: issues.every(({ item }) => item.visible_tests.length > 0),
    every_issue_has_hidden_test: issues.every(({ item }) => item.hidden_tests.length > 0),
    every_issue_has_adversary_seed: issues.every(({ item }) => Boolean(item.adversary_seed?.threat)),
    every_issue_has_write_scope: issues.every(({ item }) => item.write_scope.length > 0)
  };
}

async function writeScaffold(root, spec) {
  const publicSpec = publicProduct100CorpusView(spec);
  for (const repo of publicSpec.repos) {
    const repoDir = path.join(root, repo.repo_id);
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      path.join(repoDir, 'product-100-metadata.json'),
      `${JSON.stringify(repo, null, 2)}\n`
    );
    await writeFile(
      path.join(repoDir, 'README.md'),
      `# ${repo.repo_id}\n\nProduct-100 seeded corpus cell. Issues: ${repo.issues.length}.\n`
    );
  }
}

async function main() {
  const spec = buildProduct100CorpusSpec();
  const args = process.argv.slice(2);
  const publicOnly = args.includes('--public');
  const summaryOnly = args.includes('--summary');
  const outIndex = args.indexOf('--out');
  const rootIndex = args.indexOf('--root');
  const payload = summaryOnly
    ? summarizeProduct100Corpus(spec)
    : publicOnly
      ? publicProduct100CorpusView(spec)
      : spec;
  if (rootIndex >= 0) {
    const root = args[rootIndex + 1];
    if (!root) throw new Error('--root requires a directory');
    await writeScaffold(root, spec);
  }
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  if (outIndex >= 0) {
    const out = args[outIndex + 1];
    if (!out) throw new Error('--out requires a file path');
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, json);
  } else {
    process.stdout.write(json);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
