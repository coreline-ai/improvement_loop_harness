#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  shouldPruneUatTmp,
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';

export const scenario = 'prototype-failure-retry-loop-uat';
export const passStatus = 'PROTOTYPE_FAILURE_RETRY_LOOP_UAT_PASS';
export const failStatus = 'PROTOTYPE_FAILURE_RETRY_LOOP_UAT_FAIL';

const pruneTmp = shouldPruneUatTmp();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr, ok: code === 0 });
    });
  });
}

async function git(cwd, args) {
  const result = await run('git', args, { cwd });
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const baseCartSource = `function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

module.exports = { total };
`;

const badRetryCartSource = `function total(items) {
  return items.reduce((sum, item) => {
    const quantity = Number(item.quantity ?? 1);
    return sum + item.price + quantity * 0;
  }, 0);
}

module.exports = { total };
`;

const fixedRetryCartSource = `function total(items) {
  return items.reduce((sum, item) => {
    const quantity = Number(item.quantity ?? 1);
    return sum + item.price * quantity;
  }, 0);
}

module.exports = { total };
`;

const cartTestSource = `const assert = require('node:assert/strict');
const { total } = require('../src/cart.cjs');

assert.equal(
  total([
    { price: 10, quantity: 3 },
    { price: 2, quantity: 1 }
  ]),
  32
);
`;

async function seedRepo(repoPath) {
  await mkdir(path.join(repoPath, 'src'), { recursive: true });
  await mkdir(path.join(repoPath, 'tests'), { recursive: true });
  await writeFile(path.join(repoPath, 'src/cart.cjs'), baseCartSource);
  await writeFile(path.join(repoPath, 'tests/cart.test.cjs'), cartTestSource);
  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'user.email', 'prototype-retry@example.test']);
  await git(repoPath, ['config', 'user.name', 'VibeLoop Prototype Retry UAT']);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'seed failing cart fixture']);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

async function createCandidatePatch({ baseRepo, tmpRoot, id, cartSource }) {
  const patchRepo = path.join(tmpRoot, `patch-${id}`);
  const patchPath = path.join(tmpRoot, `${id}.candidate.patch`);
  await cp(baseRepo, patchRepo, { recursive: true });
  await writeFile(path.join(patchRepo, 'src/cart.cjs'), cartSource);
  const rawDiff = await git(patchRepo, ['diff', '--', 'src/cart.cjs']);
  const diff = rawDiff.endsWith('\n') ? rawDiff : `${rawDiff}\n`;
  await writeFile(patchPath, diff);
  return {
    patch_path: patchPath,
    patch_sha256: sha256Text(diff),
    patch_bytes: Buffer.byteLength(diff)
  };
}

async function runAttempt({ baseRepo, tmpRoot, id, retryIndex, cartSource }) {
  const attemptRepo = path.join(tmpRoot, `attempt-${retryIndex}-${id}`);
  const stdoutPath = path.join(tmpRoot, `${id}.stdout.log`);
  const stderrPath = path.join(tmpRoot, `${id}.stderr.log`);
  const patch = await createCandidatePatch({
    baseRepo,
    tmpRoot,
    id,
    cartSource
  });
  await cp(baseRepo, attemptRepo, { recursive: true });
  const apply = await run('git', ['apply', patch.patch_path], {
    cwd: attemptRepo
  });
  const test = apply.ok
    ? await run(process.execPath, ['tests/cart.test.cjs'], { cwd: attemptRepo })
    : {
        code: apply.code,
        signal: apply.signal,
        stdout: apply.stdout,
        stderr: apply.stderr,
        ok: false
      };
  await writeFile(stdoutPath, test.stdout);
  await writeFile(stderrPath, test.stderr);
  const pass = apply.ok && test.ok;
  return {
    id,
    retry_index: retryIndex,
    repo_path: attemptRepo,
    patch_path: patch.patch_path,
    patch_sha256: patch.patch_sha256,
    patch_bytes: patch.patch_bytes,
    apply_exit_code: apply.code,
    test_command: 'node tests/cart.test.cjs',
    test_exit_code: test.code,
    pass,
    failure_reason: pass
      ? null
      : apply.ok
        ? 'test_command_failed'
        : 'candidate_patch_apply_failed',
    stdout_path: stdoutPath,
    stderr_path: stderrPath
  };
}

