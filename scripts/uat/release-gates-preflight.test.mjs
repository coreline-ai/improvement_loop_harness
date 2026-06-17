import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BLOCKED_EXIT,
  buildReleaseGatePreflightReport,
  latestEvidenceBundle,
  parseJsonTail,
  releaseGateExitCode
} from './release-gates-preflight.mjs';
import {
  REQUIRED_ATTACK_SCENARIOS,
  buildAdversaryLiveAttackScenarios
} from './adversary-live-safety.mjs';
import {
  buildCommandAdversaryReviewerProvenance,
  buildControlledAdversaryReviewerProvenance
} from './adversary-live-contract.mjs';

const cleanup = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-release-gates-'));
  cleanup.push(root);
  return root;
}

async function writeLedger(
  root,
  scenario,
  runId,
  mtime = new Date(),
  patch = {}
) {
  const runDir = path.join(root, scenario, runId);
  const ledger = path.join(runDir, 'ledger.json');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    ledger,
    `${JSON.stringify({ scenario, run_id: runId, ...patch })}\n`
  );
  await utimes(ledger, mtime, mtime);
  return ledger;
}

async function writeManifest(root, scenario, runId, patch = {}) {
  const runDir = path.join(root, scenario, runId);
  const manifest = path.join(runDir, 'uat-evidence-manifest.json');
  const ledger = path.join(runDir, 'ledger.json');
  const ledgerStat = await stat(ledger);
  const ledgerHash = createHash('sha256')
    .update(await readFile(ledger))
    .digest('hex');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    manifest,
    `${JSON.stringify(
      {
        schema_version: '1.0',
        scenario,
        run_id: runId,
        ledger_ref: 'ledger.json',
        copied: [
          {
            kind: 'ledger',
            bundle_path: 'ledger.json',
            sha256: ledgerHash,
            size_bytes: ledgerStat.size
          }
        ],
        missing: [],
        ...patch
      },
      null,
      2
    )}\n`
  );
  return manifest;
}

async function copiedEntry(root, scenario, runId, bundlePath, kind = 'report') {
  const filePath = path.join(root, scenario, runId, bundlePath);
  const fileStat = await stat(filePath);
  const fileHash = createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
  return {
    kind,
    bundle_path: bundlePath,
    sha256: fileHash,
    size_bytes: fileStat.size
  };
}

function validAttackScenarios() {
  const expectedById = new Map(
    buildAdversaryLiveAttackScenarios().map((scenario) => [
      scenario.id,
      scenario
    ])
  );
  return {
    checked_count: REQUIRED_ATTACK_SCENARIOS.length,
    passed_count: REQUIRED_ATTACK_SCENARIOS.length,
    check: { ok: true, failures: [] },
    results: REQUIRED_ATTACK_SCENARIOS.map((id) => {
      const expected = expectedById.get(id);
      return {
        id,
        passed: true,
        live_required: true,
        required_signal: expected.required_signal,
        expected_outcome: expected.expected_outcome,
        stage:
          id === 'prompt_injection'
            ? 'authority_invariant'
            : id === 'visible_only_hardcode'
              ? 'n_plus_one_rulepack_semantic'
              : 'static_filter',
        mechanism:
          id === 'prompt_injection'
            ? 'authority_invariant:advisory_only'
            : id === 'visible_only_hardcode'
              ? 'rulepack_semantic:visible_only_hardcode'
              : id === 'hidden_artifact_leak'
                ? 'static_filter:no_hidden_leak'
                : 'static_filter:no_weakening',
        executed: id === 'visible_only_hardcode',
        blocked: true,
        current_loop_impact: 'none',
        pr_created: false,
        promotion_allowed: false
      };
    })
  };
}

function validAdversarySafetyLedger() {
  return {
    adversary_reviewer: buildControlledAdversaryReviewerProvenance(),
    safety_check: { ok: true, failures: [] },
    safety: {
      host_execution_allowed: false,
      current_loop_decision_impact: 'none',
      proposal_authority: 'advisory_only',
      required_preflights: ['container_runtime', 'container_smoke'],
      m2: {
        execute: true,
        isolation: 'container',
        network: 'none',
        timeout_ms: 30000
      },
      m4: {
        execute: true,
        isolation: 'container',
        network: 'none',
        timeout_ms: 30000
      },
      frozen_rulepack: {
        authority: 'fixed_next_loop_gate',
        decision_impact: 'next_loop_only',
        same_loop_application_allowed: false
      },
      n_plus_one: {
        gate: 'builtin:rulepack-semantic',
        required: true,
        expected_bad_status: 'fail'
      }
    },
    m2: {
      executed: true,
      runtime_available: true,
      all_confirmed: true
    },
    m4: {
      executed: true,
      replay_safe: true
    }
  };
}

