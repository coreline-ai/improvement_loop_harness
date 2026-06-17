import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BLOCKED_EXIT,
  artifactNameMatchesPattern,
  artifactPattern,
  buildGitHubReleaseEvidenceAuditReport,
  githubReleaseEvidenceAuditExitCode,
  parseArgs
} from './release-evidence-audit-gh.mjs';

const cleanup = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-gh-audit-'));
  cleanup.push(root);
  return root;
}

async function writeLedger(root, scenario, runId, status) {
  const runDir = path.join(root, scenario, runId);
  const ledger = path.join(runDir, 'ledger.json');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    ledger,
    `${JSON.stringify(
      {
        scenario,
        run_id: runId,
        status,
        evidence_missing_count: 0
      },
      null,
      2
    )}\n`
  );
  return ledger;
}

async function writeManifest(root, scenario, runId) {
  const runDir = path.join(root, scenario, runId);
  const ledger = path.join(runDir, 'ledger.json');
  const ledgerStat = await stat(ledger);
  const ledgerHash = createHash('sha256')
    .update(await readFile(ledger))
    .digest('hex');
  await writeFile(
    path.join(runDir, 'uat-evidence-manifest.json'),
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
        missing: []
      },
      null,
      2
    )}\n`
  );
}

describe('GitHub release evidence audit', () => {
  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('downloads matching GitHub artifacts and audits a custom scenario', async () => {
    const outputDir = await tempRoot();
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'api') {
        return {
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: JSON.stringify({
            artifacts: [
              {
                name: 'uat-evidence-123-2',
                expired: false,
                size_in_bytes: 1234
              }
            ]
          }),
          stderr: ''
        };
      }
      await writeLedger(
        outputDir,
        'skill-real-user-codex-live-uat',
        'live-run',
        'REAL_USER_RUN_PASS'
      );
      await writeManifest(
        outputDir,
        'skill-real-user-codex-live-uat',
        'live-run'
      );
      return {
        ok: true,
        status: 'pass',
        exit_code: 0,
        stdout: 'downloaded',
        stderr: ''
      };
    };

    const report = await buildGitHubReleaseEvidenceAuditReport({
      runId: '123',
      runAttempt: '2',
      repo: 'coreline-ai/improvement_loop_harness',
      outputDir,
      scenarioNames: ['skill-real-user-codex-live-uat'],
      runCommand
    });

    expect(calls).toEqual([
      [
        'gh',
        [
          'api',
          'repos/coreline-ai/improvement_loop_harness/actions/runs/123/artifacts'
        ]
      ],
      [
        'gh',
        [
          'run',
          'download',
          '123',
          '--pattern',
          '*evidence-123-2',
          '--dir',
          outputDir,
          '--repo',
          'coreline-ai/improvement_loop_harness'
        ]
      ]
    ]);
    expect(report.status).toBe('pass');
    expect(report.github).toEqual(
      expect.objectContaining({
        run_id: '123',
        run_attempt: '2',
        artifact_pattern: '*evidence-123-2'
      })
    );
    expect(report.download.attempts[0].artifact_lookup).toEqual(
      expect.objectContaining({
        ok: true,
        artifact_count: 1,
        matching_count: 1,
        matching_artifacts: [
          expect.objectContaining({ name: 'uat-evidence-123-2' })
        ]
      })
    );
    expect(report.audit).toEqual(
      expect.objectContaining({
        status: 'pass',
        scope: 'custom',
        failed_gates: []
      })
    );
    expect(githubReleaseEvidenceAuditExitCode(report)).toBe(0);
  });

  it('uses GitHub Actions env run id as a default explicit target', async () => {
    const outputDir = await tempRoot();
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, args]);
      await writeLedger(
        outputDir,
        'skill-real-user-codex-live-uat',
        'live-run',
        'REAL_USER_RUN_PASS'
      );
      await writeManifest(
        outputDir,
        'skill-real-user-codex-live-uat',
        'live-run'
      );
      return {
        ok: true,
        status: 'pass',
        exit_code: 0,
        stdout: 'downloaded',
        stderr: ''
      };
    };

    const report = await buildGitHubReleaseEvidenceAuditReport({
      env: { GITHUB_RUN_ID: '999', GITHUB_RUN_ATTEMPT: '4' },
      outputDir,
      scenarioNames: ['skill-real-user-codex-live-uat'],
      runCommand
    });

    expect(calls).toEqual([
      [
        'gh',
        [
          'run',
          'download',
          '999',
          '--pattern',
          '*evidence-999-4',
          '--dir',
          outputDir
        ]
      ]
    ]);
    expect(report.status).toBe('pass');
    expect(report.github).toEqual(
      expect.objectContaining({
        run_id: '999',
        run_attempt: '4',
        run_selection: expect.objectContaining({ source: 'environment' })
      })
    );
  });

  it('blocks when GitHub artifact download fails before claiming audit evidence', async () => {
    const outputDir = await tempRoot();
    const report = await buildGitHubReleaseEvidenceAuditReport({
      runId: '123',
      outputDir,
      runCommand: async () => ({
        ok: false,
        status: 'fail',
        exit_code: 1,
        stdout: '',
        stderr: 'no artifacts found'
      })
    });

    expect(report.status).toBe('blocked');
    expect(report.reason).toBe('GH_RELEASE_EVIDENCE_DOWNLOAD_FAILED');
    expect(report.download).toEqual(
      expect.objectContaining({
        directory: outputDir,
        attempts: [
          expect.objectContaining({
            run_id: '123',
            stderr: 'no artifacts found'
          })
        ]
      })
    );
    expect(githubReleaseEvidenceAuditExitCode(report)).toBe(BLOCKED_EXIT);
  });

  it('can select the latest completed run with downloadable evidence artifacts', async () => {
    const outputDir = await tempRoot();
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'run' && args[1] === 'list') {
        return {
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: JSON.stringify([
            {
              databaseId: 222,
              attempt: 1,
              status: 'completed',
              conclusion: 'success',
              headBranch: 'main',
              workflowName: 'CI',
              displayTitle: 'new run without artifacts',
              createdAt: '2026-06-16T00:00:00Z'
            },
            {
              databaseId: 111,
              attempt: 2,
              status: 'completed',
              conclusion: 'success',
              headBranch: 'main',
              workflowName: 'CI',
              displayTitle: 'run with artifacts',
              createdAt: '2026-06-15T00:00:00Z'
            }
          ]),
          stderr: ''
        };
      }
      if (args[2] === '222') {
        return {
          ok: false,
          status: 'fail',
          exit_code: 1,
          stdout: '',
          stderr: 'no valid artifacts found to download'
        };
      }
      await writeLedger(
        outputDir,
        'skill-real-user-codex-live-uat',
        'live-run',
        'REAL_USER_RUN_PASS'
      );
      await writeManifest(
        outputDir,
        'skill-real-user-codex-live-uat',
        'live-run'
      );
      return {
        ok: true,
        status: 'pass',
        exit_code: 0,
        stdout: 'downloaded',
        stderr: ''
      };
    };

    const report = await buildGitHubReleaseEvidenceAuditReport({
      latest: true,
      env: { GITHUB_RUN_ID: '999', GITHUB_RUN_ATTEMPT: '4' },
      latestLimit: 2,
      workflow: 'CI',
      branch: 'main',
      outputDir,
      scenarioNames: ['skill-real-user-codex-live-uat'],
      runCommand
    });

    expect(calls).toEqual([
      [
        'gh',
        [
          'run',
          'list',
          '--limit',
          '2',
          '--status',
          'completed',
          '--json',
          'databaseId,attempt,status,conclusion,headBranch,workflowName,displayTitle,createdAt',
          '--workflow',
          'CI',
          '--branch',
          'main'
        ]
      ],
      [
        'gh',
        [
          'run',
          'download',
          '222',
          '--pattern',
          '*evidence-222-1',
          '--dir',
          outputDir
        ]
      ],
      [
        'gh',
        [
          'run',
          'download',
          '111',
          '--pattern',
          '*evidence-111-2',
          '--dir',
          outputDir
        ]
      ]
    ]);
    expect(report.status).toBe('pass');
    expect(report.github).toEqual(
      expect.objectContaining({
        run_id: '111',
        run_attempt: '2',
        artifact_pattern: '*evidence-111-2',
        run_selection: expect.objectContaining({
          source: 'latest',
          latest_limit: 2
        })
      })
    );
    expect(report.download.attempts).toEqual([
      expect.objectContaining({ run_id: '222', ok: false }),
      expect.objectContaining({ run_id: '111', ok: true })
    ]);
  });

  it('uses artifact listing to skip latest runs without matching evidence artifacts', async () => {
    const outputDir = await tempRoot();
    const calls = [];
    const runCommand = async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'run' && args[1] === 'list') {
        return {
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: JSON.stringify([
            {
              databaseId: 222,
              attempt: 1,
              status: 'completed',
              conclusion: 'success',
              headBranch: 'main',
              workflowName: 'CI',
              displayTitle: 'new run without evidence artifacts',
              createdAt: '2026-06-16T00:00:00Z'
            },
            {
              databaseId: 111,
              attempt: 2,
              status: 'completed',
              conclusion: 'success',
              headBranch: 'main',
              workflowName: 'CI',
              displayTitle: 'run with evidence artifacts',
              createdAt: '2026-06-15T00:00:00Z'
            }
          ]),
          stderr: ''
        };
      }
      if (args[0] === 'api' && args[1].includes('/222/')) {
        return {
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: JSON.stringify({
            artifacts: [{ name: 'unrelated-logs-222-1', expired: false }]
          }),
          stderr: ''
        };
      }
      if (args[0] === 'api' && args[1].includes('/111/')) {
        return {
          ok: true,
          status: 'pass',
          exit_code: 0,
          stdout: JSON.stringify({
            artifacts: [
              { name: 'postgres-contract-evidence-111-2', expired: false }
            ]
          }),
          stderr: ''
        };
      }
      await writeLedger(
        outputDir,
        'skill-real-user-codex-live-uat',
        'live-run',
        'REAL_USER_RUN_PASS'
      );
      await writeManifest(
        outputDir,
        'skill-real-user-codex-live-uat',
        'live-run'
      );
      return {
        ok: true,
        status: 'pass',
        exit_code: 0,
        stdout: 'downloaded',
        stderr: ''
      };
    };

    const report = await buildGitHubReleaseEvidenceAuditReport({
      latest: true,
      latestLimit: 2,
      workflow: 'CI',
      branch: 'main',
      repo: 'coreline-ai/improvement_loop_harness',
      outputDir,
      scenarioNames: ['skill-real-user-codex-live-uat'],
      runCommand
    });

    expect(calls).toEqual([
      [
        'gh',
        [
          'run',
          'list',
          '--limit',
          '2',
          '--status',
          'completed',
          '--json',
          'databaseId,attempt,status,conclusion,headBranch,workflowName,displayTitle,createdAt',
          '--workflow',
          'CI',
          '--branch',
          'main',
          '--repo',
          'coreline-ai/improvement_loop_harness'
        ]
      ],
      [
        'gh',
        [
          'api',
          'repos/coreline-ai/improvement_loop_harness/actions/runs/222/artifacts'
        ]
      ],
      [
        'gh',
        [
          'api',
          'repos/coreline-ai/improvement_loop_harness/actions/runs/111/artifacts'
        ]
      ],
      [
        'gh',
        [
          'run',
          'download',
          '111',
          '--pattern',
          '*evidence-111-2',
          '--dir',
          outputDir,
          '--repo',
          'coreline-ai/improvement_loop_harness'
        ]
      ]
    ]);
    expect(report.status).toBe('pass');
    expect(report.github.run_id).toBe('111');
    expect(report.download.attempts).toEqual([
      expect.objectContaining({
        run_id: '222',
        status: 'missing_artifacts',
        skipped_download: true,
        artifact_lookup: expect.objectContaining({
          ok: true,
          artifact_count: 1,
          matching_count: 0
        })
      }),
      expect.objectContaining({
        run_id: '111',
        ok: true,
        artifact_lookup: expect.objectContaining({
          matching_count: 1,
          matching_artifacts: [
            expect.objectContaining({
              name: 'postgres-contract-evidence-111-2'
            })
          ]
        })
      })
    ]);
  });

  it('blocks when latest run selection fails', async () => {
    const report = await buildGitHubReleaseEvidenceAuditReport({
      latest: true,
      runCommand: async () => ({
        ok: false,
        status: 'fail',
        exit_code: 1,
        stdout: '',
        stderr: 'not authenticated'
      })
    });

    expect(report.status).toBe('blocked');
    expect(report.reason).toBe('GH_RELEASE_RUN_SELECTION_FAILED');
    expect(report.github.run_selection).toEqual(
      expect.objectContaining({
        stderr: 'not authenticated'
      })
    );
    expect(githubReleaseEvidenceAuditExitCode(report)).toBe(BLOCKED_EXIT);
  });

  it('parses run selection and audit scope arguments', () => {
    expect(
      parseArgs(
        [
          '--',
          '--run-id',
          '456',
          '--run-attempt',
          '3',
          '--repo',
          'owner/repo',
          '--output-dir',
          '.ci-release-evidence',
          '--scenario',
          'repo-matrix-uat,skill-real-user-codex-live-uat'
        ],
        {}
      )
    ).toEqual(
      expect.objectContaining({
        runId: '456',
        runAttempt: '3',
        repo: 'owner/repo',
        latest: false,
        outputDir: '.ci-release-evidence',
        scenarioNames: ['repo-matrix-uat', 'skill-real-user-codex-live-uat'],
        allReleaseEvidence: false
      })
    );

    expect(
      parseArgs(['--all-release-evidence'], { GITHUB_RUN_ID: '789' })
    ).toEqual(
      expect.objectContaining({
        allReleaseEvidence: true
      })
    );

    expect(parseArgs(['--latest'], { GITHUB_REPOSITORY: 'owner/repo' })).toEqual(
      expect.objectContaining({
        latest: true,
        repo: 'owner/repo'
      })
    );

    expect(
      parseArgs(
        [
          '--latest',
          '--latest-limit',
          '20',
          '--workflow',
          'CI',
          '--branch',
          'main'
        ],
        {}
      )
    ).toEqual(
      expect.objectContaining({
        latest: true,
        latestLimit: 20,
        workflow: 'CI',
        branch: 'main'
      })
    );
  });

  it('rejects conflicting explicit and latest run selection', async () => {
    await expect(
      buildGitHubReleaseEvidenceAuditReport({
        runId: '123',
        latest: true,
        runCommand: async () => ({ ok: true })
      })
    ).rejects.toThrow('--latest cannot be combined with --run-id');
  });

  it('builds artifact patterns from run id and attempt', () => {
    expect(artifactPattern({ runId: '1', runAttempt: '2' })).toBe(
      '*evidence-1-2'
    );
    expect(artifactPattern({ runId: '1' })).toBe('*evidence-1-*');
    expect(
      artifactPattern({ runId: '1', artifactPattern: 'custom-evidence-*' })
    ).toBe('custom-evidence-*');
    expect(artifactNameMatchesPattern('uat-evidence-1-2', '*evidence-1-2')).toBe(
      true
    );
    expect(artifactNameMatchesPattern('unrelated-1-2', '*evidence-1-2')).toBe(
      false
    );
  });

  it('requires a run id when environment defaults are unavailable', async () => {
    await expect(
      buildGitHubReleaseEvidenceAuditReport({
        env: {},
        runCommand: async () => ({ ok: true })
      })
    ).rejects.toThrow('--run-id is required');
  });
});
