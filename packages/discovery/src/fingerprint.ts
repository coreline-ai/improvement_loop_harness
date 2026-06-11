import { createHash } from 'node:crypto';
import type { CandidateSource, StructuredLocation } from './types.js';

export function normalizeCandidateLocation(location: StructuredLocation): string {
  return [location.filePath, location.testName ?? '', location.errorCode]
    .map((part) => part.trim().replace(/\\/g, '/').toLowerCase())
    .join('|');
}

export function candidateFingerprint(source: CandidateSource, location: StructuredLocation): string {
  return createHash('sha256')
    .update(`${source}:${normalizeCandidateLocation(location)}`)
    .digest('hex');
}

export function dedupeCandidates<T extends { fingerprint: string }>(
  candidates: T[],
  existingFingerprints: Iterable<string> = []
): T[] {
  const seen = new Set(existingFingerprints);
  const deduped: T[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.fingerprint)) continue;
    seen.add(candidate.fingerprint);
    deduped.push(candidate);
  }
  return deduped;
}
