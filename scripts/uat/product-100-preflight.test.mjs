import { describe, expect, it } from 'vitest';
import {
  buildProduct100PreflightReport,
  buildProduct100GithubPreflight,
  buildProduct100ExecutionImagePreflight,
  buildReviewerPreflight,
  defaultProduct100ReviewerCommand,
  normalizeAdversaryPreflightReport,
  parseJsonTail,
  product100PreflightExitCode
} from './product-100-preflight.mjs';

const passLive = { status: 'pass', required_failures: [], checks: {} };
const passR1 = { status: 'pass', required_failures: [], checks: {} };
const blockedR1 = {
  status: 'blocked',
  reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
  required_failures: ['container_runtime'],
  checks: {}
};
const blockedPostgres = {
  status: 'blocked',
  reason: 'TEST_DATABASE_URL_UNAVAILABLE',
  required_failures: ['test_database_url'],
  checks: {}
};
const passPostgres = { status: 'pass', required_failures: [], checks: {} };
const passImages = { status: 'pass', required_failures: [], images: [], checks: {} };
const passReviewer = {
  ok: true,
  status: 'pass',
  required_failures: [],
  command: '[configured]',
  provider: '[configured]',
  real_llm: true
};

describe('Product-100 preflight', () => {
  it('parses JSON tail after human-readable command output', () => {
    expect(parseJsonTail('[PASS] x\n{"status":"pass","checks":{"a":true}}')).toEqual({
      status: 'pass',
      checks: { a: true }
    });
  });

  it('blocks when R1 container prerequisites are missing while default real reviewer wrapper is available', async () => {
    const reviewer = buildReviewerPreflight({});
    expect(reviewer.ok).toBe(true);
    expect(reviewer.default_wrapper_used).toBe(true);
    expect(reviewer.real_llm).toBe(true);
    expect(reviewer.separate_context_declared).toBe(true);
    expect(defaultProduct100ReviewerCommand()).toContain('product-100-codex-reviewer.mjs --live');

    const report = await buildProduct100PreflightReport({
      liveReport: passLive,
      adversaryReport: blockedR1,
      postgresReport: blockedPostgres,
      executionImageReport: passImages,
      reviewerReport: reviewer
    });
    expect(report.status).toBe('blocked');
    expect(report.blocked_requirements).toContain('r1_container_preflight_pass');
    expect(report.blocked_requirements).not.toContain(
      'real_codex_adversary_reviewer_used'
    );
    expect(product100PreflightExitCode(report)).toBe(20);
  });

  it('passes when required live/R1/reviewer prerequisites pass and postgres is optional', async () => {
    const report = await buildProduct100PreflightReport({
      liveReport: passLive,
      adversaryReport: passR1,
      postgresReport: blockedPostgres,
      executionImageReport: passImages,
      reviewerReport: passReviewer,
      requirePostgres: false
    });
    expect(report.status).toBe('pass');
    expect(report.optional_warnings).toContain('postgres_contract_preflight');
    expect(product100PreflightExitCode(report)).toBe(0);
  });



  it('blocks Phase6 live preflight unless GitHub repo auto-provisioning or explicit repo is enabled', async () => {
    const missing = buildProduct100GithubPreflight({
      VIBELOOP_PRODUCT_100_ENABLE_PHASE6_LIVE: '1'
    });
    expect(missing.ok).toBe(false);
    expect(missing.required_failures).toContain('github_repo_or_auto_provision');

    const auto = buildProduct100GithubPreflight({
      VIBELOOP_PRODUCT_100_ENABLE_PHASE6_LIVE: '1',
      VIBELOOP_PRODUCT_100_ENABLE_GITHUB_REPOS: '1',
      VIBELOOP_PRODUCT_100_GITHUB_OWNER: 'coreline-ai'
    });
    expect(auto.ok).toBe(true);
    expect(auto.auto_provision).toBe(true);

    const report = await buildProduct100PreflightReport({
      liveReport: passLive,
      adversaryReport: passR1,
      postgresReport: blockedPostgres,
      executionImageReport: passImages,
      reviewerReport: passReviewer,
      env: { VIBELOOP_PRODUCT_100_ENABLE_PHASE6_LIVE: '1' },
      requirePostgres: false
    });
    expect(report.status).toBe('blocked');
    expect(report.blocked_requirements).toContain('github_draft_prs_open');
  });

  it('blocks on postgres when release-grade mode requires postgres', async () => {
    const report = await buildProduct100PreflightReport({
      liveReport: passLive,
      adversaryReport: passR1,
      postgresReport: blockedPostgres,
      executionImageReport: passImages,
      reviewerReport: passReviewer,
      requirePostgres: true
    });
    expect(report.status).toBe('blocked');
    expect(report.blocked_requirements).toContain('release_evidence_audit_pass');
  });

  it('accepts a configured real reviewer and rejects same command as builder', () => {
    const ok = buildReviewerPreflight({
      VIBELOOP_ADVERSARY_REVIEWER_COMMAND: 'codex review',
      VIBELOOP_ADVERSARY_REVIEWER_PROVIDER: 'codex',
      VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM: '1'
    });
    expect(ok.ok).toBe(true);

    const same = buildReviewerPreflight({
      VIBELOOP_ADVERSARY_REVIEWER_COMMAND: 'codex run',
      VIBELOOP_ADVERSARY_REVIEWER_PROVIDER: 'codex',
      VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM: '1',
      VIBELOOP_PRODUCT_100_BUILDER_COMMAND: 'codex run'
    });
    expect(same.ok).toBe(false);
    expect(same.required_failures).toContain('reviewer_same_command_as_builder');
  });

  it('separates missing R1 image from generic container smoke failure', () => {
    const report = normalizeAdversaryPreflightReport({
      status: 'blocked',
      reason: 'CONTAINER_SMOKE_UNAVAILABLE',
      required_failures: ['container_smoke'],
      checks: {
        container_smoke: {
          stderr: 'Unable to find image node:22-alpine locally: No such image'
        }
      }
    });
    expect(report.reason).toBe('CONTAINER_IMAGE_UNAVAILABLE');
    expect(report.required_failures).toEqual(['container_image']);
  });

  it('passes release-grade preflight when postgres is required and available', async () => {
    const report = await buildProduct100PreflightReport({
      liveReport: passLive,
      adversaryReport: passR1,
      postgresReport: passPostgres,
      executionImageReport: passImages,
      reviewerReport: passReviewer,
      requirePostgres: true
    });
    expect(report.status).toBe('pass');
  });

  it('checks every Product-100 execution image, including Python image support', async () => {
    const calls = [];
    const report = await buildProduct100ExecutionImagePreflight({
      artifacts: [
        { eval: { execution: { image: 'node:22-alpine' } } },
        { eval: { execution: { image: 'python:3.12-alpine' } } }
      ],
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        return {
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: args.includes('python:3.12-alpine') ? 'Python 3.12.0' : '{"ok":true}',
          stderr: ''
        };
      }
    });
    expect(report.status).toBe('pass');
    expect(report.images).toEqual(['node:22-alpine', 'python:3.12-alpine']);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['node:22-alpine']),
        expect.arrayContaining(['python:3.12-alpine'])
      ])
    );
  });

  it('blocks Product-100 preflight when a required execution image is unavailable', async () => {
    const report = await buildProduct100PreflightReport({
      liveReport: passLive,
      adversaryReport: passR1,
      postgresReport: passPostgres,
      reviewerReport: passReviewer,
      executionImageReport: {
        status: 'blocked',
        required_failures: ['execution_image:python:3.12-alpine'],
        images: ['python:3.12-alpine'],
        checks: {}
      }
    });
    expect(report.status).toBe('blocked');
    expect(report.blocked_requirements).toContain(
      'product_100_execution_images_pass'
    );
  });
});
