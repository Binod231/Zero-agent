import { describe, expect, it } from 'vitest';
import {
  ENTRY_ID_WIDTH,
  INSTANT_WIDTH,
  ORDERING_KEY_WIDTH,
  SESSION_DATE_WIDTH,
  buildOrderingKey,
  compareEntries,
  invert,
} from '../../src/core/entry-ordering';
import type { Entry, EntrySummary } from '../../src/core/types';

/**
 * Intent-carrying examples for Entry_Ordering's own rules (Req 6.6, 7.1, 7.2).
 *
 * Scope note: the agreement between the key-derived order and the comparator across arbitrary Entry
 * sets is **Property 9** (task 6.2), and it is deliberately not restated here. What is here is the
 * per-rule evidence a property test cannot localize:
 *
 * - `invert` is an involution on the alphabet and a bijection onto it, so nothing collides;
 * - the biconditional `a < b ⟺ invert(a) > invert(b)` on concrete 26-character pairs, including the
 *   pair that isolates each of the three key levels;
 * - the key's exact layout and widths, so a `#` can never be content and no key is a prefix of
 *   another;
 * - each of the comparator's three levels firing, in the right direction, with the third level's
 *   direction opposite to the first two.
 */

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The example from the design's *Entry item shape*, reused by the Entry_Serializer's unit tests. */
const ENTRY_ID = '01J8ZQ3K9YV2N7A4B6C8D0E1F2';
const INVERTED_ENTRY_ID = 'ZYDQ08WCP14XARNVMSKQJZHYGX';

const BASE_SUMMARY: EntrySummary = {
  entryId: ENTRY_ID,
  title: 'Wiring the commit log parser into generation',
  sessionDate: '2026-09-19',
  createdAt: '2026-09-19T21:04:11.417Z',
  updatedAt: '2026-09-19T21:04:11.417Z',
  generationFailed: false,
};

function summaryWith(overrides: Partial<EntrySummary>): EntrySummary {
  return { ...BASE_SUMMARY, ...overrides };
}

/** A 26-character identifier: `seed` right-padded with `0` to the ULID width. */
function entryIdFrom(seed: string): string {
  return seed.padEnd(ENTRY_ID_WIDTH, '0');
}

/** A 26-character identifier ending in `last`, so two such differ only at the final position. */
function entryIdEndingIn(last: string): string {
  return '0'.repeat(ENTRY_ID_WIDTH - 1) + last;
}

/** True when `left` sorts before `right` in a descending lexicographic index scan. */
function scansBefore(left: string, right: string): boolean {
  return left > right;
}

describe('invert', () => {
  it('maps the Crockford alphabet onto itself in reverse', () => {
    expect(invert(CROCKFORD_ALPHABET)).toBe([...CROCKFORD_ALPHABET].reverse().join(''));
    // The three pairs the serializer's own test names, spelled out.
    expect(invert('0')).toBe('Z');
    expect(invert('1')).toBe('Y');
    expect(invert('J')).toBe('D');
  });

  it('is an involution on the alphabet, so it is a bijection and collides nothing', () => {
    expect(invert(invert(CROCKFORD_ALPHABET))).toBe(CROCKFORD_ALPHABET);

    // Onto: every alphabet character is the image of exactly one other.
    const images = new Set([...invert(CROCKFORD_ALPHABET)]);
    expect(images.size).toBe(CROCKFORD_ALPHABET.length);
    expect([...images].sort().join('')).toBe(CROCKFORD_ALPHABET);
  });

  it('preserves length, which is what keeps the decision position unchanged', () => {
    expect(invert(ENTRY_ID)).toHaveLength(ENTRY_ID_WIDTH);
    expect(invert('')).toBe('');
  });

  it('produces the design example, character for character', () => {
    expect(invert(ENTRY_ID)).toBe(INVERTED_ENTRY_ID);
  });

  it('reverses the order of equal-length identifiers: a < b iff invert(a) > invert(b)', () => {
    const pairs: readonly (readonly [string, string])[] = [
      // Differ at the first position.
      [entryIdFrom('0'), entryIdFrom('1')],
      // Differ at the last position only, so the whole 25-character prefix is identical.
      [entryIdEndingIn('0'), entryIdEndingIn('Z')],
      // Differ at a letter, across the digit/letter boundary of the alphabet.
      [entryIdFrom('01J8Z9'), entryIdFrom('01J8ZA')],
      // Extremes of the alphabet.
      [entryIdFrom(''), 'Z'.repeat(ENTRY_ID_WIDTH)],
      // A realistic pair of monotonic ULIDs.
      ['01J8ZQ3K9YV2N7A4B6C8D0E1F2', '01J8ZQ3K9YV2N7A4B6C8D0E1F3'],
    ];

    for (const [smaller, larger] of pairs) {
      expect(smaller.length).toBe(ENTRY_ID_WIDTH);
      expect(larger.length).toBe(ENTRY_ID_WIDTH);
      expect(smaller < larger).toBe(true);
      // The biconditional, in the direction that matters for the descending scan.
      expect(invert(smaller) > invert(larger)).toBe(true);
      // And back, so the implication is not vacuous in one direction only.
      expect(invert(invert(smaller)) < invert(invert(larger))).toBe(true);
    }
  });

  it('is total: a character outside the alphabet passes through rather than throwing', () => {
    // `I`, `L`, `O`, `U` are deliberately absent from Crockford base32.
    expect(invert('ILOU')).toBe('ILOU');
    // Iteration is by code point, so an astral-plane character is not split into surrogates.
    expect(invert('\u{1F9EA}')).toBe('\u{1F9EA}');
    expect(invert('0\u{1F9EA}1')).toBe('Z\u{1F9EA}Y');
  });
});

