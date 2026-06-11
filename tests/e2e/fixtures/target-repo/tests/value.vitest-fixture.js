import { expect, test } from 'vitest';
import value from '../src/value.cjs';

test('base value is one', () => {
  expect(value).toBe(1);
});
