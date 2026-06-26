import { describe, expect, it } from 'vitest';
import { filterAdversaryProposal } from '../../packages/eval-engine/src/adversary-filter.ts';
import {
  HIDDEN_ATTACK_SENTINEL,
  ADVERSARY_LIVE_SELECTED_CANDIDATE_ID,
  buildAdversaryLiveAttackScenarioResults,
  buildAdversaryLiveFilterConfig,
  buildAdversaryLiveReviewInput,
  buildAccountClosureSemanticProposal,
  buildAppointmentCancellationSemanticProposal,
  buildCommandAdversaryReviewerProvenance,
  buildControlledAdversaryReviewerProvenance,
  buildCartDiscountSemanticProposal,
  buildCouponApplicationSemanticProposal,
  buildDataRetentionDeletionSemanticProposal,
  buildEntitlementAccessSemanticProposal,
  buildExpenseReimbursementSemanticProposal,
  buildGiftCardRedemptionSemanticProposal,
  buildInsuranceClaimSemanticProposal,
  buildInventoryReservationSemanticProposal,
  buildLoanUnderwritingSemanticProposal,
  buildLoyaltyPointsSemanticProposal,
  buildMerchantOnboardingSemanticProposal,
  buildOrderApprovalSemanticProposal,
  buildPaymentAuthorizationSemanticProposal,
  buildPaymentDisputeSemanticProposal,
  buildPayrollOvertimeSemanticProposal,
  buildRefundEligibilitySemanticProposal,
  buildProfileSuspensionSemanticProposal,
  buildProfileVisibilitySemanticProposal,
  buildCartRoundingSemanticProposal,
  buildCartSemanticProposal,
  buildCartTaxSemanticProposal,
  buildSellerPayoutSemanticProposal,
  buildShippingEligibilitySemanticProposal,
  buildSupportTicketRoutingSemanticProposal,
  buildSubscriptionRenewalSemanticProposal,
  buildVendorInvoiceSemanticProposal,
  buildWarrantyClaimSemanticProposal,
  buildWarehouseAllocationSemanticProposal,
  buildRejectedAttackProposals,
  selectAdversaryLiveReviewProposal,
  validateAdversaryLiveAttackScenarioResults,
  validateAdversaryReviewerProvenance,
  validateCommandAdversaryReviewerProvenance,
  validateControlledAdversaryReviewerProvenance
} from './adversary-live-contract.mjs';
import {
  REQUIRED_ATTACK_SCENARIOS,
  buildAdversaryLiveAttackScenarios
} from './adversary-live-safety.mjs';

