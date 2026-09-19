import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_COMMIT_RECORDS, parseCommitLog } from '../../src/core/commit-log-parser';
import { printCommitLog } from '../../src/core/commit-log-printer';
import type { CommitRecord } from '../../src/core/types';
import { arbCommitRecord } from '../generators';

/**
 * **Property 1** of the design's *Correctness Properties*, and the only test that implements it.
 *
 * The round trip is the primary guard on the Commit_Log_Parser, per the design's rule that a parser
 * and printer pair always gets one: the parser's own grammar tests say what it accepts, and this
 * says that what the Commit_Log_Printer emits for a list of Commit_Records reads back as that same
 * list. Req 4.5 (the printer emits text the parser accepts, LF endings only) and Req 4.6 (the four
 * fields survive in order) are the two criteria under test.
 *
 * **The scoping to printer-accepted lists is not a filter that hides inputs.** Property 1 is stated
 * over lists "the Commit_Log_Printer prints without error", because the printer is deliberately
 * partial (design, *Commit_Log_Printer*: five rejection rules). The naive way to express that — draw
 * arbitrary records and `.filter` on the printer — would discard nearly everything, since a
 * uniformly generated `authorName` almost always carries whitespace at an end, an angle bracket, or
 * a line break, and a property that passes on four surviving draws out of a hundred is vacuous
 * while still green. So the input space is built to satisfy the rejection rules **by construction**:
 * `arbCommitRecord` in `test/generators.ts` generates a 7-40 hex-digit hash, an author name that is
 * non-empty, trimmed, and free of CR, LF, `<`, and `>`, a non-empty trimmed author date, and a
 * subject that is either empty or holds a non-whitespace code point, with no CR or LF anywhere.
 *
 * `fc.pre` then states the scoping rather than enforcing it, and the counters the test keeps turn a
 * silently shrinking input space into a failure: `printerRejections` must stay empty, and the
 * accepted set must be shown to reach the 500-record ceiling, to include empty subjects, and to
 * include author names outside the ASCII range and above U+FFFF. A generator change that made the
 * property vacuous would fail here instead of passing quietly.
 *
 * Nothing here calls AWS, reads the clock, or touches the filesystem.
 */

// ---------------------------------------------------------------------------------------------
// Input space: lists of printer-acceptable Commit_Records, up to the 500-record ceiling
// ---------------------------------------------------------------------------------------------

/**
 * Lists of Commit_Records up to `MAX_COMMIT_RECORDS`, which is the bound the design's test note
 * gives (`fc.array(arbCommitRecord, { maxLength: 500 })`).
 *
 * Three weighted branches rather than one array: `fast-check`'s default `size` keeps an array draw
 * near ten entries whatever `maxLength` says, so a single branch would never come near the ceiling
 * where the printer's list-level rule and the parser's `TOO_MANY_COMMITS` boundary live. `size:
 * 'max'` on the two larger branches is what makes those lengths actually appear. Short lists still
 * dominate, because the per-record rules are where the interesting failures are and a hundred
 * 500-record draws would cost seconds for no extra coverage.
 */
const arbPrintableRecordList: fc.Arbitrary<CommitRecord[]> = fc.oneof(
  { arbitrary: fc.array(arbCommitRecord, { maxLength: 8 }), weight: 6 },
  { arbitrary: fc.array(arbCommitRecord, { minLength: 9, maxLength: 64, size: 'max' }), weight: 2 },
  {
    arbitrary: fc.array(arbCommitRecord, {
      minLength: 460,
      maxLength: MAX_COMMIT_RECORDS,
      size: 'max',
    }),
    weight: 2,
  },
);

// ---------------------------------------------------------------------------------------------
// Explicit examples: the base case, single records, and the exact ceiling, on every run
// ---------------------------------------------------------------------------------------------

