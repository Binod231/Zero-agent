import { describe, expect, it } from 'vitest';
import type { Entry } from '../../../src/core/types';
import { EntryStoreFake } from '../../doubles/entry-store-fake';

/**
 * Unit tests of the Entry_Store fake itself.
 *
 * A fake is only useful if the semantics the properties lean on actually hold, so each behaviour the
 * fake claims is checked here once. These are tests of the double, not of the System: none of them is
 * one of the 27 correctness properties, and none should be read as standing in for one.
 */

const ENTRY_ID = '01J8ZQ3K9YV2N7A4B6C8D0E1F2';
const SESSION_ID = '01J8ZQ3J5B0000000000000000';

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    entryId: ENTRY_ID,
    title: 'Wiring the commit log parser into generation',
    body: 'The parser now feeds the generator.',
    sessionDate: '2026-09-19',
    status: 'draft',
    createdAt: '2026-09-19T21:04:11.417Z',
    updatedAt: '2026-09-19T21:04:11.417Z',
    sessionId: SESSION_ID,
    generationFailed: false,
    schemaVersion: 1,
    ...overrides,
  };
}

/** A distinct identifier per index, still 26 characters of the ULID alphabet. */
function entryIdFor(index: number): string {
  return `${ENTRY_ID.slice(0, 24)}${String(index).padStart(2, '0')}`;
}

describe('EntryStoreFake write semantics', () => {
  it('leaves exactly one item holding the last of repeated writes of one identifier', async () => {
    const store = new EntryStoreFake();
    const versions = [
      makeEntry({ title: 'first', updatedAt: '2026-09-19T21:04:11.417Z' }),
      makeEntry({ title: 'second', updatedAt: '2026-09-19T21:05:00.000Z' }),
      makeEntry({ title: 'third', updatedAt: '2026-09-19T21:06:00.000Z' }),
    ];

    for (const version of versions) {
      const result = await store.putEntry(version);
      expect(result.ok).toBe(true);
    }

    const snapshot = store.snapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toEqual(versions[2]);
  });

  it('returns the complete field set of one write, never a mixture', async () => {
    const store = new EntryStoreFake();
    const first = makeEntry({
      title: 'first',
      body: 'first body',
      updatedAt: '2026-09-19T21:04:11.417Z',
    });
    const second = makeEntry({
      title: 'second',
      body: 'second body',
      updatedAt: '2026-09-19T21:05:00.000Z',
    });

    // Both writes suspend before applying, so this is a genuine interleaving rather than two
    // sequential calls that only look concurrent.
    await Promise.all([store.putEntry(first), store.putEntry(second)]);

    const read = await store.getEntry(ENTRY_ID);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect([first, second]).toContainEqual(read.value);
    }
  });

  it('shares no object with the caller in either direction', async () => {
    const store = new EntryStoreFake();
    const written = makeEntry();
    await store.putEntry(written);

    // Mutating the object that was written must not reach the store: the fake stored a frozen copy.
    written.title = 'mutated after the write';

    const read = await store.getEntry(ENTRY_ID);
    if (!read.ok || read.value === null) {
      throw new Error('expected the written entry to be readable');
    }
    expect(read.value.title).toBe('Wiring the commit log parser into generation');

    // Nor may mutating what was read: a read hands back a copy too.
    read.value.title = 'mutated through the returned copy';
    const reread = await store.getEntry(ENTRY_ID);
    if (!reread.ok || reread.value === null) {
      throw new Error('expected the written entry to still be readable');
    }
    expect(reread.value.title).toBe('Wiring the commit log parser into generation');
  });

  it('reports absence as null rather than an error', async () => {
    const store = new EntryStoreFake();
    const read = await store.getEntry('01J8ZQ3K9YV2N7A4B6C8D0ZZZZ');
    expect(read).toEqual({ ok: true, value: null });
  });
});

