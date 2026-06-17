import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeCommandGate } from '@vibeloop/eval-engine';
import type { EvalConfig, EvalGate, GateType } from '@vibeloop/task-protocol';
import { candidateFingerprint, dedupeCandidates } from '../fingerprint.js';
import type {
  CandidateSource,
  DiscoverOptions,
  DiscoverResult,
  DiscoveryCandidate,
  DiscoveryCandidateSummary,
  DiscoveryCapReport,
  DiscoveryCommand,
  StructuredLocation
} from '../types.js';

const INJECTION_PATTERNS = [
  { code: 'instruction_override', pattern: /ignore previous instructions/i },
  {
    code: 'instruction_override',
    pattern: /disregard (?:all )?(?:previous|prior) instructions/i
  },
  { code: 'prompt_leak_request', pattern: /system prompt/i },
  { code: 'prompt_leak_request', pattern: /developer message/i },
  {
    code: 'secret_exfiltration_request',
    pattern: /reveal.*(?:secret|token|key)/i
  },
  { code: 'command_injection_request', pattern: /run this command/i }
];

export function injectionIndicatorsForText(text: string): string[] {
  return [
    ...new Set(
      INJECTION_PATTERNS.filter((entry) => entry.pattern.test(text)).map(
        (entry) => entry.code
      )
    )
  ];
}

export function trustLevelForSource(
  source: CandidateSource
): 'high' | 'medium' | 'low' {
  if (source === 'manual') return 'high';
  if (source === 'test_failure' || source === 'typecheck' || source === 'lint')
    return 'medium';
  return 'low';
}

const SOURCE_PRIORITY: Record<CandidateSource, number> = {
  security_scan: 90,
  test_failure: 80,
  typecheck: 70,
  lint: 70,
  manual: 60
};

const SOURCE_ERROR_CODE: Record<Exclude<CandidateSource, 'manual'>, string> = {
  test_failure: 'TEST_FAILURE',
  typecheck: 'TYPECHECK_FAILURE',
  lint: 'LINT_FAILURE',
  security_scan: 'SECURITY_SCAN_FAILURE'
};

const SOURCE_GATE_MATCH: Record<
  Exclude<CandidateSource, 'manual'>,
  (gate: EvalGate) => boolean
> = {
  test_failure: (gate) =>
    gate.name.includes('test') ||
    gate.type === 'task_acceptance' ||
    gate.type === 'regression',
  typecheck: (gate) =>
    gate.name.includes('typecheck') || gate.command.includes('tsc'),
  lint: (gate) => gate.name.includes('lint') || gate.command.includes('eslint'),
  security_scan: (gate) =>
    gate.type === 'security' ||
    /gitleaks|audit|security|semgrep/.test(`${gate.name} ${gate.command}`)
};

function isProjectCommandGate(gate: EvalGate): boolean {
  const projectTypes = new Set<GateType>([
    'hard',
    'task_acceptance',
    'regression',
    'security',
    'performance'
  ]);
  return !gate.command.startsWith('builtin:') && projectTypes.has(gate.type);
}

export function discoveryCommandsFromEvalConfig(
  evalConfig: EvalConfig
): DiscoveryCommand[] {
  const commands: DiscoveryCommand[] = [];
  for (const source of [
    'security_scan',
    'test_failure',
    'typecheck',
    'lint'
  ] as const) {
    const gates = evalConfig.gates.filter(
      (candidate) =>
        isProjectCommandGate(candidate) && SOURCE_GATE_MATCH[source](candidate)
    );
    for (const gate of gates) commands.push({ source, gate });
  }
  return commands;
}

