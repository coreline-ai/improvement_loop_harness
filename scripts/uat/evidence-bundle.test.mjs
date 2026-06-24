import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  shouldPruneUatTmp,
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';

const cleanup = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-evidence-test-'));
  cleanup.push(root);
  return root;
}

describe('UAT evidence bundle', () => {
  afterEach(async () => {
    await Promise.all(
      cleanup
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('preserves report files, run roots, proxy stats, and audit_keep manifests', async () => {
    const root = await tempRoot();
    const dataDir = path.join(root, 'data');
    const runRoot = path.join(
      dataDir,
      'projects',
      'project-1',
      'runs',
      'loop-1'
    );
    const reportsDir = path.join(runRoot, 'reports');
    const patchesDir = path.join(runRoot, 'patches');
    const tmpRoot = path.join(root, 'tmp');
    const evidenceDir = path.join(root, 'evidence');
    await mkdir(reportsDir, { recursive: true });
    await mkdir(patchesDir, { recursive: true });
    await mkdir(tmpRoot, { recursive: true });
    await writeFile(
      path.join(runRoot, 'manifest.json'),
      `${JSON.stringify({
        schema_version: '1.0',
        loop_id: 'loop-1',
        project_id: 'project-1',
        status: 'accepted'
      })}\n`
    );
    await writeFile(
      path.join(reportsDir, 'eval-report.json'),
      '{"decision":"accept"}\n'
    );
    await writeFile(
      path.join(reportsDir, 'quality-report.json'),
      '{"met":true}\n'
    );
    await writeFile(path.join(patchesDir, 'candidate.patch'), 'diff --git\n');
    await writeFile(path.join(tmpRoot, 'improve.stdout.log'), '{"ok":true}\n');

    const bundle = await writeUatEvidenceBundle({
      scenario: 'skill-real-user-codex-live-uat',
      runId: 'loop-1',
      tmpRoot,
      dataDir,
      output: {
        selected_report: path.join(reportsDir, 'eval-report.json')
      },
      proxyStats: {
        mode: 'internal-oauth-forwarder',
        requests: 2,
        response_requests: 1,
        model_requests: 1,
        auth_header_seen: true,
        auth_header_missing: false,
        upstream_statuses: [200],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3,
          requests: 1
        }
      },
      extraFiles: [
        {
          label: 'improve_stdout',
          path: path.join(tmpRoot, 'improve.stdout.log')
        }
      ],
      evidenceDir
    });
    const ledgerPath = await writeUatEvidenceLedger(bundle, {
      status: 'REAL_USER_RUN_PASS',
      evidence: { evidence_bundle: bundle.bundle_dir }
    });

    const manifest = JSON.parse(await readFile(bundle.manifest_path, 'utf8'));
    expect(manifest.copied.some((entry) => entry.kind === 'report')).toBe(true);
    expect(manifest.copied.some((entry) => entry.kind === 'run_root')).toBe(
      true
    );
    expect(manifest.proxy_stats_ref).toBe('proxy/proxy-stats.json');
    expect(manifest.ledger_ref).toBe('ledger.json');
    expect(await readFile(ledgerPath, 'utf8')).toContain('REAL_USER_RUN_PASS');

    const copiedManifest = JSON.parse(
      await readFile(
        path.join(
          bundle.bundle_dir,
          'runs',
          'projects',
          'project-1',
          'runs',
          'loop-1',
          'manifest.json'
        ),
        'utf8'
      )
    );
    expect(copiedManifest.audit_keep).toBe(true);
  });

  it('preserves report files referenced from full UAT cases', async () => {
    const root = await tempRoot();
    const dataDir = path.join(root, 'data');
    const runRoot = path.join(
      dataDir,
      'projects',
      'project-1',
      'runs',
      'case-1'
    );
    const reportsDir = path.join(runRoot, 'reports');
    await mkdir(reportsDir, { recursive: true });
    await writeFile(
      path.join(runRoot, 'manifest.json'),
      '{"schema_version":"1.0"}\n'
    );
    await writeFile(
      path.join(reportsDir, 'eval-report.json'),
      '{"decision":"reject"}\n'
    );

    const bundle = await writeUatEvidenceBundle({
      scenario: 'skill-real-user-full-uat',
      runId: 'full-uat-run',
      tmpRoot: root,
      dataDir,
      output: {
        cases: [
          {
            id: 'negative-case',
            report: path.join(reportsDir, 'eval-report.json'),
            artifact_root: runRoot
          }
        ]
      },
      evidenceDir: path.join(root, 'evidence')
    });

    const manifest = JSON.parse(await readFile(bundle.manifest_path, 'utf8'));
    expect(
      manifest.copied.some(
        (entry) =>
          entry.kind === 'report' && entry.label === 'eval-report.json'
      )
    ).toBe(true);
    expect(manifest.copied.some((entry) => entry.kind === 'run_root')).toBe(
      true
    );
  });

  it('keeps repeated run-root basenames at distinct bundle paths', async () => {
    const root = await tempRoot();
    const runRoots = [
      path.join(root, 'data-a', 'projects', 'project-a', 'runs', 'loop-1'),
      path.join(root, 'data-b', 'projects', 'project-b', 'runs', 'loop-1')
    ];
    for (const [index, runRoot] of runRoots.entries()) {
      await mkdir(path.join(runRoot, 'reports'), { recursive: true });
      await writeFile(
        path.join(runRoot, 'manifest.json'),
        `${JSON.stringify({ schema_version: '1.0', index })}\n`
      );
      await writeFile(
        path.join(runRoot, 'reports', 'eval-report.json'),
        `${JSON.stringify({ decision: 'reject', index })}\n`
      );
    }

    const bundle = await writeUatEvidenceBundle({
      scenario: 'skill-real-user-full-uat',
      runId: 'full-uat-duplicates',
      tmpRoot: root,
      output: {
        cases: runRoots.map((runRoot, index) => ({
          id: `case-${index}`,
          artifact_root: runRoot
        }))
      },
      evidenceDir: path.join(root, 'evidence')
    });

    const manifest = JSON.parse(await readFile(bundle.manifest_path, 'utf8'));
    const bundlePaths = manifest.copied.map((entry) => entry.bundle_path);
    expect(new Set(bundlePaths).size).toBe(bundlePaths.length);
    expect(
      manifest.copied.filter(
        (entry) =>
          entry.kind === 'run_root' && entry.bundle_path.endsWith('manifest.json')
      )
    ).toHaveLength(2);
  });

  it('only prunes temp roots when explicitly requested', () => {
    expect(shouldPruneUatTmp({})).toBe(false);
    expect(shouldPruneUatTmp({ VIBELOOP_UAT_PRUNE: '1' })).toBe(true);
    expect(
      shouldPruneUatTmp({
        VIBELOOP_UAT_PRUNE: '1',
        VIBELOOP_UAT_KEEP_TMP: '1'
      })
    ).toBe(false);
  });
});
