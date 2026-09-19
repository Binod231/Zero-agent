import { describe, expect, it } from 'vitest';
import { canonicalBytes, encode, encodedSizeBytes } from '../../src/core/entry-serializer';
import type { DynamoItem, Entry } from '../../src/core/types';

/**
 * Intent-carrying examples for `encodedSizeBytes` and `canonicalBytes` (Req 8.7, 8.8).
 *
 * Scope note, so the property tests do not restate any of this:
 *
 * - **Property 6** (task 5.4) owns "for all field-equal Entries, `canonicalBytes(encode(a))` equals
 *   `canonicalBytes(encode(b))`" across the whole `arbEntry` space. What is here instead is the
 *   evidence a property cannot localize: the *mechanism* — that key order is sorted rather than
 *   insertion-dependent, that integer-like attribute names sort by string and not numerically, and
 *   that an astral-plane character reaches the bytes as itself rather than as an escape.
 * - **Property 8** (task 9.4) owns the accept/reject decision at the 393216-byte boundary and the
 *   "store unchanged" half. What is here is the arithmetic that decision rests on: one fully
 *   hand-computed item, and the per-type rules for `S`, `N`, and `BOOL` in isolation.
 * - Totality is asserted here on *out-of-contract* shapes that no generator produces, because both
 *   functions sit behind a JSON boundary where `DynamoItem` is an assertion rather than a proof.
 */

// U+1F9EA TEST TUBE: astral-plane, 1 code point, 2 UTF-16 units, 4 UTF-8 bytes. The three counts
// being different is the whole point of using it.
const TEST_TUBE = '\u{1F9EA}';
// U+00E9 LATIN SMALL LETTER E WITH ACUTE: 2 UTF-8 bytes. U+6F22 CJK IDEOGRAPH: 3 UTF-8 bytes.
const E_ACUTE = '\u00E9';
const HAN = '\u6F22';

const ENTRY_ID = '01J8ZQ3K9YV2N7A4B6C8D0E1F2';
const SESSION_ID = '01J8ZQ3J5B0000000000000000';

/** Short `title` and `body` so the hand computation below stays checkable by eye. */
const BASE_ENTRY: Entry = {
  entryId: ENTRY_ID,
  title: 'Ada',
  body: 'Bee',
  sessionDate: '2026-09-19',
  status: 'draft',
  createdAt: '2026-09-19T21:04:11.417Z',
  updatedAt: '2026-09-19T21:04:11.417Z',
  sessionId: SESSION_ID,
  generationFailed: false,
  schemaVersion: 1,
};

