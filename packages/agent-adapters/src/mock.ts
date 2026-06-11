import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { safeGit } from '@vibeloop/workspace-runner';
import type {
  AgentAdapter,
  AgentRunOptions,
  AgentRunResult
} from './adapter.js';

export type MockAction =
  | { type: 'create' | 'modify'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'symlink'; path: string; target: string }
  | { type: 'commit'; message?: string | undefined }
  | { type: 'git_tamper'; path: string; content: string }
  | { type: 'sleep'; ms: number };

export interface MockScenario {
  actions: MockAction[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readScenario(
  scenarioOrPath: MockScenario | string
): Promise<MockScenario> {
  if (typeof scenarioOrPath !== 'string') {
    return scenarioOrPath;
  }
  return JSON.parse(await readFile(scenarioOrPath, 'utf8')) as MockScenario;
}

async function gitCommonDir(worktree: string): Promise<string> {
  const output = (
    await safeGit(worktree, ['rev-parse', '--git-common-dir'])
  ).stdout.trim();
  return path.isAbsolute(output) ? output : path.resolve(worktree, output);
}

export async function applyMockScenario(
  worktree: string,
  scenario: MockScenario
): Promise<void> {
  for (const action of scenario.actions) {
    switch (action.type) {
      case 'create':
      case 'modify': {
        const target = path.join(worktree, action.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, action.content);
        break;
      }
      case 'delete':
        await rm(path.join(worktree, action.path), {
          recursive: true,
          force: true
        });
        break;
      case 'rename': {
        const target = path.join(worktree, action.to);
        await mkdir(path.dirname(target), { recursive: true });
        await rename(path.join(worktree, action.from), target);
        break;
      }
      case 'symlink': {
        const target = path.join(worktree, action.path);
        await mkdir(path.dirname(target), { recursive: true });
        await symlink(action.target, target);
        break;
      }
      case 'commit':
        await safeGit(worktree, ['add', '-A']);
        await safeGit(worktree, [
          'commit',
          '-m',
          action.message ?? 'mock agent change',
          '--allow-empty'
        ]);
        break;
      case 'git_tamper': {
        const commonDir = await gitCommonDir(worktree);
        const target = path.join(commonDir, action.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, action.content);
        break;
      }
      case 'sleep':
        await sleep(action.ms);
        break;
    }
  }
}

export class MockAgentAdapter implements AgentAdapter {
  constructor(private readonly scenarioOrPath: MockScenario | string) {}

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const scenario = await readScenario(this.scenarioOrPath);
    let timeout: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        applyMockScenario(options.worktree, scenario),
        new Promise<never>((_, reject) => {
          if (!options.timeoutMs || options.timeoutMs <= 0) {
            return;
          }
          timeout = setTimeout(
            () => reject(new Error('mock agent timed out')),
            options.timeoutMs
          );
        })
      ]);

      return {
        status: 'pass',
        exitCode: 0,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdout: 'mock scenario applied',
        stderr: ''
      };
    } catch (error) {
      return {
        status: 'error',
        exitCode: null,
        timedOut: error instanceof Error && error.message.includes('timed out'),
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
