import type { Entry, EntryStatus, EntrySummary, DecodeError } from '../../src/core/types';
import type {
  EntryRepository,
  PatchEntryInput,
  PutEntryOptions,
  RepositoryError,
  RepositoryOperation,
  RepositoryResult,
  SessionRecord,
  SessionStateTransition,
  StatusQuery,
  StatusTransition,
  TimelineQuery,
} from '../../src/core/entry-repository-port';
import { MAX_ENTRY_ITEM_BYTES, entryKey, sessionKey } from '../../src/core/entry-repository-port';

/**
 * The in-memory Entry_Store.
 *
 * This is not a `Map` with a repository-shaped facade. It reproduces the four service behaviours the
 * correctness properties actually lean on, and it is worth being explicit about which:
 *
 * 1. **Single-item writes are indivisible** (Req 8.9, Property 7). Each key holds one frozen snapshot
 *    and a write swaps the reference in a single statement. A reader therefore observes the complete
 *    field set of exactly one write, never a mixture. The snapshot is frozen, so a caller that tries
 *    to mutate a value it read throws instead of silently corrupting the store — which is how the
 *    fake catches the aliasing bug a plain `Map` would hide.
 * 2. **Repeated writes leave exactly one item holding the last completed write** (Req 8.5,
 *    Property 7). Key derivation is `ENTRY#<entryId>`, so two writes of one identifier cannot produce
 *    two items no matter what else differs between them.
 * 3. **Conditions are evaluated, not assumed** (Req 6.8, 6.9, Properties 19 and 20). Each conditional
 *    operation reads the single item at its own key and fails with `CONDITION_FAILED` when the
 *    condition does not hold — which is what makes a doubled publish a 409 and a delete of a published
 *    Entry a rejection. Nothing in the contract can express a condition over another key, so the fake
 *    cannot accidentally be more permissive than the real table.
 * 4. **Queries are a descending GSI1 scan with a limit** (Properties 9, 10, 19). Items are ordered by
 *    the design's `GSI1SK` ordering key, scanned downwards, and truncated by `Limit`, and the result
 *    carries the index's narrow `INCLUDE` projection — an `EntrySummary`, so no query can return a
 *    `body` or a `status`.
 *
 * Every operation yields to the microtask queue before it applies, so interleaved `await`ed writes
 * genuinely interleave: the fake is not accidentally atomic just because nothing suspends.
 *
 * **What it deliberately does not do.** It stores domain Entries rather than marshalled
 * `DynamoItem`s. Encoding is the Entry_Serializer's contract and Properties 5 and 6 cover it; folding
 * it in here would make a store property fail for a serializer bug and vice versa. Consequently the
 * size accounting and the ordering key are injected: pass the real `encodedSizeBytes ∘ encode` and the
 * real `buildOrderingKey` once tasks 5.2 and 6.1 land, and the fake's accept/reject decision and scan
 * order are the production ones by construction. The defaults below exist so the fake is usable
 * before those tasks and are documented as approximations, not as second implementations.
 */

const UTF8 = new TextEncoder();

/** Crockford base32, the ULID alphabet (design: *Ordering key and the total order of Req 7.2*). */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface EntryStoreFakeOptions {
  /**
   * Byte size of the stored representation of an Entry, used for the Req 8.8 ceiling. Defaults to the
   * approximation below; Property 8 injects `encodedSizeBytes(encode(entry).item)`.
   */
  measureEntryBytes?: (entry: Entry) => number;
  /** The ceiling itself, defaulting to `MAX_ENTRY_ITEM_BYTES`. Lower it to test the boundary cheaply. */
  maxItemBytes?: number;
  /** The `GSI1SK` builder. Defaults to the design's formula; Properties 9 and 10 inject the real one. */
  orderingKeyOf?: (entry: Entry) => string;
}

/** A failure to inject. `MALFORMED_ITEM` also needs the `DecodeError` the serializer would return. */
export type InjectedFailureKind = 'THROTTLED' | 'UNAVAILABLE' | 'MALFORMED_ITEM';

export interface FailureInjection {
  kind: InjectedFailureKind;
  /** Which operations it applies to. Omitted means every operation. */
  operations?: readonly RepositoryOperation[];
  /** How many matching operations it affects. Omitted means 1; use `Infinity` to make it permanent. */
  times?: number;
  /** Only for `MALFORMED_ITEM`; defaults to a `WRONG_TYPE` on `body`. */
  decodeError?: DecodeError;
}

/** A deep copy of everything stored, for the "Entry_Store unchanged" assertions. */
export interface StoreSnapshot {
  /** Sorted by `entryId`, so two snapshots are directly deep-equal. */
  entries: Entry[];
  /** Sorted by `sessionId`. */
  sessions: SessionRecord[];
}

