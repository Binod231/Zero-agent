import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCommitLog } from '../../src/core/commit-log-parser';
import type { CommitRecord, ParseResult } from '../../src/core/types';
import {
  arbCommitLogText,
  arbMalformedCommitLogText,
  arbUnicodeText,
  arbWhitespaceOnlyText,
  fullUnicodeString,
  toLf,
  WHITESPACE_CODE_POINTS,
} from '../generators';

/**
 * **Property 2: Commit log parsing is total and deterministic.**
 *
 * **Validates: Requirements 4.4, 4.10**
 *
 * The four clauses of the property, and how each is checked:
 *
 * - *Never throwing.* Every call goes through {@link parseTotally}, which catches. A throw is
 *   therefore observed and reported as a failure rather than being inferred from the test having
 *   passed — an uncaught throw would surface as an error somewhere in the run, but nothing would
 *   pin it to the input that caused it.
 * - *Either a list or an error, never both.* Checked on the returned object's own keys rather than
 *   on its static type, because the static type is exactly what a parser bug would violate.
 * - *A 1-based line number between 1 and the number of lines in the input.* See
 *   {@link grammarLineCount} for how the line count is derived.
 * - *Two invocations on identical input return identical results.* Deep equality, with an
 *   unrelated parse interleaved between the two so that a cached result, a regular expression
 *   holding `lastIndex`, or any other hidden mutable state would break the comparison instead of
 *   being hidden by two back-to-back calls.
 *
 * **On "up to 262144 bytes".** The bound is Req 9.3's request-body limit, which is what reaches the
 * parser in production; it is not a precondition the parser is allowed to lean on. The generator
 * reaches the bound (see {@link arbNearByteBoundText}) and the examples sit exactly on it, and
 * nothing here excludes larger input — totality above the bound is a superset of the obligation.
 */

/** Req 9.3's request-body limit, in UTF-8 bytes: the input size the property quantifies over. */
const MAX_INPUT_BYTES = 262_144;

/** `Hash ::= HEXDIGIT{7,40}` from the design grammar, for the record-shape check. */
const HASH_PATTERN = /^[0-9a-fA-F]{7,40}$/u;

/** The two `ParseError` discriminants of the design's interface. Nothing else is well-formed. */
const PARSE_ERROR_KINDS = ['MALFORMED', 'TOO_MANY_COMMITS'];

/**
 * A conforming two-entry log, parsed between the two invocations on the generated input so the
 * determinism comparison spans a state change rather than two adjacent calls.
 */
const CANARY_LOG = [
  'commit 0f1e2d3c4b5a690',
  'Author: Canary <canary@localhost>',
  'Date: Mon Sep 14 09:00:00 2026 +0000',
  '',
  '    first canary subject',
  '',
  'commit abcdef0123456789',
  'Author: Canary <canary@localhost>',
  'Date: Tue Sep 15 09:00:00 2026 +0000',
  '',
  '    second canary subject',
  '',
].join('\n');

const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The number of lines in `text` under the design grammar.
 *
 * The grammar is `EOL ::= "\r\n" | "\n" | <end of input>`, so exactly two sequences terminate a
 * line and a lone CR is an ordinary character inside a field (design, *Commit_Log_Parser*,
 * resolved ambiguity 2). Splitting on those two sequences therefore counts lines, and splitting on
 * `\r` as well would over-count every field that carries a stray CR — the CRLF equivalence of
 * Req 4.2 depends on that CR not being a boundary.
 *
 * Because `EOL` admits end of input, a text ending in a terminator has one final empty line, which
 * the grammar reads as a `BlankLine` and which this count includes. That matters for the upper
 * bound of clause (c): on `'commit abcdef0\n'` the parser wants an `Author` line at that final
 * empty line and reports line 2, while a reader eyeballing the paste would say it holds one line.
 * The grammar's count is the one used here, because it is the count the design's line numbering is
 * expressed in; a stricter count would make a truncated paste — the most ordinary malformed input
 * there is — report out of range.
 */
function grammarLineCount(text: string): number {
  return text.split(/\r\n|\n/u).length;
}

type TotalCall = { threw: false; result: ParseResult } | { threw: true; thrown: unknown };

/** Calls the parser and reports a throw as data, so clause (b) is observed rather than assumed. */
function parseTotally(text: string): TotalCall {
  try {
    return { threw: false, result: parseCommitLog(text) };
  } catch (thrown: unknown) {
    return { threw: true, thrown };
  }
}

/** Names a thrown value without stringifying it: the value may be anything at all. */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    return `${thrown.name}: ${thrown.message}`;
  }
  return `a non-Error value of type ${typeof thrown}`;
}

