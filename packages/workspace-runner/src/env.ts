import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EnvPolicyError } from './errors.js';

export const EXACT_ENV_ALLOWLIST = new Set([
  'PATH',
  'CI',
  'NODE_ENV',
  'PNPM_HOME',
  'COREPACK_HOME'
]);
export const BLOCKED_ENV_KEY_PATTERN =
  /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH|DSN|ENDPOINT|URL)/i;

export interface ScrubEnvOptions {
  homeDir?: string;
}

export interface PrepareAgentEnvOptions {
  env?: NodeJS.ProcessEnv;
  dataDir: string;
  projectId: string;
  loopId: string;
}

export function isAllowedEnvKey(key: string): boolean {
  return EXACT_ENV_ALLOWLIST.has(key) || key.startsWith('VIBELOOP_');
}

export function isBlockedEnvKey(key: string): boolean {
  return BLOCKED_ENV_KEY_PATTERN.test(key);
}

export function assertNoBlockedEnv(env: NodeJS.ProcessEnv): void {
  const blocked = Object.keys(env).filter((key) => isBlockedEnvKey(key));
  if (blocked.length > 0) {
    throw new EnvPolicyError(
      `scrubbed env contains blocked keys: ${blocked.sort().join(', ')}`
    );
  }
}

export function scrubEnv(
  source: NodeJS.ProcessEnv,
  options: ScrubEnvOptions = {}
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || !isAllowedEnvKey(key) || isBlockedEnvKey(key)) {
      continue;
    }
    scrubbed[key] = value;
  }

  scrubbed.HOME =
    options.homeDir ?? path.join(os.tmpdir(), 'vibeloop-agent-home-empty');
  assertNoBlockedEnv(scrubbed);
  return scrubbed;
}

export async function createEphemeralHome(
  dataDir: string,
  projectId: string,
  loopId: string
): Promise<string> {
  const homeDir = path.resolve(dataDir, 'projects', projectId, 'homes', loopId);
  await mkdir(homeDir, { recursive: true, mode: 0o700 });
  return homeDir;
}

export async function prepareAgentEnv(
  options: PrepareAgentEnvOptions
): Promise<NodeJS.ProcessEnv> {
  const homeDir = await createEphemeralHome(
    options.dataDir,
    options.projectId,
    options.loopId
  );
  return scrubEnv(options.env ?? process.env, { homeDir });
}
