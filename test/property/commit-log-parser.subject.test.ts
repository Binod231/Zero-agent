import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { codePointLength } from '../../src/core/code-points';
import { parseCommitLog } from '../../src/core/commit-log-parser';
import {
  arbAuthorDate,
  arbAuthorEmail,
  arbAuthorName,
  arbCommitHash,
  arbCommitLogModelOf,
  arbNonWhitespaceCodePoint,
  arbUnicodeText,
  arbWhitespaceOnlyText,
  expectedCommitRecords,
  renderCommitLog,
} from '../generators';
import type { CommitEntryModel, CommitLogModel } from '../generators';

/**
 * **Property 4** of the design's *Correctness Properties*, and the only test that implements it.
 *
 * This is the design's model-based test: the input is a structured {@link CommitLogModel} holding a
 * *known* number of body lines per entry, `renderCommitLog` turns that model into Commit_Log text,
 * and the expectation is computed from the model — never from the parser — so the two can genuinely
 * disagree. `test/generators.ts` already exports the model type, the renderer, and
 * {@link expectedCommitRecords}, so all three are reused rather than reimplemented; what this file
 * adds is a body-line generator that forces the design's three resolved ambiguities to appear, which
 * the shared entry generator deliberately does not do (it strips CR from every field so that the
 * CRLF-equivalence property of Req 4.2 has an unambiguous input space).
 *
 * The four criteria under test:
 *
 * - **Req 4.1** — records appear in the order of appearance. Asserted as deep equality against the
 *   model's expected list, which is ordered.
 * - **Req 4.3** — zero body lines yields a subject of zero characters, with hash, author name, and
 *   author date retained.
 * - **Req 4.8** — empty and whitespace-only input yields an empty record list and no error.
 * - **Req 4.9** — two or more body lines yields the first body line as the subject, the rest
 *   excluded.
 *
 * Nothing here calls AWS, reads the clock, or touches the filesystem.
 */

// ---------------------------------------------------------------------------------------------
// Body lines: the three resolved ambiguities of the design's Commit_Log_Parser grammar
// ---------------------------------------------------------------------------------------------

/**
 * Makes a generated fragment safe to sit inside one body line *without* weakening what the property
 * checks.
 *
 * Two edits, both about the renderer rather than about the parser:
 *
 * - An LF becomes a space, because the grammar's `BodyLine` holds `CHAR*` and `CHAR` excludes LF: a
 *   fragment carrying one would render as two lines and the model would no longer describe the text.
 * - A **trailing** CR is dropped. Ambiguity 2 keeps a lone CR as an ordinary character, but a CR
 *   immediately before an LF terminator *is* the CRLF terminator, so `····x\r` rendered with LF
 *   endings encodes the subject `x`, not `x\r`. That is the grammar agreeing with itself, not a
 *   parser defect, so the generator declines to claim otherwise. A CR anywhere else in the fragment
 *   is kept, and {@link arbLoneCarriageReturnBody} guarantees that case appears.
 */
function sanitizeBodyFragment(fragment: string): string {
  return fragment.replace(/\n/gu, ' ').replace(/\r+$/u, '');
}

/** Ordinary content: one guaranteed non-whitespace code point plus arbitrary Unicode. */
const arbPlainBody: fc.Arbitrary<string> = fc
  .tuple(arbNonWhitespaceCodePoint, arbUnicodeText({ maxLength: 30 }))
  .map(([head, tail]) => `${head}${sanitizeBodyFragment(tail)}`);

/**
 * Ambiguity 3, trailing half: whitespace at the end of a body line is significant, so `····fix bug··`
 * must yield `fix bug··` and not `fix bug`.
 */
const arbTrailingWhitespaceBody: fc.Arbitrary<string> = fc
  .tuple(
    arbNonWhitespaceCodePoint,
    arbUnicodeText({ maxLength: 20 }),
    fc.string({ unit: fc.constantFrom(' ', '\t', '\u00A0'), minLength: 1, maxLength: 4 }),
  )
  .map(([head, middle, trailing]) => `${head}${sanitizeBodyFragment(middle)}${trailing}`);

/**
 * Ambiguity 3, leading half: only the four-space indent is stripped, so a line indented eight spaces
 * yields a subject carrying four leading spaces.
 */
const arbExtraIndentBody: fc.Arbitrary<string> = fc
  .tuple(arbNonWhitespaceCodePoint, arbUnicodeText({ maxLength: 20 }))
  .map(([head, tail]) => `    ${head}${sanitizeBodyFragment(tail)}`);

/**
 * Ambiguity 2: a lone CR is an ordinary character, so it may sit inside a subject. The fragment ends
 * with a non-whitespace code point, which keeps the CR away from the line terminator — see
 * {@link sanitizeBodyFragment}.
 */
