/* global module */

function evaluateReleaseReadiness(
  release = {},
  checks = {},
  approval = {},
  policy = {},
  now = new Date()
) {
  const releaseId = release.id ?? null;
  const environment = release.environment ?? policy.defaultEnvironment ?? 'staging';
  const deploymentId = release.deploymentId ?? null;
  const allowedEnvironments =
    Array.isArray(policy.allowedEnvironments) && policy.allowedEnvironments.length > 0
      ? policy.allowedEnvironments
      : ['staging', 'production'];

  if (release.status !== 'ready') {
    return blocked('release_not_ready', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if (!allowedEnvironments.includes(environment)) {
    return blocked('environment_not_allowed', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if (checks.buildPassed !== true) {
    return blocked('build_failed', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if (checks.smokePassed !== true) {
    return blocked('smoke_failed', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: true,
      now
    });
  }

  if (checks.securityScanPassed !== true) {
    return blocked('security_scan_failed', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if ((checks.openSev1Incidents ?? 0) > 0) {
    return blocked('active_sev1_incident', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if (release.hasRollbackPlan !== true) {
    return manual('rollback_plan_required', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if (release.deploymentWindowApproved !== true) {
    return manual('deployment_window_required', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if (release.freezeWindow === true) {
    return manual('freeze_window', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if (
    release.riskLevel === 'high' &&
    approval.changeManagerApproved !== true
  ) {
    return manual('change_manager_approval_required', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if (approval.releaseOwnerApproved !== true) {
    return manual('release_owner_approval_required', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  if (policy.requireSreApproval === true && approval.sreApproved !== true) {
    return manual('sre_approval_required', {
      releaseId,
      deploymentId,
      environment,
      rollbackRequired: false,
      now
    });
  }

  return decision('approved', null, {
    releaseId,
    deploymentId,
    environment,
    releaseAllowed: true,
    requiresManualReview: false,
    rollbackRequired: false,
    now
  });
}

function blocked(reason, details) {
  return decision('blocked', reason, {
    ...details,
    releaseAllowed: false,
    requiresManualReview: false
  });
}

function manual(reason, details) {
  return decision('manual_review', reason, {
    ...details,
    releaseAllowed: false,
    requiresManualReview: true
  });
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    releaseId: details.releaseId,
    deploymentId: details.deploymentId,
    environment: details.environment,
    releaseAllowed: details.releaseAllowed,
    requiresManualReview: details.requiresManualReview,
    rollbackRequired: details.rollbackRequired,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { evaluateReleaseReadiness };
