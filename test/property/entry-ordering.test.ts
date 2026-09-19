import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { buildOrderingKey, compareEntries } from '../../src/core/entry-ordering';
import type { Entry } from '../../src/core/types';
import { arbEntrySet, arbEntrySetOf } from '../generators';

/**
 * **Property 9: Entry ordering is a deterministic total order.**
 *
 * **Validates: Requirements 6.6, 7.1, 7.2**
 *
 * One `fc.assert`, four clauses, as the design's *Property test conventions* require:
 *
 * 1. a **descending ordering-key** sort produces exactly the comparator's sequence;
 * 2. that order is a strict total order — irreflexive, antisymmetric, transitive over triples, and
 *    tie-free, so no two distinct Entries are ambiguously placed;
 * 3. re-deriving from the same set, and from a **shuffled** copy of it, gives the identical sequence;
 * 4. all of the above holds for the set restricted to status `draft`, which is the Req 6.6 listing.
 *
 * **Scope against `test/unit/entry-ordering.test.ts`.** The unit tests own the localized evidence:
 * `invert`'s involution and biconditional on concrete pairs, the key's layout and widths, and each
 * comparator level firing in the right direction. Nothing of that is restated here. What is here is
 * the universally quantified agreement between the two derivations and the order axioms, which is
 * exactly what examples cannot establish.
 *
 * **Why clause 1 sorts keys rather than entries.** `sortByDescendingOrderingKey` sorts the *key
 * strings* with `Array#sort`'s default code-unit comparison and reverses, then maps keys back to
 * Entries. It never calls `compareEntries`, so the agreement it asserts is between two genuinely
 * independent derivations rather than between one comparator and a re-spelling of itself. Reversing
 * an ascending sort is also how a DynamoDB `ScanIndexForward=false` query reads GSI1, which is the
 * thing the key exists to serve. Ordering keys are ASCII, so code-unit order and the UTF-8 byte order
 * DynamoDB compares with agree.
 *
 * **Why the generators pin small session-date and creation-timestamp pools.** A set of Entries with
 * all-distinct session dates never reaches levels two or three, so the property would pass while
 * testing one third of itself. `arbEntrySetOf` draws from pools, and the variants below shrink those
 * pools to one date (level two decides) and to one date with one instant (level three decides every
 * adjacency). The `afterAll` block asserts each level was actually reached, so a future change to the
 * shared generators that removed the ties would fail here rather than silently weaken the property.
 *
 * No AWS, no clock, no I/O: Entry_Ordering is pure and the generators are data.
 */

/** Which of the three Req 7.2 levels decides a pair, or 0 when all three fields agree. */
type TieBreakLevel = 1 | 2 | 3;

interface Coverage {
  /** Sets examined, counting shrinking runs. */
  sets: number;
  /** Sets in which at least one adjacency in the produced sequence was decided by the level. */
  setsReachingLevel: Record<TieBreakLevel, number>;
  /** Adjacencies decided by the level, summed over every set. */
  adjacentDecisions: Record<TieBreakLevel, number>;
  /** Adjacent pairs agreeing on all three fields. Must stay 0: identifiers are unique. */
  ambiguousAdjacencies: number;
}

function emptyCoverage(): Coverage {
  return {
    sets: 0,
    setsReachingLevel: { 1: 0, 2: 0, 3: 0 },
    adjacentDecisions: { 1: 0, 2: 0, 3: 0 },
    ambiguousAdjacencies: 0,
  };
}

const coverageAll = emptyCoverage();
const coverageDraft = emptyCoverage();

/** Cap on collected violations: a counterexample needs the first few, not all 7140 of them. */
const MAX_REPORTED_VIOLATIONS = 4;

/**
 * How many Entries the order axioms are checked exhaustively over. Antisymmetry is checked over
 * every pair of the whole set, but transitivity is cubic, so it runs over a randomly drawn subset of
 * this size. The subset is drawn from the same set, so it inherits the shared session dates and
 * shared creation timestamps and the ties survive the sampling.
 */
const AXIOM_SAMPLE_SIZE = 12;

/** Array access under `noUncheckedIndexedAccess`; the index is always in range at every call site. */
function at(entries: readonly Entry[], index: number): Entry {
  const entry = entries[index];
  if (entry === undefined) {
    throw new Error(`index ${String(index)} is outside a list of ${String(entries.length)}`);
  }
  return entry;
}

