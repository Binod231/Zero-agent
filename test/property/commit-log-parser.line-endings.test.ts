import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCommitLog } from '../../src/core/commit-log-parser';
import {
  arbAstralCodePoint,
  arbAuthorDate,
  arbCombiningMark,
  arbCommitHash,
  arbCommitLogModelOf,
  arbCommitLogText,
  arbMalformedCommitLogText,
  renderCommitLog,
  toCrlf,
  toLf,
} from '../generators';
import type { CommitEntryModel } from '../generators';
import type { CommitRecord } from '../../src/core/types';

/**
 * **Property 3: Line endings and non-ASCII author names do not change the result** (Req 4.2).
 *
 * The parser resolves a lone CR as an ordinary character rather than a line terminator (design,
 * *Commit_Log_Parser*, ambiguity 2), which is what makes Req 4.2's equivalence exact rather than
 * approximate. That resolution is also what makes the *oracle* here delicate, so the line-ending
 * normalization gets its own unit tests below before the property leans on it.
 *
 * **Scope of "any Commit_Log text".** The property quantifies over texts that have both an
 * LF-terminated form and a CRLF-terminated form. One shape has only the latter: a line whose content
 * *ends* with a lone CR. Writing that line into the LF form yields the code point sequence
 * `line\r\n`, and the terminator alternation `\r\n | \n` consumes it whole, so the CR is the
 * terminator rather than content — the LF form cannot express it. That is a property of the two
 * encodings, not a parser defect, and it is why {@link insertInteriorMarker} places every generated
 * lone CR strictly between two code points. Unconstrained text (which can contain `\r\r\n`) is
 * therefore not drawn here; totality and determinism over that space are Property 2's job.
 */

const CR = '\r';
const LF = '\n';
const CRLF = '\r\n';

// ---------------------------------------------------------------------------------------------
// The oracle: LF-terminated form and CRLF-terminated form
// ---------------------------------------------------------------------------------------------

/**
 * How `toLf` and `toCrlf` from `test/generators.ts` must behave, written out as examples before the
 * property depends on them. A bug in the normalization would otherwise surface as a parser failure,
 * which is the one confusion this table exists to prevent.
 *
 * Three rows carry the whole argument:
 *
 * - `a\rb` — a lone CR is content. Neither normalization may touch it. A conversion written as
 *   `text.replace(/\r?\n/g, '\r\n')` passes every other row here and fails this one's LF variant,
 *   because the optional `\r` swallows content that happens to sit before a terminator.
 * - `a\r\nb` — an existing CRLF must be consumed once and re-emitted once. A conversion written as
 *   `text.replace(/\n/g, '\r\n')` produces `a\r\r\nb`, which re-reads as a line ending in a lone CR
 *   and so changes the parsed subject.
 * - `a\r\r\nb` — a lone CR immediately before a CRLF terminator. `toCrlf` leaves it alone; `toLf`
 *   necessarily loses it, for the reason given in this file's header. It is listed so the behaviour
 *   is recorded rather than discovered, and it is the shape the generators below never emit.
 */
interface NormalizationCase {
  name: string;
  source: string;
  lf: string;
  crlf: string;
  /**
   * Whether the source has an LF-terminated form at all. False for exactly one shape — a line whose
   * content ends with a lone CR — where `toLf` is lossy and therefore not a fixpoint, and which is
   * the shape the property's generators do not emit.
   */
  hasLfForm: boolean;
}

