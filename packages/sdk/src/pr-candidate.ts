export interface PrCandidateEvidence {
  decision?: string | null | undefined;
  allPass?: boolean | null | undefined;
  qualified?: boolean | null | undefined;
  selected?: unknown;
  finalVerification?:
    | {
        passed?: boolean | null | undefined;
        reverified?: boolean | null | undefined;
      }
    | null
    | undefined;
}

export function isPrCandidate(evidence: PrCandidateEvidence): boolean {
  const requiresSelection =
    'selected' in evidence || 'finalVerification' in evidence;
  if (
    requiresSelection &&
    (evidence.selected === null || evidence.selected === undefined)
  ) {
    return false;
  }
  if (evidence.decision !== 'accept') {
    return false;
  }
  if (evidence.allPass !== true) {
    return false;
  }
  if (evidence.qualified !== true) {
    return false;
  }
  if (
    'finalVerification' in evidence &&
    (evidence.finalVerification?.passed !== true ||
      evidence.finalVerification?.reverified !== true)
  ) {
    return false;
  }
  return true;
}
