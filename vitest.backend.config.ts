import { defineConfig } from 'vitest/config';
import path from 'path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts', './src/test/backend/backendIntegrationSetup.ts'],
    include: ['src/test/backend/**/*.test.ts', 'src/test/backend/**/*.test.tsx'],
    globals: true,
    threads: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
