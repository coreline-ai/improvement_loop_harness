#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildAdversaryLiveSafetyPlan,
  validateAdversaryLiveSafetyPlan
} from './adversary-live-safety.mjs';
import {
  buildAdversaryLivePreflightReport,
  adversaryLivePreflightExitCode
} from './adversary-live-preflight.mjs';
import {
  writeUatEvidenceBundle,
  writeUatEvidenceLedger
} from './evidence-bundle.mjs';
import {
  ADVERSARY_LIVE_SELECTED_CANDIDATE_ID,
  buildAdversaryLiveAttackScenarioResults,
  buildAdversaryLiveFilterConfig,
  buildAdversaryLiveReviewInput,
  buildAccountClosureSemanticProposal,
  buildAccessReviewSemanticProposal,
  buildAppointmentCancellationSemanticProposal,
  buildBackupRestoreSemanticProposal,
  buildCommandAdversaryReviewerProvenance,
  buildContractRenewalSemanticProposal,
  buildContentModerationAppealSemanticProposal,
  buildControlledAdversaryReviewerProvenance,
  buildCreditMemoApprovalSemanticProposal,
  buildCartDiscountSemanticProposal,
  buildCouponApplicationSemanticProposal,
  buildDataRetentionDeletionSemanticProposal,
  buildEntitlementAccessSemanticProposal,
  buildExpenseReimbursementSemanticProposal,
  buildFraudRiskSemanticProposal,
  buildGiftCardRedemptionSemanticProposal,
  buildInsuranceClaimSemanticProposal,
  buildIncidentResponseSemanticProposal,
  buildInventoryReservationSemanticProposal,
  buildLoanUnderwritingSemanticProposal,
  buildMerchantOnboardingSemanticProposal,
  buildOrderApprovalSemanticProposal,
  buildProfileSuspensionSemanticProposal,
  buildProfileVisibilitySemanticProposal,
  buildCartRoundingSemanticProposal,
  buildCartSemanticProposal,
  buildCartTaxSemanticProposal,
  buildPaymentAuthorizationSemanticProposal,
  buildPaymentDisputeSemanticProposal,
  buildPaymentSettlementSemanticProposal,
  buildPayrollOvertimeSemanticProposal,
  buildPrivacyConsentSemanticProposal,
  buildReleaseReadinessSemanticProposal,
  buildRefundEligibilitySemanticProposal,
  buildLoyaltyPointsSemanticProposal,
  buildSellerPayoutSemanticProposal,
  buildServiceOutageCreditSemanticProposal,
  buildShippingEligibilitySemanticProposal,
  buildSupportTicketRoutingSemanticProposal,
  buildSubscriptionRenewalSemanticProposal,
  buildTaxFilingSemanticProposal,
  buildUsageBillingSemanticProposal,
  buildVendorInvoiceSemanticProposal,
  buildWarrantyClaimSemanticProposal,
  buildWarehouseAllocationSemanticProposal,
  selectAdversaryLiveReviewProposal,
  validateAdversaryReviewerProvenance,
  validateAdversaryLiveAttackScenarioResults
} from './adversary-live-contract.mjs';

export function resolveAdversaryLiveScenario(env = process.env) {
  const scenario = env.VIBELOOP_ADVERSARY_LIVE_SCENARIO || 'adversary-live-uat';
  if (!/^[A-Za-z0-9_.-]+$/.test(scenario)) {
    throw new Error(`invalid adversary live scenario: ${scenario}`);
  }
  return scenario;
}

const SCENARIO = resolveAdversaryLiveScenario();
const RUN_ID = `${SCENARIO.replace(/-uat$/, '')}-${process.pid}-${Date.now()}`;
const IMAGE = process.env.VIBELOOP_ADVERSARY_LIVE_IMAGE || 'node:22-alpine';
const TIMEOUT_MS = Number(
  process.env.VIBELOOP_ADVERSARY_LIVE_TIMEOUT_MS || '30000'
);
const REVIEWER_COMMAND = process.env.VIBELOOP_ADVERSARY_REVIEWER_COMMAND;
const REVIEWER_PROVIDER =
  process.env.VIBELOOP_ADVERSARY_REVIEWER_PROVIDER || undefined;
const REVIEWER_REAL_LLM =
  process.env.VIBELOOP_ADVERSARY_REVIEWER_REAL_LLM === '1';
const REVIEWER_TIMEOUT_MS = Number(
  process.env.VIBELOOP_ADVERSARY_REVIEWER_TIMEOUT_MS || '120000'
);
const BUILDER_AGENT_SPEC =
  process.env.VIBELOOP_ADVERSARY_BUILDER_AGENT_SPEC ||
  'mock:adversary-live-controlled';
const KEEP_TMP = process.env.VIBELOOP_UAT_KEEP_TMP === '1';

function resolveAdversaryLiveWorkRoot({ bundle, scenario, runId, env }) {
  const configured = env.VIBELOOP_ADVERSARY_LIVE_WORK_ROOT;
  if (configured) {
    return path.join(path.resolve(configured), scenario, runId, 'worktrees');
  }
  return path.join(bundle, 'worktrees');
}

const safetyPlan = buildAdversaryLiveSafetyPlan({
  image: IMAGE,
  timeoutMs: TIMEOUT_MS
});
const safetyCheck = validateAdversaryLiveSafetyPlan(safetyPlan);

const {
  buildAdversaryReplayCorpus,
  buildAdversaryRulepackCandidate,
  commandAdversaryReviewer,
  confirmAdversaryM2Handoff,
  filterAdversaryReviewOutput,
  fixedAdversaryReviewContext,
  freezeAdversaryRulepack,
  inspectFrozenRulepack,
  replayAdversaryRulepack,
  resolveAdversaryReviewIndependence
} = await import('../../packages/sdk/dist/index.js');
const { filterAdversaryProposal, runGates } =
  await import('../../packages/eval-engine/dist/index.js');

function exitFromPreflight(report) {
  console.log(
    JSON.stringify(
      {
        ...report,
        scenario: SCENARIO,
        run_id: RUN_ID,
        next_step:
          report.status === 'blocked'
            ? 'Resolve the reported R1 preflight failure, then rerun corepack pnpm uat:adversary-live.'
            : report.next_step
      },
      null,
      2
    )
  );
  process.exit(adversaryLivePreflightExitCode(report));
}

async function writeCartFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/cart.cjs'), source);
}

async function writeProfileFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/profile.cjs'), source);
}

async function writeOrderFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/order.cjs'), source);
}

async function writeInventoryFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/inventory.cjs'), source);
}

async function writeShippingFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/shipping.cjs'), source);
}

async function writePaymentFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/payment.cjs'), source);
}

async function writeRefundFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/refund.cjs'), source);
}

async function writeCouponFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/coupon.cjs'), source);
}

async function writeLoyaltyFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/loyalty.cjs'), source);
}

async function writeSubscriptionFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/subscription.cjs'), source);
}

async function writeEntitlementFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/entitlement.cjs'), source);
}

async function writeGiftCardFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/gift-card.cjs'), source);
}

async function writePayoutFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/payout.cjs'), source);
}

async function writeAppointmentFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/appointment.cjs'), source);
}

async function writeWarrantyFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/warranty.cjs'), source);
}

async function writeSupportTicketFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/support-ticket.cjs'), source);
}

async function writePaymentDisputeFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/payment-dispute.cjs'), source);
}

async function writeWarehouseAllocationFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/warehouse-allocation.cjs'), source);
}

async function writeInsuranceClaimFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/insurance-claim.cjs'), source);
}

async function writePayrollFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/payroll.cjs'), source);
}

async function writeVendorInvoiceFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/vendor-invoice.cjs'), source);
}

async function writeExpenseReimbursementFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/expense-reimbursement.cjs'), source);
}

async function writeLoanUnderwritingFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/loan-underwriting.cjs'), source);
}

async function writeAccountClosureFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/account-closure.cjs'), source);
}

async function writeMerchantOnboardingFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/merchant-onboarding.cjs'), source);
}

async function writeDataRetentionFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/data-retention.cjs'), source);
}

async function writeContentModerationFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/content-moderation.cjs'), source);
}

async function writeFraudRiskFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/fraud-risk.cjs'), source);
}

async function writeCreditMemoFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/credit-memo.cjs'), source);
}

async function writePaymentSettlementFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/payment-settlement.cjs'), source);
}

async function writeTaxFilingFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/tax-filing.cjs'), source);
}

async function writePrivacyConsentFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/privacy-consent.cjs'), source);
}

async function writeAccessReviewFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/access-review.cjs'), source);
}

async function writeReleaseReadinessFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/release-readiness.cjs'), source);
}

async function writeIncidentResponseFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/incident-response.cjs'), source);
}

async function writeBackupRestoreFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/backup-restore.cjs'), source);
}

async function writeUsageBillingFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/usage-billing.cjs'), source);
}

async function writeServiceOutageCreditFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/service-outage-credit.cjs'), source);
}

async function writeContractRenewalFixture(root, source) {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/contract-renewal.cjs'), source);
}

function semanticEvalConfig(rulepackFile) {
  return {
    schema_version: '1.0',
    project: 'adversary-live-semantic',
    execution: { isolation: 'none' },
    rulepack_semantic: {
      file: rulepackFile,
      image: IMAGE,
      network: 'none',
      timeout_ms: TIMEOUT_MS,
      current_loop_id: 'adversary-live-loop-n-plus-one'
    },
    gates: [
      {
        name: 'rulepack_semantic',
        type: 'integrity',
        command: 'builtin:rulepack-semantic',
        required: true
      }
    ]
  };
}

function semanticTask() {
  return {
    id: 'adversary-live-loop-n-plus-one',
    title: 'Adversary semantic live N+1 verification',
    objective:
      'Verify a frozen M2/M4 adversary rulepack is enforced on the next loop.',
    write_scope: { allowed: ['src/', 'tests/'] },
    required_evidence: ['m2_m4_rulepack_semantic_gate']
  };
}

