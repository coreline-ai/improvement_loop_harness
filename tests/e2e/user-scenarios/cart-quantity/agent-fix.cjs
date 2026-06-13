const fs = require('node:fs');
const path = require('node:path');

fs.mkdirSync('src', { recursive: true });
fs.writeFileSync(
  path.join('src', 'cart.cjs'),
  [
    'function calculateTotal(items) {',
    '  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);',
    '}',
    '',
    'module.exports = { calculateTotal };',
    ''
  ].join('\n')
);

fs.mkdirSync('tests', { recursive: true });
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

console.log(
  `real command agent applied cart quantity fix for ${process.env.VIBELOOP_TASK_FILE}`
);
