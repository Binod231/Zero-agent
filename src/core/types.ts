/**
 * Shared domain types for the pure core.
 *
 * Every shape here is transcribed from the design's *Components and Interfaces* and *Data Models*
 * sections. Modules in `src/core`, the three Lambda handlers, and the Author_Console all import
 * from this one file so that a single definition backs both sides of every round trip.
 *
 * Two conventions hold throughout:
 *
 * - **Errors are values.** Operations that can fail on ordinary input return a discriminated union
 *   with an `ok` tag rather than throwing, so a `switch` narrows exhaustively and the totality
 *   properties (Req 4.10, 8.2) are mechanically checkable.
 * - **Lengths are code points.** Every bound stated in characters is a Unicode code point count,
 *   never a UTF-16 code unit count. See `./code-points` (Req 8.4).
 */

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/**
 * The response shape every renderer and route handler returns. Deliberately plain data so a
 * handler can be exercised without an API Gateway event envelope.
 */
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------------------------
// Commit_Log_Parser / Commit_Log_Printer (Req 4)
// ---------------------------------------------------------------------------------------------

/**
 * One parsed commit. `authorDate` is retained as opaque text and never reinterpreted as a date:
 * git's default date format varies with locale and configuration, and Commit_Records feed the
 * model and nothing else.
 */
export interface CommitRecord {
  /** 7-40 hex digits, case preserved. */
  hash: string;
  /** Trimmed, Unicode preserved code point for code point. */
  authorName: string;
  /** Trimmed, retained as text. */
  authorDate: string;
  /** First body line minus the 4-space indent, or `''` when the commit has no body lines. */
  subject: string;
}

/** Why a Commit_Log could not be parsed. `line` is **1-based** (Req 4.4). */
export type ParseError =
  | { kind: 'MALFORMED'; line: number; expected: string }
  | { kind: 'TOO_MANY_COMMITS'; line: number; limit: 500 };

/** Total over every input string: `parseCommitLog` never throws (Req 4.10). */
export type ParseResult = { ok: true; records: CommitRecord[] } | { ok: false; error: ParseError };

/**
 * Why a Commit_Record list could not be printed. The printer is deliberately partial, which is why
 * the round trip of Req 4.6 is scoped to lists it prints without error. `index` is the 0-based
 * position of the offending record in the supplied list.
 */
export type PrintError =
  | { kind: 'INVALID_HASH'; index: number }
  | { kind: 'INVALID_NAME'; index: number }
  | { kind: 'INVALID_DATE'; index: number }
  | { kind: 'INVALID_SUBJECT'; index: number }
  | { kind: 'TOO_MANY_COMMITS'; limit: 500 };

export type PrintResult = { ok: true; text: string } | { ok: false; error: PrintError };

// ---------------------------------------------------------------------------------------------
// Entry (Req 6, 7, 8)
// ---------------------------------------------------------------------------------------------

export type EntryStatus = 'draft' | 'published';

/**
 * A single devlog record. Every field is always present: the Entry_Serializer writes no optional
 * attributes, because absent keys would make two field-equal Entries encode differently depending
 * on which code path produced them and so break the determinism obligation of Req 8.7.
 */
export interface Entry {
  /** ULID, 26 characters of Crockford base32. */
  entryId: string;
  /** 1-120 code points. */
  title: string;
  /** Markdown, 1-20000 code points. */
  body: string;
  /** `YYYY-MM-DD`, a real calendar date. */
  sessionDate: string;
  status: EntryStatus;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`, 24 characters, UTC. */
  createdAt: string;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`, 24 characters, UTC. */
  updatedAt: string;
  /** ULID of the Session_Input this Entry was generated from. */
  sessionId: string;
  /** True when the Entry_Generator fell back to the raw note text (Req 5.4). */
  generationFailed: boolean;
  schemaVersion: 1;
}

/**
 * The listing projection: exactly the attributes GSI1 (`status-order-index`) projects with
 * `INCLUDE`, which is what a timeline or draft-list query can read without a second lookup.
 *
 * `body` is deliberately absent, so a timeline query reads kilobytes rather than megabytes.
 * `status` is absent too — it is not in the projection because it is implied by the queried
 * partition (`TL#PUB` or `TL#DRAFT`), so the caller already knows it. `compareEntries` needs only
 * `sessionDate`, `createdAt`, and `entryId`, all of which are here.
 */
