export interface RedactProxyLogOptions {
  secrets?: string[] | undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AUTHORIZATION_PATTERN =
  /(authorization["']?\s*[:=]\s*["']?Bearer\s+)([^"'\s,}]+)/gi;
const KEY_VALUE_PATTERN =
  /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi;

export function redactProxyLog(
  input: string,
  options: RedactProxyLogOptions = {}
): string {
  let redacted = input;
  for (const secret of [...new Set(options.secrets ?? [])].filter(
    (value) => value.length > 0
  )) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(secret), 'g'),
      '[REDACTED]'
    );
  }
  return redacted
    .replace(AUTHORIZATION_PATTERN, '$1[REDACTED]')
    .replace(KEY_VALUE_PATTERN, '$1[REDACTED]');
}
