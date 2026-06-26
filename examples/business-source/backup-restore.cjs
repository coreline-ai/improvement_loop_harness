/* global module */

function evaluateBackupRestore(
  backup = {},
  restore = {},
  approval = {},
  policy = {},
  now = new Date()
) {
  const backupId = backup.id ?? null;
  const restoreId = restore.id ?? null;
  const targetEnvironment =
    restore.targetEnvironment ?? policy.defaultRestoreEnvironment ?? 'staging';
  const allowedRestoreEnvironments =
    Array.isArray(policy.allowedRestoreEnvironments) &&
    policy.allowedRestoreEnvironments.length > 0
      ? policy.allowedRestoreEnvironments
      : ['staging', 'production', 'dr'];

  const details = {
    backupId,
    restoreId,
    targetEnvironment,
    emergencyOverrideRequired: false,
    now
  };

  if (backup.status !== 'available') {
    return blocked('backup_not_available', details);
  }

  if (backup.encrypted !== true) {
    return blocked('backup_not_encrypted', details);
  }

  if ((backup.snapshotAgeHours ?? 0) > (policy.maxSnapshotAgeHours ?? 24)) {
    return manual('snapshot_too_old', details);
  }

  if (backup.integrityVerified !== true) {
    return blocked('integrity_check_required', details);
  }

  if (!allowedRestoreEnvironments.includes(targetEnvironment)) {
    return blocked('restore_environment_not_allowed', details);
  }

  if (
    restore.dataClass === 'sensitive' &&
    approval.securityApproved !== true
  ) {
    return manual('security_approval_required', details);
  }

  if (restore.crossRegion === true && approval.drOwnerApproved !== true) {
    return manual('dr_owner_approval_required', details);
  }

  if (
    restore.emergency === true &&
    policy.allowEmergencyOverride === true &&
    approval.incidentCommanderApproved !== true
  ) {
    return manual('emergency_override_required', {
      ...details,
      emergencyOverrideRequired: true
    });
  }

  if ((restore.rpoMinutes ?? 0) > (policy.maxRpoMinutes ?? 60)) {
    return manual('rpo_breach', details);
  }

  if (restore.dryRunPassed !== true) {
    return blocked('dry_run_required', details);
  }

  if ((restore.drillWithinDays ?? 0) > (policy.maxDrillAgeDays ?? 30)) {
    return manual('dr_drill_stale', details);
  }

  return decision('approved', null, {
    ...details,
    restoreAllowed: true,
    requiresManualReview: false
  });
}

function blocked(reason, details) {
  return decision('blocked', reason, {
    ...details,
    restoreAllowed: false,
    requiresManualReview: false
  });
}

function manual(reason, details) {
  return decision('manual_review', reason, {
    ...details,
    restoreAllowed: false,
    requiresManualReview: true
  });
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    backupId: details.backupId,
    restoreId: details.restoreId,
    targetEnvironment: details.targetEnvironment,
    restoreAllowed: details.restoreAllowed,
    requiresManualReview: details.requiresManualReview,
    emergencyOverrideRequired: details.emergencyOverrideRequired,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { evaluateBackupRestore };