function encodeOrFail(entry: Entry): DynamoItem {
  const result = encode(entry);
  if (!result.ok) {
    throw new Error(`expected an encode, got ${result.error.kind} on ${result.error.attribute}`);
  }
  return result.item;
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** A value shaped like nothing in `DynamoAttributeValue`, forced past the type to reach a fallback. */
function asAttribute(value: unknown): DynamoItem[string] {
  return value as DynamoItem[string];
}

describe('encodedSizeBytes: the DynamoDB accounting rule', () => {
  it('sums UTF-8 attribute-name bytes and attribute-value bytes', () => {
    // name 'a' 1 + 'hi' 2 = 3; name 'bb' 2 + N '1' (1 significant digit → 1 + 1) 2 = 4;
    // name 'ccc' 3 + BOOL 1 = 4.
    const item: DynamoItem = {
      a: { S: 'hi' },
      bb: { N: '1' },
      ccc: { BOOL: true },
    };

    expect(encodedSizeBytes(item)).toBe(3 + 4 + 4);
  });

  it('charges an Entry item exactly the hand-computed 335 bytes', () => {
    // Attribute by attribute, name bytes + value bytes:
    //   PK               2  + 32 ('ENTRY#' 6 + 26-char ULID)  = 34
    //   SK               2  +  4 ('META')                     =  6
    //   GSI1PK           6  +  8 ('TL#DRAFT')                 = 14
    //   GSI1SK           6  + 62 (10 + 1 + 24 + 1 + 26)       = 68
    //   entryId          7  + 26                              = 33
    //   title            5  +  3 ('Ada')                      =  8
    //   body             4  +  3 ('Bee')                      =  7
    //   sessionDate     11  + 10                              = 21
    //   status           6  +  5 ('draft')                    = 11
    //   createdAt        9  + 24                              = 33
    //   updatedAt        9  + 24                              = 33
    //   sessionId        9  + 26                              = 35
    //   generationFailed 16 +  1 (BOOL is 1 byte)             = 17
    //   schemaVersion   13  +  2 (N '1')                      = 15
    const expected = 34 + 6 + 14 + 68 + 33 + 8 + 7 + 21 + 11 + 33 + 33 + 35 + 17 + 15;
    expect(expected).toBe(335);

    expect(encodedSizeBytes(encodeOrFail(BASE_ENTRY))).toBe(335);
  });

  it('counts a string value in UTF-8 bytes, not UTF-16 units and not code points', () => {
    // 'Ada' is 3 bytes. An astral-plane title of one code point is 4 bytes, so the item grows by 1.
    // Were the count `String#length` it would shrink by 1; were it code points, by 2.
    expect(encodedSizeBytes(encodeOrFail({ ...BASE_ENTRY, title: TEST_TUBE }))).toBe(336);
    expect(encodedSizeBytes(encodeOrFail({ ...BASE_ENTRY, title: E_ACUTE }))).toBe(334);
    expect(encodedSizeBytes(encodeOrFail({ ...BASE_ENTRY, title: HAN }))).toBe(335);
  });

  it('counts multi-byte attribute names in UTF-8 bytes too', () => {
    expect(encodedSizeBytes({ [E_ACUTE]: { S: TEST_TUBE } })).toBe(2 + 4);
    expect(encodedSizeBytes({ [TEST_TUBE]: { S: '' } })).toBe(4);
  });

  it('sizes an N value as ceil(significant digits / 2) + 1, with zeroes trimmed', () => {
    const sizeOf = (numeric: string): number => encodedSizeBytes({ n: { N: numeric } }) - 1;

    expect(sizeOf('1')).toBe(2); // 1 digit
    expect(sizeOf('0')).toBe(2); // zero still occupies a digit
    expect(sizeOf('-1')).toBe(2); // the sign is not a digit
    expect(sizeOf('100')).toBe(2); // trailing zeroes trimmed: 1 digit
    expect(sizeOf('1E2')).toBe(2); // the exponent carries no digits
    expect(sizeOf('1.5')).toBe(2); // 2 digits, the point is not one
    expect(sizeOf('0.00012')).toBe(2); // leading zeroes trimmed: 2 digits
    expect(sizeOf('1234')).toBe(3); // 4 digits
    expect(sizeOf('12345')).toBe(4); // 5 digits, rounded up
  });

  it('sizes a BOOL value as 1 byte whichever way it reads', () => {
    expect(encodedSizeBytes({ generationFailed: { BOOL: false } })).toBe(16 + 1);
    expect(encodedSizeBytes({ generationFailed: { BOOL: true } })).toBe(16 + 1);
  });

  it('charges nothing for an item with no attributes', () => {
    expect(encodedSizeBytes({})).toBe(0);
  });

  it('never throws and never returns NaN on out-of-contract input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const odd: DynamoItem = {
      nullValue: asAttribute(null),
      numberValue: asAttribute(7),
      stringValue: asAttribute('not an attribute map'),
      listValue: asAttribute([1, 2, 3]),
      wrongInnerType: asAttribute({ S: 42 }),
      cyclicValue: asAttribute(cyclic),
      missingValue: asAttribute(undefined),
    };

    const size = encodedSizeBytes(odd);
    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBeGreaterThan(0);

    expect(encodedSizeBytes(null as unknown as DynamoItem)).toBe(0);
    expect(encodedSizeBytes('nope' as unknown as DynamoItem)).toBe(0);
  });
});

