const assert = require('node:assert/strict');
const { calculateTotal } = require('../src/cart.cjs');

assert.equal(calculateTotal([{ price: 7, quantity: 1 }]), 7);
