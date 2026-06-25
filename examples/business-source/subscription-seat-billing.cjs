/* global module */

function calculateSubscriptionInvoice(account, usage = {}, now = new Date()) {
  const currency = account.currency ?? 'USD';
  if (account.status !== 'active') return zeroInvoice(currency);

  const nowMs = new Date(now).getTime();
  if (account.trialEndsAt && nowMs < new Date(account.trialEndsAt).getTime()) {
    return zeroInvoice(currency);
  }
  if (
    account.cancelAtPeriodEnd === true &&
    account.currentPeriodEndsAt &&
    nowMs >= new Date(account.currentPeriodEndsAt).getTime()
  ) {
    return zeroInvoice(currency);
  }

  const billableSeats = Math.max(
    account.minimumSeats ?? 1,
    usage.activeSeats ?? account.seats ?? 1
  );
  const seatSubtotalCents = billableSeats * account.seatPriceCents;
  const meteredSubtotalCents =
    Math.max(0, usage.apiCalls ?? 0) * (account.apiCallPriceCents ?? 0);
  const subtotalCents = seatSubtotalCents + meteredSubtotalCents;
  const discountCents =
    account.plan === 'annual' ? Math.round((subtotalCents * 1500) / 10000) : 0;
  const taxableCents = Math.max(0, subtotalCents - discountCents);
  const taxCents = Math.round(
    (taxableCents * (account.taxRateBps ?? 0)) / 10000
  );

  return {
    currency,
    billableSeats,
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: taxableCents + taxCents
  };
}

function zeroInvoice(currency = 'USD') {
  return {
    currency,
    billableSeats: 0,
    subtotalCents: 0,
    discountCents: 0,
    taxCents: 0,
    totalCents: 0
  };
}

module.exports = { calculateSubscriptionInvoice };