export async function runPrototypeRetryLoopUat(options = {}) {
  const tmpRoot =
    options.tmpRoot ??
    (await mkdtemp(path.join(os.tmpdir(), 'vibeloop-prototype-retry-loop-')));
  const baseRepo = path.join(tmpRoot, 'base-repo');
  let pass = false;
  try {
    await mkdir(baseRepo, { recursive: true });
    const baseCommit = await seedRepo(baseRepo);
    const attempts = [];
    attempts.push(
      await runAttempt({
        baseRepo,
        tmpRoot,
        id: 'attempt-1-visible-fail',
        retryIndex: 1,
        cartSource: badRetryCartSource
      })
    );
    if (attempts[0].pass !== true) {
      attempts.push(
        await runAttempt({
          baseRepo,
          tmpRoot,
          id: 'attempt-2-retry-pass',
          retryIndex: 2,
          cartSource: fixedRetryCartSource
        })
      );
    }

    const retrySummaryPath = path.join(tmpRoot, 'retry-loop-summary.json');
    const failureReasons = attempts
      .filter((attempt) => attempt.pass !== true)
      .map((attempt) => `${attempt.id}:${attempt.failure_reason}`);
    const finalAttempt = attempts.at(-1);
    pass =
      attempts.length === 2 &&
      attempts[0].pass === false &&
      finalAttempt?.pass === true;
    const retrySummary = {
      scenario,
      base_commit: baseCommit,
      initial_failed: attempts[0]?.pass === false,
      retry_attempted: attempts.length > 1,
      final_pass: finalAttempt?.pass === true,
      attempt_count: attempts.length,
      failure_reasons: failureReasons,
      attempts
    };
    await writeFile(
      retrySummaryPath,
      `${JSON.stringify(retrySummary, null, 2)}\n`
    );

    const ledger = {
      status: pass ? passStatus : failStatus,
      scenario,
      proof_scope: 'deterministic_prototype_retry_contract',
      base_repo: baseRepo,
      base_commit: baseCommit,
      retry_contract: {
        initial_failed: retrySummary.initial_failed,
        failure_reason_recorded: failureReasons.length > 0,
        retry_attempted: retrySummary.retry_attempted,
        final_pass: retrySummary.final_pass,
        attempt_count: attempts.length
      },
      selected_candidate_id: finalAttempt?.pass ? finalAttempt.id : null,
      pr_candidate: finalAttempt?.pass === true,
      attempts,
      failure_reasons: failureReasons,
      false_pass: pass ? 0 : 1,
      leak: 0,
      limitations: [
        'deterministic prototype retry contract only',
        'does not invoke a live Codex builder',
        'does not prove arbitrary-repo autonomous repair'
      ],
      evidence: {
        tmp_root: tmpRoot,
        retry_summary: retrySummaryPath
      }
    };
    const extraFiles = [
      { label: 'retry_loop_summary', path: retrySummaryPath, kind: 'report' }
    ];
    for (const attempt of attempts) {
      extraFiles.push({
        label: `${attempt.id}_candidate_patch`,
        path: attempt.patch_path,
        kind: 'patch'
      });
      extraFiles.push({
        label: `${attempt.id}_stdout`,
        path: attempt.stdout_path
      });
      extraFiles.push({
        label: `${attempt.id}_stderr`,
        path: attempt.stderr_path
      });
    }
    const evidenceBundle = await writeUatEvidenceBundle({
      scenario,
      runId: `prototype-retry-loop-${process.pid}-${Date.now()}`,
      tmpRoot,
      dataDir: tmpRoot,
      outputs: [ledger],
      output: ledger,
      extraFiles,
      extraJson: {
        retry_contract: ledger.retry_contract
      }
    });
    ledger.evidence = {
      ...ledger.evidence,
      evidence_bundle: evidenceBundle.bundle_dir,
      evidence_manifest: evidenceBundle.manifest_path,
      evidence_ledger: path.join(evidenceBundle.bundle_dir, 'ledger.json'),
      evidence_copied_count: evidenceBundle.copied_count,
      evidence_missing_count: evidenceBundle.missing_count,
      tmp_prune_requested: pruneTmp
    };
    await writeUatEvidenceLedger(evidenceBundle, ledger);
    return ledger;
  } finally {
    if (pruneTmp && pass && existsSync(tmpRoot)) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}

async function main() {
  const ledger = await runPrototypeRetryLoopUat();
  console.log(JSON.stringify(ledger, null, 2));
  if (ledger.status !== passStatus) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
