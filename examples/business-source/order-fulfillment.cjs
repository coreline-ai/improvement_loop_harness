/* global module */

function quoteFulfillment(order = {}, inventory = {}, now = new Date()) {
  const serviceLevel = order.serviceLevel ?? 'standard';
  const country = order.shippingAddress?.country ?? 'US';
  const supportedCountries = inventory.supportedCountries ?? ['US'];

  if (order.status !== 'paid') {
    return unavailable(serviceLevel, 'order_not_paid');
  }
  if (!supportedCountries.includes(country)) {
    return unavailable(serviceLevel, 'unsupported_country');
  }
  if (order.shippingAddress?.type === 'po_box' && serviceLevel === 'express') {
    return unavailable(serviceLevel, 'po_box_express_unavailable');
  }
  if (order.containsHazmat === true && serviceLevel === 'express') {
    return unavailable(serviceLevel, 'hazmat_express_restricted');
  }
  if ((order.weightGrams ?? 0) > (inventory.maxWeightGrams ?? Infinity)) {
    return unavailable(serviceLevel, 'package_overweight');
  }
  if ((inventory.availableStock ?? 0) < (order.quantity ?? 1)) {
    return unavailable(serviceLevel, 'insufficient_stock');
  }

  const cutoffHour = inventory.cutoffHourLocal ?? 15;
  const submittedHour = new Date(now).getUTCHours();
  const shipAfterBusinessDays = submittedHour >= cutoffHour ? 1 : 0;
  const baseShippingCents = inventory.baseShippingCents ?? 500;
  const expressSurchargeCents =
    serviceLevel === 'express' ? (inventory.expressSurchargeCents ?? 1500) : 0;
  const freeShippingThresholdCents =
    inventory.freeShippingThresholdCents ?? Number.POSITIVE_INFINITY;
  const qualifiesForFreeStandard =
    serviceLevel === 'standard' &&
    (order.subtotalCents ?? 0) >= freeShippingThresholdCents;

  return {
    eligible: true,
    reason: null,
    serviceLevel,
    warehouseId: inventory.warehouseId ?? null,
    shipAfterBusinessDays,
    transitBusinessDays: serviceLevel === 'express' ? 1 : 4,
    shippingCents: qualifiesForFreeStandard
      ? 0
      : baseShippingCents + expressSurchargeCents
  };
}

function unavailable(serviceLevel, reason) {
  return {
    eligible: false,
    reason,
    serviceLevel,
    warehouseId: null,
    shipAfterBusinessDays: null,
    transitBusinessDays: null,
    shippingCents: 0
  };
}

module.exports = { quoteFulfillment };
