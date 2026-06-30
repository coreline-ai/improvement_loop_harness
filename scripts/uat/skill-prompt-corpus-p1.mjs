#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { defaultUatEvidenceDir } from './evidence-bundle.mjs';

export const fastVariants =
  'user_issue:ko-default-cart-path,auto_discovery:ko-default-auto-pr-candidate';

const supportedModes = new Set([
  'fast',
  'targeted',
  'full-local',
  'gitea-pr',
  'github-final-smoke',
  'github-final-full'
]);

function freshEvidenceDir(mode, now = Date.now(), pid = process.pid) {
  return path.join(os.tmpdir(), `vibeloop-p1-${mode}-${pid}-${now}`);
}

function defaultEvidenceDirForMode(mode, env, options = {}) {
  if (mode === 'gitea-pr') {
    return defaultUatEvidenceDir(env);
  }
  return freshEvidenceDir(mode, options.now, options.pid);
}

function explicitVariantsOrDefault(raw, fallback) {
  const value = raw?.trim();
  if (!value || value === 'default') return fallback;
  return value;
}

export function buildP1CorpusEnv(mode, env = process.env, options = {}) {
  if (!supportedModes.has(mode)) {
    throw new Error(
      `unsupported p1 corpus mode=${mode}; expected one of ${[
        ...supportedModes
      ].join(',')}`
    );
  }
  const nextEnv = {
    ...env,
    VIBELOOP_UAT_EVIDENCE_DIR:
      env.VIBELOOP_UAT_EVIDENCE_DIR ??
      defaultEvidenceDirForMode(mode, env, options)
  };
  if (!nextEnv.VIBELOOP_SKILL_PROMPT_CORPUS_CONCURRENCY) {
    nextEnv.VIBELOOP_SKILL_PROMPT_CORPUS_CONCURRENCY = '2';
  }

  if (mode === 'fast') {
    nextEnv.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS = fastVariants;
  }
  if (mode === 'targeted') {
    const variants = env.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS?.trim();
    if (!variants || variants === 'default') {
      throw new Error(
        'p1-targeted requires VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS'
      );
    }
  }
  if (mode === 'gitea-pr') {
    nextEnv.VIBELOOP_GIT_PROVIDER = 'gitea';
    nextEnv.VIBELOOP_GITEA_BASE_URL =
      env.VIBELOOP_GITEA_BASE_URL ?? 'http://127.0.0.1:13000';
    nextEnv.VIBELOOP_GITEA_KEEP_REPO = env.VIBELOOP_GITEA_KEEP_REPO ?? '1';
    nextEnv.VIBELOOP_UAT_KEEP_TMP = env.VIBELOOP_UAT_KEEP_TMP ?? '1';
    nextEnv.VIBELOOP_UAT_DURABLE_EVIDENCE =
      env.VIBELOOP_UAT_DURABLE_EVIDENCE ?? '1';
    nextEnv.VIBELOOP_P1_SCOPE = env.VIBELOOP_P1_SCOPE ?? 'targeted';
    nextEnv.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS = explicitVariantsOrDefault(
      env.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS,
      fastVariants
    );
  }
  if (mode === 'github-final-smoke') {
    nextEnv.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS = fastVariants;
    nextEnv.VIBELOOP_SKILL_PROMPT_CORPUS_GITHUB_DRAFT_PR = '1';
  }
  if (mode === 'github-final-full') {
    delete nextEnv.VIBELOOP_SKILL_PROMPT_CORPUS_VARIANTS;
    nextEnv.VIBELOOP_SKILL_PROMPT_CORPUS_GITHUB_DRAFT_PR = '1';
  }
  return nextEnv;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function writeTimingReport(mode, env, timing) {
  const evidenceRoot = env.VIBELOOP_UAT_EVIDENCE_DIR;
  if (!evidenceRoot) return;
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    path.join(evidenceRoot, `p1-wrapper-timing-${mode}-${process.pid}.json`),
    `${JSON.stringify(timing, null, 2)}\n`
  );
}

async function runStep(label, command, args, env, timing) {
  const startedAt = Date.now();
  const result = await run(command, args, { env });
  timing[`${label}_ms`] = Date.now() - startedAt;
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
    return false;
  }
  return true;
}

export async function runP1CorpusMode(mode, options = {}) {
  const env = buildP1CorpusEnv(mode, options.env ?? process.env, options);
  const timing = {
    mode,
    started_at: new Date().toISOString(),
    evidence_root: env.VIBELOOP_UAT_EVIDENCE_DIR,
    build_ms: null,
    bundle_ms: null,
    corpus_ms: null,
    total_ms: null
  };
  const startedAt = Date.now();
  if (mode === 'gitea-pr') {
    const preflightEnv = {
      ...env,
      VIBELOOP_GITEA_KEEP_REPO: env.VIBELOOP_GITEA_PREFLIGHT_KEEP_REPO ?? '0'
    };
    const preflightStartedAt = Date.now();
    const preflight = await run('corepack', ['pnpm', 'uat:gitea:preflight'], {
      env: preflightEnv
    });
    timing.gitea_preflight_ms = Date.now() - preflightStartedAt;
    if (preflight.code !== 0) {
      timing.total_ms = Date.now() - startedAt;
      await writeTimingReport(mode, env, timing);
      return preflight.code ?? 20;
    }
  }

  if (
    !(await runStep(
      'live_preflight',
      'corepack',
      ['pnpm', 'uat:live-preflight'],
      env,
      timing
    ))
  ) {
    timing.total_ms = Date.now() - startedAt;
    await writeTimingReport(mode, env, timing);
    return process.exitCode;
  }
  if (!(await runStep('build', 'corepack', ['pnpm', 'build'], env, timing))) {
    timing.total_ms = Date.now() - startedAt;
    await writeTimingReport(mode, env, timing);
    return process.exitCode;
  }
  env.VIBELOOP_P1_WRAPPER_TIMING_JSON = JSON.stringify(timing);
  if (
    !(await runStep(
      'corpus',
      process.execPath,
      ['scripts/uat/skill-real-user-prompt-corpus-live-uat.mjs'],
      env,
      timing
    ))
  ) {
    timing.total_ms = Date.now() - startedAt;
    await writeTimingReport(mode, env, timing);
    return process.exitCode;
  }
  timing.total_ms = Date.now() - startedAt;
  await writeTimingReport(mode, env, timing);
  return 0;
}

async function main() {
  const mode = process.argv[2] ?? 'fast';
  try {
    process.exitCode = await runP1CorpusMode(mode);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          status: 'blocked',
          reason: 'P1_CORPUS_MODE_CONFIGURATION_ERROR',
          message: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    );
    process.exitCode = 20;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