/** Input size, for a failure message. The text itself can be 256 KB, so it is described, not shown. */
function describeInput(text: string): string {
  return `input of ${String([...text].length)} code points / ${String(utf8ByteLength(text))} bytes`;
}

/** Fails with a message naming the input when the call threw; narrows the call to the value case. */
function requireNoThrow(call: TotalCall, text: string, label: string): ParseResult {
  if (call.threw) {
    throw new Error(
      `parseCommitLog threw on ${label} (${describeInput(text)}): ${describeThrown(call.thrown)}`,
    );
  }
  return call.result;
}

/**
 * The shape of a returned Commit_Record list: an array of records whose four fields are all strings
 * and whose hash matches the grammar. What the field *values* mean is Property 4's obligation; this
 * checks only that the success branch really carries a Commit_Record list.
 */
function assertRecordListShape(records: readonly CommitRecord[]): void {
  expect(Array.isArray(records), 'the success branch must carry an array of Commit_Records').toBe(
    true,
  );
  for (const record of records) {
    expect(typeof record.hash).toBe('string');
    expect(typeof record.authorName).toBe('string');
    expect(typeof record.authorDate).toBe('string');
    expect(typeof record.subject).toBe('string');
    expect(record.hash).toMatch(HASH_PATTERN);
  }
}

/** Clauses (a) and (c): the discriminated union is well-formed and any line number is in range. */
function assertWellFormedResult(result: ParseResult, lineCount: number): void {
  expect(typeof result.ok, 'the `ok` discriminant must be a boolean').toBe('boolean');

  // Exactly one of the two shapes: `records` present if and only if `ok`, `error` present if and
  // only if not. Read off the object's own keys, so "both" and "neither" are both failures.
  expect(
    { records: Object.hasOwn(result, 'records'), error: Object.hasOwn(result, 'error') },
    'exactly one of `records` and `error` must be present, matching the `ok` discriminant',
  ).toStrictEqual({ records: result.ok, error: !result.ok });

  if (result.ok) {
    assertRecordListShape(result.records);
    return;
  }

  const { error } = result;
  expect(PARSE_ERROR_KINDS).toContain(error.kind);
  expect(Number.isInteger(error.line), 'the reported line number must be an integer').toBe(true);
  expect(error.line).toBeGreaterThanOrEqual(1);
  expect(error.line).toBeLessThanOrEqual(lineCount);
  if (error.kind === 'MALFORMED') {
    // Req 4.4's "identifying ... line" is only useful alongside what was expected there.
    expect(typeof error.expected).toBe('string');
    expect(error.expected.length).toBeGreaterThan(0);
  } else {
    expect(error.limit).toBe(500);
  }
}

// ---------------------------------------------------------------------------------------------
// Hostile input generators
//
// Local to this file rather than added to `test/generators.ts`: totality is the one property whose
// input space is *every* string, so these families are deliberately degenerate — lone surrogates,
// NUL bytes, quarter-megabyte single lines — and no other property wants them. Everything
// structural is reused from the shared module.
// ---------------------------------------------------------------------------------------------

/** Unpaired UTF-16 surrogates. No `fast-check` string generator emits these; they must be injected. */
const LONE_SURROGATES: readonly string[] = ['\uD800', '\uDBFF', '\uDC00', '\uDFFF'];

/** NUL and friends: control and format code points that are not whitespace and not printable. */
const HOSTILE_CONTROL_CHARS: readonly string[] = [
  '\u0000', // NUL
  '\u0001',
  '\u0008', // BACKSPACE
  '\u001B', // ESCAPE
  '\u007F', // DELETE
  '\u0085', // NEXT LINE: a line break to Unicode, not a terminator to this grammar
  '\u200B', // ZERO WIDTH SPACE: not White_Space, despite the name
  '\uFEFF', // BYTE ORDER MARK
  '\uFFFD', // REPLACEMENT CHARACTER
  '\uFFFE', // a noncharacter
];

/** Fragments that look like the start of a production, so hostile text lands on real parse paths. */
const GRAMMAR_FRAGMENTS: readonly string[] = [
  'commit ',
  'commit abcdef0',
  'Merge: ',
  'Author: ',
  'Author: n <e>',
  'Date: ',
  'Date: d',
  '    ',
  '<',
  '>',
];

/** Terminator sequences and near-misses, including the lone CR the design keeps as a plain character. */
const LINE_BREAK_FRAGMENTS: readonly string[] = ['\n', '\r\n', '\r', '\r\r', '\n\r', '\r\n\r'];