interface PendingFailure {
  kind: InjectedFailureKind;
  operations: readonly RepositoryOperation[] | undefined;
  remaining: number;
  decodeError: DecodeError | undefined;
}

/**
 * The design's `invert`: maps the ULID alphabet onto itself in reverse so a descending scan over the
 * complement yields ascending identifiers. A character outside the alphabet is passed through
 * unchanged rather than throwing, which keeps the default total over any generated identifier.
 */
function invertUlid(entryId: string): string {
  let inverted = '';
  for (const character of entryId) {
    const index = ULID_ALPHABET.indexOf(character);
    inverted += index === -1 ? character : (ULID_ALPHABET[31 - index] ?? character);
  }
  return inverted;
}

function defaultOrderingKeyOf(entry: Entry): string {
  return `${entry.sessionDate}#${entry.createdAt}#${invertUlid(entry.entryId)}`;
}

/**
 * An approximation of DynamoDB's accounting — summed UTF-8 byte lengths of attribute names and
 * values — over the attribute set the design's *Entry item shape* declares. It is close enough to
 * make the boundary testable and is superseded by the serializer's `encodedSizeBytes` wherever the
 * exact figure matters.
 */
function defaultMeasureEntryBytes(entry: Entry, orderingKey: string): number {
  const key = entryKey(entry.entryId);
  const strings: readonly (readonly [string, string])[] = [
    ['PK', key.PK],
    ['SK', key.SK],
    ['GSI1PK', entry.status === 'published' ? 'TL#PUB' : 'TL#DRAFT'],
    ['GSI1SK', orderingKey],
    ['entryId', entry.entryId],
    ['title', entry.title],
    ['body', entry.body],
    ['sessionDate', entry.sessionDate],
    ['status', entry.status],
    ['createdAt', entry.createdAt],
    ['updatedAt', entry.updatedAt],
    ['sessionId', entry.sessionId],
  ];

  let total = 0;
  for (const [name, value] of strings) {
    total += UTF8.encode(name).length + UTF8.encode(value).length;
  }
  // A BOOL costs one byte and the literal `schemaVersion: 1` one digit, plus their names.
  total += UTF8.encode('generationFailed').length + 1;
  total += UTF8.encode('schemaVersion').length + 1;
  return total;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze({ ...value });
}

function summaryOf(entry: Entry): EntrySummary {
  // Exactly GSI1's INCLUDE projection: no `body`, and no `status` because the partition implies it.
  return {
    entryId: entry.entryId,
    title: entry.title,
    sessionDate: entry.sessionDate,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    generationFailed: entry.generationFailed,
  };
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('a query limit must be a positive integer, as DynamoDB requires');
  }
}

/** Descending lexicographic comparison by code unit, which is the order a DynamoDB index scan gives. */
function descendingByKey(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? 1 : -1;
}

export class EntryStoreFake implements EntryRepository {
  readonly #entries = new Map<string, Readonly<Entry>>();
  readonly #sessions = new Map<string, Readonly<SessionRecord>>();
  readonly #calls: RepositoryOperation[] = [];
  readonly #failures: PendingFailure[] = [];
  readonly #measureEntryBytes: ((entry: Entry) => number) | undefined;
  readonly #orderingKeyOf: (entry: Entry) => string;
  readonly #maxItemBytes: number;
  #writeCount = 0;

  constructor(options: EntryStoreFakeOptions = {}) {
    this.#measureEntryBytes = options.measureEntryBytes;
    this.#orderingKeyOf = options.orderingKeyOf ?? defaultOrderingKeyOf;
    this.#maxItemBytes = options.maxItemBytes ?? MAX_ENTRY_ITEM_BYTES;
  }

  // -------------------------------------------------------------------------------------------
  // EntryRepository
  // -------------------------------------------------------------------------------------------

  async getEntry(entryId: string): Promise<RepositoryResult<Entry | null>> {
    const failure = await this.#begin('getEntry');
    if (failure !== undefined) {
      return failure;
    }
    const stored = this.#entries.get(entryKey(entryId).PK);
    return { ok: true, value: stored === undefined ? null : { ...stored } };
  }

