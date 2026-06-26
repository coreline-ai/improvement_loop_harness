/* global module */

function reviewMerchantOnboarding(
  merchant = {},
  request = {},
  policy = {},
  now = new Date()
) {
  const merchantId = merchant.id ?? null;
  const currency = merchant.currency ?? policy.currency ?? 'USD';

  if (merchant.status !== 'pending_review') {
    return rejected(merchantId, currency, 'merchant_not_pending');
  }
  if (request.termsAccepted !== true) {
    return rejected(merchantId, currency, 'terms_not_accepted');
  }
  if (merchant.sanctionsHit === true) {
    return rejected(merchantId, currency, 'sanctions_match');
  }
  if (merchant.prohibitedCategory === true) {
    return rejected(merchantId, currency, 'prohibited_category');
  }

  if (merchant.businessVerified !== true) {
    return manualReview(merchantId, currency, 'business_verification_required');
  }
  if (merchant.taxFormSubmitted !== true) {
    return manualReview(merchantId, currency, 'tax_form_required');
  }
  if (merchant.bankAccountVerified !== true) {
    return manualReview(merchantId, currency, 'bank_account_required');
  }

  const riskScore = Math.max(0, merchant.riskScore ?? 0);
  const maxAutoApproveRiskScore = policy.maxAutoApproveRiskScore ?? 40;
  if (riskScore > maxAutoApproveRiskScore) {
    return manualReview(merchantId, currency, 'risk_score_manual_review');
  }

  const requestedMonthlyVolumeCents = Math.max(
    0,
    request.requestedMonthlyVolumeCents ??
      merchant.requestedMonthlyVolumeCents ??
      0
  );
  const highVolumeReviewCents =
    policy.highVolumeReviewCents ?? Number.POSITIVE_INFINITY;
  if (requestedMonthlyVolumeCents > highVolumeReviewCents) {
    return manualReview(merchantId, currency, 'high_volume_manual_review');
  }

  return {
    status: 'approved',
    reason: null,
    merchantId,
    currency,
    payoutEnabled: true,
    riskTier: riskScore <= (policy.lowRiskThreshold ?? 20) ? 'low' : 'standard',
    settlementDelayDays: policy.defaultSettlementDelayDays ?? 2,
    approvedAt: new Date(now).toISOString()
  };
}

function rejected(merchantId, currency, reason) {
  return {
    status: 'rejected',
    reason,
    merchantId,
    currency,
    payoutEnabled: false,
    riskTier: null,
    settlementDelayDays: null,
    approvedAt: null
  };
}

function manualReview(merchantId, currency, reason) {
  return {
    status: 'manual_review',
    reason,
    merchantId,
    currency,
    payoutEnabled: false,
    riskTier: null,
    settlementDelayDays: null,
    approvedAt: null
  };
}

module.exports = { reviewMerchantOnboarding };
