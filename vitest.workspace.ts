import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
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