  async queryTimeline(query: TimelineQuery): Promise<RepositoryResult<EntrySummary[]>> {
    assertLimit(query.limit);
    const failure = await this.#begin('queryTimeline');
    if (failure !== undefined) {
      return failure;
    }
    return { ok: true, value: this.#scan('published', query.limit) };
  }

  async queryByStatus(query: StatusQuery): Promise<RepositoryResult<EntrySummary[]>> {
    if (query.limit !== undefined) {
      assertLimit(query.limit);
    }
    const failure = await this.#begin('queryByStatus');
    if (failure !== undefined) {
      return failure;
    }
    return { ok: true, value: this.#scan(query.status, query.limit) };
  }

  async putEntry(entry: Entry, options?: PutEntryOptions): Promise<RepositoryResult<void>> {
    // Before the service call, so an oversized write never reaches the Entry_Store (Req 8.8).
    const tooLarge = this.#checkSize(entry, 'putEntry');
    if (tooLarge !== undefined) {
      this.#calls.push('putEntry');
      return tooLarge;
    }

    const failure = await this.#begin('putEntry');
    if (failure !== undefined) {
      return failure;
    }

    const key = entryKey(entry.entryId).PK;
    if (options?.ifAbsent === true && this.#entries.has(key)) {
      return conditionFailed('putEntry');
    }

    this.#entries.set(key, freeze(entry));
    this.#writeCount += 1;
    return { ok: true, value: undefined };
  }

  async updateEntryStatus(transition: StatusTransition): Promise<RepositoryResult<void>> {
    const failure = await this.#begin('updateEntryStatus');
    if (failure !== undefined) {
      return failure;
    }

    const key = entryKey(transition.entryId).PK;
    const current = this.#entries.get(key);
    // `condition: status = <expected>`. A doubled publish fails here and maps to 409 (Req 6.8), and
    // an absent item fails it too, exactly as `UpdateItem` does.
    if (current?.status !== transition.expected) {
      return conditionFailed('updateEntryStatus');
    }

    this.#entries.set(
      key,
      freeze({ ...current, status: transition.next, updatedAt: transition.updatedAt }),
    );
    this.#writeCount += 1;
    return { ok: true, value: undefined };
  }

  async patchEntry(input: PatchEntryInput): Promise<RepositoryResult<Entry>> {
    const failure = await this.#begin('patchEntry');
    if (failure !== undefined) {
      return failure;
    }

    const key = entryKey(input.entryId).PK;
    const current = this.#entries.get(key);
    if (current === undefined) {
      return conditionFailed('patchEntry');
    }

    // `sessionDate` and `createdAt` are not reachable from an EntryPatch, so an edit can never move
    // an Entry in the timeline (Req 6.2, Property 21).
    const next: Entry = {
      ...current,
      ...(input.patch.title === undefined ? {} : { title: input.patch.title }),
      ...(input.patch.body === undefined ? {} : { body: input.patch.body }),
      updatedAt: input.updatedAt,
    };

    const tooLarge = this.#checkSize(next, 'patchEntry');
    if (tooLarge !== undefined) {
      return tooLarge;
    }

    this.#entries.set(key, freeze(next));
    this.#writeCount += 1;
    return { ok: true, value: { ...next } };
  }

  async deleteDraft(entryId: string): Promise<RepositoryResult<void>> {
    const failure = await this.#begin('deleteDraft');
    if (failure !== undefined) {
      return failure;
    }

    const key = entryKey(entryId).PK;
    const current = this.#entries.get(key);
    // `condition: status = draft`, so a delete of a Published_Entry is rejected (Req 6.9).
    if (current?.status !== 'draft') {
      return conditionFailed('deleteDraft');
    }

    this.#entries.delete(key);
    this.#writeCount += 1;
    return { ok: true, value: undefined };
  }

  async getSession(sessionId: string): Promise<RepositoryResult<SessionRecord | null>> {
    const failure = await this.#begin('getSession');
    if (failure !== undefined) {
      return failure;
    }
    const stored = this.#sessions.get(sessionKey(sessionId).PK);
    return { ok: true, value: stored === undefined ? null : { ...stored } };
  }

  async putSession(record: SessionRecord): Promise<RepositoryResult<void>> {
    const failure = await this.#begin('putSession');
    if (failure !== undefined) {
      return failure;
    }
    this.#sessions.set(sessionKey(record.sessionId).PK, freeze(record));
    this.#writeCount += 1;
    return { ok: true, value: undefined };
  }

  async updateSessionState(transition: SessionStateTransition): Promise<RepositoryResult<void>> {
    const failure = await this.#begin('updateSessionState');
    if (failure !== undefined) {
      return failure;
    }

    const key = sessionKey(transition.sessionId).PK;
    const current = this.#sessions.get(key);
    if (current === undefined) {
      return conditionFailed('updateSessionState');
    }

    this.#sessions.set(key, freeze({ ...current, generationState: transition.next }));
    this.#writeCount += 1;
    return { ok: true, value: undefined };
  }

  // -------------------------------------------------------------------------------------------
  // Test surface
  // -------------------------------------------------------------------------------------------

  /**
   * Places items without going through the write path: no condition, no size check, no effect on
   * `writeCount`. This is how a property pre-seeds the other Entries it will later assert are
   * untouched (Property 18, Property 19).
   */
  seedEntries(entries: readonly Entry[]): void {
    for (const entry of entries) {
      this.#entries.set(entryKey(entry.entryId).PK, freeze(entry));
    }
  }

  seedSessions(records: readonly SessionRecord[]): void {
    for (const record of records) {
      this.#sessions.set(sessionKey(record.sessionId).PK, freeze(record));
    }
  }

  /** A deep copy of the whole store with deterministic ordering, for deep-equality assertions. */
  snapshot(): StoreSnapshot {
    const entries = [...this.#entries.values()]
      .map((entry) => ({ ...entry }))
      .sort((left, right) => (left.entryId < right.entryId ? -1 : 1));
    const sessions = [...this.#sessions.values()]
      .map((record) => ({ ...record }))
      .sort((left, right) => (left.sessionId < right.sessionId ? -1 : 1));
    return { entries, sessions };
  }

  /** Completed writes, so "the Entry_Store is unchanged" can be asserted as "nothing was written". */
  get writeCount(): number {
    return this.#writeCount;
  }

  /** Every operation attempted, in order, including the ones that failed. */
  get calls(): readonly RepositoryOperation[] {
    return [...this.#calls];
  }

  /**
   * Forces the store to fail, which is how Property 23 injects an Entry_Store error and Req 1.8's
   * degraded read path is reached without an AWS call.
   */
  injectFailure(injection: FailureInjection): void {
    this.#failures.push({
      kind: injection.kind,
      operations: injection.operations,
      remaining: injection.times ?? 1,
      decodeError: injection.decodeError,
    });
  }

  clearFailures(): void {
    this.#failures.length = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /**
   * Records the call, yields to the microtask queue so interleaved operations really interleave, then
   * applies any injected failure. Returning `undefined` means the operation may proceed.
   */
  async #begin(
    operation: RepositoryOperation,
  ): Promise<{ ok: false; error: RepositoryError } | undefined> {
    this.#calls.push(operation);
    await Promise.resolve();
    return this.#takeFailure(operation);
  }

  #takeFailure(operation: RepositoryOperation): { ok: false; error: RepositoryError } | undefined {
    const index = this.#failures.findIndex(
      (failure) =>
        failure.remaining > 0 &&
        (failure.operations === undefined || failure.operations.includes(operation)),
    );
    const pending = this.#failures[index];
    if (pending === undefined) {
      return undefined;
    }

    pending.remaining -= 1;
    if (pending.remaining <= 0) {
      this.#failures.splice(index, 1);
    }

    switch (pending.kind) {
      case 'THROTTLED':
        return { ok: false, error: { kind: 'THROTTLED', operation } };
      case 'UNAVAILABLE':
        return { ok: false, error: { kind: 'UNAVAILABLE', operation } };
      case 'MALFORMED_ITEM':
        return {
          ok: false,
          error: {
            kind: 'MALFORMED_ITEM',
            operation,
            error: pending.decodeError ?? { kind: 'WRONG_TYPE', attribute: 'body' },
          },
        };
    }
  }

