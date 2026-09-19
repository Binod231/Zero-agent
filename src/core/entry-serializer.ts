/**
 * Entry_Serializer: an `Entry` to and from the marshalled DynamoDB item (Req 8.2, 8.3, 8.4).
 *
 * Pure and synchronous. No AWS SDK import, no I/O, no clock: the module operates on plain attribute
 * maps, so both directions are exercisable as data. Neither `encode` nor `decode` throws for any
 * input — every failure is an `EncodeError` or a `DecodeError` value, which is what makes the
 * totality obligation of Req 8.2 mechanically checkable rather than a claim about which inputs were
 * tried.
 *
 * The attribute set, the DynamoDB types, and the per-field normalization and validation rules are
 * the design's *Entry_Serializer mapping* table, transcribed row for row. The three rules that make
 * the determinism obligation of Req 8.7 achievable are implemented literally:
 *
 * 1. **No optional attributes.** All fourteen attributes are always written, `generationFailed`
 *    always as a `BOOL` even when false. An absent key would make two field-equal Entries encode
 *    differently depending on which code path produced them.
 * 2. **One canonical form per value.** `encode` *normalizes on the way in*: `sessionDate` becomes
 *    10-character `YYYY-MM-DD`, `createdAt` and `updatedAt` become the 24-character
 *    `YYYY-MM-DDTHH:mm:ss.sssZ` UTC form. An Entry constructed from a differently formatted instant
 *    therefore encodes identically to one constructed from the canonical spelling. An encode failure
 *    means a value no normalization can rescue.
 * 3. **Closed unions and a literal `schemaVersion`.** `status` comes from `{draft, published}` and
 *    `schemaVersion` is always the number 1.
 *
 * **Lengths are code points.** `title` is 1-120 and `body` is 1-20000 *code points*, measured with
 * {@link codePointLength}, never with `String#length`. A body of astral-plane characters would
 * otherwise be rejected at half its stated limit (Req 8.4).
 *
 * **Errors name attributes, never values.** Every `EncodeError` and every `DecodeError` carries an
 * attribute name and nothing else, so the Devlog_API can log it beside the correlation identifier
 * without leaking Author content into a log record (Req 11.2, 11.3). The single exception is
 * `UNKNOWN_SCHEMA`, whose `version` the design requires and which is a schema number rather than
 * Entry content.
 *
 * **The two decode error kinds are not interchangeable.** `WRONG_TYPE` means the *attribute type* is
 * not the one the mapping table names (a `BOOL` where an `S` belongs). `OUT_OF_RANGE` means the
 * attribute type is right and the *value* is not admissible: a bad ULID, a title over 120 code
 * points, `2026-02-30`, a status outside the union, a non-canonical instant, or a derived key
 * inconsistent with the field it is derived from.
 */

import { codePointLength } from './code-points';
// Aliased because `encode`'s parameter of the same name would shadow it, and a parameter default
// cannot refer to the parameter it initializes.
import { buildOrderingKey as defaultOrderingKeyBuilder } from './entry-ordering';
import { entryKey, timelinePartition } from './entry-repository-port';
import type {
  DecodeError,
  DecodeResult,
  DynamoItem,
  EncodeError,
  EncodeResult,
  Entry,
  EntryStatus,
} from './types';

// ---------------------------------------------------------------------------------------------
// Bounds and canonical forms
// ---------------------------------------------------------------------------------------------

/** The only `schemaVersion` this module reads or writes. Anything else is `UNKNOWN_SCHEMA`. */
const SCHEMA_VERSION = 1;

/** Req 5.1, 6.2, 6.7: title bounds, in code points. */
const TITLE_MIN_CODE_POINTS = 1;
const TITLE_MAX_CODE_POINTS = 120;

/** Req 6.2, 6.7, 8.2: body bounds, in code points. */
const BODY_MIN_CODE_POINTS = 1;
const BODY_MAX_CODE_POINTS = 20000;

/**
 * A ULID: 26 characters of Crockford base32. `I`, `L`, `O`, and `U` are absent from the alphabet,
 * so a lowercase or visually confusable identifier fails here rather than becoming a key that
 * addresses nothing.
 */
