/* global module */

function adjudicateInsuranceClaim(
  policy = {},
  claim = {},
  provider = {},
  rules = {},
  now = new Date()
) {
  const currency = policy.currency ?? 'USD';
  const billedCents = Math.max(0, claim.billedCents ?? 0);

  if (policy.status !== 'active') {
    return denied(currency, 'policy_inactive');
  }
  if (
    !Array.isArray(policy.coveredBenefits) ||
    !policy.coveredBenefits.includes(claim.serviceCode)
  ) {
    return denied(currency, 'benefit_not_covered');
  }

  const effectiveAtMs = new Date(policy.effectiveAt).getTime();
  const nowMs = new Date(now).getTime();
  const daysSinceEffective = Math.floor((nowMs - effectiveAtMs) / 86_400_000);
  const waitingPeriodDays = rules.waitingPeriodDays ?? 30;
  if (claim.type !== 'preventive' && daysSinceEffective < waitingPeriodDays) {
    return denied(currency, 'waiting_period');
  }

  if (
    provider.networkStatus === 'out_of_network' &&
    policy.outOfNetworkAllowed !== true
  ) {
    return denied(currency, 'out_of_network');
  }

  if (
    claim.requiresPriorAuthorization === true &&
    !claim.priorAuthorizationId
  ) {
    return pending(currency, 'prior_authorization_required');
  }

  if (
    claim.accidentRelated === true &&
    rules.requireCoordinationForAccident === true
  ) {
    return pending(currency, 'coordination_required');
  }

  const allowedCents = Math.min(
    billedCents,
    provider.contractRateCents ?? billedCents
  );
  const annualMaxRemainingCents =
    policy.annualMaxRemainingCents ?? Number.POSITIVE_INFINITY;
  if (annualMaxRemainingCents <= 0) {
    return denied(currency, 'benefit_max_exhausted');
  }
  const payableBaseCents = Math.min(allowedCents, annualMaxRemainingCents);

  if (claim.type === 'preventive' && policy.preventiveCovered === true) {
    return approved(currency, allowedCents, 0, 0, payableBaseCents);
  }

  const deductibleAppliedCents = Math.min(
    payableBaseCents,
    policy.deductibleRemainingCents ?? 0
  );
  const coinsuranceBaseCents = Math.max(
    0,
    payableBaseCents - deductibleAppliedCents
  );
  const coinsuranceCents = Math.round(
    (coinsuranceBaseCents * (policy.coinsuranceBps ?? 0)) / 10000
  );
  const planPaysCents = Math.max(
    0,
    payableBaseCents - deductibleAppliedCents - coinsuranceCents
  );

  return approved(
    currency,
    allowedCents,
    deductibleAppliedCents,
    coinsuranceCents,
    planPaysCents
  );
}

function approved(
  currency,
  allowedCents,
  deductibleAppliedCents,
  coinsuranceCents,
  planPaysCents
) {
  return {
    status: 'approved',
    reason: null,
    currency,
    allowedCents,
    deductibleAppliedCents,
    coinsuranceCents,
    planPaysCents,
    patientResponsibilityCents: deductibleAppliedCents + coinsuranceCents
  };
}

function pending(currency, reason) {
  return {
    status: 'pending',
    reason,
    currency,
    allowedCents: 0,
    deductibleAppliedCents: 0,
    coinsuranceCents: 0,
    planPaysCents: 0,
    patientResponsibilityCents: 0
  };
}

function denied(currency, reason) {
  return {
    status: 'denied',
    reason,
    currency,
    allowedCents: 0,
    deductibleAppliedCents: 0,
    coinsuranceCents: 0,
    planPaysCents: 0,
    patientResponsibilityCents: 0
  };
}

module.exports = { adjudicateInsuranceClaim };
