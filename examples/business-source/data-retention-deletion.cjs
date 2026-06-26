/* global module */

function processDataDeletionRequest(
  account = {},
  request = {},
  policy = {},
  now = new Date()
) {
  const accountId = account.id ?? null;
  const region = account.region ?? policy.defaultRegion ?? 'US';

  if (account.status !== 'active') {
    return denied(accountId, region, 'account_not_active');
  }
  if (request.confirmed !== true) {
    return denied(accountId, region, 'confirmation_required');
  }
  if (request.requesterVerified !== true || account.verifiedRequester !== true) {
    return denied(accountId, region, 'requester_not_verified');
  }
  if (account.legalHold === true) {
    return denied(accountId, region, 'legal_hold');
  }
  if (account.openCase === true) {
    return review(accountId, region, 'open_case_review');
  }
  if (policy.requireExportReady === true && account.exportReady !== true) {
    return review(accountId, region, 'data_export_pending');
  }

  const daysSinceLastActivity = ageInDays(account.lastActivityAt, now);
  const minRetentionDays = policy.minRetentionDays ?? 365;
  if (daysSinceLastActivity < minRetentionDays) {
    return denied(accountId, region, 'retention_period_active');
  }

  if (account.minorData === true && policy.minorDataManualReview === true) {
    return review(accountId, region, 'minor_data_review');
  }

  const regionalErasureRegions = policy.regionalErasureRegions ?? [];
  const deletionScope = regionalErasureRegions.includes(region)
    ? 'full'
    : 'limited';
  return {
    status: 'deleted',
    reason: null,
    accountId,
    region,
    dataDeleted: true,
    requiresManualReview: false,
    deletionScope,
    retainedAuditDays: policy.auditTrailRetentionDays ?? 30,
    scheduledAt: new Date(now).toISOString()
  };
}

function ageInDays(start, now) {
  const startMs = new Date(start).getTime();
  const nowMs = new Date(now).getTime();
  return Math.floor((nowMs - startMs) / 86_400_000);
}

function denied(accountId, region, reason) {
  return {
    status: 'denied',
    reason,
    accountId,
    region,
    dataDeleted: false,
    requiresManualReview: false,
    deletionScope: null,
    retainedAuditDays: null,
    scheduledAt: null
  };
}

function review(accountId, region, reason) {
  return {
    status: 'manual_review',
    reason,
    accountId,
    region,
    dataDeleted: false,
    requiresManualReview: true,
    deletionScope: null,
    retainedAuditDays: null,
    scheduledAt: null
  };
}

module.exports = { processDataDeletionRequest };
