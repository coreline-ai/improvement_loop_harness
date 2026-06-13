const assert = require('node:assert/strict');
const { calculateTotal, normalizeSku } = require('../src/cart.cjs');

assert.equal(calculateTotal([{ price: 7, quantity: 1 }]), 7);
assert.equal(normalizeSku('ABC-123'), 'ABC-123');