function validPostgresLedger() {
  return {
    status: 'POSTGRES_CONTRACT_PASS',
    evidence_missing_count: 0,
    checks: {
      test_database_url: {
        ok: true,
        status: 'pass'
      },
      database_connection: {
        ok: true,
        status: 'pass'
      },
      prisma_store_smoke: {
        ok: true,
        status: 'pass',
        checks: {
          candidate_roundtrip: 'pass',
          security_metadata_roundtrip: 'pass',
          duplicate_fingerprint_rejected: 'pass'
        }
      }
    },
    test_result: {
      status: 'pass',
      exit_code: 0
    }
  };
}

function repoMatrixCells(overrides = {}) {
  const cells = [
    {
      id: 'node-single',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'node-lockfile-provisioning',
      status: 'pass',
      dependency_provisioning: { status: 'cache_miss', manager: 'npm' }
    },
    {
      id: 'node-pnpm-lockfile-provisioning',
      status: 'pass',
      dependency_provisioning: { status: 'cache_miss', manager: 'pnpm' }
    },
    {
      id: 'node-yarn-lockfile-provisioning',
      status: 'pass',
      dependency_provisioning: { status: 'cache_miss', manager: 'yarn' }
    },
    {
      id: 'python-stdlib',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'ruby-stdlib',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'java-stdlib',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'swift-stdlib',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'typescript-esm',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'js-monorepo-scope',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'react-next-like',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'cli-tool',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'no-package-manager',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'large-file-count',
      status: 'pass',
      dependency_provisioning: { status: 'skipped' }
    },
    {
      id: 'dirty-worktree',
      status: 'blocked',
      provisioning: { status: 'not_run' }
    },
    {
      id: 'network-restricted-r1',
      status: 'unsupported',
      provisioning: { status: 'unsupported' }
    }
  ];
  return cells.map((cell) => ({ ...cell, ...(overrides[cell.id] ?? {}) }));
}

