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
// The GSI1SK seam — TEMPORARY, owned by task 6.1
// ---------------------------------------------------------------------------------------------

/**
 * How the `GSI1SK` ordering key is produced. `encode` takes it as an injectable parameter so that
 * this module never owns the ordering rule: **Entry_Ordering** (`./entry-ordering`, task 6.1) is the
 * single home of `buildOrderingKey`, `invert`, and `compareEntries`.
 *
 * The builder is handed the *normalized* Entry, so the key is always built from the canonical
 * `sessionDate` and `createdAt` that are written to the item, never from the caller's spelling.
 *
 * A builder must be total over Entries that passed `encode`'s validation — `entryId` is a 26-
 * character ULID, `sessionDate` is 10 characters, `createdAt` is 24 — which is what lets `encode`
 * keep its own never-throws guarantee.
 */
export type OrderingKeyBuilder = (entry: Entry) => string;

/**
 * TEMPORARY — task 6.1 replaces this.
 *
 * The design's ordering key is `<sessionDate>#<createdAt>#<invert(entryId)>`, all three components
 * fixed-length, with the identifier complemented over the Crockford alphabet so that a single
 * descending GSI1 scan yields ascending identifiers on the third level of the Req 7.2 order.
 *
 * It lives here only because task 5.1 landed before task 6.1 and `encode` has to write *something*
 * correct into `GSI1SK`. When `src/core/entry-ordering.ts` exists, task 6.1 must:
 *
 * 1. delete `CROCKFORD_ALPHABET`, `invertEntryId`, and this constant from this file, and
 * 2. make it `import { buildOrderingKey } from './entry-ordering'` and use that as the default
 *    parameter value of {@link encode}.
 *
 * If `buildOrderingKey` takes an `EntrySummary` it satisfies {@link OrderingKeyBuilder} as-is, since
 * an `Entry` carries every `EntrySummary` field; if it takes the three components separately, wrap
 * it in one arrow. Nothing else in this module moves, because `decode` deliberately does not read
 * `GSI1SK`.
 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** TEMPORARY — see {@link TEMPORARY_ORDERING_KEY_BUILDER}. */
function invertEntryId(entryId: string): string {
  let inverted = '';
  for (const character of entryId) {
    const index = CROCKFORD_ALPHABET.indexOf(character);
    // `entryId` passed `ULID_PATTERN`, so every character is in the alphabet and the complement
    // index is in bounds. The fallback exists only because the index type is `string | undefined`.
    inverted += CROCKFORD_ALPHABET[CROCKFORD_ALPHABET.length - 1 - index] ?? character;
  }
  return inverted;
}

/** TEMPORARY — see the note on {@link CROCKFORD_ALPHABET}. Task 6.1 deletes this. */
const TEMPORARY_ORDERING_KEY_BUILDER: OrderingKeyBuilder = (entry) =>
  `${entry.sessionDate}#${entry.createdAt}#${invertEntryId(entry.entryId)}`;

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
 * @param buildOrderingKey how to derive `GSI1SK`. See {@link OrderingKeyBuilder}; the default is
 * temporary and belongs to task 6.1.
 */
export function encode(
  entry: Entry,
  buildOrderingKey: OrderingKeyBuilder = TEMPORARY_ORDERING_KEY_BUILDER,
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