const NORMALIZATION_CASES: NormalizationCase[] = [
  { name: 'empty text', source: '', lf: '', crlf: '', hasLfForm: true },
  {
    name: 'no terminator at all',
    source: 'commit abcdef0',
    lf: 'commit abcdef0',
    crlf: 'commit abcdef0',
    hasLfForm: true,
  },
  {
    name: 'a bare LF terminator becomes CRLF',
    source: 'a\nb',
    lf: 'a\nb',
    crlf: 'a\r\nb',
    hasLfForm: true,
  },
  {
    name: 'an existing CRLF terminator is not doubled',
    source: 'a\r\nb',
    lf: 'a\nb',
    crlf: 'a\r\nb',
    hasLfForm: true,
  },
  {
    name: 'a lone CR is content and is left alone',
    source: 'a\rb',
    lf: 'a\rb',
    crlf: 'a\rb',
    hasLfForm: true,
  },
  {
    name: 'a lone CR survives beside an LF terminator',
    source: 'a\rb\nc',
    lf: 'a\rb\nc',
    crlf: 'a\rb\r\nc',
    hasLfForm: true,
  },
  {
    // `toLf` cannot keep this CR: `a\r` written with an LF terminator is the code point sequence
    // `a\r\n`, which the alternation reads as `a` plus a terminator. Recorded, not asserted away.
    name: 'a lone CR before a CRLF terminator has no LF form',
    source: 'a\r\r\nb',
    lf: 'a\r\nb',
    crlf: 'a\r\r\nb',
    hasLfForm: false,
  },
  {
    name: 'mixed terminators normalize',
    source: 'a\r\nb\nc\rd',
    lf: 'a\nb\nc\rd',
    crlf: 'a\r\nb\r\nc\rd',
    hasLfForm: true,
  },
  {
    name: 'a trailing terminator is preserved',
    source: 'a\n',
    lf: 'a\n',
    crlf: 'a\r\n',
    hasLfForm: true,
  },
  { name: 'a lone CR is not a terminator', source: '\r', lf: '\r', crlf: '\r', hasLfForm: true },
  {
    name: 'consecutive blank lines',
    source: '\n\n',
    lf: '\n\n',
    crlf: '\r\n\r\n',
    hasLfForm: true,
  },
];

/** A Commit_Log carrying a lone CR inside an author name and inside a body line. */
const LOG_WITH_INTERIOR_CR = [
  'commit abcdef0123456',
  `Author: Ren${CR}é Ångström 林秀 <devlog@localhost>`,
  'Date: Mon Sep 21 09:14:02 2026 +0000',
  '',
  `    fix the pa${CR}rser`,
].join(LF);

describe('the line-ending oracle Property 3 depends on', () => {
  it.each(NORMALIZATION_CASES)('toCrlf: $name', ({ source, crlf }) => {
    expect(toCrlf(source)).toBe(crlf);
  });

  it.each(NORMALIZATION_CASES)('toLf: $name', ({ source, lf }) => {
    expect(toLf(source)).toBe(lf);
  });

  it('is idempotent, and each form is reachable from the other', () => {
    for (const { source, hasLfForm } of NORMALIZATION_CASES) {
      expect(toCrlf(toCrlf(source))).toBe(toCrlf(source));
      expect(toLf(toCrlf(source))).toBe(toLf(source));
      if (hasLfForm) {
        // Each form is derivable from the other, which is what lets the property normalize one
        // source twice rather than needing the source to be in a known form already. This is the
        // half that fails for a line ending in a lone CR: there the LF form has lost the CR, so
        // converting back cannot restore it, and the two forms are not two spellings of one log.
        expect(toLf(toLf(source))).toBe(toLf(source));
        expect(toCrlf(toLf(source))).toBe(toCrlf(source));
      }
    }
  });

  it('carries a lone CR through both forms into the parsed fields', () => {
    const expected = {
      ok: true,
      records: [
        {
          hash: 'abcdef0123456',
          authorName: `Ren${CR}é Ångström 林秀`,
          authorDate: 'Mon Sep 21 09:14:02 2026 +0000',
          subject: `fix the pa${CR}rser`,
        },
      ],
    };

    // The CR is still adjacent to its neighbours in the CRLF form: the rewrite touched terminators
    // only. Without this the assertions below would pass just as well on a normalization that
    // dropped the CR from both forms alike.
    expect(toCrlf(LOG_WITH_INTERIOR_CR)).toContain(`Ren${CR}é`);
    expect(toCrlf(LOG_WITH_INTERIOR_CR)).toContain(`pa${CR}rser`);

    expect(parseCommitLog(toLf(LOG_WITH_INTERIOR_CR))).toStrictEqual(expected);
    expect(parseCommitLog(toCrlf(LOG_WITH_INTERIOR_CR))).toStrictEqual(expected);
  });
});

// ---------------------------------------------------------------------------------------------
// Author names and body lines outside the ASCII range
// ---------------------------------------------------------------------------------------------

/** Latin-1 accented names: the ordinary Western European case, one UTF-16 unit per code point. */
const LATIN1_ACCENTED_NAMES = ['Émile', 'Ångström', 'Muñoz', 'Weiß', 'Sørensen', 'Çelik', 'Łukasz'];

