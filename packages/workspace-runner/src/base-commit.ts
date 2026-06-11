import { BranchNotFoundError, GitCommandError } from './errors.js';
import { safeGit } from './git.js';

export async function resolveBaseCommit(
  repoPath: string,
  ref: string
): Promise<string> {
  try {
    const result = await safeGit(repoPath, [
      'rev-parse',
      '--verify',
      `${ref}^{commit}`
    ]);
    return result.stdout.trim();
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw new BranchNotFoundError(ref);
    }
    throw error;
  }
}
