export type Redactor = (input: string) => string;

export interface RedactorOptions {
  secrets?: string[];
}

const SECRET_KEY_PATTERN = /((?:["']?(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?))([^"'\s,}]+)/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const secrets = [...new Set((options.secrets ?? []).filter((secret) => secret.length > 0))];
  const secretPatterns = secrets.map((secret) => new RegExp(escapeRegExp(secret), 'g'));

  return (input: string): string => {
    let redacted = input;
    for (const pattern of secretPatterns) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }

    return redacted.replace(SECRET_KEY_PATTERN, '$1[REDACTED]');
  };
}

export const passthroughRedactor: Redactor = (input) => input;