const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** The canonical `sessionDate`: exactly 10 characters. Realness of the date is checked separately. */
const SESSION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The canonical instant: exactly 24 characters, UTC, milliseconds always present. */
const CANONICAL_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The instant spellings `encode` will normalize *from*.
 *
 * Seconds and a fractional part are optional; a zone designator is **not**. An ISO date-time without
 * an offset is interpreted as local time by JavaScript, so admitting one would make the encoded
 * bytes depend on the host time zone and break Req 8.7 outright. The fractional part accepts up to
 * nine digits and is truncated to milliseconds, which is the precision the canonical form carries.
 */
const NORMALIZABLE_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------------------------
// The GSI1SK seam
// ---------------------------------------------------------------------------------------------

/**
 * How the `GSI1SK` ordering key is produced. `encode` takes it as an injectable parameter so that
 * this module never owns the ordering rule: **Entry_Ordering** (`./entry-ordering`) is the single
 * home of `buildOrderingKey`, `invert`, and `compareEntries`, and the agreement between the
 * key-derived order and the comparator is asserted there rather than here.
 *
 * The builder is handed the *normalized* Entry, so the key is always built from the canonical
 * `sessionDate` and `createdAt` that are written to the item, never from the caller's spelling.
 *
 * A builder must be total over Entries that passed `encode`'s validation — `entryId` is a 26-
 * character ULID, `sessionDate` is 10 characters, `createdAt` is 24 — which is what lets `encode`
 * keep its own never-throws guarantee. The default, `buildOrderingKey`, is total over every input.
 *
 * The parameter stays injectable because it is the seam the store fake and the ordering properties
 * use to substitute a key builder without reaching into `encode`. `decode` deliberately does not
 * read `GSI1SK`, so nothing on the read path depends on which builder wrote it.
 */
export type OrderingKeyBuilder = (entry: Entry) => string;

// ---------------------------------------------------------------------------------------------
// Calendar and instant primitives
// ---------------------------------------------------------------------------------------------

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) {
    return 30;
  }
  return 31;
}

/**
 * True when the leading 10 characters of `text` are a real calendar date.
 *
 * Arithmetic rather than `new Date(...)`: the legacy `Date.UTC` path maps a two-digit year onto
 * 1900 + year, which would make `0050-01-01` look unreal, and `Date` silently rolls `2026-02-30`
 * forward to March instead of rejecting it. The caller has already matched a digit pattern, so the
 * slices parse.
 */
function isRealCalendarDate(text: string): boolean {
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/**
 * True when `text` is the canonical 24-character UTC instant *and* names a real moment.
 *
 * The pattern alone would admit `2026-02-30T25:61:61.000Z`, which no clock in the System can
 * produce and `toISOString` never emits. Leap second 60 is refused for the same reason.
 */
function isCanonicalInstant(text: string): boolean {
  if (!CANONICAL_INSTANT_PATTERN.test(text) || !isRealCalendarDate(text)) {
    return false;
  }
  return (
    Number(text.slice(11, 13)) <= 23 &&
    Number(text.slice(14, 16)) <= 59 &&
    Number(text.slice(17, 19)) <= 59
  );
}

/** A normalization either yields the canonical spelling or names the kind of encode failure. */
type Normalization = { ok: true; value: string } | { ok: false; kind: EncodeError['kind'] };

/**
 * Normalizes any admissible instant spelling to the canonical 24-character UTC form.
 *
 * Accepted on the way in: the canonical form itself (returned unchanged, so normalization is the
 * identity on canonical input and the round trip of Req 8.3 holds), any offset (`+05:30`, `-08:00`)
 * which is converted to UTC, an omitted seconds component, and a fractional part of one to nine
 * digits which is truncated to milliseconds. Surrounding whitespace is a formatting difference and
 * is dropped.
 *
 * Refused: anything without a zone designator, and anything `Date` would parse by its
 * implementation-defined fallback. Both would make the encoded bytes depend on the host rather than
 * on the Entry.
 */
function normalizeInstant(raw: string): Normalization {
  const match = NORMALIZABLE_INSTANT_PATTERN.exec(raw.trim());
  if (match === null) {
    return { ok: false, kind: 'INVALID_ATTRIBUTE' };
  }

  const [, date, hour, minute, second = '00', fraction = '', zone] = match;
  if (date === undefined || hour === undefined || minute === undefined || zone === undefined) {
    return { ok: false, kind: 'INVALID_ATTRIBUTE' };
  }

  if (!isRealCalendarDate(date)) {
    return { ok: false, kind: 'OUT_OF_RANGE' };
  }
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return { ok: false, kind: 'OUT_OF_RANGE' };
  }
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) {
    return { ok: false, kind: 'OUT_OF_RANGE' };
  }

  // Hand `Date.parse` only the format the ECMAScript Date Time String Format specifies, so the
  // result is normative rather than engine-dependent. `.4` means 400 ms, so pad on the right.
  const milliseconds = `${fraction}000`.slice(0, 3);
  const epochMs = Date.parse(`${date}T${hour}:${minute}:${second}.${milliseconds}${zone}`);
  if (!Number.isFinite(epochMs)) {
    return { ok: false, kind: 'OUT_OF_RANGE' };
  }

  // Finite by the guard above, so `toISOString` cannot throw. An offset can still push the year
  // outside 0000-9999, where the extended `+010000-…` form is not the canonical 24 characters.
  const iso = new Date(epochMs).toISOString();
  return isCanonicalInstant(iso) ? { ok: true, value: iso } : { ok: false, kind: 'OUT_OF_RANGE' };
}