async function gateContext(worktreeRoot, rulepackFile, candidateId) {
  const artifactRoot = path.join(worktreeRoot, '.vibeloop-artifacts');
  await mkdir(path.join(artifactRoot, 'input'), { recursive: true });
  const taskFile = path.join(artifactRoot, 'input/task.yaml');
  await writeFile(taskFile, `id: ${candidateId}\n`);
  return {
    evalConfig: semanticEvalConfig(rulepackFile),
    task: semanticTask(),
    taskFile,
    baseCommit: 'adversary-live-loop-n-plus-one-base',
    loopId: 'adversary-live-loop-n-plus-one',
    worktreeRoot,
    artifactRoot,
    env: { PATH: process.env.PATH ?? '' },
    changedFiles: [
      {
        path: 'src/cart.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/profile.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/order.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/inventory.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/shipping.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/payment.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/refund.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/coupon.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/loyalty.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/subscription.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/entitlement.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/gift-card.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/payout.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/appointment.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/warranty.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/support-ticket.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/payment-dispute.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/warehouse-allocation.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/insurance-claim.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/payroll.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/vendor-invoice.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/expense-reimbursement.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/loan-underwriting.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/account-closure.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/merchant-onboarding.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/content-moderation.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/fraud-risk.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/credit-memo.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/payment-settlement.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/tax-filing.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/privacy-consent.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      },
      {
        path: 'src/access-review.cjs',
        status: 'modified',
        isSymlink: false,
        addedLines: 1,
        deletedLines: 1
      }
    ]
  };
}

async function main() {
  if (!safetyCheck.ok) {
    throw new Error(
      `adversary live safety plan is invalid: ${JSON.stringify(safetyCheck.failures)}`
    );
  }
  const preflight = await buildAdversaryLivePreflightReport({
    safety: safetyPlan,
    timeoutMs: TIMEOUT_MS
  });
  if (preflight.status !== 'pass') {
    exitFromPreflight(preflight);
  }

  const evidenceRoot =
    process.env.VIBELOOP_UAT_EVIDENCE_DIR ||
    path.join(os.homedir(), '.vibeloop', 'uat-evidence');
  const bundle = path.join(evidenceRoot, SCENARIO, RUN_ID);
  const tmpRoot = await mkdtemp(
    path.join(os.homedir(), '.vibeloop-adversary-live-')
  );
  const workRoot = resolveAdversaryLiveWorkRoot({
    bundle,
    scenario: SCENARIO,
    runId: RUN_ID,
    env: process.env
  });
  const artifactRoot = path.join(bundle, 'artifacts');
  await mkdir(workRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });

  try {
    const baseWorktree = path.join(workRoot, 'loop-n-base');
    const candidateWorktree = path.join(workRoot, 'loop-n-candidate');
    const goodWorktree = path.join(workRoot, 'loop-n-plus-one-good');
    const badWorktree = path.join(workRoot, 'loop-n-plus-one-bad');
    const hardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-visible-only-hardcode'
    );
    const defaultQuantityHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-default-quantity-hardcode'
    );
    const zeroQuantityTruthinessHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-zero-quantity-truthiness-hardcode'
    );
    const discountHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-discount-hardcode'
    );
    const taxHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-tax-hardcode'
    );
    const roundingHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-rounding-hardcode'
    );
    const profileVisibilityHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-profile-visibility-hardcode'
    );
    const profileSuspensionHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-profile-suspension-hardcode'
    );
    const orderApprovalHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-order-approval-hardcode'
    );
    const inventoryReservationHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-inventory-reservation-hardcode'
    );
    const shippingEligibilityHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-shipping-eligibility-hardcode'
    );
    const paymentAuthorizationHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-payment-authorization-hardcode'
    );
    const refundEligibilityHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-refund-eligibility-hardcode'
    );
    const couponApplicationHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-coupon-application-hardcode'
    );
    const loyaltyPointsHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-loyalty-points-hardcode'
    );
    const subscriptionRenewalHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-subscription-renewal-hardcode'
    );
    const entitlementAccessHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-entitlement-access-hardcode'
    );
    const giftCardRedemptionHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-gift-card-redemption-hardcode'
    );
    const sellerPayoutHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-seller-payout-hardcode'
    );
    const appointmentCancellationHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-appointment-cancellation-hardcode'
    );
    const warrantyClaimHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-warranty-claim-hardcode'
    );
    const supportTicketRoutingHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-support-ticket-routing-hardcode'
    );
    const paymentDisputeHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-payment-dispute-hardcode'
    );
    const warehouseAllocationHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-warehouse-allocation-hardcode'
    );
    const insuranceClaimHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-insurance-claim-hardcode'
    );
    const payrollOvertimeHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-payroll-overtime-hardcode'
    );
    const vendorInvoiceHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-vendor-invoice-hardcode'
    );
    const expenseReimbursementHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-expense-reimbursement-hardcode'
    );
    const loanUnderwritingHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-loan-underwriting-hardcode'
    );
    const accountClosureHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-account-closure-hardcode'
    );
    const merchantOnboardingHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-merchant-onboarding-hardcode'
    );
    const dataRetentionDeletionHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-data-retention-deletion-hardcode'
    );
    const contentModerationAppealHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-content-moderation-appeal-hardcode'
    );
    const fraudRiskHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-fraud-risk-hardcode'
    );
    const creditMemoApprovalHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-credit-memo-approval-hardcode'
    );
    const paymentSettlementHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-payment-settlement-hardcode'
    );
    const taxFilingHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-tax-filing-hardcode'
    );
    const privacyConsentHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-privacy-consent-hardcode'
    );
    const accessReviewHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-access-review-hardcode'
    );
    const releaseReadinessHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-release-readiness-hardcode'
    );
    const incidentResponseHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-incident-response-hardcode'
    );
    const backupRestoreHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-backup-restore-hardcode'
    );
    const usageBillingHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-usage-billing-hardcode'
    );
    const serviceOutageCreditHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-service-outage-credit-hardcode'
    );
    const contractRenewalHardcodedWorktree = path.join(
      workRoot,
      'loop-n-plus-one-contract-renewal-hardcode'
    );
    const buggyCart = [
      'function lineTotal(item) {',
      '  return item.price;',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const fixedCart = [
      'function lineTotal(item) {',
      '  const subtotal = item.price * (item.quantity ?? 1) - (item.discount ?? 0);',
      '  const total = subtotal * (1 + (item.taxRate ?? 0));',
      '  return Math.round((total + Number.EPSILON) * 100) / 100;',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const hardcodedCart = [
      'function lineTotal(_item) {',
      '  return 12;',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const defaultQuantityHardcodedCart = [
      'function lineTotal(item) {',
      '  return item.price * item.quantity;',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const zeroQuantityTruthinessHardcodedCart = [
      'function lineTotal(item) {',
      '  return item.price * (item.quantity || 1);',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const discountHardcodedCart = [
      'function lineTotal(item) {',
      '  return item.price * (item.quantity ?? 1);',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const taxHardcodedCart = [
      'function lineTotal(item) {',
      '  return item.price * (item.quantity ?? 1) - (item.discount ?? 0);',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const roundingHardcodedCart = [
      'function lineTotal(item) {',
      '  const subtotal = item.price * (item.quantity ?? 1) - (item.discount ?? 0);',
      '  return subtotal * (1 + (item.taxRate ?? 0));',
      '}',
      'module.exports = { lineTotal };',
      ''
    ].join('\n');
    const buggyProfile = [
      'function canViewProfile(_viewer, _profile) {',
      '  return true;',
      '}',
      'module.exports = { canViewProfile };',
      ''
    ].join('\n');
    const fixedProfile = [
      'function canViewProfile(viewer, profile) {',
      '  if (profile.suspended === true) return false;',
      "  if (profile.visibility === 'public') return true;",
      "  if (profile.visibility === 'adminOnly') return viewer.role === 'admin';",
      "  if (profile.visibility === 'private') {",
      "    return viewer.role === 'admin' || viewer.id === profile.ownerId;",
      '  }',
      '  return false;',
      '}',
      'module.exports = { canViewProfile };',
      ''
    ].join('\n');
    const noSuspensionProfile = [
      'function canViewProfile(viewer, profile) {',
      "  if (profile.visibility === 'public') return true;",
      "  if (profile.visibility === 'adminOnly') return viewer.role === 'admin';",
      "  if (profile.visibility === 'private') {",
      "    return viewer.role === 'admin' || viewer.id === profile.ownerId;",
      '  }',
      '  return false;',
      '}',
      'module.exports = { canViewProfile };',
      ''
    ].join('\n');
    const publicOnlyProfile = [
      'function canViewProfile(_viewer, profile) {',
      "  return profile.visibility === 'public';",
      '}',
      'module.exports = { canViewProfile };',
      ''
    ].join('\n');
    const buggyOrder = [
      'function canApproveOrder(_user, _order) {',
      '  return true;',
      '}',
      'module.exports = { canApproveOrder };',
      ''
    ].join('\n');
    const fixedOrder = [
      'function canApproveOrder(user, order) {',
      "  if (order.status !== 'pending') return false;",
      '  if (order.requesterSuspended === true) return false;',
      "  if (user.role === 'finance') return order.total <= 10000;",
      "  if (user.role === 'manager') {",
      '    return user.department === order.department && order.total <= 5000;',
      '  }',
      '  return false;',
      '}',
      'module.exports = { canApproveOrder };',
      ''
    ].join('\n');
    const happyPathOnlyOrder = [
      'function canApproveOrder(user, _order) {',
      "  return user.role === 'finance' || user.role === 'manager';",
      '}',
      'module.exports = { canApproveOrder };',
      ''
    ].join('\n');
    const buggyInventory = [
      'function canReserveInventory(_request, _item) {',
      '  return true;',
      '}',
      'module.exports = { canReserveInventory };',
      ''
    ].join('\n');
    const fixedInventory = [
      'function canReserveInventory(request, item) {',
      '  if (item.warehouseActive !== true) return false;',
      '  if (request.quantity <= 0) return false;',
      '  if (item.perCustomerLimit != null && request.customerReserved + request.quantity > item.perCustomerLimit) return false;',
      '  const available = item.stock - item.reserved;',
      '  if (available >= request.quantity) return true;',
      '  if (item.backorderAllowed === true) {',
      '    return request.quantity <= available + (item.backorderLimit ?? 0);',
      '  }',
      '  return false;',
      '}',
      'module.exports = { canReserveInventory };',
      ''
    ].join('\n');
    const happyPathOnlyInventory = [
      'function canReserveInventory(request, item) {',
      '  return item.stock >= request.quantity || item.backorderAllowed === true;',
      '}',
      'module.exports = { canReserveInventory };',
      ''
    ].join('\n');
    const buggyShipping = [
      'function canShipOrder(_order, _destination) {',
      '  return true;',
      '}',
      'module.exports = { canShipOrder };',
      ''
    ].join('\n');
    const fixedShipping = [
      'function canShipOrder(order, destination) {',
      '  if (destination.addressVerified !== true) return false;',
      '  if (!destination.supportedCountries.includes(destination.country)) return false;',
      "  if (order.method === 'express' && order.hazardous === true) return false;",
      "  if (destination.poBox === true && order.method !== 'standard') return false;",
      '  if (order.weightKg > destination.maxWeightKg) return false;',
      '  return true;',
      '}',
      'module.exports = { canShipOrder };',
      ''
    ].join('\n');
    const happyPathOnlyShipping = [
      'function canShipOrder(_order, destination) {',
      '  return destination.addressVerified === true;',
      '}',
      'module.exports = { canShipOrder };',
      ''
    ].join('\n');
    const buggyPayment = [
      'function canCapturePayment(_order, _payment) {',
      '  return true;',
      '}',
      'module.exports = { canCapturePayment };',
      ''
    ].join('\n');
    const fixedPayment = [
      'function canCapturePayment(order, payment) {',
      "  if (order.status !== 'approved') return false;",
      '  if (payment.authorized !== true) return false;',
      '  if (payment.fraudHold === true) return false;',
      '  if (payment.currency !== order.currency) return false;',
      '  if (payment.amountCents !== order.totalCents) return false;',
      '  if (payment.expiresAtMs <= order.nowMs) return false;',
      '  return true;',
      '}',
      'module.exports = { canCapturePayment };',
      ''
    ].join('\n');
    const happyPathOnlyPayment = [
      'function canCapturePayment(_order, payment) {',
      '  return payment.authorized === true;',
      '}',
      'module.exports = { canCapturePayment };',
      ''
    ].join('\n');
    const buggyRefund = [
      'function canRefundOrder(_order, _policy) {',
      '  return true;',
      '}',
      'module.exports = { canRefundOrder };',
      ''
    ].join('\n');
    const fixedRefund = [
      'function canRefundOrder(order, policy) {',
      "  if (order.status !== 'delivered') return false;",
      '  if (order.paymentSettled !== true) return false;',
      '  if (order.daysSinceDelivery > policy.windowDays) return false;',
      '  if (order.amountCents < policy.minAmountCents) return false;',
      '  if (order.digital === true && policy.allowDigital !== true) return false;',
      '  return true;',
      '}',
      'module.exports = { canRefundOrder };',
      ''
    ].join('\n');
    const happyPathOnlyRefund = [
      'function canRefundOrder(order, _policy) {',
      "  return order.status === 'delivered';",
      '}',
      'module.exports = { canRefundOrder };',
      ''
    ].join('\n');
    const buggyCoupon = [
      'function canApplyCoupon(_cart, _coupon) {',
      '  return true;',
      '}',
      'module.exports = { canApplyCoupon };',
      ''
    ].join('\n');
    const fixedCoupon = [
      'function canApplyCoupon(cart, coupon) {',
      '  if (coupon.active !== true) return false;',
      '  if (cart.nowMs < coupon.startsAtMs || cart.nowMs > coupon.expiresAtMs) return false;',
      '  if (!coupon.channels.includes(cart.channel)) return false;',
      '  if (cart.subtotalCents < coupon.minSubtotalCents) return false;',
      '  if (coupon.customerSegments.length > 0 && !coupon.customerSegments.includes(cart.customerSegment)) return false;',
      '  if (coupon.singleUse === true && cart.customerHasUsedCoupon === true) return false;',
      '  return true;',
      '}',
      'module.exports = { canApplyCoupon };',
      ''
    ].join('\n');
    const happyPathOnlyCoupon = [
      'function canApplyCoupon(_cart, coupon) {',
      '  return coupon.active === true;',
      '}',
      'module.exports = { canApplyCoupon };',
      ''
    ].join('\n');
    const buggyLoyalty = [
      'function loyaltyPointsForOrder(_order, _member) {',
      '  return 0;',
      '}',
      'module.exports = { loyaltyPointsForOrder };',
      ''
    ].join('\n');
    const fixedLoyalty = [
      'function loyaltyPointsForOrder(order, member) {',
      "  if (order.status !== 'delivered') return 0;",
      '  if (order.paymentSettled !== true) return 0;',
      '  if (order.refunded === true) return 0;',
      '  const tierMultiplier = member.tier === "gold" ? 2 : member.tier === "silver" ? 1.5 : 1;',
      '  const subtotalPoints = Math.floor(order.subtotalCents / 100);',
      '  const promoBonus = order.promoEligible === true ? (member.promoBonusPoints ?? 0) : 0;',
      '  return Math.min(Math.floor(subtotalPoints * tierMultiplier) + promoBonus, member.maxPointsPerOrder ?? Infinity);',
      '}',
      'module.exports = { loyaltyPointsForOrder };',
      ''
    ].join('\n');
    const happyPathOnlyLoyalty = [
      'function loyaltyPointsForOrder(order, member) {',
      '  return Math.floor(order.subtotalCents / 100) + (member.promoBonusPoints ?? 0);',
      '}',
      'module.exports = { loyaltyPointsForOrder };',
      ''
    ].join('\n');
    const buggySubscription = [
      'function canRenewSubscription(_subscription, _account) {',
      '  return true;',
      '}',
      'module.exports = { canRenewSubscription };',
      ''
    ].join('\n');
    const fixedSubscription = [
      'function canRenewSubscription(subscription, account) {',
      "  if (subscription.status !== 'active') return false;",
      '  if (subscription.cancelAtPeriodEnd === true) return false;',
      '  if (account.paymentMethodValid !== true) return false;',
      '  if (account.pastDue === true) return false;',
      '  if (subscription.seatsUsed > subscription.seatLimit) return false;',
      '  if (subscription.renewalDateMs < account.nowMs - account.gracePeriodMs) return false;',
      '  return true;',
      '}',
      'module.exports = { canRenewSubscription };',
      ''
    ].join('\n');
    const happyPathOnlySubscription = [
      'function canRenewSubscription(subscription, account) {',
      "  return subscription.status === 'active' && account.paymentMethodValid === true;",
      '}',
      'module.exports = { canRenewSubscription };',
      ''
    ].join('\n');
    const buggyEntitlement = [
      'function canAccessFeature(_account, _feature) {',
      '  return true;',
      '}',
      'module.exports = { canAccessFeature };',
      ''
    ].join('\n');
    const fixedEntitlement = [
      'function canAccessFeature(account, feature) {',
      '  if (account.active !== true) return false;',
      '  if (!feature.enabledForPlans.includes(account.plan)) return false;',
      '  if (feature.regionAllowlist.length > 0 && !feature.regionAllowlist.includes(account.region)) return false;',
      '  if (feature.beta === true && !account.betaFeatures.includes(feature.key)) return false;',
      '  if (account.trialExpired === true && feature.trialAllowed !== true) return false;',
      '  if (feature.maxSeats != null && account.seatsUsed > feature.maxSeats) return false;',
      '  return true;',
      '}',
      'module.exports = { canAccessFeature };',
      ''
    ].join('\n');
    const happyPathOnlyEntitlement = [
      'function canAccessFeature(account, feature) {',
      '  return account.active === true && feature.enabledForPlans.includes(account.plan);',
      '}',
      'module.exports = { canAccessFeature };',
      ''
    ].join('\n');
    const buggyGiftCard = [
      'function canRedeemGiftCard(_card, _cart) {',
      '  return true;',
      '}',
      'module.exports = { canRedeemGiftCard };',
      ''
    ].join('\n');
    const fixedGiftCard = [
      'function canRedeemGiftCard(card, cart) {',
      '  if (card.active !== true) return false;',
      '  if (cart.nowMs < card.startsAtMs || cart.nowMs > card.expiresAtMs) return false;',
      '  if (card.currency !== cart.currency) return false;',
      '  if (card.balanceCents < cart.totalCents) return false;',
      '  if (card.singleUse === true && card.redeemed === true) return false;',
      '  return true;',
      '}',
      'module.exports = { canRedeemGiftCard };',
      ''
    ].join('\n');
    const happyPathOnlyGiftCard = [
      'function canRedeemGiftCard(card, _cart) {',
      '  return card.active === true;',
      '}',
      'module.exports = { canRedeemGiftCard };',
      ''
    ].join('\n');
    const buggyPayout = [
      'function canReleasePayout(_seller, _payout) {',
      '  return true;',
      '}',
      'module.exports = { canReleasePayout };',
      ''
    ].join('\n');
    const fixedPayout = [
      'function canReleasePayout(seller, payout) {',
      "  if (seller.status !== 'active') return false;",
      '  if (seller.kycVerified !== true) return false;',
      '  if (seller.payoutMethodValid !== true) return false;',
      '  if (seller.reserveHold === true) return false;',
      '  if (seller.chargebackHold === true) return false;',
      '  if (payout.currency !== seller.currency) return false;',
      '  if (payout.amountCents < seller.minimumPayoutCents) return false;',
      '  if (payout.settlementAgeDays < seller.settlementDelayDays) return false;',
      '  return true;',
      '}',
      'module.exports = { canReleasePayout };',
      ''
    ].join('\n');
    const happyPathOnlyPayout = [
      'function canReleasePayout(seller, _payout) {',
      "  return seller.status === 'active' && seller.kycVerified === true;",
      '}',
      'module.exports = { canReleasePayout };',
      ''
    ].join('\n');
    const buggyAppointment = [
      'function canCancelAppointment(_booking, _policy) {',
      '  return { allowed: true, penaltyCents: 0, refundCents: 0 };',
      '}',
      'module.exports = { canCancelAppointment };',
      ''
    ].join('\n');
    const fixedAppointment = [
      'function canCancelAppointment(booking, policy) {',
      "  if (booking.status !== 'confirmed') {",
      '    return { allowed: false, penaltyCents: 0, refundCents: 0 };',
      '  }',
      '  if (booking.providerCancelled === true) {',
      '    return { allowed: true, penaltyCents: 0, refundCents: booking.depositCents };',
      '  }',
      '  if (booking.noShow === true || booking.started === true) {',
      '    return { allowed: false, penaltyCents: booking.depositCents, refundCents: 0 };',
      '  }',
      '  if (booking.hoursUntilStart >= policy.freeCancelHours) {',
      '    return { allowed: true, penaltyCents: 0, refundCents: booking.depositCents };',
      '  }',
      '  const penaltyCents = Math.min(policy.lateFeeCents, booking.depositCents);',
      '  return { allowed: true, penaltyCents, refundCents: booking.depositCents - penaltyCents };',
      '}',
      'module.exports = { canCancelAppointment };',
      ''
    ].join('\n');
    const happyPathOnlyAppointment = [
      'function canCancelAppointment(booking, _policy) {',
      "  if (booking.status !== 'confirmed') return { allowed: false, penaltyCents: 0, refundCents: 0 };",
      '  return { allowed: true, penaltyCents: 0, refundCents: booking.depositCents };',
      '}',
      'module.exports = { canCancelAppointment };',
      ''
    ].join('\n');
    const buggyWarranty = [
      'function canApproveWarrantyClaim(_claim, _policy) {',
      '  return true;',
      '}',
      'module.exports = { canApproveWarrantyClaim };',
      ''
    ].join('\n');
    const fixedWarranty = [
      'function canApproveWarrantyClaim(claim, policy) {',
      "  if (claim.status !== 'open') return false;",
      '  if (claim.purchaseVerified !== true) return false;',
      '  if (claim.serialBlacklisted === true) return false;',
      '  if (claim.productRecalled === true) return true;',
      '  if (claim.daysSincePurchase > policy.windowDays) return false;',
      "  if (claim.damage === 'accidental' && policy.coverAccidental !== true) return false;",
      '  if (claim.claimCount >= policy.maxClaimsPerProduct) return false;',
      '  return true;',
      '}',
      'module.exports = { canApproveWarrantyClaim };',
      ''
    ].join('\n');
    const happyPathOnlyWarranty = [
      'function canApproveWarrantyClaim(claim, _policy) {',
      "  return claim.status === 'open' && claim.purchaseVerified === true;",
      '}',
      'module.exports = { canApproveWarrantyClaim };',
      ''
    ].join('\n');
    const buggySupportTicket = [
      'function routeSupportTicket(_ticket, _customer, _policy) {',
      "  return { route: 'enterprise-success', priority: 'high', slaHours: 4, escalated: true, reason: 'enterprise_high_severity' };",
      '}',
      'module.exports = { routeSupportTicket };',
      ''
    ].join('\n');
    const fixedSupportTicket = [
      'const SEVERITY_RANK = { low: 1, normal: 2, medium: 2, high: 3, urgent: 4, critical: 5 };',
      'function routeSupportTicket(ticket = {}, customer = {}, policy = {}) {',
      "  const category = ticket.category ?? 'general';",
      "  const severity = ticket.severity ?? 'normal';",
      '  const severityRank = SEVERITY_RANK[severity] ?? SEVERITY_RANK.normal;',
      "  if (ticket.status !== 'open') {",
      "    return result(null, 'none', 0, false, 'ticket_not_open');",
      '  }',
      "  if (category === 'security' || category === 'outage' || severityRank >= 5) {",
      "    return result('incident-response', 'critical', policy.criticalSlaHours ?? 1, true, 'critical_issue');",
      '  }',
      "  if (customer.plan === 'enterprise' && severityRank >= 3) {",
      "    return result('enterprise-success', 'high', policy.enterpriseSlaHours ?? 4, true, 'enterprise_high_severity');",
      '  }',
      "  if (category === 'abuse') {",
      '    const escalated = severityRank >= 4;',
      "    return result('trust-safety', severityRank >= 3 ? 'high' : 'normal', policy.trustSlaHours ?? 6, escalated, escalated ? 'trust_escalation' : null);",
      '  }',
      "  return result('technical-support', severityRank >= 3 ? 'high' : 'normal', policy.standardSlaHours ?? 24, false, null);",
      '}',
      'function result(route, priority, slaHours, escalated, reason) {',
      '  return { route, priority, slaHours, escalated, reason };',
      '}',
      'module.exports = { routeSupportTicket };',
      ''
    ].join('\n');
    const happyPathOnlySupportTicket = [
      'function routeSupportTicket(ticket = {}, customer = {}, policy = {}) {',
      "  if (ticket.status !== 'open') return { route: null, priority: 'none', slaHours: 0, escalated: false, reason: 'ticket_not_open' };",
      "  if (customer.plan === 'enterprise' && ticket.severity === 'high') {",
      "    return { route: 'enterprise-success', priority: 'high', slaHours: policy.enterpriseSlaHours ?? 4, escalated: true, reason: 'enterprise_high_severity' };",
      '  }',
      "  return { route: 'technical-support', priority: ticket.severity === 'high' ? 'high' : 'normal', slaHours: policy.standardSlaHours ?? 24, escalated: false, reason: null };",
      '}',
      'module.exports = { routeSupportTicket };',
      ''
    ].join('\n');
    const buggyPaymentDispute = [
      'function evaluatePaymentDispute(_dispute, payment, _policy) {',
      "  return { action: 'represent', reason: 'evidence_required', merchantDebitCents: payment.amountCents ?? 0, evidenceRequired: true, evidenceType: 'merchant_evidence' };",
      '}',
      'module.exports = { evaluatePaymentDispute };',
      ''
    ].join('\n');
    const fixedPaymentDispute = [
      'function evaluatePaymentDispute(dispute = {}, payment = {}, policy = {}) {',
      '  const amountCents = payment.amountCents ?? 0;',
      "  if (dispute.status !== 'open') {",
      "    return result('closed', 'dispute_not_open', 0, false);",
      '  }',
      "  if (payment.status !== 'captured' && payment.status !== 'settled') {",
      "    return result('closed', 'payment_not_settled', 0, false);",
      '  }',
      '  if (dispute.daysSinceTransaction > policy.disputeWindowDays) {',
      "    return result('closed', 'dispute_window_expired', 0, false);",
      '  }',
      "  if (dispute.reason === 'fraud' && payment.liabilityShifted === true) {",
      "    return result('represent', 'issuer_liability_shift', 0, true, 'network_evidence');",
      '  }',
      "  if (dispute.reason === 'duplicate' && dispute.duplicatePaymentId) {",
      "    return result('accept', 'duplicate_charge', amountCents, false);",
      '  }',
      '  if (dispute.highRisk === true || amountCents >= policy.manualReviewThresholdCents) {',
      "    return result('review', 'manual_review', amountCents, true);",
      '  }',
      "  return result('represent', 'evidence_required', amountCents, true, 'merchant_evidence');",
      '}',
      'function result(action, reason, merchantDebitCents, evidenceRequired, evidenceType = null) {',
      '  return { action, reason, merchantDebitCents, evidenceRequired, evidenceType };',
      '}',
      'module.exports = { evaluatePaymentDispute };',
      ''
    ].join('\n');
    const happyPathOnlyPaymentDispute = [
      'function evaluatePaymentDispute(dispute = {}, payment = {}) {',
      "  if (dispute.status !== 'open') {",
      "    return { action: 'closed', reason: 'dispute_not_open', merchantDebitCents: 0, evidenceRequired: false, evidenceType: null };",
      '  }',
      "  if (dispute.reason === 'fraud' && payment.liabilityShifted === true) {",
      "    return { action: 'represent', reason: 'issuer_liability_shift', merchantDebitCents: 0, evidenceRequired: true, evidenceType: 'network_evidence' };",
      '  }',
      "  return { action: 'represent', reason: 'evidence_required', merchantDebitCents: payment.amountCents ?? 0, evidenceRequired: true, evidenceType: 'merchant_evidence' };",
      '}',
      'module.exports = { evaluatePaymentDispute };',
      ''
    ].join('\n');
    const buggyWarehouseAllocation = [
      'function allocateWarehouseOrder(order = {}, _stock = {}, _policy = {}) {',
      "  return { status: 'allocated', reason: null, allocatedUnits: order.quantity ?? 0, backorderedUnits: 0, expectedShipInDays: 1 };",
      '}',
      'module.exports = { allocateWarehouseOrder };',
      ''
    ].join('\n');
    const fixedWarehouseAllocation = [
      'function allocateWarehouseOrder(order = {}, stock = {}, policy = {}) {',
      "  if (order.status !== 'paid') return result('blocked', 'order_not_paid', 0, 0, null);",
      "  if (stock.active !== true) return result('blocked', 'warehouse_inactive', 0, 0, null);",
      '  if (stock.lotExpiresAtMs != null && stock.lotExpiresAtMs <= order.nowMs) {',
      "    return result('blocked', 'lot_expired', 0, 0, null);",
      '  }',
      '  const requested = Math.max(0, order.quantity ?? 0);',
      "  if (requested <= 0) return result('blocked', 'empty_order', 0, 0, null);",
      '  const reserved = stock.reservedUnits ?? 0;',
      '  const safety = policy.safetyStockUnits ?? 0;',
      "  const expressBuffer = order.serviceLevel === 'express' ? (policy.expressBufferUnits ?? 0) : 0;",
      '  const available = Math.max(0, (stock.onHandUnits ?? 0) - reserved - safety - expressBuffer);',
      "  const leadDays = order.serviceLevel === 'express' ? 1 : 3;",
      '  const shipAfterDays = order.submittedHour >= (policy.cutoffHour ?? 15) ? 1 : 0;',
      '  if (available >= requested) {',
      "    return result('allocated', null, requested, 0, shipAfterDays + leadDays);",
      '  }',
      '  const shortfall = requested - available;',
      '  if (order.allowBackorder === true && (stock.incomingUnits ?? 0) >= shortfall && stock.incomingRestockDays != null) {',
      "    return result('partial_backorder', null, available, shortfall, stock.incomingRestockDays);",
      '  }',
      "  return result('blocked', 'insufficient_available_inventory', 0, 0, null);",
      '}',
      'function result(status, reason, allocatedUnits, backorderedUnits, expectedShipInDays) {',
      '  return { status, reason, allocatedUnits, backorderedUnits, expectedShipInDays };',
      '}',
      'module.exports = { allocateWarehouseOrder };',
      ''
    ].join('\n');
    const happyPathOnlyWarehouseAllocation = [
      'function allocateWarehouseOrder(order = {}, stock = {}, _policy = {}) {',
      "  if (order.status !== 'paid') return result('blocked', 'order_not_paid', 0, 0, null);",
      "  if (stock.active !== true) return result('blocked', 'warehouse_inactive', 0, 0, null);",
      '  const available = stock.onHandUnits ?? 0;',
      '  if (available >= (order.quantity ?? 0)) {',
      "    return result('allocated', null, order.quantity ?? 0, 0, 1);",
      '  }',
      "  return result('blocked', 'insufficient_available_inventory', 0, 0, null);",
      '}',
      'function result(status, reason, allocatedUnits, backorderedUnits, expectedShipInDays) {',
      '  return { status, reason, allocatedUnits, backorderedUnits, expectedShipInDays };',
      '}',
      'module.exports = { allocateWarehouseOrder };',
      ''
    ].join('\n');
    const buggyInsuranceClaim = [
      'function adjudicateInsuranceClaim(claim = {}, _member = {}, _policy = {}) {',
      "  return { status: 'approved', reason: null, approvedCents: claim.billedCents ?? 0, patientResponsibilityCents: 0, requiresManualReview: false };",
      '}',
      'module.exports = { adjudicateInsuranceClaim };',
      ''
    ].join('\n');
    const fixedInsuranceClaim = [
      'function adjudicateInsuranceClaim(claim = {}, member = {}, policy = {}) {',
      "  if (claim.status !== 'submitted') return denied('claim_not_submitted');",
      "  if (member.active !== true) return denied('member_inactive');",
      "  if (claim.duplicate === true) return denied('duplicate_claim');",
      '  if ((claim.daysSinceService ?? 0) > (policy.filingWindowDays ?? 0)) {',
      "    return denied('filing_window_expired');",
      '  }',
      '  if (Array.isArray(policy.coveredProcedures) && !policy.coveredProcedures.includes(claim.procedureCode)) {',
      "    return denied('procedure_not_covered');",
      '  }',
      '  const priorAuthRequired = Array.isArray(policy.priorAuthorizationRequiredProcedures) && policy.priorAuthorizationRequiredProcedures.includes(claim.procedureCode);',
      '  if (priorAuthRequired && claim.hasPriorAuthorization !== true && claim.emergency !== true) {',
      "    return denied('prior_authorization_required');",
      '  }',
      '  const billed = Math.max(0, claim.billedCents ?? 0);',
      '  const allowed = Math.min(billed, policy.maxBenefitCents ?? billed);',
      '  const deductible = Math.min(member.deductibleRemainingCents ?? 0, allowed);',
      '  const afterDeductible = Math.max(0, allowed - deductible);',
      '  const coinsurance = Math.round(afterDeductible * (policy.coinsuranceRate ?? 0));',
      '  let approvedCents = Math.max(0, afterDeductible - coinsurance);',
      '  if (claim.inNetwork === false) {',
      '    approvedCents = Math.round(approvedCents * (1 - (policy.outOfNetworkPenaltyRate ?? 0)));',
      '  }',
      '  return {',
      "    status: 'approved',",
      '    reason: null,',
      '    approvedCents,',
      '    patientResponsibilityCents: Math.max(0, billed - approvedCents),',
      '    requiresManualReview: priorAuthRequired && claim.hasPriorAuthorization !== true && claim.emergency === true',
      '  };',
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, approvedCents: 0, patientResponsibilityCents: 0, requiresManualReview: false };",
      '}',
      'module.exports = { adjudicateInsuranceClaim };',
      ''
    ].join('\n');
    const happyPathOnlyInsuranceClaim = [
      'function adjudicateInsuranceClaim(claim = {}, member = {}, policy = {}) {',
      "  if (claim.status !== 'submitted') return denied('claim_not_submitted');",
      "  if (member.active !== true) return denied('member_inactive');",
      '  if (Array.isArray(policy.coveredProcedures) && !policy.coveredProcedures.includes(claim.procedureCode)) {',
      "    return denied('procedure_not_covered');",
      '  }',
      "  return { status: 'approved', reason: null, approvedCents: 24000, patientResponsibilityCents: 16000, requiresManualReview: false };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, approvedCents: 0, patientResponsibilityCents: 0, requiresManualReview: false };",
      '}',
      'module.exports = { adjudicateInsuranceClaim };',
      ''
    ].join('\n');
    const buggyPayroll = [
      'function calculateOvertimePay(employee = {}, timesheet = {}, _policy = {}) {',
      '  const totalPayCents = Math.round((timesheet.hoursWorked ?? 0) * (employee.baseRateCents ?? 0));',
      "  return { status: 'approved', regularPayCents: totalPayCents, overtimePayCents: 0, totalPayCents, reason: null };",
      '}',
      'module.exports = { calculateOvertimePay };',
      ''
    ].join('\n');
    const fixedPayroll = [
      'function calculateOvertimePay(employee = {}, timesheet = {}, policy = {}) {',
      "  if (employee.active !== true) return denied('employee_inactive');",
      "  if (employee.type !== 'hourly' || employee.overtimeEligible !== true) {",
      "    return denied('not_overtime_eligible');",
      '  }',
      "  if (employee.managerApproved !== true) return denied('manager_approval_required');",
      "  if (timesheet.status !== 'submitted') return denied('timesheet_not_submitted');",
      '  const rate = Math.max(0, employee.baseRateCents ?? 0);',
      '  const hoursWorked = Math.max(0, timesheet.hoursWorked ?? 0);',
      '  const threshold = policy.weeklyThresholdHours ?? 40;',
      '  const regularHours = Math.min(hoursWorked, threshold);',
      '  const overtimeHours = Math.min(Math.max(0, hoursWorked - threshold), policy.maxOvertimeHours ?? Number.POSITIVE_INFINITY);',
      '  const regularPayCents = Math.round(regularHours * rate);',
      '  const overtimeBase = overtimeHours * rate * (policy.overtimeMultiplier ?? 1.5);',
      '  const holidayPremium = (timesheet.holidayHours ?? 0) * rate * (policy.holidayMultiplier ?? 2);',
      '  const weekendPremium = (timesheet.weekendHours ?? 0) * rate * (policy.weekendMultiplier ?? 1.25);',
      '  const overtimePayCents = Math.round(overtimeBase + holidayPremium + weekendPremium);',
      '  return { status: "approved", regularPayCents, overtimePayCents, totalPayCents: regularPayCents + overtimePayCents, reason: null };',
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', regularPayCents: 0, overtimePayCents: 0, totalPayCents: 0, reason };",
      '}',
      'module.exports = { calculateOvertimePay };',
      ''
    ].join('\n');
    const happyPathOnlyPayroll = [
      'function calculateOvertimePay(employee = {}, timesheet = {}) {',
      "  if (employee.active !== true) return denied('employee_inactive');",
      "  if (timesheet.status !== 'submitted') return denied('timesheet_not_submitted');",
      '  const regularPayCents = Math.min(timesheet.hoursWorked ?? 0, 40) * (employee.baseRateCents ?? 0);',
      '  const overtimePayCents = Math.max(0, (timesheet.hoursWorked ?? 0) - 40) * (employee.baseRateCents ?? 0) * 1.5;',
      '  return { status: "approved", regularPayCents, overtimePayCents, totalPayCents: regularPayCents + overtimePayCents, reason: null };',
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', regularPayCents: 0, overtimePayCents: 0, totalPayCents: 0, reason };",
      '}',
      'module.exports = { calculateOvertimePay };',
      ''
    ].join('\n');
    const buggyVendorInvoice = [
      'function approveVendorInvoice(_vendor = {}, _po = {}, _receipt = {}, invoice = {}, _policy = {}) {',
      "  return { status: 'approved', reason: null, payableCents: invoice.amountCents ?? 0, holdCents: 0, requiresManualReview: false };",
      '}',
      'module.exports = { approveVendorInvoice };',
      ''
    ].join('\n');
    const fixedVendorInvoice = [
      'function approveVendorInvoice(vendor = {}, po = {}, receipt = {}, invoice = {}, policy = {}) {',
      "  if (invoice.status !== 'submitted') return denied('invoice_not_submitted');",
      "  if (vendor.active !== true) return denied('vendor_inactive');",
      "  if (vendor.onHold === true) return denied('vendor_on_hold');",
      "  if (vendor.taxIdVerified !== true) return denied('vendor_tax_id_unverified');",
      "  if (po.status !== 'approved' || po.closed === true) return denied('po_not_approved');",
      "  if (invoice.currency !== po.currency || invoice.currency !== vendor.currency) return denied('currency_mismatch');",
      "  if (invoice.duplicate === true) return denied('duplicate_invoice');",
      '  const amount = Math.max(0, invoice.amountCents ?? 0);',
      '  if (amount > (po.remainingCents ?? 0)) {',
      '    return review("po_amount_exceeded", po.remainingCents ?? 0, amount - (po.remainingCents ?? 0));',
      '  }',
      '  if (po.receiptRequired === true && receipt.received !== true && policy.allowUnreceiptedServices !== true) {',
      "    return denied('receipt_required');",
      '  }',
      '  if (po.receiptRequired === true && receipt.received === true) {',
      '    const accepted = Math.max(0, receipt.acceptedCents ?? 0);',
      '    if (accepted + (policy.toleranceCents ?? 0) < amount) {',
      '      return review("receipt_mismatch", accepted, amount - accepted);',
      '    }',
      '  }',
      '  const requiredWithholding = vendor.withholdingRequired === true ? Math.round(amount * (policy.withholdingRate ?? 0)) : 0;',
      '  const withheld = Math.max(0, invoice.taxWithheldCents ?? 0);',
      '  if (withheld < requiredWithholding) {',
      '    return review("tax_withholding_shortfall", amount, requiredWithholding - withheld);',
      '  }',
      '  return { status: "approved", reason: null, payableCents: amount - withheld, holdCents: 0, requiresManualReview: false };',
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, payableCents: 0, holdCents: 0, requiresManualReview: false };",
      '}',
      'function review(reason, payableCents, holdCents) {',
      "  return { status: 'review', reason, payableCents, holdCents, requiresManualReview: true };",
      '}',
      'module.exports = { approveVendorInvoice };',
      ''
    ].join('\n');
    const happyPathOnlyVendorInvoice = [
      'function approveVendorInvoice(vendor = {}, po = {}, receipt = {}, invoice = {}) {',
      "  if (vendor.active !== true) return denied('vendor_inactive');",
      "  if (vendor.onHold === true) return denied('vendor_on_hold');",
      "  if (po.status !== 'approved') return denied('po_not_approved');",
      "  if (po.receiptRequired === true && receipt.received !== true) return denied('receipt_required');",
      "  if (invoice.duplicate === true) return denied('duplicate_invoice');",
      "  return { status: 'approved', reason: null, payableCents: invoice.amountCents ?? 0, holdCents: 0, requiresManualReview: false };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, payableCents: 0, holdCents: 0, requiresManualReview: false };",
      '}',
      'module.exports = { approveVendorInvoice };',
      ''
    ].join('\n');
    const buggyExpenseReimbursement = [
      'function approveExpenseReimbursement(_employee = {}, expense = {}, _policy = {}) {',
      "  return { status: 'approved', reason: null, reimbursableCents: expense.amountCents ?? 0, requiresManualReview: false };",
      '}',
      'module.exports = { approveExpenseReimbursement };',
      ''
    ].join('\n');
    const fixedExpenseReimbursement = [
      'function approveExpenseReimbursement(employee = {}, expense = {}, policy = {}) {',
      "  if (employee.active !== true) return denied('employee_inactive');",
      "  if (expense.status !== 'submitted') return denied('expense_not_submitted');",
      '  const allowed = new Set(policy.allowedCategories ?? []);',
      '  if (!allowed.has(expense.category)) return denied("category_not_allowed");',
      '  const amount = reimbursementAmount(expense, policy);',
      '  if (amount > (policy.requiresReceiptAboveCents ?? 0) && expense.receiptAttached !== true) {',
      "    return denied('receipt_required');",
      '  }',
      "  if (employee.managerApproved !== true) return denied('manager_approval_required');",
      "  if (expense.duplicate === true) return denied('duplicate_expense');",
      '  const limit = policy.policyLimitCents ?? Number.POSITIVE_INFINITY;',
      '  if (amount > limit) {',
      '    return { status: "review", reason: "policy_limit_exceeded", reimbursableCents: limit, requiresManualReview: true };',
      '  }',
      '  return { status: "approved", reason: null, reimbursableCents: amount, requiresManualReview: false };',
      '}',
      'function reimbursementAmount(expense, policy) {',
      "  if (expense.category === 'mileage') return Math.round((expense.miles ?? 0) * (policy.mileageRateCents ?? 0));",
      "  if (expense.category === 'meal' && (expense.perDiemDays ?? 0) > 0) {",
      '    return Math.round((expense.perDiemDays ?? 0) * (policy.dailyPerDiemCents ?? 0));',
      '  }',
      '  return Math.max(0, expense.amountCents ?? 0);',
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, reimbursableCents: 0, requiresManualReview: false };",
      '}',
      'module.exports = { approveExpenseReimbursement };',
      ''
    ].join('\n');
    const happyPathOnlyExpenseReimbursement = [
      'function approveExpenseReimbursement(employee = {}, expense = {}, policy = {}) {',
      "  if (employee.active !== true) return denied('employee_inactive');",
      "  if (expense.status !== 'submitted') return denied('expense_not_submitted');",
      '  const allowed = new Set(policy.allowedCategories ?? []);',
      '  if (!allowed.has(expense.category)) return denied("category_not_allowed");',
      "  if (expense.receiptAttached !== true) return denied('receipt_required');",
      "  if (employee.managerApproved !== true) return denied('manager_approval_required');",
      "  if (expense.duplicate === true) return denied('duplicate_expense');",
      "  return { status: 'approved', reason: null, reimbursableCents: expense.amountCents ?? 0, requiresManualReview: false };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, reimbursableCents: 0, requiresManualReview: false };",
      '}',
      'module.exports = { approveExpenseReimbursement };',
      ''
    ].join('\n');
    const buggyLoanUnderwriting = [
      'function underwriteLoan(_applicant = {}, loan = {}, _policy = {}) {',
      "  return { decision: 'approved', reason: null, approvedAmountCents: loan.amountCents ?? 0, aprBps: 950, requiresManualReview: false };",
      '}',
      'module.exports = { underwriteLoan };',
      ''
    ].join('\n');
    const fixedLoanUnderwriting = [
      'function underwriteLoan(applicant = {}, loan = {}, policy = {}) {',
      "  if (applicant.active !== true) return denied('applicant_inactive');",
      "  if (loan.status !== 'submitted') return denied('loan_not_submitted');",
      "  if (applicant.sanctionsHit === true) return denied('sanctions_match');",
      '  const income = applicant.monthlyIncomeCents ?? 0;',
      '  if (income < (policy.minMonthlyIncomeCents ?? 0)) return denied("income_below_minimum");',
      '  if ((applicant.creditScore ?? 0) < (policy.minCreditScore ?? 0)) {',
      "    return denied('credit_score_below_minimum');",
      '  }',
      '  const dti = income === 0 ? Number.POSITIVE_INFINITY : (applicant.monthlyDebtCents ?? 0) / income;',
      '  if (dti > (policy.maxDebtToIncomeRatio ?? Number.POSITIVE_INFINITY)) {',
      "    return denied('debt_to_income_exceeded');",
      '  }',
      '  const amount = loan.amountCents ?? 0;',
      '  if (loan.secured !== true && amount > (policy.maxUnsecuredAmountCents ?? Number.POSITIVE_INFINITY)) {',
      "    return denied('unsecured_amount_exceeded');",
      '  }',
      '  const aprBps = priceLoan(applicant, policy);',
      '  if (applicant.incomeVerified !== true) {',
      '    return { decision: "review", reason: "income_verification_required", approvedAmountCents: amount, aprBps: policy.standardAprBps ?? aprBps, requiresManualReview: true };',
      '  }',
      '  if (amount > (policy.manualReviewAmountCents ?? Number.POSITIVE_INFINITY)) {',
      '    return { decision: "review", reason: "large_loan_manual_review", approvedAmountCents: amount, aprBps, requiresManualReview: true };',
      '  }',
      '  return { decision: "approved", reason: null, approvedAmountCents: amount, aprBps, requiresManualReview: false };',
      '}',
      'function priceLoan(applicant, policy) {',
      '  const score = applicant.creditScore ?? 0;',
      '  if (score >= 700) return policy.primeAprBps ?? 0;',
      '  if (score >= 660) return policy.standardAprBps ?? 0;',
      '  return policy.subprimeAprBps ?? 0;',
      '}',
      'function denied(reason) {',
      "  return { decision: 'denied', reason, approvedAmountCents: 0, aprBps: null, requiresManualReview: false };",
      '}',
      'module.exports = { underwriteLoan };',
      ''
    ].join('\n');
    const happyPathOnlyLoanUnderwriting = [
      'function underwriteLoan(applicant = {}, loan = {}, policy = {}) {',
      "  if (applicant.active !== true) return denied('applicant_inactive');",
      "  if (loan.status !== 'submitted') return denied('loan_not_submitted');",
      "  if (applicant.sanctionsHit === true) return denied('sanctions_match');",
      "  if (applicant.incomeVerified !== true) return { decision: 'review', reason: 'income_verification_required', approvedAmountCents: loan.amountCents ?? 0, aprBps: policy.standardAprBps ?? 950, requiresManualReview: true };",
      "  return { decision: 'approved', reason: null, approvedAmountCents: loan.amountCents ?? 0, aprBps: policy.primeAprBps ?? 650, requiresManualReview: false };",
      '}',
      'function denied(reason) {',
      "  return { decision: 'denied', reason, approvedAmountCents: 0, aprBps: null, requiresManualReview: false };",
      '}',
      'module.exports = { underwriteLoan };',
      ''
    ].join('\n');
    const buggyAccountClosure = [
      'function closeAccount(_account = {}, _request = {}, _policy = {}) {',
      "  return { status: 'closed', reason: null, refundCents: 0, requiresManualReview: false, dataDeleted: true };",
      '}',
      'module.exports = { closeAccount };',
      ''
    ].join('\n');
    const fixedAccountClosure = [
      'function closeAccount(account = {}, request = {}, policy = {}) {',
      "  if (account.active !== true) return denied('account_not_active');",
      "  if (request.confirmPhrase !== 'CLOSE') return denied('confirmation_required');",
      "  if (account.legalHold === true) return denied('legal_hold');",
      "  if (account.subscriptionActive === true) return denied('active_subscription');",
      "  if (account.status === 'suspended') return review('suspended_account_review', 0);",
      "  if (account.pendingDisputes === true) return review('pending_dispute', 0);",
      "  if (account.dataExportReady !== true) return review('data_export_pending', 0);",
      '  const refundCents = account.balanceCents ?? 0;',
      '  if (refundCents > 0 && request.refundMethodOnFile !== true) {',
      "    return review('refund_method_required', refundCents);",
      '  }',
      '  if (account.identityVerified !== true && (account.lastLoginDays ?? 0) > (policy.maxDormantDaysWithoutIdentity ?? Number.POSITIVE_INFINITY)) {',
      "    return review('identity_verification_required', 0);",
      '  }',
      '  return { status: "closed", reason: null, refundCents, requiresManualReview: false, dataDeleted: true };',
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, refundCents: 0, requiresManualReview: false, dataDeleted: false };",
      '}',
      'function review(reason, refundCents) {',
      "  return { status: 'review', reason, refundCents, requiresManualReview: true, dataDeleted: false };",
      '}',
      'module.exports = { closeAccount };',
      ''
    ].join('\n');
    const happyPathOnlyAccountClosure = [
      'function closeAccount(account = {}, request = {}) {',
      "  if (account.active !== true) return denied('account_not_active');",
      "  if (request.confirmPhrase !== 'CLOSE') return denied('confirmation_required');",
      "  return { status: 'closed', reason: null, refundCents: account.balanceCents ?? 0, requiresManualReview: false, dataDeleted: true };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, refundCents: 0, requiresManualReview: false, dataDeleted: false };",
      '}',
      'module.exports = { closeAccount };',
      ''
    ].join('\n');
    const buggyMerchantOnboarding = [
      'function onboardMerchant(_merchant = {}, _request = {}, _policy = {}) {',
      "  return { status: 'approved', reason: null, payoutEnabled: true, requiresManualReview: false, riskTier: 'standard' };",
      '}',
      'module.exports = { onboardMerchant };',
      ''
    ].join('\n');
    const fixedMerchantOnboarding = [
      'function onboardMerchant(merchant = {}, request = {}, policy = {}) {',
      "  if (merchant.status !== 'pending_review') return denied('merchant_not_pending');",
      "  if (request.termsAccepted !== true) return denied('terms_not_accepted');",
      "  if (merchant.sanctionsHit === true) return denied('sanctions_match');",
      "  if (merchant.prohibitedCategory === true) return denied('prohibited_category');",
      "  if (merchant.businessVerified !== true) return review('business_verification_required');",
      "  if (merchant.taxFormSubmitted !== true) return review('tax_form_required');",
      "  if (merchant.bankAccountVerified !== true) return review('bank_account_required');",
      '  if ((merchant.riskScore ?? 100) > (policy.maxAutoApproveRiskScore ?? 70)) {',
      "    return review('risk_score_manual_review');",
      '  }',
      '  if ((merchant.processingVolumeCents ?? 0) > (policy.highVolumeReviewCents ?? Number.POSITIVE_INFINITY)) {',
      "    return review('high_volume_manual_review');",
      '  }',
      "  const riskTier = (merchant.riskScore ?? 100) <= (policy.lowRiskThreshold ?? 25) ? 'low' : 'standard';",
      "  return { status: 'approved', reason: null, payoutEnabled: true, requiresManualReview: false, riskTier };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, payoutEnabled: false, requiresManualReview: false, riskTier: null };",
      '}',
      'function review(reason) {',
      "  return { status: 'review', reason, payoutEnabled: false, requiresManualReview: true, riskTier: null };",
      '}',
      'module.exports = { onboardMerchant };',
      ''
    ].join('\n');
    const happyPathOnlyMerchantOnboarding = [
      'function onboardMerchant(merchant = {}, request = {}) {',
      "  if (merchant.status !== 'pending_review') return denied('merchant_not_pending');",
      "  if (request.termsAccepted !== true) return denied('terms_not_accepted');",
      "  return { status: 'approved', reason: null, payoutEnabled: true, requiresManualReview: false, riskTier: 'standard' };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, payoutEnabled: false, requiresManualReview: false, riskTier: null };",
      '}',
      'module.exports = { onboardMerchant };',
      ''
    ].join('\n');
    const buggyDataRetentionDeletion = [
      'function processDeletionRequest(_account = {}, _request = {}, _policy = {}) {',
      "  return { status: 'deleted', reason: null, dataDeleted: true, requiresManualReview: false, deletionScope: 'full' };",
      '}',
      'module.exports = { processDeletionRequest };',
      ''
    ].join('\n');
    const fixedDataRetentionDeletion = [
      'function processDeletionRequest(account = {}, request = {}, policy = {}) {',
      "  if (account.status !== 'active') return denied('account_not_active');",
      "  if (request.confirmed !== true) return denied('confirmation_required');",
      "  if (request.requesterVerified !== true || account.verifiedRequester !== true) return denied('requester_not_verified');",
      "  if (account.legalHold === true) return denied('legal_hold');",
      "  if (account.openCase === true) return review('open_case_review');",
      '  if (policy.requireExportReady === true && account.exportReady !== true) {',
      "    return review('data_export_pending');",
      '  }',
      '  if ((account.daysSinceLastActivity ?? 0) < (policy.minRetentionDays ?? 0)) {',
      "    return denied('retention_period_active');",
      '  }',
      '  if (account.minorData === true && policy.minorDataManualReview === true) {',
      "    return review('minor_data_review');",
      '  }',
      '  const regional = (policy.regionalErasureRegions ?? []).includes(account.region);',
      "  return { status: 'deleted', reason: null, dataDeleted: true, requiresManualReview: false, deletionScope: regional ? 'full' : 'limited' };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, dataDeleted: false, requiresManualReview: false, deletionScope: null };",
      '}',
      'function review(reason) {',
      "  return { status: 'review', reason, dataDeleted: false, requiresManualReview: true, deletionScope: null };",
      '}',
      'module.exports = { processDeletionRequest };',
      ''
    ].join('\n');
    const happyPathOnlyDataRetentionDeletion = [
      'function processDeletionRequest(account = {}, request = {}, policy = {}) {',
      "  if (account.status !== 'active') return denied('account_not_active');",
      "  if (request.confirmed !== true) return denied('confirmation_required');",
      "  if (request.requesterVerified !== true || account.verifiedRequester !== true) return denied('requester_not_verified');",
      '  const regional = (policy.regionalErasureRegions ?? []).includes(account.region);',
      "  return { status: 'deleted', reason: null, dataDeleted: true, requiresManualReview: false, deletionScope: regional ? 'full' : 'limited' };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, dataDeleted: false, requiresManualReview: false, deletionScope: null };",
      '}',
      'module.exports = { processDeletionRequest };',
      ''
    ].join('\n');
    const buggyContentModerationAppeal = [
      'function reviewAppeal(_user = {}, _content = {}, _appeal = {}, _policy = {}) {',
      "  return { status: 'restored', reason: null, contentRestored: true, requiresManualReview: false, restoreScope: 'full' };",
      '}',
      'module.exports = { reviewAppeal };',
      ''
    ].join('\n');
    const fixedContentModerationAppeal = [
      'function reviewAppeal(user = {}, content = {}, appeal = {}, policy = {}) {',
      "  if (content.status !== 'removed') return denied('content_not_removed');",
      "  if (appeal.submitted !== true) return denied('appeal_not_submitted');",
      "  if (appeal.userId !== user.id || content.ownerId !== user.id) return denied('owner_mismatch');",
      "  if (content.safetyCritical === true) return upheld('safety_critical_policy');",
      '  if ((content.daysSinceRemoval ?? 0) > (policy.appealDeadlineDays ?? 30)) {',
      "    return denied('appeal_window_expired');",
      '  }',
      '  if (appeal.newEvidence === true && appeal.evidenceReviewed !== true) {',
      "    return review('new_evidence_review');",
      '  }',
      '  if (content.repeatedViolation === true && policy.requireHumanReviewForRepeat === true) {',
      "    return review('repeat_violation_review');",
      '  }',
      '  const limited = (policy.restrictedRestoreRegions ?? []).includes(user.region);',
      "  return { status: 'restored', reason: null, contentRestored: true, requiresManualReview: false, restoreScope: limited ? 'limited' : 'full' };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, contentRestored: false, requiresManualReview: false, restoreScope: null };",
      '}',
      'function upheld(reason) {',
      "  return { status: 'upheld', reason, contentRestored: false, requiresManualReview: false, restoreScope: null };",
      '}',
      'function review(reason) {',
      "  return { status: 'review', reason, contentRestored: false, requiresManualReview: true, restoreScope: null };",
      '}',
      'module.exports = { reviewAppeal };',
      ''
    ].join('\n');
    const happyPathOnlyContentModerationAppeal = [
      'function reviewAppeal(user = {}, content = {}, appeal = {}, policy = {}) {',
      "  if (content.status !== 'removed') return denied('content_not_removed');",
      "  if (appeal.submitted !== true) return denied('appeal_not_submitted');",
      "  if (appeal.userId !== user.id || content.ownerId !== user.id) return denied('owner_mismatch');",
      '  const limited = (policy.restrictedRestoreRegions ?? []).includes(user.region);',
      "  return { status: 'restored', reason: null, contentRestored: true, requiresManualReview: false, restoreScope: limited ? 'limited' : 'full' };",
      '}',
      'function denied(reason) {',
      "  return { status: 'denied', reason, contentRestored: false, requiresManualReview: false, restoreScope: null };",
      '}',
      'module.exports = { reviewAppeal };',
      ''
    ].join('\n');
    const buggyFraudRisk = [
      'function assessOrderFraudRisk(_order = {}, _customer = {}, _payment = {}, _rules = {}) {',
      '  return decision("approved", null, 0, false, true);',
      '}',
      'function decision(status, reason, riskScore, requiresManualReview, approved) {',
      '  return { status, reason, riskScore, requiresManualReview, approved };',
      '}',
      'module.exports = { assessOrderFraudRisk };',
      ''
    ].join('\n');
    const fixedFraudRisk = [
      'function assessOrderFraudRisk(order = {}, customer = {}, payment = {}, rules = {}) {',
      "  if (order.status !== 'submitted') return decision('ignored', 'order_not_submitted', 0, false, false);",
      "  if (customer.accountStatus === 'blocked') return decision('declined', 'customer_blocked', 100, false, false);",
      "  if (payment.verified !== true) return decision('manual_review', 'payment_not_verified', rules.paymentVerificationRisk ?? 55, true, false);",
      '  let riskScore = 0;',
      '  const addRisk = (condition, points) => { if (condition) riskScore += points; };',
      '  addRisk(Boolean(payment.cardCountry && order.country) && payment.cardCountry !== order.country, rules.crossBorderRisk ?? 35);',
      '  addRisk((customer.chargebacksLast90Days ?? 0) >= (rules.chargebackThreshold ?? 2), rules.chargebackRisk ?? 55);',
      '  addRisk((customer.ordersLastHour ?? 0) > (rules.velocityOrderLimit ?? 5), rules.velocityRisk ?? 60);',
      '  addRisk((order.total ?? 0) > (rules.highValueThreshold ?? 500), rules.highValueRisk ?? 25);',
      '  addRisk(rules.postalMismatchReview === true && payment.billingPostalCode !== order.shippingPostalCode, rules.postalMismatchRisk ?? 30);',
      '  if (riskScore >= (rules.autoDeclineThreshold ?? 85)) return decision("declined", "auto_decline_risk_threshold", riskScore, false, false);',
      '  if (riskScore >= (rules.manualReviewThreshold ?? 50)) return decision("manual_review", "risk_threshold", riskScore, true, false);',
      '  return decision("approved", null, riskScore, false, true);',
      '}',
      'function decision(status, reason, riskScore, requiresManualReview, approved) {',
      '  return { status, reason, riskScore, requiresManualReview, approved };',
      '}',
      'module.exports = { assessOrderFraudRisk };',
      ''
    ].join('\n');
    const happyPathOnlyFraudRisk = [
      'function assessOrderFraudRisk(order = {}, customer = {}, payment = {}, rules = {}) {',
      "  if (order.status !== 'submitted') return decision('ignored', 'order_not_submitted', 0, false, false);",
      "  if (customer.accountStatus === 'blocked') return decision('declined', 'customer_blocked', 100, false, false);",
      "  if (payment.verified !== true) return decision('manual_review', 'payment_not_verified', rules.paymentVerificationRisk ?? 55, true, false);",
      '  return decision("approved", null, 0, false, true);',
      '}',
      'function decision(status, reason, riskScore, requiresManualReview, approved) {',
      '  return { status, reason, riskScore, requiresManualReview, approved };',
      '}',
      'module.exports = { assessOrderFraudRisk };',
      ''
    ].join('\n');
    const buggyCreditMemo = [
      'function evaluateCreditMemo(_invoice = {}, request = {}, _account = {}, _policy = {}) {',
      '  return decision("approved", null, Math.max(0, request.amountCents ?? 0), false, true);',
      '}',
      'function decision(status, reason, amountCents, requiresApproval, approved) {',
      '  return { status, reason, amountCents, requiresApproval, approved };',
      '}',
      'module.exports = { evaluateCreditMemo };',
      ''
    ].join('\n');
    const fixedCreditMemo = [
      'function evaluateCreditMemo(invoice = {}, request = {}, account = {}, policy = {}) {',
      '  const amountCents = Math.max(0, request.amountCents ?? 0);',
      "  if (!['paid', 'settled'].includes(invoice.status)) return decision('denied', 'invoice_not_settled', amountCents, false, false);",
      "  if (account.status === 'suspended' && policy.allowSuspendedAccounts !== true) return decision('denied', 'account_suspended', amountCents, false, false);",
      "  if (request.duplicateMemo === true || invoice.hasOpenCreditMemo === true) return decision('denied', 'duplicate_credit_memo', amountCents, false, false);",
      "  if (request.type === 'service_credit' && !request.linkedDisputeId) return decision('manual_review', 'missing_dispute_evidence', amountCents, true, false);",
      "  if ((invoice.daysSinceSettlement ?? 0) > (policy.creditWindowDays ?? 90)) return decision('denied', 'credit_window_expired', amountCents, false, false);",
      "  if (amountCents <= 0) return decision('denied', 'invalid_credit_amount', amountCents, false, false);",
      "  if (amountCents > (invoice.paidCents ?? 0)) return decision('denied', 'credit_exceeds_paid_amount', amountCents, false, false);",
      "  if (request.reason === 'tax_adjustment') {",
      '    const cap = policy.taxAdjustmentCapCents ?? Math.round((invoice.taxCents ?? 0) * (policy.taxAdjustmentCapRate ?? 1));',
      "    if (amountCents > cap) return decision('manual_review', 'tax_adjustment_cap', amountCents, true, false);",
      '  }',
      "  if (amountCents > (policy.autoApproveLimitCents ?? Number.POSITIVE_INFINITY)) return decision('manual_review', 'approval_threshold', amountCents, true, false);",
      '  return decision("approved", null, amountCents, false, true);',
      '}',
      'function decision(status, reason, amountCents, requiresApproval, approved) {',
      '  return { status, reason, amountCents, requiresApproval, approved };',
      '}',
      'module.exports = { evaluateCreditMemo };',
      ''
    ].join('\n');
    const happyPathOnlyCreditMemo = [
      'function evaluateCreditMemo(invoice = {}, request = {}, account = {}) {',
      '  const amountCents = Math.max(0, request.amountCents ?? 0);',
      "  if (!['paid', 'settled'].includes(invoice.status)) return decision('denied', 'invoice_not_settled', amountCents, false, false);",
      "  if (account.status === 'suspended') return decision('denied', 'account_suspended', amountCents, false, false);",
      "  if (amountCents <= 0) return decision('denied', 'invalid_credit_amount', amountCents, false, false);",
      "  if (amountCents > (invoice.paidCents ?? 0)) return decision('denied', 'credit_exceeds_paid_amount', amountCents, false, false);",
      '  return decision("approved", null, amountCents, false, true);',
      '}',
      'function decision(status, reason, amountCents, requiresApproval, approved) {',
      '  return { status, reason, amountCents, requiresApproval, approved };',
      '}',
      'module.exports = { evaluateCreditMemo };',
      ''
    ].join('\n');
    const buggyPaymentSettlement = [
      'function settlePaymentCapture(_order = {}, payment = {}, _settlement = {}, _policy = {}) {',
      '  return decision("settled", null, Math.max(0, payment.captureCents ?? 0), false, true);',
      '}',
      'function decision(status, reason, captureCents, requiresManualReview, settled) {',
      '  return { status, reason, captureCents, requiresManualReview, settled };',
      '}',
      'module.exports = { settlePaymentCapture };',
      ''
    ].join('\n');
    const fixedPaymentSettlement = [
      'function settlePaymentCapture(order = {}, payment = {}, settlement = {}, policy = {}, now = new Date("2026-06-26T12:00:00.000Z")) {',
      '  const captureCents = Math.max(0, payment.captureCents ?? order.totalCents ?? 0);',
      "  if (!['fulfilled', 'shipped', 'delivered'].includes(order.status)) return decision('denied', 'order_not_fulfilled', captureCents, false, false);",
      "  if (payment.status !== 'authorized') return decision('denied', 'payment_not_authorized', captureCents, false, false);",
      "  if (elapsedDays(payment.authorizedAt, now) > (policy.authorizationWindowDays ?? 7)) return decision('denied', 'authorization_expired', captureCents, false, false);",
      "  if (payment.currency && order.currency && payment.currency !== order.currency) return decision('denied', 'currency_mismatch', captureCents, false, false);",
      '  const authorizedCents = payment.authorizedCents ?? order.totalCents ?? 0;',
      "  if (captureCents <= 0 || captureCents > authorizedCents) return decision('denied', 'capture_exceeds_authorization', captureCents, false, false);",
      "  if (payment.chargebackOpen === true || payment.disputeOpen === true) return decision('manual_review', 'open_dispute_review', captureCents, true, false);",
      "  if (payment.fraudHold === true || order.riskHold === true) return decision('manual_review', 'risk_hold_review', captureCents, true, false);",
      "  if (settlement.status !== 'open') return decision('denied', 'settlement_batch_closed', captureCents, false, false);",
      "  if (settlement.merchantStatus === 'suspended') return decision('denied', 'merchant_suspended', captureCents, false, false);",
      "  if (captureCents > (policy.autoSettleLimitCents ?? Number.POSITIVE_INFINITY)) return decision('manual_review', 'settlement_threshold_review', captureCents, true, false);",
      '  return decision("settled", null, captureCents, false, true);',
      '}',
      'function elapsedDays(from, to) {',
      '  if (!from) return Number.POSITIVE_INFINITY;',
      '  const fromMs = new Date(from).getTime();',
      '  const toMs = new Date(to).getTime();',
      '  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return Number.POSITIVE_INFINITY;',
      '  return Math.floor((toMs - fromMs) / 86400000);',
      '}',
      'function decision(status, reason, captureCents, requiresManualReview, settled) {',
      '  return { status, reason, captureCents, requiresManualReview, settled };',
      '}',
      'module.exports = { settlePaymentCapture };',
      ''
    ].join('\n');
    const happyPathOnlyPaymentSettlement = [
      'function settlePaymentCapture(order = {}, payment = {}, settlement = {}) {',
      '  const captureCents = Math.max(0, payment.captureCents ?? order.totalCents ?? 0);',
      "  if (!['fulfilled', 'shipped', 'delivered'].includes(order.status)) return decision('denied', 'order_not_fulfilled', captureCents, false, false);",
      "  if (payment.status !== 'authorized') return decision('denied', 'payment_not_authorized', captureCents, false, false);",
      "  if (settlement.status !== 'open') return decision('denied', 'settlement_batch_closed', captureCents, false, false);",
      '  return decision("settled", null, captureCents, false, true);',
      '}',
      'function decision(status, reason, captureCents, requiresManualReview, settled) {',
      '  return { status, reason, captureCents, requiresManualReview, settled };',
      '}',
      'module.exports = { settlePaymentCapture };',
      ''
    ].join('\n');
    const buggyTaxFiling = [
      'function assessTaxFiling(_payer = {}, _vendor = {}, filing = {}, _policy = {}) {',
      '  return decision("accepted", null, Math.max(0, filing.amountCents ?? 0), Math.max(0, filing.withholdingCents ?? 0), false, true);',
      '}',
      'function decision(status, reason, reportableAmountCents, withholdingCents, requiresManualReview, filed) {',
      '  return { status, reason, reportableAmountCents, withholdingCents, requiresManualReview, filed };',
      '}',
      'module.exports = { assessTaxFiling };',
      ''
    ].join('\n');
    const fixedTaxFiling = [
      'function assessTaxFiling(payer = {}, vendor = {}, filing = {}, policy = {}) {',
      '  const amountCents = Math.max(0, filing.amountCents ?? 0);',
      '  const withholdingCents = Math.max(0, filing.withholdingCents ?? 0);',
      "  if (payer.status !== 'active') return decision('denied', 'payer_inactive', amountCents, withholdingCents, false, false);",
      "  if (vendor.status === 'suspended') return decision('denied', 'payee_suspended', amountCents, withholdingCents, false, false);",
      "  if (amountCents < (policy.reportingThresholdCents ?? 60000)) return decision('not_required', 'reporting_threshold_not_met', amountCents, withholdingCents, false, false);",
      "  if (filing.form !== (policy.requiredForm ?? '1099-NEC')) return decision('denied', 'form_mismatch', amountCents, withholdingCents, false, false);",
      "  if (deadlineMissed(filing.filedAt, policy.filingDeadline)) return decision('denied', 'filing_deadline_missed', amountCents, withholdingCents, false, false);",
      "  if (filing.correction === true && filing.originalAccepted !== true) return decision('denied', 'correction_without_original', amountCents, withholdingCents, false, false);",
      "  if (vendor.country && payer.country && vendor.country !== payer.country && vendor.treatyOnFile !== true) return decision('manual_review', 'treaty_review_required', amountCents, withholdingCents, true, false);",
      '  const requiredWithholding = vendor.w9OnFile === true && vendor.tinVerified === true ? 0 : Math.ceil(amountCents * (policy.backupWithholdingRate ?? 0.24));',
      "  if (requiredWithholding > 0 && withholdingCents === 0) return decision('manual_review', 'backup_withholding_required', amountCents, requiredWithholding, true, false);",
      "  if (withholdingCents < requiredWithholding) return decision('manual_review', 'withholding_shortfall', amountCents, requiredWithholding, true, false);",
      '  return decision("accepted", null, amountCents, withholdingCents, false, true);',
      '}',
      'function deadlineMissed(filedAt, deadline) {',
      '  if (!deadline) return false;',
      '  const filedMs = new Date(filedAt).getTime();',
      '  const deadlineMs = new Date(deadline).getTime();',
      '  if (!Number.isFinite(filedMs) || !Number.isFinite(deadlineMs)) return true;',
      '  return filedMs > deadlineMs;',
      '}',
      'function decision(status, reason, reportableAmountCents, withholdingCents, requiresManualReview, filed) {',
      '  return { status, reason, reportableAmountCents, withholdingCents, requiresManualReview, filed };',
      '}',
      'module.exports = { assessTaxFiling };',
      ''
    ].join('\n');
    const happyPathOnlyTaxFiling = [
      'function assessTaxFiling(payer = {}, _vendor = {}, filing = {}, policy = {}) {',
      '  const amountCents = Math.max(0, filing.amountCents ?? 0);',
      '  const withholdingCents = Math.max(0, filing.withholdingCents ?? 0);',
      "  if (payer.status !== 'active') return decision('denied', 'payer_inactive', amountCents, withholdingCents, false, false);",
      "  if (amountCents < (policy.reportingThresholdCents ?? 60000)) return decision('not_required', 'reporting_threshold_not_met', amountCents, withholdingCents, false, false);",
      "  if (filing.form !== (policy.requiredForm ?? '1099-NEC')) return decision('denied', 'form_mismatch', amountCents, withholdingCents, false, false);",
      "  if (deadlineMissed(filing.filedAt, policy.filingDeadline)) return decision('denied', 'filing_deadline_missed', amountCents, withholdingCents, false, false);",
      '  return decision("accepted", null, amountCents, withholdingCents, false, true);',
      '}',
      'function deadlineMissed(filedAt, deadline) {',
      '  if (!deadline) return false;',
      '  const filedMs = new Date(filedAt).getTime();',
      '  const deadlineMs = new Date(deadline).getTime();',
      '  if (!Number.isFinite(filedMs) || !Number.isFinite(deadlineMs)) return true;',
      '  return filedMs > deadlineMs;',
      '}',
      'function decision(status, reason, reportableAmountCents, withholdingCents, requiresManualReview, filed) {',
      '  return { status, reason, reportableAmountCents, withholdingCents, requiresManualReview, filed };',
      '}',
      'module.exports = { assessTaxFiling };',
      ''
    ].join('\n');
    const buggyPrivacyConsent = [
      'function evaluatePrivacyConsent(_user, _consent, _request, _policy) {',
      '  return { status: "allowed", reason: null, requiresManualReview: false, shareAllowed: true };',
      '}',
      'module.exports = { evaluatePrivacyConsent };',
      ''
    ].join('\n');
    const fixedPrivacyConsent = [
      'function evaluatePrivacyConsent(user = {}, consent = {}, request = {}, policy = {}) {',
      "  if (user.status !== 'active') return decision('denied', 'user_not_active', false, false);",
      "  if (consent.granted !== true) return decision('denied', 'consent_not_granted', false, false);",
      "  if (consent.revoked === true) return decision('denied', 'consent_revoked', false, false);",
      "  if (consent.versionAccepted !== policy.requiredVersion) return decision('denied', 'consent_version_outdated', false, false);",
      '  if (isExpired(consent.expiresAt, request.requestedAt)) return decision("denied", "consent_expired", false, false);',
      '  if ((user.age ?? Infinity) < (policy.minorAge ?? 16) && user.guardianConsent !== true) return decision("denied", "guardian_consent_required", false, false);',
      '  const allowedPurposes = policy.allowedPurposes ?? [];',
      '  if (!allowedPurposes.includes(request.purpose)) return decision("denied", "purpose_not_allowed", false, false);',
      '  const grantedPurposes = consent.purposes ?? [];',
      '  if (!grantedPurposes.includes(request.purpose)) return decision("denied", "purpose_not_allowed", false, false);',
      '  if ((policy.sensitivePurposes ?? []).includes(request.purpose)) return decision("manual_review", "sensitive_purpose_review", true, false);',
      '  if (request.vendorDpaSigned !== true) return decision("manual_review", "vendor_dpa_required", true, false);',
      '  return decision("allowed", null, false, true);',
      '}',
      'function isExpired(expiresAt, requestedAt) {',
      '  if (!expiresAt) return false;',
      '  const expiresMs = new Date(expiresAt).getTime();',
      '  const requestedMs = new Date(requestedAt).getTime();',
      '  if (!Number.isFinite(expiresMs) || !Number.isFinite(requestedMs)) return true;',
      '  return requestedMs > expiresMs;',
      '}',
      'function decision(status, reason, requiresManualReview, shareAllowed) {',
      '  return { status, reason, requiresManualReview, shareAllowed };',
      '}',
      'module.exports = { evaluatePrivacyConsent };',
      ''
    ].join('\n');
    const happyPathOnlyPrivacyConsent = [
      'function evaluatePrivacyConsent(_user, consent = {}, request = {}, _policy = {}) {',
      '  if (consent.granted !== true) return decision("denied", "consent_not_granted", false, false);',
      '  if (!Array.isArray(consent.purposes) || !consent.purposes.includes(request.purpose)) return decision("denied", "purpose_not_allowed", false, false);',
      '  return decision("allowed", null, false, true);',
      '}',
      'function decision(status, reason, requiresManualReview, shareAllowed) {',
      '  return { status, reason, requiresManualReview, shareAllowed };',
      '}',
      'module.exports = { evaluatePrivacyConsent };',
      ''
    ].join('\n');
    const buggyAccessReview = [
      'function evaluateAccessReview(_user = {}, _resource = {}, _review = {}, _policy = {}) {',
      '  return decision("approved", null, true, false, null);',
      '}',
      'function decision(status, reason, accessAllowed, requiresManualReview, deprovisionAfterDays) {',
      '  return { status, reason, accessAllowed, requiresManualReview, deprovisionAfterDays };',
      '}',
      'module.exports = { evaluateAccessReview };',
      ''
    ].join('\n');
    const fixedAccessReview = [
      'function evaluateAccessReview(user = {}, resource = {}, review = {}, policy = {}) {',
      "  if (user.status !== 'active') return revoke('user_not_active');",
      "  if (user.employmentStatus === 'terminated') return revoke('employment_terminated');",
      "  if (resource.status !== 'active') return revoke('resource_not_active');",
      '  if (!(policy.allowedRoles ?? []).includes(user.role)) return revoke("role_not_allowed");',
      '  if (resource.requiredRole && user.role !== resource.requiredRole) {',
      "    return manual('insufficient_role', policy);",
      '  }',
      '  if (resource.requiresMfa === true && user.mfaEnabled !== true) {',
      "    return manual('mfa_required', policy);",
      '  }',
      '  if ((user.lastLoginDays ?? 0) > (policy.maxInactiveLoginDays ?? Number.POSITIVE_INFINITY)) {',
      "    return manual('inactive_access_review', policy);",
      '  }',
      '  if (resource.ownerDepartment && user.department !== resource.ownerDepartment) {',
      "    return manual('department_mismatch', policy);",
      '  }',
      '  if (review.status !== "submitted") return manual("review_not_submitted", policy);',
      '  if (review.reviewerApproved !== true) return manual("reviewer_approval_required", policy);',
      '  if (resource.highRisk === true && policy.requireManagerForHighRisk === true && review.managerApproved !== true) {',
      "    return manual('manager_approval_required', policy);",
      '  }',
      '  if (review.accessUsedLast90Days !== true && review.policyException !== true) {',
      "    return manual('unused_access', policy);",
      '  }',
      '  return decision("approved", null, true, false, null);',
      '}',
      'function revoke(reason) {',
      '  return decision("revoked", reason, false, false, 0);',
      '}',
      'function manual(reason, policy) {',
      '  return decision("manual_review", reason, false, true, policy.deprovisionGraceDays ?? 7);',
      '}',
      'function decision(status, reason, accessAllowed, requiresManualReview, deprovisionAfterDays) {',
      '  return { status, reason, accessAllowed, requiresManualReview, deprovisionAfterDays };',
      '}',
      'module.exports = { evaluateAccessReview };',
      ''
    ].join('\n');
    const happyPathOnlyAccessReview = [
      'function evaluateAccessReview(user = {}, resource = {}, review = {}, _policy = {}) {',
      "  if (user.status !== 'active') return revoke('user_not_active');",
      "  if (resource.status !== 'active') return revoke('resource_not_active');",
      '  if (review.reviewerApproved !== true) return manual("reviewer_approval_required");',
      '  return decision("approved", null, true, false, null);',
      '}',
      'function revoke(reason) {',
      '  return decision("revoked", reason, false, false, 0);',
      '}',
      'function manual(reason) {',
      '  return decision("manual_review", reason, false, true, 7);',
      '}',
      'function decision(status, reason, accessAllowed, requiresManualReview, deprovisionAfterDays) {',
      '  return { status, reason, accessAllowed, requiresManualReview, deprovisionAfterDays };',
      '}',
      'module.exports = { evaluateAccessReview };',
      ''
    ].join('\n');
    const buggyReleaseReadiness = [
      'function evaluateReleaseReadiness(_release = {}, _checks = {}, _approval = {}, _policy = {}) {',
      '  return decision("approved", null, true, false, false);',
      '}',
      'function decision(status, reason, releaseAllowed, requiresManualReview, rollbackRequired) {',
      '  return { status, reason, releaseAllowed, requiresManualReview, rollbackRequired };',
      '}',
      'module.exports = { evaluateReleaseReadiness };',
      ''
    ].join('\n');
    const fixedReleaseReadiness = [
      'function evaluateReleaseReadiness(release = {}, checks = {}, approval = {}, policy = {}) {',
      '  if (release.status !== "ready") return blocked("release_not_ready");',
      '  if (Array.isArray(policy.allowedEnvironments) && !policy.allowedEnvironments.includes(release.environment)) {',
      '    return blocked("environment_not_allowed");',
      '  }',
      '  if (checks.buildPassed !== true) return blocked("build_failed");',
      '  if (checks.smokePassed !== true) return blocked("smoke_failed", true);',
      '  if (checks.securityScanPassed !== true) return blocked("security_scan_failed");',
      '  if ((checks.openSev1Incidents ?? 0) > 0) return blocked("active_sev1_incident");',
      '  if (release.hasRollbackPlan !== true) return manual("rollback_plan_required");',
      '  if (release.deploymentWindowApproved !== true) return manual("deployment_window_required");',
      '  if (release.freezeWindow === true) return manual("freeze_window");',
      '  if (release.riskLevel === "high" && approval.changeManagerApproved !== true) {',
      '    return manual("change_manager_approval_required");',
      '  }',
      '  if (approval.releaseOwnerApproved !== true) return manual("release_owner_approval_required");',
      '  if (policy.requireSreApproval === true && approval.sreApproved !== true) {',
      '    return manual("sre_approval_required");',
      '  }',
      '  return decision("approved", null, true, false, false);',
      '}',
      'function blocked(reason, rollbackRequired = false) {',
      '  return decision("blocked", reason, false, false, rollbackRequired);',
      '}',
      'function manual(reason) {',
      '  return decision("manual_review", reason, false, true, false);',
      '}',
      'function decision(status, reason, releaseAllowed, requiresManualReview, rollbackRequired) {',
      '  return { status, reason, releaseAllowed, requiresManualReview, rollbackRequired };',
      '}',
      'module.exports = { evaluateReleaseReadiness };',
      ''
    ].join('\n');
    const happyPathOnlyReleaseReadiness = [
      'function evaluateReleaseReadiness(release = {}, checks = {}, approval = {}, _policy = {}) {',
      '  if (release.status !== "ready") return blocked("release_not_ready");',
      '  if (checks.buildPassed !== true) return blocked("build_failed");',
      '  if (checks.smokePassed !== true) return blocked("smoke_failed", true);',
      '  if (approval.releaseOwnerApproved !== true) return manual("release_owner_approval_required");',
      '  return decision("approved", null, true, false, false);',
      '}',
      'function blocked(reason, rollbackRequired = false) {',
      '  return decision("blocked", reason, false, false, rollbackRequired);',
      '}',
      'function manual(reason) {',
      '  return decision("manual_review", reason, false, true, false);',
      '}',
      'function decision(status, reason, releaseAllowed, requiresManualReview, rollbackRequired) {',
      '  return { status, reason, releaseAllowed, requiresManualReview, rollbackRequired };',
      '}',
      'module.exports = { evaluateReleaseReadiness };',
      ''
    ].join('\n');
    const buggyIncidentResponse = [
      'function evaluateIncidentResponse(_incident = {}, _telemetry = {}, _response = {}, _policy = {}) {',
      '  return decision("monitoring", null, false, false, false);',
      '}',
      'function decision(status, reason, escalationRequired, customerCommsRequired, regulatoryNoticeRequired) {',
      '  return { status, reason, escalationRequired, customerCommsRequired, regulatoryNoticeRequired };',
      '}',
      'module.exports = { evaluateIncidentResponse };',
      ''
    ].join('\n');
    const fixedIncidentResponse = [
      'function evaluateIncidentResponse(incident = {}, telemetry = {}, response = {}, policy = {}) {',
      '  if (incident.status !== "active") return decision("ignored", "incident_not_active", false, false, false);',
      '  if (telemetry.alertConfirmed !== true) return decision("blocked", "alert_not_confirmed", false, false, false);',
      '  if ((telemetry.staleMinutes ?? 0) > (policy.staleTelemetryMinutes ?? 10)) return manual("telemetry_stale", false, false);',
      '  const severity = String(incident.severity ?? "sev3").toLowerCase();',
      '  if (severity === "sev1" && response.onCallAcked !== true) return escalated("on_call_ack_required", false, false);',
      '  if (severity === "sev1" && incident.commanderAssigned !== true) return escalated("incident_commander_required", false, false);',
      '  if ((telemetry.errorBudgetBurnRate ?? 0) >= (policy.sev1BurnRate ?? 8)) return escalated("error_budget_burn", false, false);',
      '  if (incident.customerImpact === true && policy.requireCustomerCommsForImpact === true) {',
      '    if (response.commsPlanReady !== true) return manual("customer_comms_plan_required", true, false);',
      '    if (response.customerCommsApproved !== true) return manual("customer_comms_approval_required", true, false);',
      '  }',
      '  if (incident.securitySignal === true && policy.requireSecurityLeadForSignal === true && response.securityLeadApproved !== true) {',
      '    return escalated("security_lead_required", false, false);',
      '  }',
      '  if (incident.regulatoryImpact === true && policy.requireRegulatoryNotice === true && response.regulatoryNotified !== true) {',
      '    return manual("regulatory_notice_required", false, true);',
      '  }',
      '  if (incident.postmortemOwnerAssigned !== true) return manual("postmortem_owner_required", false, false);',
      '  return decision("monitoring", null, false, false, false);',
      '}',
      'function escalated(reason, customerCommsRequired, regulatoryNoticeRequired) {',
      '  return decision("escalated", reason, true, customerCommsRequired, regulatoryNoticeRequired);',
      '}',
      'function manual(reason, customerCommsRequired, regulatoryNoticeRequired) {',
      '  return decision("manual_review", reason, true, customerCommsRequired, regulatoryNoticeRequired);',
      '}',
      'function decision(status, reason, escalationRequired, customerCommsRequired, regulatoryNoticeRequired) {',
      '  return { status, reason, escalationRequired, customerCommsRequired, regulatoryNoticeRequired };',
      '}',
      'module.exports = { evaluateIncidentResponse };',
      ''
    ].join('\n');
    const happyPathOnlyIncidentResponse = [
      'function evaluateIncidentResponse(incident = {}, telemetry = {}, response = {}) {',
      '  if (incident.status !== "active") return decision("ignored", "incident_not_active", false, false, false);',
      '  if (telemetry.alertConfirmed !== true) return decision("blocked", "alert_not_confirmed", false, false, false);',
      '  if (incident.severity === "sev1" && response.onCallAcked !== true) return decision("escalated", "on_call_ack_required", true, false, false);',
      '  return decision("monitoring", null, false, false, false);',
      '}',
      'function decision(status, reason, escalationRequired, customerCommsRequired, regulatoryNoticeRequired) {',
      '  return { status, reason, escalationRequired, customerCommsRequired, regulatoryNoticeRequired };',
      '}',
      'module.exports = { evaluateIncidentResponse };',
      ''
    ].join('\n');
    const buggyBackupRestore = [
      'function evaluateBackupRestore(_backup = {}, _restore = {}, _approval = {}, _policy = {}) {',
      '  return decision("ready", null, true, false, false);',
      '}',
      'function decision(status, reason, restoreAllowed, manualReviewRequired, emergencyOverrideRequired) {',
      '  return { status, reason, restoreAllowed, manualReviewRequired, emergencyOverrideRequired };',
      '}',
      'module.exports = { evaluateBackupRestore };',
      ''
    ].join('\n');
    const fixedBackupRestore = [
      'function evaluateBackupRestore(backup = {}, restore = {}, approval = {}, policy = {}) {',
      '  if (backup.status !== "available") return blocked("backup_not_available");',
      '  if (backup.encrypted !== true) return blocked("backup_not_encrypted");',
      '  if ((backup.snapshotAgeHours ?? 0) > (policy.maxSnapshotAgeHours ?? 24)) return manual("stale_snapshot");',
      '  if (backup.integrityVerified !== true) return blocked("integrity_check_required");',
      '  const allowed = policy.allowedRestoreEnvironments ?? ["prod"];',
      '  if (!allowed.includes(restore.targetEnvironment)) return blocked("restore_environment_not_allowed");',
      '  if (restore.dataClass === "sensitive" && approval.securityApproved !== true) return manual("security_approval_required");',
      '  if (restore.crossRegion === true && approval.drOwnerApproved !== true) return manual("dr_owner_approval_required");',
      '  if (restore.emergency === true && policy.allowEmergencyOverride === true && approval.incidentCommanderApproved !== true) {',
      '    return decision("manual_review", "emergency_override_required", false, true, true);',
      '  }',
      '  if ((restore.rpoMinutes ?? 0) > (policy.maxRpoMinutes ?? 30)) return manual("rpo_breach");',
      '  if (restore.dryRunPassed !== true) return blocked("dry_run_required");',
      '  if ((restore.drillWithinDays ?? 0) > (policy.maxDrillAgeDays ?? 30)) return manual("dr_drill_stale");',
      '  return decision("ready", null, true, false, false);',
      '}',
      'function blocked(reason) {',
      '  return decision("blocked", reason, false, false, false);',
      '}',
      'function manual(reason) {',
      '  return decision("manual_review", reason, false, true, false);',
      '}',
      'function decision(status, reason, restoreAllowed, manualReviewRequired, emergencyOverrideRequired) {',
      '  return { status, reason, restoreAllowed, manualReviewRequired, emergencyOverrideRequired };',
      '}',
      'module.exports = { evaluateBackupRestore };',
      ''
    ].join('\n');
    const happyPathOnlyBackupRestore = [
      'function evaluateBackupRestore(backup = {}, restore = {}, _approval = {}, _policy = {}) {',
      '  if (backup.status !== "available") return decision("blocked", "backup_not_available", false, false, false);',
      '  if (backup.encrypted !== true) return decision("blocked", "backup_not_encrypted", false, false, false);',
      '  if (restore.dryRunPassed !== true) return decision("blocked", "dry_run_required", false, false, false);',
      '  return decision("ready", null, true, false, false);',
      '}',
      'function decision(status, reason, restoreAllowed, manualReviewRequired, emergencyOverrideRequired) {',
      '  return { status, reason, restoreAllowed, manualReviewRequired, emergencyOverrideRequired };',
      '}',
      'module.exports = { evaluateBackupRestore };',
      ''
    ].join('\n');
    const buggyUsageBilling = [
      'function calculateUsageInvoice(_account = {}, _usage = {}, _pricing = {}, _policy = {}) {',
      '  return decision("approved", null, true, false, 0);',
      '}',
      'function decision(status, reason, overageBillable, manualReviewRequired, invoiceCents) {',
      '  return { status, reason, overageBillable, manualReviewRequired, invoiceCents };',
      '}',
      'module.exports = { calculateUsageInvoice };',
      ''
    ].join('\n');
    const fixedUsageBilling = [
      'function calculateUsageInvoice(account = {}, usage = {}, pricing = {}, policy = {}) {',
      '  if (account.status !== "active") return decision("blocked", "account_not_active", false, false, 0);',
      '  if (usage.status !== "finalized") return decision("manual_review", "usage_not_finalized", false, true, 0);',
      '  if (account.currency && pricing.currency && account.currency !== pricing.currency) {',
      '    return decision("blocked", "currency_mismatch", false, false, 0);',
      '  }',
      '  const includedUnits = account.includedUnits ?? policy.defaultIncludedUnits ?? 0;',
      '  const billableUnits = usage.billableUnits ?? 0;',
      '  const overageUnits = Math.max(0, billableUnits - includedUnits);',
      '  if (overageUnits === 0) return decision("approved", null, false, false, 0);',
      '  const invoiceCents = Math.round(overageUnits * (pricing.unitPriceCents ?? 0));',
      '  if (policy.maxOverageCents != null && invoiceCents > policy.maxOverageCents) {',
      '    return decision("manual_review", "overage_cap_exceeded", true, true, invoiceCents);',
      '  }',
      '  return decision("approved", null, true, false, invoiceCents);',
      '}',
      'function decision(status, reason, overageBillable, manualReviewRequired, invoiceCents) {',
      '  return { status, reason, overageBillable, manualReviewRequired, invoiceCents };',
      '}',
      'module.exports = { calculateUsageInvoice };',
      ''
    ].join('\n');
    const happyPathOnlyUsageBilling = [
      'function calculateUsageInvoice(account = {}, usage = {}, pricing = {}, _policy = {}) {',
      '  const includedUnits = account.includedUnits ?? 0;',
      '  const overageUnits = Math.max(0, (usage.billableUnits ?? 0) - includedUnits);',
      '  const invoiceCents = Math.round(overageUnits * (pricing.unitPriceCents ?? 0));',
      '  return decision("approved", null, invoiceCents > 0, false, invoiceCents);',
      '}',
      'function decision(status, reason, overageBillable, manualReviewRequired, invoiceCents) {',
      '  return { status, reason, overageBillable, manualReviewRequired, invoiceCents };',
      '}',
      'module.exports = { calculateUsageInvoice };',
      ''
    ].join('\n');
    const buggyServiceOutageCredit = [
      'function calculateServiceOutageCredit(_customer = {}, _outage = {}, _policy = {}, _ledger = {}) {',
      '  return decision("approved", null, true, false, 0);',
      '}',
      'function decision(status, reason, creditEligible, manualReviewRequired, creditCents) {',
      '  return { status, reason, creditEligible, manualReviewRequired, creditCents };',
      '}',
      'module.exports = { calculateServiceOutageCredit };',
      ''
    ].join('\n');
    const fixedServiceOutageCredit = [
      'function calculateServiceOutageCredit(customer = {}, outage = {}, policy = {}, ledger = {}) {',
      '  if (customer.status !== "active") return decision("blocked", "customer_not_active", false, false, 0);',
      '  if (outage.verified !== true) return decision("manual_review", "outage_not_verified", false, true, 0);',
      '  if (Array.isArray(policy.eligibleSeverities) && !policy.eligibleSeverities.includes(outage.severity)) {',
      '    return decision("blocked", "severity_not_eligible", false, false, 0);',
      '  }',
      '  if (Array.isArray(policy.eligiblePlans) && !policy.eligiblePlans.includes(customer.plan)) {',
      '    return decision("blocked", "plan_not_eligible", false, false, 0);',
      '  }',
      '  if ((ledger.creditedOutageIds ?? []).includes(outage.id)) {',
      '    return decision("blocked", "duplicate_credit", false, false, 0);',
      '  }',
      '  const durationMinutes = outage.durationMinutes ?? 0;',
      '  if (durationMinutes < (policy.minDurationMinutes ?? 0)) {',
      '    return decision("approved", null, false, false, 0);',
      '  }',
      '  const creditCents = Math.round(durationMinutes * (policy.creditPerMinuteCents ?? 0));',
      '  if (policy.maxCreditCents != null && creditCents > policy.maxCreditCents) {',
      '    return decision("manual_review", "credit_cap_exceeded", true, true, creditCents);',
      '  }',
      '  if (policy.manualReviewThresholdCents != null && creditCents > policy.manualReviewThresholdCents) {',
      '    return decision("manual_review", "manual_review_threshold_exceeded", true, true, creditCents);',
      '  }',
      '  return decision("approved", null, true, false, creditCents);',
      '}',
      'function decision(status, reason, creditEligible, manualReviewRequired, creditCents) {',
      '  return { status, reason, creditEligible, manualReviewRequired, creditCents };',
      '}',
      'module.exports = { calculateServiceOutageCredit };',
      ''
    ].join('\n');
    const happyPathOnlyServiceOutageCredit = [
      'function calculateServiceOutageCredit(_customer = {}, outage = {}, policy = {}, _ledger = {}) {',
      '  const durationMinutes = outage.durationMinutes ?? 0;',
      '  const eligible = durationMinutes >= (policy.minDurationMinutes ?? 0);',
      '  const creditCents = eligible ? Math.round(durationMinutes * (policy.creditPerMinuteCents ?? 0)) : 0;',
      '  return decision("approved", null, eligible, false, creditCents);',
      '}',
      'function decision(status, reason, creditEligible, manualReviewRequired, creditCents) {',
      '  return { status, reason, creditEligible, manualReviewRequired, creditCents };',
      '}',
      'module.exports = { calculateServiceOutageCredit };',
      ''
    ].join('\n');
    const buggyContractRenewal = [
      'function evaluateContractRenewal(_account = {}, _contract = {}, _notice = {}, _policy = {}, _now = new Date()) {',
      '  return decision("approved", null, true, false, 0);',
      '}',
      'function decision(status, reason, renewalApproved, requiresManualReview, renewalAmountCents) {',
      '  return { status, reason, renewalApproved, requiresManualReview, renewalAmountCents };',
      '}',
      'module.exports = { evaluateContractRenewal };',
      ''
    ].join('\n');
    const fixedContractRenewal = [
      'function evaluateContractRenewal(account = {}, contract = {}, notice = {}, policy = {}, now = new Date()) {',
      '  const renewalAt = new Date(contract.renewalAt ?? contract.endsAt ?? now);',
      '  const nowDate = new Date(now);',
      '  const daysUntilRenewal = Math.ceil((renewalAt.getTime() - nowDate.getTime()) / 86400000);',
      '  const minNoticeDays = policy.minNoticeDays ?? 30;',
      '  if (account.status !== "active") return decision("blocked", "account_not_active", false, false, 0);',
      '  if (contract.status !== "active") return decision("blocked", "contract_not_active", false, false, 0);',
      '  if (contract.autoRenew !== true) return decision("blocked", "auto_renew_disabled", false, false, 0);',
      '  if (notice.sent !== true) return decision("manual_review", "renewal_notice_not_sent", false, true, 0);',
      '  if (daysUntilRenewal < minNoticeDays) return decision("manual_review", "renewal_notice_window_missed", false, true, 0);',
      '  if (policy.requireBillingCurrent === true && account.billingCurrent !== true) return decision("manual_review", "billing_not_current", false, true, 0);',
      '  if (contract.pendingCancellation === true) return decision("blocked", "pending_cancellation", false, false, 0);',
      '  if (contract.termsChanged === true && notice.termsAccepted !== true) return decision("manual_review", "terms_change_unaccepted", false, true, 0);',
      '  return decision("approved", null, true, false, contract.renewalAmountCents ?? contract.amountCents ?? 0);',
      '}',
      'function decision(status, reason, renewalApproved, requiresManualReview, renewalAmountCents) {',
      '  return { status, reason, renewalApproved, requiresManualReview, renewalAmountCents };',
      '}',
      'module.exports = { evaluateContractRenewal };',
      ''
    ].join('\n');
    const happyPathOnlyContractRenewal = [
      'function evaluateContractRenewal(_account = {}, contract = {}, _notice = {}, _policy = {}, _now = new Date()) {',
      '  return decision("approved", null, true, false, contract.renewalAmountCents ?? contract.amountCents ?? 0);',
      '}',
      'function decision(status, reason, renewalApproved, requiresManualReview, renewalAmountCents) {',
      '  return { status, reason, renewalApproved, requiresManualReview, renewalAmountCents };',
      '}',
      'module.exports = { evaluateContractRenewal };',
      ''
    ].join('\n');
    async function writeAllFixedFixtures(worktree) {
      await writeCartFixture(worktree, fixedCart);
      await writeProfileFixture(worktree, fixedProfile);
      await writeOrderFixture(worktree, fixedOrder);
      await writeInventoryFixture(worktree, fixedInventory);
      await writeShippingFixture(worktree, fixedShipping);
      await writePaymentFixture(worktree, fixedPayment);
      await writeRefundFixture(worktree, fixedRefund);
      await writeCouponFixture(worktree, fixedCoupon);
      await writeLoyaltyFixture(worktree, fixedLoyalty);
      await writeSubscriptionFixture(worktree, fixedSubscription);
      await writeEntitlementFixture(worktree, fixedEntitlement);
      await writeGiftCardFixture(worktree, fixedGiftCard);
      await writePayoutFixture(worktree, fixedPayout);
      await writeAppointmentFixture(worktree, fixedAppointment);
      await writeWarrantyFixture(worktree, fixedWarranty);
      await writeSupportTicketFixture(worktree, fixedSupportTicket);
      await writePaymentDisputeFixture(worktree, fixedPaymentDispute);
      await writeWarehouseAllocationFixture(worktree, fixedWarehouseAllocation);
      await writeInsuranceClaimFixture(worktree, fixedInsuranceClaim);
      await writePayrollFixture(worktree, fixedPayroll);
      await writeVendorInvoiceFixture(worktree, fixedVendorInvoice);
      await writeExpenseReimbursementFixture(worktree, fixedExpenseReimbursement);
      await writeLoanUnderwritingFixture(worktree, fixedLoanUnderwriting);
      await writeAccountClosureFixture(worktree, fixedAccountClosure);
      await writeMerchantOnboardingFixture(worktree, fixedMerchantOnboarding);
      await writeDataRetentionFixture(worktree, fixedDataRetentionDeletion);
      await writeContentModerationFixture(
        worktree,
        fixedContentModerationAppeal
      );
      await writeFraudRiskFixture(worktree, fixedFraudRisk);
      await writeCreditMemoFixture(worktree, fixedCreditMemo);
      await writePaymentSettlementFixture(worktree, fixedPaymentSettlement);
      await writeTaxFilingFixture(worktree, fixedTaxFiling);
      await writePrivacyConsentFixture(worktree, fixedPrivacyConsent);
      await writeAccessReviewFixture(worktree, fixedAccessReview);
      await writeReleaseReadinessFixture(worktree, fixedReleaseReadiness);
      await writeIncidentResponseFixture(worktree, fixedIncidentResponse);
      await writeBackupRestoreFixture(worktree, fixedBackupRestore);
      await writeUsageBillingFixture(worktree, fixedUsageBilling);
      await writeServiceOutageCreditFixture(worktree, fixedServiceOutageCredit);
      await writeContractRenewalFixture(worktree, fixedContractRenewal);
    }
    await writeCartFixture(baseWorktree, buggyCart);
    await writeCartFixture(candidateWorktree, fixedCart);
    await writeCartFixture(goodWorktree, fixedCart);
    await writeCartFixture(badWorktree, buggyCart);
    await writeCartFixture(hardcodedWorktree, hardcodedCart);
    await writeCartFixture(
      defaultQuantityHardcodedWorktree,
      defaultQuantityHardcodedCart
    );
    await writeCartFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      zeroQuantityTruthinessHardcodedCart
    );
    await writeCartFixture(discountHardcodedWorktree, discountHardcodedCart);
    await writeCartFixture(taxHardcodedWorktree, taxHardcodedCart);
    await writeCartFixture(roundingHardcodedWorktree, roundingHardcodedCart);
    await writeCartFixture(profileVisibilityHardcodedWorktree, fixedCart);
    await writeCartFixture(profileSuspensionHardcodedWorktree, fixedCart);
    await writeCartFixture(orderApprovalHardcodedWorktree, fixedCart);
    await writeCartFixture(inventoryReservationHardcodedWorktree, fixedCart);
    await writeCartFixture(shippingEligibilityHardcodedWorktree, fixedCart);
    await writeCartFixture(paymentAuthorizationHardcodedWorktree, fixedCart);
    await writeCartFixture(refundEligibilityHardcodedWorktree, fixedCart);
    await writeCartFixture(couponApplicationHardcodedWorktree, fixedCart);
    await writeCartFixture(loyaltyPointsHardcodedWorktree, fixedCart);
    await writeProfileFixture(baseWorktree, buggyProfile);
    await writeProfileFixture(candidateWorktree, fixedProfile);
    await writeProfileFixture(goodWorktree, fixedProfile);
    await writeProfileFixture(badWorktree, fixedProfile);
    await writeProfileFixture(hardcodedWorktree, fixedProfile);
    await writeProfileFixture(defaultQuantityHardcodedWorktree, fixedProfile);
    await writeProfileFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      fixedProfile
    );
    await writeProfileFixture(discountHardcodedWorktree, fixedProfile);
    await writeProfileFixture(taxHardcodedWorktree, fixedProfile);
    await writeProfileFixture(roundingHardcodedWorktree, fixedProfile);
    await writeProfileFixture(
      profileVisibilityHardcodedWorktree,
      publicOnlyProfile
    );
    await writeProfileFixture(
      profileSuspensionHardcodedWorktree,
      noSuspensionProfile
    );
    await writeProfileFixture(orderApprovalHardcodedWorktree, fixedProfile);
    await writeProfileFixture(
      inventoryReservationHardcodedWorktree,
      fixedProfile
    );
    await writeProfileFixture(
      shippingEligibilityHardcodedWorktree,
      fixedProfile
    );
    await writeProfileFixture(
      paymentAuthorizationHardcodedWorktree,
      fixedProfile
    );
    await writeProfileFixture(refundEligibilityHardcodedWorktree, fixedProfile);
    await writeProfileFixture(couponApplicationHardcodedWorktree, fixedProfile);
    await writeProfileFixture(loyaltyPointsHardcodedWorktree, fixedProfile);
    await writeOrderFixture(baseWorktree, buggyOrder);
    await writeOrderFixture(candidateWorktree, fixedOrder);
    await writeOrderFixture(goodWorktree, fixedOrder);
    await writeOrderFixture(badWorktree, fixedOrder);
    await writeOrderFixture(hardcodedWorktree, fixedOrder);
    await writeOrderFixture(defaultQuantityHardcodedWorktree, fixedOrder);
    await writeOrderFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      fixedOrder
    );
    await writeOrderFixture(discountHardcodedWorktree, fixedOrder);
    await writeOrderFixture(taxHardcodedWorktree, fixedOrder);
    await writeOrderFixture(roundingHardcodedWorktree, fixedOrder);
    await writeOrderFixture(profileVisibilityHardcodedWorktree, fixedOrder);
    await writeOrderFixture(profileSuspensionHardcodedWorktree, fixedOrder);
    await writeOrderFixture(orderApprovalHardcodedWorktree, happyPathOnlyOrder);
    await writeOrderFixture(inventoryReservationHardcodedWorktree, fixedOrder);
    await writeOrderFixture(shippingEligibilityHardcodedWorktree, fixedOrder);
    await writeOrderFixture(paymentAuthorizationHardcodedWorktree, fixedOrder);
    await writeOrderFixture(refundEligibilityHardcodedWorktree, fixedOrder);
    await writeOrderFixture(couponApplicationHardcodedWorktree, fixedOrder);
    await writeOrderFixture(loyaltyPointsHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(baseWorktree, buggyInventory);
    await writeInventoryFixture(candidateWorktree, fixedInventory);
    await writeInventoryFixture(goodWorktree, fixedInventory);
    await writeInventoryFixture(badWorktree, fixedInventory);
    await writeInventoryFixture(hardcodedWorktree, fixedInventory);
    await writeInventoryFixture(
      defaultQuantityHardcodedWorktree,
      fixedInventory
    );
    await writeInventoryFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      fixedInventory
    );
    await writeInventoryFixture(discountHardcodedWorktree, fixedInventory);
    await writeInventoryFixture(taxHardcodedWorktree, fixedInventory);
    await writeInventoryFixture(roundingHardcodedWorktree, fixedInventory);
    await writeInventoryFixture(
      profileVisibilityHardcodedWorktree,
      fixedInventory
    );
    await writeInventoryFixture(
      profileSuspensionHardcodedWorktree,
      fixedInventory
    );
    await writeInventoryFixture(orderApprovalHardcodedWorktree, fixedInventory);
    await writeInventoryFixture(
      inventoryReservationHardcodedWorktree,
      happyPathOnlyInventory
    );
    await writeInventoryFixture(
      shippingEligibilityHardcodedWorktree,
      fixedInventory
    );
    await writeInventoryFixture(
      paymentAuthorizationHardcodedWorktree,
      fixedInventory
    );
    await writeInventoryFixture(
      refundEligibilityHardcodedWorktree,
      fixedInventory
    );
    await writeInventoryFixture(
      couponApplicationHardcodedWorktree,
      fixedInventory
    );
    await writeInventoryFixture(loyaltyPointsHardcodedWorktree, fixedInventory);
    await writeShippingFixture(baseWorktree, buggyShipping);
    await writeShippingFixture(candidateWorktree, fixedShipping);
    await writeShippingFixture(goodWorktree, fixedShipping);
    await writeShippingFixture(badWorktree, fixedShipping);
    await writeShippingFixture(hardcodedWorktree, fixedShipping);
    await writeShippingFixture(defaultQuantityHardcodedWorktree, fixedShipping);
    await writeShippingFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      fixedShipping
    );
    await writeShippingFixture(discountHardcodedWorktree, fixedShipping);
    await writeShippingFixture(taxHardcodedWorktree, fixedShipping);
    await writeShippingFixture(roundingHardcodedWorktree, fixedShipping);
    await writeShippingFixture(
      profileVisibilityHardcodedWorktree,
      fixedShipping
    );
    await writeShippingFixture(
      profileSuspensionHardcodedWorktree,
      fixedShipping
    );
    await writeShippingFixture(orderApprovalHardcodedWorktree, fixedShipping);
    await writeShippingFixture(
      inventoryReservationHardcodedWorktree,
      fixedShipping
    );
    await writeShippingFixture(
      shippingEligibilityHardcodedWorktree,
      happyPathOnlyShipping
    );
    await writeShippingFixture(
      paymentAuthorizationHardcodedWorktree,
      fixedShipping
    );
    await writeShippingFixture(
      refundEligibilityHardcodedWorktree,
      fixedShipping
    );
    await writeShippingFixture(
      couponApplicationHardcodedWorktree,
      fixedShipping
    );
    await writeShippingFixture(loyaltyPointsHardcodedWorktree, fixedShipping);
    await writePaymentFixture(baseWorktree, buggyPayment);
    await writePaymentFixture(candidateWorktree, fixedPayment);
    await writePaymentFixture(goodWorktree, fixedPayment);
    await writePaymentFixture(badWorktree, fixedPayment);
    await writePaymentFixture(hardcodedWorktree, fixedPayment);
    await writePaymentFixture(defaultQuantityHardcodedWorktree, fixedPayment);
    await writePaymentFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      fixedPayment
    );
    await writePaymentFixture(discountHardcodedWorktree, fixedPayment);
    await writePaymentFixture(taxHardcodedWorktree, fixedPayment);
    await writePaymentFixture(roundingHardcodedWorktree, fixedPayment);
    await writePaymentFixture(profileVisibilityHardcodedWorktree, fixedPayment);
    await writePaymentFixture(profileSuspensionHardcodedWorktree, fixedPayment);
    await writePaymentFixture(orderApprovalHardcodedWorktree, fixedPayment);
    await writePaymentFixture(
      inventoryReservationHardcodedWorktree,
      fixedPayment
    );
    await writePaymentFixture(
      shippingEligibilityHardcodedWorktree,
      fixedPayment
    );
    await writePaymentFixture(
      paymentAuthorizationHardcodedWorktree,
      happyPathOnlyPayment
    );
    await writePaymentFixture(refundEligibilityHardcodedWorktree, fixedPayment);
    await writePaymentFixture(couponApplicationHardcodedWorktree, fixedPayment);
    await writePaymentFixture(loyaltyPointsHardcodedWorktree, fixedPayment);
    await writeRefundFixture(baseWorktree, buggyRefund);
    await writeRefundFixture(candidateWorktree, fixedRefund);
    await writeRefundFixture(goodWorktree, fixedRefund);
    await writeRefundFixture(badWorktree, fixedRefund);
    await writeRefundFixture(hardcodedWorktree, fixedRefund);
    await writeRefundFixture(defaultQuantityHardcodedWorktree, fixedRefund);
    await writeRefundFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      fixedRefund
    );
    await writeRefundFixture(discountHardcodedWorktree, fixedRefund);
    await writeRefundFixture(taxHardcodedWorktree, fixedRefund);
    await writeRefundFixture(roundingHardcodedWorktree, fixedRefund);
    await writeRefundFixture(profileVisibilityHardcodedWorktree, fixedRefund);
    await writeRefundFixture(profileSuspensionHardcodedWorktree, fixedRefund);
    await writeRefundFixture(orderApprovalHardcodedWorktree, fixedRefund);
    await writeRefundFixture(
      inventoryReservationHardcodedWorktree,
      fixedRefund
    );
    await writeRefundFixture(shippingEligibilityHardcodedWorktree, fixedRefund);
    await writeRefundFixture(
      paymentAuthorizationHardcodedWorktree,
      fixedRefund
    );
    await writeRefundFixture(
      refundEligibilityHardcodedWorktree,
      happyPathOnlyRefund
    );
    await writeRefundFixture(couponApplicationHardcodedWorktree, fixedRefund);
    await writeRefundFixture(loyaltyPointsHardcodedWorktree, fixedRefund);
    await writeCouponFixture(baseWorktree, buggyCoupon);
    await writeCouponFixture(candidateWorktree, fixedCoupon);
    await writeCouponFixture(goodWorktree, fixedCoupon);
    await writeCouponFixture(badWorktree, fixedCoupon);
    await writeCouponFixture(hardcodedWorktree, fixedCoupon);
    await writeCouponFixture(defaultQuantityHardcodedWorktree, fixedCoupon);
    await writeCouponFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      fixedCoupon
    );
    await writeCouponFixture(discountHardcodedWorktree, fixedCoupon);
    await writeCouponFixture(taxHardcodedWorktree, fixedCoupon);
    await writeCouponFixture(roundingHardcodedWorktree, fixedCoupon);
    await writeCouponFixture(profileVisibilityHardcodedWorktree, fixedCoupon);
    await writeCouponFixture(profileSuspensionHardcodedWorktree, fixedCoupon);
    await writeCouponFixture(orderApprovalHardcodedWorktree, fixedCoupon);
    await writeCouponFixture(
      inventoryReservationHardcodedWorktree,
      fixedCoupon
    );
    await writeCouponFixture(shippingEligibilityHardcodedWorktree, fixedCoupon);
    await writeCouponFixture(
      paymentAuthorizationHardcodedWorktree,
      fixedCoupon
    );
    await writeCouponFixture(refundEligibilityHardcodedWorktree, fixedCoupon);
    await writeCouponFixture(
      couponApplicationHardcodedWorktree,
      happyPathOnlyCoupon
    );
    await writeCouponFixture(loyaltyPointsHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(baseWorktree, buggyLoyalty);
    await writeLoyaltyFixture(candidateWorktree, fixedLoyalty);
    await writeLoyaltyFixture(goodWorktree, fixedLoyalty);
    await writeLoyaltyFixture(badWorktree, fixedLoyalty);
    await writeLoyaltyFixture(hardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(defaultQuantityHardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(
      zeroQuantityTruthinessHardcodedWorktree,
      fixedLoyalty
    );
    await writeLoyaltyFixture(discountHardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(taxHardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(roundingHardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(profileVisibilityHardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(profileSuspensionHardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(orderApprovalHardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(
      inventoryReservationHardcodedWorktree,
      fixedLoyalty
    );
    await writeLoyaltyFixture(
      shippingEligibilityHardcodedWorktree,
      fixedLoyalty
    );
    await writeLoyaltyFixture(
      paymentAuthorizationHardcodedWorktree,
      fixedLoyalty
    );
    await writeLoyaltyFixture(refundEligibilityHardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(couponApplicationHardcodedWorktree, fixedLoyalty);
    await writeLoyaltyFixture(
      loyaltyPointsHardcodedWorktree,
      happyPathOnlyLoyalty
    );
    await writeCartFixture(entitlementAccessHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      entitlementAccessHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(entitlementAccessHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      entitlementAccessHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      entitlementAccessHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      entitlementAccessHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(entitlementAccessHardcodedWorktree, fixedRefund);
    await writeCouponFixture(entitlementAccessHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(
      entitlementAccessHardcodedWorktree,
      fixedLoyalty
    );
    await writeCartFixture(subscriptionRenewalHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      subscriptionRenewalHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(subscriptionRenewalHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      subscriptionRenewalHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      subscriptionRenewalHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      subscriptionRenewalHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(subscriptionRenewalHardcodedWorktree, fixedRefund);
    await writeCouponFixture(subscriptionRenewalHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(
      subscriptionRenewalHardcodedWorktree,
      fixedLoyalty
    );
    await writeCartFixture(giftCardRedemptionHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      giftCardRedemptionHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(giftCardRedemptionHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      giftCardRedemptionHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      giftCardRedemptionHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      giftCardRedemptionHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(giftCardRedemptionHardcodedWorktree, fixedRefund);
    await writeCouponFixture(giftCardRedemptionHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(
      giftCardRedemptionHardcodedWorktree,
      fixedLoyalty
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree
    ]) {
      await writeSubscriptionFixture(worktree, fixedSubscription);
    }
    await writeSubscriptionFixture(baseWorktree, buggySubscription);
    await writeSubscriptionFixture(
      subscriptionRenewalHardcodedWorktree,
      happyPathOnlySubscription
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree
    ]) {
      await writeEntitlementFixture(worktree, fixedEntitlement);
    }
    await writeEntitlementFixture(baseWorktree, buggyEntitlement);
    await writeEntitlementFixture(
      entitlementAccessHardcodedWorktree,
      happyPathOnlyEntitlement
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree
    ]) {
      await writeGiftCardFixture(worktree, fixedGiftCard);
    }
    await writeGiftCardFixture(baseWorktree, buggyGiftCard);
    await writeGiftCardFixture(
      giftCardRedemptionHardcodedWorktree,
      happyPathOnlyGiftCard
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree
    ]) {
      await writePayoutFixture(worktree, fixedPayout);
    }
    await writePayoutFixture(baseWorktree, buggyPayout);
    await writePayoutFixture(
      sellerPayoutHardcodedWorktree,
      happyPathOnlyPayout
    );
    await writeCartFixture(sellerPayoutHardcodedWorktree, fixedCart);
    await writeProfileFixture(sellerPayoutHardcodedWorktree, fixedProfile);
    await writeOrderFixture(sellerPayoutHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(sellerPayoutHardcodedWorktree, fixedInventory);
    await writeShippingFixture(sellerPayoutHardcodedWorktree, fixedShipping);
    await writePaymentFixture(sellerPayoutHardcodedWorktree, fixedPayment);
    await writeRefundFixture(sellerPayoutHardcodedWorktree, fixedRefund);
    await writeCouponFixture(sellerPayoutHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(sellerPayoutHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      sellerPayoutHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      sellerPayoutHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(sellerPayoutHardcodedWorktree, fixedGiftCard);
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree
    ]) {
      await writeAppointmentFixture(worktree, fixedAppointment);
    }
    await writeAppointmentFixture(baseWorktree, buggyAppointment);
    await writeAppointmentFixture(
      appointmentCancellationHardcodedWorktree,
      happyPathOnlyAppointment
    );
    await writeCartFixture(appointmentCancellationHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      appointmentCancellationHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(appointmentCancellationHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      appointmentCancellationHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      appointmentCancellationHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      appointmentCancellationHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(
      appointmentCancellationHardcodedWorktree,
      fixedRefund
    );
    await writeCouponFixture(
      appointmentCancellationHardcodedWorktree,
      fixedCoupon
    );
    await writeLoyaltyFixture(
      appointmentCancellationHardcodedWorktree,
      fixedLoyalty
    );
    await writeSubscriptionFixture(
      appointmentCancellationHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      appointmentCancellationHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      appointmentCancellationHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(
      appointmentCancellationHardcodedWorktree,
      fixedPayout
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree
    ]) {
      await writeWarrantyFixture(worktree, fixedWarranty);
    }
    await writeWarrantyFixture(baseWorktree, buggyWarranty);
    await writeWarrantyFixture(
      warrantyClaimHardcodedWorktree,
      happyPathOnlyWarranty
    );
    await writeCartFixture(warrantyClaimHardcodedWorktree, fixedCart);
    await writeProfileFixture(warrantyClaimHardcodedWorktree, fixedProfile);
    await writeOrderFixture(warrantyClaimHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(warrantyClaimHardcodedWorktree, fixedInventory);
    await writeShippingFixture(warrantyClaimHardcodedWorktree, fixedShipping);
    await writePaymentFixture(warrantyClaimHardcodedWorktree, fixedPayment);
    await writeRefundFixture(warrantyClaimHardcodedWorktree, fixedRefund);
    await writeCouponFixture(warrantyClaimHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(warrantyClaimHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      warrantyClaimHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      warrantyClaimHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(warrantyClaimHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(warrantyClaimHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      warrantyClaimHardcodedWorktree,
      fixedAppointment
    );
    await writeCartFixture(supportTicketRoutingHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(supportTicketRoutingHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(supportTicketRoutingHardcodedWorktree, fixedRefund);
    await writeCouponFixture(supportTicketRoutingHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedLoyalty
    );
    await writeSubscriptionFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(supportTicketRoutingHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(
      supportTicketRoutingHardcodedWorktree,
      fixedWarranty
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree
    ]) {
      await writeSupportTicketFixture(worktree, fixedSupportTicket);
    }
    await writeSupportTicketFixture(baseWorktree, buggySupportTicket);
    await writeSupportTicketFixture(
      supportTicketRoutingHardcodedWorktree,
      happyPathOnlySupportTicket
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree
    ]) {
      await writePaymentDisputeFixture(worktree, fixedPaymentDispute);
    }
    await writePaymentDisputeFixture(baseWorktree, buggyPaymentDispute);
    await writePaymentDisputeFixture(
      paymentDisputeHardcodedWorktree,
      happyPathOnlyPaymentDispute
    );
    await writeCartFixture(paymentDisputeHardcodedWorktree, fixedCart);
    await writeProfileFixture(paymentDisputeHardcodedWorktree, fixedProfile);
    await writeOrderFixture(paymentDisputeHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(paymentDisputeHardcodedWorktree, fixedInventory);
    await writeShippingFixture(paymentDisputeHardcodedWorktree, fixedShipping);
    await writePaymentFixture(paymentDisputeHardcodedWorktree, fixedPayment);
    await writeRefundFixture(paymentDisputeHardcodedWorktree, fixedRefund);
    await writeCouponFixture(paymentDisputeHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(paymentDisputeHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      paymentDisputeHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      paymentDisputeHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(paymentDisputeHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(paymentDisputeHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      paymentDisputeHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(paymentDisputeHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      paymentDisputeHardcodedWorktree,
      fixedSupportTicket
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree
    ]) {
      await writeWarehouseAllocationFixture(worktree, fixedWarehouseAllocation);
    }
    await writeWarehouseAllocationFixture(
      baseWorktree,
      buggyWarehouseAllocation
    );
    await writeWarehouseAllocationFixture(
      warehouseAllocationHardcodedWorktree,
      happyPathOnlyWarehouseAllocation
    );
    await writeCartFixture(warehouseAllocationHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      warehouseAllocationHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(warehouseAllocationHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      warehouseAllocationHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      warehouseAllocationHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      warehouseAllocationHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(warehouseAllocationHardcodedWorktree, fixedRefund);
    await writeCouponFixture(warehouseAllocationHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(
      warehouseAllocationHardcodedWorktree,
      fixedLoyalty
    );
    await writeSubscriptionFixture(
      warehouseAllocationHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      warehouseAllocationHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      warehouseAllocationHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(warehouseAllocationHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      warehouseAllocationHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(
      warehouseAllocationHardcodedWorktree,
      fixedWarranty
    );
    await writeSupportTicketFixture(
      warehouseAllocationHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      warehouseAllocationHardcodedWorktree,
      fixedPaymentDispute
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree
    ]) {
      await writeInsuranceClaimFixture(worktree, fixedInsuranceClaim);
    }
    await writeInsuranceClaimFixture(baseWorktree, buggyInsuranceClaim);
    await writeInsuranceClaimFixture(
      insuranceClaimHardcodedWorktree,
      happyPathOnlyInsuranceClaim
    );
    await writeCartFixture(insuranceClaimHardcodedWorktree, fixedCart);
    await writeProfileFixture(insuranceClaimHardcodedWorktree, fixedProfile);
    await writeOrderFixture(insuranceClaimHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      insuranceClaimHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(insuranceClaimHardcodedWorktree, fixedShipping);
    await writePaymentFixture(insuranceClaimHardcodedWorktree, fixedPayment);
    await writeRefundFixture(insuranceClaimHardcodedWorktree, fixedRefund);
    await writeCouponFixture(insuranceClaimHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(insuranceClaimHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      insuranceClaimHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      insuranceClaimHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(insuranceClaimHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(insuranceClaimHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      insuranceClaimHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(insuranceClaimHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      insuranceClaimHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      insuranceClaimHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      insuranceClaimHardcodedWorktree,
      fixedWarehouseAllocation
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree
    ]) {
      await writePayrollFixture(worktree, fixedPayroll);
    }
    await writePayrollFixture(baseWorktree, buggyPayroll);
    await writePayrollFixture(
      payrollOvertimeHardcodedWorktree,
      happyPathOnlyPayroll
    );
    await writeCartFixture(payrollOvertimeHardcodedWorktree, fixedCart);
    await writeProfileFixture(payrollOvertimeHardcodedWorktree, fixedProfile);
    await writeOrderFixture(payrollOvertimeHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(payrollOvertimeHardcodedWorktree, fixedInventory);
    await writeShippingFixture(payrollOvertimeHardcodedWorktree, fixedShipping);
    await writePaymentFixture(payrollOvertimeHardcodedWorktree, fixedPayment);
    await writeRefundFixture(payrollOvertimeHardcodedWorktree, fixedRefund);
    await writeCouponFixture(payrollOvertimeHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(payrollOvertimeHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      payrollOvertimeHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      payrollOvertimeHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(payrollOvertimeHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(payrollOvertimeHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      payrollOvertimeHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(payrollOvertimeHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      payrollOvertimeHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      payrollOvertimeHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      payrollOvertimeHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      payrollOvertimeHardcodedWorktree,
      fixedInsuranceClaim
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree
    ]) {
      await writeVendorInvoiceFixture(worktree, fixedVendorInvoice);
    }
    await writeVendorInvoiceFixture(baseWorktree, buggyVendorInvoice);
    await writeVendorInvoiceFixture(
      vendorInvoiceHardcodedWorktree,
      happyPathOnlyVendorInvoice
    );
    await writeCartFixture(vendorInvoiceHardcodedWorktree, fixedCart);
    await writeProfileFixture(vendorInvoiceHardcodedWorktree, fixedProfile);
    await writeOrderFixture(vendorInvoiceHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(vendorInvoiceHardcodedWorktree, fixedInventory);
    await writeShippingFixture(vendorInvoiceHardcodedWorktree, fixedShipping);
    await writePaymentFixture(vendorInvoiceHardcodedWorktree, fixedPayment);
    await writeRefundFixture(vendorInvoiceHardcodedWorktree, fixedRefund);
    await writeCouponFixture(vendorInvoiceHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(vendorInvoiceHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      vendorInvoiceHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      vendorInvoiceHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(vendorInvoiceHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(vendorInvoiceHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      vendorInvoiceHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(vendorInvoiceHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      vendorInvoiceHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      vendorInvoiceHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      vendorInvoiceHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      vendorInvoiceHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(vendorInvoiceHardcodedWorktree, fixedPayroll);
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree
    ]) {
      await writeExpenseReimbursementFixture(
        worktree,
        fixedExpenseReimbursement
      );
    }
    await writeExpenseReimbursementFixture(
      baseWorktree,
      buggyExpenseReimbursement
    );
    await writeExpenseReimbursementFixture(
      expenseReimbursementHardcodedWorktree,
      happyPathOnlyExpenseReimbursement
    );
    await writeCartFixture(expenseReimbursementHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      expenseReimbursementHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(expenseReimbursementHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      expenseReimbursementHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      expenseReimbursementHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      expenseReimbursementHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(expenseReimbursementHardcodedWorktree, fixedRefund);
    await writeCouponFixture(expenseReimbursementHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(
      expenseReimbursementHardcodedWorktree,
      fixedLoyalty
    );
    await writeSubscriptionFixture(
      expenseReimbursementHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      expenseReimbursementHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      expenseReimbursementHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(expenseReimbursementHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      expenseReimbursementHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(
      expenseReimbursementHardcodedWorktree,
      fixedWarranty
    );
    await writeSupportTicketFixture(
      expenseReimbursementHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      expenseReimbursementHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      expenseReimbursementHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      expenseReimbursementHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(
      expenseReimbursementHardcodedWorktree,
      fixedPayroll
    );
    await writeVendorInvoiceFixture(
      expenseReimbursementHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeLoanUnderwritingFixture(
      expenseReimbursementHardcodedWorktree,
      fixedLoanUnderwriting
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree
    ]) {
      await writeLoanUnderwritingFixture(worktree, fixedLoanUnderwriting);
    }
    await writeLoanUnderwritingFixture(baseWorktree, buggyLoanUnderwriting);
    await writeLoanUnderwritingFixture(
      loanUnderwritingHardcodedWorktree,
      happyPathOnlyLoanUnderwriting
    );
    await writeCartFixture(loanUnderwritingHardcodedWorktree, fixedCart);
    await writeProfileFixture(loanUnderwritingHardcodedWorktree, fixedProfile);
    await writeOrderFixture(loanUnderwritingHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      loanUnderwritingHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(loanUnderwritingHardcodedWorktree, fixedShipping);
    await writePaymentFixture(loanUnderwritingHardcodedWorktree, fixedPayment);
    await writeRefundFixture(loanUnderwritingHardcodedWorktree, fixedRefund);
    await writeCouponFixture(loanUnderwritingHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(loanUnderwritingHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      loanUnderwritingHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      loanUnderwritingHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      loanUnderwritingHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(loanUnderwritingHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      loanUnderwritingHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(loanUnderwritingHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      loanUnderwritingHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      loanUnderwritingHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      loanUnderwritingHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      loanUnderwritingHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(loanUnderwritingHardcodedWorktree, fixedPayroll);
    await writeVendorInvoiceFixture(
      loanUnderwritingHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      loanUnderwritingHardcodedWorktree,
      fixedExpenseReimbursement
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree
    ]) {
      await writeAccountClosureFixture(worktree, fixedAccountClosure);
    }
    await writeAccountClosureFixture(baseWorktree, buggyAccountClosure);
    await writeAccountClosureFixture(
      accountClosureHardcodedWorktree,
      happyPathOnlyAccountClosure
    );
    await writeCartFixture(accountClosureHardcodedWorktree, fixedCart);
    await writeProfileFixture(accountClosureHardcodedWorktree, fixedProfile);
    await writeOrderFixture(accountClosureHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      accountClosureHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(accountClosureHardcodedWorktree, fixedShipping);
    await writePaymentFixture(accountClosureHardcodedWorktree, fixedPayment);
    await writeRefundFixture(accountClosureHardcodedWorktree, fixedRefund);
    await writeCouponFixture(accountClosureHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(accountClosureHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      accountClosureHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      accountClosureHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(accountClosureHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(accountClosureHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      accountClosureHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(accountClosureHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      accountClosureHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      accountClosureHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      accountClosureHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      accountClosureHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(accountClosureHardcodedWorktree, fixedPayroll);
    await writeVendorInvoiceFixture(
      accountClosureHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      accountClosureHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      accountClosureHardcodedWorktree,
      fixedLoanUnderwriting
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree
    ]) {
      await writeMerchantOnboardingFixture(worktree, fixedMerchantOnboarding);
    }
    await writeMerchantOnboardingFixture(
      baseWorktree,
      buggyMerchantOnboarding
    );
    await writeMerchantOnboardingFixture(
      merchantOnboardingHardcodedWorktree,
      happyPathOnlyMerchantOnboarding
    );
    await writeCartFixture(merchantOnboardingHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      merchantOnboardingHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(merchantOnboardingHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      merchantOnboardingHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      merchantOnboardingHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      merchantOnboardingHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(merchantOnboardingHardcodedWorktree, fixedRefund);
    await writeCouponFixture(merchantOnboardingHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(
      merchantOnboardingHardcodedWorktree,
      fixedLoyalty
    );
    await writeSubscriptionFixture(
      merchantOnboardingHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      merchantOnboardingHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      merchantOnboardingHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(merchantOnboardingHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      merchantOnboardingHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(
      merchantOnboardingHardcodedWorktree,
      fixedWarranty
    );
    await writeSupportTicketFixture(
      merchantOnboardingHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      merchantOnboardingHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      merchantOnboardingHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      merchantOnboardingHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(
      merchantOnboardingHardcodedWorktree,
      fixedPayroll
    );
    await writeVendorInvoiceFixture(
      merchantOnboardingHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      merchantOnboardingHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      merchantOnboardingHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(
      merchantOnboardingHardcodedWorktree,
      fixedAccountClosure
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree
    ]) {
      await writeDataRetentionFixture(worktree, fixedDataRetentionDeletion);
    }
    await writeDataRetentionFixture(
      baseWorktree,
      buggyDataRetentionDeletion
    );
    await writeDataRetentionFixture(
      dataRetentionDeletionHardcodedWorktree,
      happyPathOnlyDataRetentionDeletion
    );
    await writeCartFixture(dataRetentionDeletionHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(dataRetentionDeletionHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(dataRetentionDeletionHardcodedWorktree, fixedRefund);
    await writeCouponFixture(dataRetentionDeletionHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedLoyalty
    );
    await writeSubscriptionFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(dataRetentionDeletionHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedWarranty
    );
    await writeSupportTicketFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedPayroll
    );
    await writeVendorInvoiceFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedAccountClosure
    );
    await writeMerchantOnboardingFixture(
      dataRetentionDeletionHardcodedWorktree,
      fixedMerchantOnboarding
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree
    ]) {
      await writeContentModerationFixture(
        worktree,
        fixedContentModerationAppeal
      );
    }
    await writeContentModerationFixture(
      baseWorktree,
      buggyContentModerationAppeal
    );
    await writeContentModerationFixture(
      contentModerationAppealHardcodedWorktree,
      happyPathOnlyContentModerationAppeal
    );
    await writeCartFixture(contentModerationAppealHardcodedWorktree, fixedCart);
    await writeProfileFixture(
      contentModerationAppealHardcodedWorktree,
      fixedProfile
    );
    await writeOrderFixture(contentModerationAppealHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      contentModerationAppealHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      contentModerationAppealHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(
      contentModerationAppealHardcodedWorktree,
      fixedPayment
    );
    await writeRefundFixture(contentModerationAppealHardcodedWorktree, fixedRefund);
    await writeCouponFixture(contentModerationAppealHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(
      contentModerationAppealHardcodedWorktree,
      fixedLoyalty
    );
    await writeSubscriptionFixture(
      contentModerationAppealHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      contentModerationAppealHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      contentModerationAppealHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(
      contentModerationAppealHardcodedWorktree,
      fixedPayout
    );
    await writeAppointmentFixture(
      contentModerationAppealHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(
      contentModerationAppealHardcodedWorktree,
      fixedWarranty
    );
    await writeSupportTicketFixture(
      contentModerationAppealHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      contentModerationAppealHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      contentModerationAppealHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      contentModerationAppealHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(
      contentModerationAppealHardcodedWorktree,
      fixedPayroll
    );
    await writeVendorInvoiceFixture(
      contentModerationAppealHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      contentModerationAppealHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      contentModerationAppealHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(
      contentModerationAppealHardcodedWorktree,
      fixedAccountClosure
    );
    await writeMerchantOnboardingFixture(
      contentModerationAppealHardcodedWorktree,
      fixedMerchantOnboarding
    );
    await writeDataRetentionFixture(
      contentModerationAppealHardcodedWorktree,
      fixedDataRetentionDeletion
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree
    ]) {
      await writeFraudRiskFixture(worktree, fixedFraudRisk);
    }
    await writeFraudRiskFixture(baseWorktree, buggyFraudRisk);
    await writeFraudRiskFixture(fraudRiskHardcodedWorktree, happyPathOnlyFraudRisk);
    await writeCartFixture(fraudRiskHardcodedWorktree, fixedCart);
    await writeProfileFixture(fraudRiskHardcodedWorktree, fixedProfile);
    await writeOrderFixture(fraudRiskHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(fraudRiskHardcodedWorktree, fixedInventory);
    await writeShippingFixture(fraudRiskHardcodedWorktree, fixedShipping);
    await writePaymentFixture(fraudRiskHardcodedWorktree, fixedPayment);
    await writeRefundFixture(fraudRiskHardcodedWorktree, fixedRefund);
    await writeCouponFixture(fraudRiskHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(fraudRiskHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(fraudRiskHardcodedWorktree, fixedSubscription);
    await writeEntitlementFixture(fraudRiskHardcodedWorktree, fixedEntitlement);
    await writeGiftCardFixture(fraudRiskHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(fraudRiskHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(fraudRiskHardcodedWorktree, fixedAppointment);
    await writeWarrantyFixture(fraudRiskHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(fraudRiskHardcodedWorktree, fixedSupportTicket);
    await writePaymentDisputeFixture(fraudRiskHardcodedWorktree, fixedPaymentDispute);
    await writeWarehouseAllocationFixture(
      fraudRiskHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(fraudRiskHardcodedWorktree, fixedInsuranceClaim);
    await writePayrollFixture(fraudRiskHardcodedWorktree, fixedPayroll);
    await writeVendorInvoiceFixture(fraudRiskHardcodedWorktree, fixedVendorInvoice);
    await writeExpenseReimbursementFixture(
      fraudRiskHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      fraudRiskHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(fraudRiskHardcodedWorktree, fixedAccountClosure);
    await writeMerchantOnboardingFixture(
      fraudRiskHardcodedWorktree,
      fixedMerchantOnboarding
    );
    await writeDataRetentionFixture(
      fraudRiskHardcodedWorktree,
      fixedDataRetentionDeletion
    );
    await writeContentModerationFixture(
      fraudRiskHardcodedWorktree,
      fixedContentModerationAppeal
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree
    ]) {
      await writeCreditMemoFixture(worktree, fixedCreditMemo);
    }
    await writeCreditMemoFixture(baseWorktree, buggyCreditMemo);
    await writeCreditMemoFixture(
      creditMemoApprovalHardcodedWorktree,
      happyPathOnlyCreditMemo
    );
    await writeCartFixture(creditMemoApprovalHardcodedWorktree, fixedCart);
    await writeProfileFixture(creditMemoApprovalHardcodedWorktree, fixedProfile);
    await writeOrderFixture(creditMemoApprovalHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(creditMemoApprovalHardcodedWorktree, fixedShipping);
    await writePaymentFixture(creditMemoApprovalHardcodedWorktree, fixedPayment);
    await writeRefundFixture(creditMemoApprovalHardcodedWorktree, fixedRefund);
    await writeCouponFixture(creditMemoApprovalHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(creditMemoApprovalHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(creditMemoApprovalHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(creditMemoApprovalHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(creditMemoApprovalHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(creditMemoApprovalHardcodedWorktree, fixedPayroll);
    await writeVendorInvoiceFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedAccountClosure
    );
    await writeMerchantOnboardingFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedMerchantOnboarding
    );
    await writeDataRetentionFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedDataRetentionDeletion
    );
    await writeContentModerationFixture(
      creditMemoApprovalHardcodedWorktree,
      fixedContentModerationAppeal
    );
    await writeFraudRiskFixture(creditMemoApprovalHardcodedWorktree, fixedFraudRisk);
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree
    ]) {
      await writePaymentSettlementFixture(worktree, fixedPaymentSettlement);
    }
    await writePaymentSettlementFixture(baseWorktree, buggyPaymentSettlement);
    await writePaymentSettlementFixture(
      paymentSettlementHardcodedWorktree,
      happyPathOnlyPaymentSettlement
    );
    await writeCartFixture(paymentSettlementHardcodedWorktree, fixedCart);
    await writeProfileFixture(paymentSettlementHardcodedWorktree, fixedProfile);
    await writeOrderFixture(paymentSettlementHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      paymentSettlementHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(paymentSettlementHardcodedWorktree, fixedShipping);
    await writePaymentFixture(paymentSettlementHardcodedWorktree, fixedPayment);
    await writeRefundFixture(paymentSettlementHardcodedWorktree, fixedRefund);
    await writeCouponFixture(paymentSettlementHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(paymentSettlementHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      paymentSettlementHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      paymentSettlementHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(paymentSettlementHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(paymentSettlementHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      paymentSettlementHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(paymentSettlementHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      paymentSettlementHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      paymentSettlementHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      paymentSettlementHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      paymentSettlementHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(paymentSettlementHardcodedWorktree, fixedPayroll);
    await writeVendorInvoiceFixture(
      paymentSettlementHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      paymentSettlementHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      paymentSettlementHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(
      paymentSettlementHardcodedWorktree,
      fixedAccountClosure
    );
    await writeMerchantOnboardingFixture(
      paymentSettlementHardcodedWorktree,
      fixedMerchantOnboarding
    );
    await writeDataRetentionFixture(
      paymentSettlementHardcodedWorktree,
      fixedDataRetentionDeletion
    );
    await writeContentModerationFixture(
      paymentSettlementHardcodedWorktree,
      fixedContentModerationAppeal
    );
    await writeFraudRiskFixture(paymentSettlementHardcodedWorktree, fixedFraudRisk);
    await writeCreditMemoFixture(
      paymentSettlementHardcodedWorktree,
      fixedCreditMemo
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree,
      paymentSettlementHardcodedWorktree
    ]) {
      await writeTaxFilingFixture(worktree, fixedTaxFiling);
    }
    await writeTaxFilingFixture(baseWorktree, buggyTaxFiling);
    await writeCartFixture(taxFilingHardcodedWorktree, fixedCart);
    await writeProfileFixture(taxFilingHardcodedWorktree, fixedProfile);
    await writeOrderFixture(taxFilingHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(taxFilingHardcodedWorktree, fixedInventory);
    await writeShippingFixture(taxFilingHardcodedWorktree, fixedShipping);
    await writePaymentFixture(taxFilingHardcodedWorktree, fixedPayment);
    await writeRefundFixture(taxFilingHardcodedWorktree, fixedRefund);
    await writeCouponFixture(taxFilingHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(taxFilingHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(taxFilingHardcodedWorktree, fixedSubscription);
    await writeEntitlementFixture(taxFilingHardcodedWorktree, fixedEntitlement);
    await writeGiftCardFixture(taxFilingHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(taxFilingHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(taxFilingHardcodedWorktree, fixedAppointment);
    await writeWarrantyFixture(taxFilingHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(taxFilingHardcodedWorktree, fixedSupportTicket);
    await writePaymentDisputeFixture(taxFilingHardcodedWorktree, fixedPaymentDispute);
    await writeWarehouseAllocationFixture(
      taxFilingHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(taxFilingHardcodedWorktree, fixedInsuranceClaim);
    await writePayrollFixture(taxFilingHardcodedWorktree, fixedPayroll);
    await writeVendorInvoiceFixture(taxFilingHardcodedWorktree, fixedVendorInvoice);
    await writeExpenseReimbursementFixture(
      taxFilingHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      taxFilingHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(taxFilingHardcodedWorktree, fixedAccountClosure);
    await writeMerchantOnboardingFixture(
      taxFilingHardcodedWorktree,
      fixedMerchantOnboarding
    );
    await writeDataRetentionFixture(
      taxFilingHardcodedWorktree,
      fixedDataRetentionDeletion
    );
    await writeContentModerationFixture(
      taxFilingHardcodedWorktree,
      fixedContentModerationAppeal
    );
    await writeFraudRiskFixture(taxFilingHardcodedWorktree, fixedFraudRisk);
    await writeCreditMemoFixture(taxFilingHardcodedWorktree, fixedCreditMemo);
    await writePaymentSettlementFixture(
      taxFilingHardcodedWorktree,
      fixedPaymentSettlement
    );
    await writeTaxFilingFixture(taxFilingHardcodedWorktree, happyPathOnlyTaxFiling);
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree,
      paymentSettlementHardcodedWorktree,
      taxFilingHardcodedWorktree
    ]) {
      await writePrivacyConsentFixture(worktree, fixedPrivacyConsent);
    }
    await writePrivacyConsentFixture(baseWorktree, buggyPrivacyConsent);
    await writeCartFixture(privacyConsentHardcodedWorktree, fixedCart);
    await writeProfileFixture(privacyConsentHardcodedWorktree, fixedProfile);
    await writeOrderFixture(privacyConsentHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(privacyConsentHardcodedWorktree, fixedInventory);
    await writeShippingFixture(privacyConsentHardcodedWorktree, fixedShipping);
    await writePaymentFixture(privacyConsentHardcodedWorktree, fixedPayment);
    await writeRefundFixture(privacyConsentHardcodedWorktree, fixedRefund);
    await writeCouponFixture(privacyConsentHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(privacyConsentHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      privacyConsentHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      privacyConsentHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      privacyConsentHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(privacyConsentHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      privacyConsentHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(privacyConsentHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      privacyConsentHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      privacyConsentHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      privacyConsentHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      privacyConsentHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(privacyConsentHardcodedWorktree, fixedPayroll);
    await writeVendorInvoiceFixture(
      privacyConsentHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      privacyConsentHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      privacyConsentHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(
      privacyConsentHardcodedWorktree,
      fixedAccountClosure
    );
    await writeMerchantOnboardingFixture(
      privacyConsentHardcodedWorktree,
      fixedMerchantOnboarding
    );
    await writeDataRetentionFixture(
      privacyConsentHardcodedWorktree,
      fixedDataRetentionDeletion
    );
    await writeContentModerationFixture(
      privacyConsentHardcodedWorktree,
      fixedContentModerationAppeal
    );
    await writeFraudRiskFixture(privacyConsentHardcodedWorktree, fixedFraudRisk);
    await writeCreditMemoFixture(privacyConsentHardcodedWorktree, fixedCreditMemo);
    await writePaymentSettlementFixture(
      privacyConsentHardcodedWorktree,
      fixedPaymentSettlement
    );
    await writeTaxFilingFixture(privacyConsentHardcodedWorktree, fixedTaxFiling);
    await writePrivacyConsentFixture(
      privacyConsentHardcodedWorktree,
      happyPathOnlyPrivacyConsent
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree,
      paymentSettlementHardcodedWorktree,
      taxFilingHardcodedWorktree,
      privacyConsentHardcodedWorktree
    ]) {
      await writeAccessReviewFixture(worktree, fixedAccessReview);
    }
    await writeAccessReviewFixture(baseWorktree, buggyAccessReview);
    await writeCartFixture(accessReviewHardcodedWorktree, fixedCart);
    await writeProfileFixture(accessReviewHardcodedWorktree, fixedProfile);
    await writeOrderFixture(accessReviewHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(accessReviewHardcodedWorktree, fixedInventory);
    await writeShippingFixture(accessReviewHardcodedWorktree, fixedShipping);
    await writePaymentFixture(accessReviewHardcodedWorktree, fixedPayment);
    await writeRefundFixture(accessReviewHardcodedWorktree, fixedRefund);
    await writeCouponFixture(accessReviewHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(accessReviewHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(accessReviewHardcodedWorktree, fixedSubscription);
    await writeEntitlementFixture(accessReviewHardcodedWorktree, fixedEntitlement);
    await writeGiftCardFixture(accessReviewHardcodedWorktree, fixedGiftCard);
    await writePayoutFixture(accessReviewHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(accessReviewHardcodedWorktree, fixedAppointment);
    await writeWarrantyFixture(accessReviewHardcodedWorktree, fixedWarranty);
    await writeSupportTicketFixture(
      accessReviewHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      accessReviewHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      accessReviewHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      accessReviewHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(accessReviewHardcodedWorktree, fixedPayroll);
    await writeVendorInvoiceFixture(
      accessReviewHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      accessReviewHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      accessReviewHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(
      accessReviewHardcodedWorktree,
      fixedAccountClosure
    );
    await writeMerchantOnboardingFixture(
      accessReviewHardcodedWorktree,
      fixedMerchantOnboarding
    );
    await writeDataRetentionFixture(
      accessReviewHardcodedWorktree,
      fixedDataRetentionDeletion
    );
    await writeContentModerationFixture(
      accessReviewHardcodedWorktree,
      fixedContentModerationAppeal
    );
    await writeFraudRiskFixture(accessReviewHardcodedWorktree, fixedFraudRisk);
    await writeCreditMemoFixture(accessReviewHardcodedWorktree, fixedCreditMemo);
    await writePaymentSettlementFixture(
      accessReviewHardcodedWorktree,
      fixedPaymentSettlement
    );
    await writeTaxFilingFixture(accessReviewHardcodedWorktree, fixedTaxFiling);
    await writePrivacyConsentFixture(
      accessReviewHardcodedWorktree,
      fixedPrivacyConsent
    );
    await writeAccessReviewFixture(
      accessReviewHardcodedWorktree,
      happyPathOnlyAccessReview
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree,
      paymentSettlementHardcodedWorktree,
      taxFilingHardcodedWorktree,
      privacyConsentHardcodedWorktree,
      accessReviewHardcodedWorktree
    ]) {
      await writeReleaseReadinessFixture(worktree, fixedReleaseReadiness);
    }
    await writeReleaseReadinessFixture(
      baseWorktree,
      buggyReleaseReadiness
    );
    await writeCartFixture(releaseReadinessHardcodedWorktree, fixedCart);
    await writeProfileFixture(releaseReadinessHardcodedWorktree, fixedProfile);
    await writeOrderFixture(releaseReadinessHardcodedWorktree, fixedOrder);
    await writeInventoryFixture(
      releaseReadinessHardcodedWorktree,
      fixedInventory
    );
    await writeShippingFixture(
      releaseReadinessHardcodedWorktree,
      fixedShipping
    );
    await writePaymentFixture(releaseReadinessHardcodedWorktree, fixedPayment);
    await writeRefundFixture(releaseReadinessHardcodedWorktree, fixedRefund);
    await writeCouponFixture(releaseReadinessHardcodedWorktree, fixedCoupon);
    await writeLoyaltyFixture(releaseReadinessHardcodedWorktree, fixedLoyalty);
    await writeSubscriptionFixture(
      releaseReadinessHardcodedWorktree,
      fixedSubscription
    );
    await writeEntitlementFixture(
      releaseReadinessHardcodedWorktree,
      fixedEntitlement
    );
    await writeGiftCardFixture(
      releaseReadinessHardcodedWorktree,
      fixedGiftCard
    );
    await writePayoutFixture(releaseReadinessHardcodedWorktree, fixedPayout);
    await writeAppointmentFixture(
      releaseReadinessHardcodedWorktree,
      fixedAppointment
    );
    await writeWarrantyFixture(
      releaseReadinessHardcodedWorktree,
      fixedWarranty
    );
    await writeSupportTicketFixture(
      releaseReadinessHardcodedWorktree,
      fixedSupportTicket
    );
    await writePaymentDisputeFixture(
      releaseReadinessHardcodedWorktree,
      fixedPaymentDispute
    );
    await writeWarehouseAllocationFixture(
      releaseReadinessHardcodedWorktree,
      fixedWarehouseAllocation
    );
    await writeInsuranceClaimFixture(
      releaseReadinessHardcodedWorktree,
      fixedInsuranceClaim
    );
    await writePayrollFixture(releaseReadinessHardcodedWorktree, fixedPayroll);
    await writeVendorInvoiceFixture(
      releaseReadinessHardcodedWorktree,
      fixedVendorInvoice
    );
    await writeExpenseReimbursementFixture(
      releaseReadinessHardcodedWorktree,
      fixedExpenseReimbursement
    );
    await writeLoanUnderwritingFixture(
      releaseReadinessHardcodedWorktree,
      fixedLoanUnderwriting
    );
    await writeAccountClosureFixture(
      releaseReadinessHardcodedWorktree,
      fixedAccountClosure
    );
    await writeMerchantOnboardingFixture(
      releaseReadinessHardcodedWorktree,
      fixedMerchantOnboarding
    );
    await writeDataRetentionFixture(
      releaseReadinessHardcodedWorktree,
      fixedDataRetentionDeletion
    );
    await writeContentModerationFixture(
      releaseReadinessHardcodedWorktree,
      fixedContentModerationAppeal
    );
    await writeFraudRiskFixture(
      releaseReadinessHardcodedWorktree,
      fixedFraudRisk
    );
    await writeCreditMemoFixture(
      releaseReadinessHardcodedWorktree,
      fixedCreditMemo
    );
    await writePaymentSettlementFixture(
      releaseReadinessHardcodedWorktree,
      fixedPaymentSettlement
    );
    await writeTaxFilingFixture(
      releaseReadinessHardcodedWorktree,
      fixedTaxFiling
    );
    await writePrivacyConsentFixture(
      releaseReadinessHardcodedWorktree,
      fixedPrivacyConsent
    );
    await writeAccessReviewFixture(
      releaseReadinessHardcodedWorktree,
      fixedAccessReview
    );
    await writeReleaseReadinessFixture(
      releaseReadinessHardcodedWorktree,
      happyPathOnlyReleaseReadiness
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree,
      paymentSettlementHardcodedWorktree,
      taxFilingHardcodedWorktree,
      privacyConsentHardcodedWorktree,
      accessReviewHardcodedWorktree,
      releaseReadinessHardcodedWorktree
    ]) {
      await writeIncidentResponseFixture(worktree, fixedIncidentResponse);
    }
    await writeIncidentResponseFixture(baseWorktree, buggyIncidentResponse);
    await writeAllFixedFixtures(incidentResponseHardcodedWorktree);
    await writeIncidentResponseFixture(
      incidentResponseHardcodedWorktree,
      happyPathOnlyIncidentResponse
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree,
      paymentSettlementHardcodedWorktree,
      taxFilingHardcodedWorktree,
      privacyConsentHardcodedWorktree,
      accessReviewHardcodedWorktree,
      releaseReadinessHardcodedWorktree,
      incidentResponseHardcodedWorktree
    ]) {
      await writeBackupRestoreFixture(worktree, fixedBackupRestore);
    }
    await writeBackupRestoreFixture(baseWorktree, buggyBackupRestore);
    await writeAllFixedFixtures(backupRestoreHardcodedWorktree);
    await writeBackupRestoreFixture(
      backupRestoreHardcodedWorktree,
      happyPathOnlyBackupRestore
    );
    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree,
      paymentSettlementHardcodedWorktree,
      taxFilingHardcodedWorktree,
      privacyConsentHardcodedWorktree,
      accessReviewHardcodedWorktree,
      releaseReadinessHardcodedWorktree,
      incidentResponseHardcodedWorktree,
      backupRestoreHardcodedWorktree,
      usageBillingHardcodedWorktree
    ]) {
      await writeServiceOutageCreditFixture(
        worktree,
        fixedServiceOutageCredit
      );
    }
    await writeServiceOutageCreditFixture(
      baseWorktree,
      buggyServiceOutageCredit
    );
    await writeAllFixedFixtures(serviceOutageCreditHardcodedWorktree);
    await writeServiceOutageCreditFixture(
      serviceOutageCreditHardcodedWorktree,
      happyPathOnlyServiceOutageCredit
    );

    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree,
      paymentSettlementHardcodedWorktree,
      taxFilingHardcodedWorktree,
      privacyConsentHardcodedWorktree,
      accessReviewHardcodedWorktree,
      releaseReadinessHardcodedWorktree,
      incidentResponseHardcodedWorktree,
      backupRestoreHardcodedWorktree
    ]) {
      await writeUsageBillingFixture(worktree, fixedUsageBilling);
    }
    await writeUsageBillingFixture(baseWorktree, buggyUsageBilling);
    await writeAllFixedFixtures(usageBillingHardcodedWorktree);
    await writeUsageBillingFixture(
      usageBillingHardcodedWorktree,
      happyPathOnlyUsageBilling
    );

    for (const worktree of [
      candidateWorktree,
      goodWorktree,
      badWorktree,
      hardcodedWorktree,
      defaultQuantityHardcodedWorktree,
      zeroQuantityTruthinessHardcodedWorktree,
      discountHardcodedWorktree,
      taxHardcodedWorktree,
      roundingHardcodedWorktree,
      profileVisibilityHardcodedWorktree,
      profileSuspensionHardcodedWorktree,
      orderApprovalHardcodedWorktree,
      inventoryReservationHardcodedWorktree,
      shippingEligibilityHardcodedWorktree,
      paymentAuthorizationHardcodedWorktree,
      refundEligibilityHardcodedWorktree,
      couponApplicationHardcodedWorktree,
      loyaltyPointsHardcodedWorktree,
      subscriptionRenewalHardcodedWorktree,
      entitlementAccessHardcodedWorktree,
      giftCardRedemptionHardcodedWorktree,
      sellerPayoutHardcodedWorktree,
      appointmentCancellationHardcodedWorktree,
      warrantyClaimHardcodedWorktree,
      supportTicketRoutingHardcodedWorktree,
      paymentDisputeHardcodedWorktree,
      warehouseAllocationHardcodedWorktree,
      insuranceClaimHardcodedWorktree,
      payrollOvertimeHardcodedWorktree,
      vendorInvoiceHardcodedWorktree,
      expenseReimbursementHardcodedWorktree,
      loanUnderwritingHardcodedWorktree,
      accountClosureHardcodedWorktree,
      merchantOnboardingHardcodedWorktree,
      dataRetentionDeletionHardcodedWorktree,
      contentModerationAppealHardcodedWorktree,
      fraudRiskHardcodedWorktree,
      creditMemoApprovalHardcodedWorktree,
      paymentSettlementHardcodedWorktree,
      taxFilingHardcodedWorktree,
      privacyConsentHardcodedWorktree,
      accessReviewHardcodedWorktree,
      releaseReadinessHardcodedWorktree,
      incidentResponseHardcodedWorktree,
      backupRestoreHardcodedWorktree,
      usageBillingHardcodedWorktree,
      serviceOutageCreditHardcodedWorktree
    ]) {
      await writeContractRenewalFixture(worktree, fixedContractRenewal);
    }
    await writeContractRenewalFixture(baseWorktree, buggyContractRenewal);
    await writeAllFixedFixtures(contractRenewalHardcodedWorktree);
    await writeContractRenewalFixture(
      contractRenewalHardcodedWorktree,
      happyPathOnlyContractRenewal
    );

    const filterConfig = buildAdversaryLiveFilterConfig();
    let proposal = buildCartSemanticProposal();
    let supplementalProposals = [
      buildCartDiscountSemanticProposal(),
      buildCartTaxSemanticProposal(),
      buildCartRoundingSemanticProposal(),
      buildProfileVisibilitySemanticProposal({
        targetPath: 'tests/adversary/profile-visibility-supplemental.test.cjs'
      }),
      buildProfileSuspensionSemanticProposal({
        targetPath: 'tests/adversary/profile-suspension-supplemental.test.cjs'
      }),
      buildOrderApprovalSemanticProposal({
        targetPath: 'tests/adversary/order-approval-supplemental.test.cjs'
      }),
      buildInventoryReservationSemanticProposal({
        targetPath:
          'tests/adversary/inventory-reservation-supplemental.test.cjs'
      }),
      buildShippingEligibilitySemanticProposal({
        targetPath: 'tests/adversary/shipping-eligibility-supplemental.test.cjs'
      }),
      buildPaymentAuthorizationSemanticProposal({
        targetPath:
          'tests/adversary/payment-authorization-supplemental.test.cjs'
      }),
      buildRefundEligibilitySemanticProposal({
        targetPath: 'tests/adversary/refund-eligibility-supplemental.test.cjs'
      }),
      buildCouponApplicationSemanticProposal({
        targetPath: 'tests/adversary/coupon-application-supplemental.test.cjs'
      }),
      buildLoyaltyPointsSemanticProposal({
        targetPath: 'tests/adversary/loyalty-points-supplemental.test.cjs'
      }),
      buildSubscriptionRenewalSemanticProposal({
        targetPath: 'tests/adversary/subscription-renewal-supplemental.test.cjs'
      }),
      buildEntitlementAccessSemanticProposal({
        targetPath: 'tests/adversary/entitlement-access-supplemental.test.cjs'
      }),
      buildGiftCardRedemptionSemanticProposal({
        targetPath: 'tests/adversary/gift-card-redemption-supplemental.test.cjs'
      }),
      buildSellerPayoutSemanticProposal({
        targetPath: 'tests/adversary/seller-payout-supplemental.test.cjs'
      }),
      buildAppointmentCancellationSemanticProposal({
        targetPath:
          'tests/adversary/appointment-cancellation-supplemental.test.cjs'
      }),
      buildWarrantyClaimSemanticProposal({
        targetPath: 'tests/adversary/warranty-claim-supplemental.test.cjs'
      }),
      buildSupportTicketRoutingSemanticProposal({
        targetPath:
          'tests/adversary/support-ticket-routing-supplemental.test.cjs'
      }),
      buildPaymentDisputeSemanticProposal({
        targetPath: 'tests/adversary/payment-dispute-supplemental.test.cjs'
      }),
      buildWarehouseAllocationSemanticProposal({
        targetPath:
          'tests/adversary/warehouse-allocation-supplemental.test.cjs'
      }),
      buildInsuranceClaimSemanticProposal({
        targetPath: 'tests/adversary/insurance-claim-supplemental.test.cjs'
      }),
      buildPayrollOvertimeSemanticProposal({
        targetPath: 'tests/adversary/payroll-overtime-supplemental.test.cjs'
      }),
      buildVendorInvoiceSemanticProposal({
        targetPath: 'tests/adversary/vendor-invoice-supplemental.test.cjs'
      }),
      buildExpenseReimbursementSemanticProposal({
        targetPath:
          'tests/adversary/expense-reimbursement-supplemental.test.cjs'
      }),
      buildLoanUnderwritingSemanticProposal({
        targetPath: 'tests/adversary/loan-underwriting-supplemental.test.cjs'
      }),
      buildAccountClosureSemanticProposal({
        targetPath: 'tests/adversary/account-closure-supplemental.test.cjs'
      }),
      buildMerchantOnboardingSemanticProposal({
        targetPath: 'tests/adversary/merchant-onboarding-supplemental.test.cjs'
      }),
      buildDataRetentionDeletionSemanticProposal({
        targetPath:
          'tests/adversary/data-retention-deletion-supplemental.test.cjs'
      }),
      buildContentModerationAppealSemanticProposal({
        targetPath:
          'tests/adversary/content-moderation-appeal-supplemental.test.cjs'
      }),
      buildFraudRiskSemanticProposal({
        targetPath: 'tests/adversary/fraud-risk-supplemental.test.cjs'
      }),
      buildCreditMemoApprovalSemanticProposal({
        targetPath: 'tests/adversary/credit-memo-approval-supplemental.test.cjs'
      }),
      buildPaymentSettlementSemanticProposal({
        targetPath: 'tests/adversary/payment-settlement-supplemental.test.cjs'
      }),
      buildTaxFilingSemanticProposal({
        targetPath: 'tests/adversary/tax-filing-supplemental.test.cjs'
      }),
      buildPrivacyConsentSemanticProposal({
        targetPath: 'tests/adversary/privacy-consent-supplemental.test.cjs'
      }),
      buildAccessReviewSemanticProposal({
        targetPath: 'tests/adversary/access-review-supplemental.test.cjs'
      }),
      buildReleaseReadinessSemanticProposal({
        targetPath: 'tests/adversary/release-readiness-supplemental.test.cjs'
      }),
      buildIncidentResponseSemanticProposal({
        targetPath: 'tests/adversary/incident-response-supplemental.test.cjs'
      }),
      buildBackupRestoreSemanticProposal({
        targetPath: 'tests/adversary/backup-restore-supplemental.test.cjs'
      }),
      buildUsageBillingSemanticProposal({
        targetPath: 'tests/adversary/usage-billing-supplemental.test.cjs'
      }),
      buildServiceOutageCreditSemanticProposal({
        targetPath:
          'tests/adversary/service-outage-credit-supplemental.test.cjs'
      }),
      buildContractRenewalSemanticProposal({
        targetPath: 'tests/adversary/contract-renewal-supplemental.test.cjs'
      })
    ];
    let adversaryReview = null;
    let adversaryReviewerProvenance =
      buildControlledAdversaryReviewerProvenance();
    const handoffFile = path.join(artifactRoot, 'adversary-m2-handoff.json');
    const reviewFile = path.join(artifactRoot, 'adversary-review.json');
    const confirmationFile = path.join(artifactRoot, 'm2-confirmation.json');
    const candidateFile = path.join(artifactRoot, 'rulepack-candidate.json');
    const corpusFile = path.join(artifactRoot, 'adversary-replay-corpus.json');
    const replayFile = path.join(artifactRoot, 'm4-replay.json');
    const freezeFile = path.join(artifactRoot, 'rulepack-freeze.json');
    const rulepackFile = path.join(artifactRoot, 'rulepack.lock.json');
    const selectedPatchFile = path.join(artifactRoot, 'candidate.patch');
    const selectedPatch = buildAdversaryLiveReviewInput().selected.patch;
    await writeFile(selectedPatchFile, `${selectedPatch}\n`);

    if (REVIEWER_COMMAND) {
      const reviewInput = buildAdversaryLiveReviewInput({
        patchRef: selectedPatchFile,
        patch: selectedPatch,
        reviewerContext: fixedAdversaryReviewContext()
      });
      const reviewOutput = await commandAdversaryReviewer(REVIEWER_COMMAND, {
        timeoutMs: REVIEWER_TIMEOUT_MS,
        env: process.env
      })(reviewInput);
      adversaryReview = filterAdversaryReviewOutput({
        input: reviewInput,
        output: reviewOutput,
        filterConfig,
        independence: resolveAdversaryReviewIndependence({
          builderAgentSpec: BUILDER_AGENT_SPEC,
          reviewerProvider: REVIEWER_PROVIDER,
          requireDifferentProvider: false
        })
      });
      const reviewProposal = selectAdversaryLiveReviewProposal(adversaryReview);
      if (!reviewProposal) {
        throw new Error(
          'adversary reviewer command did not produce an accepted proposal for M2'
        );
      }
      proposal = reviewProposal;
      supplementalProposals = [
        buildCartDiscountSemanticProposal(),
        buildCartTaxSemanticProposal(),
        buildCartRoundingSemanticProposal(),
        buildProfileVisibilitySemanticProposal({
          targetPath: 'tests/adversary/profile-visibility-supplemental.test.cjs'
        }),
        buildProfileSuspensionSemanticProposal({
          targetPath: 'tests/adversary/profile-suspension-supplemental.test.cjs'
        }),
        buildOrderApprovalSemanticProposal({
          targetPath: 'tests/adversary/order-approval-supplemental.test.cjs'
        }),
        buildInventoryReservationSemanticProposal({
          targetPath:
            'tests/adversary/inventory-reservation-supplemental.test.cjs'
        }),
        buildShippingEligibilitySemanticProposal({
          targetPath:
            'tests/adversary/shipping-eligibility-supplemental.test.cjs'
        }),
        buildPaymentAuthorizationSemanticProposal({
          targetPath:
            'tests/adversary/payment-authorization-supplemental.test.cjs'
        }),
        buildRefundEligibilitySemanticProposal({
          targetPath: 'tests/adversary/refund-eligibility-supplemental.test.cjs'
        }),
        buildCouponApplicationSemanticProposal({
          targetPath: 'tests/adversary/coupon-application-supplemental.test.cjs'
        }),
        buildLoyaltyPointsSemanticProposal({
          targetPath: 'tests/adversary/loyalty-points-supplemental.test.cjs'
        }),
        buildSubscriptionRenewalSemanticProposal({
          targetPath:
            'tests/adversary/subscription-renewal-supplemental.test.cjs'
        }),
        buildEntitlementAccessSemanticProposal({
          targetPath:
            'tests/adversary/entitlement-access-supplemental.test.cjs'
        }),
        buildGiftCardRedemptionSemanticProposal({
          targetPath:
            'tests/adversary/gift-card-redemption-supplemental.test.cjs'
        }),
        buildSellerPayoutSemanticProposal({
          targetPath: 'tests/adversary/seller-payout-supplemental.test.cjs'
        }),
        buildAppointmentCancellationSemanticProposal({
          targetPath:
            'tests/adversary/appointment-cancellation-supplemental.test.cjs'
        }),
        buildWarrantyClaimSemanticProposal({
          targetPath: 'tests/adversary/warranty-claim-supplemental.test.cjs'
        }),
        buildSupportTicketRoutingSemanticProposal({
          targetPath:
            'tests/adversary/support-ticket-routing-supplemental.test.cjs'
        }),
        buildPaymentDisputeSemanticProposal({
          targetPath: 'tests/adversary/payment-dispute-supplemental.test.cjs'
        }),
        buildWarehouseAllocationSemanticProposal({
          targetPath:
            'tests/adversary/warehouse-allocation-supplemental.test.cjs'
        }),
        buildInsuranceClaimSemanticProposal({
          targetPath: 'tests/adversary/insurance-claim-supplemental.test.cjs'
        }),
        buildPayrollOvertimeSemanticProposal({
          targetPath: 'tests/adversary/payroll-overtime-supplemental.test.cjs'
        }),
        buildVendorInvoiceSemanticProposal({
          targetPath: 'tests/adversary/vendor-invoice-supplemental.test.cjs'
        }),
        buildExpenseReimbursementSemanticProposal({
          targetPath:
            'tests/adversary/expense-reimbursement-supplemental.test.cjs'
        }),
        buildLoanUnderwritingSemanticProposal({
          targetPath: 'tests/adversary/loan-underwriting-supplemental.test.cjs'
        }),
        buildAccountClosureSemanticProposal({
          targetPath: 'tests/adversary/account-closure-supplemental.test.cjs'
        }),
        buildMerchantOnboardingSemanticProposal({
          targetPath:
            'tests/adversary/merchant-onboarding-supplemental.test.cjs'
        }),
        buildDataRetentionDeletionSemanticProposal({
          targetPath:
            'tests/adversary/data-retention-deletion-supplemental.test.cjs'
        }),
        buildContentModerationAppealSemanticProposal({
          targetPath:
            'tests/adversary/content-moderation-appeal-supplemental.test.cjs'
        }),
        buildFraudRiskSemanticProposal({
          targetPath: 'tests/adversary/fraud-risk-supplemental.test.cjs'
        }),
        buildCreditMemoApprovalSemanticProposal({
          targetPath:
            'tests/adversary/credit-memo-approval-supplemental.test.cjs'
        }),
        buildPaymentSettlementSemanticProposal({
          targetPath:
            'tests/adversary/payment-settlement-supplemental.test.cjs'
        }),
        buildTaxFilingSemanticProposal({
          targetPath: 'tests/adversary/tax-filing-supplemental.test.cjs'
        }),
        buildPrivacyConsentSemanticProposal({
          targetPath: 'tests/adversary/privacy-consent-supplemental.test.cjs'
        }),
        buildAccessReviewSemanticProposal({
          targetPath: 'tests/adversary/access-review-supplemental.test.cjs'
        }),
        buildReleaseReadinessSemanticProposal({
          targetPath:
            'tests/adversary/release-readiness-supplemental.test.cjs'
        }),
        buildIncidentResponseSemanticProposal({
          targetPath:
            'tests/adversary/incident-response-supplemental.test.cjs'
        }),
        buildBackupRestoreSemanticProposal({
          targetPath:
            'tests/adversary/backup-restore-supplemental.test.cjs'
        }),
        buildUsageBillingSemanticProposal({
          targetPath:
            'tests/adversary/usage-billing-supplemental.test.cjs'
        }),
        buildServiceOutageCreditSemanticProposal({
          targetPath:
            'tests/adversary/service-outage-credit-supplemental.test.cjs'
        }),
        buildContractRenewalSemanticProposal({
          targetPath: 'tests/adversary/contract-renewal-supplemental.test.cjs'
        })
      ];
      adversaryReviewerProvenance = buildCommandAdversaryReviewerProvenance({
        reviewReport: adversaryReview,
        realLlm: REVIEWER_REAL_LLM,
        provider: REVIEWER_PROVIDER ?? adversaryReview.reviewer_provider
      });
      const provenanceCheck = validateAdversaryReviewerProvenance(
        adversaryReviewerProvenance
      );
      if (!provenanceCheck.ok) {
        throw new Error(
          `adversary reviewer provenance is not release-grade: ${JSON.stringify(
            provenanceCheck.failures
          )}`
        );
      }
      await writeFile(
        reviewFile,
        `${JSON.stringify(
          {
            input: reviewInput,
            output: reviewOutput,
            report: adversaryReview,
            provenance: adversaryReviewerProvenance
          },
          null,
          2
        )}\n`
      );
    }

    const handoff = {
      schema_version: '1.0',
      kind: 'adversary_m2_handoff',
      authority: 'advisory_only',
      decision_impact: 'none',
      loop_id: 'adversary-live-loop-n',
      base_commit: 'fixture-base-cart-quantity',
      selected_candidate_id: ADVERSARY_LIVE_SELECTED_CANDIDATE_ID,
      selected_patch: selectedPatchFile,
      next_step: 'm2_execute_under_isolation_then_m4_replay_freeze_next_loop',
      proposals: [
        { proposal, next_step: 'm2_execution_required' },
        ...supplementalProposals.map((supplementalProposal) => ({
          proposal: supplementalProposal,
          next_step: 'm2_execution_required'
        }))
      ]
    };
    await writeFile(handoffFile, `${JSON.stringify(handoff, null, 2)}\n`);
    const testCommand =
      'sh -c \'for f in tests/adversary/*.cjs; do node "$f"; done\'';

    const confirmation = await confirmAdversaryM2Handoff({
      handoffFile,
      candidateWorktree,
      baseWorktree,
      execute: true,
      filterConfig: {
        ...filterConfig
      },
      execution: {
        image: IMAGE,
        testCommand,
        network: 'none',
        timeoutMs: TIMEOUT_MS
      },
      outputFile: confirmationFile
    });
    if (!confirmation.all_confirmed) {
      throw new Error(
        `M2 did not confirm every proposal: ${JSON.stringify(confirmation.confirmations)}`
      );
    }

    const candidate = await buildAdversaryRulepackCandidate({
      handoffFile,
      confirmationFile,
      outputFile: candidateFile
    });
    const corpus = await buildAdversaryReplayCorpus({
      handoffFile,
      candidateFile,
      testCommand,
      outputFile: corpusFile
    });
    const replay = await replayAdversaryRulepack({
      corpusFile,
      execute: true,
      worktreePath: candidateWorktree,
      image: IMAGE,
      network: 'none',
      timeoutMs: TIMEOUT_MS,
      outputFile: replayFile
    });
    if (!replay.replaySafe) {
      throw new Error(
        `M4 replay was not replay-safe: ${JSON.stringify(replay)}`
      );
    }
    const freeze = await freezeAdversaryRulepack({
      candidateFile,
      replayFile,
      outputFile: freezeFile,
      rulepackOutFile: rulepackFile
    });
    if (!freeze.frozen || !freeze.rulepack_ref) {
      throw new Error(`rulepack freeze failed: ${JSON.stringify(freeze)}`);
    }
    const inspected = await inspectFrozenRulepack(rulepackFile);
    if (!inspected.valid || !inspected.semantic_ready) {
      throw new Error(
        `frozen rulepack is not semantic ready: ${JSON.stringify(inspected)}`
      );
    }

    const good = await runGates(
      await gateContext(goodWorktree, rulepackFile, 'adversary-live-good')
    );
    const bad = await runGates(
      await gateContext(badWorktree, rulepackFile, 'adversary-live-bad')
    );
    const hardcoded = await runGates(
      await gateContext(
        hardcodedWorktree,
        rulepackFile,
        'adversary-live-visible-only-hardcode'
      )
    );
    const defaultQuantityHardcoded = await runGates(
      await gateContext(
        defaultQuantityHardcodedWorktree,
        rulepackFile,
        'adversary-live-default-quantity-hardcode'
      )
    );
    const zeroQuantityTruthinessHardcoded = await runGates(
      await gateContext(
        zeroQuantityTruthinessHardcodedWorktree,
        rulepackFile,
        'adversary-live-zero-quantity-truthiness-hardcode'
      )
    );
    const discountHardcoded = await runGates(
      await gateContext(
        discountHardcodedWorktree,
        rulepackFile,
        'adversary-live-discount-hardcode'
      )
    );
    const taxHardcoded = await runGates(
      await gateContext(
        taxHardcodedWorktree,
        rulepackFile,
        'adversary-live-tax-hardcode'
      )
    );
    const roundingHardcoded = await runGates(
      await gateContext(
        roundingHardcodedWorktree,
        rulepackFile,
        'adversary-live-rounding-hardcode'
      )
    );
    const profileVisibilityHardcoded = await runGates(
      await gateContext(
        profileVisibilityHardcodedWorktree,
        rulepackFile,
        'adversary-live-profile-visibility-hardcode'
      )
    );
    const profileSuspensionHardcoded = await runGates(
      await gateContext(
        profileSuspensionHardcodedWorktree,
        rulepackFile,
        'adversary-live-profile-suspension-hardcode'
      )
    );
    const orderApprovalHardcoded = await runGates(
      await gateContext(
        orderApprovalHardcodedWorktree,
        rulepackFile,
        'adversary-live-order-approval-hardcode'
      )
    );
    const inventoryReservationHardcoded = await runGates(
      await gateContext(
        inventoryReservationHardcodedWorktree,
        rulepackFile,
        'adversary-live-inventory-reservation-hardcode'
      )
    );
    const shippingEligibilityHardcoded = await runGates(
      await gateContext(
        shippingEligibilityHardcodedWorktree,
        rulepackFile,
        'adversary-live-shipping-eligibility-hardcode'
      )
    );
    const paymentAuthorizationHardcoded = await runGates(
      await gateContext(
        paymentAuthorizationHardcodedWorktree,
        rulepackFile,
        'adversary-live-payment-authorization-hardcode'
      )
    );
    const refundEligibilityHardcoded = await runGates(
      await gateContext(
        refundEligibilityHardcodedWorktree,
        rulepackFile,
        'adversary-live-refund-eligibility-hardcode'
      )
    );
    const couponApplicationHardcoded = await runGates(
      await gateContext(
        couponApplicationHardcodedWorktree,
        rulepackFile,
        'adversary-live-coupon-application-hardcode'
      )
    );
    const loyaltyPointsHardcoded = await runGates(
      await gateContext(
        loyaltyPointsHardcodedWorktree,
        rulepackFile,
        'adversary-live-loyalty-points-hardcode'
      )
    );
    const subscriptionRenewalHardcoded = await runGates(
      await gateContext(
        subscriptionRenewalHardcodedWorktree,
        rulepackFile,
        'adversary-live-subscription-renewal-hardcode'
      )
    );
    const entitlementAccessHardcoded = await runGates(
      await gateContext(
        entitlementAccessHardcodedWorktree,
        rulepackFile,
        'adversary-live-entitlement-access-hardcode'
      )
    );
    const giftCardRedemptionHardcoded = await runGates(
      await gateContext(
        giftCardRedemptionHardcodedWorktree,
        rulepackFile,
        'adversary-live-gift-card-redemption-hardcode'
      )
    );
    const sellerPayoutHardcoded = await runGates(
      await gateContext(
        sellerPayoutHardcodedWorktree,
        rulepackFile,
        'adversary-live-seller-payout-hardcode'
      )
    );
    const appointmentCancellationHardcoded = await runGates(
      await gateContext(
        appointmentCancellationHardcodedWorktree,
        rulepackFile,
        'adversary-live-appointment-cancellation-hardcode'
      )
    );
    const warrantyClaimHardcoded = await runGates(
      await gateContext(
        warrantyClaimHardcodedWorktree,
        rulepackFile,
        'adversary-live-warranty-claim-hardcode'
      )
    );
    const supportTicketRoutingHardcoded = await runGates(
      await gateContext(
        supportTicketRoutingHardcodedWorktree,
        rulepackFile,
        'adversary-live-support-ticket-routing-hardcode'
      )
    );
    const paymentDisputeHardcoded = await runGates(
      await gateContext(
        paymentDisputeHardcodedWorktree,
        rulepackFile,
        'adversary-live-payment-dispute-hardcode'
      )
    );
    const warehouseAllocationHardcoded = await runGates(
      await gateContext(
        warehouseAllocationHardcodedWorktree,
        rulepackFile,
        'adversary-live-warehouse-allocation-hardcode'
      )
    );
    const insuranceClaimHardcoded = await runGates(
      await gateContext(
        insuranceClaimHardcodedWorktree,
        rulepackFile,
        'adversary-live-insurance-claim-hardcode'
      )
    );
    const payrollOvertimeHardcoded = await runGates(
      await gateContext(
        payrollOvertimeHardcodedWorktree,
        rulepackFile,
        'adversary-live-payroll-overtime-hardcode'
      )
    );
    const vendorInvoiceHardcoded = await runGates(
      await gateContext(
        vendorInvoiceHardcodedWorktree,
        rulepackFile,
        'adversary-live-vendor-invoice-hardcode'
      )
    );
    const expenseReimbursementHardcoded = await runGates(
      await gateContext(
        expenseReimbursementHardcodedWorktree,
        rulepackFile,
        'adversary-live-expense-reimbursement-hardcode'
      )
    );
    const loanUnderwritingHardcoded = await runGates(
      await gateContext(
        loanUnderwritingHardcodedWorktree,
        rulepackFile,
        'adversary-live-loan-underwriting-hardcode'
      )
    );
    const accountClosureHardcoded = await runGates(
      await gateContext(
        accountClosureHardcodedWorktree,
        rulepackFile,
        'adversary-live-account-closure-hardcode'
      )
    );
    const merchantOnboardingHardcoded = await runGates(
      await gateContext(
        merchantOnboardingHardcodedWorktree,
        rulepackFile,
        'adversary-live-merchant-onboarding-hardcode'
      )
    );
    const dataRetentionDeletionHardcoded = await runGates(
      await gateContext(
        dataRetentionDeletionHardcodedWorktree,
        rulepackFile,
        'adversary-live-data-retention-deletion-hardcode'
      )
    );
    const contentModerationAppealHardcoded = await runGates(
      await gateContext(
        contentModerationAppealHardcodedWorktree,
        rulepackFile,
        'adversary-live-content-moderation-appeal-hardcode'
      )
    );
    const fraudRiskHardcoded = await runGates(
      await gateContext(
        fraudRiskHardcodedWorktree,
        rulepackFile,
        'adversary-live-fraud-risk-hardcode'
      )
    );
    const creditMemoApprovalHardcoded = await runGates(
      await gateContext(
        creditMemoApprovalHardcodedWorktree,
        rulepackFile,
        'adversary-live-credit-memo-approval-hardcode'
      )
    );
    const paymentSettlementHardcoded = await runGates(
      await gateContext(
        paymentSettlementHardcodedWorktree,
        rulepackFile,
        'adversary-live-payment-settlement-hardcode'
      )
    );
    const taxFilingHardcoded = await runGates(
      await gateContext(
        taxFilingHardcodedWorktree,
        rulepackFile,
        'adversary-live-tax-filing-hardcode'
      )
    );
    const privacyConsentHardcoded = await runGates(
      await gateContext(
        privacyConsentHardcodedWorktree,
        rulepackFile,
        'adversary-live-privacy-consent-hardcode'
      )
    );
    const accessReviewHardcoded = await runGates(
      await gateContext(
        accessReviewHardcodedWorktree,
        rulepackFile,
        'adversary-live-access-review-hardcode'
      )
    );
    const releaseReadinessHardcoded = await runGates(
      await gateContext(
        releaseReadinessHardcodedWorktree,
        rulepackFile,
        'adversary-live-release-readiness-hardcode'
      )
    );
    const incidentResponseHardcoded = await runGates(
      await gateContext(
        incidentResponseHardcodedWorktree,
        rulepackFile,
        'adversary-live-incident-response-hardcode'
      )
    );
    const backupRestoreHardcoded = await runGates(
      await gateContext(
        backupRestoreHardcodedWorktree,
        rulepackFile,
        'adversary-live-backup-restore-hardcode'
      )
    );
    const usageBillingHardcoded = await runGates(
      await gateContext(
        usageBillingHardcodedWorktree,
        rulepackFile,
        'adversary-live-usage-billing-hardcode'
      )
    );
    const serviceOutageCreditHardcoded = await runGates(
      await gateContext(
        serviceOutageCreditHardcodedWorktree,
        rulepackFile,
        'adversary-live-service-outage-credit-hardcode'
      )
    );
    const contractRenewalHardcoded = await runGates(
      await gateContext(
        contractRenewalHardcodedWorktree,
        rulepackFile,
        'adversary-live-contract-renewal-hardcode'
      )
    );
    const goodGate = good.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const badGate = bad.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const hardcodedGate = hardcoded.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const defaultQuantityHardcodedGate =
      defaultQuantityHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const zeroQuantityTruthinessHardcodedGate =
      zeroQuantityTruthinessHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const discountHardcodedGate = discountHardcoded.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const taxHardcodedGate = taxHardcoded.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const roundingHardcodedGate = roundingHardcoded.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const profileVisibilityHardcodedGate =
      profileVisibilityHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const profileSuspensionHardcodedGate =
      profileSuspensionHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const orderApprovalHardcodedGate = orderApprovalHardcoded.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const inventoryReservationHardcodedGate =
      inventoryReservationHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const shippingEligibilityHardcodedGate =
      shippingEligibilityHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const paymentAuthorizationHardcodedGate =
      paymentAuthorizationHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const refundEligibilityHardcodedGate =
      refundEligibilityHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const couponApplicationHardcodedGate =
      couponApplicationHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const loyaltyPointsHardcodedGate = loyaltyPointsHardcoded.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const subscriptionRenewalHardcodedGate =
      subscriptionRenewalHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const entitlementAccessHardcodedGate =
      entitlementAccessHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const giftCardRedemptionHardcodedGate =
      giftCardRedemptionHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const sellerPayoutHardcodedGate =
      sellerPayoutHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const appointmentCancellationHardcodedGate =
      appointmentCancellationHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const warrantyClaimHardcodedGate =
      warrantyClaimHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const supportTicketRoutingHardcodedGate =
      supportTicketRoutingHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const paymentDisputeHardcodedGate =
      paymentDisputeHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const warehouseAllocationHardcodedGate =
      warehouseAllocationHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const insuranceClaimHardcodedGate =
      insuranceClaimHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const payrollOvertimeHardcodedGate =
      payrollOvertimeHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const vendorInvoiceHardcodedGate =
      vendorInvoiceHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const expenseReimbursementHardcodedGate =
      expenseReimbursementHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const loanUnderwritingHardcodedGate =
      loanUnderwritingHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const accountClosureHardcodedGate =
      accountClosureHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const merchantOnboardingHardcodedGate =
      merchantOnboardingHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const dataRetentionDeletionHardcodedGate =
      dataRetentionDeletionHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const contentModerationAppealHardcodedGate =
      contentModerationAppealHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const fraudRiskHardcodedGate = fraudRiskHardcoded.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const creditMemoApprovalHardcodedGate =
      creditMemoApprovalHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const paymentSettlementHardcodedGate =
      paymentSettlementHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const taxFilingHardcodedGate = taxFilingHardcoded.report.gates.find(
      (gate) => gate.name === 'rulepack_semantic'
    );
    const privacyConsentHardcodedGate =
      privacyConsentHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const accessReviewHardcodedGate =
      accessReviewHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const releaseReadinessHardcodedGate =
      releaseReadinessHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const incidentResponseHardcodedGate =
      incidentResponseHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const backupRestoreHardcodedGate =
      backupRestoreHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const usageBillingHardcodedGate =
      usageBillingHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const serviceOutageCreditHardcodedGate =
      serviceOutageCreditHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    const contractRenewalHardcodedGate =
      contractRenewalHardcoded.report.gates.find(
        (gate) => gate.name === 'rulepack_semantic'
      );
    if (
      goodGate?.status !== 'pass' ||
      badGate?.status !== 'fail' ||
      hardcodedGate?.status !== 'fail' ||
      defaultQuantityHardcodedGate?.status !== 'fail' ||
      zeroQuantityTruthinessHardcodedGate?.status !== 'fail' ||
      discountHardcodedGate?.status !== 'fail' ||
      taxHardcodedGate?.status !== 'fail' ||
      roundingHardcodedGate?.status !== 'fail' ||
      profileVisibilityHardcodedGate?.status !== 'fail' ||
      profileSuspensionHardcodedGate?.status !== 'fail' ||
      orderApprovalHardcodedGate?.status !== 'fail' ||
      inventoryReservationHardcodedGate?.status !== 'fail' ||
      shippingEligibilityHardcodedGate?.status !== 'fail' ||
      paymentAuthorizationHardcodedGate?.status !== 'fail' ||
      refundEligibilityHardcodedGate?.status !== 'fail' ||
      couponApplicationHardcodedGate?.status !== 'fail' ||
      loyaltyPointsHardcodedGate?.status !== 'fail' ||
      subscriptionRenewalHardcodedGate?.status !== 'fail' ||
      entitlementAccessHardcodedGate?.status !== 'fail' ||
      giftCardRedemptionHardcodedGate?.status !== 'fail' ||
      sellerPayoutHardcodedGate?.status !== 'fail' ||
      appointmentCancellationHardcodedGate?.status !== 'fail' ||
      warrantyClaimHardcodedGate?.status !== 'fail' ||
      supportTicketRoutingHardcodedGate?.status !== 'fail' ||
      paymentDisputeHardcodedGate?.status !== 'fail' ||
      warehouseAllocationHardcodedGate?.status !== 'fail' ||
      insuranceClaimHardcodedGate?.status !== 'fail' ||
      payrollOvertimeHardcodedGate?.status !== 'fail' ||
      vendorInvoiceHardcodedGate?.status !== 'fail' ||
      expenseReimbursementHardcodedGate?.status !== 'fail' ||
      loanUnderwritingHardcodedGate?.status !== 'fail' ||
      accountClosureHardcodedGate?.status !== 'fail' ||
      merchantOnboardingHardcodedGate?.status !== 'fail' ||
      dataRetentionDeletionHardcodedGate?.status !== 'fail' ||
      contentModerationAppealHardcodedGate?.status !== 'fail' ||
      fraudRiskHardcodedGate?.status !== 'fail' ||
      creditMemoApprovalHardcodedGate?.status !== 'fail' ||
      paymentSettlementHardcodedGate?.status !== 'fail' ||
      taxFilingHardcodedGate?.status !== 'fail' ||
      privacyConsentHardcodedGate?.status !== 'fail' ||
      accessReviewHardcodedGate?.status !== 'fail' ||
      releaseReadinessHardcodedGate?.status !== 'fail' ||
      incidentResponseHardcodedGate?.status !== 'fail' ||
      backupRestoreHardcodedGate?.status !== 'fail' ||
      usageBillingHardcodedGate?.status !== 'fail' ||
      serviceOutageCreditHardcodedGate?.status !== 'fail' ||
      contractRenewalHardcodedGate?.status !== 'fail'
    ) {
      throw new Error(
        `unexpected semantic gate results: ${JSON.stringify({
          good: goodGate,
          bad: badGate,
          hardcoded: hardcodedGate,
          defaultQuantityHardcoded: defaultQuantityHardcodedGate,
          zeroQuantityTruthinessHardcoded: zeroQuantityTruthinessHardcodedGate,
          discountHardcoded: discountHardcodedGate,
          taxHardcoded: taxHardcodedGate,
          roundingHardcoded: roundingHardcodedGate,
          profileVisibilityHardcoded: profileVisibilityHardcodedGate,
          profileSuspensionHardcoded: profileSuspensionHardcodedGate,
          orderApprovalHardcoded: orderApprovalHardcodedGate,
          inventoryReservationHardcoded: inventoryReservationHardcodedGate,
          shippingEligibilityHardcoded: shippingEligibilityHardcodedGate,
          paymentAuthorizationHardcoded: paymentAuthorizationHardcodedGate,
          refundEligibilityHardcoded: refundEligibilityHardcodedGate,
          couponApplicationHardcoded: couponApplicationHardcodedGate,
          loyaltyPointsHardcoded: loyaltyPointsHardcodedGate,
          subscriptionRenewalHardcoded: subscriptionRenewalHardcodedGate,
          entitlementAccessHardcoded: entitlementAccessHardcodedGate,
          giftCardRedemptionHardcoded: giftCardRedemptionHardcodedGate,
          sellerPayoutHardcoded: sellerPayoutHardcodedGate,
          appointmentCancellationHardcoded:
            appointmentCancellationHardcodedGate,
          warrantyClaimHardcoded: warrantyClaimHardcodedGate,
          supportTicketRoutingHardcoded: supportTicketRoutingHardcodedGate,
          paymentDisputeHardcoded: paymentDisputeHardcodedGate,
          warehouseAllocationHardcoded: warehouseAllocationHardcodedGate,
          insuranceClaimHardcoded: insuranceClaimHardcodedGate,
          payrollOvertimeHardcoded: payrollOvertimeHardcodedGate,
          vendorInvoiceHardcoded: vendorInvoiceHardcodedGate,
          expenseReimbursementHardcoded: expenseReimbursementHardcodedGate,
          loanUnderwritingHardcoded: loanUnderwritingHardcodedGate,
          accountClosureHardcoded: accountClosureHardcodedGate,
          merchantOnboardingHardcoded: merchantOnboardingHardcodedGate,
          dataRetentionDeletionHardcoded: dataRetentionDeletionHardcodedGate,
          contentModerationAppealHardcoded:
            contentModerationAppealHardcodedGate,
          fraudRiskHardcoded: fraudRiskHardcodedGate,
          creditMemoApprovalHardcoded: creditMemoApprovalHardcodedGate,
          paymentSettlementHardcoded: paymentSettlementHardcodedGate,
          taxFilingHardcoded: taxFilingHardcodedGate,
          privacyConsentHardcoded: privacyConsentHardcodedGate,
          accessReviewHardcoded: accessReviewHardcodedGate,
          releaseReadinessHardcoded: releaseReadinessHardcodedGate,
          incidentResponseHardcoded: incidentResponseHardcodedGate,
          backupRestoreHardcoded: backupRestoreHardcodedGate,
          usageBillingHardcoded: usageBillingHardcodedGate,
          serviceOutageCreditHardcoded: serviceOutageCreditHardcodedGate,
          contractRenewalHardcoded: contractRenewalHardcodedGate
        })}`
      );
    }
    const attackScenarioResults = buildAdversaryLiveAttackScenarioResults({
      filterAdversaryProposal,
      filterConfig,
      handoff,
      safety: safetyPlan,
      gates: {
        good: goodGate.status,
        bad: badGate.status,
        hardcoded: hardcodedGate.status,
        defaultQuantityHardcoded: defaultQuantityHardcodedGate.status,
        zeroQuantityTruthinessHardcoded:
          zeroQuantityTruthinessHardcodedGate.status,
        discountHardcoded: discountHardcodedGate.status,
        taxHardcoded: taxHardcodedGate.status,
        roundingHardcoded: roundingHardcodedGate.status,
        profileVisibilityHardcoded: profileVisibilityHardcodedGate.status,
        profileSuspensionHardcoded: profileSuspensionHardcodedGate.status,
        orderApprovalHardcoded: orderApprovalHardcodedGate.status,
        inventoryReservationHardcoded: inventoryReservationHardcodedGate.status,
        shippingEligibilityHardcoded: shippingEligibilityHardcodedGate.status,
        paymentAuthorizationHardcoded: paymentAuthorizationHardcodedGate.status,
        refundEligibilityHardcoded: refundEligibilityHardcodedGate.status,
        couponApplicationHardcoded: couponApplicationHardcodedGate.status,
        loyaltyPointsHardcoded: loyaltyPointsHardcodedGate.status,
        subscriptionRenewalHardcoded: subscriptionRenewalHardcodedGate.status,
        entitlementAccessHardcoded: entitlementAccessHardcodedGate.status,
        giftCardRedemptionHardcoded: giftCardRedemptionHardcodedGate.status,
        sellerPayoutHardcoded: sellerPayoutHardcodedGate.status,
        appointmentCancellationHardcoded:
          appointmentCancellationHardcodedGate.status,
        warrantyClaimHardcoded: warrantyClaimHardcodedGate.status,
        supportTicketRoutingHardcoded:
          supportTicketRoutingHardcodedGate.status,
        paymentDisputeHardcoded: paymentDisputeHardcodedGate.status,
        warehouseAllocationHardcoded: warehouseAllocationHardcodedGate.status,
        insuranceClaimHardcoded: insuranceClaimHardcodedGate.status,
        payrollOvertimeHardcoded: payrollOvertimeHardcodedGate.status,
        vendorInvoiceHardcoded: vendorInvoiceHardcodedGate.status,
        expenseReimbursementHardcoded:
          expenseReimbursementHardcodedGate.status,
        loanUnderwritingHardcoded: loanUnderwritingHardcodedGate.status,
        accountClosureHardcoded: accountClosureHardcodedGate.status,
        merchantOnboardingHardcoded: merchantOnboardingHardcodedGate.status,
        dataRetentionDeletionHardcoded:
          dataRetentionDeletionHardcodedGate.status,
        contentModerationAppealHardcoded:
          contentModerationAppealHardcodedGate.status,
        fraudRiskHardcoded: fraudRiskHardcodedGate.status,
        creditMemoApprovalHardcoded: creditMemoApprovalHardcodedGate.status,
        paymentSettlementHardcoded: paymentSettlementHardcodedGate.status,
        taxFilingHardcoded: taxFilingHardcodedGate.status,
        privacyConsentHardcoded: privacyConsentHardcodedGate.status,
        accessReviewHardcoded: accessReviewHardcodedGate.status,
        releaseReadinessHardcoded: releaseReadinessHardcodedGate.status,
        incidentResponseHardcoded: incidentResponseHardcodedGate.status,
        backupRestoreHardcoded: backupRestoreHardcodedGate.status,
        usageBillingHardcoded: usageBillingHardcodedGate.status,
        serviceOutageCreditHardcoded:
          serviceOutageCreditHardcodedGate.status,
        contractRenewalHardcoded: contractRenewalHardcodedGate.status
      }
    });
    const attackScenarioCheck = validateAdversaryLiveAttackScenarioResults(
      attackScenarioResults
    );
    if (!attackScenarioCheck.ok) {
      throw new Error(
        `adversary live attack scenarios did not pass: ${JSON.stringify(
          attackScenarioCheck.failures
        )}`
      );
    }

    const ledger = {
      status: 'ADVERSARY_LIVE_PASS',
      scenario: SCENARIO,
      run_id: RUN_ID,
      mode: REVIEWER_COMMAND
        ? 'advisory reviewer command + real R1 M2/M4 execution'
        : 'controlled command adversary + real R1 M2/M4 execution',
      adversary_reviewer: adversaryReviewerProvenance,
      image: IMAGE,
      evidence_bundle: bundle,
      worktree_root: workRoot,
      artifacts: {
        selected_patch: selectedPatchFile,
        ...(adversaryReview ? { adversary_review: reviewFile } : {}),
        handoff: handoffFile,
        confirmation: confirmationFile,
        candidate: candidateFile,
        replay_corpus: corpusFile,
        replay: replayFile,
        freeze: freezeFile,
        rulepack: rulepackFile
      },
      m2: {
        executed: confirmation.executed,
        runtime_available: confirmation.runtime_available,
        confirmed_count: confirmation.confirmed_count,
        all_confirmed: confirmation.all_confirmed
      },
      safety: safetyPlan,
      safety_check: safetyCheck,
      candidate: {
        candidate_created: candidate.candidate_created,
        added_rule_count: candidate.added_rules.length
      },
      corpus: {
        case_count: corpus.case_count
      },
      m4: {
        executed: replay.executed,
        replay_safe: replay.replaySafe,
        total: replay.total,
        matched: replay.matched
      },
      freeze: {
        frozen: freeze.frozen,
        rulepack_ref: freeze.rulepack_ref
      },
      inspect: {
        valid: inspected.valid,
        semantic_ready: inspected.semantic_ready,
        status: inspected.status
      },
      n_plus_one: {
        good_gate_status: goodGate.status,
        bad_gate_status: badGate.status,
        hardcoded_gate_status: hardcodedGate.status,
        default_quantity_hardcoded_gate_status:
          defaultQuantityHardcodedGate.status,
        zero_quantity_truthiness_hardcoded_gate_status:
          zeroQuantityTruthinessHardcodedGate.status,
        discount_hardcoded_gate_status: discountHardcodedGate.status,
        tax_hardcoded_gate_status: taxHardcodedGate.status,
        rounding_hardcoded_gate_status: roundingHardcodedGate.status,
        profile_visibility_hardcoded_gate_status:
          profileVisibilityHardcodedGate.status,
        profile_suspension_hardcoded_gate_status:
          profileSuspensionHardcodedGate.status,
        order_approval_hardcoded_gate_status: orderApprovalHardcodedGate.status,
        inventory_reservation_hardcoded_gate_status:
          inventoryReservationHardcodedGate.status,
        shipping_eligibility_hardcoded_gate_status:
          shippingEligibilityHardcodedGate.status,
        payment_authorization_hardcoded_gate_status:
          paymentAuthorizationHardcodedGate.status,
        refund_eligibility_hardcoded_gate_status:
          refundEligibilityHardcodedGate.status,
        coupon_application_hardcoded_gate_status:
          couponApplicationHardcodedGate.status,
        loyalty_points_hardcoded_gate_status: loyaltyPointsHardcodedGate.status,
        subscription_renewal_hardcoded_gate_status:
          subscriptionRenewalHardcodedGate.status,
        entitlement_access_hardcoded_gate_status:
          entitlementAccessHardcodedGate.status,
        gift_card_redemption_hardcoded_gate_status:
          giftCardRedemptionHardcodedGate.status,
        seller_payout_hardcoded_gate_status:
          sellerPayoutHardcodedGate.status,
        appointment_cancellation_hardcoded_gate_status:
          appointmentCancellationHardcodedGate.status,
        warranty_claim_hardcoded_gate_status:
          warrantyClaimHardcodedGate.status,
        support_ticket_routing_hardcoded_gate_status:
          supportTicketRoutingHardcodedGate.status,
        payment_dispute_hardcoded_gate_status:
          paymentDisputeHardcodedGate.status,
        warehouse_allocation_hardcoded_gate_status:
          warehouseAllocationHardcodedGate.status,
        insurance_claim_hardcoded_gate_status:
          insuranceClaimHardcodedGate.status,
        payroll_overtime_hardcoded_gate_status:
          payrollOvertimeHardcodedGate.status,
        vendor_invoice_hardcoded_gate_status:
          vendorInvoiceHardcodedGate.status,
        expense_reimbursement_hardcoded_gate_status:
          expenseReimbursementHardcodedGate.status,
        loan_underwriting_hardcoded_gate_status:
          loanUnderwritingHardcodedGate.status,
        account_closure_hardcoded_gate_status:
          accountClosureHardcodedGate.status,
        merchant_onboarding_hardcoded_gate_status:
          merchantOnboardingHardcodedGate.status,
        data_retention_deletion_hardcoded_gate_status:
          dataRetentionDeletionHardcodedGate.status,
        content_moderation_appeal_hardcoded_gate_status:
          contentModerationAppealHardcodedGate.status,
        fraud_risk_hardcoded_gate_status: fraudRiskHardcodedGate.status,
        credit_memo_approval_hardcoded_gate_status:
          creditMemoApprovalHardcodedGate.status,
        payment_settlement_hardcoded_gate_status:
          paymentSettlementHardcodedGate.status,
        tax_filing_hardcoded_gate_status: taxFilingHardcodedGate.status,
        privacy_consent_hardcoded_gate_status:
          privacyConsentHardcodedGate.status,
        access_review_hardcoded_gate_status:
          accessReviewHardcodedGate.status,
        release_readiness_hardcoded_gate_status:
          releaseReadinessHardcodedGate.status,
        incident_response_hardcoded_gate_status:
          incidentResponseHardcodedGate.status,
        backup_restore_hardcoded_gate_status:
          backupRestoreHardcodedGate.status,
        usage_billing_hardcoded_gate_status:
          usageBillingHardcodedGate.status,
        service_outage_credit_hardcoded_gate_status:
          serviceOutageCreditHardcodedGate.status,
        contract_renewal_hardcoded_gate_status:
          contractRenewalHardcodedGate.status,
        bad_rejected: badGate.status === 'fail',
        visible_only_hardcode_rejected: hardcodedGate.status === 'fail',
        default_quantity_hardcode_rejected:
          defaultQuantityHardcodedGate.status === 'fail',
        zero_quantity_truthiness_hardcode_rejected:
          zeroQuantityTruthinessHardcodedGate.status === 'fail',
        discount_hardcode_rejected: discountHardcodedGate.status === 'fail',
        tax_hardcode_rejected: taxHardcodedGate.status === 'fail',
        rounding_hardcode_rejected: roundingHardcodedGate.status === 'fail',
        profile_visibility_hardcode_rejected:
          profileVisibilityHardcodedGate.status === 'fail',
        profile_suspension_hardcode_rejected:
          profileSuspensionHardcodedGate.status === 'fail',
        order_approval_hardcode_rejected:
          orderApprovalHardcodedGate.status === 'fail',
        inventory_reservation_hardcode_rejected:
          inventoryReservationHardcodedGate.status === 'fail',
        shipping_eligibility_hardcode_rejected:
          shippingEligibilityHardcodedGate.status === 'fail',
        payment_authorization_hardcode_rejected:
          paymentAuthorizationHardcodedGate.status === 'fail',
        refund_eligibility_hardcode_rejected:
          refundEligibilityHardcodedGate.status === 'fail',
        coupon_application_hardcode_rejected:
          couponApplicationHardcodedGate.status === 'fail',
        loyalty_points_hardcode_rejected:
          loyaltyPointsHardcodedGate.status === 'fail',
        subscription_renewal_hardcode_rejected:
          subscriptionRenewalHardcodedGate.status === 'fail',
        entitlement_access_hardcode_rejected:
          entitlementAccessHardcodedGate.status === 'fail',
        gift_card_redemption_hardcode_rejected:
          giftCardRedemptionHardcodedGate.status === 'fail',
        seller_payout_hardcode_rejected:
          sellerPayoutHardcodedGate.status === 'fail',
        appointment_cancellation_hardcode_rejected:
          appointmentCancellationHardcodedGate.status === 'fail',
        warranty_claim_hardcode_rejected:
          warrantyClaimHardcodedGate.status === 'fail',
        support_ticket_routing_hardcode_rejected:
          supportTicketRoutingHardcodedGate.status === 'fail',
        payment_dispute_hardcode_rejected:
          paymentDisputeHardcodedGate.status === 'fail',
        warehouse_allocation_hardcode_rejected:
          warehouseAllocationHardcodedGate.status === 'fail',
        insurance_claim_hardcode_rejected:
          insuranceClaimHardcodedGate.status === 'fail',
        payroll_overtime_hardcode_rejected:
          payrollOvertimeHardcodedGate.status === 'fail',
        vendor_invoice_hardcode_rejected:
          vendorInvoiceHardcodedGate.status === 'fail',
        expense_reimbursement_hardcode_rejected:
          expenseReimbursementHardcodedGate.status === 'fail',
        loan_underwriting_hardcode_rejected:
          loanUnderwritingHardcodedGate.status === 'fail',
        account_closure_hardcode_rejected:
          accountClosureHardcodedGate.status === 'fail',
        merchant_onboarding_hardcode_rejected:
          merchantOnboardingHardcodedGate.status === 'fail',
        data_retention_deletion_hardcode_rejected:
          dataRetentionDeletionHardcodedGate.status === 'fail',
        content_moderation_appeal_hardcode_rejected:
          contentModerationAppealHardcodedGate.status === 'fail',
        fraud_risk_hardcode_rejected:
          fraudRiskHardcodedGate.status === 'fail',
        credit_memo_approval_hardcode_rejected:
          creditMemoApprovalHardcodedGate.status === 'fail',
        payment_settlement_hardcode_rejected:
          paymentSettlementHardcodedGate.status === 'fail',
        tax_filing_hardcode_rejected:
          taxFilingHardcodedGate.status === 'fail',
        privacy_consent_hardcode_rejected:
          privacyConsentHardcodedGate.status === 'fail',
        access_review_hardcode_rejected:
          accessReviewHardcodedGate.status === 'fail',
        release_readiness_hardcode_rejected:
          releaseReadinessHardcodedGate.status === 'fail',
        incident_response_hardcode_rejected:
          incidentResponseHardcodedGate.status === 'fail',
        backup_restore_hardcode_rejected:
          backupRestoreHardcodedGate.status === 'fail',
        usage_billing_hardcode_rejected:
          usageBillingHardcodedGate.status === 'fail',
        service_outage_credit_hardcode_rejected:
          serviceOutageCreditHardcodedGate.status === 'fail',
        contract_renewal_hardcode_rejected:
          contractRenewalHardcodedGate.status === 'fail'
      },
      attack_scenarios: {
        checked_count: attackScenarioResults.length,
        passed_count: attackScenarioResults.filter((result) => result.passed)
          .length,
        check: attackScenarioCheck,
        results: attackScenarioResults
      },
      ...(adversaryReview ? { adversary_review: adversaryReview } : {}),
      limitation: REVIEWER_COMMAND
        ? 'This UAT used an advisory reviewer command proposal; it remains current-loop advisory only and still requires R1 M2/M4 evidence.'
        : 'This UAT uses a controlled command adversary proposal; real Codex adversary reviewer generation remains a separate live lane.'
    };
    const evidenceBundle = await writeUatEvidenceBundle({
      scenario: SCENARIO,
      runId: RUN_ID,
      tmpRoot,
      dataDir: artifactRoot,
      output: ledger,
      extraFiles: [
        { kind: 'report', label: 'm2-handoff', path: handoffFile },
        ...(adversaryReview
          ? [{ kind: 'report', label: 'adversary-review', path: reviewFile }]
          : []),
        { kind: 'report', label: 'candidate-patch', path: selectedPatchFile },
        { kind: 'report', label: 'm2-confirmation', path: confirmationFile },
        { kind: 'report', label: 'rulepack-candidate', path: candidateFile },
        { kind: 'report', label: 'm4-replay-corpus', path: corpusFile },
        { kind: 'report', label: 'm4-replay', path: replayFile },
        { kind: 'report', label: 'rulepack-freeze', path: freezeFile },
        { kind: 'report', label: 'rulepack-lock', path: rulepackFile }
      ],
      extraJson: {
        safety: safetyPlan,
        safety_check: safetyCheck,
        adversary_reviewer: ledger.adversary_reviewer,
        ...(adversaryReview ? { adversary_review: adversaryReview } : {}),
        attack_scenarios: ledger.attack_scenarios
      },
      evidenceDir: evidenceRoot
    });
    ledger.evidence_bundle = evidenceBundle.bundle_dir;
    ledger.evidence_manifest = evidenceBundle.manifest_path;
    ledger.evidence_copied_count = evidenceBundle.copied_count + 1;
    ledger.evidence_missing_count = evidenceBundle.missing_count;
    const ledgerFile = await writeUatEvidenceLedger(evidenceBundle, ledger);
    console.log(JSON.stringify({ ...ledger, ledger: ledgerFile }, null, 2));
  } finally {
    if (!KEEP_TMP) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
