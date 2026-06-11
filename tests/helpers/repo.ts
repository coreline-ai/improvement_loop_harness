import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface TempGitRepo {
  repoPath: string;
  initialCommit: string;
  git(args: readonly string[]): Promise<string>;
  write(relativePath: string, content: string): Promise<void>;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const subprocess = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    subprocess.stdout.setEncoding('utf8');
    subprocess.stderr.setEncoding('utf8');
    subprocess.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    subprocess.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    subprocess.on('error', reject);
    subprocess.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderr}`)
      );
    });
  });
}

export async function createTempGitRepo(): Promise<TempGitRepo> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), 'vibeloop-repo-'));
  const write = async (
    relativePath: string,
    content: string
  ): Promise<void> => {
    const absolutePath = path.join(repoPath, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  };
  const git = (args: readonly string[]): Promise<string> =>
    runGit(repoPath, args);

  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'vibeloop@example.test']);
  await git(['config', 'user.name', 'VibeLoop Test']);
  await write('README.md', '# fixture repo\n');
  await git(['add', 'README.md']);
  await git(['commit', '-m', 'initial']);
  const initialCommit = (await git(['rev-parse', 'HEAD'])).trim();

  return { repoPath, initialCommit, git, write };
}
