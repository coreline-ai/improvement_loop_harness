import { describe, expect, it } from 'vitest';
import {
  BLOCKED_EXIT,
  adversaryLivePreflightExitCode,
  buildAdversaryLivePreflightReport,
  redact
} from './adversary-live-preflight.mjs';

describe('adversary live preflight', () => {
  it('redacts auth-like values from runtime output', () => {
    expect(redact('Bearer abc.def Token secret Authorization xyz')).toBe(
      'Bearer [REDACTED] Token [REDACTED] Authorization [REDACTED]'
    );
  });

  it('blocks when a Docker-compatible runtime is unavailable', async () => {
    const report = await buildAdversaryLivePreflightReport({
      runCommand: async () => ({
        ok: false,
        status: 'spawn_error',
        exit_code: null,
        stdout: '',
        stderr: 'spawn docker ENOENT Bearer should-not-leak'
      })
    });

    expect(report).toMatchObject({
      status: 'blocked',
      scenario: 'adversary-live-preflight',
      reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
      required_failures: ['container_runtime'],
      safety_check: { ok: true, failures: [] },
      safety: {
        host_execution_allowed: false,
        current_loop_decision_impact: 'none',
        m2: { isolation: 'container', network: 'none' },
        m4: { isolation: 'container', network: 'none' },
        frozen_rulepack: { decision_impact: 'next_loop_only' }
      }
    });
    expect(report.checks.container_runtime.stderr).toContain(
      'Bearer [REDACTED]'
    );
    expect(report.checks.container_runtime.stderr).not.toContain(
      'should-not-leak'
    );
    expect(adversaryLivePreflightExitCode(report)).toBe(BLOCKED_EXIT);
  });

  it('blocks when the R1 smoke container cannot run', async () => {
    const report = await buildAdversaryLivePreflightReport({
      runCommand: async (_command, args) => {
        if (args[0] === 'info') {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: '"28.0.0"',
            stderr: ''
          };
        }
        return {
          ok: false,
          status: 'fail',
          exit_code: 125,
          stdout: '',
          stderr: 'unable to find image Token should-not-leak'
        };
      }
    });

    expect(report).toMatchObject({
      status: 'blocked',
      scenario: 'adversary-live-preflight',
      reason: 'CONTAINER_SMOKE_UNAVAILABLE',
      required_failures: ['container_smoke'],
      safety_check: { ok: true, failures: [] },
      checks: {
        container_runtime: { ok: true },
        container_smoke: {
          ok: false,
          image: 'node:22-alpine',
          network: 'none'
        }
      }
    });
    expect(report.checks.container_smoke.stderr).toContain('Token [REDACTED]');
    expect(report.checks.container_smoke.stderr).not.toContain(
      'should-not-leak'
    );
    expect(adversaryLivePreflightExitCode(report)).toBe(BLOCKED_EXIT);
  });

  it('passes when Docker info and R1 smoke succeed', async () => {
    const report = await buildAdversaryLivePreflightReport({
      runCommand: async (command, args) => {
        if (args[0] === 'info') {
          return {
            ok: true,
            status: 'pass',
            exit_code: 0,
            stdout: `"28.0.0" via ${command} ${args[0]}`,
            stderr: ''
          };
        }
        return {
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: `{"ok":true} via ${command} ${args.slice(0, 3).join(' ')}`,
          stderr: ''
        };
      }
    });

    expect(report).toMatchObject({
      status: 'pass',
      scenario: 'adversary-live-preflight',
      required_failures: [],
      safety_check: { ok: true, failures: [] }
    });
    expect(report.checks.container_runtime.ok).toBe(true);
    expect(report.checks.container_smoke).toMatchObject({
      ok: true,
      image: 'node:22-alpine',
      network: 'none'
    });
    expect(adversaryLivePreflightExitCode(report)).toBe(0);
  });

  it('fails when the adversary live safety invariant is invalid', async () => {
    const report = await buildAdversaryLivePreflightReport({
      safety: {
        host_execution_allowed: true,
        current_loop_decision_impact: 'none',
        proposal_authority: 'advisory_only',
        m2: { execute: true, isolation: 'container', network: 'none', timeout_ms: 1 },
        m4: { execute: true, isolation: 'container', network: 'none', timeout_ms: 1 },
        frozen_rulepack: {
          authority: 'fixed_next_loop_gate',
          decision_impact: 'next_loop_only',
          same_loop_application_allowed: false
        },
        n_plus_one: {
          gate: 'builtin:rulepack-semantic',
          expected_bad_status: 'fail'
        }
      },
      runCommand: async () => ({
        ok: true,
        status: 'pass',
        exit_code: 0,
        stdout: '"28.0.0"',
        stderr: ''
      })
    });

    expect(report).toMatchObject({
      status: 'fail',
      scenario: 'adversary-live-preflight',
      reason: 'ADVERSARY_LIVE_SAFETY_INVARIANT_FAILED',
      safety_check: {
        ok: false,
        failures: expect.arrayContaining([
          'host_execution_allowed_must_be_false',
          'attack_scenario_count_too_low'
        ])
      }
    });
    expect(adversaryLivePreflightExitCode(report)).toBe(1);
  });
});
