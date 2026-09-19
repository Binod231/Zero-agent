import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { codePointLength, truncateAtCodePoint } from '../../src/core/code-points';
import { canonicalBytes, encode } from '../../src/core/entry-serializer';
import type { DynamoItem, Entry } from '../../src/core/types';
import { arbEntry, arbEntryWith, arbUlid, arbUtcInstant } from '../generators';

/**
 * **Property 6: Entry serialization is canonical and deterministic.**
 *
 * **Validates: Requirements 8.7**
 *
 * One `fc.assert`, as the design's *Property test conventions* require, with every clause of the
 * property asserted inside it:
 *
 * 1. **Byte equality for field-equal pairs.** `canonicalBytes(encode(a))` equals
 *    `canonicalBytes(encode(b))` when `b` carries the same field values as `a` but was *constructed
 *    along a different path*.
 * 2. **Stability across repeated invocation.** Encoding and canonicalizing the same Entry again, and
 *    canonicalizing the same item object again, yields the same bytes.
 * 3. **Independence of invocation order.** The same bytes come out whether `a` is encoded before
 *    `b`, after `b`, or interleaved with encodings of unrelated Entries.
 * 4. **The converse.** An Entry differing from `a` in any one field must *not* produce `a`'s bytes.
 *    Without this clause a `canonicalBytes` that returned a constant would satisfy clauses 1-3.
 *
 * **The second construction path is the substance of the test.** Encoding one object twice proves
 * almost nothing — `encode` is pure, so of course it agrees with itself. What Req 8.7 is about is two
 * Entries that *arrived differently* and hold equal field values. Five independent paths are
 * generated per pair, rather than one being hand-picked:
 *
 * - **Instant respelling** (`createdAt`, `updatedAt`): a zone offset in place of `Z` with the wall
 *   clock shifted to match, surrounding whitespace, a fraction padded with trailing zeros, a fraction
 *   carrying sub-millisecond digits that normalization truncates, and — for minute-aligned instants —
 *   an omitted seconds component. `encode` normalizes each back to the 24-character UTC form.
 * - **Session-date respelling**: the date carried as a midnight instant, as a midday instant under an
 *   offset, or padded with whitespace.
 * - **String rebuilding**: `title` and `body` split at a code point boundary and concatenated back,
 *   so the twin's strings are built by concatenation rather than reused.
 * - **Entry field assignment order**: the twin's ten fields assigned in a drawn non-identity
 *   permutation, so `Object.keys(twin)` differs from `Object.keys(entry)`.
 * - **Item attribute assignment order**: the *encoded item* rebuilt with its fourteen attributes
 *   assigned in a rotated-and-reversed order, which is what makes the recursive key sort in
 *   `canonicalBytes` load-bearing rather than incidental.
 *
 * Each respelling is checked to have actually produced a *different input string*, and the two key
 * orders to have actually differed, so a "different path" that quietly degenerated into the canonical
 * spelling fails here instead of passing vacuously. The `afterAll` block asserts each path was
 * exercised, which is the same guard `test/property/entry-ordering.test.ts` puts on its tie-breaks.
 *
 * **Scope against `test/unit/entry-serializer.sizing.test.ts`.** The unit tests own the *mechanism* of
 * the canonical encoding: sorted output for one item, integer-like key ordering, JSON escaping, one
 * hand-built equal-content pair, and totality on out-of-contract shapes. None of that is restated
 * here. What is here is the universal quantification over `arbEntry` that examples cannot give.
 *
 * Byte equality is compared as *bytes*: element by element over the `Uint8Array`s, and a failure
 * reports the first differing index with the surrounding bytes in hex and as text, so a counterexample
 * is diagnosable rather than just red.
 *
 * No AWS, no clock, no I/O: `encode` and `canonicalBytes` are pure and the generators are data.
 */

type EntryField = keyof Entry;

