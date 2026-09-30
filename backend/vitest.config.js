import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // API tests share one database; run files serially.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    include: ['tests/**/*.test.js'],
    setupFiles: process.argv.some((a) => a.includes('tests/engines')) ? [] : ['tests/api/setup-env.js'],
    globalSetup: process.argv.some((a) => a.includes('tests/engines')) ? [] : ['tests/api/global-setup.js'],
  },
});