const arbLoneCarriageReturnBody: fc.Arbitrary<string> = fc
  .tuple(
    arbUnicodeText({ maxLength: 12 }),
    arbNonWhitespaceCodePoint,
    arbUnicodeText({ maxLength: 12 }),
    arbNonWhitespaceCodePoint,
  )
  .map(
    ([prefix, afterCr, middle, tail]) =>
      `${sanitizeBodyFragment(prefix)}\r${afterCr}${sanitizeBodyFragment(middle)}${tail}`,
  );

/**
 * Body line content, meaning the text *after* the four-space indent. Every branch holds at least one
 * non-whitespace code point, which is what makes it a `BodyLine` rather than the `BlankLine` of
 * ambiguity 1.
 */
const arbBodyLineContent: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: arbPlainBody, weight: 4 },
  { arbitrary: arbTrailingWhitespaceBody, weight: 3 },
  { arbitrary: arbExtraIndentBody, weight: 2 },
  { arbitrary: arbLoneCarriageReturnBody, weight: 3 },
);

/**
 * The three body-line counts Property 4 distinguishes, each about a third of draws: none (Req 4.3),
 * exactly one, and two or more (Req 4.9).
 */
const arbBodyLines: fc.Arbitrary<string[]> = fc.oneof(
  { arbitrary: fc.constant<string[]>([]), weight: 1 },
  { arbitrary: fc.array(arbBodyLineContent, { minLength: 1, maxLength: 1 }), weight: 1 },
  { arbitrary: fc.array(arbBodyLineContent, { minLength: 2, maxLength: 4 }), weight: 1 },
);

/**
 * Ambiguity 1: a line of exactly four spaces — or four spaces followed only by whitespace — is a
 * `BlankLine` that terminates the body section, not a body line whose subject is whitespace.
 *
 * Weighted heavily towards that shape, because it is the one blank-line spelling that can be
 * mistaken for a body line, and it is decisive for an entry with zero body lines: read as a body
 * line it would give that entry a whitespace subject where Req 4.3 requires zero characters.
 */
const arbBlankLineContent: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.constant(''), weight: 3 },
  { arbitrary: fc.constantFrom(' ', '\t', '  \t', '   '), weight: 2 },
  { arbitrary: fc.constantFrom('    ', '     ', '    \t', '    \u00A0', '      \t '), weight: 4 },
);

const arbPadding: fc.Arbitrary<{ left: string; right: string }> = fc.record({
  left: fc.string({ unit: fc.constantFrom(' ', '\t'), maxLength: 2 }),
  right: fc.string({ unit: fc.constantFrom(' ', '\t'), maxLength: 2 }),
});

/**
 * One commit entry. `Merge` lines appear on about half of entries rather than the shared generator's
 * quarter: Req 4.9 says nothing about merges, so the property has to show that the optional line
 * moves the header down by one without moving the subject.
 */
const arbEntryModel: fc.Arbitrary<CommitEntryModel> = fc.record({
  hash: arbCommitHash,
  mergeLine: fc.oneof(
    { arbitrary: fc.constant<string | null>(null), weight: 1 },
    {
      arbitrary: fc
        .tuple(arbCommitHash, arbCommitHash)
        .map(([left, right]) => `${left.slice(0, 7)} ${right.slice(0, 7)}`),
      weight: 1,
    },
  ),
  authorName: arbAuthorName,
  authorNamePadding: arbPadding,
  email: arbAuthorEmail,
  authorDate: arbAuthorDate,
  authorDatePadding: arbPadding,
  blankAfterDate: arbBlankLineContent,
  bodyLines: arbBodyLines,
});

/**
 * A Commit_Log model with the given entry count, whose every blank line is redrawn from
 * {@link arbBlankLineContent} so the four-space spelling of ambiguity 1 lands in the three positions
 * that bear on subject extraction: before the first entry, between entries (immediately after a body
 * section), and after the last entry.
 */
function arbSubjectLogModel(minEntries: number, maxEntries: number): fc.Arbitrary<CommitLogModel> {
  return arbCommitLogModelOf({ minEntries, maxEntries, entry: arbEntryModel }).chain((model) => {
    const separatorGroups = Math.max(model.entries.length - 1, 0);
    return fc
      .record({
        leadingBlankLines: fc.array(arbBlankLineContent, { maxLength: 2 }),
        separatorBlankLines: fc.array(
          fc.array(arbBlankLineContent, { minLength: 1, maxLength: 2 }),
          { minLength: separatorGroups, maxLength: separatorGroups },
        ),
        trailingBlankLines: fc.array(arbBlankLineContent, { maxLength: 2 }),
      })
      .map((blankLines): CommitLogModel => ({ ...model, ...blankLines }));
  });
}

