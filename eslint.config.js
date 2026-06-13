import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'apps/*/.next/**',
      'apps/*/playwright-report/**',
      'apps/*/test-results/**',
      'packages/*/dist/**',
      'coverage/**',
      '.vibeloop/**',
      'tests/e2e/fixtures/**',
      'tests/e2e/user-scenarios/**/target-template/**',
      'tests/e2e/user-scenarios/**/hidden/**',
      'tests/e2e/user-scenarios/**/agent-*.cjs',
      'skills/vibeloop-harness/vendor/**',
      '*.tsbuildinfo'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      'no-console': 'off'
    }
  }
];
