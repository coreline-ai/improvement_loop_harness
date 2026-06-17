import { describe, expect, it } from 'vitest';
import { isPrCandidate } from './pr-candidate.js';

describe('isPrCandidate', () => {
  it('requires explicit accept, ALL_PASS, and qualified for single-run PR candidacy', () => {
    expect(
      isPrCandidate({
        decision: 'accept',
        allPass: true,
        qualified: true
      })
    ).toBe(true);
    expect(isPrCandidate({ allPass: true, qualified: true })).toBe(false);
    expect(isPrCandidate({ decision: 'accept', qualified: true })).toBe(false);
    expect(isPrCandidate({ decision: 'accept', allPass: true })).toBe(false);
    expect(
      isPrCandidate({
        decision: 'reject',
        allPass: true,
        qualified: true
      })
    ).toBe(false);
    expect(
      isPrCandidate({
        decision: 'accept',
        allPass: false,
        qualified: true
      })
    ).toBe(false);
    expect(
      isPrCandidate({
        decision: 'accept',
        allPass: true,
        qualified: false
      })
    ).toBe(false);
    expect(
      isPrCandidate({
        decision: 'accept',
        allPass: true,
        qualified: null
      })
    ).toBe(false);
  });

  it('requires a selected candidate and passed final verification for selection flows', () => {
    expect(
      isPrCandidate({
        decision: 'accept',
        allPass: true,
        qualified: true,
        selected: { candidateId: 'c0' },
        finalVerification: { passed: true }
      })
    ).toBe(true);
    expect(
      isPrCandidate({
        decision: 'accept',
        allPass: true,
        qualified: true,
        selected: null,
        finalVerification: { passed: true }
      })
    ).toBe(false);
    expect(
      isPrCandidate({
        decision: 'accept',
        allPass: true,
        qualified: true,
        selected: { candidateId: 'c0' },
        finalVerification: { passed: false }
      })
    ).toBe(false);
    expect(
      isPrCandidate({
        decision: 'accept',
        allPass: true,
        qualified: true,
        selected: { candidateId: 'c0' },
        finalVerification: null
      })
    ).toBe(false);
  });
});
