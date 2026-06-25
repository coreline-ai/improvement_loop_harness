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
  buildAppointmentCancellationSemanticProposal,
  buildCommandAdversaryReviewerProvenance,
  buildControlledAdversaryReviewerProvenance,
  buildCartDiscountSemanticProposal,
  buildCouponApplicationSemanticProposal,
  buildEntitlementAccessSemanticProposal,
  buildGiftCardRedemptionSemanticProposal,
  buildInventoryReservationSemanticProposal,
  buildOrderApprovalSemanticProposal,
  buildProfileSuspensionSemanticProposal,
  buildProfileVisibilitySemanticProposal,
  buildCartRoundingSemanticProposal,
  buildCartSemanticProposal,
  buildCartTaxSemanticProposal,
  buildPaymentAuthorizationSemanticProposal,
  buildRefundEligibilitySemanticProposal,
  buildLoyaltyPointsSemanticProposal,
  buildSellerPayoutSemanticProposal,
  buildShippingEligibilitySemanticProposal,
  buildSupportTicketRoutingSemanticProposal,
  buildSubscriptionRenewalSemanticProposal,
  buildWarrantyClaimSemanticProposal,
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
      supportTicketRoutingHardcodedGate?.status !== 'fail'
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
          supportTicketRoutingHardcoded: supportTicketRoutingHardcodedGate
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
          supportTicketRoutingHardcodedGate.status
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
          supportTicketRoutingHardcodedGate.status === 'fail'
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
