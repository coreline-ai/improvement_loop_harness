const assert = require('node:assert/strict');
const { normalizeSku } = require('../../src/cart.cjs');

// SECRET_HIDDEN_EXPECTATION: skill loop hidden SKU acceptance must not leak.
assert.equal(normalizeSku('  ab-120-x  '), 'AB-120-X');
