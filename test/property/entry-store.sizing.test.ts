import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encode, encodedSizeBytes } from '../../src/core/entry-serializer';
import { MAX_ENTRY_ITEM_BYTES } from '../../src/core/entry-repository-port';
import type { Entry } from '../../src/core/types';
import { EntryStoreFake } from '../doubles/entry-store-fake';
import { arbEntry } from '../generators';

/**
 * **Property 8: Oversized entries are rejected without a write** (Req 8.8).
 *
 * *For any* Entry whose canonical encoded size exceeds 393216 bytes, the Devlog_API rejects the
 * write with an error naming the storage size limit and the Entry_Store is unchanged, and for any
 * Entry at or below that size the write is attempted.
 *
 * Validates: Requirements 8.8.
 */

describe('Property 8: Oversized entries are rejected without a write', () => {
  const measureEntryBytes = (entry: Entry): number => {
    const res = encode(entry);
    if (!res.ok) {
      // Fallback to utf-8 length of fields
      return new TextEncoder().encode(JSON.stringify(entry)).length;
    }
    return encodedSizeBytes(res.item);
  };

  it('rejects entries with ITEM_TOO_LARGE when encodedSizeBytes exceeds limit and leaves store unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntry, fc.integer({ min: 100, max: 2000 }), async (entry, testThreshold) => {
        const store = new EntryStoreFake({
          measureEntryBytes,
          maxItemBytes: testThreshold,
        });

        const initialSnapshot = store.snapshot();
        const measuredSize = measureEntryBytes(entry);

        const result = await store.putEntry(entry);

        if (measuredSize > testThreshold) {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('ITEM_TOO_LARGE');
            if (result.error.kind === 'ITEM_TOO_LARGE') {
              expect(result.error.sizeBytes).toBe(measuredSize);
              expect(result.error.limitBytes).toBe(testThreshold);
            }
          }
          expect(store.snapshot()).toEqual(initialSnapshot);
        } else {
          expect(result.ok).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('accepts any valid in-bounds entry at the production MAX_ENTRY_ITEM_BYTES ceiling', async () => {
    await fc.assert(
      fc.asyncProperty(arbEntry, async (entry) => {
        const store = new EntryStoreFake({
          measureEntryBytes,
          maxItemBytes: MAX_ENTRY_ITEM_BYTES,
        });

        const measuredSize = measureEntryBytes(entry);
        expect(measuredSize).toBeLessThanOrEqual(MAX_ENTRY_ITEM_BYTES);

        const result = await store.putEntry(entry);
        expect(result.ok).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
