/* global module */

const SEVERITY_RANK = {
  low: 1,
  normal: 2,
  medium: 2,
  high: 3,
  urgent: 4,
  critical: 5
};

function routeSupportTicket(
  ticket = {},
  customer = {},
  policy = {},
  now = new Date()
) {
  const category = ticket.category ?? 'general';
  const severity = ticket.severity ?? 'normal';
  const severityRank = SEVERITY_RANK[severity] ?? SEVERITY_RANK.normal;

  if (ticket.status !== 'open') {
    return unassigned('ticket_not_open');
  }

  if (category === 'security' || category === 'outage' || severityRank >= 5) {
    return assign(
      'incident-response',
      'critical',
      policy.criticalSlaHours ?? 1,
      true,
      'critical_issue',
      now
    );
  }

  if (customer.plan === 'enterprise' && severityRank >= 3) {
    return assign(
      'enterprise-success',
      'high',
      policy.enterpriseSlaHours ?? 4,
      true,
      'enterprise_high_severity',
      now
    );
  }

  if (category === 'billing') {
    return assign(
      'billing-support',
      severityRank >= 3 ? 'high' : 'normal',
      policy.billingSlaHours ?? 12,
      false,
      null,
      now
    );
  }

  if (category === 'abuse') {
    const escalated = severityRank >= 4;
    return assign(
      'trust-safety',
      severityRank >= 3 ? 'high' : 'normal',
      policy.trustSlaHours ?? 6,
      escalated,
      escalated ? 'trust_escalation' : null,
      now
    );
  }

  return assign(
    'technical-support',
    severityRank >= 3 ? 'high' : 'normal',
    policy.standardSlaHours ?? 24,
    false,
    null,
    now
  );
}

function assign(route, priority, slaHours, escalated, reason, now) {
  const dueAt = new Date(new Date(now).getTime() + slaHours * 3_600_000);
  return {
    route,
    priority,
    slaHours,
    dueAt: dueAt.toISOString(),
    escalated,
    reason
  };
}

function unassigned(reason) {
  return {
    route: null,
    priority: 'none',
    slaHours: 0,
    dueAt: null,
    escalated: false,
    reason
  };
}

module.exports = { routeSupportTicket };
