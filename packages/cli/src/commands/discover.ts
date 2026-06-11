import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { discoverCandidates } from '@vibeloop/discovery';
import { loadEvalConfig, type EvalConfig } from '@vibeloop/task-protocol';

interface DiscoverCommandOptions {
  repo: string;
  eval?: string | undefined;
  testCommand?: string | undefined;
  typecheckCommand?: string | undefined;
  lintCommand?: string | undefined;
  securityCommand?: string | undefined;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function configForDiscovery(options: DiscoverCommandOptions): Promise<EvalConfig> {
  const evalPath = options.eval ?? path.join(options.repo, 'eval.yaml');
  const config = (await exists(evalPath))
    ? await loadEvalConfig(evalPath)
    : {
        schema_version: '1.0',
        project: 'cli-discovery',
        gates: []
      } satisfies EvalConfig;

  const extraGates = [
    options.testCommand
      ? { name: 'unit_tests', type: 'task_acceptance' as const, command: options.testCommand, required: true }
      : null,
    options.typecheckCommand
      ? { name: 'typecheck', type: 'hard' as const, command: options.typecheckCommand, required: true }
      : null,
    options.lintCommand ? { name: 'lint', type: 'hard' as const, command: options.lintCommand, required: true } : null,
    options.securityCommand
      ? { name: 'security_scan', type: 'security' as const, command: options.securityCommand, required: true }
      : null
  ].filter((gate): gate is NonNullable<typeof gate> => Boolean(gate));

  return { ...config, gates: [...extraGates, ...config.gates] };
}

export function registerDiscoverCommand(program: Command): void {
  program
    .command('discover')
    .description('Dry-run autonomous improvement discovery without saving candidates')
    .requiredOption('--repo <path>', 'target repository path')
    .option('--eval <path>', 'eval.yaml path; defaults to <repo>/eval.yaml when present')
    .option('--test-command <command>', 'override test discovery command')
    .option('--typecheck-command <command>', 'override typecheck discovery command')
    .option('--lint-command <command>', 'override lint discovery command')
    .option('--security-command <command>', 'override security scan discovery command')
    .action(async (options: DiscoverCommandOptions) => {
      const evalConfig = await configForDiscovery(options);
      const candidates = await discoverCandidates({ repoPath: options.repo, evalConfig });
      console.log(JSON.stringify({ candidates }, null, 2));
    });
}
