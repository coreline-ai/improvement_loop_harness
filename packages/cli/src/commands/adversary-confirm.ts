import type { Command } from 'commander';
import { EXIT_CODES, confirmAdversaryM2Handoff } from '@vibeloop/sdk';

interface AdversaryConfirmOptions {
  handoff: string;
  candidateWorktree?: string | undefined;
  baseWorktree?: string | undefined;
  execute?: boolean | undefined;
  image?: string | undefined;
  testCommand?: string | undefined;
  network?: 'none' | 'default' | undefined;
  timeoutMs?: string | undefined;
  testDir: string[];
  objectiveTerm: string[];
  hiddenMarker: string[];
  maxBodyBytes?: string | undefined;
  out?: string | undefined;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInt(
  value: string | undefined,
  name: string
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function registerAdversaryConfirmCommand(program: Command): void {
  program
    .command('adversary-confirm')
    .description(
      'M2 helper: consume an adversary-m2-handoff.json and optionally confirm proposals under R1 isolation (advisory only; never changes accept)'
    )
    .requiredOption('--handoff <path>', 'adversary_review.m2_handoff_ref JSON')
    .option('--candidate-worktree <path>', 'candidate worktree for --execute')
    .option(
      '--base-worktree <path>',
      'base worktree for fail_to_pass proposals'
    )
    .option(
      '--execute',
      'actually run proposals in an isolated container',
      false
    )
    .option('--image <image>', 'container image for --execute')
    .option('--test-command <command>', 'command to run staged adversary test')
    .option('--network <none|default>', 'container network policy', 'none')
    .option('--timeout-ms <n>', 'per proposal timeout in milliseconds')
    .option('--test-dir <prefix>', 'allowed test/staging prefix', collect, [])
    .option(
      '--objective-term <term>',
      'objective-link term for re-filtering',
      collect,
      []
    )
    .option(
      '--hidden-marker <marker>',
      'hidden/secret marker that rejects proposals',
      collect,
      []
    )
    .option('--max-body-bytes <n>', 'maximum proposal body size', '8000')
    .option('--out <path>', 'write confirmation report JSON')
    .action(async (options: AdversaryConfirmOptions) => {
      if (options.network && !['none', 'default'].includes(options.network)) {
        throw new Error('--network must be none or default');
      }
      const execute = options.execute === true;
      if (execute && (!options.image || !options.testCommand)) {
        throw new Error('--execute requires --image and --test-command');
      }
      const timeoutMs = parsePositiveInt(options.timeoutMs, '--timeout-ms');
      const maxBodyBytes = parsePositiveInt(
        options.maxBodyBytes,
        '--max-body-bytes'
      );
      const report = await confirmAdversaryM2Handoff({
        handoffFile: options.handoff,
        execute,
        ...(options.candidateWorktree
          ? { candidateWorktree: options.candidateWorktree }
          : {}),
        ...(options.baseWorktree ? { baseWorktree: options.baseWorktree } : {}),
        filterConfig: {
          testDirs:
            options.testDir.length > 0
              ? options.testDir
              : ['tests/', 'test/', '__tests__/', '.vibeloop/adversary/'],
          ...(options.objectiveTerm.length > 0
            ? { objectiveTerms: options.objectiveTerm }
            : {}),
          hiddenMarkers:
            options.hiddenMarker.length > 0
              ? options.hiddenMarker
              : ['SECRET_HIDDEN', 'HIDDEN_ACCEPTANCE', 'BEGIN_HIDDEN'],
          ...(maxBodyBytes ? { maxBodyBytes } : {})
        },
        ...(execute
          ? {
              execution: {
                image: options.image!,
                testCommand: options.testCommand!,
                network: options.network ?? 'none',
                ...(timeoutMs ? { timeoutMs } : {})
              }
            }
          : {}),
        ...(options.out ? { outputFile: options.out } : {})
      });
      process.exitCode = !execute
        ? EXIT_CODES.accept
        : report.all_confirmed
          ? EXIT_CODES.accept
          : EXIT_CODES.reject;
      console.log(JSON.stringify(report, null, 2));
    });
}
