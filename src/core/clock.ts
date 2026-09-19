/**
 * The injectable clock.
 *
 * Nothing in the System reads `Date.now()` or calls `setTimeout` directly. Every timestamp and every
 * wait goes through this interface, for two reasons the design names outright:
 *
 * - Properties 16 and 21 assert an exact `createdAt` / `updatedAt` value, which is only possible
 *   against a clock that does not move during the assertion.
 * - Property 17 asserts the Entry_Generator's 1 s and 2 s backoff sleeps and its 60-second deadline.
 *   A real sleep would make that property take minutes; a virtual clock makes it instant while still
 *   exercising the same code path.
 *
 * The test doubles live in `test/doubles/clock.ts`. This module is interface only, so production code
 * and the doubles agree on one shape.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;

  /**
   * The current instant as the canonical 24-character `YYYY-MM-DDTHH:mm:ss.sssZ` UTC form — the one
   * spelling the Entry_Serializer accepts for `createdAt` and `updatedAt`.
   */
  nowIso(): string;

  /**
   * Waits at least `durationMs` before resolving. A virtual implementation resolves immediately and
   * advances its own notion of now instead, which is what keeps the backoff assertions cheap.
   */
  sleep(durationMs: number): Promise<void>;
}