const ENTRY_FIELDS: readonly EntryField[] = [
  'entryId',
  'title',
  'body',
  'sessionDate',
  'status',
  'createdAt',
  'updatedAt',
  'sessionId',
  'generationFailed',
  'schemaVersion',
];

/** The ways an instant is respelled so that it normalizes back to the same canonical form. */
type InstantRespellingKind =
  | 'ZONE_OFFSET'
  | 'SURROUNDING_WHITESPACE'
  | 'FRACTION_TRAILING_ZEROS'
  | 'FRACTION_SUB_MILLISECOND'
  | 'OMITTED_SECONDS';

/** The ways a session date is respelled so that it normalizes back to the same `YYYY-MM-DD`. */
type SessionDateRespellingKind = 'MIDNIGHT_INSTANT' | 'OFFSET_INSTANT' | 'SURROUNDING_WHITESPACE';

type RespellingKind = InstantRespellingKind | SessionDateRespellingKind;

/** Which field of an Entry a converse-direction mutation changes. `schemaVersion` is the literal 1. */
type MutationField = Exclude<EntryField, 'schemaVersion'>;

const MUTATION_FIELDS: readonly MutationField[] = [
  'entryId',
  'title',
  'body',
  'sessionDate',
  'status',
  'createdAt',
  'updatedAt',
  'sessionId',
  'generationFailed',
];

interface Whitespace {
  left: string;
  right: string;
}

interface InstantRespelling {
  kind: InstantRespellingKind;
  /** Minutes east of UTC, a multiple of 15 within ±23:45. */
  offsetMinutes: number;
  /** 1 to 6 digits appended after the millisecond digits; the first is never `0`. */
  extraFractionDigits: string;
  padding: Whitespace;
}

interface SessionDateRespelling {
  kind: SessionDateRespellingKind;
  /** Minutes east of UTC within ±11:30, so a midday wall clock stays on the same UTC date. */
  offsetMinutes: number;
  padding: Whitespace;
}

/** One applied construction-path variation, kept so the property can prove the input really differed. */
interface AppliedRespelling {
  field: 'sessionDate' | 'createdAt' | 'updatedAt';
  kind: RespellingKind;
  /** The text handed to `encode` for the twin. */
  input: string;
  /** False when the respelling does not apply to this value. Only `OMITTED_SECONDS` can be absent. */
  applicable: boolean;
  /** True when the twin's input text differs from the original's, which is the whole point. */
  differs: boolean;
}

interface Mutation {
  field: MutationField;
  /** A ULID for the identifier mutations, forced away from the original when it collides. */
  replacementUlid: string;
  /** A non-zero millisecond shift for the instant mutations. */
  instantShiftMs: number;
  /** A non-zero day shift for the session-date mutation. */
  dayShift: number;
}

interface CanonicalCase {
  entry: Entry;
  /** Field-equal to `entry`, built along the five different paths described above. */
  twin: Entry;
  /** An Entry that differs from `entry` in exactly one field: the converse-direction witness. */
  mutated: Entry;
  mutationField: MutationField;
  /** An Entry encoded between the encodings of `entry` and `twin`, to disturb invocation order. */
  unrelated: Entry;
  respellings: AppliedRespelling[];
  /** The order the twin's fields were assigned in. */
  fieldOrder: EntryField[];
  /** Seed for the rotation used when reassigning the encoded item's attributes. */
  attributeRotation: number;
}

// ---------------------------------------------------------------------------------------------
// Respelling an instant and a session date without changing the value they denote
// ---------------------------------------------------------------------------------------------