describe('buildOrderingKey', () => {
  it('lays the key out as sessionDate#createdAt#invert(entryId)', () => {
    expect(buildOrderingKey(BASE_SUMMARY)).toBe(
      `2026-09-19#2026-09-19T21:04:11.417Z#${INVERTED_ENTRY_ID}`,
    );
  });

  it('holds the three fixed widths and exactly two separators', () => {
    const key = buildOrderingKey(BASE_SUMMARY);
    expect(key).toHaveLength(ORDERING_KEY_WIDTH);

    const components = key.split('#');
    expect(components).toHaveLength(3);
    expect(components[0]).toHaveLength(SESSION_DATE_WIDTH);
    expect(components[1]).toHaveLength(INSTANT_WIDTH);
    expect(components[2]).toHaveLength(ENTRY_ID_WIDTH);
    // Fixed widths are what make a prefix relationship between two keys impossible.
    expect(ORDERING_KEY_WIDTH).toBe(62);
  });

  it('reads only the three ordering fields, never title, updatedAt, or generationFailed', () => {
    const key = buildOrderingKey(BASE_SUMMARY);
    expect(
      buildOrderingKey(
        summaryWith({ title: 'a different title', updatedAt: '2030-01-01T00:00:00.000Z' }),
      ),
    ).toBe(key);
    expect(buildOrderingKey(summaryWith({ generationFailed: true }))).toBe(key);
  });

  it('orders descending keys the way each of the three levels requires', () => {
    // Level 1: later session date sorts first, so its key must be the larger string.
    expect(
      scansBefore(
        buildOrderingKey(summaryWith({ sessionDate: '2026-09-20' })),
        buildOrderingKey(summaryWith({ sessionDate: '2026-09-19' })),
      ),
    ).toBe(true);
    // Level 2: same session date, later creation instant sorts first.
    expect(
      scansBefore(
        buildOrderingKey(summaryWith({ createdAt: '2026-09-19T22:00:00.000Z' })),
        buildOrderingKey(summaryWith({ createdAt: '2026-09-19T21:00:00.000Z' })),
      ),
    ).toBe(true);
    // Level 3, the inverted one: same date and instant, the *smaller* identifier sorts first, so
    // the smaller identifier must carry the LARGER key. This is the whole point of `invert`.
    expect(
      scansBefore(
        buildOrderingKey(summaryWith({ entryId: entryIdFrom('0') })),
        buildOrderingKey(summaryWith({ entryId: entryIdFrom('1') })),
      ),
    ).toBe(true);
  });

  it('gives a descending scan the Req 7.2 order, agreeing with compareEntries', () => {
    const shared = { createdAt: '2026-09-19T21:04:11.417Z' };
    const entries = [
      summaryWith({ ...shared, sessionDate: '2026-09-18', entryId: entryIdFrom('A') }),
      summaryWith({ ...shared, sessionDate: '2026-09-19', entryId: entryIdFrom('B') }),
      summaryWith({ ...shared, sessionDate: '2026-09-19', entryId: entryIdFrom('A') }),
      summaryWith({
        sessionDate: '2026-09-19',
        createdAt: '2026-09-19T23:00:00.000Z',
        entryId: entryIdFrom('Z'),
      }),
    ];

    // A single descending index scan over GSI1SK.
    const scanned = [...entries]
      .sort((left, right) => {
        const a = buildOrderingKey(left);
        const b = buildOrderingKey(right);
        return a === b ? 0 : a < b ? 1 : -1;
      })
      .map((entry) => entry.entryId);

    expect(scanned).toEqual([
      // 2026-09-19 first, most recent instant first within it,
      entryIdFrom('Z'),
      // then the two sharing date and instant, by *ascending* identifier,
      entryIdFrom('A'),
      entryIdFrom('B'),
      // then the earlier session date.
      entryIdFrom('A'),
    ]);

    expect([...entries].sort(compareEntries).map((entry) => entry.entryId)).toEqual(scanned);
  });
});

