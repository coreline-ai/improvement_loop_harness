/* global module */

function approveVendorInvoice(
  invoice = {},
  vendor = {},
  purchaseOrder = {},
  policy = {},
  now = new Date()
) {
  const invoiceId = invoice.id ?? null;
  const vendorId = vendor.id ?? invoice.vendorId ?? purchaseOrder.vendorId ?? null;
  const purchaseOrderId = purchaseOrder.id ?? invoice.purchaseOrderId ?? null;
  const currency =
    invoice.currency ?? purchaseOrder.currency ?? policy.defaultCurrency ?? 'USD';
  const amountCents = Math.max(0, invoice.amountCents ?? 0);

  if (vendor.status !== 'active') {
    return decision('denied', 'vendor_inactive', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: false,
      approved: false,
      now
    });
  }

  if (vendor.paymentHold === true) {
    return decision('manual_review', 'vendor_payment_hold', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: true,
      approved: false,
      now
    });
  }

  if (policy.requireTaxId !== false && vendor.taxIdVerified !== true) {
    return decision('manual_review', 'tax_id_unverified', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: true,
      approved: false,
      now
    });
  }

  if (purchaseOrder.approved !== true) {
    return decision('denied', 'purchase_order_not_approved', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: false,
      approved: false,
      now
    });
  }

  if (['closed', 'cancelled', 'canceled'].includes(purchaseOrder.status)) {
    return decision('denied', 'purchase_order_closed', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: false,
      approved: false,
      now
    });
  }

  if (amountCents <= 0) {
    return decision('denied', 'invalid_invoice_amount', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: false,
      approved: false,
      now
    });
  }

  if (
    invoice.currency &&
    purchaseOrder.currency &&
    invoice.currency !== purchaseOrder.currency
  ) {
    return decision('denied', 'currency_mismatch', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: false,
      approved: false,
      now
    });
  }

  if (
    invoice.duplicate === true ||
    (Array.isArray(purchaseOrder.invoiceNumbers) &&
      purchaseOrder.invoiceNumbers.includes(invoice.number))
  ) {
    return decision('denied', 'duplicate_invoice', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: false,
      approved: false,
      now
    });
  }

  const remainingCents =
    purchaseOrder.remainingCents ??
    Math.max(
      0,
      (purchaseOrder.totalCents ?? 0) - (purchaseOrder.invoicedCents ?? 0)
    );
  if (amountCents > remainingCents) {
    return decision('manual_review', 'amount_exceeds_po_remaining', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: true,
      approved: false,
      now
    });
  }

  if (
    policy.requireReceiptMatch !== false &&
    invoice.receiptMatched !== true &&
    purchaseOrder.receiptMatched !== true
  ) {
    return decision('manual_review', 'receipt_not_matched', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: true,
      approved: false,
      now
    });
  }

  const receiptToleranceCents = policy.receiptToleranceCents ?? 0;
  if ((invoice.receiptVarianceCents ?? 0) > receiptToleranceCents) {
    return decision('manual_review', 'receipt_tolerance_exceeded', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: true,
      approved: false,
      now
    });
  }

  const autoApproveLimitCents =
    policy.autoApproveLimitCents ?? Number.POSITIVE_INFINITY;
  if (amountCents > autoApproveLimitCents) {
    return decision('manual_review', 'approval_threshold', {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents: 0,
      withholdingCents: 0,
      requiresManualReview: true,
      approved: false,
      now
    });
  }

  const withholdingRate = policy.withholdingRate ?? 0.24;
  const withholdingCents =
    vendor.backupWithholding === true
      ? Math.round(amountCents * withholdingRate)
      : 0;
  const payableCents = amountCents - withholdingCents;

  return decision(
    withholdingCents > 0 ? 'approved_with_withholding' : 'approved',
    null,
    {
      invoiceId,
      vendorId,
      purchaseOrderId,
      currency,
      amountCents,
      payableCents,
      withholdingCents,
      requiresManualReview: false,
      approved: true,
      now
    }
  );
}

function decision(status, reason, details) {
  return {
    status,
    reason,
    invoiceId: details.invoiceId,
    vendorId: details.vendorId,
    purchaseOrderId: details.purchaseOrderId,
    currency: details.currency,
    amountCents: details.amountCents,
    payableCents: details.payableCents,
    withholdingCents: details.withholdingCents,
    requiresManualReview: details.requiresManualReview,
    approved: details.approved,
    reviewedAt: new Date(details.now).toISOString()
  };
}

module.exports = { approveVendorInvoice };
