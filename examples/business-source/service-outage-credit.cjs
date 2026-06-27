/* global module */

function evaluateServiceCredit(
  account = {},
  incident = {},
  policy = {},
  now = new Date()
) {
  const accountId = account.id ?? null;
  const incidentId = incident.id ?? null;
  const minOutageMinutes = policy.minOutageMinutes ?? 60;
  const maxCreditCents = policy.maxCreditCents ?? 5000;
  const creditPercent = policy.creditPercent ?? 25;
  const details = {
    accountId,
    incidentId,
    region: incident.region ?? null,
    now
  };

  if (account.status !== 'active') {
    return blocked('account_not_active', details);
  }

  if (incident.status !== 'resolved') {
    return manual('incident_not_resolved', details);
  }

  if (incident.customerImpacted !== true) {
    return blocked('not_customer_impacting', details);
  }

  if ((incident.durationMinutes ?? 0) < minOutageMinutes) {
    return blocked('outage_below_sla_threshold', details);
  }

  if (
    policy.requireRegionMatch === true &&
    incident.region != null &&
    account.region != null &&
    incident.region !== account.region
  ) {
    return blocked('region_mismatch', details);
  }

  if (
    Array.isArray(policy.excludedPlans) &&
    policy.excludedPlans.includes(account.plan)
  ) {
    return manual('plan_excluded_review', details);
  }

  if (incident.excludedMaintenance === true) {
    return manual('maintenance_exclusion_review', details);
  }

  if (account.hasOpenDispute === true) {
    return manual('open_dispute_review', details);
  }

  const monthlyFeeCents = account.monthlyFeeCents ?? 0;
  const creditCents = Math.min(
    maxCreditCents,
    Math.round(monthlyFeeCents * (creditPercent / 100))
  );

  return decision('approved', null, {
    ...details,
    creditEligible: true,
    requiresManualReview: false,
    creditCents
  });
}

function blocked(reason, details) {
  return decision('blocked', reason, {
    ...details,
    creditEligible: false,
    requiresManualReview: false,
    creditCents: 0
  });
}

function manual(reason, details) {
  return decision('manual_review', reason, {
    ...details,
    creditEligible: false,
    requiresManualReview: true,
    creditCents: 0
  });
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    accountId: details.accountId,
    incidentId: details.incidentId,
    region: details.region,
    creditEligible: details.creditEligible,
    requiresManualReview: details.requiresManualReview,
    creditCents: details.creditCents,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { evaluateServiceCredit };