function idsOf(entries: readonly Entry[]): string[] {
  return entries.map((entry) => entry.entryId);
}

function decidingLevel(a: Entry, b: Entry): TieBreakLevel | 0 {
  if (a.sessionDate !== b.sessionDate) {
    return 1;
  }
  if (a.createdAt !== b.createdAt) {
    return 2;
  }
  if (a.entryId !== b.entryId) {
    return 3;
  }
  return 0;
}

/**
 * A single **descending ordering-key** sort: larger key first, which is what a descending GSI1 scan
 * returns. Keys are sorted as strings and then reversed; `compareEntries` is not consulted.
 *
 * @throws Error when two Entries share an ordering key, which unique identifiers make impossible and
 *   which would make the sequence ambiguous rather than merely misordered.
 */
function sortByDescendingOrderingKey(entries: readonly Entry[]): Entry[] {
  const byKey = new Map<string, Entry>();
  for (const entry of entries) {
    const key = buildOrderingKey(entry);
    const collision = byKey.get(key);
    if (collision !== undefined) {
      throw new Error(`ordering key ${key} is shared by ${collision.entryId} and ${entry.entryId}`);
    }
    byKey.set(key, entry);
  }
  // Ascending code-unit order, then reversed: the largest key leads.
  const descendingKeys = [...byKey.keys()].sort().reverse();
  return descendingKeys.map((key) => {
    const entry = byKey.get(key);
    if (entry === undefined) {
      throw new Error(`ordering key ${key} vanished from the index`);
    }
    return entry;
  });
}

/** Irreflexivity, antisymmetry, and tie-freedom over every pair of the set. */
function pairAxiomViolations(entries: readonly Entry[], label: string): string[] {
  const violations: string[] = [];
  for (let i = 0; i < entries.length && violations.length < MAX_REPORTED_VIOLATIONS; i += 1) {
    const a = at(entries, i);
    // Irreflexive: `a ≺ a` is `compareEntries(a, a) < 0`, which must never hold.
    if (compareEntries(a, a) !== 0) {
      violations.push(
        `${label}: compareEntries(a, a) = ${String(compareEntries(a, a))} for ${a.entryId}`,
      );
    }
    // The "returns 0 for equal ordering fields" direction: fields outside the order are irrelevant.
    const fieldEqualCopy: Entry = {
      ...a,
      title: `${a.title}~`,
      generationFailed: !a.generationFailed,
    };
    if (compareEntries(a, fieldEqualCopy) !== 0) {
      violations.push(
        `${label}: ${a.entryId} did not tie with a copy differing only outside the order`,
      );
    }
    for (let j = i + 1; j < entries.length && violations.length < MAX_REPORTED_VIOLATIONS; j += 1) {
      const b = at(entries, j);
      const ab = compareEntries(a, b);
      const ba = compareEntries(b, a);
      // The only tie is between entries with identical ordering fields, and identifiers are unique.
      if (ab === 0) {
        violations.push(`${label}: distinct ${a.entryId} and ${b.entryId} tied`);
      }
      // Antisymmetric: at most one of the two directions is negative, and swapping flips the sign.
      if (Math.sign(ab) !== -Math.sign(ba)) {
        violations.push(
          `${label}: ${a.entryId} vs ${b.entryId} gave ${String(ab)} and ${String(ba)}`,
        );
      }
    }
  }
  return violations;
}

/** Transitivity over every ordered triple of distinct members of the drawn sample. */
function transitivityViolations(sample: readonly Entry[], label: string): string[] {
  const violations: string[] = [];
  const size = sample.length;
  for (let i = 0; i < size && violations.length < MAX_REPORTED_VIOLATIONS; i += 1) {
    for (let j = 0; j < size && violations.length < MAX_REPORTED_VIOLATIONS; j += 1) {
      if (j === i) {
        continue;
      }
      for (let k = 0; k < size && violations.length < MAX_REPORTED_VIOLATIONS; k += 1) {
        if (k === i || k === j) {
          continue;
        }
        const a = at(sample, i);
        const b = at(sample, j);
        const c = at(sample, k);
        if (compareEntries(a, b) < 0 && compareEntries(b, c) < 0 && !(compareEntries(a, c) < 0)) {
          violations.push(
            `${label}: ${a.entryId} ≺ ${b.entryId} ≺ ${c.entryId} but not ${a.entryId} ≺ ${c.entryId}`,
          );
        }
      }
    }
  }
  return violations;
}

