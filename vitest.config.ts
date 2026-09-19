import { defineConfig } from 'vitest/config';

/**
 * Four separate, individually selectable projects, matching the four test layers in the design's
 * Testing Strategy. Every project is selectable with `vitest run --project <name>`, which is what
 * the `test:*` npm scripts do.
 *
 * `npm test` runs `unit`, `property`, and `infra` and deliberately omits `integration`: integration
 * tests talk to a deployed stack (real Bedrock, real CloudFront), so they are on-demand only and
 * must never be pulled in by a default test run.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'property',
          environment: 'node',
          include: ['test/property/**/*.test.ts'],
          // Sets the global fast-check defaults: minimum 100 runs per property and the seed policy.
          setupFiles: ['./test/setup.fast-check.ts'],
        },
      },
      {
        test: {
          name: 'infra',
          environment: 'node',
          include: ['test/infra/**/*.test.ts'],
          // CDK synthesis is slower than a pure-core assertion.
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          // Hits deployed AWS. Excluded from `npm test`; run with `npm run test:integration`.
          // Publish visibility and CloudFront propagation are asserted within 60 seconds, so the
          // per-test budget has to sit above that.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // Shared deployed state: concurrent files would interfere with each other's seed data.
          fileParallelism: false,
        },
      },
    ],
  },
});
