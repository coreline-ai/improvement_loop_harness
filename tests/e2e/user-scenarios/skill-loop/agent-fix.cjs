const fs = require('node:fs');
const path = require('node:path');

const taskFile = process.env.VIBELOOP_TASK_FILE;
if (!taskFile) {
  throw new Error('VIBELOOP_TASK_FILE is required');
}

const taskText = fs.readFileSync(taskFile, 'utf8');
const isCartQuantity = taskText.includes('skill-loop-cart-quantity');
const isSkuNormalization = taskText.includes('skill-loop-sku-normalization');

if (!isCartQuantity && !isSkuNormalization) {
  throw new Error(`unsupported skill loop task: ${taskFile}`);
}

fs.mkdirSync('src', { recursive: true });
fs.mkdirSync('tests', { recursive: true });

if (isCartQuantity) {
  fs.writeFileSync(
    path.join('src', 'cart.cjs'),
    [
      'function calculateTotal(items) {',
      '  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);',
      '}',
      '',
      'function normalizeSku(value) {',
      '  return String(value);',
      '}',
      '',
      'module.exports = { calculateTotal, normalizeSku };',
      ''
    ].join('\n')
  );
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
    `skill-loop agent applied skill-loop-cart-quantity for ${taskFile}`
  );
  process.exit(0);
}

fs.writeFileSync(
  path.join('src', 'cart.cjs'),
  [
    'function calculateTotal(items) {',
    '  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);',
    '}',
    '',
    'function normalizeSku(value) {',
    '  return String(value).trim().toUpperCase();',
    '}',
    '',
    'module.exports = { calculateTotal, normalizeSku };',
    ''
  ].join('\n')
);
fs.writeFileSync(
  path.join('tests', 'sku-normalization.test.cjs'),
  [
    "const assert = require('node:assert/strict');",
    "const { normalizeSku } = require('../src/cart.cjs');",
    '',
    "assert.equal(normalizeSku('  sku-42  '), 'SKU-42');",
    ''
  ].join('\n')
);
console.log(
  `skill-loop agent applied skill-loop-sku-normalization for ${taskFile}`
);
