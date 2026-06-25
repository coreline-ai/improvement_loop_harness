/* global module */

function evaluateReturnAuthorization(order = {}, request = {}, policy = {}, now = new Date()) {
  const currency = order.currency ?? 'USD';
  const refundMethod = request.receiptAvailable === false ? 'store_credit' : 'original_payment';

  if (!['fulfilled', 'delivered'].includes(order.status)) {
    return denied(currency, refundMethod, 'order_not_delivered');
  }
  if (order.finalSale === true) {
    return denied(currency, refundMethod, 'final_sale');
  }

  const deliveredAtMs = new Date(order.deliveredAt).getTime();
  const nowMs = new Date(now).getTime();
  const daysSinceDelivery = Math.floor((nowMs - deliveredAtMs) / 86_400_000);
  const returnWindowDays = policy.returnWindowDays ?? 30;
  if (daysSinceDelivery > returnWindowDays) {
    return denied(currency, refundMethod, 'return_window_expired');
  }

  const itemSubtotalCents = Math.max(0, order.itemSubtotalCents ?? 0);
  const restockingFeeBps =
    request.reason === 'damaged' ? 0 : (policy.restockingFeeBps ?? 0);
  const restockingFeeCents = Math.round(
    (itemSubtotalCents * restockingFeeBps) / 10000
  );
  const shippingRefundCents =
    policy.refundShipping === true || request.reason === 'damaged'
      ? (order.shippingCents ?? 0)
      : 0;
  const refundCents = Math.max(
    0,
    itemSubtotalCents - restockingFeeCents + shippingRefundCents
  );

  return {
    eligible: true,
    reason: null,
    currency,
    refundMethod,
    restockingFeeCents,
    shippingRefundCents,
    refundCents
  };
}

function denied(currency, refundMethod, reason) {
  return {
    eligible: false,
    reason,
    currency,
    refundMethod,
    restockingFeeCents: 0,
    shippingRefundCents: 0,
    refundCents: 0
  };
}

module.exports = { evaluateReturnAuthorization };
