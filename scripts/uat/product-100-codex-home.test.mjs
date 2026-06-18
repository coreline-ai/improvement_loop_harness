import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareProduct100CodexHome } from './product-100-codex-home.mjs';

describe('Product-100 isolated Codex home', () => {
  it('copies only auth material into an isolated worker home', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'p100-home-test-'));
    const source = path.join(root, 'source');
    await mkdir(path.join(source, 'skills', 'unrelated-skill'), { recursive: true });
    await Promise.all([
      writeFile(path.join(source, 'auth.json'), '{"token":"redacted"}\n'),
      writeFile(path.join(source, 'skills', 'unrelated-skill', 'SKILL.md'), 'do not copy')
    ]);

    const prepared = await prepareProduct100CodexHome({
      root,
      sourceHome: source
    });

    expect(prepared.isolated).toBe(true);
    expect(prepared.copied_files).toEqual(['auth.json']);
    expect(await readFile(path.join(prepared.path, 'auth.json'), 'utf8')).toContain('redacted');
    await expect(stat(path.join(prepared.path, 'skills'))).rejects.toThrow();
  });
});
