/* global module */

function evaluateReferralReward(
  referrer = {},
  referee = {},
  order = {},
  campaign = {},
  ledger = {},
  now = new Date()
) {
  const referrerId = referrer.id ?? null;
  const refereeId = referee.id ?? null;
  const orderId = order.id ?? null;
  const nowIso = new Date(now).toISOString();
  const details = {
    referrerId,
    refereeId,
    orderId,
    currency: order.currency ?? campaign.currency ?? null,
    now: nowIso
  };

  if (campaign.status !== 'active') {
    return blocked('campaign_inactive', details);
  }

  if (referrer.status !== 'active') {
    return blocked('referrer_not_active', details);
  }

  if (referee.status !== 'active') {
    return blocked('referee_not_active', details);
  }

  if (referrer.id === referee.id) {
    return blocked('self_referral', details);
  }

  if (order.status !== 'completed') {
    return blocked('order_not_completed', details);
  }

  if (order.refunded === true) {
    return blocked('order_refunded', details);
  }

  if (campaign.currency && order.currency !== campaign.currency) {
    return manual('currency_mismatch', details);
  }

  const completedAt = new Date(order.completedAt ?? now);
  const startsAt = campaign.startsAt ? new Date(campaign.startsAt) : null;
  const endsAt = campaign.endsAt ? new Date(campaign.endsAt) : null;
  if ((startsAt && completedAt < startsAt) || (endsAt && completedAt > endsAt)) {
    return blocked('order_outside_campaign_window', details);
  }

  const minEligibleOrderCents = campaign.minEligibleOrderCents ?? 0;
  if ((order.totalCents ?? 0) < minEligibleOrderCents) {
    return blocked('minimum_order_not_met', details);
  }

  if ((ledger.rewardedOrderIds ?? []).includes(order.id)) {
    return blocked('duplicate_reward', details);
  }

  const configuredRewardCents = campaign.rewardCents ?? 0;
  if (configuredRewardCents <= 0) {
    return manual('reward_not_configured', details);
  }

  const rewardCents = Math.min(
    configuredRewardCents,
    campaign.maxRewardCents ?? Number.POSITIVE_INFINITY
  );
  const manualThresholdCents =
    campaign.manualReviewThresholdCents ?? Number.POSITIVE_INFINITY;
  if (rewardCents > manualThresholdCents) {
    return manual('reward_manual_review_threshold', {
      ...details,
      rewardCents
    });
  }

  return decision('approved', null, {
    ...details,
    payoutAllowed: true,
    requiresManualReview: false,
    rewardCents
  });
}

function blocked(reason, details) {
  return decision('blocked', reason, {
    ...details,
    payoutAllowed: false,
    requiresManualReview: false,
    rewardCents: 0
  });
}

function manual(reason, details) {
  return decision('manual_review', reason, {
    ...details,
    payoutAllowed: false,
    requiresManualReview: true,
    rewardCents: details.rewardCents ?? 0
  });
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    referrerId: details.referrerId,
    refereeId: details.refereeId,
    orderId: details.orderId,
    currency: details.currency,
    payoutAllowed: details.payoutAllowed,
    requiresManualReview: details.requiresManualReview,
    rewardCents: details.rewardCents,
    reviewedAt: details.now
  };
}

module.exports = { evaluateReferralReward };
