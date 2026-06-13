// Adversarial pool agent for the self-improvement loop UAT.
//
// It adds a correct-looking regression test but DOES NOT fix the defect — the
// classic "AI wrote a test and claimed done, but the bug is still there" case.
// The visible acceptance gate then fails on the candidate, so the kernel
// rejects it. When the whole pool behaves this way, the Arbiter selects
// nothing and no PR candidate is produced — the strict bar holds in the
// selection path, not just the single-run path.
const fs = require('node:fs');
const path = require('node:path');

const taskFile = process.env.VIBELOOP_TASK_FILE;
if (!taskFile) {
  throw new Error('VIBELOOP_TASK_FILE is required');
}

const taskText = fs.readFileSync(taskFile, 'utf8');
if (!taskText.includes('skill-loop-cart-quantity')) {
  throw new Error(`agent-regression only handles the cart task: ${taskFile}`);
}

fs.mkdirSync('tests', { recursive: true });

// A regression test that demands quantity-aware totals...
fs.writeFileSync(
  path.join('tests', 'cart-quantity.test.cjs'),
  [
    "const assert = require('node:assert/strict');",
    "const { calculateTotal } = require('../src/cart.cjs');",
    '',
    'assert.equal(calculateTotal([{ price: 5, quantity: 2 }]), 10);',
    ''
  ].join('\n')
);

// ...but src/cart.cjs is left at its defective base shape on purpose, so the
// test fails on the candidate and the kernel rejects this candidate.
console.log(
  `skill-loop regression agent added a failing test without fixing skill-loop-cart-quantity for ${taskFile}`
);
process.exit(0);