/** Records which tie-break levels actually decided adjacencies in a produced sequence. */
function recordCoverage(order: readonly Entry[], coverage: Coverage): void {
  coverage.sets += 1;
  const reached = new Set<TieBreakLevel>();
  for (let i = 1; i < order.length; i += 1) {
    const level = decidingLevel(at(order, i - 1), at(order, i));
    if (level === 0) {
      coverage.ambiguousAdjacencies += 1;
      continue;
    }
    coverage.adjacentDecisions[level] += 1;
    reached.add(level);
  }
  for (const level of reached) {
    coverage.setsReachingLevel[level] += 1;
  }
}

/**
 * All four clauses over one set and one shuffled copy of it. Returns the produced sequence so the
 * caller can assert that restricting it to Drafts agrees with ordering the Drafts alone.
 */
function checkOrder(
  entries: readonly Entry[],
  shuffled: readonly Entry[],
  axiomSample: readonly Entry[],
  coverage: Coverage,
  label: string,
): Entry[] {
  const keyOrder = sortByDescendingOrderingKey(entries);
  const comparatorOrder = [...entries].sort(compareEntries);

  // Clause 1: the descending key sort *is* the comparator's sequence.
  expect(idsOf(keyOrder), `${label}: key order vs comparator order`).toEqual(
    idsOf(comparatorOrder),
  );

  // Clause 2, and the no-ambiguity obligation: every adjacency is strictly decided, and the keys
  // themselves are strictly descending, so nothing is placed by accident of input order.
  const adjacencyViolations: string[] = [];
  for (
    let i = 1;
    i < keyOrder.length && adjacencyViolations.length < MAX_REPORTED_VIOLATIONS;
    i += 1
  ) {
    const previous = at(keyOrder, i - 1);
    const current = at(keyOrder, i);
    if (!(compareEntries(previous, current) < 0)) {
      adjacencyViolations.push(
        `${label}: ${previous.entryId} not strictly before ${current.entryId}`,
      );
    }
    if (!(buildOrderingKey(previous) > buildOrderingKey(current))) {
      adjacencyViolations.push(
        `${label}: key of ${previous.entryId} not above key of ${current.entryId}`,
      );
    }
  }
  expect(adjacencyViolations, `${label}: adjacency`).toEqual([]);
  expect(pairAxiomViolations(entries, label), `${label}: pair axioms`).toEqual([]);
  expect(transitivityViolations(axiomSample, label), `${label}: transitivity`).toEqual([]);

  // Clause 3: re-deriving from the same set, and from a shuffled copy, gives the same sequence. A
  // comparator or key sort that leaned on input order would pass a single derivation and fail here.
  expect(idsOf(sortByDescendingOrderingKey(entries)), `${label}: re-derivation`).toEqual(
    idsOf(keyOrder),
  );
  expect(idsOf(sortByDescendingOrderingKey(shuffled)), `${label}: shuffled key order`).toEqual(
    idsOf(keyOrder),
  );
  expect(idsOf([...shuffled].sort(compareEntries)), `${label}: shuffled comparator order`).toEqual(
    idsOf(keyOrder),
  );

  recordCoverage(keyOrder, coverage);
  return keyOrder;
}

interface OrderingCase {
  entries: Entry[];
  /** A full permutation of `entries`: same members, arbitrary input order. */
  shuffled: Entry[];
  /** Up to {@link AXIOM_SAMPLE_SIZE} members, for the cubic transitivity check. */
  axiomSample: Entry[];
}

function arbPermutationOf(entries: Entry[]): fc.Arbitrary<Entry[]> {
  if (entries.length === 0) {
    return fc.constant<Entry[]>([]);
  }
  return fc.shuffledSubarray(entries, {
    minLength: entries.length,
    maxLength: entries.length,
  });
}

function arbAxiomSampleOf(entries: Entry[]): fc.Arbitrary<Entry[]> {
  if (entries.length === 0) {
    return fc.constant<Entry[]>([]);
  }
  const size = Math.min(entries.length, AXIOM_SAMPLE_SIZE);
  return fc.shuffledSubarray(entries, { minLength: size, maxLength: size });
}