describe('adversary live contract', () => {
  it('uses a semantic cart proposal that catches visible-only hardcoding', () => {
    const proposal = buildCartSemanticProposal();

    expect(proposal.targetPath).toBe(
      'tests/adversary/cart-quantity-semantic.test.cjs'
    );
    expect(proposal.expectation).toBe('fail_to_pass');
    expect(proposal.body).toContain('quantity: 3');
    expect(proposal.body).toContain('quantity: 2');
    expect(proposal.body).toContain('quantity: 0');
    expect(proposal.body).toContain('expected');
  });

  it('adds a supplemental discount semantic proposal for multi-rule M4 coverage', () => {
    const proposal = buildCartDiscountSemanticProposal({
      targetPath: 'tests/adversary/cart-line-total-semantics.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'cart-discount-semantic',
      targetPath: 'tests/adversary/cart-line-total-semantics.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('discount: 5');
    expect(proposal.body).toContain('quantity: 0');
    expect(proposal.body).toContain('lineTotal');
  });

  it('adds a supplemental tax semantic proposal for multi-rule M4 coverage', () => {
    const proposal = buildCartTaxSemanticProposal({
      targetPath: 'tests/adversary/cart-line-total-tax.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'cart-tax-semantic',
      targetPath: 'tests/adversary/cart-line-total-tax.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('taxRate: 0.1');
    expect(proposal.body).toContain('assertClose');
    expect(proposal.body).toContain('lineTotal');
  });

  it('adds a supplemental rounding semantic proposal for multi-rule M4 coverage', () => {
    const proposal = buildCartRoundingSemanticProposal({
      targetPath: 'tests/adversary/cart-line-total-rounding.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'cart-rounding-semantic',
      targetPath: 'tests/adversary/cart-line-total-rounding.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('taxRate: 0.2');
    expect(proposal.body).toContain('1.005');
    expect(proposal.body).toContain('lineTotal');
  });

  it('adds a supplemental profile visibility semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildProfileVisibilitySemanticProposal({
      targetPath: 'tests/adversary/profile-visibility.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'profile-visibility-semantic',
      targetPath: 'tests/adversary/profile-visibility.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canViewProfile');
    expect(proposal.body).toContain("visibility: 'private'");
    expect(proposal.body).toContain("visibility: 'adminOnly'");
  });

  it('adds a supplemental profile suspension semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildProfileSuspensionSemanticProposal({
      targetPath: 'tests/adversary/profile-suspension.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'profile-suspension-semantic',
      targetPath: 'tests/adversary/profile-suspension.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canViewProfile');
    expect(proposal.body).toContain('suspended: true');
    expect(proposal.body).toContain("visibility: 'adminOnly'");
  });

  it('adds a supplemental order approval semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildOrderApprovalSemanticProposal({
      targetPath: 'tests/adversary/order-approval.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'order-approval-semantic',
      targetPath: 'tests/adversary/order-approval.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canApproveOrder');
    expect(proposal.body).toContain("role: 'finance'");
    expect(proposal.body).toContain('requesterSuspended: true');
    expect(proposal.body).toContain('department');
  });

  it('adds a supplemental inventory reservation semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildInventoryReservationSemanticProposal({
      targetPath: 'tests/adversary/inventory-reservation.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'inventory-reservation-semantic',
      targetPath: 'tests/adversary/inventory-reservation.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canReserveInventory');
    expect(proposal.body).toContain('warehouseActive: false');
    expect(proposal.body).toContain('backorderLimit');
    expect(proposal.body).toContain('perCustomerLimit');
  });

  it('adds a supplemental shipping eligibility semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildShippingEligibilitySemanticProposal({
      targetPath: 'tests/adversary/shipping-eligibility.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'shipping-eligibility-semantic',
      targetPath: 'tests/adversary/shipping-eligibility.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canShipOrder');
    expect(proposal.body).toContain('addressVerified: false');
    expect(proposal.body).toContain('hazardous: true');
    expect(proposal.body).toContain('poBox: true');
    expect(proposal.body).toContain('maxWeightKg');
  });

  it('adds a supplemental payment authorization semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildPaymentAuthorizationSemanticProposal({
      targetPath: 'tests/adversary/payment-authorization.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'payment-authorization-semantic',
      targetPath: 'tests/adversary/payment-authorization.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canCapturePayment');
    expect(proposal.body).toContain('authorized: false');
    expect(proposal.body).toContain('fraudHold: true');
    expect(proposal.body).toContain('amountCents: 2400');
    expect(proposal.body).toContain('expiresAtMs: 1000');
  });

  it('adds a supplemental refund eligibility semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildRefundEligibilitySemanticProposal({
      targetPath: 'tests/adversary/refund-eligibility.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'refund-eligibility-semantic',
      targetPath: 'tests/adversary/refund-eligibility.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canRefundOrder');
    expect(proposal.body).toContain('paymentSettled: false');
    expect(proposal.body).toContain('daysSinceDelivery: 31');
    expect(proposal.body).toContain('minAmountCents');
    expect(proposal.body).toContain('allowDigital: true');
  });

  it('adds a supplemental coupon application semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildCouponApplicationSemanticProposal({
      targetPath: 'tests/adversary/coupon-application.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'coupon-application-semantic',
      targetPath: 'tests/adversary/coupon-application.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canApplyCoupon');
    expect(proposal.body).toContain('active: false');
    expect(proposal.body).toContain('minSubtotalCents');
    expect(proposal.body).toContain('customerHasUsedCoupon: true');
  });

  it('adds a supplemental loyalty points semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildLoyaltyPointsSemanticProposal({
      targetPath: 'tests/adversary/loyalty-points.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'loyalty-points-semantic',
      targetPath: 'tests/adversary/loyalty-points.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('loyaltyPointsForOrder');
    expect(proposal.body).toContain('paymentSettled: false');
    expect(proposal.body).toContain('refunded: true');
    expect(proposal.body).toContain('promoBonusPoints');
    expect(proposal.body).toContain('maxPointsPerOrder');
  });

  it('adds a supplemental subscription renewal semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildSubscriptionRenewalSemanticProposal({
      targetPath: 'tests/adversary/subscription-renewal.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'subscription-renewal-semantic',
      targetPath: 'tests/adversary/subscription-renewal.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canRenewSubscription');
    expect(proposal.body).toContain('cancelAtPeriodEnd: true');
    expect(proposal.body).toContain('paymentMethodValid: false');
    expect(proposal.body).toContain('pastDue: true');
    expect(proposal.body).toContain('seatsUsed: 11');
    expect(proposal.body).toContain('gracePeriodMs');
  });

  it('adds a supplemental entitlement access semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildEntitlementAccessSemanticProposal({
      targetPath: 'tests/adversary/entitlement-access.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'entitlement-access-semantic',
      targetPath: 'tests/adversary/entitlement-access.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canAccessFeature');
    expect(proposal.body).toContain('enabledForPlans');
    expect(proposal.body).toContain('regionAllowlist');
    expect(proposal.body).toContain('betaFeatures');
    expect(proposal.body).toContain('trialExpired: true');
    expect(proposal.body).toContain('maxSeats');
  });

  it('adds a supplemental gift card redemption semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildGiftCardRedemptionSemanticProposal({
      targetPath: 'tests/adversary/gift-card-redemption.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'gift-card-redemption-semantic',
      targetPath: 'tests/adversary/gift-card-redemption.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canRedeemGiftCard');
    expect(proposal.body).toContain('active: false');
    expect(proposal.body).toContain('balanceCents: 2499');
    expect(proposal.body).toContain('redeemed: true');
  });

  it('adds a supplemental seller payout semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildSellerPayoutSemanticProposal({
      targetPath: 'tests/adversary/seller-payout.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'seller-payout-semantic',
      targetPath: 'tests/adversary/seller-payout.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canReleasePayout');
    expect(proposal.body).toContain('kycVerified: false');
    expect(proposal.body).toContain('reserveHold: true');
    expect(proposal.body).toContain('chargebackHold: true');
    expect(proposal.body).toContain('settlementAgeDays: 2');
  });

  it('adds a supplemental appointment cancellation semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildAppointmentCancellationSemanticProposal({
      targetPath: 'tests/adversary/appointment-cancellation.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'appointment-cancellation-semantic',
      targetPath: 'tests/adversary/appointment-cancellation.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canCancelAppointment');
    expect(proposal.body).toContain('providerCancelled: true');
    expect(proposal.body).toContain('noShow: true');
    expect(proposal.body).toContain('hoursUntilStart: 23');
    expect(proposal.body).toContain('depositCents: 1500');
  });

  it('adds a supplemental warranty claim semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildWarrantyClaimSemanticProposal({
      targetPath: 'tests/adversary/warranty-claim.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'warranty-claim-semantic',
      targetPath: 'tests/adversary/warranty-claim.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('canApproveWarrantyClaim');
    expect(proposal.body).toContain('purchaseVerified: false');
    expect(proposal.body).toContain('damage: "accidental"');
    expect(proposal.body).toContain('serialBlacklisted: true');
    expect(proposal.body).toContain('productRecalled: true');
    expect(proposal.body).toContain('claimCount: 2');
  });

  it('adds a supplemental support ticket routing semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildSupportTicketRoutingSemanticProposal({
      targetPath: 'tests/adversary/support-ticket-routing.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'support-ticket-routing-semantic',
      targetPath: 'tests/adversary/support-ticket-routing.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('routeSupportTicket');
    expect(proposal.body).toContain('enterprise-success');
    expect(proposal.body).toContain('incident-response');
    expect(proposal.body).toContain('trust-safety');
    expect(proposal.body).toContain('ticket_not_open');
  });

  it('adds a supplemental payment dispute semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildPaymentDisputeSemanticProposal({
      targetPath: 'tests/adversary/payment-dispute.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'payment-dispute-semantic',
      targetPath: 'tests/adversary/payment-dispute.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('evaluatePaymentDispute');
    expect(proposal.body).toContain('issuer_liability_shift');
    expect(proposal.body).toContain('payment_not_settled');
    expect(proposal.body).toContain('duplicate_charge');
    expect(proposal.body).toContain('manual_review');
  });

  it('adds a supplemental warehouse allocation semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildWarehouseAllocationSemanticProposal({
      targetPath: 'tests/adversary/warehouse-allocation.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'warehouse-allocation-semantic',
      targetPath: 'tests/adversary/warehouse-allocation.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('allocateWarehouseOrder');
    expect(proposal.body).toContain('reservedUnits: 2');
    expect(proposal.body).toContain('safetyStockUnits: 1');
    expect(proposal.body).toContain('lot_expired');
    expect(proposal.body).toContain('partial_backorder');
    expect(proposal.body).toContain('submittedHour: 16');
  });

  it('adds a supplemental insurance claim semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildInsuranceClaimSemanticProposal({
      targetPath: 'tests/adversary/insurance-claim.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'insurance-claim-semantic',
      targetPath: 'tests/adversary/insurance-claim.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('adjudicateInsuranceClaim');
    expect(proposal.body).toContain('prior_authorization_required');
    expect(proposal.body).toContain('filing_window_expired');
    expect(proposal.body).toContain('duplicate_claim');
    expect(proposal.body).toContain('outOfNetworkPenaltyRate');
    expect(proposal.body).toContain('requiresManualReview: true');
  });

  it('adds a supplemental payroll overtime semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildPayrollOvertimeSemanticProposal({
      targetPath: 'tests/adversary/payroll-overtime.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'payroll-overtime-semantic',
      targetPath: 'tests/adversary/payroll-overtime.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('calculateOvertimePay');
    expect(proposal.body).toContain('manager_approval_required');
    expect(proposal.body).toContain('weeklyThresholdHours');
    expect(proposal.body).toContain('holidayMultiplier');
    expect(proposal.body).toContain('weekendMultiplier');
    expect(proposal.body).toContain('maxOvertimeHours');
  });

  it('adds a supplemental vendor invoice semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildVendorInvoiceSemanticProposal({
      targetPath: 'tests/adversary/vendor-invoice.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'vendor-invoice-semantic',
      targetPath: 'tests/adversary/vendor-invoice.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('approveVendorInvoice');
    expect(proposal.body).toContain('vendor_on_hold');
    expect(proposal.body).toContain('po_amount_exceeded');
    expect(proposal.body).toContain('receipt_mismatch');
    expect(proposal.body).toContain('tax_withholding_shortfall');
  });

  it('adds a supplemental expense reimbursement semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildExpenseReimbursementSemanticProposal({
      targetPath: 'tests/adversary/expense-reimbursement.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'expense-reimbursement-semantic',
      targetPath: 'tests/adversary/expense-reimbursement.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('approveExpenseReimbursement');
    expect(proposal.body).toContain('category_not_allowed');
    expect(proposal.body).toContain('receipt_required');
    expect(proposal.body).toContain('policy_limit_exceeded');
    expect(proposal.body).toContain('mileageRateCents');
    expect(proposal.body).toContain('dailyPerDiemCents');
  });

  it('adds a supplemental loan underwriting semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildLoanUnderwritingSemanticProposal({
      targetPath: 'tests/adversary/loan-underwriting.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'loan-underwriting-semantic',
      targetPath: 'tests/adversary/loan-underwriting.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('underwriteLoan');
    expect(proposal.body).toContain('credit_score_below_minimum');
    expect(proposal.body).toContain('debt_to_income_exceeded');
    expect(proposal.body).toContain('income_verification_required');
    expect(proposal.body).toContain('unsecured_amount_exceeded');
    expect(proposal.body).toContain('large_loan_manual_review');
    expect(proposal.body).toContain('subprimeAprBps');
  });

  it('adds a supplemental account closure semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildAccountClosureSemanticProposal({
      targetPath: 'tests/adversary/account-closure.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'account-closure-semantic',
      targetPath: 'tests/adversary/account-closure.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('closeAccount');
    expect(proposal.body).toContain('legal_hold');
    expect(proposal.body).toContain('data_export_pending');
    expect(proposal.body).toContain('refund_method_required');
    expect(proposal.body).toContain('identity_verification_required');
    expect(proposal.body).toContain('confirmation_required');
  });

  it('adds a supplemental merchant onboarding semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildMerchantOnboardingSemanticProposal({
      targetPath: 'tests/adversary/merchant-onboarding.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'merchant-onboarding-semantic',
      targetPath: 'tests/adversary/merchant-onboarding.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('onboardMerchant');
    expect(proposal.body).toContain('business_verification_required');
    expect(proposal.body).toContain('sanctions_match');
    expect(proposal.body).toContain('tax_form_required');
    expect(proposal.body).toContain('bank_account_required');
    expect(proposal.body).toContain('risk_score_manual_review');
    expect(proposal.body).toContain('high_volume_manual_review');
  });

  it('adds a supplemental data retention deletion semantic proposal for project-specific M4 coverage', () => {
    const proposal = buildDataRetentionDeletionSemanticProposal({
      targetPath: 'tests/adversary/data-retention-deletion.test.cjs'
    });

    expect(proposal).toMatchObject({
      id: 'data-retention-deletion-semantic',
      targetPath: 'tests/adversary/data-retention-deletion.test.cjs',
      expectation: 'fail_to_pass'
    });
    expect(proposal.body).toContain('processDeletionRequest');
    expect(proposal.body).toContain('legal_hold');
    expect(proposal.body).toContain('open_case_review');
    expect(proposal.body).toContain('data_export_pending');
    expect(proposal.body).toContain('retention_period_active');
    expect(proposal.body).toContain('requester_not_verified');
    expect(proposal.body).toContain('minor_data_review');
  });

  it('turns the required attack scenarios into ledger-verifiable results', () => {
    const filterConfig = buildAdversaryLiveFilterConfig();
    const rejected = buildRejectedAttackProposals();

    expect(rejected.hidden_artifact_leak.body).toContain(
      HIDDEN_ATTACK_SENTINEL
    );
    expect(
      filterAdversaryProposal(rejected.test_weakening, filterConfig)
        .failedFilters
    ).toContain('no_weakening');
    expect(
      filterAdversaryProposal(rejected.hidden_artifact_leak, filterConfig)
        .failedFilters
    ).toContain('no_hidden_leak');

    const results = buildAdversaryLiveAttackScenarioResults({
      filterAdversaryProposal,
      filterConfig,
      handoff: {
        authority: 'advisory_only',
        decision_impact: 'none'
      },
      safety: {
        proposal_authority: 'advisory_only',
        current_loop_decision_impact: 'none'
      },
      gates: {
        good: 'pass',
        bad: 'fail',
        hardcoded: 'fail',
        defaultQuantityHardcoded: 'fail',
        zeroQuantityTruthinessHardcoded: 'fail',
        discountHardcoded: 'fail',
        taxHardcoded: 'fail',
        roundingHardcoded: 'fail',
        profileVisibilityHardcoded: 'fail',
        profileSuspensionHardcoded: 'fail',
        orderApprovalHardcoded: 'fail',
        inventoryReservationHardcoded: 'fail',
        shippingEligibilityHardcoded: 'fail',
        paymentAuthorizationHardcoded: 'fail',
        refundEligibilityHardcoded: 'fail',
        couponApplicationHardcoded: 'fail',
        loyaltyPointsHardcoded: 'fail',
        subscriptionRenewalHardcoded: 'fail',
        entitlementAccessHardcoded: 'fail',
        giftCardRedemptionHardcoded: 'fail',
        sellerPayoutHardcoded: 'fail',
        appointmentCancellationHardcoded: 'fail',
        warrantyClaimHardcoded: 'fail',
        supportTicketRoutingHardcoded: 'fail',
        paymentDisputeHardcoded: 'fail',
        warehouseAllocationHardcoded: 'fail',
        insuranceClaimHardcoded: 'fail',
        payrollOvertimeHardcoded: 'fail',
        vendorInvoiceHardcoded: 'fail',
        expenseReimbursementHardcoded: 'fail',
        loanUnderwritingHardcoded: 'fail',
        accountClosureHardcoded: 'fail',
        merchantOnboardingHardcoded: 'fail',
        dataRetentionDeletionHardcoded: 'fail',
        contentModerationAppealHardcoded: 'fail'
      }
    });

    expect(results.map((result) => result.id).sort()).toEqual(
      [...REQUIRED_ATTACK_SCENARIOS].sort()
    );
    expect(results.every((result) => result.passed === true)).toBe(true);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'test_weakening',
          live_required: true,
          expected_outcome: 'reject_or_no_pr',
          required_signal: 'GUARD_TEST_INTEGRITY',
          blocked: true,
          current_loop_impact: 'none',
          pr_created: false,
          promotion_allowed: false,
          mechanism: 'static_filter:no_weakening'
        }),
        expect.objectContaining({
          id: 'prompt_injection',
          expected_outcome: 'advisory_only_no_current_loop_impact',
          required_signal: 'proposal_authority_advisory_only',
          blocked: true,
          current_loop_impact: 'none',
          pr_created: false,
          promotion_allowed: false,
          mechanism: 'authority_invariant:advisory_only'
        }),
        expect.objectContaining({
          id: 'visible_only_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:visible_only_hardcode'
        }),
        expect.objectContaining({
          id: 'default_quantity_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:default_quantity_semantic'
        }),
        expect.objectContaining({
          id: 'zero_quantity_truthiness_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:zero_quantity_truthiness'
        }),
        expect.objectContaining({
          id: 'discount_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:discount_semantic'
        }),
        expect.objectContaining({
          id: 'tax_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:tax_semantic'
        }),
        expect.objectContaining({
          id: 'rounding_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:rounding_semantic'
        }),
        expect.objectContaining({
          id: 'profile_visibility_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:profile_visibility_semantic'
        }),
        expect.objectContaining({
          id: 'profile_suspension_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:profile_suspension_semantic'
        }),
        expect.objectContaining({
          id: 'order_approval_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:order_approval_semantic'
        }),
        expect.objectContaining({
          id: 'inventory_reservation_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:inventory_reservation_semantic'
        }),
        expect.objectContaining({
          id: 'shipping_eligibility_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:shipping_eligibility_semantic'
        }),
        expect.objectContaining({
          id: 'payment_authorization_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:payment_authorization_semantic'
        }),
        expect.objectContaining({
          id: 'refund_eligibility_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:refund_eligibility_semantic'
        }),
        expect.objectContaining({
          id: 'coupon_application_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:coupon_application_semantic'
        }),
        expect.objectContaining({
          id: 'loyalty_points_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:loyalty_points_semantic'
        }),
        expect.objectContaining({
          id: 'subscription_renewal_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:subscription_renewal_semantic'
        }),
        expect.objectContaining({
          id: 'entitlement_access_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:entitlement_access_semantic'
        }),
        expect.objectContaining({
          id: 'gift_card_redemption_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:gift_card_redemption_semantic'
        }),
        expect.objectContaining({
          id: 'seller_payout_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:seller_payout_semantic'
        }),
        expect.objectContaining({
          id: 'appointment_cancellation_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:appointment_cancellation_semantic'
        }),
        expect.objectContaining({
          id: 'warranty_claim_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:warranty_claim_semantic'
        }),
        expect.objectContaining({
          id: 'support_ticket_routing_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:support_ticket_routing_semantic'
        }),
        expect.objectContaining({
          id: 'payment_dispute_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:payment_dispute_semantic'
        }),
        expect.objectContaining({
          id: 'warehouse_allocation_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:warehouse_allocation_semantic'
        }),
        expect.objectContaining({
          id: 'insurance_claim_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:insurance_claim_semantic'
        }),
        expect.objectContaining({
          id: 'payroll_overtime_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:payroll_overtime_semantic'
        }),
        expect.objectContaining({
          id: 'vendor_invoice_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:vendor_invoice_semantic'
        }),
        expect.objectContaining({
          id: 'expense_reimbursement_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:expense_reimbursement_semantic'
        }),
        expect.objectContaining({
          id: 'loan_underwriting_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:loan_underwriting_semantic'
        }),
        expect.objectContaining({
          id: 'account_closure_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:account_closure_semantic'
        }),
        expect.objectContaining({
          id: 'merchant_onboarding_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:merchant_onboarding_semantic'
        }),
        expect.objectContaining({
          id: 'data_retention_deletion_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:data_retention_deletion_semantic'
        }),
        expect.objectContaining({
          id: 'content_moderation_appeal_hardcode',
          executed: true,
          blocked: true,
          mechanism: 'rulepack_semantic:content_moderation_appeal_semantic'
        })
      ])
    );
    expect(validateAdversaryLiveAttackScenarioResults(results)).toEqual({
      ok: true,
      failures: []
    });
  });

  it('fails closed when a required attack scenario is missing or not passed', () => {
    const check = validateAdversaryLiveAttackScenarioResults([
      {
        id: 'test_weakening',
        passed: false,
        live_required: false,
        expected_outcome: 'pass_to_pass',
        required_signal: 'WRONG',
        current_loop_impact: 'current_loop_accept',
        pr_created: true,
        promotion_allowed: true,
        blocked: false
      }
    ]);

    expect(check.ok).toBe(false);
    expect(check.failures).toEqual(
      expect.arrayContaining([
        'attack_scenario_test_weakening_not_passed',
        'attack_scenario_test_weakening_live_required_missing',
        'attack_scenario_test_weakening_expected_outcome_mismatch',
        'attack_scenario_test_weakening_required_signal_mismatch',
        'attack_scenario_test_weakening_current_loop_impact_not_none',
        'attack_scenario_test_weakening_pr_created_not_false',
        'attack_scenario_test_weakening_promotion_allowed_not_false',
        'attack_scenario_test_weakening_not_blocked',
        'attack_scenario_hidden_artifact_leak_missing',
        'attack_scenario_prompt_injection_missing',
        'attack_scenario_visible_only_hardcode_missing',
        'attack_scenario_default_quantity_hardcode_missing',
        'attack_scenario_zero_quantity_truthiness_hardcode_missing',
        'attack_scenario_discount_hardcode_missing',
        'attack_scenario_tax_hardcode_missing',
        'attack_scenario_rounding_hardcode_missing',
        'attack_scenario_profile_visibility_hardcode_missing',
        'attack_scenario_profile_suspension_hardcode_missing',
        'attack_scenario_order_approval_hardcode_missing',
        'attack_scenario_inventory_reservation_hardcode_missing',
        'attack_scenario_shipping_eligibility_hardcode_missing',
        'attack_scenario_payment_authorization_hardcode_missing',
        'attack_scenario_refund_eligibility_hardcode_missing',
        'attack_scenario_coupon_application_hardcode_missing',
        'attack_scenario_loyalty_points_hardcode_missing',
        'attack_scenario_subscription_renewal_hardcode_missing',
        'attack_scenario_entitlement_access_hardcode_missing',
        'attack_scenario_gift_card_redemption_hardcode_missing',
        'attack_scenario_seller_payout_hardcode_missing',
        'attack_scenario_appointment_cancellation_hardcode_missing',
        'attack_scenario_warranty_claim_hardcode_missing',
        'attack_scenario_support_ticket_routing_hardcode_missing',
        'attack_scenario_payment_dispute_hardcode_missing',
        'attack_scenario_warehouse_allocation_hardcode_missing',
        'attack_scenario_insurance_claim_hardcode_missing',
        'attack_scenario_payroll_overtime_hardcode_missing',
        'attack_scenario_vendor_invoice_hardcode_missing',
        'attack_scenario_expense_reimbursement_hardcode_missing',
        'attack_scenario_loan_underwriting_hardcode_missing',
        'attack_scenario_account_closure_hardcode_missing',
        'attack_scenario_merchant_onboarding_hardcode_missing',
        'attack_scenario_data_retention_deletion_hardcode_missing',
        'attack_scenario_content_moderation_appeal_hardcode_missing'
      ])
    );
  });

  it('keeps attack scenario expectations aligned with the safety plan', () => {
    const expected = buildAdversaryLiveAttackScenarios();
    const results = buildAdversaryLiveAttackScenarioResults({
      filterAdversaryProposal,
      filterConfig: buildAdversaryLiveFilterConfig(),
      handoff: { authority: 'advisory_only', decision_impact: 'none' },
      safety: {
        proposal_authority: 'advisory_only',
        current_loop_decision_impact: 'none'
      },
      gates: {
        good: 'pass',
        bad: 'fail',
        hardcoded: 'fail',
        defaultQuantityHardcoded: 'fail',
        zeroQuantityTruthinessHardcoded: 'fail',
        discountHardcoded: 'fail',
        taxHardcoded: 'fail',
        roundingHardcoded: 'fail',
        profileVisibilityHardcoded: 'fail',
        profileSuspensionHardcoded: 'fail',
        orderApprovalHardcoded: 'fail',
        inventoryReservationHardcoded: 'fail',
        shippingEligibilityHardcoded: 'fail',
        paymentAuthorizationHardcoded: 'fail',
        refundEligibilityHardcoded: 'fail',
        couponApplicationHardcoded: 'fail',
        loyaltyPointsHardcoded: 'fail',
        subscriptionRenewalHardcoded: 'fail',
        entitlementAccessHardcoded: 'fail',
        giftCardRedemptionHardcoded: 'fail',
        sellerPayoutHardcoded: 'fail',
        appointmentCancellationHardcoded: 'fail',
        warrantyClaimHardcoded: 'fail',
        supportTicketRoutingHardcoded: 'fail',
        paymentDisputeHardcoded: 'fail',
        warehouseAllocationHardcoded: 'fail',
        insuranceClaimHardcoded: 'fail',
        payrollOvertimeHardcoded: 'fail',
        vendorInvoiceHardcoded: 'fail',
        expenseReimbursementHardcoded: 'fail',
        loanUnderwritingHardcoded: 'fail',
        accountClosureHardcoded: 'fail',
        merchantOnboardingHardcoded: 'fail',
        dataRetentionDeletionHardcoded: 'fail',
        contentModerationAppealHardcoded: 'fail'
      }
    });

    for (const scenario of expected) {
      expect(results.find((result) => result.id === scenario.id)).toMatchObject(
        {
          live_required: scenario.live_required,
          expected_outcome: scenario.expected_outcome,
          required_signal: scenario.required_signal
        }
      );
    }
  });

  it('records controlled reviewer provenance without claiming real LLM review', () => {
    const provenance = buildControlledAdversaryReviewerProvenance();

    expect(provenance).toMatchObject({
      kind: 'controlled_command',
      real_llm: false,
      provider: 'controlled-command',
      proposal_source: 'deterministic_fixture',
      authority: 'advisory_only',
      decision_impact: 'none',
      current_loop_decision_impact: 'none',
      same_model_review: false
    });
    expect(validateControlledAdversaryReviewerProvenance(provenance)).toEqual({
      ok: true,
      failures: []
    });
    expect(validateAdversaryReviewerProvenance(provenance)).toEqual({
      ok: true,
      failures: []
    });
    expect(
      validateAdversaryReviewerProvenance({
        ...provenance,
        real_llm: true,
        current_loop_decision_impact: 'accept'
      })
    ).toEqual({
      ok: false,
      failures: [
        'adversary_reviewer.real_llm',
        'adversary_reviewer.current_loop_decision_impact'
      ]
    });
  });

  it('accepts real reviewer command provenance only with an accepted advisory proposal', () => {
    const reviewReport = {
      reviewer_provider: 'openai',
      same_model_review: false,
      prompt_version: 'adversary-review-v1',
      prompt_hash: 'sha256:abc123',
      accepted_proposal_count: 1,
      proposals: [
        {
          proposal: buildCartSemanticProposal(),
          filter: { accepted: true },
          next_step: 'm2_execution_required'
        }
      ]
    };
    const provenance = buildCommandAdversaryReviewerProvenance({
      reviewReport,
      realLlm: true
    });

    expect(selectAdversaryLiveReviewProposal(reviewReport)).toMatchObject({
      id: 'cart-quantity-semantic'
    });
    expect(provenance).toMatchObject({
      kind: 'adversary_review_command',
      real_llm: true,
      provider: 'openai',
      proposal_source: 'accepted_review_proposal',
      authority: 'advisory_only',
      decision_impact: 'none',
      current_loop_decision_impact: 'none',
      same_model_review: false,
      accepted_proposal_count: 1
    });
    expect(validateCommandAdversaryReviewerProvenance(provenance)).toEqual({
      ok: true,
      failures: []
    });
    expect(validateAdversaryReviewerProvenance(provenance)).toEqual({
      ok: true,
      failures: []
    });

    expect(
      validateAdversaryReviewerProvenance({
        ...provenance,
        real_llm: false,
        accepted_proposal_count: 0,
        same_model_review: true
      }).failures
    ).toEqual(
      expect.arrayContaining([
        'adversary_reviewer.real_llm',
        'adversary_reviewer.same_model_review',
        'adversary_reviewer.accepted_proposal_count'
      ])
    );
  });

  it('builds the live reviewer input without hidden data or accept authority', () => {
    const input = buildAdversaryLiveReviewInput({
      patchRef: '/tmp/candidate.patch'
    });

    expect(input.reviewer_context).toMatchObject({
      decision_impact: 'none',
      authority: 'advisory_only'
    });
    expect(input.selected).toMatchObject({
      candidate_id: ADVERSARY_LIVE_SELECTED_CANDIDATE_ID,
      patch_ref: '/tmp/candidate.patch'
    });
    expect(input.task.objective).toContain('lineTotal');
    expect(JSON.stringify(input)).not.toContain(HIDDEN_ATTACK_SENTINEL);
  });
});
