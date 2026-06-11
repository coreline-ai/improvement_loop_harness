import path from 'node:path';
import { TaskProtocolError } from './errors.js';

const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/;

export function normalizeRepoPath(rawPath: string, context = 'path'): string {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    throw new TaskProtocolError(`${context} must not be empty`);
  }
  if (trimmed.includes('\0')) {
    throw new TaskProtocolError(`${context} must not contain NUL bytes: ${rawPath}`);
  }
  if (trimmed.includes('\\')) {
    throw new TaskProtocolError(`${context} must use POSIX separators: ${rawPath}`);
  }
  if (path.posix.isAbsolute(trimmed) || WINDOWS_DRIVE_PREFIX.test(trimmed)) {
    throw new TaskProtocolError(`${context} must be repo-relative: ${rawPath}`);
  }

  const hadTrailingSlash = trimmed.endsWith('/');
  const withoutLeadingDot = trimmed.replace(/^\.\//, '');
  const normalized = path.posix.normalize(withoutLeadingDot);

  if (normalized === '.' || normalized.length === 0) {
    throw new TaskProtocolError(`${context} must not resolve to repo root/current dir: ${rawPath}`);
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new TaskProtocolError(`${context} must not escape repo root: ${rawPath}`);
  }
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new TaskProtocolError(`${context} must not contain parent segments: ${rawPath}`);
  }

  return hadTrailingSlash && !normalized.endsWith('/') ? `${normalized}/` : normalized;
}

export function normalizePathList(paths: string[] | undefined, context: string): string[] | undefined {
  if (!paths) {
    return undefined;
  }

  return paths.map((entry, index) => normalizeRepoPath(entry, `${context}[${index}]`));
}

export function pathMatchesPrefix(filePath: string, prefix: string): boolean {
  const normalizedFile = normalizeRepoPath(filePath, 'filePath');
  const normalizedPrefix = normalizeRepoPath(prefix, 'prefix');
  const prefixWithoutSlash = normalizedPrefix.replace(/\/$/, '');
  return normalizedFile === prefixWithoutSlash || normalizedFile.startsWith(`${prefixWithoutSlash}/`);
}
