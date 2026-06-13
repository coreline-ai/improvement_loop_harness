import { describe, expect, it } from 'vitest';
import { filterAdversaryProposal } from './adversary-filter.js';

const config = {
  testDirs: ['tests/', '.vibeloop/ephemeral/'],
  objectiveTerms: ['cart', 'quantity'],
  hiddenMarkers: ['HIDDEN_ACCEPTANCE_TOKEN', 'sk-secret'],
  maxBodyBytes: 4096
};

describe('filterAdversaryProposal', () => {
  it('accepts an in-scope objective-linked test and marks it for execution confirmation', () => {
    const result = filterAdversaryProposal(
      {
        id: 'p1',
        targetPath: 'tests/cart-quantity-edge.test.js',
        body: "assert(cart.quantity('') === 0);\n",
        expectation: 'fail_to_pass'
      },
      config
    );
    expect(result.accepted).toBe(true);
    expect(result.classification).toBe('objective_edge');
    expect(result.requiresExecutionConfirmation).toBe(true);
    expect(result.failedFilters).toEqual([]);
  });

  it('classifies a pass_to_pass proposal as a regression guard', () => {
    const result = filterAdversaryProposal(
      {
        id: 'p2',
        targetPath: 'tests/cart-regression.test.js',
        body: 'assert(cart.quantity(2) === 2);\n',
        expectation: 'pass_to_pass'
      },
      config
    );
    expect(result.accepted).toBe(true);
    expect(result.classification).toBe('regression_guard');
  });

  it('rejects out-of-scope or unlinked proposals as out_of_scope', () => {
    const outside = filterAdversaryProposal(
      {
        id: 'p3',
        targetPath: 'src/secret.js',
        body: 'assert(cart.quantity(1) === 1);\n'
      },
      config
    );
    expect(outside.accepted).toBe(false);
    expect(outside.failedFilters).toContain('scope');
    expect(outside.classification).toBe('out_of_scope');

    const unlinked = filterAdversaryProposal(
      {
        id: 'p4',
        targetPath: 'tests/unrelated.test.js',
        body: 'assert(1 === 1);\n'
      },
      config
    );
    expect(unlinked.failedFilters).toContain('objective_link');
    expect(unlinked.classification).toBe('out_of_scope');
  });

  it('rejects weakening proposals as invalid', () => {
    const result = filterAdversaryProposal(
      {
        id: 'p5',
        targetPath: 'tests/cart.test.js',
        body: 'test.skip("cart quantity", () => {});\nexpect(true).toBe(true);\n'
      },
      config
    );
    expect(result.accepted).toBe(false);
    expect(result.failedFilters).toContain('no_weakening');
    expect(result.classification).toBe('invalid');
  });

  it('rejects proposals that embed hidden-acceptance/secret markers', () => {
    const result = filterAdversaryProposal(
      {
        id: 'p6',
        targetPath: 'tests/cart.test.js',
        body: 'assert(cart.quantity(1) === 1); // HIDDEN_ACCEPTANCE_TOKEN\n'
      },
      config
    );
    expect(result.accepted).toBe(false);
    expect(result.failedFilters).toContain('no_hidden_leak');
    expect(result.classification).toBe('invalid');
  });

  it('rejects oversized proposals as invalid (bounded cost)', () => {
    const result = filterAdversaryProposal(
      {
        id: 'p7',
        targetPath: 'tests/cart.test.js',
        body: `// cart quantity\n${'a'.repeat(5000)}`
      },
      { ...config, maxBodyBytes: 100 }
    );
    expect(result.accepted).toBe(false);
    expect(result.failedFilters).toContain('bounded_cost');
    expect(result.classification).toBe('invalid');
  });
});
