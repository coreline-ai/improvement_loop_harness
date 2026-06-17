import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ruleSpecHashMatches,
  type RulepackRule
} from '@vibeloop/eval-engine';

export interface RulepackInspectViolation {
  code: string;
  message: string;
}

export interface RulepackInspectReport {
  schema_version: '1.0';
  kind: 'rulepack_inspect';
  file: string;
  valid: boolean;
  semantic_ready: boolean;
  status: 'semantic_ready' | 'lock_valid' | 'invalid';
  summary: string;
  authority: string | null;
  decision_impact: string | null;
  source_loop_id: string | null;
  source_base_commit: string | null;
  lock_hash: string | null;
  rule_count: number;
  added_rule_count: number;
  executable_rule_count: number;
  violations: RulepackInspectViolation[];
  semantic_violations: RulepackInspectViolation[];
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRule(value: unknown): value is RulepackRule {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.hash === 'string' &&
    value.hash.startsWith('sha256:')
  );
}

export async function inspectFrozenRulepack(
  file: string
): Promise<RulepackInspectReport> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const record = isRecord(parsed) ? parsed : undefined;
  const rules = Array.isArray(record?.rules) ? record.rules : [];
  const addedRules = Array.isArray(record?.added_rules)
    ? record.added_rules
    : [];
  const validRules = rules.filter(isRule);
  const validAddedRules = addedRules.filter(isRule);
  const executableRules = validAddedRules.filter((rule) => rule.spec);
  const violations: RulepackInspectViolation[] = [];

  if (!record) {
    violations.push({ code: 'RULEPACK_INVALID', message: 'not an object' });
  }
  if (record?.kind !== 'frozen_rulepack') {
    violations.push({
      code: 'RULEPACK_KIND',
      message: 'kind must be frozen_rulepack'
    });
  }
  if (record?.authority !== 'fixed_next_loop_gate') {
    violations.push({
      code: 'RULEPACK_AUTHORITY',
      message: 'authority must be fixed_next_loop_gate'
    });
  }
  if (record?.decision_impact !== 'next_loop_only') {
    violations.push({
      code: 'RULEPACK_DECISION_IMPACT',
      message: 'decision_impact must be next_loop_only'
    });
  }
  if (rules.length === 0 || validRules.length !== rules.length) {
    violations.push({
      code: 'RULEPACK_RULES',
      message: 'rules must be non-empty sha256-hashed rules'
    });
  }
  if (addedRules.length === 0 || validAddedRules.length !== addedRules.length) {
    violations.push({
      code: 'RULEPACK_ADDED_RULES',
      message: 'added_rules must be non-empty sha256-hashed rules'
    });
  }
  const specHashMismatches = [
    ...new Set(
      [...validRules, ...validAddedRules]
        .filter((rule) => !ruleSpecHashMatches(rule))
        .map((rule) => rule.id)
    )
  ];
  if (specHashMismatches.length > 0) {
    violations.push({
      code: 'RULEPACK_RULE_SPEC_HASH',
      message: `rule spec hash mismatch: ${specHashMismatches.join(', ')}`
    });
  }
  if (!isRecord(record?.diff) || record.diff.appendOnly !== true) {
    violations.push({
      code: 'RULEPACK_NOT_APPEND_ONLY',
      message: 'diff.appendOnly must be true'
    });
  }
  if (!isRecord(record?.replay) || record.replay.replaySafe !== true) {
    violations.push({
      code: 'RULEPACK_REPLAY_UNSAFE',
      message: 'replay.replaySafe must be true'
    });
  }
  if (
    typeof record?.lock_hash !== 'string' ||
    !record.lock_hash.startsWith('sha256:')
  ) {
    violations.push({
      code: 'RULEPACK_LOCK_HASH_MISSING',
      message: 'lock_hash must be a sha256 hash'
    });
  } else if (record) {
    const expected = sha256({
      source_candidate_ref: record.source_candidate_ref,
      source_replay_ref: record.source_replay_ref,
      source_loop_id: record.source_loop_id,
      source_base_commit: record.source_base_commit,
      rules: record.rules,
      added_rules: record.added_rules,
      diff: record.diff,
      replay: record.replay
    });
    if (record.lock_hash !== expected) {
      violations.push({
        code: 'RULEPACK_LOCK_HASH_MISMATCH',
        message: 'lock_hash does not match frozen rulepack content'
      });
    }
  }

  const semanticViolations: RulepackInspectViolation[] = [];
  if (
    typeof record?.source_loop_id !== 'string' ||
    record.source_loop_id.length === 0
  ) {
    semanticViolations.push({
      code: 'RULEPACK_SOURCE_LOOP_MISSING',
      message: 'source_loop_id is required for semantic next-loop execution'
    });
  }
  if (
    typeof record?.source_base_commit !== 'string' ||
    record.source_base_commit.length === 0
  ) {
    semanticViolations.push({
      code: 'RULEPACK_SOURCE_BASE_COMMIT_MISSING',
      message:
        'source_base_commit is required for semantic next-loop execution'
    });
  }
  if (executableRules.length === 0) {
    semanticViolations.push({
      code: 'RULEPACK_NO_EXECUTABLE_RULES',
      message: 'at least one added rule must contain an executable spec'
    });
  }
  for (const rule of executableRules) {
    if (rule.spec?.network !== 'none') {
      semanticViolations.push({
        code: 'RULEPACK_NETWORK_NOT_NONE',
        message: `${rule.id}: executable semantic rules require network=none`
      });
    }
  }

  const valid = violations.length === 0;
  const semanticReady = valid && semanticViolations.length === 0;
  return {
    schema_version: '1.0',
    kind: 'rulepack_inspect',
    file,
    valid,
    semantic_ready: semanticReady,
    status: semanticReady ? 'semantic_ready' : valid ? 'lock_valid' : 'invalid',
    summary: semanticReady
      ? `semantic-ready frozen rulepack: ${executableRules.length}/${validAddedRules.length} executable added rule(s)`
      : valid
        ? `valid frozen rulepack lock: ${validAddedRules.length} added rule(s), ${executableRules.length} executable`
        : `invalid frozen rulepack: ${violations.length} violation(s)`,
    authority:
      typeof record?.authority === 'string' ? record.authority : null,
    decision_impact:
      typeof record?.decision_impact === 'string'
        ? record.decision_impact
        : null,
    source_loop_id:
      typeof record?.source_loop_id === 'string'
        ? record.source_loop_id
        : null,
    source_base_commit:
      typeof record?.source_base_commit === 'string'
        ? record.source_base_commit
        : null,
    lock_hash: typeof record?.lock_hash === 'string' ? record.lock_hash : null,
    rule_count: validRules.length,
    added_rule_count: validAddedRules.length,
    executable_rule_count: executableRules.length,
    violations,
    semantic_violations: semanticViolations
  };
}
