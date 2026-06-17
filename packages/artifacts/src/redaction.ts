export type Redactor = (input: string) => string;

export interface RedactorOptions {
  secrets?: string[];
}

const SECRET_KEY_PATTERN =
  /((?:["']?(?:api[_-]?key|token|password|secret|credential|cookie|auth)["']?\s*[:=]\s*))(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,}]+))/gi;
const TOKEN_LIKE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactSecretAssignment(
  _match: string,
  prefix: string,
  doubleQuoted: string | undefined,
  singleQuoted: string | undefined
): string {
  if (doubleQuoted !== undefined) {
    return `${prefix}"[REDACTED]"`;
  }
  if (singleQuoted !== undefined) {
    return `${prefix}'[REDACTED]'`;
  }
  return `${prefix}[REDACTED]`;
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const secrets = [...new Set((options.secrets ?? []).filter((secret) => secret.length > 0))];
  const secretPatterns = secrets.map((secret) => new RegExp(escapeRegExp(secret), 'g'));

  return (input: string): string => {
    let redacted = input;
    for (const pattern of secretPatterns) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }

    for (const pattern of TOKEN_LIKE_PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }

    return redacted.replace(SECRET_KEY_PATTERN, redactSecretAssignment);
  };
}

export const defaultRedactor: Redactor = createRedactor();
export const passthroughRedactor: Redactor = (input) => input;