/** CJK names: non-ASCII, in the BMP, and rendered double width. */
const CJK_NAMES = ['林秀', '山田太郎', '한지민', '张伟', '陳大文'];

/**
 * Right-to-left names. Bidirectional text is where a normalization that reorders or re-encodes
 * anything shows up, and one entry carries an interior space so the parser's trim is exercised
 * against a name it must not shorten.
 */
const RTL_NAMES = ['شادي', 'أحمد الحسن', 'שלום כהן', 'מרים', 'فاطمة'];

/** A base letter plus a combining mark: two code points that render as one grapheme. */
const arbCombiningCluster: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('a', 'e', 'o', 'n', 'ا', 'ש', 'ก'), arbCombiningMark)
  .map(([base, mark]) => `${base}${mark}`);

/**
 * Text holding, in a generated order, one Latin-1 accented name, one CJK name, one right-to-left
 * name, one code point above U+FFFF, and one base-plus-combining-mark cluster. Every class Req 4.2
 * and Req 8.4 name therefore appears in every draw rather than in some draws.
 *
 * Every part begins and ends with a non-whitespace code point, so the assembled text survives the
 * parser's trim of the author name whole.
 */
const arbScriptRichText: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...LATIN1_ACCENTED_NAMES),
    fc.constantFrom(...CJK_NAMES),
    fc.constantFrom(...RTL_NAMES),
    arbAstralCodePoint,
    arbCombiningCluster,
  )
  .chain((parts) =>
    fc.shuffledSubarray(parts, { minLength: parts.length, maxLength: parts.length }),
  )
  .map((parts) => parts.join(''));

/**
 * Inserts `marker` strictly between two code points of `text` — never first, never last.
 *
 * Interior placement is required rather than tidy. A lone CR as the last code point of a line has no
 * LF-terminated form (see this file's header), and a lone CR as the *first* or last code point of an
 * author name is trimmed away before it reaches the field, because CR carries the Unicode
 * `White_Space` property. Interior is the only position where a CR both survives into a
 * Commit_Record field and keeps the property's premise well defined — which is exactly the position
 * a careless LF-to-CRLF rewrite corrupts.
 */
function insertInteriorMarker(text: string, marker: string, position: number): string {
  const codePoints = [...text];
  if (codePoints.length < 2) {
    return text;
  }
  const at = 1 + (position % (codePoints.length - 1));
  return `${codePoints.slice(0, at).join('')}${marker}${codePoints.slice(at).join('')}`;
}

/** Script-rich text, half the time carrying an interior lone CR. */
const arbScriptRichTextWithOptionalCr: fc.Arbitrary<string> = fc
  .tuple(arbScriptRichText, fc.nat(), fc.boolean())
  .map(([text, position, withCr]) => (withCr ? insertInteriorMarker(text, CR, position) : text));

const arbSpaceOrTabPadding: fc.Arbitrary<{ left: string; right: string }> = fc.record({
  left: fc.string({ unit: fc.constantFrom(' ', '\t'), maxLength: 2 }),
  right: fc.string({ unit: fc.constantFrom(' ', '\t'), maxLength: 2 }),
});

/** Body line content after the four-space indent, sometimes carrying an interior lone CR. */
const arbBodyLineContentWithOptionalCr: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('fix ', 'refactor ', 'add ', ''), arbScriptRichTextWithOptionalCr)
  .map(([prefix, text]) => `${prefix}${text}`);

/**
 * A commit entry whose author name and body lines are non-ASCII throughout and may carry a lone CR.
 * Built on the shared {@link CommitEntryModel} so the shared renderer produces the text.
 */
const arbScriptRichEntryModel: fc.Arbitrary<CommitEntryModel> = fc.record({
  hash: arbCommitHash,
  mergeLine: fc.oneof(
    { arbitrary: fc.constant<string | null>(null), weight: 3 },
    { arbitrary: arbCommitHash.map((hash) => hash.slice(0, 7)), weight: 1 },
  ),
  authorName: arbScriptRichTextWithOptionalCr,
  authorNamePadding: arbSpaceOrTabPadding,
  email: fc.constant('devlog@localhost'),
  authorDate: arbAuthorDate,
  authorDatePadding: arbSpaceOrTabPadding,
  blankAfterDate: fc.string({ unit: fc.constantFrom(' ', '\t'), maxLength: 3 }),
  bodyLines: fc.array(arbBodyLineContentWithOptionalCr, { maxLength: 3 }),
});

