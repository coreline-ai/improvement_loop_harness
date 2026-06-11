import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'report-html',
      root: 'packages/report-html',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**']
    }
  },
  {
    test: {
      name: 'agent-adapters',
      root: 'packages/agent-adapters',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**']
    }
  },
  {
    test: {
      name: 'eval-engine',
      root: 'packages/eval-engine',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**']
    }
  },
  {
    test: {
      name: 'guards',
      root: 'packages/guards',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**']
    }
  },
  {
    test: {
      name: 'workspace-runner',
      root: 'packages/workspace-runner',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**']
    }
  },
  {
    test: {
      name: 'artifacts',
      root: 'packages/artifacts',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**']
    }
  },

  {
    test: {
      name: 'task-protocol',
      root: 'packages/task-protocol',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**']
    }
  },
  {
    test: {
      name: 'shared',
      root: 'packages/shared',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**']
    }
  },
  {
    test: {
      name: 'cli',
      root: 'packages/cli',
      environment: 'node',
      include: ['src/**/*.test.ts'],
      exclude: ['dist/**', 'node_modules/**']
    }
  }
]);