describe('EntryStoreFake conditional operations', () => {
  it('fails a status transition whose expected status does not hold, changing nothing', async () => {
    const store = new EntryStoreFake();
    store.seedEntries([makeEntry({ status: 'draft' })]);

    const first = await store.updateEntryStatus({
      entryId: ENTRY_ID,
      expected: 'draft',
      next: 'published',
      updatedAt: '2026-09-19T22:00:00.000Z',
    });
    expect(first.ok).toBe(true);

    const before = store.snapshot();
    const writesBefore = store.writeCount;

    // The doubled publish: the condition `status = draft` no longer holds, which is what a 409 is
    // built on (Req 6.8).
    const second = await store.updateEntryStatus({
      entryId: ENTRY_ID,
      expected: 'draft',
      next: 'published',
      updatedAt: '2026-09-19T23:00:00.000Z',
    });
    expect(second).toEqual({
      ok: false,
      error: { kind: 'CONDITION_FAILED', operation: 'updateEntryStatus' },
    });
    expect(store.snapshot()).toEqual(before);
    expect(store.writeCount).toBe(writesBefore);
  });

  it('rejects a delete of a published Entry and deletes a draft', async () => {
    const store = new EntryStoreFake();
    store.seedEntries([makeEntry({ status: 'published' })]);

    const rejected = await store.deleteDraft(ENTRY_ID);
    expect(rejected).toEqual({
      ok: false,
      error: { kind: 'CONDITION_FAILED', operation: 'deleteDraft' },
    });
    expect(store.snapshot().entries).toHaveLength(1);

    store.seedEntries([makeEntry({ status: 'draft' })]);
    const accepted = await store.deleteDraft(ENTRY_ID);
    expect(accepted.ok).toBe(true);
    expect(store.snapshot().entries).toHaveLength(0);
  });

  it('fails an absent-item condition on put-if-absent, patch, and session state', async () => {
    const store = new EntryStoreFake();
    await store.putEntry(makeEntry());

    const collision = await store.putEntry(makeEntry({ title: 'other' }), { ifAbsent: true });
    expect(collision).toEqual({
      ok: false,
      error: { kind: 'CONDITION_FAILED', operation: 'putEntry' },
    });

    const patchMissing = await store.patchEntry({
      entryId: '01J8ZQ3K9YV2N7A4B6C8D0ZZZZ',
      patch: { title: 'nope' },
      updatedAt: '2026-09-19T23:00:00.000Z',
    });
    expect(patchMissing).toEqual({
      ok: false,
      error: { kind: 'CONDITION_FAILED', operation: 'patchEntry' },
    });

    const sessionMissing = await store.updateSessionState({
      sessionId: SESSION_ID,
      next: 'generated',
    });
    expect(sessionMissing).toEqual({
      ok: false,
      error: { kind: 'CONDITION_FAILED', operation: 'updateSessionState' },
    });
  });

  it('patches content and the modification instant while leaving the identity fields alone', async () => {
    const store = new EntryStoreFake();
    store.seedEntries([makeEntry()]);

    const patched = await store.patchEntry({
      entryId: ENTRY_ID,
      patch: { body: 'edited body' },
      updatedAt: '2026-09-20T09:00:00.000Z',
    });

    expect(patched.ok).toBe(true);
    if (patched.ok) {
      expect(patched.value.body).toBe('edited body');
      expect(patched.value.title).toBe('Wiring the commit log parser into generation');
      expect(patched.value.sessionDate).toBe('2026-09-19');
      expect(patched.value.createdAt).toBe('2026-09-19T21:04:11.417Z');
      expect(patched.value.updatedAt).toBe('2026-09-20T09:00:00.000Z');
    }
  });
});

