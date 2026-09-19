import { describe, expect, it } from 'vitest';
import { FrozenClock, VirtualClock } from '../../doubles/clock';

/**
 * Unit tests of the clock doubles. Not correctness properties: these check that the injectable clock
 * behaves as the properties assume — frozen means constant, virtual means advancing under control.
 */

const INSTANT = '2026-09-19T21:04:11.417Z';

describe('FrozenClock', () => {
  it('returns the same instant however often it is read', () => {
    const clock = new FrozenClock(INSTANT);
    expect(clock.nowIso()).toBe(INSTANT);
    expect(clock.nowIso()).toBe(INSTANT);
    expect(clock.nowMs()).toBe(Date.parse(INSTANT));
  });

  it('emits the canonical 24-character UTC instant', () => {
    expect(new FrozenClock(0).nowIso()).toBe('1970-01-01T00:00:00.000Z');
    expect(new FrozenClock(INSTANT).nowIso()).toHaveLength(24);
  });

  it('records a sleep without moving time', async () => {
    const clock = new FrozenClock(INSTANT);
    await clock.sleep(1000);
    await clock.sleep(2000);
    expect(clock.sleeps).toEqual([1000, 2000]);
    expect(clock.nowIso()).toBe(INSTANT);
  });

  it('refuses an unparseable instant and a negative sleep', async () => {
    expect(() => new FrozenClock('not a date')).toThrow(RangeError);
    await expect(new FrozenClock(INSTANT).sleep(-1)).rejects.toThrow(RangeError);
  });
});

describe('VirtualClock', () => {
  it('advances only when told to', () => {
    const clock = new VirtualClock(INSTANT);
    clock.advanceMs(583);
    expect(clock.nowIso()).toBe('2026-09-19T21:04:12.000Z');
    clock.advanceMs(60_000);
    expect(clock.nowIso()).toBe('2026-09-19T21:05:12.000Z');
  });

  it('advances by the slept duration and records it, which is how backoff is asserted', async () => {
    const clock = new VirtualClock(INSTANT);
    await clock.sleep(1000);
    await clock.sleep(2000);
    expect(clock.sleeps).toEqual([1000, 2000]);
    expect(clock.nowMs()).toBe(Date.parse(INSTANT) + 3000);
  });

  it('jumps forward to an instant but never backwards', () => {
    const clock = new VirtualClock(INSTANT);
    clock.setTo('2026-09-19T21:05:11.417Z');
    expect(clock.nowIso()).toBe('2026-09-19T21:05:11.417Z');
    expect(() => clock.setTo(INSTANT)).toThrow(RangeError);
    expect(() => clock.advanceMs(-1)).toThrow(RangeError);
  });
});
