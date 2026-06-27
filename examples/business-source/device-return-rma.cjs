/* global module */

function evaluateDeviceReturn(
  customer = {},
  device = {},
  request = {},
  policy = {},
  now = new Date()
) {
  const customerId = customer.id ?? null;
  const deviceId = device.id ?? null;
  const purchasedAt = new Date(device.purchasedAt ?? now);
  const nowDate = new Date(now);
  const daysSincePurchase = Math.ceil(
    (nowDate.getTime() - purchasedAt.getTime()) / 86_400_000
  );
  const returnWindowDays = policy.returnWindowDays ?? 30;
  const details = {
    customerId,
    deviceId,
    daysSincePurchase,
    purchasedAt: purchasedAt.toISOString(),
    now
  };

  if (customer.status !== 'active') {
    return blocked('customer_not_active', details);
  }

  if (customer.fraudHold === true) {
    return blocked('customer_fraud_hold', details);
  }

  if (device.ownerCustomerId !== customer.id) {
    return blocked('ownership_mismatch', details);
  }

  if (request.type !== 'rma_return') {
    return blocked('unsupported_return_type', details);
  }

  if (policy.requireSerialNumber === true && !device.serialNumber) {
    return manual('serial_number_missing', details);
  }

  if (daysSincePurchase > returnWindowDays) {
    return blocked('return_window_expired', details);
  }

  if (request.condition === 'damaged' && policy.allowDamagedReturns !== true) {
    return manual('damaged_device_review', details);
  }

  if (request.accessoriesComplete === false) {
    return manual('accessories_missing', details);
  }

  const inspectionThreshold =
    policy.inspectionRequiredOverValueCents ?? Number.POSITIVE_INFINITY;
  if ((device.itemValueCents ?? 0) > inspectionThreshold) {
    return manual('high_value_inspection', details);
  }

  const refundCents = Math.max(
    0,
    (device.itemValueCents ?? 0) - (policy.restockingFeeCents ?? 0)
  );

  return decision('approved', null, {
    ...details,
    returnApproved: true,
    requiresManualReview: false,
    refundCents
  });
}

function blocked(reason, details) {
  return decision('blocked', reason, {
    ...details,
    returnApproved: false,
    requiresManualReview: false,
    refundCents: 0
  });
}

function manual(reason, details) {
  return decision('manual_review', reason, {
    ...details,
    returnApproved: false,
    requiresManualReview: true,
    refundCents: 0
  });
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    customerId: details.customerId,
    deviceId: details.deviceId,
    daysSincePurchase: details.daysSincePurchase,
    purchasedAt: details.purchasedAt,
    returnApproved: details.returnApproved,
    requiresManualReview: details.requiresManualReview,
    refundCents: details.refundCents,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { evaluateDeviceReturn };
