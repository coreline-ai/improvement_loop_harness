/* global module */

function evaluateCreditTransfer(
  source = {},
  destination = {},
  transfer = {},
  policy = {},
  ledger = {},
  now = new Date()
) {
  const sourceAccountId = source.id ?? null;
  const destinationAccountId = destination.id ?? null;
  const amountCents = transfer.amountCents ?? 0;
  const maxAutoTransferCents =
    policy.maxAutoTransferCents ?? Number.POSITIVE_INFINITY;
  const details = {
    sourceAccountId,
    destinationAccountId,
    transferId: transfer.id ?? null,
    amountCents,
    currency: transfer.currency ?? null,
    now
  };

  if (source.status !== 'active') {
    return blocked('source_account_not_active', details);
  }

  if (source.fraudHold === true) {
    return blocked('source_fraud_hold', details);
  }

  if (destination.status !== 'active') {
    return blocked('destination_account_not_active', details);
  }

  if (
    source.currency !== transfer.currency ||
    destination.currency !== transfer.currency
  ) {
    return manual('currency_mismatch', details);
  }

  if ((source.balanceCents ?? 0) < amountCents) {
    return blocked('insufficient_credit_balance', details);
  }

  if (amountCents > maxAutoTransferCents) {
    return manual('transfer_limit_exceeded', details);
  }

  if ((ledger.processedTransferIds ?? []).includes(transfer.id)) {
    return blocked('duplicate_transfer', details);
  }

  const manualReviewThresholdCents =
    policy.manualReviewThresholdCents ?? Number.POSITIVE_INFINITY;
  if (amountCents > manualReviewThresholdCents) {
    return manualAllowed('manual_review_threshold_exceeded', details);
  }

  return decision('approved', null, {
    ...details,
    transferAllowed: true,
    requiresManualReview: false,
    movedCents: amountCents
  });
}

function blocked(reason, details) {
  return decision('blocked', reason, {
    ...details,
    transferAllowed: false,
    requiresManualReview: false,
    movedCents: 0
  });
}

function manual(reason, details) {
  return decision('manual_review', reason, {
    ...details,
    transferAllowed: false,
    requiresManualReview: true,
    movedCents: 0
  });
}

function manualAllowed(reason, details) {
  return decision('manual_review', reason, {
    ...details,
    transferAllowed: true,
    requiresManualReview: true,
    movedCents: details.amountCents
  });
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    sourceAccountId: details.sourceAccountId,
    destinationAccountId: details.destinationAccountId,
    transferId: details.transferId,
    amountCents: details.amountCents,
    currency: details.currency,
    transferAllowed: details.transferAllowed,
    requiresManualReview: details.requiresManualReview,
    movedCents: details.movedCents,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { evaluateCreditTransfer };
