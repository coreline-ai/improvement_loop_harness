import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeCommandGate } from '@vibeloop/eval-engine';
import type { EvalConfig, EvalGate, GateType } from '@vibeloop/task-protocol';
import { candidateFingerprint, dedupeCandidates } from '../fingerprint.js';
import type { CandidateSource, DiscoverOptions, DiscoveryCandidate, DiscoveryCommand, StructuredLocation } from '../types.js';

const INJECTION_PATTERNS = [
  { code: 'instruction_override', pattern: /ignore previous instructions/i },
  { code: 'instruction_override', pattern: /disregard (?:all )?(?:previous|prior) instructions/i },
  { code: 'prompt_leak_request', pattern: /system prompt/i },
  { code: 'prompt_leak_request', pattern: /developer message/i },
  { code: 'secret_exfiltration_request', pattern: /reveal.*(?:secret|token|key)/i },
  { code: 'command_injection_request', pattern: /run this command/i }
];

export function injectionIndicatorsForText(text: string): string[] {
  return [...new Set(INJECTION_PATTERNS
    .filter((entry) => entry.pattern.test(text))
    .map((entry) => entry.code))];
}

export function trustLevelForSource(source: CandidateSource): 'high' | 'medium' | 'low' {
  if (source === 'manual') return 'high';
  if (source === 'test_failure' || source === 'typecheck' || source === 'lint') return 'medium';
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

const SOURCE_GATE_MATCH: Record<Exclude<CandidateSource, 'manual'>, (gate: EvalGate) => boolean> = {
  test_failure: (gate) => gate.name.includes('test') || gate.type === 'task_acceptance' || gate.type === 'regression',
  typecheck: (gate) => gate.name.includes('typecheck') || gate.command.includes('tsc'),
  lint: (gate) => gate.name.includes('lint') || gate.command.includes('eslint'),
  security_scan: (gate) => gate.type === 'security' || /gitleaks|audit|security|semgrep/.test(`${gate.name} ${gate.command}`)
};

function isProjectCommandGate(gate: EvalGate): boolean {
  const projectTypes = new Set<GateType>(['hard', 'task_acceptance', 'regression', 'security', 'performance']);
  return !gate.command.startsWith('builtin:') && projectTypes.has(gate.type);
}

export function discoveryCommandsFromEvalConfig(evalConfig: EvalConfig): DiscoveryCommand[] {
  const commands: DiscoveryCommand[] = [];
  for (const source of ['security_scan', 'test_failure', 'typecheck', 'lint'] as const) {
    const gate = evalConfig.gates.find((candidate) => isProjectCommandGate(candidate) && SOURCE_GATE_MATCH[source](candidate));
    if (gate) commands.push({ source, gate });
  }
  return commands;
}

function sanitizePath(value: string): string {
  return value.replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function extractFilePath(output: string, repoPath: string): string {
  const repoPrefix = repoPath.replace(/\\/g, '/').replace(/\/$/, '');
  const filePattern = /((?:[A-Za-z]:)?[./]?[A-Za-z0-9_@./-]+\.(?:test\.)?(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|php|c|cpp|h|hpp|json|ya?ml))/g;
  for (const match of output.matchAll(filePattern)) {
    const raw = sanitizePath(match[1] ?? '');
    const normalized = raw.startsWith(repoPrefix) ? raw.slice(repoPrefix.length + 1) : raw;
    if (!normalized.includes('node_modules/') && !normalized.startsWith('/')) return normalized;
  }
  return 'project';
}

function extractTestName(output: string): string | undefined {
  const match = output.match(/(?:FAIL|✗|×|not ok)\s+([^\n\r]{1,80})/i);
  if (!match?.[1]) return undefined;
  return match[1].replace(/[^a-zA-Z0-9_ .:/-]+/g, '').trim().slice(0, 80) || undefined;
}

function riskAreaFromPath(evalConfig: EvalConfig, filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  for (const [riskArea, prefixes] of Object.entries(evalConfig.risk_classification ?? {})) {
    if (prefixes.some((prefix) => normalized.startsWith(prefix))) return riskArea;
  }
  return null;
}

function titleFor(source: CandidateSource, location: StructuredLocation): string {
  return `${location.filePath}: ${source} ${location.errorCode}`;
}

async function outputForRefs(artifactRoot: string, refs: Array<string | null>): Promise<string> {
  const chunks = await Promise.all(
    refs.filter((ref): ref is string => Boolean(ref)).map((ref) => readFile(path.join(artifactRoot, ref), 'utf8').catch(() => ''))
  );
  return chunks.join('\n');
}

async function collectCommand(options: DiscoverOptions, command: DiscoveryCommand, artifactRoot: string): Promise<DiscoveryCandidate[]> {
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

  const output = await outputForRefs(artifactRoot, [gate.stdout_ref, gate.stderr_ref]);
  const errorCode = SOURCE_ERROR_CODE[command.source];
  const location: StructuredLocation = {
    filePath: extractFilePath(output, options.repoPath),
    errorCode,
    ...(extractTestName(output) ? { testName: extractTestName(output) } : {})
  };
  return [
    {
      source: command.source,
      fingerprint: candidateFingerprint(command.source, location),
      title: titleFor(command.source, location),
      evidenceRefs: [gate.stdout_ref, gate.stderr_ref].filter((ref): ref is string => Boolean(ref)),
      riskAreaHint: riskAreaFromPath(options.evalConfig, location.filePath),
      trustLevel: trustLevelForSource(command.source),
      injectionIndicators: injectionIndicatorsForText(output),
      reproCommand: null,
      priority: SOURCE_PRIORITY[command.source],
      status: 'proposed',
      location
    }
  ];
}

export function selectTopCandidates(candidates: DiscoveryCandidate[], maxProposed = 50): DiscoveryCandidate[] {
  return candidates
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title))
    .slice(0, maxProposed);
}

export async function discoverCandidates(options: DiscoverOptions): Promise<DiscoveryCandidate[]> {
  const artifactRoot = options.artifactRoot ?? (await mkdtemp(path.join(os.tmpdir(), 'vibeloop-discovery-')));
  const commands = options.commands ?? discoveryCommandsFromEvalConfig(options.evalConfig);
  const discovered = (
    await Promise.all(commands.map((command) => collectCommand(options, command, artifactRoot)))
  ).flat();
  return selectTopCandidates(dedupeCandidates(discovered, options.existingFingerprints), options.maxProposed ?? 50);
}
