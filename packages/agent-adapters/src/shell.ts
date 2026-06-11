export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function joinShellCommand(parts: readonly string[]): string {
  return parts.map(shellQuote).join(' ');
}
