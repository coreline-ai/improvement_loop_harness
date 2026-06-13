// Parametric command builder agent for the self-improvement loop UAT.
//
// Both styles produce a FUNCTIONALLY IDENTICAL, correct fix plus a regression
// test that fails on the base commit and passes on the candidate. They differ
// ONLY in diff size:
//   - tight   : minimal diff (the smallest correct change)
//   - verbose : same behaviour, but extra documentation + an extra in-scope
//               notes file, i.e. a larger diff
//
// The deterministic Arbiter scores smaller diffs higher
// (evidence_present*100 - changed_files*5 - changed_lines), so when a verbose
// builder and a tight challenger both pass, the tight challenger is selected.
// That selection IS the observable "self-improvement progressed in a better
// direction" signal: same correctness, measurably cleaner change.
const fs = require('node:fs');
const path = require('node:path');

const taskFile = process.env.VIBELOOP_TASK_FILE;
if (!taskFile) {
  throw new Error('VIBELOOP_TASK_FILE is required');
}

const style = (process.env.VIBELOOP_CANDIDATE_STYLE || 'tight').toLowerCase();
if (style !== 'tight' && style !== 'verbose') {
  throw new Error(`unsupported VIBELOOP_CANDIDATE_STYLE: ${style}`);
}

const taskText = fs.readFileSync(taskFile, 'utf8');
const isCart = taskText.includes('skill-loop-cart-quantity');
const isSku = taskText.includes('skill-loop-sku-normalization');
if (!isCart && !isSku) {
  throw new Error(`unsupported skill loop task: ${taskFile}`);
}

fs.mkdirSync('src', { recursive: true });
fs.mkdirSync('tests', { recursive: true });

// The cart issue fixes only calculateTotal; the sku issue fixes only
// normalizeSku. Each candidate leaves the other function at its base shape so
// the diff stays scoped to the single objective.
const normalizeBody = isSku
  ? '  return String(value).trim().toUpperCase();'
  : '  return String(value);';

const cartLines = [];
if (style === 'verbose') {
  cartLines.push('// cart.cjs — order math helpers');
  cartLines.push(
    '// calculateTotal multiplies unit price by quantity for each line item.'
  );
  cartLines.push(
    '// (verbose candidate: extra documentation, identical behaviour)'
  );
  cartLines.push('');
}
cartLines.push('function calculateTotal(items) {');
if (style === 'verbose') {
  cartLines.push('  // sum price * quantity across every line item');
}
cartLines.push(
  '  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);'
);
cartLines.push('}');
cartLines.push('');
cartLines.push('function normalizeSku(value) {');
cartLines.push(normalizeBody);
cartLines.push('}');
cartLines.push('');
cartLines.push('module.exports = { calculateTotal, normalizeSku };');
cartLines.push('');
fs.writeFileSync(path.join('src', 'cart.cjs'), cartLines.join('\n'));

if (isCart) {
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
} else {
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
}

// verbose candidate adds an extra in-scope notes file -> larger, lower-scoring
// diff. Content is intentionally benign (no prior-issue id, no secret, no
// token-like string) so the artifact-leak gate stays clean.
if (style === 'verbose') {
  const slug = isCart ? 'cart-quantity' : 'sku-normalization';
  fs.writeFileSync(
    path.join('src', `${slug}-notes.cjs`),
    [
      '// Implementation notes (verbose candidate).',
      '// Documents intent only; not part of the runtime contract.',
      'module.exports = {',
      `  issue: '${slug}',`,
      "  rationale: 'fix preserves the public API; only the defective branch changed'",
      '};',
      ''
    ].join('\n')
  );
}

const issueId = isCart
  ? 'skill-loop-cart-quantity'
  : 'skill-loop-sku-normalization';
console.log(
  `skill-loop candidate(${style}) applied ${issueId} for ${taskFile}`
);
process.exit(0);
