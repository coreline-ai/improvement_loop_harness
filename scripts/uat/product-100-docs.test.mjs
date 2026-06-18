import { describe, expect, it } from 'vitest';
import {
  evaluateProduct100DocsTruth,
  runProduct100Phase7DocsCheck
} from './product-100-docs.mjs';
import { PRODUCT_100_PASS_STATUS } from './product-100-contract.mjs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function docs(text) {
  return {
    readme: { path: 'README.md', text },
    runbook: { path: 'runbook.md', text },
    runLedger: { path: 'ledger.md', text }
  };
}

describe('Product-100 Phase7 docs truth check', () => {
  it('passes when docs disclose non-pass status, run id, and missing requirements', () => {
    const ledger = {
      status: 'PRODUCT_100_CODEX_LIVE_FAIL',
      run_id: 'run-1',
      evaluation: {
        missing_requirements: ['github_draft_prs_open']
      }
    };
    const text = [
      'Product-100',
      'run-1',
      'PRODUCT_100_CODEX_LIVE_FAIL',
      'PASS 아님',
      'GitHub draft PR 미완'
    ].join('\n');

    const report = evaluateProduct100DocsTruth({ ledger, docs: docs(text) });

    expect(report.phase7_pass).toBe(true);
    expect(report.docs_run_ledger_readme_truthful).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('fails closed when docs hide non-pass status or missing requirements', () => {
    const report = evaluateProduct100DocsTruth({
      ledger: {
        status: 'PRODUCT_100_CODEX_LIVE_FAIL',
        run_id: 'run-2',
        evaluation: {
          missing_requirements: ['release_evidence_audit_pass']
        }
      },
      docs: docs('Product-100 run-2 everything is good')
    });

    expect(report.phase7_pass).toBe(false);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        'docs.status_missing',
        'docs.non_pass_disclaimer_missing',
        'docs.missing_requirements_not_mentioned'
      ])
    );
  });


  it('does not require dynamic run ids in static docs unless explicitly requested', () => {
    const ledger = {
      status: PRODUCT_100_PASS_STATUS,
      run_id: 'dynamic-run-not-in-docs',
      evaluation: { missing_requirements: [] }
    };
    const text = ['Product-100', PRODUCT_100_PASS_STATUS, 'Product-100 PASS'].join('\n');

    expect(evaluateProduct100DocsTruth({ ledger, docs: docs(text) }).phase7_pass).toBe(true);
    expect(
      evaluateProduct100DocsTruth({
        ledger,
        docs: docs(text),
        requireRunIdInDocs: true
      }).failures
    ).toContain('docs.run_id_missing');
  });

  it('passes a Product-100 PASS ledger only when PASS status is documented', () => {
    const report = evaluateProduct100DocsTruth({
      ledger: {
        status: PRODUCT_100_PASS_STATUS,
        run_id: 'pass-run',
        evaluation: { missing_requirements: [] }
      },
      docs: docs(
        [
          'Product-100',
          'pass-run',
          PRODUCT_100_PASS_STATUS,
          'Product-100 PASS'
        ].join('\n')
      )
    });

    expect(report.phase7_pass).toBe(true);
  });

  it('reads docs and ledger from files', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'p100-docs-'));
    const ledgerFile = path.join(tmp, 'ledger.json');
    await writeFile(
      ledgerFile,
      `${JSON.stringify({
        status: 'PRODUCT_100_CODEX_LIVE_FAIL',
        run_id: 'file-run',
        evaluation: { missing_requirements: ['github_draft_prs_open'] }
      })}\n`
    );
    const text = [
      'Product-100',
      'file-run',
      'PRODUCT_100_CODEX_LIVE_FAIL',
      'PASS 아님',
      'github_draft_prs_open'
    ].join('\n');
    for (const file of ['README.md', 'runbook.md', 'ledger.md']) {
      await mkdir(path.dirname(path.join(tmp, file)), { recursive: true });
      await writeFile(path.join(tmp, file), text);
    }

    const report = await runProduct100Phase7DocsCheck({
      ledgerFile,
      root: tmp,
      docPaths: {
        readme: 'README.md',
        runbook: 'runbook.md',
        runLedger: 'ledger.md'
      }
    });

    expect(report.phase7_pass).toBe(true);
    expect(report.checked_docs.readme).toBe(path.join(tmp, 'README.md'));
  });
});
