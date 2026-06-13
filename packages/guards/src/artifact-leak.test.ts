import { describe, expect, it } from 'vitest';
import { scanArtifactLeak } from './artifact-leak.js';

describe('scanArtifactLeak', () => {
  it('is a pass no-op when not configured', () => {
    const out = scanArtifactLeak({
      stdout: 'Bearer abcdefgh12345',
      config: undefined
    });
    expect(out.result.status).toBe('pass');
    expect(out.redactedStdout).toBe('Bearer abcdefgh12345');
    expect(out.findings).toEqual([]);
  });

  it('rejects and redacts a forbidden literal without exposing the raw value', () => {
    const out = scanArtifactLeak({
      stdout: 'resolved skill-loop-cart-quantity in previous run',
      config: {
        forbidden_literals: [
          { label: 'previous_issue', value: 'skill-loop-cart-quantity' }
        ]
      }
    });
    expect(out.result.status).toBe('fail');
    expect(out.result.code).toBe('GUARD_ARTIFACT_LEAK');
    expect(out.redactedStdout).toBe(
      'resolved [REDACTED:previous_issue] in previous run'
    );
    // raw value must not appear anywhere in the result/violations
    expect(JSON.stringify(out.result)).not.toContain(
      'skill-loop-cart-quantity'
    );
    expect(out.findings[0]).toMatchObject({
      kind: 'forbidden_literal',
      label: 'previous_issue',
      rejecting: true
    });
  });

  it('redacts token-like content but does NOT reject by default (opt-in)', () => {
    const out = scanArtifactLeak({
      stderr: 'debug: Authorization Bearer sk-supersecretvalue1234',
      config: { forbidden_literals: [] }
    });
    expect(out.result.status).toBe('pass'); // token_like not opted in → redact only
    expect(out.redactedStderr).toContain('[REDACTED:');
    expect(out.redactedStderr).not.toContain('sk-supersecretvalue1234');
    expect(
      out.findings.some((f) => f.kind === 'token_like' && !f.rejecting)
    ).toBe(true);
  });

  it('rejects token-like content when builtins.token_like is opted in', () => {
    const out = scanArtifactLeak({
      stdout: 'api_key=AKIAIOSFODNN7EXAMPLE',
      config: { builtins: { token_like: true } }
    });
    expect(out.result.status).toBe('fail');
    expect(out.redactedStdout).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('does NOT reject a benign keyword assignment (password/secret) by default — false-positive guard', () => {
    // A `password:`/`secret:` assignment in example/docs/test output must not
    // fail a normal candidate. token_like reject is opt-in precisely to avoid
    // this; by default such content is redact-only (status pass).
    const out = scanArtifactLeak({
      stdout: 'example docs: password: hunter2 (sample, not a real secret)',
      config: { forbidden_literals: [] } // token_like NOT opted in (default)
    });
    expect(out.result.status).toBe('pass'); // no false reject
    expect(out.redactedStdout).toContain('[REDACTED]'); // still redact-only
    expect(out.redactedStdout).not.toContain('hunter2');
    expect(
      out.findings.some((f) => f.kind === 'token_like' && !f.rejecting)
    ).toBe(true);
  });

  it('does not scan stderr when scan_agent_stderr is false', () => {
    const out = scanArtifactLeak({
      stderr: 'leak skill-loop-cart-quantity',
      config: {
        scan_agent_stderr: false,
        forbidden_literals: [
          { label: 'previous_issue', value: 'skill-loop-cart-quantity' }
        ]
      }
    });
    expect(out.result.status).toBe('pass');
    expect(out.redactedStderr).toBe('leak skill-loop-cart-quantity');
  });

  it('truncates beyond max_scan_bytes so no unredacted tail is persisted', () => {
    const tail = `tail skill-loop-cart-quantity`;
    const out = scanArtifactLeak({
      stdout: `${'a'.repeat(20)}${tail}`,
      config: {
        max_scan_bytes: 10,
        forbidden_literals: [
          { label: 'previous_issue', value: 'skill-loop-cart-quantity' }
        ]
      }
    });
    expect(out.redactedStdout).not.toContain('skill-loop-cart-quantity');
    expect(out.redactedStdout).toContain('scan truncated');
  });
});
