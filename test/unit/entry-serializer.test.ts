import { describe, expect, it } from 'vitest';
import { decode, encode } from '../../src/core/entry-serializer';
import type { DynamoItem, Entry } from '../../src/core/types';

/**
 * Intent-carrying examples for the Entry_Serializer's own rules (Req 8.2, 8.3, 8.4).
 *
 * Scope note: the general round trip is **Property 5** (task 5.3) and canonicality across all
 * field-equal Entries is **Property 6** (task 5.4). Neither is restated here. What is here is the
 * per-rule evidence a property test cannot localize: that each `EncodeError` and each `DecodeError`
 * variant fires on the attribute the mapping table names, that normalization actually normalizes,
 * that `generationFailed: false` is written as a `BOOL` rather than omitted, and that no error
 * payload carries the offending value.
 */

// U+1F9EA TEST TUBE and U+1D11E MUSICAL SYMBOL G CLEF: astral-plane, two UTF-16 units each.
const TEST_TUBE = '\u{1F9EA}';
const G_CLEF = '\u{1D11E}';

const ENTRY_ID = '01J8ZQ3K9YV2N7A4B6C8D0E1F2';
const SESSION_ID = '01J8ZQ3J5B0000000000000000';

const BASE_ENTRY: Entry = {
  entryId: ENTRY_ID,
  title: 'Wiring the commit log parser into generation',
  body: '## What happened\n\nThe parser landed.',
  sessionDate: '2026-09-19',
  status: 'draft',
  createdAt: '2026-09-19T21:04:11.417Z',
  updatedAt: '2026-09-19T21:04:11.417Z',
  sessionId: SESSION_ID,
  generationFailed: false,
  schemaVersion: 1,
};

/** An Entry with one or more fields replaced, including fields no type would admit. */
function entryWith(overrides: Record<string, unknown>): Entry {
  return { ...BASE_ENTRY, ...overrides };
}

/** The encoded form of `BASE_ENTRY` plus overrides, for driving `decode` from a valid baseline. */
function itemWith(overrides: Record<string, unknown>): DynamoItem {
  const encoded = encode(BASE_ENTRY);
  if (!encoded.ok) {
    throw new Error('the baseline Entry must encode');
  }
  return { ...encoded.item, ...overrides } as DynamoItem;
}

function encodeOrFail(entry: Entry): DynamoItem {
  const result = encode(entry);
  if (!result.ok) {
    throw new Error(`expected an encode, got ${result.error.kind} on ${result.error.attribute}`);
  }
  return result.item;
}

