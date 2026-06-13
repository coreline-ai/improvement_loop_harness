const assert = require('node:assert/strict');
const { calculateTotal } = require('../../src/cart.cjs');

// SECRET_HIDDEN_EXPECTATION: user scenario hidden acceptance must not leak into artifacts.
assert.equal(
  calculateTotal([
    { price: 3, quantity: 4 },
    { price: 2, quantity: 5 }
  ]),
  22
);