function arbOrderingCase(entrySet: fc.Arbitrary<Entry[]>): fc.Arbitrary<OrderingCase> {
  return entrySet.chain((entries) =>
    fc.record({
      entries: fc.constant(entries),
      shuffled: arbPermutationOf(entries),
      axiomSample: arbAxiomSampleOf(entries),
    }),
  );
}

/**
 * Sets deliberately seeded so each tie-break level decides somewhere. `arbEntrySetOf` draws session
 * dates and creation timestamps from pools of the given size, so a pool of one forces the tie.
 */
const arbOrderingCases: fc.Arbitrary<OrderingCase> = fc.oneof(
  // The shared default: pools of four dates and four instants, sizes 0 to 120, statuses mixed.
  { arbitrary: arbOrderingCase(arbEntrySet), weight: 3 },
  // One session date: level one never fires, so level two decides wherever the instants differ.
  {
    arbitrary: arbOrderingCase(
      arbEntrySetOf({ minLength: 2, maxLength: 30, maxSessionDates: 1, maxCreatedAt: 4 }),
    ),
    weight: 2,
  },
  // One session date and one instant: level three decides *every* adjacency in the set.
  {
    arbitrary: arbOrderingCase(
      arbEntrySetOf({ minLength: 2, maxLength: 24, maxSessionDates: 1, maxCreatedAt: 1 }),
    ),
    weight: 3,
  },
  // Two dates and two instants: all three levels decide adjacencies within one set.
  {
    arbitrary: arbOrderingCase(
      arbEntrySetOf({ minLength: 3, maxLength: 40, maxSessionDates: 2, maxCreatedAt: 2 }),
    ),
    weight: 2,
  },
);

describe('Entry_Ordering', () => {
  it('orders any set of Entries as one deterministic total order (Property 9)', () => {
    // Feature: devlog-narrator, Property 9: For any set of Entries, sorting by descending ordering
    // key produces exactly the same sequence as the reference comparator (session date descending,
    // then creation timestamp descending, then entry identifier ascending); that sequence is a
    // strict total order, being irreflexive, antisymmetric, and transitive over distinct entries;
    // and re-deriving it from the same set always produces the same sequence. The same holds when
    // the set is restricted to Entries holding status `draft`.
    fc.assert(
      fc.property(arbOrderingCases, ({ entries, shuffled, axiomSample }) => {
        const timeline = checkOrder(entries, shuffled, axiomSample, coverageAll, 'all');

        // Clause 4: the Req 6.6 Draft listing is the same order restricted to status `draft`.
        const isDraft = (entry: Entry): boolean => entry.status === 'draft';
        const drafts = entries.filter(isDraft);
        const draftOrder = checkOrder(
          drafts,
          shuffled.filter(isDraft),
          axiomSample.filter(isDraft),
          coverageDraft,
          'draft',
        );
        // One comparator serves both listings, so restricting the timeline and ordering the Drafts
        // alone cannot disagree.
        expect(idsOf(draftOrder), 'draft order vs restricted timeline').toEqual(
          idsOf(timeline.filter(isDraft)),
        );
      }),
    );
  });

  afterAll(() => {
    // Not a property: a guard on the input space the property above ran over. A change to the shared
    // generators that stopped producing shared session dates or shared creation timestamps would
    // leave every assertion above green while levels two and three went untested, so the levels are
    // asserted to have actually decided something.
    expect(coverageAll.sets, 'sets examined').toBeGreaterThanOrEqual(100);
    expect(
      coverageAll.setsReachingLevel[1],
      'sets where session date decided',
    ).toBeGreaterThanOrEqual(10);
    expect(
      coverageAll.setsReachingLevel[2],
      'sets where creation timestamp decided',
    ).toBeGreaterThanOrEqual(10);
    expect(
      coverageAll.setsReachingLevel[3],
      'sets where entry identifier decided',
    ).toBeGreaterThanOrEqual(10);
    expect(
      coverageDraft.setsReachingLevel[3],
      'draft sets where entry identifier decided',
    ).toBeGreaterThanOrEqual(5);
    // Unique identifiers make a fully tied adjacency impossible, in the full set and in the Drafts.
    expect(coverageAll.ambiguousAdjacencies, 'ambiguous adjacencies').toBe(0);
    expect(coverageDraft.ambiguousAdjacencies, 'ambiguous draft adjacencies').toBe(0);
  });
});