describe('EntryStoreFake queries', () => {
  it('scans one status partition in descending ordering-key order and honours the limit', async () => {
    const store = new EntryStoreFake();
    store.seedEntries([
      makeEntry({ entryId: entryIdFor(1), sessionDate: '2026-09-17', status: 'published' }),
      makeEntry({ entryId: entryIdFor(2), sessionDate: '2026-09-19', status: 'published' }),
      makeEntry({ entryId: entryIdFor(3), sessionDate: '2026-09-18', status: 'published' }),
      makeEntry({ entryId: entryIdFor(4), sessionDate: '2026-09-20', status: 'draft' }),
    ]);

    const timeline = await store.queryTimeline({ limit: 2 });
    expect(timeline.ok).toBe(true);
    if (timeline.ok) {
      expect(timeline.value.map((summary) => summary.entryId)).toEqual([
        entryIdFor(2),
        entryIdFor(3),
      ]);
    }

    const drafts = await store.queryByStatus({ status: 'draft' });
    expect(drafts.ok).toBe(true);
    if (drafts.ok) {
      expect(drafts.value.map((summary) => summary.entryId)).toEqual([entryIdFor(4)]);
    }
  });

  it('breaks a shared session date by creation instant descending, then identifier ascending', async () => {
    const store = new EntryStoreFake();
    store.seedEntries([
      makeEntry({
        entryId: entryIdFor(5),
        createdAt: '2026-09-19T10:00:00.000Z',
        status: 'published',
      }),
      makeEntry({
        entryId: entryIdFor(3),
        createdAt: '2026-09-19T12:00:00.000Z',
        status: 'published',
      }),
      makeEntry({
        entryId: entryIdFor(4),
        createdAt: '2026-09-19T12:00:00.000Z',
        status: 'published',
      }),
    ]);

    const timeline = await store.queryTimeline({ limit: 10 });
    expect(timeline.ok).toBe(true);
    if (timeline.ok) {
      expect(timeline.value.map((summary) => summary.entryId)).toEqual([
        entryIdFor(3),
        entryIdFor(4),
        entryIdFor(5),
      ]);
    }
  });

  it('returns the GSI1 projection only, so no query can leak a body', async () => {
    const store = new EntryStoreFake();
    store.seedEntries([makeEntry({ status: 'published', body: 'secret body text' })]);

    const timeline = await store.queryTimeline({ limit: 1 });
    expect(timeline.ok).toBe(true);
    if (timeline.ok) {
      expect(timeline.value[0]).toEqual({
        entryId: ENTRY_ID,
        title: 'Wiring the commit log parser into generation',
        sessionDate: '2026-09-19',
        createdAt: '2026-09-19T21:04:11.417Z',
        updatedAt: '2026-09-19T21:04:11.417Z',
        generationFailed: false,
      });
    }
  });

  it('treats a non-positive limit as a caller bug', async () => {
    const store = new EntryStoreFake();
    await expect(store.queryTimeline({ limit: 0 })).rejects.toThrow(RangeError);
  });
});

describe('EntryStoreFake size ceiling', () => {
  it('rejects an oversized write before any store mutation', async () => {
    const store = new EntryStoreFake({ maxItemBytes: 200 });
    const oversized = makeEntry({ body: 'x'.repeat(300) });

    const result = await store.putEntry(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('ITEM_TOO_LARGE');
      if (result.error.kind === 'ITEM_TOO_LARGE') {
        expect(result.error.limitBytes).toBe(200);
        expect(result.error.sizeBytes).toBeGreaterThan(200);
      }
    }
    expect(store.snapshot().entries).toHaveLength(0);
    expect(store.writeCount).toBe(0);
  });

  it('measures with the injected accounting function, which is how the real serializer is used', async () => {
    const store = new EntryStoreFake({
      maxItemBytes: 1000,
      measureEntryBytes: (entry) => entry.body.length * 100,
    });

    expect((await store.putEntry(makeEntry({ body: 'short' }))).ok).toBe(true);
    expect((await store.putEntry(makeEntry({ body: 'much longer body' }))).ok).toBe(false);
    expect(store.snapshot().entries[0]?.body).toBe('short');
  });

  it('rejects a patch that would push the item over the ceiling, leaving it unchanged', async () => {
    const store = new EntryStoreFake({ maxItemBytes: 300 });
    store.seedEntries([makeEntry()]);
    const before = store.snapshot();

    const result = await store.patchEntry({
      entryId: ENTRY_ID,
      patch: { body: 'y'.repeat(400) },
      updatedAt: '2026-09-20T09:00:00.000Z',
    });

    expect(result.ok).toBe(false);
    expect(store.snapshot()).toEqual(before);
  });
});

