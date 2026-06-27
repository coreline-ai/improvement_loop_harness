/* global module */

function evaluateContractRenewal(
  account = {},
  contract = {},
  notice = {},
  policy = {},
  now = new Date()
) {
  const accountId = account.id ?? null;
  const contractId = contract.id ?? null;
  const minNoticeDays = policy.minNoticeDays ?? 30;
  const renewalAt = new Date(contract.renewalAt ?? contract.endsAt ?? now);
  const nowDate = new Date(now);
  const daysUntilRenewal = Math.ceil(
    (renewalAt.getTime() - nowDate.getTime()) / 86_400_000
  );
  const details = {
    accountId,
    contractId,
    daysUntilRenewal,
    renewalAt: renewalAt.toISOString(),
    now
  };

  if (account.status !== 'active') {
    return blocked('account_not_active', details);
  }

  if (contract.status !== 'active') {
    return blocked('contract_not_active', details);
  }

  if (contract.autoRenew !== true) {
    return blocked('auto_renew_disabled', details);
  }

  if (notice.sent !== true) {
    return manual('renewal_notice_not_sent', details);
  }

  if (daysUntilRenewal < minNoticeDays) {
    return manual('renewal_notice_window_missed', details);
  }

  if (policy.requireBillingCurrent === true && account.billingCurrent !== true) {
    return manual('billing_not_current', details);
  }

  if (contract.pendingCancellation === true) {
    return blocked('pending_cancellation', details);
  }

  if (contract.termsChanged === true && notice.termsAccepted !== true) {
    return manual('terms_change_unaccepted', details);
  }

  return decision('approved', null, {
    ...details,
    renewalApproved: true,
    requiresManualReview: false,
    renewalAmountCents:
      contract.renewalAmountCents ?? contract.amountCents ?? 0
  });
}

function blocked(reason, details) {
  return decision('blocked', reason, {
    ...details,
    renewalApproved: false,
    requiresManualReview: false,
    renewalAmountCents: 0
  });
}

function manual(reason, details) {
  return decision('manual_review', reason, {
    ...details,
    renewalApproved: false,
    requiresManualReview: true,
    renewalAmountCents: 0
  });
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    accountId: details.accountId,
    contractId: details.contractId,
    daysUntilRenewal: details.daysUntilRenewal,
    renewalAt: details.renewalAt,
    renewalApproved: details.renewalApproved,
    requiresManualReview: details.requiresManualReview,
    renewalAmountCents: details.renewalAmountCents,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { evaluateContractRenewal };
