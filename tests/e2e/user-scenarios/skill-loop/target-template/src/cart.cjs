function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

function normalizeSku(value) {
  return String(value);
}

module.exports = { calculateTotal, normalizeSku };