describe('encode', () => {
  it('writes all fourteen attributes with no optional key omitted', () => {
    const item = encodeOrFail(BASE_ENTRY);

    expect(Object.keys(item).sort()).toEqual(
      [
        'GSI1PK',
        'GSI1SK',
        'PK',
        'SK',
        'body',
        'createdAt',
        'entryId',
        'generationFailed',
        'schemaVersion',
        'sessionDate',
        'sessionId',
        'status',
        'title',
        'updatedAt',
      ].sort(),
    );
  });

  it('writes generationFailed as a BOOL even when false', () => {
    // The rule that makes Req 8.7 reachable: an omitted-when-false key would make two field-equal
    // Entries encode differently depending on which code path produced them.
    expect(encodeOrFail(BASE_ENTRY).generationFailed).toEqual({ BOOL: false });
    expect(encodeOrFail(entryWith({ generationFailed: true })).generationFailed).toEqual({
      BOOL: true,
    });
  });

  it('derives PK, SK, GSI1PK, and GSI1SK from the Entry', () => {
    const draft = encodeOrFail(BASE_ENTRY);
    expect(draft.PK).toEqual({ S: `ENTRY#${ENTRY_ID}` });
    expect(draft.SK).toEqual({ S: 'META' });
    expect(draft.GSI1PK).toEqual({ S: 'TL#DRAFT' });
    // <sessionDate>#<createdAt>#<invert(entryId)>, all three components fixed-length. The
    // identifier is the Crockford complement of `01J8ZQ3K9YV2N7A4B6C8D0E1F2`, character for
    // character: `0`→`Z`, `1`→`Y`, `J`(18)→`D`(13), and so on.
    expect(draft.GSI1SK).toEqual({
      S: '2026-09-19#2026-09-19T21:04:11.417Z#ZYDQ08WCP14XARNVMSKQJZHYGX',
    });

    const published = encodeOrFail(entryWith({ status: 'published' }));
    expect(published.GSI1PK).toEqual({ S: 'TL#PUB' });
    expect(published.status).toEqual({ S: 'published' });
  });

  it('writes schemaVersion as the literal number 1 in an N attribute', () => {
    expect(encodeOrFail(BASE_ENTRY).schemaVersion).toEqual({ N: '1' });
  });

  it('accepts a title of exactly 120 code points and a body of exactly 20000', () => {
    // Code points, not UTF-16 units: each astral-plane character is one, so these are at the bound
    // rather than at twice it.
    expect(encode(entryWith({ title: TEST_TUBE.repeat(120) })).ok).toBe(true);
    expect(encode(entryWith({ body: G_CLEF.repeat(20000) })).ok).toBe(true);
  });

  describe('normalization', () => {
    it('reduces a session date carried as an instant to its UTC calendar date', () => {
      const item = encodeOrFail(entryWith({ sessionDate: '2026-09-19T21:04:11.417Z' }));
      expect(item.sessionDate).toEqual({ S: '2026-09-19' });
    });

    it('converts an offset instant to UTC', () => {
      const item = encodeOrFail(entryWith({ createdAt: '2026-09-19T23:04:11.417+02:00' }));
      expect(item.createdAt).toEqual({ S: '2026-09-19T21:04:11.417Z' });
    });

    it('supplies omitted seconds and pads or truncates the fractional part to milliseconds', () => {
      expect(encodeOrFail(entryWith({ createdAt: '2026-09-19T21:04Z' })).createdAt).toEqual({
        S: '2026-09-19T21:04:00.000Z',
      });
      expect(encodeOrFail(entryWith({ createdAt: '2026-09-19T21:04:11.4Z' })).createdAt).toEqual({
        S: '2026-09-19T21:04:11.400Z',
      });
      expect(
        encodeOrFail(entryWith({ createdAt: '2026-09-19T21:04:11.417999Z' })).createdAt,
      ).toEqual({ S: '2026-09-19T21:04:11.417Z' });
    });

    it('is the identity on values already in canonical form', () => {
      const item = encodeOrFail(BASE_ENTRY);
      expect(item.sessionDate).toEqual({ S: BASE_ENTRY.sessionDate });
      expect(item.createdAt).toEqual({ S: BASE_ENTRY.createdAt });
      expect(item.updatedAt).toEqual({ S: BASE_ENTRY.updatedAt });
    });

    it('makes two Entries that differ only in formatting encode identically', () => {
      // The point of normalizing on the way in: the determinism obligation of Req 8.7 holds across
      // code paths that spell the same instant differently.
      const spelledDifferently = entryWith({
        sessionDate: ' 2026-09-19T00:00:00Z ',
        createdAt: '2026-09-19T22:04:11.417+01:00',
        updatedAt: ' 2026-09-19T21:04:11.4170Z',
      });
      expect(encodeOrFail(spelledDifferently)).toEqual(encodeOrFail(BASE_ENTRY));
    });

    it('refuses an instant with no zone designator, which would depend on the host time zone', () => {
      expect(encode(entryWith({ createdAt: '2026-09-19T21:04:11.417' }))).toEqual({
        ok: false,
        error: { kind: 'INVALID_ATTRIBUTE', attribute: 'createdAt' },
      });
    });
  });

  describe('failures', () => {
    it.each([
      ['entryId', 'INVALID_ATTRIBUTE', { entryId: '01J8ZQ3K9YV2N7A4B6C8D0E1FI' }],
      ['entryId', 'INVALID_ATTRIBUTE', { entryId: 'too-short' }],
      ['title', 'OUT_OF_RANGE', { title: '' }],
      ['title', 'OUT_OF_RANGE', { title: TEST_TUBE.repeat(121) }],
      ['body', 'OUT_OF_RANGE', { body: '' }],
      ['body', 'OUT_OF_RANGE', { body: 'x'.repeat(20001) }],
      ['sessionDate', 'INVALID_ATTRIBUTE', { sessionDate: '19-09-2026' }],
      ['sessionDate', 'OUT_OF_RANGE', { sessionDate: '2026-02-30' }],
      ['sessionDate', 'OUT_OF_RANGE', { sessionDate: '2026-13-01' }],
      ['status', 'INVALID_ATTRIBUTE', { status: 'archived' }],
      ['createdAt', 'INVALID_ATTRIBUTE', { createdAt: 'yesterday' }],
      ['createdAt', 'OUT_OF_RANGE', { createdAt: '2026-09-19T25:04:11.417Z' }],
      ['updatedAt', 'OUT_OF_RANGE', { updatedAt: '2026-02-30T21:04:11.417Z' }],
      ['sessionId', 'INVALID_ATTRIBUTE', { sessionId: '' }],
      ['generationFailed', 'INVALID_ATTRIBUTE', { generationFailed: 'false' }],
      ['schemaVersion', 'INVALID_ATTRIBUTE', { schemaVersion: 2 }],
    ])('names %s with %s', (attribute, kind, overrides) => {
      // toEqual on the whole error is the assertion that matters twice over: it pins the kind and
      // the attribute, and it proves the payload carries nothing else — no value, ever (Req 11.3).
      expect(encode(entryWith(overrides))).toEqual({ ok: false, error: { kind, attribute } });
    });

    it('returns an error rather than throwing for input that is not an Entry at all', () => {
      const notEntries = [null, undefined, 'entry', 42, []];
      for (const notAnEntry of notEntries) {
        const result = encode(notAnEntry as unknown as Entry);
        expect(result.ok).toBe(false);
      }
    });
  });
});

