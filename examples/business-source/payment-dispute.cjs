/* global module */

function evaluatePaymentDispute(
  payment = {},
  dispute = {},
  merchant = {},
  policy = {},
  now = new Date()
) {
  const currency = payment.currency ?? 'USD';
  const amountCents = Math.max(0, payment.amountCents ?? 0);
  const evidenceDueAt = addHours(now, policy.evidenceDueHours ?? 72);

  if (!['captured', 'settled'].includes(payment.status)) {
    return closed(currency, 'payment_not_settled');
  }

  const capturedAtMs = new Date(payment.capturedAt).getTime();
  const nowMs = new Date(now).getTime();
  const daysSinceCapture = Math.floor((nowMs - capturedAtMs) / 86_400_000);
  const disputeWindowDays = policy.disputeWindowDays ?? 120;
  if (daysSinceCapture > disputeWindowDays) {
    return closed(currency, 'dispute_window_expired');
  }

  if (dispute.reason === 'fraud' && payment.liabilityShifted === true) {
    return represent(
      currency,
      'issuer_liability_shift',
      0,
      evidenceDueAt,
      'network_evidence'
    );
  }

  if (dispute.reason === 'duplicate' && payment.duplicateOfPaymentId) {
    return accept(currency, 'duplicate_charge', amountCents);
  }

  const manualReviewThresholdCents =
    policy.manualReviewThresholdCents ?? Number.POSITIVE_INFINITY;
  if (merchant.riskTier === 'high' || amountCents >= manualReviewThresholdCents) {
    return review(currency, 'manual_review_required', amountCents, evidenceDueAt);
  }

  return represent(
    currency,
    'evidence_required',
    amountCents,
    evidenceDueAt,
    'merchant_evidence'
  );
}

function addHours(now, hours) {
  return new Date(new Date(now).getTime() + hours * 3_600_000).toISOString();
}

function closed(currency, reason) {
  return {
    eligible: false,
    action: 'closed',
    reason,
    currency,
    merchantDebitCents: 0,
    evidenceDueAt: null,
    evidenceType: null
  };
}

function accept(currency, reason, merchantDebitCents) {
  return {
    eligible: true,
    action: 'accept',
    reason,
    currency,
    merchantDebitCents,
    evidenceDueAt: null,
    evidenceType: null
  };
}

function review(currency, reason, merchantDebitCents, evidenceDueAt) {
  return {
    eligible: true,
    action: 'manual_review',
    reason,
    currency,
    merchantDebitCents,
    evidenceDueAt,
    evidenceType: 'merchant_evidence'
  };
}

function represent(currency, reason, merchantDebitCents, evidenceDueAt, evidenceType) {
  return {
    eligible: true,
    action: 'represent',
    reason,
    currency,
    merchantDebitCents,
    evidenceDueAt,
    evidenceType
  };
}

module.exports = { evaluatePaymentDispute };
