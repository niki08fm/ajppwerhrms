import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/worker.ts', 'src/jobs/retention.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Bundle the workspace packages (TypeScript source) into the output: the shared rules and face matching.
  noExternal: ['@ajpwer/shared', '@ajpwer/face'],
});
