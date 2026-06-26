/* global module */

function prepareTaxFiling(
  payee = {},
  payer = {},
  filing = {},
  policy = {},
  now = new Date()
) {
  const payeeId = payee.id ?? filing.payeeId ?? null;
  const payerId = payer.id ?? filing.payerId ?? null;
  const form = filing.form ?? expectedFormFor(payee);
  const grossCents = Math.max(0, filing.grossCents ?? payee.yearToDateCents ?? 0);
  const thresholdCents = policy.reportingThresholdCents ?? 60000;

  if (payer.status !== 'active') {
    return decision('denied', 'payer_inactive', {
      payeeId,
      payerId,
      form,
      grossCents,
      withholdingCents: 0,
      requiresBackupWithholding: false,
      accepted: false,
      now
    });
  }

  if (payee.status === 'suspended') {
    return decision('denied', 'payee_suspended', {
      payeeId,
      payerId,
      form,
      grossCents,
      withholdingCents: 0,
      requiresBackupWithholding: false,
      accepted: false,
      now
    });
  }

  if (grossCents < thresholdCents) {
    return decision('not_required', 'reporting_threshold_not_met', {
      payeeId,
      payerId,
      form,
      grossCents,
      withholdingCents: 0,
      requiresBackupWithholding: false,
      accepted: true,
      now
    });
  }

  const expectedForm = expectedFormFor(payee);
  if (form !== expectedForm) {
    return decision('denied', 'form_mismatch', {
      payeeId,
      payerId,
      form,
      grossCents,
      withholdingCents: 0,
      requiresBackupWithholding: false,
      accepted: false,
      now
    });
  }

  if (isAfter(filing.filedAt ?? now, policy.filingDeadline)) {
    return decision('denied', 'filing_deadline_missed', {
      payeeId,
      payerId,
      form,
      grossCents,
      withholdingCents: 0,
      requiresBackupWithholding: false,
      accepted: false,
      now
    });
  }

  if (filing.correction === true && !filing.originalFiledAt) {
    return decision('denied', 'correction_without_original', {
      payeeId,
      payerId,
      form,
      grossCents,
      withholdingCents: 0,
      requiresBackupWithholding: false,
      accepted: false,
      now
    });
  }

  if (payee.foreign === true && payee.treatyDocumentOnFile !== true) {
    return decision('manual_review', 'treaty_review_required', {
      payeeId,
      payerId,
      form,
      grossCents,
      withholdingCents: 0,
      requiresBackupWithholding: false,
      accepted: false,
      now
    });
  }

  if (payee.w9OnFile !== true) {
    return withholdingDecision({
      payeeId,
      payerId,
      form,
      grossCents,
      filing,
      policy,
      now
    });
  }

  if (payee.tinVerified !== true) {
    return withholdingDecision({
      payeeId,
      payerId,
      form,
      grossCents,
      filing,
      policy,
      now
    });
  }

  return decision('filed', null, {
    payeeId,
    payerId,
    form,
    grossCents,
    withholdingCents: 0,
    requiresBackupWithholding: false,
    accepted: true,
    now
  });
}

function withholdingDecision({ payeeId, payerId, form, grossCents, filing, policy, now }) {
  const rate = policy.backupWithholdingRate ?? 0.24;
  const withholdingCents = Math.round(grossCents * rate);
  if (
    Number.isFinite(filing.withholdingPaidCents) &&
    filing.withholdingPaidCents < withholdingCents
  ) {
    return decision('manual_review', 'withholding_shortfall', {
      payeeId,
      payerId,
      form,
      grossCents,
      withholdingCents,
      requiresBackupWithholding: true,
      accepted: false,
      now
    });
  }

  return decision('withholding_required', 'backup_withholding_required', {
    payeeId,
    payerId,
    form,
    grossCents,
    withholdingCents,
    requiresBackupWithholding: true,
    accepted: false,
    now
  });
}

function expectedFormFor(payee) {
  if (payee.foreign === true) return '1042-S';
  if (payee.kind === 'attorney') return '1099-MISC';
  return '1099-NEC';
}

function isAfter(value, deadline) {
  if (!deadline) return false;
  const valueMs = new Date(value).getTime();
  const deadlineMs = new Date(deadline).getTime();
  if (!Number.isFinite(valueMs) || !Number.isFinite(deadlineMs)) return true;
  return valueMs > deadlineMs;
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    payeeId: details.payeeId,
    payerId: details.payerId,
    form: details.form,
    grossCents: details.grossCents,
    withholdingCents: details.withholdingCents,
    requiresBackupWithholding: details.requiresBackupWithholding,
    accepted: details.accepted,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { prepareTaxFiling };
