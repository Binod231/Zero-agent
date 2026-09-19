import type { Clock } from '../../src/core/clock';

/**
 * Clock doubles: one frozen, one virtual. Both implement `Clock`, so anything constructed with a real
 * clock in production is constructed with one of these in a test.
 *
 * - **Frozen** never moves. That is what lets Properties 16 and 21 assert an exact `createdAt` or
 *   `updatedAt` string rather than a range: the acceptance instant is a constant of the test.
 * - **Virtual** moves only when told to, or when something sleeps on it. Property 22 drives arrival
 *   sequences through it, and Property 17 drives the 60-second generation deadline and the 1 s / 2 s
 *   backoff sleeps without waiting three seconds of wall clock per iteration.
 */

/** Any instant accepted by a double: epoch milliseconds, or a string `Date` can parse. */
export type InstantInput = number | string;

const MIN_EPOCH_MS = Date.parse('1000-01-01T00:00:00.000Z');
const MAX_EPOCH_MS = Date.parse('9999-12-31T23:59:59.999Z');

/**
 * Both doubles are pinned to the four-digit-year range, because outside it `toISOString` produces the
 * expanded `+275760-…` form, which is not the 24-character instant the Entry_Serializer accepts. A
 * test that wandered out of range would otherwise fail much later with a confusing decode error.
 */
function toEpochMs(instant: InstantInput): number {
  const epochMs = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(epochMs)) {
    throw new RangeError(`not a parseable instant: ${String(instant)}`);
  }
  if (!Number.isInteger(epochMs)) {
    throw new RangeError('an instant must be a whole number of milliseconds');
  }
  if (epochMs < MIN_EPOCH_MS || epochMs > MAX_EPOCH_MS) {
    throw new RangeError('an instant must fall between 1000-01-01 and 9999-12-31 UTC');
  }
  return epochMs;
}

function toInstant(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function assertDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError('a sleep duration must be a non-negative finite number of milliseconds');
  }
}

/**
 * A clock stopped at one instant.
 *
 * `sleep` records the requested duration and resolves without moving time, which is deliberate: a
 * frozen clock's whole purpose is that two timestamps taken either side of an operation are equal, so
 * a test can assert the exact value the handler wrote.
 */
export class FrozenClock implements Clock {
  readonly #epochMs: number;
  readonly #sleeps: number[] = [];

  constructor(instant: InstantInput) {
    this.#epochMs = toEpochMs(instant);
  }

  nowMs(): number {
    return this.#epochMs;
  }

  nowIso(): string {
    return toInstant(this.#epochMs);
  }

  async sleep(durationMs: number): Promise<void> {
    assertDuration(durationMs);
    this.#sleeps.push(durationMs);
    await Promise.resolve();
  }

  /** Every duration slept on, in order. Property 17 asserts the backoff intervals from this. */
  get sleeps(): readonly number[] {
    return [...this.#sleeps];
  }
}

/**
 * A clock that advances only under test control.
 *
 * `sleep` advances by exactly the requested duration and resolves on the next microtask, so code
 * under test observes time passing while the suite spends none. Time never moves backwards:
 * `advanceMs` rejects a negative argument, and `setTo` rejects an earlier instant.
 */
export class VirtualClock implements Clock {
  #epochMs: number;
  readonly #sleeps: number[] = [];

  constructor(instant: InstantInput) {
    this.#epochMs = toEpochMs(instant);
  }

  nowMs(): number {
    return this.#epochMs;
  }

  nowIso(): string {
    return toInstant(this.#epochMs);
  }

  async sleep(durationMs: number): Promise<void> {
    assertDuration(durationMs);
    this.#sleeps.push(durationMs);
    this.advanceMs(durationMs);
    await Promise.resolve();
  }

  /** Moves now forward. Zero is allowed; negative is a test bug. */
  advanceMs(durationMs: number): void {
    assertDuration(durationMs);
    this.#epochMs = toEpochMs(this.#epochMs + durationMs);
  }

  /** Jumps to an instant at or after the current one. */
  setTo(instant: InstantInput): void {
    const next = toEpochMs(instant);
    if (next < this.#epochMs) {
      throw new RangeError('a virtual clock cannot move backwards');
    }
    this.#epochMs = next;
  }

  /** Every duration slept on, in order. */
  get sleeps(): readonly number[] {
    return [...this.#sleeps];
  }
}