describe('EntryStoreFake failure injection', () => {
  it('fails the next matching operation only, then recovers', async () => {
    const store = new EntryStoreFake();
    store.seedEntries([makeEntry()]);
    store.injectFailure({ kind: 'UNAVAILABLE', operations: ['getEntry'] });

    const failed = await store.getEntry(ENTRY_ID);
    expect(failed).toEqual({
      ok: false,
      error: { kind: 'UNAVAILABLE', operation: 'getEntry' },
    });

    const recovered = await store.getEntry(ENTRY_ID);
    expect(recovered.ok).toBe(true);
  });

  it('holds a throttle open for a requested number of operations across every operation', async () => {
    const store = new EntryStoreFake();
    store.injectFailure({ kind: 'THROTTLED', times: 2 });

    const first = await store.putEntry(makeEntry());
    const second = await store.queryTimeline({ limit: 5 });
    const third = await store.putEntry(makeEntry());

    expect(first).toEqual({ ok: false, error: { kind: 'THROTTLED', operation: 'putEntry' } });
    expect(second).toEqual({
      ok: false,
      error: { kind: 'THROTTLED', operation: 'queryTimeline' },
    });
    expect(third.ok).toBe(true);
    // The two rejected operations were attempted but wrote nothing.
    expect(store.calls).toEqual(['putEntry', 'queryTimeline', 'putEntry']);
    expect(store.writeCount).toBe(1);
  });

  it('injects a malformed stored item, which is the degraded read path of Req 1.8', async () => {
    const store = new EntryStoreFake();
    store.seedEntries([makeEntry()]);
    store.injectFailure({
      kind: 'MALFORMED_ITEM',
      operations: ['getEntry'],
      decodeError: { kind: 'MISSING_ATTRIBUTE', attribute: 'title' },
    });

    const result = await store.getEntry(ENTRY_ID);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'MALFORMED_ITEM',
        operation: 'getEntry',
        error: { kind: 'MISSING_ATTRIBUTE', attribute: 'title' },
      },
    });
  });

  it('clears pending failures on request', async () => {
    const store = new EntryStoreFake();
    store.injectFailure({ kind: 'UNAVAILABLE', times: Number.POSITIVE_INFINITY });
    store.clearFailures();
    expect((await store.putEntry(makeEntry())).ok).toBe(true);
  });
});

describe('EntryStoreFake session items', () => {
  it('round-trips a SESSION item verbatim and moves its generation state', async () => {
    const store = new EntryStoreFake();
    const record = {
      sessionId: SESSION_ID,
      entryId: ENTRY_ID,
      noteText: '  ragged\r\nnotes with an emoji \u{1F600}  ',
      commitLog: '',
      sessionDate: '2026-09-19',
      submittedAt: '2026-09-19T21:03:58.002Z',
      generationState: 'pending' as const,
      correlationId: '01J8ZQ3J5BQ7X9K2M4N6P8R0T2',
      schemaVersion: 1 as const,
    };

    expect((await store.putSession(record)).ok).toBe(true);
    expect((await store.updateSessionState({ sessionId: SESSION_ID, next: 'generated' })).ok).toBe(
      true,
    );

    const read = await store.getSession(SESSION_ID);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toEqual({ ...record, generationState: 'generated' });
    }
  });
});

describe('EntryStoreFake test surface', () => {
  it('seeds without counting a write, and snapshots deterministically', () => {
    const store = new EntryStoreFake();
    store.seedEntries([
      makeEntry({ entryId: entryIdFor(2) }),
      makeEntry({ entryId: entryIdFor(1) }),
    ]);

    expect(store.writeCount).toBe(0);
    expect(store.snapshot().entries.map((entry) => entry.entryId)).toEqual([
      entryIdFor(1),
      entryIdFor(2),
    ]);
    expect(store.snapshot()).toEqual(store.snapshot());
  });
});
