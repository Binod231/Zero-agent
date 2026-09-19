/**
 * The Entry_Store repository contract.
 *
 * This module is **interface only**: no DynamoDB client, no AWS SDK import, no I/O. It exists so
 * that the in-memory fake used by the property tests and the real single-table repository
 * (`src/core/entry-repository.ts`, task 9.2) are the same type, and so a handler can be constructed
 * with either without knowing which it holds.
 *
 * Shapes here are transcribed from the design's *Item types*, *Access patterns*, and Entry_Store
 * *Write semantics* sections. Three conventions hold:
 *
 * - **Errors are values.** Every operation returns a `RepositoryResult`, never throws for a
 *   condition the design gives a behaviour for. A thrown error from an implementation means a
 *   programming fault, which the Devlog_API's single sanitizing boundary turns into a 500.
 * - **Conditions are key-scoped.** Every conditional operation names exactly one item, and its
 *   condition reads only that item. Nothing in this contract can express a cross-item condition,
 *   which is what keeps the "leaves the Entry_Store unchanged" clauses structural.
 * - **Queries return the GSI1 projection.** `queryTimeline` and `queryByStatus` yield
 *   `EntrySummary`, which is exactly the index's `INCLUDE` list. Neither can return a `body`, and
 *   neither can return `status`, because the queried partition already determines it.
 */

import type {
  DecodeError,
  Entry,
  EntryPatch,
  EntryStatus,
  EntrySummary,
  SessionStatus,
} from './types';

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** The table's primary key. Every item type in the design is addressed by exactly this pair. */
export interface ItemKey {
  PK: string;
  SK: string;
}

/** `ENTRY#<entryId>` / `META` — access patterns 1, 11, 12. */
export function entryKey(entryId: string): ItemKey {
  return { PK: `ENTRY#${entryId}`, SK: 'META' };
}

/** `SESSION#<sessionId>` / `META` — access pattern 6. */
export function sessionKey(sessionId: string): ItemKey {
  return { PK: `SESSION#${sessionId}`, SK: 'META' };
}

/** `AUTHSESSION#<jti>` / `STATE` — the revocation record, access pattern 7. */
export function authSessionKey(jti: string): ItemKey {
  return { PK: `AUTHSESSION#${jti}`, SK: 'STATE' };
}

/**
 * `AUTHFAIL#<sha256(ip)>` / `WINDOW` — the sign-in failure window, access pattern 8.
 *
 * The address arrives already hashed: hashing is the caller's concern, so this module stays free of
 * `node:crypto` and of any decision about how an address is derived from a request.
 */
export function authFailureKey(hashedClientAddress: string): ItemKey {
  return { PK: `AUTHFAIL#${hashedClientAddress}`, SK: 'WINDOW' };
}

/** `RATE#<authorSub>` / `H#<YYYY-MM-DDTHH>` — the rolling-hour submission counter, pattern 9. */
export function hourlyQuotaKey(authorSub: string, hourBucket: string): ItemKey {
  return { PK: `RATE#${authorSub}`, SK: `H#${hourBucket}` };
}

/** `RATE#<authorSub>` / `D#<YYYY-MM-DD>` — the rolling-day submission counter, pattern 9. */
export function dailyQuotaKey(authorSub: string, dayBucket: string): ItemKey {
  return { PK: `RATE#${authorSub}`, SK: `D#${dayBucket}` };
}

/** `IPB#<sha256(ip)>` / `BUCKET` — the per-address token bucket, access pattern 10. */
export function ipBucketKey(hashedClientAddress: string): ItemKey {
  return { PK: `IPB#${hashedClientAddress}`, SK: 'BUCKET' };
}

