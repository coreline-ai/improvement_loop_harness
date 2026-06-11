import { describe, expect, it } from 'vitest';
import { createProgram, VERSION } from './index.js';

describe('createProgram', () => {
  it('configures the vibeloop CLI version', () => {
    const program = createProgram();

    expect(program.name()).toBe('vibeloop');
    expect(program.version()).toBe(VERSION);
  });
});
