import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 10_000,
    env: { LMNR_LOG_LEVEL: 'silent' },
  },
});
