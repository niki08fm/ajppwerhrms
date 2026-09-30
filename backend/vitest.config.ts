import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // API tests share one database; run files serially.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['test/**/*.test.ts'],
    setupFiles: process.argv.some((a) => a.includes('test/engines')) ? [] : ['test/api/setup-env.ts'],
    globalSetup: process.argv.some((a) => a.includes('test/engines')) ? [] : ['test/api/global-setup.ts'],
  },
});