function offsetSuffix(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const magnitude = Math.abs(offsetMinutes);
  const hours = String(Math.floor(magnitude / 60)).padStart(2, '0');
  const minutes = String(magnitude % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

/**
 * The wall-clock reading of `canonicalInstant` in a zone `offsetMinutes` east of UTC, as the 23
 * characters before the zone designator. Generated instants sit in 2020-2030, so no offset can push
 * the year outside the four-digit range.
 */
function wallClockOf(canonicalInstant: string, offsetMinutes: number): string {
  const epochMs = Date.parse(canonicalInstant) + offsetMinutes * 60_000;
  return new Date(epochMs).toISOString().slice(0, 23);
}

/**
 * A different spelling of the same instant, or `null` when the respelling does not apply.
 *
 * Every branch is a spelling `encode` normalizes back to `canonicalInstant`: the zone offset moves
 * the wall clock to match, whitespace is trimmed, extra fraction digits are truncated at
 * milliseconds, and an omitted seconds component defaults to `00.000` — which is why that last one
 * only applies to a minute-aligned instant.
 */
function respellInstant(canonicalInstant: string, choice: InstantRespelling): string | null {
  switch (choice.kind) {
    case 'ZONE_OFFSET':
      return `${wallClockOf(canonicalInstant, choice.offsetMinutes)}${offsetSuffix(choice.offsetMinutes)}`;
    case 'SURROUNDING_WHITESPACE':
      return `${choice.padding.left}${canonicalInstant}${choice.padding.right}`;
    case 'FRACTION_TRAILING_ZEROS':
      return `${canonicalInstant.slice(0, 23)}${'0'.repeat(choice.extraFractionDigits.length)}Z`;
    case 'FRACTION_SUB_MILLISECOND':
      return `${canonicalInstant.slice(0, 23)}${choice.extraFractionDigits}Z`;
    case 'OMITTED_SECONDS':
      // `YYYY-MM-DDTHH:mm` plus the zone: only the same instant when seconds and milliseconds are 0.
      return canonicalInstant.endsWith(':00.000Z') ? `${canonicalInstant.slice(0, 16)}Z` : null;
  }
}

/**
 * A different spelling of the same calendar date. `encode` reduces a full instant to its UTC calendar
 * date, so a midday wall clock under an offset within ±11:30 still names the same day.
 */
function respellSessionDate(date: string, choice: SessionDateRespelling): string {
  switch (choice.kind) {
    case 'MIDNIGHT_INSTANT':
      return `${date}T00:00:00.000Z`;
    case 'OFFSET_INSTANT':
      return `${date}T12:00:00.000${offsetSuffix(choice.offsetMinutes)}`;
    case 'SURROUNDING_WHITESPACE':
      return `${choice.padding.left}${date}${choice.padding.right}`;
  }
}

/**
 * The same string value, built by concatenating two halves split at a code point boundary rather than
 * reused. A value-level identity by construction — the difference is in how the twin's string was
 * produced, not in what it holds.
 */
function rebuildString(text: string, splitAt: number): string {
  const codePoints = [...text];
  const index = codePoints.length === 0 ? 0 : splitAt % codePoints.length;
  return `${codePoints.slice(0, index).join('')}${codePoints.slice(index).join('')}`;
}

/**
 * The Entry's fields assigned in `order`, so two field-equal Entries differ in property order.
 *
 * `order` is a permutation of every `Entry` key, so the result carries all ten fields with the values
 * they had in `fields`; only the insertion order differs, which is what the assertion is about.
 */
function assignInOrder(fields: Entry, order: readonly EntryField[]): Entry {
  const built: Record<string, unknown> = {};
  for (const field of order) {
    built[field] = fields[field];
  }
  return built as unknown as Entry;
}

/**
 * The same attribute map with its attributes assigned in a rotated, reversed order. Fourteen distinct
 * attribute names make the result's insertion order always differ from the input's, which the property
 * asserts rather than assumes.
 */
function reassignAttributes(item: DynamoItem, rotation: number): DynamoItem {
  const names = Object.keys(item);
  const start = names.length === 0 ? 0 : rotation % names.length;
  const rebuilt: DynamoItem = {};
  for (const name of [...names.slice(start), ...names.slice(0, start)].reverse()) {
    const value = item[name];
    if (value !== undefined) {
      rebuilt[name] = value;
    }
  }
  return rebuilt;
}

// ---------------------------------------------------------------------------------------------
// The converse direction: an Entry differing in exactly one field
// ---------------------------------------------------------------------------------------------

/** A ULID other than `original`. The ULID alphabet holds both `0` and `1`, so the fallback is valid. */
function differentUlid(original: string, candidate: string): string {
  if (candidate !== original) {
    return candidate;
  }
  return `${original.slice(0, 25)}${original.endsWith('0') ? '1' : '0'}`;
}

/** Text that differs from `text` and still holds 1 to `maxCodePoints` code points. */
function alterText(text: string, maxCodePoints: number): string {
  return codePointLength(text) < maxCodePoints
    ? `${text}x`
    : truncateAtCodePoint(text, maxCodePoints - 1);
}

function shiftInstant(canonicalInstant: string, shiftMs: number): string {
  return new Date(Date.parse(canonicalInstant) + shiftMs).toISOString();
}

function shiftSessionDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** An Entry equal to `entry` except in `mutation.field`, where the value is guaranteed to differ. */
function mutate(entry: Entry, mutation: Mutation): Entry {
  switch (mutation.field) {
    case 'entryId':
      return { ...entry, entryId: differentUlid(entry.entryId, mutation.replacementUlid) };
    case 'title':
      return { ...entry, title: alterText(entry.title, 120) };
    case 'body':
      return { ...entry, body: alterText(entry.body, 20_000) };
    case 'sessionDate':
      return { ...entry, sessionDate: shiftSessionDate(entry.sessionDate, mutation.dayShift) };
    case 'status':
      return { ...entry, status: entry.status === 'draft' ? 'published' : 'draft' };
    case 'createdAt':
      return { ...entry, createdAt: shiftInstant(entry.createdAt, mutation.instantShiftMs) };
    case 'updatedAt':
      return { ...entry, updatedAt: shiftInstant(entry.updatedAt, mutation.instantShiftMs) };
    case 'sessionId':
      return { ...entry, sessionId: differentUlid(entry.sessionId, mutation.replacementUlid) };
    case 'generationFailed':
      return { ...entry, generationFailed: !entry.generationFailed };
  }
}

// ---------------------------------------------------------------------------------------------
// Byte comparison, with a diagnosable failure
// ---------------------------------------------------------------------------------------------

/** The index of the first differing byte, or `null` when the two sequences are byte for byte equal. */
function firstDifferingIndex(left: Uint8Array, right: Uint8Array): number | null {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }
  return left.length === right.length ? null : shared;
}

/**
 * The bytes around `index` in hex and as text. The window can start or end inside a multi-byte
 * sequence, so the decoded text may show a replacement character; that is a property of the window,
 * not of the bytes, and the hex is the authoritative half of the report.
 */
function neighbourhood(bytes: Uint8Array, index: number): string {
  const from = Math.max(0, index - 8);
  const to = Math.min(bytes.length, index + 9);
  const hex = [...bytes.slice(from, to)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
  const text = new TextDecoder().decode(bytes.slice(from, to));
  return `bytes[${String(from)}..${String(to - 1)}] ${hex} ${JSON.stringify(text)}`;
}

/** A description of the first byte-level difference, or `null` when there is none. */
function byteDifference(
  left: Uint8Array,
  right: Uint8Array,
  leftLabel: string,
  rightLabel: string,
): string | null {
  const index = firstDifferingIndex(left, right);
  if (index === null) {
    return null;
  }
  return [
    `${leftLabel} and ${rightLabel} first differ at byte ${String(index)}`,
    `(lengths ${String(left.length)} and ${String(right.length)});`,
    `${leftLabel}: ${neighbourhood(left, index)};`,
    `${rightLabel}: ${neighbourhood(right, index)}`,
  ].join(' ');
}

function encodeOrFail(entry: Entry, label: string): DynamoItem {
  const result = encode(entry);
  if (!result.ok) {
    throw new Error(
      `${label} failed to encode: ${result.error.kind} on ${result.error.attribute}`,
    );
  }
  return result.item;
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

const arbWhitespacePadding: fc.Arbitrary<Whitespace> = fc.record({
  // At least one code point on the left, so the padded spelling always differs from the canonical one.
  left: fc.string({ unit: fc.constantFrom(' ', '\t', '\n', '\r'), minLength: 1, maxLength: 3 }),
  right: fc.string({ unit: fc.constantFrom(' ', '\t', '\n', '\r'), maxLength: 3 }),
});

/** 1 to 6 extra fraction digits whose first digit is never `0`, so the spelling is not zero padding. */
const arbExtraFractionDigits: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...'123456789'),
    fc.string({ unit: fc.constantFrom(...'0123456789'), maxLength: 5 }),
  )
  .map(([head, tail]) => `${head}${tail}`);

const arbInstantRespelling: fc.Arbitrary<InstantRespelling> = fc.record({
  kind: fc.constantFrom<InstantRespellingKind>(
    'ZONE_OFFSET',
    'SURROUNDING_WHITESPACE',
    'FRACTION_TRAILING_ZEROS',
    'FRACTION_SUB_MILLISECOND',
    'OMITTED_SECONDS',
  ),
  // Quarter-hour offsets out to ±23:45, the widest the normalizer accepts. 0 spells `Z` as `+00:00`.
  offsetMinutes: fc.integer({ min: -95, max: 95 }).map((quarters) => quarters * 15),
  extraFractionDigits: arbExtraFractionDigits,
  padding: arbWhitespacePadding,
});

const arbSessionDateRespelling: fc.Arbitrary<SessionDateRespelling> = fc.record({
  kind: fc.constantFrom<SessionDateRespellingKind>(
    'MIDNIGHT_INSTANT',
    'OFFSET_INSTANT',
    'SURROUNDING_WHITESPACE',
  ),
  // ±11:30 keeps a midday wall clock on the same UTC calendar date.
  offsetMinutes: fc.integer({ min: -46, max: 46 }).map((quarters) => quarters * 15),
  padding: arbWhitespacePadding,
});

/** A non-identity permutation of the ten `Entry` keys. */
const arbFieldOrder: fc.Arbitrary<EntryField[]> = fc
  .shuffledSubarray([...ENTRY_FIELDS], {
    minLength: ENTRY_FIELDS.length,
    maxLength: ENTRY_FIELDS.length,
  })
  .filter((order) => order.some((field, index) => field !== ENTRY_FIELDS[index]));

const arbMutation: fc.Arbitrary<Mutation> = fc.record({
  field: fc.constantFrom(...MUTATION_FIELDS),
  replacementUlid: arbUlid,
  instantShiftMs: fc.oneof(
    fc.integer({ min: 1, max: 86_400_000 }),
    fc.integer({ min: -86_400_000, max: -1 }),
  ),
  dayShift: fc.oneof(fc.integer({ min: 1, max: 5 }), fc.integer({ min: -5, max: -1 })),
});

/** `YYYY-MM-DDTHH:mm:00.000Z`: the instants the `OMITTED_SECONDS` respelling applies to. */
function toMinuteBoundary(instant: string): string {
  return `${instant.slice(0, 17)}00.000Z`;
}

/**
 * Entries whose timestamps sit on a minute boundary. Uniform instants are almost never minute
 * aligned, so without this branch the `OMITTED_SECONDS` construction path would go untested.
 */
const arbMinuteAlignedEntry: fc.Arbitrary<Entry> = fc
  .tuple(arbUtcInstant, arbUtcInstant)
  .chain(([created, updated]) =>
    arbEntryWith({
      createdAt: toMinuteBoundary(created),
      updatedAt: toMinuteBoundary(updated),
    }),
  );

const arbBaseEntry: fc.Arbitrary<Entry> = fc.oneof(
  { arbitrary: arbEntry, weight: 3 },
  { arbitrary: arbMinuteAlignedEntry, weight: 1 },
);

/**
 * Applies one respelling, recording whether it applied and whether it actually changed the input text.
 * When it does not apply, the canonical spelling is used and the pair is still field-equal.
 */
function applyRespelling(
  field: AppliedRespelling['field'],
  original: string,
  kind: RespellingKind,
  respelled: string | null,
  applied: AppliedRespelling[],
): string {
  const input = respelled ?? original;
  applied.push({
    field,
    kind,
    input,
    applicable: respelled !== null,
    differs: input !== original,
  });
  return input;
}

const arbCanonicalCase: fc.Arbitrary<CanonicalCase> = fc
  .record({
    entry: arbBaseEntry,
    unrelated: arbEntry,
    createdAtRespelling: arbInstantRespelling,
    updatedAtRespelling: arbInstantRespelling,
    sessionDateRespelling: arbSessionDateRespelling,
    titleSplit: fc.nat({ max: 512 }),
    bodySplit: fc.nat({ max: 512 }),
    fieldOrder: arbFieldOrder,
    attributeRotation: fc.nat({ max: 32 }),
    mutation: arbMutation,
  })
  .map((draw): CanonicalCase => {
    const { entry } = draw;
    const respellings: AppliedRespelling[] = [];

    const createdAt = applyRespelling(
      'createdAt',
      entry.createdAt,
      draw.createdAtRespelling.kind,
      respellInstant(entry.createdAt, draw.createdAtRespelling),
      respellings,
    );
    const updatedAt = applyRespelling(
      'updatedAt',
      entry.updatedAt,
      draw.updatedAtRespelling.kind,
      respellInstant(entry.updatedAt, draw.updatedAtRespelling),
      respellings,
    );
    const sessionDate = applyRespelling(
      'sessionDate',
      entry.sessionDate,
      draw.sessionDateRespelling.kind,
      respellSessionDate(entry.sessionDate, draw.sessionDateRespelling),
      respellings,
    );

    const twinFields: Entry = {
      ...entry,
      title: rebuildString(entry.title, draw.titleSplit),
      body: rebuildString(entry.body, draw.bodySplit),
      sessionDate,
      createdAt,
      updatedAt,
    };

    return {
      entry,
      twin: assignInOrder(twinFields, draw.fieldOrder),
      mutated: mutate(entry, draw.mutation),
      mutationField: draw.mutation.field,
      unrelated: draw.unrelated,
      respellings,
      fieldOrder: draw.fieldOrder,
      attributeRotation: draw.attributeRotation,
    };
  });

// ---------------------------------------------------------------------------------------------
// Coverage of the construction paths, asserted after the property has run
// ---------------------------------------------------------------------------------------------

interface RespellingCoverage {
  applied: number;
  notApplicable: number;
  /** Applied respellings whose input text genuinely differed from the canonical spelling. */
  differed: number;
}

function emptyRespellingCoverage(): RespellingCoverage {
  return { applied: 0, notApplicable: 0, differed: 0 };
}

const coverage = {
  /** Pairs examined, counting shrinking runs. */
  pairs: 0,
  respellings: {
    ZONE_OFFSET: emptyRespellingCoverage(),
    SURROUNDING_WHITESPACE: emptyRespellingCoverage(),
    FRACTION_TRAILING_ZEROS: emptyRespellingCoverage(),
    FRACTION_SUB_MILLISECOND: emptyRespellingCoverage(),
    OMITTED_SECONDS: emptyRespellingCoverage(),
    MIDNIGHT_INSTANT: emptyRespellingCoverage(),
    OFFSET_INSTANT: emptyRespellingCoverage(),
  } satisfies Record<RespellingKind, RespellingCoverage>,
  /** Pairs where at least one of the three respelled inputs differed as text before encoding. */
  pairsWithDifferingInputText: 0,
  /** Pairs where the twin's field assignment order differed from the original's. */
  pairsWithDifferingFieldOrder: 0,
  /** Pairs where the rebuilt item's attribute assignment order differed from the encoder's. */
  pairsWithDifferingAttributeOrder: 0,
  /** Pairs where the rebuilt `title` and `body` were equal in value, as they must be. */
  pairsWithEqualRebuiltStrings: 0,
  /** Byte sequences compared against the first encoding of the original, summed over all pairs. */
  byteComparisons: 0,
  /** Converse-direction checks, by the field the mutation changed. */
  mutations: {
    entryId: 0,
    title: 0,
    body: 0,
    sessionDate: 0,
    status: 0,
    createdAt: 0,
    updatedAt: 0,
    sessionId: 0,
    generationFailed: 0,
  } satisfies Record<MutationField, number>,
};

describe('Entry_Serializer canonical encoding', () => {
  it('gives field-equal Entries identical bytes on every invocation and in any order (Property 6)', () => {
    // Feature: devlog-narrator, Property 6: For any pair of Entries whose field values are equal,
    // the Entry_Serializer produces canonical encoded representations that are identical byte for
    // byte, on every invocation and independently of the order in which the encodings are produced.
    fc.assert(
      fc.property(arbCanonicalCase, (testCase) => {
        const { entry, twin, mutated, unrelated } = testCase;
        const violations: string[] = [];

        coverage.pairs += 1;

        // Evidence the second construction path is real rather than cosmetic: each respelling either
        // did not apply to this value, or produced an input string that actually differs.
        for (const respelling of testCase.respellings) {
          const kindCoverage = coverage.respellings[respelling.kind];
          if (respelling.applicable) {
            kindCoverage.applied += 1;
            if (respelling.differs) {
              kindCoverage.differed += 1;
            } else {
              violations.push(
                `${respelling.kind} on ${respelling.field} produced the canonical spelling ` +
                  `${JSON.stringify(respelling.input)}, so the twin took the same path`,
              );
            }
          } else {
            kindCoverage.notApplicable += 1;
          }
        }
        if (testCase.respellings.some((respelling) => respelling.differs)) {
          coverage.pairsWithDifferingInputText += 1;
        } else {
          violations.push('no respelling changed the twin input text');
        }

        // The twin's fields were assigned in a different order, and its strings were rebuilt.
        if (Object.keys(twin).join() === Object.keys(entry).join()) {
          violations.push(`twin field order did not differ: ${Object.keys(twin).join()}`);
        } else {
          coverage.pairsWithDifferingFieldOrder += 1;
        }
        if (twin.title === entry.title && twin.body === entry.body) {
          coverage.pairsWithEqualRebuiltStrings += 1;
        } else {
          violations.push('rebuilding title or body changed its value, so the pair is not field-equal');
        }

        // Clause 1, first half: the original encoded and canonicalized once.
        const originalItem = encodeOrFail(entry, 'entry');
        const reference = canonicalBytes(originalItem);

        // Clause 3: three invocation orders. Every encode is fresh, so nothing is shared between them.
        // Order A — original first, then the twin.
        const twinItem = encodeOrFail(twin, 'twin');
        const twinFirstOrder = canonicalBytes(twinItem);
        // Order B — the twin first, then the original.
        const twinBeforeOriginal = canonicalBytes(encodeOrFail(twin, 'twin'));
        const originalAfterTwin = canonicalBytes(encodeOrFail(entry, 'entry'));
        // Order C — interleaved with encodings of unrelated Entries whose bytes are discarded.
        canonicalBytes(encodeOrFail(unrelated, 'unrelated'));
        const twinInterleaved = canonicalBytes(encodeOrFail(twin, 'twin'));
        canonicalBytes(encodeOrFail(mutated, 'mutated'));
        const originalInterleaved = canonicalBytes(encodeOrFail(entry, 'entry'));
        canonicalBytes(encodeOrFail(unrelated, 'unrelated'));

        // Clause 2: canonicalizing the same item object again, twice over.
        const originalRepeated = canonicalBytes(originalItem);
        const originalRepeatedAgain = canonicalBytes(originalItem);
        const twinRepeated = canonicalBytes(twinItem);

        // Clause 1, second half: the twin's item with its attributes assigned in a different order.
        const reorderedTwinItem = reassignAttributes(twinItem, testCase.attributeRotation);
        if (Object.keys(reorderedTwinItem).join() === Object.keys(twinItem).join()) {
          violations.push(`item attribute order did not differ: ${Object.keys(twinItem).join()}`);
        } else {
          coverage.pairsWithDifferingAttributeOrder += 1;
        }
        const twinReordered = canonicalBytes(reorderedTwinItem);

        const compared: readonly (readonly [string, Uint8Array])[] = [
          ['twin encoded after the original', twinFirstOrder],
          ['twin encoded before the original', twinBeforeOriginal],
          ['original re-encoded after the twin', originalAfterTwin],
          ['twin encoded between unrelated encodings', twinInterleaved],
          ['original encoded between unrelated encodings', originalInterleaved],
          ['original item canonicalized a second time', originalRepeated],
          ['original item canonicalized a third time', originalRepeatedAgain],
          ['twin item canonicalized a second time', twinRepeated],
          ['twin item with attributes reassigned in another order', twinReordered],
        ];
        for (const [label, bytes] of compared) {
          coverage.byteComparisons += 1;
          const difference = byteDifference(reference, bytes, 'original first encoding', label);
          if (difference !== null) {
            violations.push(difference);
          }
        }

        // Clause 4, the converse: an Entry differing in one field must not land on the same bytes.
        // Without this, a `canonicalBytes` returning a constant would satisfy everything above.
        coverage.mutations[testCase.mutationField] += 1;
        if (mutated[testCase.mutationField] === entry[testCase.mutationField]) {
          violations.push(`mutation of ${testCase.mutationField} left the field value unchanged`);
        }
        const mutatedBytes = canonicalBytes(encodeOrFail(mutated, 'mutated'));
        if (firstDifferingIndex(reference, mutatedBytes) === null) {
          violations.push(
            `changing ${testCase.mutationField} left the canonical bytes identical over all ` +
              `${String(reference.length)} bytes`,
          );
        }

        expect(violations, 'canonical encoding').toEqual([]);
      }),
    );
  });

  afterAll(() => {
    // Not a property: a guard on the input space the property above ran over. Each of the five
    // construction paths has to have been exercised, and each respelling that applied has to have
    // genuinely changed the input text — otherwise the pairs were field-equal by re-spelling nothing
    // and clause 1 would hold vacuously.
    expect(coverage.pairs, 'pairs examined').toBeGreaterThanOrEqual(100);
    expect(coverage.pairsWithDifferingFieldOrder, 'pairs with a permuted field order').toBe(
      coverage.pairs,
    );
    expect(coverage.pairsWithDifferingAttributeOrder, 'pairs with reassigned attributes').toBe(
      coverage.pairs,
    );
    expect(coverage.pairsWithEqualRebuiltStrings, 'pairs whose rebuilt strings stayed equal').toBe(
      coverage.pairs,
    );
    expect(coverage.pairsWithDifferingInputText, 'pairs whose input text differed').toBe(
      coverage.pairs,
    );
    expect(coverage.byteComparisons, 'byte sequences compared').toBeGreaterThanOrEqual(
      coverage.pairs * 9,
    );

    for (const [kind, kindCoverage] of Object.entries(coverage.respellings)) {
      expect(kindCoverage.applied, `${kind} respellings applied`).toBeGreaterThanOrEqual(3);
      expect(kindCoverage.differed, `${kind} respellings that changed the input`).toBe(
        kindCoverage.applied,
      );
    }
    // Every respelling but the seconds-omitting one applies to every value it is drawn for.
    for (const [kind, kindCoverage] of Object.entries(coverage.respellings)) {
      if (kind !== 'OMITTED_SECONDS') {
        expect(kindCoverage.notApplicable, `${kind} respellings skipped`).toBe(0);
      }
    }

    for (const [field, count] of Object.entries(coverage.mutations)) {
      expect(count, `converse checks mutating ${field}`).toBeGreaterThanOrEqual(3);
    }
  });
});
