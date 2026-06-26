/* global module */

function assessOrderFraudRisk(
  order = {},
  customer = {},
  payment = {},
  rules = {},
  now = new Date()
) {
  const orderId = order.id ?? null;
  const customerId = customer.id ?? null;
  const region = order.region ?? customer.region ?? rules.defaultRegion ?? 'US';

  if (order.status !== 'submitted') {
    return decision('ignored', 'order_not_submitted', {
      orderId,
      customerId,
      region,
      riskScore: 0,
      requiresManualReview: false,
      approved: false,
      now
    });
  }
  if (customer.accountStatus === 'blocked') {
    return decision('declined', 'customer_blocked', {
      orderId,
      customerId,
      region,
      riskScore: 100,
      requiresManualReview: false,
      approved: false,
      now
    });
  }
  if (payment.verified !== true) {
    return decision('manual_review', 'payment_not_verified', {
      orderId,
      customerId,
      region,
      riskScore: rules.paymentVerificationRisk ?? 55,
      requiresManualReview: true,
      approved: false,
      now
    });
  }

  let riskScore = 0;
  const riskReasons = [];
  const addRisk = (condition, points, reason) => {
    if (!condition) return;
    riskScore += points;
    riskReasons.push(reason);
  };

  addRisk(
    Boolean(payment.cardCountry && order.country) &&
      payment.cardCountry !== order.country,
    rules.crossBorderRisk ?? 30,
    'cross_border_card'
  );
  addRisk(
    (customer.chargebacksLast90Days ?? 0) >=
      (rules.chargebackThreshold ?? 2),
    rules.chargebackRisk ?? 40,
    'recent_chargebacks'
  );
  addRisk(
    (customer.ordersLastHour ?? 0) > (rules.velocityOrderLimit ?? 5),
    rules.velocityRisk ?? 35,
    'velocity_spike'
  );
  addRisk(
    (order.total ?? 0) > (rules.highValueThreshold ?? 500),
    rules.highValueRisk ?? 25,
    'high_value_order'
  );
  addRisk(
    rules.postalMismatchReview === true &&
      payment.billingPostalCode !== order.shippingPostalCode,
    rules.postalMismatchRisk ?? 20,
    'postal_mismatch'
  );

  const autoDeclineThreshold = rules.autoDeclineThreshold ?? 85;
  if (riskScore >= autoDeclineThreshold) {
    return decision('declined', 'auto_decline_risk_threshold', {
      orderId,
      customerId,
      region,
      riskScore,
      riskReasons,
      requiresManualReview: false,
      approved: false,
      now
    });
  }

  const manualReviewThreshold = rules.manualReviewThreshold ?? 50;
  if (riskScore >= manualReviewThreshold) {
    return decision('manual_review', 'risk_threshold', {
      orderId,
      customerId,
      region,
      riskScore,
      riskReasons,
      requiresManualReview: true,
      approved: false,
      now
    });
  }

  return decision('approved', null, {
    orderId,
    customerId,
    region,
    riskScore,
    riskReasons,
    requiresManualReview: false,
    approved: true,
    now
  });
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    orderId: details.orderId,
    customerId: details.customerId,
    region: details.region,
    riskScore: details.riskScore,
    riskReasons: details.riskReasons ?? [],
    requiresManualReview: details.requiresManualReview,
    approved: details.approved,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { assessOrderFraudRisk };