/**
 * Normalizes any admissible session-date spelling to the canonical `YYYY-MM-DD`.
 *
 * A bare calendar date passes through once its realness is checked; a full instant is reduced to its
 * UTC calendar date, so an Entry whose `sessionDate` was carried as a timestamp still encodes
 * identically to one carrying the 10-character form.
 */
function normalizeSessionDate(raw: string): Normalization {
  const text = raw.trim();
  if (SESSION_DATE_PATTERN.test(text)) {
    return isRealCalendarDate(text)
      ? { ok: true, value: text }
      : { ok: false, kind: 'OUT_OF_RANGE' };
  }

  const instant = normalizeInstant(text);
  return instant.ok ? { ok: true, value: instant.value.slice(0, 10) } : instant;
}

function isUlid(value: unknown): boolean {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

function isWithinCodePoints(text: string, min: number, max: number): boolean {
  const length = codePointLength(text);
  return length >= min && length <= max;
}

// ---------------------------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------------------------

function encodeInvalid(attribute: string): EncodeResult {
  return { ok: false, error: { kind: 'INVALID_ATTRIBUTE', attribute } };
}

function encodeOutOfRange(attribute: string): EncodeResult {
  return { ok: false, error: { kind: 'OUT_OF_RANGE', attribute } };
}

function encodeFailure(attribute: string, kind: EncodeError['kind']): EncodeResult {
  return kind === 'OUT_OF_RANGE' ? encodeOutOfRange(attribute) : encodeInvalid(attribute);
}

/**
 * Converts an Entry to the marshalled item the Entry_Store holds (Req 8.2, 8.7).
 *
 * Validation runs in the order of the design's mapping table and stops at the first offending
 * attribute, so the reported attribute is stable for a given item rather than dependent on which
 * check happens to run first. Every value is normalized before anything is written, and the item is
 * built in one expression from the normalized Entry, so a partially normalized item cannot be
 * produced.
 *
 * The type guards on each field are deliberate even though the parameter is typed: the handlers sit
 * behind a JSON boundary, and a guard is the difference between "returns an error" and "throws on
 * the request path".
 *
 * @param buildOrderingKey how to derive `GSI1SK`. See {@link OrderingKeyBuilder}. Defaults to
 * Entry_Ordering's `buildOrderingKey`, which is the design's rule, so the parameter is optional and
 * every existing call site gets the production key.
 */
export function encode(
  entry: Entry,
  buildOrderingKey: OrderingKeyBuilder = defaultOrderingKeyBuilder,
): EncodeResult {
  if (typeof entry !== 'object' || entry === null) {
    return encodeInvalid('entry');
  }

  if (!isUlid(entry.entryId)) {
    return encodeInvalid('entryId');
  }
  if (typeof entry.title !== 'string') {
    return encodeInvalid('title');
  }
  if (!isWithinCodePoints(entry.title, TITLE_MIN_CODE_POINTS, TITLE_MAX_CODE_POINTS)) {
    return encodeOutOfRange('title');
  }
  if (typeof entry.body !== 'string') {
    return encodeInvalid('body');
  }
  if (!isWithinCodePoints(entry.body, BODY_MIN_CODE_POINTS, BODY_MAX_CODE_POINTS)) {
    return encodeOutOfRange('body');
  }
  if (typeof entry.sessionDate !== 'string') {
    return encodeInvalid('sessionDate');
  }
  const sessionDate = normalizeSessionDate(entry.sessionDate);
  if (!sessionDate.ok) {
    return encodeFailure('sessionDate', sessionDate.kind);
  }
  if (entry.status !== 'draft' && entry.status !== 'published') {
    return encodeInvalid('status');
  }
  if (typeof entry.createdAt !== 'string') {
    return encodeInvalid('createdAt');
  }
  const createdAt = normalizeInstant(entry.createdAt);
  if (!createdAt.ok) {
    return encodeFailure('createdAt', createdAt.kind);
  }
  if (typeof entry.updatedAt !== 'string') {
    return encodeInvalid('updatedAt');
  }
  const updatedAt = normalizeInstant(entry.updatedAt);
  if (!updatedAt.ok) {
    return encodeFailure('updatedAt', updatedAt.kind);
  }
  if (!isUlid(entry.sessionId)) {
    return encodeInvalid('sessionId');
  }
  if (typeof entry.generationFailed !== 'boolean') {
    return encodeInvalid('generationFailed');
  }
  if (entry.schemaVersion !== SCHEMA_VERSION) {
    return encodeInvalid('schemaVersion');
  }

  // The canonical Entry: exactly what `decode` will read back, which is what makes the round trip
  // of Req 8.3 a consequence of the shape rather than a coincidence of the checks above.
  const canonical: Entry = {
    entryId: entry.entryId,
    title: entry.title,
    body: entry.body,
    sessionDate: sessionDate.value,
    status: entry.status,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    sessionId: entry.sessionId,
    generationFailed: entry.generationFailed,
    schemaVersion: SCHEMA_VERSION,
  };

  const key = entryKey(canonical.entryId);

  return {
    ok: true,
    item: {
      PK: { S: key.PK },
      SK: { S: key.SK },
      GSI1PK: { S: timelinePartition(canonical.status) },
      GSI1SK: { S: buildOrderingKey(canonical) },
      entryId: { S: canonical.entryId },
      title: { S: canonical.title },
      body: { S: canonical.body },
      sessionDate: { S: canonical.sessionDate },
      status: { S: canonical.status },
      createdAt: { S: canonical.createdAt },
      updatedAt: { S: canonical.updatedAt },
      sessionId: { S: canonical.sessionId },
      generationFailed: { BOOL: canonical.generationFailed },
      schemaVersion: { N: String(SCHEMA_VERSION) },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------------------------

/** One attribute read: the value, or the `DecodeError` that stops the whole decode. */
type AttributeRead<T> = { ok: true; value: T } | { ok: false; error: DecodeError };

function decodeMissing<T>(attribute: string): AttributeRead<T> {
  return { ok: false, error: { kind: 'MISSING_ATTRIBUTE', attribute } };
}

function decodeWrongType<T>(attribute: string): AttributeRead<T> {
  return { ok: false, error: { kind: 'WRONG_TYPE', attribute } };
}

function decodeOutOfRange(attribute: string): DecodeResult {
  return { ok: false, error: { kind: 'OUT_OF_RANGE', attribute } };
}

/**
 * Reads an `S` attribute. Under `noUncheckedIndexedAccess` the lookup is `… | undefined`, so
 * presence has to be tested — which is precisely what produces `MISSING_ATTRIBUTE` rather than a
 * `TypeError` later.
 *
 * The `typeof` check behind the `in` narrowing is not redundant at runtime: a stored item arrives
 * from the DynamoDB client as JSON that nothing has verified, and `DynamoItem` is an assertion about
 * that JSON rather than a proof of it.
 */
function readString(item: DynamoItem, attribute: string): AttributeRead<string> {
  const attributeValue = item[attribute];
  if (attributeValue === undefined || attributeValue === null) {
    return decodeMissing(attribute);
  }
  if (!('S' in attributeValue) || typeof attributeValue.S !== 'string') {
    return decodeWrongType(attribute);
  }
  return { ok: true, value: attributeValue.S };
}

/** Reads a `BOOL` attribute. `generationFailed` is always written, so absence is an anomaly. */
function readBoolean(item: DynamoItem, attribute: string): AttributeRead<boolean> {
  const attributeValue = item[attribute];
  if (attributeValue === undefined || attributeValue === null) {
    return decodeMissing(attribute);
  }
  if (!('BOOL' in attributeValue) || typeof attributeValue.BOOL !== 'boolean') {
    return decodeWrongType(attribute);
  }
  return { ok: true, value: attributeValue.BOOL };
}

/** Reads an `N` attribute. DynamoDB carries numbers as strings, so this parses rather than casts. */
function readNumber(item: DynamoItem, attribute: string): AttributeRead<number> {
  const attributeValue = item[attribute];
  if (attributeValue === undefined || attributeValue === null) {
    return decodeMissing(attribute);
  }
  if (!('N' in attributeValue) || typeof attributeValue.N !== 'string') {
    return decodeWrongType(attribute);
  }
  const parsed = attributeValue.N.trim() === '' ? Number.NaN : Number(attributeValue.N);
  return Number.isFinite(parsed) ? { ok: true, value: parsed } : decodeWrongType(attribute);
}

/**
 * Converts a stored item back to an Entry (Req 8.3, 8.4).
 *
 * Never throws, and never returns a partially populated Entry: the Entry object is constructed only
 * in the final `return`, after every attribute has been read and validated. Every anomaly is a
 * `DecodeError` naming the attribute, which the Public_Site renders as "temporarily unavailable"
 * (Req 1.8) and the Devlog_API logs with the correlation identifier and no value (Req 11.3).
 *
 * `schemaVersion` is checked first, so an item written by a future writer reports `UNKNOWN_SCHEMA`
 * instead of a misleading complaint about whichever field that writer changed.
 *
 * `GSI1SK` is deliberately neither read nor validated — the mapping table states no validation for
 * it. It is derived data consumed by an index scan, not by a single-item read, and its canonical
 * form belongs to Entry_Ordering. `PK`, `SK`, and `GSI1PK` *are* checked, because the mapping table
 * requires them to be consistent with `entryId` and `status`: an item whose key disagrees with its
 * fields is not an Entry this System wrote.
 */
export function decode(item: DynamoItem): DecodeResult {
  if (typeof item !== 'object' || item === null) {
    return { ok: false, error: { kind: 'MISSING_ATTRIBUTE', attribute: 'PK' } };
  }

  const schemaVersion = readNumber(item, 'schemaVersion');
  if (!schemaVersion.ok) {
    return schemaVersion;
  }
  if (schemaVersion.value !== SCHEMA_VERSION) {
    return { ok: false, error: { kind: 'UNKNOWN_SCHEMA', version: schemaVersion.value } };
  }

  const entryId = readString(item, 'entryId');
  if (!entryId.ok) {
    return entryId;
  }
  if (!isUlid(entryId.value)) {
    return decodeOutOfRange('entryId');
  }

  const title = readString(item, 'title');
  if (!title.ok) {
    return title;
  }
  if (!isWithinCodePoints(title.value, TITLE_MIN_CODE_POINTS, TITLE_MAX_CODE_POINTS)) {
    return decodeOutOfRange('title');
  }

  const body = readString(item, 'body');
  if (!body.ok) {
    return body;
  }
  if (!isWithinCodePoints(body.value, BODY_MIN_CODE_POINTS, BODY_MAX_CODE_POINTS)) {
    return decodeOutOfRange('body');
  }

  const sessionDate = readString(item, 'sessionDate');
  if (!sessionDate.ok) {
    return sessionDate;
  }
  if (!SESSION_DATE_PATTERN.test(sessionDate.value) || !isRealCalendarDate(sessionDate.value)) {
    return decodeOutOfRange('sessionDate');
  }

  const storedStatus = readString(item, 'status');
  if (!storedStatus.ok) {
    return storedStatus;
  }
  if (storedStatus.value !== 'draft' && storedStatus.value !== 'published') {
    return decodeOutOfRange('status');
  }
  const status: EntryStatus = storedStatus.value;

  const createdAt = readString(item, 'createdAt');
  if (!createdAt.ok) {
    return createdAt;
  }
  if (!isCanonicalInstant(createdAt.value)) {
    return decodeOutOfRange('createdAt');
  }

  const updatedAt = readString(item, 'updatedAt');
  if (!updatedAt.ok) {
    return updatedAt;
  }
  if (!isCanonicalInstant(updatedAt.value)) {
    return decodeOutOfRange('updatedAt');
  }

  const sessionId = readString(item, 'sessionId');
  if (!sessionId.ok) {
    return sessionId;
  }
  if (!isUlid(sessionId.value)) {
    return decodeOutOfRange('sessionId');
  }

  const generationFailed = readBoolean(item, 'generationFailed');
  if (!generationFailed.ok) {
    return generationFailed;
  }

  const expectedKey = entryKey(entryId.value);

  const partitionKey = readString(item, 'PK');
  if (!partitionKey.ok) {
    return partitionKey;
  }
  if (partitionKey.value !== expectedKey.PK) {
    return decodeOutOfRange('PK');
  }

  const sortKey = readString(item, 'SK');
  if (!sortKey.ok) {
    return sortKey;
  }
  if (sortKey.value !== expectedKey.SK) {
    return decodeOutOfRange('SK');
  }

  const indexPartitionKey = readString(item, 'GSI1PK');
  if (!indexPartitionKey.ok) {
    return indexPartitionKey;
  }
  if (indexPartitionKey.value !== timelinePartition(status)) {
    return decodeOutOfRange('GSI1PK');
  }

  return {
    ok: true,
    entry: {
      entryId: entryId.value,
      title: title.value,
      body: body.value,
      sessionDate: sessionDate.value,
      status,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
      sessionId: sessionId.value,
      generationFailed: generationFailed.value,
      schemaVersion: SCHEMA_VERSION,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// UTF-8 primitives
// ---------------------------------------------------------------------------------------------

/**
 * The number of bytes `text` occupies when encoded as UTF-8.
 *
 * Both `encodedSizeBytes` and the canonical encoding are defined in *bytes*, and JavaScript strings
 * are UTF-16, so nothing in this module may use `String#length`. The count is computed from code
 * points rather than by encoding into a buffer, so a 20000-code-point body costs no allocation on
 * the request path.
 *
 * An unpaired surrogate is counted as 3 bytes, which is what `TextEncoder` produces for it: the
 * encoder substitutes U+FFFD REPLACEMENT CHARACTER, itself 3 bytes. The count therefore agrees with
 * {@link canonicalBytes} byte for byte on every string, well-formed or not.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const codePoint of text) {
    // `for…of` yields whole code points, so `codePointAt(0)` is the code point, not a high surrogate.
    const value = codePoint.codePointAt(0) ?? 0;
    if (value < 0x80) {
      bytes += 1;
    } else if (value < 0x800) {
      bytes += 2;
    } else if (value < 0x10000) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// The canonical encoding (Req 8.7)
// ---------------------------------------------------------------------------------------------

/**
 * Serializes any JSON-shaped value to canonical JSON text: object members emitted in ascending key
 * order at *every* level of nesting, no insignificant whitespace, one spelling per value.
 *
 * **Why this is hand-written rather than `JSON.stringify` with a key-sorting replacer.** A replacer
 * that rebuilds each object with its keys inserted in sorted order does not actually control the
 * emitted order: JavaScript's own property order puts array-index-like keys (`"0"`, `"9"`, `"10"`)
 * first and in *numeric* ascending order, whatever order they were inserted in. For keys `"9"` and
 * `"10"` that disagrees with string order, so the bytes would depend on whether an attribute name
 * happens to look like an integer. Emitting the members from an explicitly sorted array is the only
 * way to make the order a property of this function rather than of the engine's object layout.
 *
 * **The sort is locale-independent by construction.** `Array#sort` with no comparator compares
 * stringified elements with the abstract relational comparison, which is a UTF-16 code-unit
 * comparison — the same result on every host, in every locale, under every `Intl` configuration.
 * `localeCompare` is deliberately not used: it is locale-sensitive and would make the bytes depend
 * on the runtime's collation. Code-unit order places astral-plane names (encoded as surrogates,
 * U+D800–U+DFFF) below names in U+E000–U+FFFF, which is not code-point order; that is a harmless
 * difference, since what the determinism obligation needs is one fixed order, not a specific one.
 *
 * **String escaping is spec-pinned.** `JSON.stringify` of a string is
 * `QuoteJSONString`: `"` and `\` are escaped, C0 control characters take their short escape or
 * `\uXXXX`, unpaired surrogates take `\uXXXX`, and every other code point is emitted literally. It
 * is a total function on strings and fixed by the language, so an astral-plane character survives as
 * itself and contributes its 4 UTF-8 bytes rather than an escape sequence.
 *
 * **Total on every input, including inputs `DynamoItem` does not describe.** This module sits behind
 * a JSON boundary, so the fallbacks are reachable in principle and none of them throws:
 * `undefined`, functions, and symbols become `null`; non-finite numbers become `null`, as in JSON;
 * a `bigint`, which `JSON.stringify` throws on, becomes its decimal string; and a value that
 * encloses itself becomes `null` at the point the cycle closes, detected against the chain of
 * enclosing objects rather than a global visited set, so a value legitimately repeated in two
 * sibling positions still serializes both times.
 *
 * A member whose value is `undefined` is emitted as `null` rather than dropped, unlike
 * `JSON.stringify`. Dropping it would make an item carrying an explicit `undefined` attribute
 * indistinguishable from one missing that attribute; keeping it makes the attribute *name set*
 * visible in the bytes.
 *
 * @param ancestors the objects enclosing `value`, innermost last. Callers start with `[]`.
 */
function canonicalJson(value: unknown, ancestors: readonly object[]): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (typeof value !== 'object' || value === null) {
    return 'null';
  }
  if (ancestors.includes(value)) {
    return 'null';
  }

  const enclosing: readonly object[] = [...ancestors, value];

  if (Array.isArray(value)) {
    // Array order is data, not layout, so it is preserved rather than sorted.
    const elements = (value as unknown[]).map((element) => canonicalJson(element, enclosing));
    return `[${elements.join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], enclosing)}`);
  return `{${members.join(',')}}`;
}

/** One encoder for the module: `TextEncoder` is stateless and always emits UTF-8. */
const UTF8 = new TextEncoder();

/**
 * The canonical byte sequence of a marshalled item — the artifact the determinism obligation of
 * Req 8.7 is stated over.
 *
 * The requirement says two field-equal Entries must encode "identical byte for byte", but the
 * DynamoDB wire form of an attribute map has no single normative byte sequence: attribute order is
 * not part of the map's identity, and the client is free to serialize it however it likes. So this
 * function *is* the definition of byte equality for this codebase: the item as UTF-8 JSON with
 * attribute names sorted recursively and no insignificant whitespace.
 *
 * Two items with equal contents therefore produce equal bytes regardless of the order their
 * attributes were assigned in, on every invocation and independently of invocation order — the
 * function reads nothing but its argument and holds no state between calls. Combined with `encode`'s
 * normalization, that is Req 8.7.
 *
 * Never throws, for any input. See {@link canonicalJson} for how out-of-contract shapes are handled.
 * The result is a fresh `Uint8Array` on every call, so a caller may retain or mutate it freely.
 */
export function canonicalBytes(item: DynamoItem): Uint8Array {
  return UTF8.encode(canonicalJson(item, []));
}

// ---------------------------------------------------------------------------------------------
// Item size accounting (Req 8.8)
// ---------------------------------------------------------------------------------------------

/**
 * The number of significant digits DynamoDB would count in an `N` value.
 *
 * DynamoDB normalizes numbers before storing them — leading and trailing zeroes are trimmed, and up
 * to 38 significant digits are retained — so `100`, `1E2`, and `1.00E2` are the same stored number
 * with one significant digit, and `0.00012` has two. The digits are taken from the mantissa only;
 * the sign, the decimal point, and the exponent carry no significant digits.
 *
 * Zero, and any spelling of it, counts as one digit: a stored number is never zero bytes wide. A
 * value that is not a number at all — which the `N` type cannot exclude, because a stored item is
 * unverified JSON — also counts as one, so this stays total instead of returning `NaN` and poisoning
 * the sum.
 */
function significantDigitCount(numeric: string): number {
  const mantissa = numeric.split(/[eE]/)[0] ?? '';
  const digits = mantissa.replace(/\D/g, '').replace(/^0+/, '').replace(/0+$/, '');
  return digits.length === 0 ? 1 : digits.length;
}

/**
 * The bytes DynamoDB attributes to one attribute *value*, excluding its name.
 *
 * The three cases are the three members of `DynamoAttributeValue`. The final fallback exists because
 * a stored item arrives as JSON that nothing has verified: it sizes an unrecognized shape by the
 * UTF-8 length of its canonical JSON text, which is *at least* what DynamoDB would charge for any
 * scalar it could have been — a quoted string is longer than its raw bytes, `true` is 4 bytes
 * against a boolean's 1 — so the estimate errs high and the Req 8.8 gate can only reject early,
 * never admit an item the service would refuse.
 */
function attributeValueBytes(value: unknown): number {
  if (typeof value === 'object' && value !== null) {
    if ('S' in value && typeof value.S === 'string') {
      return utf8ByteLength(value.S);
    }
    if ('N' in value && typeof value.N === 'string') {
      return Math.ceil(significantDigitCount(value.N) / 2) + 1;
    }
    if ('BOOL' in value && typeof value.BOOL === 'boolean') {
      return 1;
    }
  }
  return utf8ByteLength(canonicalJson(value, []));
}

/**
 * The size DynamoDB itself attributes to a marshalled item, in bytes.
 *
 * **The rule.** Per the DynamoDB Developer Guide, *Item sizes and formats*: an item's size is the
 * sum of the lengths of its attribute names and values. Per attribute, with `name` counted as its
 * UTF-8 byte length in every case:
 *
 * | Type | Value bytes |
 * | --- | --- |
 * | `S` | UTF-8 byte length of the string |
 * | `N` | `ceil(significant digits / 2) + 1` |
 * | `BOOL` | 1 |
 *
 * So the `schemaVersion` attribute of an Entry item — name `schemaVersion`, value `1` — is
 * 13 + 1 + 1 = 15 bytes, and `generationFailed: false` is 16 + 1 = 17 bytes.
 *
 * **Where this is approximate.** The guide's own wording for numbers is *approximately*
 * `(1 byte per two significant digits) + (1 byte)`; the exact internal encoding is unpublished. This
 * module implements the documented formula literally, which is the only rule available to implement,
 * and the imprecision is bounded by a byte or two per number. Every Entry item carries exactly one
 * number, the literal `schemaVersion`, so for the items this System writes the error is at most a
 * byte — nowhere near the 8 KiB of headroom the 384 KiB ceiling leaves under the service's 400 KB
 * limit. Two things are deliberately *not* included: the 100 bytes of per-item storage overhead the
 * guide describes, which is a storage-billing figure rather than part of the item-size limit, and
 * list, map, set, and binary accounting, because no item shape in the design uses those types.
 *
 * **Where the 384 KiB decision lives.** Not here. This function is the primitive; the ceiling is
 * `MAX_ENTRY_ITEM_BYTES` (393216) in `./entry-repository-port`, and the rejection is the
 * repository's `putEntry`, which returns `ITEM_TOO_LARGE` *before* issuing any service call so that
 * an oversized write never reaches the Entry_Store and the Devlog_API can name the storage size
 * limit in a 400 (Req 8.8). Keeping the comparison out of this module is what lets `encodedSizeBytes`
 * stay a pure measurement with no policy in it.
 *
 * Never throws, for any input, and never returns `NaN`: the sum is over `Object.keys`, and every
 * per-attribute term is finite by construction.
 */
export function encodedSizeBytes(item: DynamoItem): number {
  if (typeof item !== 'object' || item === null) {
    return 0;
  }

  let total = 0;
  for (const name of Object.keys(item)) {
    total += utf8ByteLength(name) + attributeValueBytes(item[name]);
  }
  return total;
}
