function normalizePath(input: string): string {
  return input.replaceAll('\\', '/').replace(/^\.\//, '');
}

function escapeRegex(input: string): string {
  return input.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  const regex = `^${normalized.split('*').map(escapeRegex).join('[^/]*')}$`;
  return new RegExp(regex);
}

export function pathMatchesPattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);

  if (normalizedPattern.includes('*')) {
    return globToRegex(normalizedPattern).test(normalizedPath);
  }
  if (normalizedPattern.endsWith('/')) {
    return normalizedPath.startsWith(normalizedPattern);
  }
  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern}/`)
  );
}

export function pathMatchesAny(
  filePath: string,
  patterns: readonly string[] | undefined
): boolean {
  return (patterns ?? []).some((pattern) =>
    pathMatchesPattern(filePath, pattern)
  );
}
