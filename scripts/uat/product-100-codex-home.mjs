#!/usr/bin/env node
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a minimal Codex home for real LLM workers.
 *
 * Product-100 worker agents must use the user's real ChatGPT/OAuth auth, but
 * must not inherit unrelated user skills, memories, rules, project trust config,
 * or stale sessions. Copy only auth material and let `codex exec --ephemeral`
 * create any transient cache it needs inside this directory.
 */
export async function prepareProduct100CodexHome(options = {}) {
  const explicit = options.codeHome ?? process.env.VIBELOOP_PRODUCT_100_CODEX_HOME;
  if (explicit) {
    return {
      path: explicit,
      source_home: explicit,
      isolated: false,
      explicit: true,
      copied_files: []
    };
  }

  const sourceHome =
    options.sourceHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const root = options.root ?? path.join(os.tmpdir(), `product-100-codex-home-${process.pid}`);
  const dest = path.join(root, options.name ?? 'codex-home');
  await mkdir(dest, { recursive: true, mode: 0o700 });

  const copiedFiles = [];
  for (const fileName of ['auth.json']) {
    const source = path.join(sourceHome, fileName);
    if (await exists(source)) {
      await copyFile(source, path.join(dest, fileName));
      copiedFiles.push(fileName);
    }
  }

  await writeFile(
    path.join(dest, 'AGENTS.md'),
    [
      '# Product-100 isolated Codex worker home',
      '',
      'This home intentionally contains auth material only.',
      'Do not load user skills, user memories, unrelated project rules, or stale sessions.',
      ''
    ].join('\n'),
    { mode: 0o600 }
  );

  return {
    path: dest,
    source_home: sourceHome,
    isolated: true,
    explicit: false,
    copied_files: copiedFiles
  };
}
