/* global module */

function settlePaymentCapture(
  order = {},
  payment = {},
  settlement = {},
  policy = {},
  now = new Date()
) {
  const orderId = order.id ?? payment.orderId ?? null;
  const merchantId = order.merchantId ?? payment.merchantId ?? null;
  const currency = order.currency ?? payment.currency ?? settlement.currency ?? 'USD';
  const captureCents = Math.max(0, payment.captureCents ?? order.totalCents ?? 0);

  if (!['fulfilled', 'shipped', 'delivered'].includes(order.status)) {
    return decision('denied', 'order_not_fulfilled', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: false,
      settled: false,
      now
    });
  }

  if (payment.status !== 'authorized') {
    return decision('denied', 'payment_not_authorized', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: false,
      settled: false,
      now
    });
  }

  const authorizationWindowDays = policy.authorizationWindowDays ?? 7;
  if (elapsedDays(payment.authorizedAt, now) > authorizationWindowDays) {
    return decision('denied', 'authorization_expired', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: false,
      settled: false,
      now
    });
  }

  if (payment.currency && order.currency && payment.currency !== order.currency) {
    return decision('denied', 'currency_mismatch', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: false,
      settled: false,
      now
    });
  }

  const authorizedCents = payment.authorizedCents ?? order.totalCents ?? 0;
  if (captureCents <= 0 || captureCents > authorizedCents) {
    return decision('denied', 'capture_exceeds_authorization', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: false,
      settled: false,
      now
    });
  }

  if (payment.chargebackOpen === true || payment.disputeOpen === true) {
    return decision('manual_review', 'open_dispute_review', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: true,
      settled: false,
      now
    });
  }

  if (payment.fraudHold === true || order.riskHold === true) {
    return decision('manual_review', 'risk_hold_review', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: true,
      settled: false,
      now
    });
  }

  if (settlement.status !== 'open') {
    return decision('denied', 'settlement_batch_closed', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: false,
      settled: false,
      now
    });
  }

  if (settlement.merchantStatus === 'suspended') {
    return decision('denied', 'merchant_suspended', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: false,
      settled: false,
      now
    });
  }

  const autoSettleLimitCents =
    policy.autoSettleLimitCents ?? Number.POSITIVE_INFINITY;
  if (captureCents > autoSettleLimitCents) {
    return decision('manual_review', 'settlement_threshold_review', {
      orderId,
      merchantId,
      currency,
      captureCents,
      requiresManualReview: true,
      settled: false,
      now
    });
  }

  return decision('settled', null, {
    orderId,
    merchantId,
    currency,
    captureCents,
    requiresManualReview: false,
    settled: true,
    now
  });
}

function elapsedDays(from, to) {
  if (!from) return Number.POSITIVE_INFINITY;
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor((toMs - fromMs) / 86_400_000);
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    orderId: details.orderId,
    merchantId: details.merchantId,
    currency: details.currency,
    captureCents: details.captureCents,
    requiresManualReview: details.requiresManualReview,
    settled: details.settled,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { settlePaymentCapture };
