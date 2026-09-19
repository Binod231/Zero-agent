/**
 * Entry_Ordering: the single home of the Req 7.2 total order.
 *
 * Req 7.2 states a three-level order over Published_Entries — session date **descending**, then
 * creation timestamp **descending**, then entry identifier **ascending** — and requires it to be a
 * single deterministic total order. Req 6.6 states the first two levels for the Author's Draft
 * listing. Req 7.1 renders in that order. One comparator and one sort key serve all three.
 *
 * This module holds both halves of that order and nothing else:
 *
 * - {@link buildOrderingKey} produces `GSI1SK`, the stored key a **single descending GSI1 scan**
 *   reads (access patterns 2, 3, 4, 5).
 * - {@link compareEntries} is the equivalent in-memory comparator, and the reference model the
 *   agreement property (Property 9, task 6.2) tests the key-derived order against.
 *
 * The two live together deliberately. They are not two utilities that happen to be related; they are
 * two spellings of one invariant, and the only thing that makes the stored key *correct* is that a
 * descending scan over it reproduces {@link compareEntries} exactly. Splitting them across modules
 * would make that agreement a coincidence between two files rather than a property of one.
 *
 * **Why the identifier is complemented in the key but not in the comparator.** The first two levels
 * of the order are descending and the third is ascending. A descending index scan applies one
 * direction to the whole key, so the third level has to be pre-reversed in the stored bytes. That is
 * what {@link invert} is for. The comparator has no such constraint and compares identifiers
 * directly, ascending. The asymmetry between the two functions is exactly this, and it is the reason
 * they are asserted against each other rather than trusted.
 *
 * **Scope.** Pure, synchronous, total, no I/O and no clock. `PK`, `SK`, and `GSI1PK` are not spelled
 * here: `entryKey` and `timelinePartition` in `./entry-repository-port` own those. `GSI1SK` is the
 * one derived key they do not cover, because it is the only one carrying an *order* rather than an
 * *address*.
 */

import type { EntrySummary } from './types';

// ---------------------------------------------------------------------------------------------
// The alphabet
// ---------------------------------------------------------------------------------------------

/**
 * Crockford base32: the ULID alphabet (design, *Entry item shape*). `I`, `L`, `O`, and `U` are
 * absent, so no identifier carries a visually confusable character.
 *
 * Two facts about this string are load-bearing for {@link invert}, and neither is incidental:
 *
 * 1. **It is strictly ascending in code-unit order.** `'0'`(U+0030) through `'9'`(U+0039), then
 *    `'A'`(U+0041) through `'Z'`(U+005A) with four letters omitted — omitting characters from an
 *    ascending sequence leaves it ascending. So `indexOf` is a strictly *increasing* function of the
 *    character, which is what lets an index complement stand in for a character reversal.
 * 2. **Its length is exactly 32**, so `31 - index` is the index complement and lands in bounds for
 *    every member.
 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The last index of {@link CROCKFORD_ALPHABET}. `31 - index` is the complement. */
const LAST_ALPHABET_INDEX = CROCKFORD_ALPHABET.length - 1;

// ---------------------------------------------------------------------------------------------
// Component widths
// ---------------------------------------------------------------------------------------------

/**
 * The fixed widths of the three ordering-key components, and the resulting key width.
 *
 * Fixed width is what makes the `#` separators unambiguous. Because every component is exactly as
 * long as its neighbour in every key, a `#` in the key is always a separator and never content, and
 * no key can be a proper prefix of another. Both matter: a variable-width first component would let
 * `2026-9-1#…` and `2026-09-1#…` interleave wrongly, and a prefix relationship between two keys
 * would break the equal-length argument {@link invert} rests on.
 *
 * These are a **documented precondition, not a runtime check**. {@link buildOrderingKey} must stay
 * total — the Entry_Serializer's `encode` guarantees it never throws, and it delegates `GSI1SK` to
 * this module — so a malformed component produces a malformed key rather than an exception. Every
 * caller reaches it through `encode`, which has already validated `entryId` as a 26-character ULID,
 * `sessionDate` as canonical `YYYY-MM-DD`, and `createdAt` as a canonical 24-character UTC instant.
 * The unit tests assert the widths hold for valid input.
 */
export const SESSION_DATE_WIDTH = 10;

/** `YYYY-MM-DDTHH:mm:ss.sssZ`. See {@link SESSION_DATE_WIDTH}. */
export const INSTANT_WIDTH = 24;

/** A ULID. See {@link SESSION_DATE_WIDTH}. */
export const ENTRY_ID_WIDTH = 26;

/** `10 + 1 + 24 + 1 + 26`: the width of every well-formed ordering key. */
export const ORDERING_KEY_WIDTH = SESSION_DATE_WIDTH + INSTANT_WIDTH + ENTRY_ID_WIDTH + 2;

// ---------------------------------------------------------------------------------------------
// invert
// ---------------------------------------------------------------------------------------------

