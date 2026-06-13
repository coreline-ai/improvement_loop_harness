import { createHash } from 'node:crypto';
import type { CandidateSource, StructuredLocation } from './types.js';

export function normalizeCandidateLocation(
  location: StructuredLocation
): string {
  return [location.filePath, location.testName ?? '', location.errorCode]
    .map((part) => part.trim().replace(/\\/g, '/').toLowerCase())
    .join('|');
}

export function candidateFingerprint(
  source: CandidateSource,
  location: StructuredLocation
): string {
  return createHash('sha256')
    .update(`${source}:${normalizeCandidateLocation(location)}`)
    .digest('hex');
}

/**
 * A coarser-than-fingerprint key that groups candidates by the SAME kind of
 * failure (source + risk area + error code) regardless of which file/test it
 * surfaced in. Used to recognise systemic repeated failures across loops (the
 * "정립→참조" learning primitive) for read-only ledger grouping and priority
 * hints. Unlike `candidateFingerprint`, this is deliberately not hashed so it
 * stays human-readable in ledgers. Computable from fields already stored on a
 * candidate, so it needs no schema change.
 */
export function failureClusterKey(input: {
  source: CandidateSource;
  riskAreaHint?: string | null | undefined;
  errorCode: string;
}): string {
  const risk =
    (input.riskAreaHint ?? 'unknown').trim().toLowerCase() || 'unknown';
  const code = input.errorCode.trim().toLowerCase() || 'unknown';
  return `${input.source}:${risk}:${code}`;
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
