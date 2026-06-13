import type { EvaluatorConfig } from '@vibeloop/task-protocol';

/**
 * Deterministic improvement-quality Evaluator (M0).
 *
 * This is NOT an LLM. It computes a fixed-rule quality verdict from artifacts the
 * verifier already produced (changed files, evidence, test-on-base). It is the
 * second fixed gate alongside the deterministic Verifier: PR candidacy requires
 * `verified ∧ qualified`. It never relaxes correctness and never participates in
 * the decision-engine rules — quality failures live only in this report.
 *
 * When no `evaluator` config is present the verdict is `met: true` (status
 * `not_configured`) so existing projects see no behavior change.
 *
 * See docs/SELF_IMPROVEMENT_LOOP_DESIGN.md §8/§9.
 */

export type QualityRuleStatus = 'pass' | 'fail' | 'skip';

export interface QualityRuleResult {
  id: string;
  status: QualityRuleStatus;
  detail: string;
  value?: number | undefined;
  threshold?: number | undefined;
}

export interface QualityReport {
  schema_version: '1.0';
  status: 'pass' | 'fail' | 'not_configured';
  met: boolean;
  rules: QualityRuleResult[];
}

export interface QualityChangedFile {
  path: string;
  addedLines: number;
  deletedLines: number;
  protected?: boolean | undefined;
}

export interface EvaluateQualityInput {
  config: EvaluatorConfig | undefined;
  changedFiles: ReadonlyArray<QualityChangedFile>;
  evidence: ReadonlyArray<{ status: 'present' | 'missing' | 'inconclusive' }>;
  /** test-on-base result; present only when the task declares required_tests. */
  testOnBase?: { base_failed_candidate_passed: boolean } | undefined;
  /** number of task.acceptance.required_tests (decides whether Q2 applies). */
  requiredTestCount?: number | undefined;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function evaluateQuality(input: EvaluateQualityInput): QualityReport {
  if (!input.config) {
    return {
      schema_version: '1.0',
      status: 'not_configured',
      met: true,
      rules: []
    };
  }

  const config = input.config;
  const rules: QualityRuleResult[] = [];

  // Q1 — evidence strength
  const minPresent = config.min_evidence_present ?? 1;
  const presentCount = input.evidence.filter(
    (item) => item.status === 'present'
  ).length;
  rules.push({
    id: 'Q1',
    status: presentCount >= minPresent ? 'pass' : 'fail',
    detail: 'evidence_present',
    value: presentCount,
    threshold: minPresent
  });

  // Q2 — test meaning (opt-in; only when the task declares required tests).
  // Default false: the kernel already enforces fail-to-pass for
  // adds_regression_test / fixes_reproduced_failure evidence, and requiring it for
  // every evaluator user would wrongly fail non-bugfix tasks (refactor/perf) whose
  // required tests legitimately pass on base too.
  if (config.require_test_on_base_pass ?? false) {
    if ((input.requiredTestCount ?? 0) > 0) {
      const passed = input.testOnBase?.base_failed_candidate_passed === true;
      rules.push({
        id: 'Q2',
        status: passed ? 'pass' : 'fail',
        detail: 'test_on_base_fail_to_pass'
      });
    } else {
      rules.push({ id: 'Q2', status: 'skip', detail: 'no_required_tests' });
    }
  }

  // Q3 — target directness (only when target_paths declared)
  if (config.target_paths && config.target_paths.length > 0) {
    const targets = config.target_paths.map(normalizePath);
    const hit = input.changedFiles.some((file) =>
      targets.some((target) => normalizePath(file.path).startsWith(target))
    );
    rules.push({
      id: 'Q3',
      status: hit ? 'pass' : 'fail',
      detail: 'target_directness'
    });
  }

  // Q4 — diff risk / economy
  if (config.max_changed_files !== undefined) {
    const fileCount = input.changedFiles.length;
    rules.push({
      id: 'Q4_files',
      status: fileCount <= config.max_changed_files ? 'pass' : 'fail',
      detail: 'max_changed_files',
      value: fileCount,
      threshold: config.max_changed_files
    });
  }
  if (config.max_changed_lines !== undefined) {
    const lineCount = input.changedFiles.reduce(
      (sum, file) => sum + file.addedLines + file.deletedLines,
      0
    );
    rules.push({
      id: 'Q4_lines',
      status: lineCount <= config.max_changed_lines ? 'pass' : 'fail',
      detail: 'max_changed_lines',
      value: lineCount,
      threshold: config.max_changed_lines
    });
  }
  if (config.forbid_protected ?? true) {
    const touchedProtected = input.changedFiles.some(
      (file) => file.protected === true
    );
    rules.push({
      id: 'Q4_protected',
      status: touchedProtected ? 'fail' : 'pass',
      detail: 'no_protected_path'
    });
  }

  const met = rules.every((rule) => rule.status !== 'fail');
  return {
    schema_version: '1.0',
    status: met ? 'pass' : 'fail',
    met,
    rules
  };
}
