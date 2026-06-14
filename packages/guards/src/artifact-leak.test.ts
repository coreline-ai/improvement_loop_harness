import { describe, expect, it } from 'vitest';
import {
  mergeArtifactLeakResults,
  redactForLeak,
  scanArtifactLeak,
  scanPatchForLeak
} from './artifact-leak.js';

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

describe('scanPatchForLeak (v2 candidate.patch scan)', () => {
  it('passes when scan_patch is not opted in', () => {
    const out = scanPatchForLeak('+ const x = "skill-loop-cart-quantity";', {
      forbidden_literals: [
        { label: 'prior_issue', value: 'skill-loop-cart-quantity' }
      ]
      // scan_patch omitted → off
    });
    expect(out.result.status).toBe('pass');
    expect(out.findings).toEqual([]);
  });

  it('rejects a forbidden literal in the patch without exposing the raw value', () => {
    const out = scanPatchForLeak(
      '+++ b/src/a.ts\n+ // leaked skill-loop-cart-quantity from prior issue\n',
      {
        scan_patch: true,
        forbidden_literals: [
          { label: 'prior_issue', value: 'skill-loop-cart-quantity' }
        ]
      }
    );
    expect(out.result.status).toBe('fail');
    expect(out.result.code).toBe('GUARD_ARTIFACT_LEAK');
    expect(out.findings[0]).toMatchObject({
      source: 'patch',
      kind: 'forbidden_literal',
      label: 'prior_issue',
      rejecting: true
    });
    // raw value never appears in the verdict
    expect(JSON.stringify(out.result)).not.toContain(
      'skill-loop-cart-quantity'
    );
  });

  it('does NOT reject a token-like patch line by default (opt-in), but does when token_like is on', () => {
    const patch = '+ const apiKey = "sk-supersecretvalue1234";\n';
    const off = scanPatchForLeak(patch, { scan_patch: true });
    expect(off.result.status).toBe('pass'); // detect-only, not rejecting
    const on = scanPatchForLeak(patch, {
      scan_patch: true,
      builtins: { token_like: true }
    });
    expect(on.result.status).toBe('fail');
  });
});

describe('mergeArtifactLeakResults', () => {
  it('fails if either side fails and concatenates violations', () => {
    const pass = scanArtifactLeak({ stdout: 'clean', config: {} }).result;
    const patchFail = scanPatchForLeak('+ skill-loop-cart-quantity', {
      scan_patch: true,
      forbidden_literals: [
        { label: 'prior_issue', value: 'skill-loop-cart-quantity' }
      ]
    }).result;
    const merged = mergeArtifactLeakResults(pass, patchFail);
    expect(merged.status).toBe('fail');
    expect(merged.code).toBe('GUARD_ARTIFACT_LEAK');
    expect(merged.violations.length).toBe(patchFail.violations.length);
  });

  it('returns the extra verdict when base is undefined', () => {
    const extra = scanPatchForLeak('+ clean line', { scan_patch: true }).result;
    expect(mergeArtifactLeakResults(undefined, extra)).toBe(extra);
  });
});

describe('redactForLeak (gate-log redact-only)', () => {
  it('redacts forbidden literals and tokens without rejecting or truncating', () => {
    const big = 'x'.repeat(2_000_000); // > default 1 MiB scan cap
    const text = `coverage_percent=81 LEAK_MARKER_ABC Bearer abcdefgh12345 ${big}END`;
    const out = redactForLeak(text, {
      forbidden_literals: [{ label: 'marker', value: 'LEAK_MARKER_ABC' }]
    });
    expect(out).not.toContain('LEAK_MARKER_ABC');
    expect(out).toContain('[REDACTED:marker]');
    expect(out).not.toContain('abcdefgh12345'); // token redacted regardless of opt-in
    expect(out).toContain('coverage_percent=81'); // metric line untouched
    expect(out.endsWith('END')).toBe(true); // no truncation marker
  });

  it('returns the text unchanged when config is undefined', () => {
    expect(redactForLeak('LEAK_MARKER_ABC', undefined)).toBe('LEAK_MARKER_ABC');
  });
});
