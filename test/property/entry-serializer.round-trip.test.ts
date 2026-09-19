import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decode, encode } from '../../src/core/entry-serializer';
import type { Entry } from '../../src/core/types';
import { arbEntry } from '../generators';

/**
 * **Property 5** of the design's *Correctness Properties*, and the only test that implements it.
 *
 * Req 8.2 (encoding is total over in-bounds Entries), Req 8.3 (what was written reads back field for
 * field, text code point for code point and timestamps as the same instant in UTC), and Req 8.4 (no
 * substituted, dropped, escaped, or replacement character, including above U+FFFF) are the three
 * criteria under test. The unit suites next door cover the other direction: every `EncodeError` and
 * `DecodeError` variant (`test/unit/entry-serializer.test.ts`) and the size and canonical-byte
 * accounting (`test/unit/entry-serializer.sizing.test.ts`). Nothing is duplicated here.
 *
 * **Why timestamps are compared as instants and not as strings.** `encode` normalizes on the way in
 * (design, *Entry_Serializer*, rule 2: "one canonical form per value"), so an Entry carrying
 * `2026-09-19T18:04:11+05:30` encodes as `2026-09-19T12:34:11.000Z` and `decode` returns that
 * canonical spelling. The two strings differ; the instant does not. Property 5 says "timestamp
 * fields as the same instant in UTC" precisely because of this, so the timestamp clause is asserted
 * with {@link isSameInstantInUtc} — `Date.parse` of both sides, both finite and equal — rather than
 * by string equality, and separately with the claim that the value coming back is in the canonical
 * 24-character UTC form. Two of the explicit examples below carry offset spellings so that the
 * "same instant, different string" case is exercised on every run rather than left to a generator
 * that would never produce it: `arbEntry` derives both timestamps from `Date#toISOString`, so every
 * *generated* Entry already carries the canonical form and string equality holds there. The property
 * asserts the stronger string-level claim for exactly those Entries, tracked by
 * `canonicalTimestampEntries`.
 *
 * **Why text equality is stated in code-point units.** `expect(a).toEqual(b)` on two strings would
 * pass or fail identically, but the failure report would print two visually indistinguishable
 * strings. Comparing `[...text]` arrays makes a Unicode normalization, a dropped combining mark, or
 * a surrogate half replaced by U+FFFD show up as a diff at a named index, which is what Req 8.4 is
 * about. `sessionDate` is compared the same way: it is a text field, and `arbEntry` supplies it in
 * the canonical 10-character form that normalization leaves untouched.
 *
 * **Non-vacuity is asserted, not assumed.** The counters below record how much of the Unicode input
 * space actually reached the assertions — astral-plane code points in the title and in the body,
 * combining marks, and the 1/120 and 1/20000 code-point boundaries — and fail the test if any class
 * went unseen. The explicit examples alone satisfy every count, so these are guarantees rather than
 * statistical hopes; `fast-check`'s own draws add to them.
 *
 * Nothing here calls AWS, reads the clock, or touches the filesystem.
 */

// ---------------------------------------------------------------------------------------------
// Comparison primitives
// ---------------------------------------------------------------------------------------------

/** The canonical instant `encode` normalizes to and `decode` accepts: 24 characters, UTC. */
const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Any code point carrying the Unicode `Mark` general category: combining marks and friends. */
const COMBINING_MARK_PATTERN = /\p{M}/u;

/** Code points, not UTF-16 units, so a failure report names the code point that changed. */
function codePoints(text: string): string[] {
  return [...text];
}

/** True when any code point of `text` sits above U+FFFF, so it is a surrogate pair in UTF-16. */
function carriesAstralCodePoint(text: string): boolean {
  return codePoints(text).some((codePoint) => (codePoint.codePointAt(0) ?? 0) > 0xffff);
}

function carriesCombiningMark(text: string): boolean {
  return COMBINING_MARK_PATTERN.test(text);
}

/**
 * True when two instant spellings name the same moment. `Date.parse` is normative for both the
 * canonical form and the offset forms `encode` accepts, and a non-finite result means the text was
 * not an instant at all, which fails rather than comparing equal to another failure.
 */