describe('decode', () => {
  it('reads back an Entry field for field', () => {
    // One example; Property 5 (task 5.3) generalizes it.
    const unicodeEntry = entryWith({
      title: `${TEST_TUBE} parser ${G_CLEF}`,
      body: `líne\u0301 one\n\n${TEST_TUBE}${G_CLEF}\ttab`,
      status: 'published',
      generationFailed: true,
    });
    const result = decode(encodeOrFail(unicodeEntry));

    expect(result).toEqual({ ok: true, entry: unicodeEntry });
    if (result.ok) {
      // Code point for code point, including above U+FFFF (Req 8.4).
      expect([...result.entry.body]).toEqual([...unicodeEntry.body]);
    }
  });

  it('returns the normalized values for an Entry that needed normalizing', () => {
    const result = decode(encodeOrFail(entryWith({ createdAt: '2026-09-19T23:04:11.417+02:00' })));
    expect(result).toEqual({ ok: true, entry: BASE_ENTRY });
  });

  it.each(['PK', 'SK', 'entryId', 'title', 'body', 'sessionDate', 'status'])(
    'reports MISSING_ATTRIBUTE for an absent %s',
    (attribute) => {
      const item = itemWith({});
      delete item[attribute];
      expect(decode(item)).toEqual({
        ok: false,
        error: { kind: 'MISSING_ATTRIBUTE', attribute },
      });
    },
  );

  it.each([
    ['createdAt', 'updatedAt'],
    ['sessionId', 'generationFailed'],
    ['schemaVersion', 'GSI1PK'],
  ])('reports MISSING_ATTRIBUTE for an absent %s and %s', (first, second) => {
    for (const attribute of [first, second]) {
      const item = itemWith({});
      delete item[attribute];
      expect(decode(item)).toEqual({ ok: false, error: { kind: 'MISSING_ATTRIBUTE', attribute } });
    }
  });

  it.each([
    ['title', { title: { BOOL: true } }],
    ['generationFailed', { generationFailed: { S: 'false' } }],
    ['schemaVersion', { schemaVersion: { S: '1' } }],
    ['schemaVersion', { schemaVersion: { N: 'one' } }],
  ])('reports WRONG_TYPE for %s carried as the wrong attribute type', (attribute, overrides) => {
    expect(decode(itemWith(overrides))).toEqual({
      ok: false,
      error: { kind: 'WRONG_TYPE', attribute },
    });
  });

  it.each([
    ['entryId', { entryId: { S: 'not-a-ulid' } }],
    ['title', { title: { S: '' } }],
    ['title', { title: { S: TEST_TUBE.repeat(121) } }],
    ['body', { body: { S: '' } }],
    ['body', { body: { S: 'x'.repeat(20001) } }],
    ['sessionDate', { sessionDate: { S: '2026-9-19' } }],
    ['sessionDate', { sessionDate: { S: '2026-02-30' } }],
    ['status', { status: { S: 'archived' } }],
    // decode validates the canonical form and does not normalize: a stored non-canonical instant is
    // an anomaly, because encode is the only writer and it always writes 24 characters.
    ['createdAt', { createdAt: { S: '2026-09-19T21:04:11Z' } }],
    ['createdAt', { createdAt: { S: '2026-09-19T21:04:11.417+02:00' } }],
    ['updatedAt', { updatedAt: { S: '2026-09-19T24:00:00.000Z' } }],
    ['sessionId', { sessionId: { S: '01J8ZQ3J5B000000000000000' } }],
  ])('reports OUT_OF_RANGE for an inadmissible %s', (attribute, overrides) => {
    expect(decode(itemWith(overrides))).toEqual({
      ok: false,
      error: { kind: 'OUT_OF_RANGE', attribute },
    });
  });

  it.each([
    ['PK', { PK: { S: 'ENTRY#01J8ZQ3J5B0000000000000000' } }],
    ['SK', { SK: { S: 'STATE' } }],
    ['GSI1PK', { GSI1PK: { S: 'TL#PUB' } }],
  ])(
    'reports OUT_OF_RANGE when the derived %s disagrees with the fields',
    (attribute, overrides) => {
      expect(decode(itemWith(overrides))).toEqual({
        ok: false,
        error: { kind: 'OUT_OF_RANGE', attribute },
      });
    },
  );

  it('reports UNKNOWN_SCHEMA, carrying the version and no attribute value', () => {
    expect(decode(itemWith({ schemaVersion: { N: '2' } }))).toEqual({
      ok: false,
      error: { kind: 'UNKNOWN_SCHEMA', version: 2 },
    });
  });

  it('reports the schema before any field, so a future writer is not misattributed', () => {
    const item = itemWith({ schemaVersion: { N: '7' }, title: { S: '' } });
    expect(decode(item)).toEqual({ ok: false, error: { kind: 'UNKNOWN_SCHEMA', version: 7 } });
  });

  it('ignores GSI1SK, which the mapping table states no validation for', () => {
    expect(decode(itemWith({ GSI1SK: { S: 'nonsense' } })).ok).toBe(true);
    const item = itemWith({});
    delete item.GSI1SK;
    expect(decode(item).ok).toBe(true);
  });

  it('returns an error rather than throwing for items nothing wrote', () => {
    const hostile: DynamoItem[] = [
      {},
      { PK: { S: 'ENTRY#x' } },
      { schemaVersion: { N: '' } },
      ...[null, undefined, 'item', 0].map((value) => value as unknown as DynamoItem),
    ];
    for (const item of hostile) {
      expect(decode(item).ok).toBe(false);
    }
  });

  it('never returns a partially populated Entry', () => {
    // Every failing decode returns no `entry` key at all, so a caller cannot read a half-built one.
    const result = decode(itemWith({ title: { S: '' } }));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('entry');
  });
});
