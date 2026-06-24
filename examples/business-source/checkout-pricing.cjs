/* global module */

function calculateCheckoutTotal(cart, customer = {}, now = new Date()) {
  const subtotalCents = cart.items.reduce(
    (sum, item) => sum + item.unitPriceCents * item.quantity,
    0
  );
  const discountCents = calculateDiscountCents(
    subtotalCents,
    cart.coupon,
    customer,
    now
  );
  const taxableCents = Math.max(0, subtotalCents - discountCents);
  const taxCents = Math.round(
    (taxableCents * (cart.taxRateBps ?? 0)) / 10000
  );
  const freeShippingThresholdCents =
    cart.freeShippingThresholdCents ?? Number.POSITIVE_INFINITY;
  const shippingCents =
    taxableCents >= freeShippingThresholdCents ? 0 : (cart.shippingCents ?? 0);

  return {
    currency: cart.currency ?? 'USD',
    subtotalCents,
    discountCents,
    taxCents,
    shippingCents,
    totalCents: taxableCents + taxCents + shippingCents
  };
}

function calculateDiscountCents(
  subtotalCents,
  coupon,
  customer = {},
  now = new Date()
) {
  if (!coupon || coupon.active !== true) return 0;

  const nowMs = new Date(now).getTime();
  if (coupon.startsAt && nowMs < new Date(coupon.startsAt).getTime()) return 0;
  if (coupon.expiresAt && nowMs > new Date(coupon.expiresAt).getTime()) {
    return 0;
  }
  if (
    coupon.minimumSubtotalCents != null &&
    subtotalCents < coupon.minimumSubtotalCents
  ) {
    return 0;
  }
  if (coupon.segment && customer.segment !== coupon.segment) return 0;
  if (coupon.firstOrderOnly === true && (customer.orderCount ?? 0) > 0) {
    return 0;
  }
  if (coupon.percentOffBps != null) {
    const uncapped = Math.round((subtotalCents * coupon.percentOffBps) / 10000);
    return Math.min(
      uncapped,
      coupon.maxDiscountCents ?? Number.MAX_SAFE_INTEGER
    );
  }
  if (coupon.amountOffCents != null) {
    return Math.min(coupon.amountOffCents, subtotalCents);
  }
  return 0;
}

module.exports = { calculateCheckoutTotal, calculateDiscountCents };
