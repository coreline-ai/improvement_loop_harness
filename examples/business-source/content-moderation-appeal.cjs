/* global module */

function reviewModerationAppeal(
  user = {},
  content = {},
  appeal = {},
  policy = {},
  now = new Date()
) {
  const userId = user.id ?? null;
  const contentId = content.id ?? null;
  const region = user.region ?? policy.defaultRegion ?? 'US';

  if (content.status !== 'removed') {
    return denied(userId, contentId, region, 'content_not_removed');
  }
  if (appeal.submitted !== true) {
    return denied(userId, contentId, region, 'appeal_not_submitted');
  }
  if (appeal.userId !== userId || content.ownerId !== userId) {
    return denied(userId, contentId, region, 'owner_mismatch');
  }
  if (content.safetyCritical === true) {
    return upheld(userId, contentId, region, 'safety_critical_policy');
  }

  const daysSinceRemoval = ageInDays(content.removedAt, now);
  const appealDeadlineDays = policy.appealDeadlineDays ?? 30;
  if (daysSinceRemoval > appealDeadlineDays) {
    return denied(userId, contentId, region, 'appeal_window_expired');
  }
  if (appeal.newEvidence === true && appeal.evidenceReviewed !== true) {
    return review(userId, contentId, region, 'new_evidence_review');
  }
  if (
    content.repeatedViolation === true &&
    policy.requireHumanReviewForRepeat === true
  ) {
    return review(userId, contentId, region, 'repeat_violation_review');
  }

  const restrictedRestoreRegions = policy.restrictedRestoreRegions ?? [];
  const restoreScope = restrictedRestoreRegions.includes(region)
    ? 'limited'
    : 'full';
  return {
    status: 'restored',
    reason: null,
    userId,
    contentId,
    region,
    contentRestored: true,
    requiresManualReview: false,
    restoreScope,
    restoredAt: new Date(now).toISOString()
  };
}

function ageInDays(start, now) {
  const startMs = new Date(start).getTime();
  const nowMs = new Date(now).getTime();
  return Math.floor((nowMs - startMs) / 86_400_000);
}

function denied(userId, contentId, region, reason) {
  return {
    status: 'denied',
    reason,
    userId,
    contentId,
    region,
    contentRestored: false,
    requiresManualReview: false,
    restoreScope: null,
    restoredAt: null
  };
}

function upheld(userId, contentId, region, reason) {
  return {
    status: 'upheld',
    reason,
    userId,
    contentId,
    region,
    contentRestored: false,
    requiresManualReview: false,
    restoreScope: null,
    restoredAt: null
  };
}

function review(userId, contentId, region, reason) {
  return {
    status: 'manual_review',
    reason,
    userId,
    contentId,
    region,
    contentRestored: false,
    requiresManualReview: true,
    restoreScope: null,
    restoredAt: null
  };
}

module.exports = { reviewModerationAppeal };
