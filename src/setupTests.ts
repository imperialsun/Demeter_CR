/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import '@testing-library/jest-dom';

// Global mocks and helpers for Vitest + Testing Library

// Mock crypto.randomUUID for test environments if missing
if (typeof (globalThis as any).crypto === 'undefined') {
  (globalThis as any).crypto = { randomUUID: () => 'test-uuid' };
} else if (typeof (globalThis as any).crypto.randomUUID !== 'function') {
  (globalThis as any).crypto.randomUUID = () => 'test-uuid';
}

// Polyfill URL.createObjectURL/revokeObjectURL used by AudioPlayer and other components
if (typeof (URL as any).createObjectURL !== 'function') {
  (URL as any).createObjectURL = (_: any) => 'blob://test';
}
if (typeof (URL as any).revokeObjectURL !== 'function') {
  (URL as any).revokeObjectURL = (_: any) => {};
}

// Simple localStorage/sessionStorage polyfill for test envs
if (typeof window !== 'undefined') {
  if (typeof window.localStorage?.getItem !== 'function') {
    (window as any).localStorage = {
      getItem: (_: string) => null,
      setItem: (_: string, __: string) => {},
      removeItem: (_: string) => {},
      clear: () => {},
    };
  }
  if (typeof window.sessionStorage?.getItem !== 'function') {
    (window as any).sessionStorage = {
      getItem: (_: string) => null,
      setItem: (_: string, __: string) => {},
      removeItem: (_: string) => {},
      clear: () => {},
    };
  }
}