function isSameInstantInUtc(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

/**
 * Every field except the two timestamps — the part of an Entry that normalization leaves alone for
 * the inputs this property quantifies over, and so the part a single deep comparison can state.
 */
function normalizationInvariantFields(entry: Entry): Omit<Entry, 'createdAt' | 'updatedAt'> {
  return {
    entryId: entry.entryId,
    title: entry.title,
    body: entry.body,
    sessionDate: entry.sessionDate,
    status: entry.status,
    sessionId: entry.sessionId,
    generationFailed: entry.generationFailed,
    schemaVersion: entry.schemaVersion,
  };
}

// ---------------------------------------------------------------------------------------------
// Explicit examples: the Unicode classes and the code-point boundaries, on every run
// ---------------------------------------------------------------------------------------------

const BASE_ENTRY: Entry = {
  entryId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  title: 'baseline title',
  body: 'baseline body',
  sessionDate: '2026-09-19',
  status: 'draft',
  createdAt: '2026-09-19T12:34:11.000Z',
  updatedAt: '2026-09-19T12:34:11.000Z',
  sessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  generationFailed: false,
  schemaVersion: 1,
};

/** 120 code points: 40 astral characters, 40 letters each carrying a combining mark. */
const TITLE_AT_MAX = `${'\u{1F680}'.repeat(40)}${'e\u0301'.repeat(40)}`;

/** 20000 code points: 19999 astral characters plus one ASCII character. */
const BODY_AT_MAX = `${'\u{1D11E}'.repeat(19_999)}x`;

const EXAMPLES: [Entry][] = [
  // Both lower bounds: a title of exactly 1 code point and a body of exactly 1, both above U+FFFF,
  // so the minimum-length case and the surrogate-pair case coincide.
  [{ ...BASE_ENTRY, title: '\u{1F600}', body: '\u{20BB7}' }],
  // Both upper bounds, measured in code points. `String#length` would see 160 and 39999 here, so an
  // implementation counting UTF-16 units rejects this Entry instead of encoding it.
  [{ ...BASE_ENTRY, title: TITLE_AT_MAX, body: BODY_AT_MAX, status: 'published' }],
  // Combining marks, a variation selector, a keycap sequence, a ZWJ emoji sequence, and a regional
  // indicator pair: code point sequences that any normalization or grapheme-based handling would
  // visibly rearrange.
  [
    {
      ...BASE_ENTRY,
      title: 'a\u0301e\u0308o\u0327 \u0023\uFE0F\u20E3 \u{1F1E6}\u{1F1FF}',
      body: '\u{1F9D1}\u200D\u{1F680} \u0915\u093C\u0E48 \u0591\u064B fin',
    },
  ],
  // An unpaired high surrogate and an unpaired low surrogate. Req 8.4 forbids a substituted or
  // replacement character on read-back, so a UTF-8 round trip through the storage layer must not
  // quietly turn either of these into U+FFFD.
  [{ ...BASE_ENTRY, title: 'lone high \uD800 end', body: 'lone low \uDC00 end' }],
  // A positive and a negative offset spelling. Encoding normalizes both to UTC, so the strings
  // coming back differ from the strings going in while naming the same instant — the case the
  // timestamp clause of Property 5 is worded for.
  [
    {
      ...BASE_ENTRY,
      title: 'offset instants \u{1F551}',
      body: 'created in India, updated in California',
      createdAt: '2026-09-19T18:04:11+05:30',
      updatedAt: '2026-09-19T05:34:11-08:00',
    },
  ],
  // Seconds omitted and a sub-millisecond fraction: two more spellings of one instant, both of which
  // must reduce to the same 24-character canonical form.
  [
    {
      ...BASE_ENTRY,
      title: 'coarse and fine instants',
      body: 'minute precision in, millisecond precision out',
      createdAt: '2026-01-01T00:00Z',
      updatedAt: '2026-01-01T00:00:00.500Z',
    },
  ],
  // The canonical form itself at both ends of the day, so normalization is shown to be the identity
  // on input that is already canonical.
  [
    {
      ...BASE_ENTRY,
      title: 'already canonical',
      body: 'midnight to the last millisecond',
      sessionDate: '2028-02-29',
      createdAt: '2028-02-29T00:00:00.000Z',
      updatedAt: '2028-02-29T23:59:59.999Z',
      generationFailed: true,
    },
  ],
];

// ---------------------------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------------------------

describe('Entry_Serializer encode and decode round trip', () => {
  it('encodes every in-bounds Entry and reads it back field for field, code point for code point', () => {
    // Non-vacuity and coverage accounting, asserted after `fc.assert` returns.
    const encodeFailures: string[] = [];
    const decodeFailures: string[] = [];
    let runs = 0;
    let astralTitles = 0;
    let astralBodies = 0;
    let combiningMarkTitles = 0;
    let combiningMarkBodies = 0;
    let titlesAtMinLength = 0;
    let titlesAtMaxLength = 0;
    let bodiesAtMinLength = 0;
    let bodiesAtMaxLength = 0;
    let canonicalTimestampEntries = 0;
    let normalizedTimestampEntries = 0;

    // Feature: devlog-narrator, Property 5: For all Entries whose title is 1 to 120 code points,
    // whose body is 1 to 20000 code points, and whose session date, status, creation timestamp, and
    // last-modified timestamp are present, the Entry_Serializer encodes without error, and decoding
    // that encoded representation yields an Entry whose every field equals the original — text
    // fields code point for code point including code points above U+FFFF, and timestamp fields as
    // the same instant in UTC.
    fc.assert(
      fc.property(arbEntry, (entry) => {
        runs += 1;

        const titleCodePoints = codePoints(entry.title);
        const bodyCodePoints = codePoints(entry.body);

        // The precondition of Property 5, restated on the drawn value rather than trusted: the title
        // is 1 to 120 code points, the body is 1 to 20000, and the other four fields are present. A
        // generator change that drifted outside these bounds would make the totality clause below
        // assert something Req 8.2 does not claim, so it fails here instead.
        expect(titleCodePoints.length).toBeGreaterThanOrEqual(1);
        expect(titleCodePoints.length).toBeLessThanOrEqual(120);
        expect(bodyCodePoints.length).toBeGreaterThanOrEqual(1);
        expect(bodyCodePoints.length).toBeLessThanOrEqual(20_000);
        expect(entry.sessionDate).not.toBe('');
        expect(entry.status).not.toBe(undefined);
        expect(entry.createdAt).not.toBe('');
        expect(entry.updatedAt).not.toBe('');

        if (carriesAstralCodePoint(entry.title)) {
          astralTitles += 1;
        }
        if (carriesAstralCodePoint(entry.body)) {
          astralBodies += 1;
        }
        if (carriesCombiningMark(entry.title)) {
          combiningMarkTitles += 1;
        }
        if (carriesCombiningMark(entry.body)) {
          combiningMarkBodies += 1;
        }
        if (titleCodePoints.length === 1) {
          titlesAtMinLength += 1;
        }
        if (titleCodePoints.length === 120) {
          titlesAtMaxLength += 1;
        }
        if (bodyCodePoints.length === 1) {
          bodiesAtMinLength += 1;
        }
        if (bodyCodePoints.length === 20_000) {
          bodiesAtMaxLength += 1;
        }

        // Req 8.2, totality: encoding an in-bounds Entry produces an item, never an error.
        const encoded = encode(entry);
        if (!encoded.ok) {
          encodeFailures.push(`${encoded.error.kind}:${encoded.error.attribute}`);
        }
        expect(encoded.ok).toBe(true);
        if (!encoded.ok) {
          throw new Error(
            `encode rejected an in-bounds Entry: ${encoded.error.kind} on ${encoded.error.attribute}`,
          );
        }

        // Req 8.3: decoding that encoded representation succeeds. The `ok` branch, not merely a call
        // that did not throw.
        const decoded = decode(encoded.item);
        if (!decoded.ok) {
          decodeFailures.push(
            decoded.error.kind === 'UNKNOWN_SCHEMA'
              ? `UNKNOWN_SCHEMA:${String(decoded.error.version)}`
              : `${decoded.error.kind}:${decoded.error.attribute}`,
          );
        }
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) {
          throw new Error(`decode rejected an encoded Entry: ${decoded.error.kind}`);
        }
        const readBack = decoded.entry;

        // Every field except the two timestamps equals the original. One structural comparison, so a
        // mismatch is localized to a named field; the code-point comparisons below then state the
        // text clause in the units Req 8.4 uses.
        expect(normalizationInvariantFields(readBack)).toEqual(normalizationInvariantFields(entry));

        // Req 8.3 and 8.4, text fields: equal code point for code point, including above U+FFFF.
        // Comparing arrays of code points rather than strings means a normalization, a dropped
        // combining mark, or a surrogate half replaced by U+FFFD appears as a diff at an index.
        expect(codePoints(readBack.title)).toEqual(titleCodePoints);
        expect(codePoints(readBack.body)).toEqual(bodyCodePoints);
        expect(codePoints(readBack.sessionDate)).toEqual(codePoints(entry.sessionDate));

        // No substituted or replacement character: U+FFFD only ever appears on read-back if the
        // original carried it.
        expect(readBack.title.includes('\uFFFD')).toBe(entry.title.includes('\uFFFD'));
        expect(readBack.body.includes('\uFFFD')).toBe(entry.body.includes('\uFFFD'));

        // Nothing is escaped on the way through: the read-back length in UTF-16 units matches too, so
        // a surrogate pair did not become six characters of `\uXXXX`.
        expect(readBack.title.length).toBe(entry.title.length);
        expect(readBack.body.length).toBe(entry.body.length);

        // Remaining non-text fields, stated individually so a failure names the field.
        expect(readBack.entryId).toBe(entry.entryId);
        expect(readBack.status).toBe(entry.status);
        expect(readBack.sessionId).toBe(entry.sessionId);
        expect(readBack.generationFailed).toBe(entry.generationFailed);
        expect(readBack.schemaVersion).toBe(1);

        // Req 8.3, timestamps: the same instant in UTC. Not string equality — `encode` normalizes, so
        // an offset spelling legitimately comes back as a different string naming the same moment.
        expect(isSameInstantInUtc(readBack.createdAt, entry.createdAt)).toBe(true);
        expect(isSameInstantInUtc(readBack.updatedAt, entry.updatedAt)).toBe(true);

        // And what comes back is the canonical 24-character UTC spelling, which is the other half of
        // "the same instant in UTC": same moment, stated in UTC.
        expect(readBack.createdAt).toMatch(CANONICAL_INSTANT_PATTERN);
        expect(readBack.updatedAt).toMatch(CANONICAL_INSTANT_PATTERN);

        if (
          CANONICAL_INSTANT_PATTERN.test(entry.createdAt) &&
          CANONICAL_INSTANT_PATTERN.test(entry.updatedAt)
        ) {
          // The Entry was already canonical, so normalization is the identity and the whole Entry —
          // timestamps included — deep-equals the original. This is the clause the design's test note
          // states, and it is where every generated draw lands.
          canonicalTimestampEntries += 1;
          expect(readBack).toEqual(entry);
        } else {
          normalizedTimestampEntries += 1;
        }

        // The round trip is stable: re-encoding what came back yields the same item, so decode
        // produced a value `encode` accepts and no information was left behind in the first pass.
        const reEncoded = encode(readBack);
        expect(reEncoded.ok).toBe(true);
        if (!reEncoded.ok) {
          throw new Error(`encode rejected a decoded Entry: ${reEncoded.error.kind}`);
        }
        expect(reEncoded.item).toEqual(encoded.item);
      }),
      { numRuns: 100, examples: EXAMPLES },
    );

    // Totality held on every input the property saw, and the run count is the design's minimum.
    expect(encodeFailures).toEqual([]);
    expect(decodeFailures).toEqual([]);
    expect(runs).toBeGreaterThanOrEqual(100);

    // The Unicode input space was actually explored: code points above U+FFFF reached both text
    // fields, combining marks reached both, and all four code-point boundaries were sat on.
    expect(astralTitles).toBeGreaterThan(0);
    expect(astralBodies).toBeGreaterThan(0);
    expect(combiningMarkTitles).toBeGreaterThan(0);
    expect(combiningMarkBodies).toBeGreaterThan(0);
    expect(titlesAtMinLength).toBeGreaterThan(0);
    expect(titlesAtMaxLength).toBeGreaterThan(0);
    expect(bodiesAtMinLength).toBeGreaterThan(0);
    expect(bodiesAtMaxLength).toBeGreaterThan(0);

    // Both timestamp regimes were exercised: Entries already in canonical form, where the full deep
    // equality clause applies, and Entries in another admissible spelling, where only same-instant
    // equality can hold.
    expect(canonicalTimestampEntries).toBeGreaterThan(0);
    expect(normalizedTimestampEntries).toBeGreaterThan(0);
  });
});