const arbHostileUnit: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.constantFrom(...LONE_SURROGATES), weight: 2 },
  { arbitrary: fc.constantFrom(...HOSTILE_CONTROL_CHARS), weight: 2 },
  { arbitrary: fc.constantFrom(...LINE_BREAK_FRAGMENTS), weight: 3 },
  { arbitrary: fc.constantFrom(...WHITESPACE_CODE_POINTS), weight: 2 },
  { arbitrary: fc.constantFrom(...GRAMMAR_FRAGMENTS), weight: 4 },
  { arbitrary: arbUnicodeText({ minLength: 1, maxLength: 4 }), weight: 3 },
);

/** Noise assembled from the fragments above: grammar-shaped debris with hostile code points in it. */
const arbHostileText: fc.Arbitrary<string> = fc
  .array(arbHostileUnit, { maxLength: 80 })
  .map((parts) => parts.join(''));

/**
 * A conforming log whose terminators are rewritten to a repeating mix of LF, CRLF, and lone CR, so
 * the grammar's two terminators and the ordinary-character CR meet inside one input.
 */
const arbLineEndingMixText: fc.Arbitrary<string> = fc
  .tuple(
    arbCommitLogText,
    fc.array(fc.constantFrom(...LINE_BREAK_FRAGMENTS), { minLength: 1, maxLength: 6 }),
  )
  .map(([text, breaks]) => {
    let index = 0;
    return toLf(text).replace(/\n/gu, () => {
      const replacement = breaks[index % breaks.length] ?? '\n';
      index += 1;
      return replacement;
    });
  });

/** One line of 30000 to 90000 repeats of a single unit, with no terminator anywhere in it. */
const arbVeryLongSingleLine: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('', 'commit ', 'Author: ', 'Date: ', '    '),
    fc.constantFrom('a', '0', 'x', ' ', '\u{1F600}', '\u0000', '\uD800', '\u0301'),
    fc.integer({ min: 30_000, max: 90_000 }),
  )
  .map(([prefix, unit, count]) => `${prefix}${unit.repeat(count)}`);

/** Repeats `unit` as many whole times as fit in `maxBytes` of UTF-8. */
function repeatToByteBudget(unit: string, maxBytes: number): string {
  const unitBytes = utf8ByteLength(unit);
  return unit.repeat(Math.max(1, Math.floor(maxBytes / unitBytes)));
}

const ONE_CONFORMING_ENTRY = 'commit abcdef0\nAuthor: n <e>\nDate: d\n\n    s\n\n';

/** Units whose repetition fills the byte budget in different ways: 1, 2, 3, and 4 bytes per unit. */
const BYTE_BOUND_UNITS: readonly string[] = [
  'a',
  ONE_CONFORMING_ENTRY,
  '\u00e9',
  '\u3000',
  '\u{1F600}',
  '\r\n',
  '\u0000',
  'commit \n',
];

/** Input within 256 bytes of the 262144-byte bound of Req 4.10 and Req 9.3. */
const arbNearByteBoundText: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...BYTE_BOUND_UNITS),
    fc.integer({ min: MAX_INPUT_BYTES - 256, max: MAX_INPUT_BYTES }),
  )
  .map(([unit, bytes]) => repeatToByteBudget(unit, bytes));

/**
 * The property's input space. The first four branches are the design's test note verbatim —
 * `arbCommitLogText`, `arbMalformedCommitLogText`, `fc.fullUnicodeString()` (spelled
 * {@link fullUnicodeString} for `fast-check` 4), and `fc.string()`. The rest are the hostile
 * families, because totality over "all text inputs" is not demonstrated by well-formed logs and
 * uniform random strings alone: neither ever produces a lone surrogate, a quarter-megabyte line, or
 * a mixed-terminator log.
 */
const arbParserInput: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: arbCommitLogText, weight: 6 },
  { arbitrary: arbMalformedCommitLogText, weight: 6 },
  { arbitrary: fullUnicodeString(), weight: 4 },
  { arbitrary: fc.string(), weight: 4 },
  { arbitrary: arbHostileText, weight: 6 },
  { arbitrary: arbLineEndingMixText, weight: 3 },
  { arbitrary: arbWhitespaceOnlyText({ maxLength: 40 }), weight: 2 },
  { arbitrary: arbVeryLongSingleLine, weight: 1 },
  { arbitrary: arbNearByteBoundText, weight: 1 },
);

/** 501 conforming entries: the `TOO_MANY_COMMITS` line number is in range too (Req 4.1, 4.4). */
const OVER_LIMIT_LOG = ONE_CONFORMING_ENTRY.repeat(501);

/**
 * Named hostile inputs, run before the random ones so each is checked on every run rather than
 * whenever sampling happens to reach it. `numRuns` is raised by this count below, so the 100
 * randomly generated runs the design requires are 100 runs *in addition* to these.
 */