/**
 * Maps the Crockford alphabet onto itself in reverse, character by character: `0`↔`Z`, `1`↔`Y`,
 * `J`↔`D`, and so on.
 *
 * **The property this exists for.** For two identifiers `a` and `b` *of equal length*:
 *
 * ```
 * a < b   if and only if   invert(a) > invert(b)
 * ```
 *
 * Why it holds. Lexicographic comparison of two equal-length strings is decided entirely at the
 * first position `i` at which they differ: `a < b` exactly when `a[i] < b[i]`. `invert` is applied
 * positionwise and preserves length, so `invert(a)` and `invert(b)` differ at that same position `i`
 * and at no earlier one. At `i`, the alphabet is ascending (see {@link CROCKFORD_ALPHABET}) so
 * `a[i] < b[i]` is the same statement as `indexOf(a[i]) < indexOf(b[i])`, and complementing gives
 * `31 - indexOf(a[i]) > 31 - indexOf(b[i])`, which is `invert(a)[i] > invert(b)[i]`. The decision
 * position is unchanged and its verdict is flipped, so the verdict on the whole string is flipped.
 * Since `invert` is a bijection on the alphabet it is also injective, so distinct identifiers stay
 * distinct and the biconditional has no ties to worry about.
 *
 * **Equal length is not a technicality.** A positionwise map cannot reverse a prefix relationship:
 * if `a` is a proper prefix of `b` then `a < b`, but `invert(a)` is still a proper prefix of
 * `invert(b)` and so still the smaller string. The property would fail outright. Every ULID is
 * exactly 26 characters, which is what rules that case out — and why {@link ENTRY_ID_WIDTH} is
 * stated as a precondition rather than left implicit.
 *
 * **Totality.** A character outside the alphabet is passed through unchanged rather than throwing,
 * so this is total over every string and `encode` keeps its never-throws guarantee. Such a character
 * cannot reach here through `encode`, which validates the ULID alphabet first. Iteration is by code
 * point, so an astral-plane character is passed through whole rather than split into surrogates.
 */
export function invert(identifier: string): string {
  let complemented = '';
  for (const character of identifier) {
    const index = CROCKFORD_ALPHABET.indexOf(character);
    if (index === -1) {
      complemented += character;
      continue;
    }
    // `index` is in `0..31`, so the complement is too and the lookup is always defined. The `??`
    // exists only because `noUncheckedIndexedAccess` types the index access as `string | undefined`.
    complemented += CROCKFORD_ALPHABET[LAST_ALPHABET_INDEX - index] ?? character;
  }
  return complemented;
}

// ---------------------------------------------------------------------------------------------
// buildOrderingKey
// ---------------------------------------------------------------------------------------------

/**
 * Builds `GSI1SK`, the key whose **descending** scan is exactly the Req 7.2 order.
 *
 * ```
 * GSI1SK = <sessionDate> "#" <createdAt> "#" <invert(entryId)>
 *              10 chars        24 chars         26 chars
 * ```
 *
 * Reading a descending scan level by level:
 *
 * 1. `sessionDate` leads, so decreasing keys mean later session dates first — Req 7.2 level one.
 * 2. Entries sharing a session date have a byte-identical first component, so the comparison moves
 *    to `createdAt`; decreasing means most recent first — Req 7.2 level two, and the whole of the
 *    Req 6.6 Draft order.
 * 3. Entries sharing both have two identical components, so the comparison falls to
 *    `invert(entryId)`. Decreasing `invert(entryId)` is *increasing* `entryId` by the biconditional
 *    on {@link invert} — Req 7.2 level three, the ascending tie-break, from the same descending
 *    scan. This is the only reason the complement exists.
 *
 * Because identifiers are unique, level three always decides, so no two distinct Entries share a
 * key and the scan order is fully determined by the data.
 *
 * Takes an `EntrySummary` — the GSI1 `INCLUDE` projection — and reads only `sessionDate`,
 * `createdAt`, and `entryId` from it. A full `Entry` carries every `EntrySummary` field, so the
 * Entry_Serializer passes its normalized `Entry` here with no cast, and a timeline query result can
 * be re-keyed with no cast either.
 *
 * Total: never throws, for any input. See {@link SESSION_DATE_WIDTH} on why the component widths are
 * a precondition rather than a check.
 */
export function buildOrderingKey(entry: EntrySummary): string {
  return `${entry.sessionDate}#${entry.createdAt}#${invert(entry.entryId)}`;
}

// ---------------------------------------------------------------------------------------------
// compareEntries
// ---------------------------------------------------------------------------------------------

/**
 * The reference comparator for the Req 7.2 order: session date descending, then creation timestamp
 * descending, then **entry identifier ascending**.
 *
 * Note the direction of the third comparison against the first two. Levels one and two return `1`
 * when the left operand is the *smaller* string, which sorts larger values first. Level three
 * returns `-1` in that case, which sorts smaller values first. That inversion is Req 7.2's
 * "ascending Entry identifier", and it is the comparator-side counterpart of {@link invert} in the
 * stored key.
 *
 * **A strict total order.** Both `sessionDate` and `createdAt` are canonical fixed-width forms, so
 * lexicographic comparison on them *is* chronological comparison and no two spellings of one moment
 * can disagree. The three levels are checked in order and each returns before the next is reached,
 * so the result is a deterministic function of the pair. It returns `0` only when all three fields
 * are equal, and since entry identifiers are unique across the Entry_Store (Req 3.1) that means only
 * for the same Entry. So the relation is irreflexive and antisymmetric on distinct Entries,
 * transitive because each level is a lexicographic comparison of strings refined by the next, and
 * never ties — which is the "single deterministic order for any set of Published_Entries" Req 7.2
 * asks for, and what makes the rendered order a function of the data alone.
 *
 * Suitable for `Array#sort` directly. Reads only three of the six `EntrySummary` fields; `title`,
 * `updatedAt`, and `generationFailed` play no part in the order.
 */
export function compareEntries(a: EntrySummary, b: EntrySummary): number {
  if (a.sessionDate !== b.sessionDate) {
    return a.sessionDate < b.sessionDate ? 1 : -1;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  if (a.entryId !== b.entryId) {
    return a.entryId < b.entryId ? -1 : 1;
  }
  return 0;
}