const arbScriptRichCommitLogText: fc.Arbitrary<string> = arbCommitLogModelOf({
  minEntries: 1,
  maxEntries: 3,
  entry: arbScriptRichEntryModel,
}).map(renderCommitLog);

/**
 * The input space of Property 3. `arbCommitLogText` supplies grammar-conforming logs in both
 * terminators, including the empty and whitespace-only cases of Req 4.8;
 * {@link arbScriptRichCommitLogText} supplies the non-ASCII, astral-plane, combining-mark,
 * right-to-left, and lone-CR cases; and `arbMalformedCommitLogText` reaches the error branch, where
 * the two forms must fail identically and report the same 1-based line number.
 */
const arbLineEndingSubject: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: arbCommitLogText, weight: 5 },
  { arbitrary: arbScriptRichCommitLogText, weight: 4 },
  { arbitrary: arbMalformedCommitLogText, weight: 3 },
);

/** Every field of a Commit_Record as an explicit code point array, for the "code point for code
 * point" clause: `toStrictEqual` on the records already compares strings exactly, and this states
 * the clause in the units the requirement uses. */
function fieldCodePoints(record: CommitRecord): string[][] {
  return [[...record.hash], [...record.authorName], [...record.authorDate], [...record.subject]];
}

describe('Commit_Log_Parser line-ending and non-ASCII equivalence', () => {
  it('generates author names reaching every named script class', () => {
    const samples = fc.sample(arbScriptRichText, 50);
    for (const sample of samples) {
      const codePoints = [...sample];
      expect(codePoints.some((cp) => (cp.codePointAt(0) ?? 0) > 0xffff)).toBe(true);
      expect(LATIN1_ACCENTED_NAMES.some((name) => sample.includes(name))).toBe(true);
      expect(CJK_NAMES.some((name) => sample.includes(name))).toBe(true);
      expect(RTL_NAMES.some((name) => sample.includes(name))).toBe(true);
    }
  });

  it('parses the CRLF-terminated form and the LF-terminated form to the identical result', () => {
    // Feature: devlog-narrator, Property 3: For any Commit_Log text, parsing the CRLF-terminated form yields a Commit_Record list identical field for field, code point for code point, to the list produced by parsing the LF-terminated form, including when author names contain code points outside the ASCII range.
    fc.assert(
      fc.property(arbLineEndingSubject, (text) => {
        const lfForm = toLf(text);
        const crlfForm = toCrlf(text);

        // The two forms are the same Commit_Log written with the two terminators the grammar
        // admits: the same lines, in the same order, differing only in what ends each line. This is
        // the premise the rest of the assertions rest on, so it is checked rather than assumed —
        // a normalization that dropped or duplicated a code point inside a line would make the
        // parse comparison below meaningless whether it passed or failed.
        expect(crlfForm.split(CRLF)).toStrictEqual(lfForm.split(LF));

        const fromLf = parseCommitLog(lfForm);
        const fromCrlf = parseCommitLog(crlfForm);

        // Field for field and code point for code point, on both branches of the result union. A
        // deep equality over the whole `ParseResult` is deliberately the primary assertion: it
        // compares the `ok` discriminant, the record count, every Commit_Record field, and — on the
        // error branch — the error kind, its 1-based line number, and the `expected` text. So a
        // CRLF form that succeeded where the LF form failed, or failed at a different line, fails
        // here.
        expect(fromCrlf).toStrictEqual(fromLf);

        if (fromLf.ok && fromCrlf.ok) {
          expect(fromCrlf.records.map(fieldCodePoints)).toStrictEqual(
            fromLf.records.map(fieldCodePoints),
          );
        }

        expect(fromCrlf.ok).toBe(fromLf.ok);
        if (!fromLf.ok && !fromCrlf.ok) {
          expect(fromCrlf.error.line).toBe(fromLf.error.line);
          expect(fromCrlf.error.kind).toBe(fromLf.error.kind);
        }
      }),
    );
  });
});