/**
 * One case for the property: the text handed to the parser, and the model it was rendered from.
 *
 * `model` is `null` for the raw inputs of Req 4.8 — the empty string and whitespace-only text — which
 * are not rendered from a model and whose expectation is simply the empty record list. Carrying them
 * through the same property rather than a second `fc.assert` keeps Property 4 to one test, as the
 * design's conventions require.
 */
interface SubjectCase {
  text: string;
  model: CommitLogModel | null;
}

const arbModelCase: fc.Arbitrary<SubjectCase> = fc
  .oneof(
    // Zero entries: a model that renders to blank lines only, which is the Req 4.8 case reached
    // through the model path.
    { arbitrary: arbSubjectLogModel(0, 0), weight: 1 },
    { arbitrary: arbSubjectLogModel(1, 3), weight: 6 },
    { arbitrary: arbSubjectLogModel(4, 8), weight: 3 },
  )
  .map((model): SubjectCase => ({ text: renderCommitLog(model), model }));

/**
 * The Req 4.8 inputs stated directly: zero characters, and whitespace-only text drawn from the
 * Unicode `White_Space` property. `'    '` and `'\r'` are named explicitly — the first is ambiguity 1
 * with no entry around it, the second is ambiguity 2's lone CR as the whole input.
 */
const arbBlankInputCase: fc.Arbitrary<SubjectCase> = fc
  .oneof(
    { arbitrary: fc.constant(''), weight: 2 },
    { arbitrary: arbWhitespaceOnlyText({ maxLength: 16 }), weight: 4 },
    {
      arbitrary: fc.constantFrom('    ', '\r', '\n', '\r\n', '   \n\t\n', '    \n     \n    '),
      weight: 3,
    },
  )
  .map((text): SubjectCase => ({ text, model: null }));

const arbSubjectCase: fc.Arbitrary<SubjectCase> = fc.oneof(
  { arbitrary: arbModelCase, weight: 8 },
  { arbitrary: arbBlankInputCase, weight: 2 },
);

/**
 * The expected subject, computed from the model alone: the first body line when there is one,
 * otherwise zero characters. The renderer adds the four-space indent, so the model's stored content
 * *is* the indent-stripped subject — which is the whole of Req 4.3 and Req 4.9 restated as data.
 */
function expectedSubject(entry: CommitEntryModel): string {
  return entry.bodyLines[0] ?? '';
}

describe('Commit_Log_Parser subject extraction', () => {
  it('takes the subject from the first body line and retains the header fields', () => {
    // Feature: devlog-narrator, Property 4: For any Commit_Log whose commit entries each carry a
    // known number of body lines, every produced Commit_Record has a subject equal to the first body
    // line of its entry with exactly the four-space indent removed when at least one body line is
    // present, and a subject of zero characters when no body line is present, and in every case
    // retains the commit hash, author name, and author date of that entry.
    fc.assert(
      fc.property(arbSubjectCase, ({ text, model }) => {
        const result = parseCommitLog(text);

        // Req 4.8, and the grammar-conformance half of Req 4.1: none of these inputs is an error.
        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        const records = result.records;

        if (model === null) {
          // Req 4.8: empty or whitespace-only input, zero records, no error.
          expect(records).toEqual([]);
          return;
        }

        // Req 4.1: one record per entry, in the order the entries appear.
        expect(records).toHaveLength(model.entries.length);
        expect(records).toEqual(expectedCommitRecords(model));

        model.entries.forEach((entry, index) => {
          const record = records[index];
          if (record === undefined) {
            throw new Error(`no Commit_Record at index ${String(index)}`);
          }

          // Req 4.3, second clause: the header fields survive in every case, body lines or not.
          expect(record.hash).toBe(entry.hash);
          expect(record.authorName).toBe(entry.authorName);
          expect(record.authorDate).toBe(entry.authorDate);

          const subject = expectedSubject(entry);
          expect(record.subject).toBe(subject);

          if (entry.bodyLines.length === 0) {
            // Req 4.3, first clause: zero *code points*, not merely a falsy string.
            expect(codePointLength(record.subject)).toBe(0);
          } else {
            // Req 4.9: the remaining body lines are excluded from the subject. Equality with the
            // first line already says so; naming the later lines says it in the form the criterion
            // is written in, and fails loudly if a later line were ever chosen instead.
            for (const laterLine of entry.bodyLines.slice(1)) {
              if (laterLine !== subject) {
                expect(record.subject).not.toBe(laterLine);
              }
            }
          }
        });
      }),
      { numRuns: 100 },
    );
  });
});
