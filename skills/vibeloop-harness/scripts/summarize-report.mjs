#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report') {
      out.report = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith('--') && !out.report) {
      out.report = arg;
    }
  }
  if (!out.report)
    throw new Error('usage: summarize-report.mjs --report <eval-report.json>');
  return out;
}

function redactText(value) {
  return value
    .replace(/SECRET_HIDDEN_EXPECTATION/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]')
    .replace(
      /((?:access|refresh)[_-]?token["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
      '$1[REDACTED]'
    )
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]');
}

function redact(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item)])
    );
  }
  return value;
}

// Single canonical PR-candidate predicate, identical across CLI/Skill/server:
//   decision = accept (implies ALL_PASS + hidden/protected/scope guards) AND the
//   deterministic quality gate is met (quality-report.status != 'fail').
function isPrCandidate(report, qualityStatus) {
  return (
    report.decision === 'accept' &&
    report.decision_reasons?.[0]?.code === 'ALL_PASS' &&
    qualityStatus !== 'fail'
  );
}

function nextAction(report, failedGates, prCandidate, qualityStatus) {
  if (prCandidate) return 'prepare_pr_candidate';
  if (report.decision_reasons?.[0]?.code === 'GUARD_ARTIFACT_LEAK') {
    return 'remove_leaked_context_then_rerun';
  }
  if (report.decision === 'accept' && qualityStatus === 'fail') {
    return 'improve_quality_then_rerun';
  }
  if (failedGates.length > 0) return 'fix_failed_gates_then_rerun';
  if (report.risk?.human_approval_required) return 'request_human_review';
  return 'inspect_decision_reasons';
}

async function readQualityStatus(reportFilePath) {
  // quality-report.json is a sibling of eval-report.json in reports/.
  const qualityPath = path.join(
    path.dirname(reportFilePath),
    'quality-report.json'
  );
  try {
    const quality = JSON.parse(await readFile(qualityPath, 'utf8'));
    return quality.status ?? null; // 'pass' | 'fail' | 'not_configured'
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
const reportPath = path.resolve(args.report);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const qualityStatus = await readQualityStatus(reportPath);
const failedGates = (report.gate_runs ?? [])
  .filter((gate) => gate.required && gate.status !== 'pass')
  .map((gate) => ({
    name: gate.name,
    type: gate.type,
    status: gate.status,
    summary: gate.summary ?? null
  }));
const prCandidate = isPrCandidate(report, qualityStatus);
const summary = redact({
  decision: report.decision ?? null,
  reason: report.decision_reasons?.[0]?.code ?? null,
  qualityStatus,
  qualified: qualityStatus !== 'fail',
  prCandidate,
  changedFiles: (report.changed_files ?? []).map((file) => file.path),
  failedGates,
  evidence: report.improvement_evidence ?? [],
  risk: report.risk ?? null,
  reportPath,
  nextAction: nextAction(report, failedGates, prCandidate, qualityStatus)
});
console.log(`${JSON.stringify(summary, null, 2)}\n`);
