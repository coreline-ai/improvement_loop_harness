#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_SOURCE_SKILL_ROOT = path.join(
  REPO_ROOT,
  'skills/vibeloop-harness'
);

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
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
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function assertFile(filePath, message) {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    throw new Error(message);
  }
}

export async function runCleanCodexHomeSkillSmoke(options = {}) {
  const root =
    options.root ??
    (await mkdtemp(path.join(os.tmpdir(), 'vibeloop-clean-codex-home-')));
  const keepTmp = options.keepTmp ?? process.env.VIBELOOP_UAT_KEEP_TMP === '1';
  const sourceSkillRoot = options.sourceSkillRoot ?? DEFAULT_SOURCE_SKILL_ROOT;
  const codexHome = path.join(root, 'codex-home');
  const skillsRoot = path.join(codexHome, 'skills');
  const skillRoot = path.join(skillsRoot, 'vibeloop-harness');
  const runScript = path.join(skillRoot, 'scripts/vibeloop-run.mjs');
  const vendorCli = path.join(skillRoot, 'vendor/vibeloop.mjs');

  try {
    await assertFile(
      path.join(sourceSkillRoot, 'vendor/vibeloop.mjs'),
      `missing bundled Skill vendor CLI at ${path.join(sourceSkillRoot, 'vendor/vibeloop.mjs')}; run pnpm bundle:skill before this UAT`
    );
    await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
    await cp(sourceSkillRoot, skillRoot, { recursive: true });
    await assertFile(runScript, 'copied Skill wrapper is missing');
    await assertFile(vendorCli, 'copied Skill vendor CLI is missing');

    const skillEntries = (await readdir(skillsRoot)).sort();
    if (JSON.stringify(skillEntries) !== JSON.stringify(['vibeloop-harness'])) {
      throw new Error(
        `clean CODEX_HOME skills directory contains unexpected entries: ${skillEntries.join(', ')}`
      );
    }

    const versionResult = await runCommand(
      process.execPath,
      [runScript, '--version'],
      {
        cwd: codexHome,
        env: {
          ...process.env,
          CODEX_HOME: codexHome
        }
      }
    );
    if (versionResult.code !== 0 || versionResult.stderr !== '') {
      throw new Error(
        `clean CODEX_HOME Skill wrapper failed (${versionResult.code})\nstdout:\n${versionResult.stdout}\nstderr:\n${versionResult.stderr}`
      );
    }

    return {
      status: 'CLEAN_CODEX_HOME_SKILL_SMOKE_PASS',
      scenario: 'skill-clean-codex-home-smoke',
      clean_codex_home: true,
      codex_home_skills_entries: skillEntries,
      copied_skill_path: 'CODEX_HOME/skills/vibeloop-harness',
      wrapper_vendor_version: versionResult.stdout.trim(),
      artifacts: keepTmp
        ? {
            temp_root: root,
            codex_home: codexHome,
            skill_root: skillRoot
          }
        : { temp_root: '[removed unless VIBELOOP_UAT_KEEP_TMP=1]' }
    };
  } finally {
    if (!keepTmp) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCleanCodexHomeSkillSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