function sanitizePath(value: string): string {
  return value
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function extractFilePath(output: string, repoPath: string): string {
  const repoPrefix = repoPath.replace(/\\/g, '/').replace(/\/$/, '');
  const filePattern =
    /((?:[A-Za-z]:)?[./]?[A-Za-z0-9_@./-]+\.(?:test\.)?(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|c|cpp|h|hpp|json|ya?ml))/g;
  const candidates: string[] = [];
  for (const match of output.matchAll(filePattern)) {
    const raw = sanitizePath(match[1] ?? '');
    const normalized = raw.startsWith(repoPrefix)
      ? raw.slice(repoPrefix.length + 1)
      : raw;
    const absolute = path.join(repoPath, normalized);
    const looksLikeRuntimeName = /^(?:node|bun|deno)\.js$/i.test(normalized);
    if (
      !normalized.includes('node_modules/') &&
      !normalized.startsWith('/') &&
      !looksLikeRuntimeName &&
      existsSync(absolute)
    )
      candidates.push(normalized);
  }
  return (
    candidates.find(
      (candidate) =>
        !candidate.startsWith('tests/') && !candidate.includes('.test.')
    ) ??
    candidates[0] ??
    'project'
  );
}

function extractTestFilePath(output: string, repoPath: string): string | null {
  const repoPrefix = repoPath.replace(/\\/g, '/').replace(/\/$/, '');
  const filePattern =
    /((?:[A-Za-z]:)?[./]?[A-Za-z0-9_@./-]+\.test\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|c|cpp|h|hpp))/g;
  for (const match of output.matchAll(filePattern)) {
    const raw = sanitizePath(match[1] ?? '');
    const normalized = raw.startsWith(repoPrefix)
      ? raw.slice(repoPrefix.length + 1)
      : raw;
    const absolute = path.join(repoPath, normalized);
    if (
      !normalized.includes('node_modules/') &&
      !normalized.startsWith('/') &&
      existsSync(absolute)
    ) {
      return normalized;
    }
  }
  return null;
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function focusedReproCommand(
  originalCommand: string,
  output: string,
  repoPath: string
): string {
  const testFile = extractTestFilePath(output, repoPath);
  if (!testFile) return originalCommand;
  if (/^(npm|pnpm|yarn)\s+(run\s+)?test\b/.test(originalCommand.trim())) {
    return `node ${shSingleQuote(testFile)}`;
  }
  return originalCommand;
}

function sanitizedEvidenceSummary(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => injectionIndicatorsForText(line).length === 0)
    .filter((line) => !/node:internal|requireStack|^\s*at\s+/i.test(line))
    .slice(0, 12);
  const summary = lines.join('\n').slice(0, 1200).trim();
  return summary.length > 0 ? summary : undefined;
}

function extractTestName(output: string): string | undefined {
  const match = output.match(/(?:FAIL|✗|×|not ok)\s+([^\n\r]{1,80})/i);
  if (!match?.[1]) return undefined;
  return (
    match[1]
      .replace(/[^a-zA-Z0-9_ .:/-]+/g, '')
      .trim()
      .slice(0, 80) || undefined
  );
}

function isLikelySourcePath(filePath: string): boolean {
  return /^(src|lib|app|packages)\//.test(filePath);
}

function riskAreaFromPath(
  evalConfig: EvalConfig,
  filePath: string
): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  for (const [riskArea, prefixes] of Object.entries(
    evalConfig.risk_classification ?? {}
  )) {
    if (prefixes.some((prefix) => normalized.startsWith(prefix)))
      return riskArea;
  }
  return null;
}

function titleFor(
  source: CandidateSource,
  location: StructuredLocation
): string {
  return `${location.filePath}: ${source} ${location.errorCode}`;
}

async function outputForRefs(
  artifactRoot: string,
  refs: Array<string | null>
): Promise<string> {
  const chunks = await Promise.all(
    refs
      .filter((ref): ref is string => Boolean(ref))
      .map((ref) =>
        readFile(path.join(artifactRoot, ref), 'utf8').catch(() => '')
      )
  );
  return chunks.join('\n');
}