describe('compareEntries', () => {
  it('orders by session date descending first', () => {
    const later = summaryWith({ sessionDate: '2026-09-20' });
    const earlier = summaryWith({ sessionDate: '2026-09-19' });
    expect(compareEntries(later, earlier)).toBe(-1);
    expect(compareEntries(earlier, later)).toBe(1);
  });

  it('breaks a shared session date by creation timestamp descending', () => {
    const later = summaryWith({ createdAt: '2026-09-19T22:00:00.000Z' });
    const earlier = summaryWith({ createdAt: '2026-09-19T21:00:00.000Z' });
    expect(compareEntries(later, earlier)).toBe(-1);
    expect(compareEntries(earlier, later)).toBe(1);
  });

  it('breaks a shared date and timestamp by entry identifier ASCENDING, the opposite direction', () => {
    const smaller = summaryWith({ entryId: entryIdFrom('0') });
    const larger = summaryWith({ entryId: entryIdFrom('1') });
    // Note the sign against the two tests above: the smaller identifier sorts first.
    expect(compareEntries(smaller, larger)).toBe(-1);
    expect(compareEntries(larger, smaller)).toBe(1);
  });

  it('lets an earlier level win over a later one', () => {
    // A later session date beats a later creation instant.
    expect(
      compareEntries(
        summaryWith({ sessionDate: '2026-09-20', createdAt: '2026-01-01T00:00:00.000Z' }),
        summaryWith({ sessionDate: '2026-09-19', createdAt: '2026-12-31T00:00:00.000Z' }),
      ),
    ).toBe(-1);
    // A later creation instant beats a smaller identifier.
    expect(
      compareEntries(
        summaryWith({ createdAt: '2026-09-19T22:00:00.000Z', entryId: entryIdFrom('Z') }),
        summaryWith({ createdAt: '2026-09-19T21:00:00.000Z', entryId: entryIdFrom('0') }),
      ),
    ).toBe(-1);
  });

  it('returns 0 only when all three ordering fields are equal', () => {
    expect(compareEntries(BASE_SUMMARY, BASE_SUMMARY)).toBe(0);
    // Fields outside the order do not make two Entries distinct for ordering purposes; identifiers
    // are unique across the Entry_Store, so in practice this is always the same Entry.
    expect(compareEntries(BASE_SUMMARY, summaryWith({ title: 'other' }))).toBe(0);
    expect(compareEntries(BASE_SUMMARY, summaryWith({ entryId: entryIdFrom('7') }))).not.toBe(0);
  });

  it('accepts a full Entry without a cast, which is how the serializer reaches it', () => {
    // `Entry` carries every `EntrySummary` field, so neither call site needs a cast and
    // `buildOrderingKey` satisfies the serializer's `OrderingKeyBuilder` as-is.
    const entry: Entry = {
      ...BASE_SUMMARY,
      body: 'a body',
      status: 'draft',
      sessionId: '01J8ZQ3J5B0000000000000000',
      schemaVersion: 1,
    };
    expect(compareEntries(entry, BASE_SUMMARY)).toBe(0);
    expect(buildOrderingKey(entry)).toBe(buildOrderingKey(BASE_SUMMARY));
  });
});
