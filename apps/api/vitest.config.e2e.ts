import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    fileParallelism: false, // ponytail: e2e files share one Postgres DB and assert global row counts, so run files one at a time (whole suite ~2s); per-file schemas if it gets slow
  },
});