export interface EntrySummary {
  entryId: string;
  title: string;
  sessionDate: string;
  createdAt: string;
  updatedAt: string;
  generationFailed: boolean;
}

/**
 * A partial replacement of Entry content (Req 6.2, 6.7). `sessionDate` and `createdAt` are absent
 * by design: an edit never moves an Entry in the timeline. An omitted key means "leave unchanged",
 * which under `exactOptionalPropertyTypes` is expressed by omission and cannot be spelled as an
 * explicit `undefined`.
 */
export interface EntryPatch {
  /** Replacement title, 1-120 code points. */
  title?: string;
  /** Replacement body, 1-20000 code points. */
  body?: string;
}

// ---------------------------------------------------------------------------------------------
// Entry_Serializer (Req 8)
// ---------------------------------------------------------------------------------------------

/**
 * The subset of the DynamoDB attribute-value union every item type in the design uses: strings,
 * numbers carried as strings on the wire, and booleans. No list, map, set, or binary attribute
 * appears in any item shape, so admitting them would only weaken the exhaustiveness of a `switch`
 * over an attribute.
 */
export type DynamoAttributeValue = { S: string } | { N: string } | { BOOL: boolean };

/** A marshalled item: DynamoDB's low-level attribute map. */
export type DynamoItem = Record<string, DynamoAttributeValue>;

/**
 * Why an Entry could not be encoded. Encoding normalizes (`sessionDate` to `YYYY-MM-DD`,
 * timestamps to the 24-character UTC instant), so a failure means a value no normalization can
 * rescue. Both variants name the offending attribute and never its value, so an error is safe to
 * log (Req 11.2, 11.3).
 */
export type EncodeError =
  { kind: 'INVALID_ATTRIBUTE'; attribute: string } | { kind: 'OUT_OF_RANGE'; attribute: string };

export type EncodeResult = { ok: true; item: DynamoItem } | { ok: false; error: EncodeError };

/**
 * Why a stored item could not be decoded. `decode` never throws and never returns a partially
 * populated Entry: every anomaly is one of these, which the Public_Site treats as "this entry is
 * unavailable" (Req 1.8).
 */
export type DecodeError =
  | { kind: 'MISSING_ATTRIBUTE'; attribute: string }
  | { kind: 'WRONG_TYPE'; attribute: string }
  | { kind: 'OUT_OF_RANGE'; attribute: string }
  | { kind: 'UNKNOWN_SCHEMA'; version: number };

export type DecodeResult = { ok: true; entry: Entry } | { ok: false; error: DecodeError };

// ---------------------------------------------------------------------------------------------
// Session_Input (Req 3)
// ---------------------------------------------------------------------------------------------

/**
 * The submitted body of `POST /api/author/sessions`. `commitLog` and `sessionDate` are genuinely
 * absent-or-present in the JSON the console sends, so they are optional keys rather than
 * `string | undefined` values: under `exactOptionalPropertyTypes` that distinction is what lets
 * the validator branch on presence without treating a present-but-undefined key as supplied.
 */
export interface SessionInputPayload {
  noteText: string;
  commitLog?: string;
  sessionDate?: string;
}

/** The 202 response body. The Entry identifier is allocated before the Entry exists (Req 3.1). */
export interface SubmitAccepted {
  entryId: string;
  sessionId: string;
}

/**
 * The console's generation-polling view of a SESSION item. `noteText` and `commitLog` come back
 * verbatim — untrimmed, with newlines and Unicode unnormalized (Req 3.6). `commitLog` is a
 * required string rather than an optional one because the SESSION item always carries the
 * attribute, holding `''` when the Author submitted no Commit_Log, and holding the submitted text
 * even when parsing it failed.
 */
export interface SessionStatus {
  sessionId: string;
  entryId: string;
  generationState: 'pending' | 'generated' | 'failed';
  noteText: string;
  commitLog: string;
  sessionDate: string;
}