/** Cyclic pick from a pool known to be non-empty, so `noUncheckedIndexedAccess` is satisfied. */
function pick<T>(pool: readonly T[], index: number): T {
  const value = pool[index % pool.length];
  if (value === undefined) {
    throw new Error('pick: pool is empty');
  }
  return value;
}

/** Hashes at both ends of `HEXDIGIT{7,40}`, with mixed case, which the parser preserves. */
const EXAMPLE_HASHES: readonly string[] = [
  'abcdef1',
  'ABCDEF0',
  '0123456789abcdef',
  'dEaDbEeF0123',
  '0f1e2d3c4b5a69788796a5b4c3d2e1f00fedcba9',
];

/** Author names spanning ASCII, the non-ASCII BMP, combining marks, and above U+FFFF (Req 4.2). */
const EXAMPLE_NAMES: readonly string[] = [
  'Ann Lee',
  'Ámbar Núñez',
  'a\u0301 combining acute',
  '漢字 著者',
  '\u{1F680} Rocket Reviewer',
  '\u{20BB7}\u{1D11E} astral pair',
];

/** Author dates: git's default human-readable form and the opaque text the parser also allows. */
const EXAMPLE_DATES: readonly string[] = [
  'Mon Sep 21 10:04:11 2026 +0000',
  'Thu Jan 01 00:00:00 1970 -0700',
  '2026-09-21',
  'vor 3 Tagen',
];

/**
 * Subjects covering the cases the round trip turns on: empty (Req 4.3, printed as no body line),
 * plain text, significant leading and trailing whitespace, a subject already carrying the
 * four-space indent (ambiguity 3), and code points above U+FFFF.
 */
const EXAMPLE_SUBJECTS: readonly string[] = [
  '',
  'wire the parser into generation',
  '  padded subject with trailing spaces  ',
  '    subject that arrives pre-indented',
  'ship it \u{1F389} and an e\u0303',
];

/** A deterministic record, varied across the four fields by index. */
function exampleRecord(index: number): CommitRecord {
  return {
    hash: pick(EXAMPLE_HASHES, index),
    authorName: pick(EXAMPLE_NAMES, index),
    authorDate: pick(EXAMPLE_DATES, index),
    subject: pick(EXAMPLE_SUBJECTS, index),
  };
}

/** Exactly `MAX_COMMIT_RECORDS` records: the largest list the printer accepts. */
const CEILING_LIST: readonly CommitRecord[] = Array.from(
  { length: MAX_COMMIT_RECORDS },
  (_unused, index) => exampleRecord(index),
);

/**
 * Cases run on every execution rather than left to the random stream: the empty list (the base case
 * of Req 4.8, which prints as the empty string), a single record with a subject, a single record
 * with no subject, and a list sitting exactly on the 500-record ceiling.
 */
const EXAMPLES: [readonly CommitRecord[]][] = [
  [[]],
  [[exampleRecord(1)]],
  [[{ ...exampleRecord(2), subject: '' }]],
  [CEILING_LIST],
];

// ---------------------------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------------------------

/** Code points, not UTF-16 units, so a failure report shows which code point changed (Req 4.2). */
function codePoints(text: string): string[] {
  return [...text];
}

/** The scalar value of a single code point. `0` for the empty string, which no caller passes. */
function scalarValue(codePoint: string): number {
  return codePoint.codePointAt(0) ?? 0;
}

/** True when any code point of `text` sits above `below`, measured as a scalar value. */
function carriesCodePointAbove(text: string, below: number): boolean {
  return codePoints(text).some((codePoint) => scalarValue(codePoint) > below);
}

/** The four fields Req 4.6 scopes the round trip to. Email is outside it by design. */
function roundTrippedFields(
  record: CommitRecord,
): Pick<CommitRecord, 'hash' | 'authorName' | 'authorDate' | 'subject'> {
  return {
    hash: record.hash,
    authorName: record.authorName,
    authorDate: record.authorDate,
    subject: record.subject,
  };
}

