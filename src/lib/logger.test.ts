import { describe, it, expect } from 'vitest';

// Backwards-compatible placeholder so Vitest's default `src/**/*.test.ts` pattern
// doesn't fail with "No test suite found" after we moved the real tests to `test/`.
describe('logger placeholder', () => {
  it('placeholder test to satisfy test runner', () => {
    expect(true).toBe(true);
  });
});