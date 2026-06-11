import os from 'node:os';
import path from 'node:path';

export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['VIBELOOP_DATA_DIR'];
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured);
  }

  return path.join(os.homedir(), '.vibeloop');
}