describe('release gate preflight', () => {
  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('parses the JSON report out of pnpm lifecycle output', () => {
    const parsed = parseJsonTail(`noise { not json }
> vibeloop-harness@0.1.0 uat:postgres-contract-preflight
> node scripts/uat/postgres-contract-uat.mjs --preflight

{
  "status": "blocked",
  "reason": "TEST_DATABASE_URL_UNAVAILABLE",
  "required_failures": ["test_database_url"],
  "details": { "message": "brace } inside a string is harmless" }
}

ELIFECYCLE Command failed with exit code 20.`);

    expect(parsed).toEqual({
      status: 'blocked',
      reason: 'TEST_DATABASE_URL_UNAVAILABLE',
      required_failures: ['test_database_url'],
      details: {
        message: 'brace } inside a string is harmless'
      }
    });
  });

  it('selects the newest evidence ledger for a scenario', async () => {
    const root = await tempRoot();
    const oldTime = new Date('2026-06-15T00:00:00.000Z');
    const newTime = new Date('2026-06-15T01:00:00.000Z');
    await writeLedger(root, 'repo-matrix-uat', 'old-run', oldTime);
    const latestLedger = await writeLedger(
      root,
      'repo-matrix-uat',
      'new-run',
      newTime
    );

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root)
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      scenario: 'repo-matrix-uat',
      run_id: 'new-run',
      ledger: latestLedger
    });
  });

  it('validates required evidence manifests for live scenarios', async () => {
    const root = await tempRoot();
    const ledger = await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'live-run'
    );
    const manifest = await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'live-run'
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true,
        expectedStatus: undefined
      })
    ).resolves.toMatchObject({
      ok: true,
      status: 'present',
      scenario: 'skill-real-user-codex-live-uat',
      run_id: 'live-run',
      ledger,
      manifest,
      manifest_summary: {
        ledger_ref: 'ledger.json',
        copied_count: 1,
        missing_count: 0
      }
    });
  });

  it('validates expected evidence ledger status and scenario', async () => {
    const root = await tempRoot();
    const ledger = await writeLedger(
      root,
      'repo-matrix-uat',
      'matrix-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'matrix-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS'
      })
    ).resolves.toMatchObject({
      ok: true,
      expected_status: 'REPO_MATRIX_PASS',
      ledger,
      ledger_summary: {
        status: 'REPO_MATRIX_PASS',
        scenario: 'repo-matrix-uat',
        run_id: 'matrix-run',
        evidence_missing_count: 0
      }
    });

    await writeLedger(
      root,
      'repo-matrix-uat',
      'bad-matrix-run',
      new Date('2026-06-15T03:00:00.000Z'),
      {
        status: 'REPO_MATRIX_FAIL',
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'bad-matrix-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS'
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      expected_status: 'REPO_MATRIX_PASS',
      ledger_failures: ['status']
    });
  });

  it('validates repo matrix ledger counts and dependency provisioning', async () => {
    const root = await tempRoot();
    const requiredCells = [
      { id: 'node-single', status: 'pass', provisioning_status: 'skipped' },
      {
        id: 'node-lockfile-provisioning',
        status: 'pass',
        provisioning_status: 'cache_miss',
        provisioning_manager: 'npm'
      },
      {
        id: 'node-pnpm-lockfile-provisioning',
        status: 'pass',
        provisioning_status: 'cache_miss',
        provisioning_manager: 'pnpm'
      },
      {
        id: 'node-yarn-lockfile-provisioning',
        status: 'pass',
        provisioning_status: 'cache_miss',
        provisioning_manager: 'yarn'
      },
      { id: 'python-stdlib', status: 'pass' },
      { id: 'ruby-stdlib', status: 'pass' },
      { id: 'java-stdlib', status: 'pass' },
      { id: 'swift-stdlib', allowed_statuses: ['pass', 'unsupported'] },
      { id: 'typescript-esm', status: 'pass', provisioning_status: 'skipped' },
      { id: 'js-monorepo-scope', status: 'pass' },
      { id: 'react-next-like', status: 'pass' },
      { id: 'cli-tool', status: 'pass' },
      {
        id: 'no-package-manager',
        status: 'pass',
        provisioning_status: 'skipped'
      },
      { id: 'large-file-count', status: 'pass' },
      {
        id: 'dirty-worktree',
        status: 'blocked',
        provisioning_status: 'not_run'
      },
      {
        id: 'network-restricted-r1',
        status: 'unsupported',
        provisioning_status: 'unsupported'
      }
    ];
    const ledger = await writeLedger(
      root,
      'repo-matrix-uat',
      'matrix-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        cell_count: 16,
        pass_count: 14,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 16,
          statuses: {
            skipped: 11,
            cache_miss: 3,
            not_run: 1,
            unsupported: 1
          }
        },
        cells: repoMatrixCells(),
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'matrix-run');

    const expectedLedger = {
      min_cell_count: 16,
      min_pass_count: 13,
      max_fail_count: 0,
      min_dependency_checked_count: 16,
      min_dependency_cache_miss_count: 3,
      required_cells: requiredCells
    };

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS',
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: true,
      expected_ledger: expectedLedger,
      ledger,
      ledger_summary: {
        cell_count: 16,
        pass_count: 14,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 16,
          statuses: {
            cache_miss: 3
          }
        },
        cells: expect.arrayContaining([
          expect.objectContaining({
            id: 'java-stdlib',
            status: 'pass',
            provisioning_status: 'skipped'
          }),
          expect.objectContaining({
            id: 'swift-stdlib',
            status: 'pass',
            provisioning_status: 'skipped'
          }),
          expect.objectContaining({
            id: 'network-restricted-r1',
            status: 'unsupported',
            provisioning_status: 'unsupported'
          })
        ])
      }
    });

    await writeLedger(
      root,
      'repo-matrix-uat',
      'swift-unsupported-run',
      new Date('2026-06-15T02:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        cell_count: 16,
        pass_count: 13,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 16,
          statuses: {
            skipped: 10,
            cache_miss: 3,
            not_run: 1,
            unsupported: 2
          }
        },
        cells: repoMatrixCells({
          'swift-stdlib': {
            status: 'unsupported',
            dependency_provisioning: undefined,
            provisioning: { status: 'unsupported' }
          }
        }),
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'swift-unsupported-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS',
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: true,
      ledger_summary: {
        cell_count: 16,
        pass_count: 13,
        dependency_provisioning: {
          checked_count: 16,
          statuses: {
            unsupported: 2
          }
        },
        cells: expect.arrayContaining([
          expect.objectContaining({
            id: 'swift-stdlib',
            status: 'unsupported',
            provisioning_status: 'unsupported'
          })
        ])
      }
    });

    await writeLedger(
      root,
      'repo-matrix-uat',
      'bad-matrix-run',
      new Date('2026-06-15T03:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        cell_count: 16,
        pass_count: 14,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 16,
          statuses: {
            skipped: 16
          }
        },
        cells: repoMatrixCells(),
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'bad-matrix-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS',
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: ['dependency_provisioning.cache_miss']
    });

    await writeLedger(
      root,
      'repo-matrix-uat',
      'missing-java-run',
      new Date('2026-06-15T04:00:00.000Z'),
      {
        status: 'REPO_MATRIX_PASS',
        cell_count: 16,
        pass_count: 14,
        fail_count: 0,
        dependency_provisioning: {
          checked_count: 16,
          statuses: {
            skipped: 11,
            cache_miss: 3,
            not_run: 1,
            unsupported: 1
          }
        },
        cells: repoMatrixCells().filter((cell) => cell.id !== 'java-stdlib'),
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'repo-matrix-uat', 'missing-java-run');

    await expect(
      latestEvidenceBundle('repo-matrix-uat', root, {
        requireManifest: true,
        expectedStatus: 'REPO_MATRIX_PASS',
        expectedLedger
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: ['cells.java-stdlib']
    });
  });

  it('fails live evidence when the required manifest is missing or incomplete', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'missing-manifest',
      new Date('2026-06-15T01:00:00.000Z')
    );
    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'missing_or_invalid_manifest',
      run_id: 'missing-manifest'
    });

    const newer = new Date('2026-06-15T02:00:00.000Z');
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'invalid-manifest',
      newer
    );
    await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'invalid-manifest',
      {
        missing: [{ kind: 'report', reason: 'missing' }]
      }
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_manifest',
      run_id: 'invalid-manifest',
      manifest_failures: ['missing_count']
    });
  });

  it('fails evidence when the manifest copied file integrity is invalid', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'bad-integrity',
      new Date('2026-06-15T01:00:00.000Z')
    );
    await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'bad-integrity',
      {
        copied: [
          {
            kind: 'ledger',
            bundle_path: 'ledger.json',
            sha256: '0'.repeat(64),
            size_bytes: 9999
          }
        ]
      }
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_manifest',
      run_id: 'bad-integrity',
      manifest_failures: expect.arrayContaining([
        'copied[0].size_bytes',
        'copied[0].sha256'
      ])
    });
  });

  it('fails evidence when the manifest ledger ref is not in copied artifacts', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'missing-ledger-copy',
      new Date('2026-06-15T01:00:00.000Z')
    );
    const reportPath = path.join(
      root,
      'skill-real-user-codex-live-uat',
      'missing-ledger-copy',
      'report.json'
    );
    await writeFile(reportPath, '{"ok":true}\n');
    await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'missing-ledger-copy',
      {
        copied: [
          await copiedEntry(
            root,
            'skill-real-user-codex-live-uat',
            'missing-ledger-copy',
            'report.json'
          )
        ]
      }
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_manifest',
      run_id: 'missing-ledger-copy',
      manifest_failures: expect.arrayContaining(['ledger_ref_copied'])
    });
  });

  it('fails evidence when the manifest repeats a copied bundle path', async () => {
    const root = await tempRoot();
    await writeLedger(
      root,
      'skill-real-user-codex-live-uat',
      'duplicate-copy',
      new Date('2026-06-15T01:00:00.000Z')
    );
    const ledgerEntry = await copiedEntry(
      root,
      'skill-real-user-codex-live-uat',
      'duplicate-copy',
      'ledger.json',
      'ledger'
    );
    await writeManifest(
      root,
      'skill-real-user-codex-live-uat',
      'duplicate-copy',
      {
        copied: [ledgerEntry, ledgerEntry]
      }
    );

    await expect(
      latestEvidenceBundle('skill-real-user-codex-live-uat', root, {
        requireManifest: true
      })
    ).resolves.toMatchObject({
      ok: false,
      status: 'invalid_manifest',
      run_id: 'duplicate-copy',
      manifest_failures: expect.arrayContaining([
        'copied[1].bundle_path_duplicate'
      ])
    });
  });

  it('reports blocked release gates without dumping nested preflight stdout', async () => {
    const root = await tempRoot();
    await writeLedger(root, 'skill-real-user-codex-live-uat', 'live-run');
    await writeLedger(root, 'repo-matrix-uat', 'matrix-run');

    const report = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P0', name: 'live environment', command: ['p0'] },
        { gate: 'P2', name: 'Postgres contract', command: ['p2'] },
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios: [
        {
          gate: 'P3',
          name: 'live Codex evidence bundle',
          scenario: 'skill-real-user-codex-live-uat'
        },
        {
          gate: 'P5',
          name: 'controlled repo matrix evidence',
          scenario: 'repo-matrix-uat'
        }
      ],
      runCommand: async (command) => {
        if (command === 'p0') {
          return { status: 'pass', exit_code: 0, report: { status: 'pass' } };
        }
        if (command === 'p2') {
          return {
            status: 'blocked',
            exit_code: BLOCKED_EXIT,
            stdout: 'large nested stdout',
            stderr: '',
            report: {
              status: 'blocked',
              reason: 'TEST_DATABASE_URL_UNAVAILABLE',
              required_failures: ['test_database_url'],
              next_step:
                'Start an isolated PostgreSQL database or run corepack pnpm uat:postgres-contract:docker.',
              checks: {
                test_database_url: {
                  ok: false,
                  status: 'missing',
                  value: ''
                }
              }
            }
          };
        }
        return {
          status: 'blocked',
          exit_code: BLOCKED_EXIT,
          stdout: 'large nested stdout',
          stderr: '',
          report: {
            status: 'blocked',
            reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
            required_failures: ['container_runtime'],
            checks: {
              container_runtime: {
                ok: false,
                status: 'spawn_error',
                stderr: 'spawn docker ENOENT'
              }
            },
            safety_check: { ok: true, failures: [] },
            safety: {
              host_execution_allowed: false,
              current_loop_decision_impact: 'none',
              m2: { isolation: 'container', network: 'none' },
              m4: { isolation: 'container', network: 'none' },
              frozen_rulepack: { decision_impact: 'next_loop_only' }
            }
          }
        };
      }
    });

    expect(report.status).toBe('blocked');
    expect(report.blocked_gates).toEqual(['P2', 'P4']);
    expect(report.failed_gates).toEqual([]);
    expect(report.preflights[1]).toMatchObject({
      reason: 'TEST_DATABASE_URL_UNAVAILABLE',
      required_failures: ['test_database_url'],
      next_step:
        'Start an isolated PostgreSQL database or run corepack pnpm uat:postgres-contract:docker.',
      checks: {
        test_database_url: {
          ok: false,
          status: 'missing'
        }
      }
    });
    expect(report.preflights[2]).toMatchObject({
      reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
      required_failures: ['container_runtime'],
      checks: {
        container_runtime: {
          ok: false,
          status: 'spawn_error'
        }
      },
      safety_check: { ok: true, failures: [] },
      safety: {
        host_execution_allowed: false,
        current_loop_decision_impact: 'none',
        m2: { isolation: 'container', network: 'none' },
        m4: { isolation: 'container', network: 'none' },
        frozen_rulepack: { decision_impact: 'next_loop_only' }
      }
    });
    expect(report.preflights[1]).not.toHaveProperty('stdout');
    expect(releaseGateExitCode(report)).toBe(BLOCKED_EXIT);
  });

  it('requires P2 Postgres contract evidence only after the P2 preflight passes', async () => {
    const root = await tempRoot();
    const evidenceScenarios = [
      {
        gate: 'P2',
        name: 'Postgres contract evidence',
        scenario: 'postgres-contract-uat',
        require_manifest: true,
        expected_status: 'POSTGRES_CONTRACT_PASS',
        require_when_preflight_gate_passes: 'P2',
        expected_ledger: {
          required_checks: [
            'test_database_url',
            'database_connection',
            'prisma_store_smoke'
          ],
          expected_test_result_status: 'pass'
        }
      }
    ];

    const blockedReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [{ gate: 'P2', name: 'Postgres contract', command: ['p2'] }],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'blocked',
        exit_code: BLOCKED_EXIT,
        report: {
          status: 'blocked',
          reason: 'TEST_DATABASE_URL_UNAVAILABLE',
          required_failures: ['test_database_url']
        }
      })
    });

    expect(blockedReport.status).toBe('blocked');
    expect(blockedReport.blocked_gates).toEqual(['P2']);
    expect(blockedReport.failed_gates).toEqual([]);
    expect(blockedReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'blocked_by_preflight',
      scenario: 'postgres-contract-uat',
      required_preflight_gate: 'P2',
      preflight_status: 'blocked',
      reason: 'TEST_DATABASE_URL_UNAVAILABLE'
    });
    expect(releaseGateExitCode(blockedReport)).toBe(BLOCKED_EXIT);

    const missingEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [{ gate: 'P2', name: 'Postgres contract', command: ['p2'] }],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(missingEvidenceReport.status).toBe('fail');
    expect(missingEvidenceReport.failed_gates).toEqual(['P2']);
    expect(missingEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'missing',
      scenario: 'postgres-contract-uat'
    });
    expect(releaseGateExitCode(missingEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'postgres-contract-uat',
      'postgres-run-invalid',
      new Date('2026-06-15T00:30:00.000Z'),
      {
        status: 'POSTGRES_CONTRACT_PASS',
        evidence_missing_count: 0,
        checks: {
          test_database_url: { ok: true, status: 'pass' }
        },
        test_result: { status: 'fail', exit_code: 1 }
      }
    );
    await writeManifest(root, 'postgres-contract-uat', 'postgres-run-invalid');

    const invalidEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [{ gate: 'P2', name: 'Postgres contract', command: ['p2'] }],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(invalidEvidenceReport.status).toBe('fail');
    expect(invalidEvidenceReport.failed_gates).toEqual(['P2']);
    expect(invalidEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'checks.database_connection',
        'checks.prisma_store_smoke',
        'test_result.status'
      ])
    });

    await writeLedger(
      root,
      'postgres-contract-uat',
      'postgres-run',
      new Date('2026-06-15T01:00:00.000Z'),
      validPostgresLedger()
    );
    await writeManifest(root, 'postgres-contract-uat', 'postgres-run');

    const presentEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [{ gate: 'P2', name: 'Postgres contract', command: ['p2'] }],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(presentEvidenceReport.status).toBe('pass');
    expect(presentEvidenceReport.failed_gates).toEqual([]);
    expect(presentEvidenceReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'present',
      expected_status: 'POSTGRES_CONTRACT_PASS',
      ledger_summary: {
        checks: {
          test_database_url: { ok: true, status: 'pass' },
          database_connection: { ok: true, status: 'pass' }
        },
        test_result: { status: 'pass', exit_code: 0 }
      },
      manifest_summary: {
        ledger_ref: 'ledger.json',
        missing_count: 0
      }
    });
    expect(releaseGateExitCode(presentEvidenceReport)).toBe(0);

  });

  it('requires P4 live evidence only after the P4 runtime preflight passes', async () => {
    const root = await tempRoot();
    const evidenceScenarios = [
      {
        gate: 'P4',
        name: 'adversary live evidence bundle',
        scenario: 'adversary-live-uat',
        require_manifest: true,
        expected_status: 'ADVERSARY_LIVE_PASS',
        require_when_preflight_gate_passes: 'P4',
        expected_ledger: {
          required_attack_scenarios: REQUIRED_ATTACK_SCENARIOS,
          required_adversary_safety: true,
          required_adversary_reviewer_provenance: true
        }
      }
    ];

    const blockedReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'blocked',
        exit_code: BLOCKED_EXIT,
        report: {
          status: 'blocked',
          reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
          required_failures: ['container_runtime']
        }
      })
    });

    expect(blockedReport.status).toBe('blocked');
    expect(blockedReport.blocked_gates).toEqual(['P4']);
    expect(blockedReport.failed_gates).toEqual([]);
    expect(blockedReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'blocked_by_preflight',
      scenario: 'adversary-live-uat',
      required_preflight_gate: 'P4',
      preflight_status: 'blocked',
      reason: 'CONTAINER_RUNTIME_UNAVAILABLE'
    });
    expect(releaseGateExitCode(blockedReport)).toBe(BLOCKED_EXIT);

    const missingEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(missingEvidenceReport.status).toBe('fail');
    expect(missingEvidenceReport.blocked_gates).toEqual([]);
    expect(missingEvidenceReport.failed_gates).toEqual(['P4']);
    expect(missingEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'missing',
      scenario: 'adversary-live-uat'
    });
    expect(releaseGateExitCode(missingEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-invalid',
      new Date('2026-06-15T00:30:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0
      }
    );
    await writeManifest(root, 'adversary-live-uat', 'adversary-run-invalid');

    const invalidAttackEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(invalidAttackEvidenceReport.status).toBe('fail');
    expect(invalidAttackEvidenceReport.failed_gates).toEqual(['P4']);
    expect(invalidAttackEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'attack_scenarios.test_weakening',
        'attack_scenarios.hidden_artifact_leak',
        'attack_scenarios.prompt_injection',
        'attack_scenarios.visible_only_hardcode'
      ])
    });
    expect(releaseGateExitCode(invalidAttackEvidenceReport)).toBe(1);

    const impactAttackScenarios = validAttackScenarios();
    impactAttackScenarios.results[0] = {
      ...impactAttackScenarios.results[0],
      live_required: false,
      current_loop_impact: 'current_loop_accept',
      pr_created: true,
      promotion_allowed: true,
      blocked: false
    };
    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-impact',
      new Date('2026-06-15T00:40:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: impactAttackScenarios,
        ...validAdversarySafetyLedger()
      }
    );
    await writeManifest(root, 'adversary-live-uat', 'adversary-run-impact');

    const impactEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(impactEvidenceReport.status).toBe('fail');
    expect(impactEvidenceReport.failed_gates).toEqual(['P4']);
    expect(impactEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'attack_scenarios.test_weakening.live_required',
        'attack_scenarios.test_weakening.current_loop_impact',
        'attack_scenarios.test_weakening.pr_created',
        'attack_scenarios.test_weakening.promotion_allowed',
        'attack_scenarios.test_weakening.blocked'
      ])
    });
    expect(releaseGateExitCode(impactEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-unsafe',
      new Date('2026-06-15T00:45:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: validAttackScenarios(),
        ...validAdversarySafetyLedger(),
        safety: {
          ...validAdversarySafetyLedger().safety,
          host_execution_allowed: true,
          m4: {
            ...validAdversarySafetyLedger().safety.m4,
            network: 'bridge'
          }
        },
        m4: {
          executed: false,
          replay_safe: true
        }
      }
    );
    await writeManifest(root, 'adversary-live-uat', 'adversary-run-unsafe');

    const unsafeEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(unsafeEvidenceReport.status).toBe('fail');
    expect(unsafeEvidenceReport.failed_gates).toEqual(['P4']);
    expect(unsafeEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'adversary_safety.host_execution_allowed',
        'adversary_safety.m4.network',
        'adversary_safety.m4.run_executed'
      ])
    });
    expect(releaseGateExitCode(unsafeEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-reviewer-overclaim',
      new Date('2026-06-15T00:50:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: validAttackScenarios(),
        ...validAdversarySafetyLedger(),
        adversary_reviewer: {
          ...buildControlledAdversaryReviewerProvenance(),
          real_llm: true,
          current_loop_decision_impact: 'accept'
        }
      }
    );
    await writeManifest(
      root,
      'adversary-live-uat',
      'adversary-run-reviewer-overclaim'
    );

    const reviewerEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(reviewerEvidenceReport.status).toBe('fail');
    expect(reviewerEvidenceReport.failed_gates).toEqual(['P4']);
    expect(reviewerEvidenceReport.evidence[0]).toMatchObject({
      ok: false,
      status: 'invalid_ledger',
      ledger_failures: expect.arrayContaining([
        'adversary_reviewer.real_llm',
        'adversary_reviewer.current_loop_decision_impact'
      ])
    });
    expect(releaseGateExitCode(reviewerEvidenceReport)).toBe(1);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run',
      new Date('2026-06-15T01:00:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: validAttackScenarios(),
        ...validAdversarySafetyLedger()
      }
    );
    await writeManifest(root, 'adversary-live-uat', 'adversary-run');

    const presentEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(presentEvidenceReport.status).toBe('pass');
    expect(presentEvidenceReport.failed_gates).toEqual([]);
    expect(presentEvidenceReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'present',
      expected_status: 'ADVERSARY_LIVE_PASS',
      manifest_summary: {
        ledger_ref: 'ledger.json',
        missing_count: 0
      },
      ledger_summary: {
        adversary_reviewer: {
          kind: 'controlled_command',
          real_llm: false,
          provider: 'controlled-command',
          proposal_source: 'deterministic_fixture',
          current_loop_decision_impact: 'none'
        },
        adversary_safety: {
          safety_check: { ok: true, failures: [] },
          host_execution_allowed: false,
          m2: {
            isolation: 'container',
            network: 'none',
            run_executed: true
          },
          m4: {
            isolation: 'container',
            network: 'none',
            run_executed: true
          }
        }
      }
    });
    expect(releaseGateExitCode(presentEvidenceReport)).toBe(0);

    await writeLedger(
      root,
      'adversary-live-uat',
      'adversary-run-real-reviewer',
      new Date('2026-06-15T01:05:00.000Z'),
      {
        status: 'ADVERSARY_LIVE_PASS',
        evidence_missing_count: 0,
        attack_scenarios: validAttackScenarios(),
        ...validAdversarySafetyLedger(),
        adversary_reviewer: buildCommandAdversaryReviewerProvenance({
          realLlm: true,
          reviewReport: {
            reviewer_provider: 'openai',
            same_model_review: false,
            prompt_version: 'adversary-review-v1',
            prompt_hash: 'sha256:reviewer',
            accepted_proposal_count: 1
          }
        })
      }
    );
    await writeManifest(
      root,
      'adversary-live-uat',
      'adversary-run-real-reviewer'
    );

    const realReviewerEvidenceReport = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios,
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(realReviewerEvidenceReport.status).toBe('pass');
    expect(realReviewerEvidenceReport.evidence[0]).toMatchObject({
      ok: true,
      status: 'present',
      ledger_summary: {
        adversary_reviewer: {
          kind: 'adversary_review_command',
          real_llm: true,
          provider: 'openai',
          proposal_source: 'accepted_review_proposal',
          current_loop_decision_impact: 'none',
          accepted_proposal_count: 1
        }
      }
    });
  });

  it('fails the release gate report when required evidence is missing', async () => {
    const root = await tempRoot();
    const report = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P0', name: 'live environment', command: ['p0'] },
        { gate: 'P2', name: 'Postgres contract', command: ['p2'] },
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios: [
        {
          gate: 'P3',
          name: 'live Codex evidence bundle',
          scenario: 'skill-real-user-codex-live-uat'
        }
      ],
      runCommand: async () => ({
        status: 'pass',
        exit_code: 0,
        report: { status: 'pass' }
      })
    });

    expect(report.status).toBe('fail');
    expect(report.failed_gates).toEqual(['P3']);
    expect(releaseGateExitCode(report)).toBe(1);
  });

  it('fails P4 when nested adversary safety metadata is invalid', async () => {
    const root = await tempRoot();
    await writeLedger(root, 'skill-real-user-codex-live-uat', 'live-run');
    const report = await buildReleaseGatePreflightReport({
      evidenceRoot: root,
      preflights: [
        { gate: 'P4', name: 'adversary live runtime', command: ['p4'] }
      ],
      evidenceScenarios: [
        {
          gate: 'P3',
          name: 'live Codex evidence bundle',
          scenario: 'skill-real-user-codex-live-uat'
        }
      ],
      runCommand: async () => ({
        status: 'blocked',
        exit_code: BLOCKED_EXIT,
        report: {
          status: 'blocked',
          reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
          required_failures: ['container_runtime'],
          safety_check: {
            ok: false,
            failures: ['host_execution_allowed_must_be_false']
          }
        }
      })
    });

    expect(report.status).toBe('fail');
    expect(report.blocked_gates).toEqual([]);
    expect(report.failed_gates).toEqual(['P4']);
    expect(report.preflights[0]).toMatchObject({
      status: 'fail',
      reason: 'CONTAINER_RUNTIME_UNAVAILABLE',
      safety_check: {
        ok: false,
        failures: ['host_execution_allowed_must_be_false']
      }
    });
    expect(releaseGateExitCode(report)).toBe(1);
  });
});
