import fc from 'fast-check';

/**
 * Global fast-check configuration for the `property` project.
 *
 * Seed policy, so that a CI failure is reproducible locally:
 *
 * 1. CI (`CI` is set) uses `CI_SEED` below, a fixed value. Every CI run therefore explores the same
 *    inputs in the same order, so a failure is not a one-off that disappears on re-run.
 * 2. Local runs pass no seed, so fast-check derives one from the clock and each run explores new
 *    inputs. That is how new counterexamples get found.
 * 3. `FAST_CHECK_SEED` overrides both. On failure fast-check's report prints the seed, the path, and
 *    the shrunk counterexample; re-running with `FAST_CHECK_SEED=<printed seed> npm run test:property`
 *    reproduces it. To jump straight to the shrunk case, also pass the printed path to that one
 *    assertion: `fc.assert(prop, { path: '<printed path>' })`.
 */
const CI_SEED = 20260101;

function resolveSeed(): number | undefined {
  const override = process.env.FAST_CHECK_SEED;
  if (override !== undefined && override.trim() !== '') {
    const parsed = Number(override);
    if (!Number.isInteger(parsed)) {
      throw new Error(`FAST_CHECK_SEED must be an integer, received: ${override}`);
    }
    return parsed;
  }
  return process.env.CI !== undefined && process.env.CI !== '' ? CI_SEED : undefined;
}

const seed = resolveSeed();

fc.configureGlobal({
  // The design requires a minimum of 100 iterations for each of the 27 properties. Individual
  // assertions may raise this; none may lower it.
  numRuns: 100,
  // Keep the failing error in the report alongside the counterexample and the seed.
  includeErrorInReport: true,
  ...(seed === undefined ? {} : { seed }),
});
