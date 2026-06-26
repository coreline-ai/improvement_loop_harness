/* global module */

function evaluateCreditMemo(
  invoice = {},
  request = {},
  account = {},
  policy = {},
  now = new Date()
) {
  const invoiceId = invoice.id ?? null;
  const accountId = account.id ?? invoice.accountId ?? null;
  const currency = invoice.currency ?? request.currency ?? 'USD';
  const amountCents = Math.max(0, request.amountCents ?? 0);
  const settledStatus = ['paid', 'settled'];

  if (!settledStatus.includes(invoice.status)) {
    return decision('denied', 'invoice_not_settled', {
      invoiceId,
      accountId,
      currency,
      amountCents,
      requiresApproval: false,
      approved: false,
      now
    });
  }

  if (account.status === 'suspended' && policy.allowSuspendedAccounts !== true) {
    return decision('denied', 'account_suspended', {
      invoiceId,
      accountId,
      currency,
      amountCents,
      requiresApproval: false,
      approved: false,
      now
    });
  }

  if (request.duplicateMemo === true || invoice.hasOpenCreditMemo === true) {
    return decision('denied', 'duplicate_credit_memo', {
      invoiceId,
      accountId,
      currency,
      amountCents,
      requiresApproval: false,
      approved: false,
      now
    });
  }

  if (request.type === 'service_credit' && !request.linkedDisputeId) {
    return decision('manual_review', 'missing_dispute_evidence', {
      invoiceId,
      accountId,
      currency,
      amountCents,
      requiresApproval: true,
      approved: false,
      now
    });
  }

  const settledAt = invoice.settledAt ?? invoice.paidAt;
  const daysSinceSettlement = elapsedDays(settledAt, now);
  const creditWindowDays = policy.creditWindowDays ?? 90;
  if (daysSinceSettlement > creditWindowDays) {
    return decision('denied', 'credit_window_expired', {
      invoiceId,
      accountId,
      currency,
      amountCents,
      requiresApproval: false,
      approved: false,
      now
    });
  }

  if (amountCents <= 0) {
    return decision('denied', 'invalid_credit_amount', {
      invoiceId,
      accountId,
      currency,
      amountCents,
      requiresApproval: false,
      approved: false,
      now
    });
  }

  const paidCents = invoice.paidCents ?? invoice.totalCents ?? 0;
  if (amountCents > paidCents) {
    return decision('denied', 'credit_exceeds_paid_amount', {
      invoiceId,
      accountId,
      currency,
      amountCents,
      requiresApproval: false,
      approved: false,
      now
    });
  }

  if (request.reason === 'tax_adjustment') {
    const taxAdjustmentCapCents =
      policy.taxAdjustmentCapCents ??
      Math.round((invoice.taxCents ?? 0) * (policy.taxAdjustmentCapRate ?? 1));
    if (amountCents > taxAdjustmentCapCents) {
      return decision('manual_review', 'tax_adjustment_cap', {
        invoiceId,
        accountId,
        currency,
        amountCents,
        requiresApproval: true,
        approved: false,
        now
      });
    }
  }

  const autoApproveLimitCents =
    policy.autoApproveLimitCents ?? Number.POSITIVE_INFINITY;
  if (amountCents > autoApproveLimitCents) {
    return decision('manual_review', 'approval_threshold', {
      invoiceId,
      accountId,
      currency,
      amountCents,
      requiresApproval: true,
      approved: false,
      now
    });
  }

  return decision('approved', null, {
    invoiceId,
    accountId,
    currency,
    amountCents,
    requiresApproval: false,
    approved: true,
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
    invoiceId: details.invoiceId,
    accountId: details.accountId,
    currency: details.currency,
    amountCents: details.amountCents,
    requiresApproval: details.requiresApproval,
    approved: details.approved,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { evaluateCreditMemo };
