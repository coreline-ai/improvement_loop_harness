/* global module */

function calculateUsageInvoice(
  account = {},
  usage = {},
  pricing = {},
  policy = {},
  now = new Date()
) {
  const accountId = account.id ?? null;
  const usageId = usage.id ?? null;
  const currency = pricing.currency ?? account.currency ?? 'USD';
  const includedUnits = account.includedUnits ?? policy.defaultIncludedUnits ?? 0;
  const unitPriceCents = pricing.unitPriceCents ?? 0;
  const details = {
    accountId,
    usageId,
    currency,
    now
  };

  if (account.status !== 'active') {
    return blocked('account_not_active', details);
  }

  if (usage.status !== 'finalized') {
    return manual('usage_not_finalized', details);
  }

  if (
    account.currency != null &&
    pricing.currency != null &&
    account.currency !== pricing.currency
  ) {
    return blocked('currency_mismatch', details);
  }

  if ((usage.billableUnits ?? 0) <= includedUnits) {
    return decision('approved', null, {
      ...details,
      overageBillable: false,
      requiresManualReview: false,
      invoiceCents: 0
    });
  }

  const overageUnits = (usage.billableUnits ?? 0) - includedUnits;
  const invoiceCents = Math.round(overageUnits * unitPriceCents);

  if (
    policy.maxOverageCents != null &&
    invoiceCents > policy.maxOverageCents
  ) {
    return manual('overage_cap_exceeded', {
      ...details,
      overageBillable: true,
      invoiceCents
    });
  }

  return decision('approved', null, {
    ...details,
    overageBillable: true,
    requiresManualReview: false,
    invoiceCents
  });
}

function blocked(reason, details) {
  return decision('blocked', reason, {
    ...details,
    overageBillable: false,
    requiresManualReview: false,
    invoiceCents: 0
  });
}

function manual(reason, details) {
  return decision('manual_review', reason, {
    ...details,
    overageBillable: details.overageBillable ?? false,
    requiresManualReview: true,
    invoiceCents: details.invoiceCents ?? 0
  });
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    accountId: details.accountId,
    usageId: details.usageId,
    currency: details.currency,
    overageBillable: details.overageBillable,
    requiresManualReview: details.requiresManualReview,
    invoiceCents: details.invoiceCents,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { calculateUsageInvoice };