  #checkSize(
    entry: Entry,
    operation: RepositoryOperation,
  ): { ok: false; error: RepositoryError } | undefined {
    const sizeBytes =
      this.#measureEntryBytes?.(entry) ??
      defaultMeasureEntryBytes(entry, this.#orderingKeyOf(entry));
    if (sizeBytes <= this.#maxItemBytes) {
      return undefined;
    }
    return {
      ok: false,
      error: { kind: 'ITEM_TOO_LARGE', operation, sizeBytes, limitBytes: this.#maxItemBytes },
    };
  }

  /** The descending GSI1 partition scan of access patterns 2, 3, 4, and 5. */
  #scan(status: EntryStatus, limit: number | undefined): EntrySummary[] {
    const partition = [...this.#entries.values()]
      .filter((entry) => entry.status === status)
      .map((entry) => ({ orderingKey: this.#orderingKeyOf(entry), summary: summaryOf(entry) }))
      .sort((left, right) => descendingByKey(left.orderingKey, right.orderingKey))
      .map((indexed) => indexed.summary);
    return limit === undefined ? partition : partition.slice(0, limit);
  }
}

function conditionFailed(operation: RepositoryOperation): { ok: false; error: RepositoryError } {
  return { ok: false, error: { kind: 'CONDITION_FAILED', operation } };
}
