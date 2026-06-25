/* global module */

function evaluateCancellation(booking = {}, request = {}, policy = {}, now = new Date()) {
  const currency = booking.currency ?? 'USD';
  const depositCents = Math.max(0, booking.depositCents ?? 0);
  const serviceFeeCents = Math.max(0, booking.serviceFeeCents ?? 0);
  const refundMethod =
    request.refundToOriginalPayment === false ? 'account_credit' : 'original_payment';

  if (booking.status !== 'confirmed') {
    return denied(currency, refundMethod, 'booking_not_confirmed');
  }
  if (request.reason === 'provider_cancelled') {
    return approved(currency, refundMethod, depositCents + serviceFeeCents);
  }
  if (request.noShow === true) {
    return penalized(currency, refundMethod, 'no_show', depositCents + serviceFeeCents);
  }

  const startsAtMs = new Date(booking.startsAt).getTime();
  const nowMs = new Date(now).getTime();
  const hoursUntilStart = Math.floor((startsAtMs - nowMs) / 3_600_000);
  if (hoursUntilStart < 0) {
    return penalized(currency, refundMethod, 'appointment_started', depositCents);
  }

  const freeCancelHours = policy.freeCancelHours ?? 24;
  if (hoursUntilStart < freeCancelHours) {
    const lateFeeCents = Math.min(
      depositCents,
      policy.lateCancellationFeeCents ?? depositCents
    );
    return penalized(currency, refundMethod, 'late_cancellation', lateFeeCents);
  }

  return approved(currency, refundMethod, depositCents);
}

function approved(currency, refundMethod, refundCents) {
  return {
    cancellable: true,
    reason: null,
    currency,
    refundMethod,
    penaltyCents: 0,
    refundCents
  };
}

function denied(currency, refundMethod, reason) {
  return {
    cancellable: false,
    reason,
    currency,
    refundMethod,
    penaltyCents: 0,
    refundCents: 0
  };
}

function penalized(currency, refundMethod, reason, penaltyCents) {
  return {
    cancellable: true,
    reason,
    currency,
    refundMethod,
    penaltyCents,
    refundCents: 0
  };
}

module.exports = { evaluateCancellation };
