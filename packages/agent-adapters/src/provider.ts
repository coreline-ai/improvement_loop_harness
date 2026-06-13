/**
 * Maps an agent spec to a coarse provider identity used to reason about reviewer
 * independence (see `resolveSameModelReview`). This is intentionally conservative:
 * unknown shapes return `'unknown'` so callers treat independence as unproven.
 */
export function providerForAgentSpec(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith('mock:')) {
    return 'mock';
  }
  if (trimmed === 'patch') {
    return 'patch';
  }
  if (trimmed.startsWith('command:')) {
    return 'command';
  }
  // `codex` / `codex exec ...` run against the OpenAI/ChatGPT backend.
  if (trimmed === 'codex' || /^codex(\s|$)/.test(trimmed)) {
    return 'openai';
  }
  return 'unknown';
}