describe('Commit_Log_Printer to Commit_Log_Parser round trip', () => {
  it('parses printed text back into the same records, field for field, in the same order', () => {
    // Non-vacuity accounting for the `fc.pre` scoping, asserted after `fc.assert` returns.
    const printerRejections: string[] = [];
    let accepted = 0;
    let ceilingLists = 0;
    let emptySubjects = 0;
    let nonAsciiNames = 0;
    let astralNames = 0;

    // Feature: devlog-narrator, Property 1: For any list of Commit_Records that the
    // Commit_Log_Printer prints without error, parsing the printed text with the Commit_Log_Parser
    // succeeds and yields a list of the same length whose commit hash, author name, author date, and
    // subject fields equal those of the original list, in the same order.
    fc.assert(
      fc.property(arbPrintableRecordList, (records) => {
        const printed = printCommitLog(records);

        // Property 1 is scoped to lists the printer prints without error. The input space is built
        // to satisfy the printer's rejection rules, so this precondition is expected to discard
        // nothing; every discard is recorded and fails the test below, because a precondition that
        // quietly ate the input space would leave the property vacuous and still green.
        if (!printed.ok) {
          printerRejections.push(printed.error.kind);
        }
        fc.pre(printed.ok);

        accepted += 1;
        if (records.length === MAX_COMMIT_RECORDS) {
          ceilingLists += 1;
        }
        for (const record of records) {
          if (record.subject === '') {
            emptySubjects += 1;
          }
          if (carriesCodePointAbove(record.authorName, 0x7f)) {
            nonAsciiNames += 1;
          }
          if (carriesCodePointAbove(record.authorName, 0xffff)) {
            astralNames += 1;
          }
        }

        // Req 4.5: the printer emits LF line endings only, so nothing in the text is a CR acting as
        // a terminator. The parser treats a lone CR as an ordinary character, so a stray CR would
        // not fail the round trip — it would silently move into a field — which is why this is
        // asserted on the text rather than inferred from the records.
        expect(printed.text).not.toContain('\r');

        const parsed = parseCommitLog(printed.text);

        // Parsing SUCCEEDS: the result is the `ok` branch, not merely a call that did not throw.
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
          throw new Error(
            `parse of printed text failed: ${parsed.error.kind} at line ${String(parsed.error.line)}`,
          );
        }

        // Same length: one Commit_Record out for every Commit_Record in.
        expect(parsed.records).toHaveLength(records.length);

        // All four fields, in the same order. One structural comparison states the whole clause and
        // localizes a mismatch to an index; the per-record checks below state it code point for code
        // point, which is what makes a Unicode normalization or a lost surrogate half visible.
        expect(parsed.records.map(roundTrippedFields)).toEqual(records.map(roundTrippedFields));

        records.forEach((expectedRecord, index) => {
          const actual = parsed.records[index];
          if (actual === undefined) {
            throw new Error(`no Commit_Record at index ${String(index)}`);
          }

          expect(codePoints(actual.hash)).toEqual(codePoints(expectedRecord.hash));
          expect(codePoints(actual.authorName)).toEqual(codePoints(expectedRecord.authorName));
          expect(codePoints(actual.authorDate)).toEqual(codePoints(expectedRecord.authorDate));
          expect(codePoints(actual.subject)).toEqual(codePoints(expectedRecord.subject));
        });
      }),
      { numRuns: 100, examples: EXAMPLES },
    );

    // The accepted set is neither empty nor degenerate: the ceiling, the no-subject case, and author
    // names outside ASCII and above U+FFFF all reached the assertions above. The explicit examples
    // alone satisfy every count, so these are guarantees rather than statistical hopes.
    expect(printerRejections).toEqual([]);
    expect(accepted).toBeGreaterThanOrEqual(100);
    expect(ceilingLists).toBeGreaterThan(0);
    expect(emptySubjects).toBeGreaterThan(0);
    expect(nonAsciiNames).toBeGreaterThan(0);
    expect(astralNames).toBeGreaterThan(0);
  });
});
