import { describe, expect, it } from 'vitest';
import { providerForAgentSpec } from './provider.js';

describe('providerForAgentSpec', () => {
  it.each([
    ['mock:scenario.json', 'mock'],
    ['patch', 'patch'],
    ['command:npm run fix', 'command'],
    ['codex', 'openai'],
    ['codex exec --cd /tmp/worktree -', 'openai'],
    ['  codex  ', 'openai'],
    ['unknown-agent --flag', 'unknown']
  ] as const)('maps %s to %s', (spec, expected) => {
    expect(providerForAgentSpec(spec)).toBe(expected);
  });
});
