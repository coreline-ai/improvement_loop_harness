import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCleanCodexHomeSkillSmoke } from './skill-clean-codex-home-smoke.mjs';

describe('clean CODEX_HOME Skill smoke UAT', () => {
  it('installs exactly vibeloop-harness under CODEX_HOME/skills and runs the wrapper there', async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), 'vibeloop-clean-codex-home-test-')
    );
    const sourceSkillRoot = path.join(root, 'source-skill');
    await mkdir(path.join(sourceSkillRoot, 'scripts'), { recursive: true });
    await mkdir(path.join(sourceSkillRoot, 'vendor'), { recursive: true });
    await writeFile(
      path.join(sourceSkillRoot, 'vendor/vibeloop.mjs'),
      "export const version = '0.0.0-test';\n"
    );
    await writeFile(
      path.join(sourceSkillRoot, 'scripts/vibeloop-run.mjs'),
      [
        '#!/usr/bin/env node',
        "if (!process.env.CODEX_HOME?.endsWith('/codex-home')) process.exit(2);",
        "console.log('vibeloop 0.0.0-test');",
        ''
      ].join('\n')
    );

    const result = await runCleanCodexHomeSkillSmoke({
      root,
      sourceSkillRoot,
      keepTmp: true
    });

    expect(result).toMatchObject({
      status: 'CLEAN_CODEX_HOME_SKILL_SMOKE_PASS',
      clean_codex_home: true,
      codex_home_skills_entries: ['vibeloop-harness'],
      copied_skill_path: 'CODEX_HOME/skills/vibeloop-harness',
      wrapper_vendor_version: 'vibeloop 0.0.0-test'
    });
    await expect(
      stat(path.join(root, 'codex-home/skills/unrelated-skill'))
    ).rejects.toThrow();
  });
});