/** The GSI1 partition an Entry of the given status lives in. */
export function timelinePartition(status: EntryStatus): string {
  return status === 'published' ? 'TL#PUB' : 'TL#DRAFT';
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

/**
 * Derived from `SessionStatus` rather than restated, so the console's polling view and the stored
 * item can never drift apart.
 */
export type GenerationState = SessionStatus['generationState'];

/**
 * The stored SESSION item (design: *Session_Input item shape*). It is a superset of the console's
 * `SessionStatus`: `submittedAt` and `correlationId` are persisted but never returned to the
 * Author, and `noteText` and `commitLog` are held verbatim (Req 3.6).
 */
export interface SessionRecord {
  sessionId: string;
  entryId: string;
  /** Verbatim: untrimmed, newlines and Unicode unnormalized. */
  noteText: string;
  /** Verbatim, `''` when none was submitted, retained even when parsing it failed. */
  commitLog: string;
  sessionDate: string;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  submittedAt: string;
  generationState: GenerationState;
  correlationId: string;
  schemaVersion: 1;
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/** The operation names of this contract. Used for failure attribution in logs and in test doubles. */
export type RepositoryOperation =
  | 'getEntry'
  | 'queryTimeline'
  | 'queryByStatus'
  | 'putEntry'
  | 'updateEntryStatus'
  | 'patchEntry'
  | 'deleteDraft'
  | 'getSession'
  | 'putSession'
  | 'updateSessionState';

/**
 * Why a repository operation did not complete.
 *
 * No variant carries an attribute *value*, a key, or any submitted content, so a `RepositoryError`
 * is safe to put in a log record or to classify into a status code (Req 11.2, 11.3).
 *
 * - `CONDITION_FAILED` is DynamoDB's conditional-check failure. It covers both "the item is absent"
 *   and "the item's status is not the expected one", exactly as the service does; a caller that
 *   needs to tell 404 from 409 reads the item first, which every such path already does.
 * - `ITEM_TOO_LARGE` is raised **before** any service call, so an oversized write never reaches the
 *   Entry_Store (Req 8.8).
 * - `MALFORMED_ITEM` is a stored item the Entry_Serializer could not decode: unavailable on the
 *   public path (Req 1.8), logged with the attribute name and never its value.
 */
export type RepositoryError =
  | { kind: 'CONDITION_FAILED'; operation: RepositoryOperation }
  | {
      kind: 'ITEM_TOO_LARGE';
      operation: RepositoryOperation;
      sizeBytes: number;
      limitBytes: number;
    }
  | { kind: 'THROTTLED'; operation: RepositoryOperation }
  | { kind: 'UNAVAILABLE'; operation: RepositoryOperation }
  | { kind: 'MALFORMED_ITEM'; operation: RepositoryOperation; error: DecodeError };

export type RepositoryResult<T> = { ok: true; value: T } | { ok: false; error: RepositoryError };

/**
 * The application's own item-size ceiling, 384 KiB, below DynamoDB's 400 KB limit so a rejection is
 * always this System's decision with a clear message rather than a service error (Req 8.8).
 */
export const MAX_ENTRY_ITEM_BYTES = 393216;

// ---------------------------------------------------------------------------------------------
// Operation inputs
// ---------------------------------------------------------------------------------------------

/**
 * `ifAbsent` adds `attribute_not_exists(PK)`, which is the ULID-collision guard on first creation.
 * The Entry_Generator's own write omits it: its key was allocated at submission time, so a
 * duplicate asynchronous delivery must overwrite rather than fail (Req 8.5).
 */
export interface PutEntryOptions {
  ifAbsent: boolean;
}

/** A descending GSI1 scan of `TL#PUB`. The public path cannot name a status, so it cannot ask for drafts. */
export interface TimelineQuery {
  /** DynamoDB `Limit`; a positive integer. Pagination over-fetches `n * 20 + 1` and discards. */
  limit: number;
}

/** A descending GSI1 scan of `TL#PUB` or `TL#DRAFT` for the Author's listings (Req 6.6). */
export interface StatusQuery {
  status: EntryStatus;
  /** DynamoDB `Limit`; omitted means the whole partition. */
  limit?: number;
}

/** A status transition conditioned on the current status, which is what makes a doubled publish 409. */
export interface StatusTransition {
  entryId: string;
  expected: EntryStatus;
  next: EntryStatus;
  /** The acceptance-time instant to record as `updatedAt`. */
  updatedAt: string;
}

/** A partial content replacement. `sessionDate` and `createdAt` are not reachable from here. */
export interface PatchEntryInput {
  entryId: string;
  patch: EntryPatch;
  /** The acceptance-time instant to record as `updatedAt` (Req 6.2). */
  updatedAt: string;
}

/** A SESSION item generation-state transition, conditioned on the item existing. */
export interface SessionStateTransition {
  sessionId: string;
  next: GenerationState;
}

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

/**
 * Every Entry_Store access in the System goes through one of these ten operations. There is no
 * scan, no batch, and no transaction: each operation touches exactly one item, or reads one GSI1
 * partition, which is what gives Req 8.5 and Req 8.9 from the service contract with no
 * application-level locking.
 */
export interface EntryRepository {
  /** Access pattern 1. `null` when no item carries that identifier. */
  getEntry(entryId: string): Promise<RepositoryResult<Entry | null>>;

  /** Access patterns 2 and 5: `TL#PUB`, descending, limited. */
  queryTimeline(query: TimelineQuery): Promise<RepositoryResult<EntrySummary[]>>;

  /** Access patterns 3 and 4: `TL#PUB` or `TL#DRAFT`, descending. */
  queryByStatus(query: StatusQuery): Promise<RepositoryResult<EntrySummary[]>>;

  /** A single-item `PutItem`: indivisible, and last-write-wins on repetition (Req 8.5, 8.9). */
  putEntry(entry: Entry, options?: PutEntryOptions): Promise<RepositoryResult<void>>;

  /** Access pattern 11: `UpdateItem` with `condition: status = expected` (Req 6.3, 6.4, 6.8). */
  updateEntryStatus(transition: StatusTransition): Promise<RepositoryResult<void>>;

  /** Content edit; returns the stored Entry as it now stands (Req 6.2, 6.7). */
  patchEntry(input: PatchEntryInput): Promise<RepositoryResult<Entry>>;

  /** Access pattern 12: `DeleteItem` with `condition: status = draft` (Req 6.9). */
  deleteDraft(entryId: string): Promise<RepositoryResult<void>>;

  /** Access pattern 6. `null` when no item carries that identifier. */
  getSession(sessionId: string): Promise<RepositoryResult<SessionRecord | null>>;

  /** A single-item `PutItem` of the SESSION item at submission time. */
  putSession(record: SessionRecord): Promise<RepositoryResult<void>>;

  /** `UpdateItem` moving `generationState`, conditioned on the SESSION item existing. */
  updateSessionState(transition: SessionStateTransition): Promise<RepositoryResult<void>>;
}
