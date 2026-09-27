import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../../src/core/types';
import { EntryStoreFake } from '../doubles/entry-store-fake';
import { arbEntry } from '../generators';

/**
 * **Property 7: Entry writes are idempotent and atomic** (Req 8.5, 8.9).
 *
 * *For any* Entry and any sequence of two or more writes of that Entry's identifier, the Entry_Store
 * holds exactly one item carrying that identifier, and reading it yields the complete field set of
 * the most recently completed write and never a mixture of field values drawn from different writes.
 *
 * Validates: Requirements 8.5, 8.9.
 */

describe('Property 7: Entry writes are idempotent and atomic', () => {
  it('holds exactly one item on repeated writes and returns the exact most recent write without field mixtures', async () => {
    // Generate a base entry and a sequence of variations with the same entryId
    const arbEntryVariations = fc.tuple(
      arbEntry,
      fc.array(
        fc.record({
          title: fc.string({ minLength: 1, maxLength: 50 }),
          body: fc.string({ minLength: 1, maxLength: 500 }),
          generationFailed: fc.boolean(),
        }),
        { minLength: 1, maxLength: 5 },
      ),
    );

    await fc.assert(
      fc.asyncProperty(arbEntryVariations, async ([base, variations]) => {
        const store = new EntryStoreFake();

        const versions: Entry[] = [
          base,
          ...variations.map((v, i) => ({
            ...base,
            title: v.title,
            body: v.body,
            generationFailed: v.generationFailed,
            updatedAt: `2026-09-20T10:00:0${i}.000Z`,
          })),
        ];

        // Apply every write sequentially
        for (const version of versions) {
          const res = await store.putEntry(version);
          expect(res.ok).toBe(true);
        }

        // Reading back must yield exactly the latest write
        const readRes = await store.getEntry(base.entryId);
        expect(readRes.ok).toBe(true);
        if (readRes.ok) {
          const expected = versions[versions.length - 1];
          expect(readRes.value).toEqual(expected);
        }

        // Verify only 1 entry exists in the store for this ID
        const snapshot = store.snapshot();
        const matching = snapshot.entries.filter((e) => e.entryId === base.entryId);
        expect(matching).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });
});