async function collectCommand(
  options: DiscoverOptions,
  command: DiscoveryCommand,
  artifactRoot: string
): Promise<DiscoveryCandidate[]> {
  const gate = await executeCommandGate(command.gate, {
    evalConfig: options.evalConfig,
    task: {
      id: 'discovery-task',
      title: 'Discovery task',
      objective: 'Discovery command execution placeholder',
      write_scope: { allowed: ['.'] },
      required_evidence: ['discovery']
    },
    taskFile: path.join(options.repoPath, 'task.yaml'),
    baseCommit: 'HEAD',
    loopId: options.loopId ?? 'discovery',
    worktreeRoot: options.repoPath,
    artifactRoot,
    changedFiles: []
  });
  if (gate.status === 'pass') return [];

  const output = await outputForRefs(artifactRoot, [
    gate.stdout_ref,
    gate.stderr_ref
  ]);
  const errorCode = SOURCE_ERROR_CODE[command.source];
  const testName = extractTestName(output);
  const outputFilePath = extractFilePath(output, options.repoPath);
  const testNameFilePath = testName
    ? extractFilePath(testName, options.repoPath)
    : 'project';
  const filePath =
    !isLikelySourcePath(outputFilePath) && testNameFilePath !== 'project'
      ? testNameFilePath
      : outputFilePath;
  const location: StructuredLocation = {
    filePath,
    errorCode,
    gateName: command.gate.name,
    ...(testName ? { testName } : {})
  };
  return [
    {
      source: command.source,
      fingerprint: candidateFingerprint(command.source, location),
      title: titleFor(command.source, location),
      evidenceRefs: [gate.stdout_ref, gate.stderr_ref].filter(
        (ref): ref is string => Boolean(ref)
      ),
      ...(sanitizedEvidenceSummary(output)
        ? { evidenceSummary: sanitizedEvidenceSummary(output) }
        : {}),
      riskAreaHint: riskAreaFromPath(options.evalConfig, location.filePath),
      trustLevel: trustLevelForSource(command.source),
      injectionIndicators: injectionIndicatorsForText(output),
      // Capture the failing command so the generated task can REQUIRE it as the
      // acceptance test (test-on-base verifies fixes_reproduced_failure with it).
      reproCommand: focusedReproCommand(
        command.gate.command,
        output,
        options.repoPath
      ),
      priority: SOURCE_PRIORITY[command.source],
      status: 'proposed',
      location
    }
  ];
}

export function selectTopCandidates(
  candidates: DiscoveryCandidate[],
  maxProposed = 50
): DiscoveryCandidate[] {
  return [...candidates]
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))
    .slice(0, maxProposed);
}

function summarizeCandidate(
  candidate: DiscoveryCandidate
): DiscoveryCandidateSummary {
  return {
    fingerprint: candidate.fingerprint,
    title: candidate.title,
    source: candidate.source,
    priority: candidate.priority,
    location: candidate.location
  };
}

export function selectTopCandidatesWithReport(
  candidates: DiscoveryCandidate[],
  maxProposed = 50,
  rawCount = candidates.length
): DiscoverResult {
  const ranked = [...candidates].sort(
    (a, b) => b.priority - a.priority || a.title.localeCompare(b.title)
  );
  const selected = ranked.slice(0, maxProposed);
  const dropped = ranked.slice(maxProposed);
  const report: DiscoveryCapReport = {
    schema_version: '1.0',
    max_proposed: maxProposed,
    raw_count: rawCount,
    deduped_count: candidates.length,
    selected_count: selected.length,
    dropped_count: dropped.length,
    cap_applied: dropped.length > 0,
    sort_order: 'priority_desc_title_asc',
    selected: selected.map(summarizeCandidate),
    dropped: dropped.map((candidate) => ({
      ...summarizeCandidate(candidate),
      reason: 'max_proposed_cap'
    }))
  };
  return { candidates: selected, report };
}

export async function discoverCandidatesWithReport(
  options: DiscoverOptions
): Promise<DiscoverResult> {
  const artifactRoot =
    options.artifactRoot ??
    (await mkdtemp(path.join(os.tmpdir(), 'vibeloop-discovery-')));
  const commands =
    options.commands ?? discoveryCommandsFromEvalConfig(options.evalConfig);
  const discovered = (
    await Promise.all(
      commands.map((command) => collectCommand(options, command, artifactRoot))
    )
  ).flat();
  return selectTopCandidatesWithReport(
    dedupeCandidates(discovered, options.existingFingerprints),
    options.maxProposed ?? 50,
    discovered.length
  );
}

export async function discoverCandidates(
  options: DiscoverOptions
): Promise<DiscoveryCandidate[]> {
  return (await discoverCandidatesWithReport(options)).candidates;
}