describe('canonicalBytes: the canonical encoding', () => {
  it('emits UTF-8 JSON with attribute names in ascending order', () => {
    const item: DynamoItem = {
      zeta: { S: 'z' },
      alpha: { S: 'a' },
      Mid: { BOOL: true },
    };

    // Uppercase sorts before lowercase, which is UTF-16 code-unit order, not alphabetic order.
    expect(textOf(canonicalBytes(item))).toBe(
      '{"Mid":{"BOOL":true},"alpha":{"S":"a"},"zeta":{"S":"z"}}',
    );
  });

  it('is independent of the order the attributes were assigned in', () => {
    const forwards: DynamoItem = {};
    forwards.alpha = { S: 'a' };
    forwards.beta = { N: '2' };
    forwards.gamma = { BOOL: false };

    const backwards: DynamoItem = {};
    backwards.gamma = { BOOL: false };
    backwards.beta = { N: '2' };
    backwards.alpha = { S: 'a' };

    expect(Object.keys(forwards)).not.toEqual(Object.keys(backwards));
    expect(canonicalBytes(forwards)).toEqual(canonicalBytes(backwards));
  });

  it('sorts integer-like attribute names by string, not by numeric value', () => {
    // The reason the serializer is hand-written: JavaScript's own property order puts array-index-like
    // keys first and numerically ascending, so `Object.keys` here is ['9', '10'] however they were
    // inserted. Canonical order is '10' before '9'.
    const item: DynamoItem = { '9': { S: 'nine' }, '10': { S: 'ten' } };

    expect(Object.keys(item)).toEqual(['9', '10']);
    expect(textOf(canonicalBytes(item))).toBe('{"10":{"S":"ten"},"9":{"S":"nine"}}');
  });

  it('gives two Entries of equal content identical bytes when built along different paths', () => {
    // Same instant spelled with an offset, and a session date carried as a full timestamp. Encode
    // normalizes both, so the canonical bytes cannot tell the two construction paths apart.
    const canonicalPath = encodeOrFail(BASE_ENTRY);
    const denormalizedPath = encodeOrFail({
      ...BASE_ENTRY,
      sessionDate: '2026-09-19T00:00:00.000Z',
      createdAt: '2026-09-20T02:34:11.417+05:30',
      updatedAt: '  2026-09-19T21:04:11.417Z  ',
    });

    expect(canonicalBytes(denormalizedPath)).toEqual(canonicalBytes(canonicalPath));
  });

  it('is stable across repeated invocations and returns a fresh array each time', () => {
    const item = encodeOrFail(BASE_ENTRY);
    const first = canonicalBytes(item);
    const second = canonicalBytes(item);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('carries an astral-plane character through as its own four UTF-8 bytes', () => {
    const bytes = canonicalBytes({ t: { S: TEST_TUBE } });

    // '{"t":{"S":"' is 11 bytes, the character is 4, '"}}' is 3.
    expect(bytes.length).toBe(11 + 4 + 3);
    expect(textOf(bytes)).toBe(`{"t":{"S":"${TEST_TUBE}"}}`);
    // Not escaped, and no surrogate or replacement character survives in the text.
    expect(textOf(bytes)).not.toContain('\\u');
    expect(textOf(bytes)).not.toContain('\uFFFD');
  });

  it('escapes quotes, backslashes, and control characters exactly as JSON requires', () => {
    // The value holds five characters: a quote, a backslash, a newline, a tab, and U+0001.
    // `String.raw` lets the expectation be written as the JSON text itself.
    expect(textOf(canonicalBytes({ t: { S: '"\\\n\t\u0001' } }))).toBe(
      String.raw`{"t":{"S":"\"\\\n\t\u0001"}}`,
    );
  });

  it('agrees with encodedSizeBytes on how wide a string is', () => {
    // Both count UTF-8, so the astral title costs 1 byte more than 'Ada' in each measure.
    const plain = encodeOrFail(BASE_ENTRY);
    const astral = encodeOrFail({ ...BASE_ENTRY, title: TEST_TUBE });

    expect(canonicalBytes(astral).length - canonicalBytes(plain).length).toBe(1);
    expect(encodedSizeBytes(astral) - encodedSizeBytes(plain)).toBe(1);
  });

  it('never throws on out-of-contract input, including a cycle', () => {
    const cyclic: Record<string, unknown> = { tag: 'outer' };
    cyclic.self = cyclic;

    const item: DynamoItem = {
      nullValue: asAttribute(null),
      listValue: asAttribute(['a', 1, true, null]),
      nestedValue: asAttribute({ zz: 1, aa: { bb: 2, ab: 3 } }),
      bigintValue: asAttribute(10n),
      nonFinite: asAttribute(Number.NaN),
      missingValue: asAttribute(undefined),
      cyclicValue: asAttribute(cyclic),
    };

    const text = textOf(canonicalBytes(item));

    // Sorted at every level: 'aa' before 'zz', and inside 'aa', 'ab' before 'bb'.
    expect(text).toContain('"nestedValue":{"aa":{"ab":3,"bb":2},"zz":1}');
    // Array order is data and is preserved.
    expect(text).toContain('"listValue":["a",1,true,null]');
    // A cycle closes as null rather than recursing forever.
    expect(text).toContain('"cyclicValue":{"self":null,"tag":"outer"}');
    // No JSON form: each becomes null, and a bigint becomes its decimal string.
    expect(text).toContain('"nullValue":null');
    expect(text).toContain('"nonFinite":null');
    expect(text).toContain('"missingValue":null');
    expect(text).toContain('"bigintValue":"10"');

    expect(() => canonicalBytes(null as unknown as DynamoItem)).not.toThrow();
    expect(textOf(canonicalBytes(null as unknown as DynamoItem))).toBe('null');
  });

  it('distinguishes items whose attribute name sets differ', () => {
    // Canonicality must not collapse two different items onto the same bytes.
    const withBoth: DynamoItem = { a: { S: '' }, b: { S: '' } };
    const withOne: DynamoItem = { a: { S: '' } };

    expect(canonicalBytes(withBoth)).not.toEqual(canonicalBytes(withOne));
  });
});