const PARSER_INPUT_EXAMPLES: [string][] = [
  // Empty and terminator-only.
  [''],
  ['\n'],
  ['\r'],
  ['\r\n'],
  ['\n\r'],
  ['\r\r\n\n\r'],
  // Whitespace only, by the Unicode White_Space property (Req 4.8).
  [WHITESPACE_CODE_POINTS.join('')],
  ['\u3000\u00a0\u2028\u2029\u1680'],
  ['    \n    \n    '],
  // Lone surrogates, alone and inside fields.
  ['\uD800'],
  ['\uDFFF\uD800'],
  ['commit abcdef\uD800\n'],
  [`commit abcdef0\nAuthor: \uD800 <\uDC00>\nDate: \uDBFF\n\n    \uD800\n`],
  // NUL bytes.
  ['\u0000'],
  ['commit abcdef0\u0000\n'],
  [`commit abcdef0\nAuthor: n\u0000 <e>\nDate: \u0000d\n\n    \u0000\n`],
  ['    \u0000\n'],
  // CRLF and lone CR mixes, including a CR inside every field.
  ['commit abcdef0\r\nAuthor: n <e>\r\nDate: d\r\n\r\n    s\r\n'],
  ['commit abcdef0\r\nAuthor: n\r <e>\rDate: d\n\n    s\r\n\r'],
  ['commit abcdef0\rAuthor: n <e>\rDate: d\r\r    s\r'],
  // Truncated entries: the scan runs off the end of the input rather than onto a bad line.
  ['commit abcdef0'],
  ['commit abcdef0\n'],
  ['commit abcdef0\nAuthor: n <e>\n'],
  ['commit abcdef0\nAuthor: n <e>\nDate: d\n'],
  // Very long single lines, with no terminator to break the scan up.
  ['a'.repeat(MAX_INPUT_BYTES)],
  [`commit ${'a'.repeat(200_000)}`],
  [`    ${'x'.repeat(100_000)}`],
  ['\u0000'.repeat(100_000)],
  // Exactly on and just under the 262144-byte bound, in 1-, 2-, 3-, and 4-byte units.
  [repeatToByteBudget('a', MAX_INPUT_BYTES)],
  [repeatToByteBudget(ONE_CONFORMING_ENTRY, MAX_INPUT_BYTES)],
  [repeatToByteBudget('\u00e9', MAX_INPUT_BYTES)],
  [repeatToByteBudget('\u3000', MAX_INPUT_BYTES)],
  [repeatToByteBudget('\u{1F600}', MAX_INPUT_BYTES)],
  [repeatToByteBudget('\r\n', MAX_INPUT_BYTES)],
  // Over the commit-entry ceiling, and over the byte bound: neither is a precondition.
  [OVER_LIMIT_LOG],
  [`${'a'.repeat(MAX_INPUT_BYTES)}\n${'b'.repeat(4096)}`],
  // A BOM ahead of an otherwise conforming log, which is what a pasted file often carries.
  [`\uFEFF${CANARY_LOG}`],
  // Deeply indented and over-indented body lines.
  [`commit abcdef0\nAuthor: n <e>\nDate: d\n\n${'    '.repeat(64)}subject\n`],
];

describe('Commit_Log_Parser: totality and determinism (Property 2)', () => {
  it('returns a well-formed result with an in-range line number, and repeats it exactly', () => {
    // Feature: devlog-narrator, Property 2: For all text inputs of up to 262144 bytes, the
    // Commit_Log_Parser returns either a Commit_Record list or an error carrying a 1-based line
    // number between 1 and the number of lines in the input, never throwing and never returning
    // both; and two invocations on identical input return identical results.
    fc.assert(
      fc.property(arbParserInput, (text) => {
        const first = requireNoThrow(parseTotally(text), text, 'the first invocation');
        assertWellFormedResult(first, grammarLineCount(text));

        // An unrelated parse between the two invocations, so hidden per-call state cannot hide.
        requireNoThrow(parseTotally(CANARY_LOG), CANARY_LOG, 'the interleaved canary parse');

        const second = requireNoThrow(parseTotally(text), text, 'the second invocation');
        expect(
          second,
          'two invocations on identical input must return identical results',
        ).toStrictEqual(first);
      }),
      {
        // The design's floor is 100 iterations. The named examples run first and consume iterations,
        // so the floor is raised by their count rather than shared with them.
        numRuns: 100 + PARSER_INPUT_EXAMPLES.length,
        examples: PARSER_INPUT_EXAMPLES,
      },
    );
  });
});
