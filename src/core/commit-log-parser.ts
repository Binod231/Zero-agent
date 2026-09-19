/**
 * Commit_Log_Parser: `git log` text to an ordered list of Commit_Records (Req 4.1-4.4, 4.8-4.10).
 *
 * Pure and synchronous. No AWS dependency, no I/O, and — the property that matters most — no
 * exceptions: every failure is a `ParseError` value, which is what makes the totality obligation of
 * Req 4.10 mechanically checkable rather than a claim about which inputs were tried.
 *
 * The grammar is the design's *Commit_Log_Parser / Grammar* section, written out here as the shape
 * the scan accepts. `SP` is one space, `HEXDIGIT` is `[0-9a-fA-F]`, and `CHAR` is any code point
 * that is neither CR nor LF:
 *
 * ```ebnf
 * CommitLog   ::= WS* | ( BlankLine* CommitEntry ( BlankLine+ CommitEntry )* BlankLine* )
 * CommitEntry ::= CommitLine MergeLine? AuthorLine DateLine BlankLine BodySection
 * CommitLine  ::= "commit" SP HEXDIGIT{7,40} EOL
 * MergeLine   ::= "Merge:" SP CHAR+ EOL
 * AuthorLine  ::= "Author:" SP AuthorName SP "<" Email ">" EOL
 * DateLine    ::= "Date:" SP DateText EOL
 * BodySection ::= BodyLine*
 * BodyLine    ::= "    " CHAR* EOL
 * BlankLine   ::= WS* EOL
 * EOL         ::= "\r\n" | "\n" | <end of input>
 * ```
 *
 * **Implementation shape.** The input is split into lines once, keeping every line at its 1-based
 * position, and a line-oriented recursive-descent scan then walks the array with an explicit
 * cursor. The descent is expressed as calls that *return* a new cursor rather than as recursion
 * over the remaining input, so a 100000-character paste costs no stack depth: a per-line recursive
 * parser would throw `RangeError` on large input and totality would be false for exactly the
 * inputs a Reader is most likely to produce.
 *
 * **The three resolved ambiguities** from the design are implemented in one place each, and each
 * place carries a back-reference:
 *
 * 1. A whitespace-only line terminates a body section — {@link isBodyLine}.
 * 2. A lone CR is an ordinary character, not a line terminator — {@link LINE_TERMINATOR}.
 * 3. Trailing whitespace inside a body line is significant — {@link scanBodySection}.
 */

import { hasNonWhitespaceCodePoint } from './code-points';
import type { CommitRecord, ParseError, ParseResult } from './types';

/**
 * The commit-entry ceiling of Req 4.1. The 501st `commit` line is refused rather than truncated, so
 * a paste that overflows is a visible error instead of a silently shortened Entry.
 *
 * Exported because the Commit_Log_Printer enforces the same bound, and a limit spelled twice is a
 * limit that will eventually be spelled two different ways.
 */
export const MAX_COMMIT_RECORDS = 500;

/**
 * Ambiguity 2: only CRLF and LF terminate a line. A lone CR matches nothing here and so survives as
 * an ordinary code point inside whatever field holds it.
 *
 * This is what makes the CRLF equivalence of Req 4.2 exact. Splitting on `\r` as well would make
 * the LF form and the CRLF form of a log whose fields contain a stray CR parse differently, and the
 * requirement says the two forms agree character for character in every field.
 *
 * CRLF precedes LF in the alternation, so `\r\n` is consumed whole and never leaves an orphan CR at
 * the end of a line.
 */
const LINE_TERMINATOR = /\r\n|\n/;

/** `CommitLine`. Anchored at both ends: nothing may follow the hash. The hash keeps its case. */
const COMMIT_LINE = /^commit ([0-9a-fA-F]{7,40})$/;

/** How a `Merge` line is recognized, as distinct from how it is validated. See {@link scanEntry}. */
const MERGE_MARKER = 'Merge:';
const MERGE_LINE_PREFIX = 'Merge: ';
const AUTHOR_LINE_PREFIX = 'Author: ';
const DATE_LINE_PREFIX = 'Date: ';

/** `BodyLine`'s four-space indent. The only part of a body line that is ever stripped. */
const BODY_INDENT = '    ';

/**
 * What the parser required at the position it rejected. These strings are the `expected` field of a
 * `MALFORMED` error (Req 4.4), so they name the construct rather than the offending text: the value
 * on the line is the Author's pasted material and has no place in an error message that may be
 * logged (Req 11.3).
 */
const EXPECTED_COMMIT_LINE = "a commit line of the form 'commit <hash>' with 7 to 40 hex digits";
const EXPECTED_MERGE_LINE = "a merge line of the form 'Merge: <parent hashes>'";
const EXPECTED_AUTHOR_LINE = "an author line of the form 'Author: <name> <email>'";
const EXPECTED_DATE_LINE = "a date line of the form 'Date: <author date>'";
const EXPECTED_BLANK_AFTER_DATE = 'a blank line after the date line';
const EXPECTED_ENTRY_SEPARATOR = 'a blank line separating commit entries';

/** The outcome of scanning one `CommitEntry`: a record and the cursor after it, or an error. */
type EntryScan =
  { ok: true; record: CommitRecord; next: number } | { ok: false; error: ParseError };

/**
 * True when a line carries no non-whitespace code point, which is this parser's `BlankLine`.
 *
 * The grammar writes `BlankLine ::= WS* EOL` with `WS` as space or tab, and ambiguity 1 widens that
 * to "no non-whitespace code point after the indent". Both readings are satisfied by testing the
 * whole line for a non-whitespace code point, and using the one Unicode `White_Space` predicate
 * everywhere keeps the body-versus-blank boundary a single decidable rule instead of two
 * definitions of whitespace that disagree on U+3000.
 */
function isBlankLine(line: string): boolean {
  return !hasNonWhitespaceCodePoint(line);
}

/**
 * Ambiguity 1: within a body section a line is a `BodyLine` only when it begins with exactly four
 * spaces **and** holds at least one non-whitespace code point after them. Anything else is a
 * `BlankLine` that terminates the body section, and therefore the entry.
 *
 * `BodyLine` and `BlankLine` both match a line of four spaces, so the grammar is ambiguous without
 * an ordering rule. Resolving it towards `BlankLine` is what lets an entry whose body is a single
 * line of indentation end where git's output ends it, and it is why the Commit_Log_Printer refuses
 * a non-empty subject that is all whitespace: such a subject would print as a line this function
 * reads back as blank, so it could not round-trip (Req 4.6).
 */
function isBodyLine(line: string): boolean {
  return line.startsWith(BODY_INDENT) && hasNonWhitespaceCodePoint(line.slice(BODY_INDENT.length));
}

/**
 * The 1-based line number to report for a rejection at array index `index`.
 *
 * When the scan runs off the end of the input there is no non-conforming line to point at — the
 * input simply stopped early — so the last line present is reported. Property 2 requires every
 * reported line number to fall between 1 and the number of lines in the input, and a fabricated
 * "line after the last one" would violate that for every truncated paste.
 */
function reportedLine(index: number, lineCount: number): number {
  return index < lineCount ? index + 1 : lineCount;
}

function malformed(
  index: number,
  lineCount: number,
  expected: string,
): { ok: false; error: ParseError } {
  return {
    ok: false,
    error: { kind: 'MALFORMED', line: reportedLine(index, lineCount), expected },
  };
}

/** Advances past a run of `BlankLine`s, returning the index of the first line that is not blank. */
function skipBlankLines(lines: readonly string[], from: number): number {
  let index = from;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || !isBlankLine(line)) {
      break;
    }
    index += 1;
  }
  return index;
}

/**
 * `BodySection ::= BodyLine*`, plus the subject rule of Req 4.3 and Req 4.9.
 *
 * Ambiguity 3: only the four-space indent is removed. Trailing whitespace inside a body line is
 * significant, so `····fix bug··` yields `fix bug··`, and a line indented eight spaces yields a
 * subject carrying four leading spaces — which is exactly what the printer re-indents on the way
 * back out, so it round-trips.
 *
 * The first body line becomes the subject and the rest are discarded (Req 4.9); an entry with no
 * body lines yields `''` (Req 4.3).
 */
function scanBodySection(
  lines: readonly string[],
  from: number,
): { subject: string; next: number } {
  let index = from;
  let subject = '';
  let seenBodyLine = false;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || !isBodyLine(line)) {
      break;
    }
    if (!seenBodyLine) {
      subject = line.slice(BODY_INDENT.length);
      seenBodyLine = true;
    }
    index += 1;
  }

  return { subject, next: index };
}

/**
 * `AuthorLine ::= "Author:" SP AuthorName SP "<" Email ">" EOL`.
 *
 * `AuthorName` excludes `<` and `>` and `Email` excludes `>`, which makes the first `<` the
 * delimiter and the final `>` the terminator, with no backtracking. The name is returned trimmed
 * (the grammar trims surrounding space) so that git's own single-space layout and a log padded with
 * extra spaces produce the identical Commit_Record.
 */
function parseAuthorName(line: string): string | undefined {
  if (!line.startsWith(AUTHOR_LINE_PREFIX)) {
    return undefined;
  }

  const rest = line.slice(AUTHOR_LINE_PREFIX.length);
  const openIndex = rest.indexOf('<');
  if (openIndex < 0 || !rest.endsWith('>')) {
    return undefined;
  }

  const nameSegment = rest.slice(0, openIndex);
  const email = rest.slice(openIndex + 1, rest.length - 1);

  // `AuthorName SP "<"`: at least one space separates the name from the bracket, the name holds at
  // least one non-whitespace code point, and neither field carries an angle bracket of its own.
  if (!nameSegment.endsWith(' ') || nameSegment.includes('>')) {
    return undefined;
  }
  if (email.includes('>') || !hasNonWhitespaceCodePoint(nameSegment)) {
    return undefined;
  }

  return nameSegment.trim();
}

/**
 * `DateLine ::= "Date:" SP DateText EOL`, with `DateText` trimmed.
 *
 * git pads this line to align with `Author:`, so the padding is part of the trimmed run rather than
 * a second `SP` in the grammar. The value is kept as opaque text and never reinterpreted as an
 * instant: git's default date format varies with locale and configuration, and Commit_Records feed
 * the model and nothing else.
 */
function parseAuthorDate(line: string): string | undefined {
  if (!line.startsWith(DATE_LINE_PREFIX)) {
    return undefined;
  }
  const rest = line.slice(DATE_LINE_PREFIX.length);
  return hasNonWhitespaceCodePoint(rest) ? rest.trim() : undefined;
}

/**
 * One `CommitEntry`, starting at `start`, which the caller has positioned on a non-blank line.
 *
 * `recordCount` is how many records precede this entry, so the `commit` line that would begin the
 * 501st entry is refused with `TOO_MANY_COMMITS` carrying that line's number. The commit line is
 * validated first: a 501st entry that is also malformed reports the malformation, which is the more
 * specific fact about the input.
 */
function scanEntry(lines: readonly string[], start: number, recordCount: number): EntryScan {
  const lineCount = lines.length;
  let index = start;

  const commitLine = lines[index];
  const hashMatch = commitLine === undefined ? null : COMMIT_LINE.exec(commitLine);
  if (hashMatch === null) {
    return malformed(index, lineCount, EXPECTED_COMMIT_LINE);
  }
  if (recordCount >= MAX_COMMIT_RECORDS) {
    return {
      ok: false,
      error: { kind: 'TOO_MANY_COMMITS', line: reportedLine(index, lineCount), limit: 500 },
    };
  }
  // The capture group is present whenever the pattern matched.
  const hash = hashMatch[1] ?? '';
  index += 1;

  // `MergeLine?`. Recognition is by the bare marker so that a damaged merge line is reported as a
  // malformed merge line rather than as a missing author line, which is the more useful message.
  const mergeLine = lines[index];
  if (mergeLine?.startsWith(MERGE_MARKER)) {
    if (!mergeLine.startsWith(MERGE_LINE_PREFIX) || mergeLine.length === MERGE_LINE_PREFIX.length) {
      return malformed(index, lineCount, EXPECTED_MERGE_LINE);
    }
    index += 1;
  }

  const authorLine = lines[index];
  const authorName = authorLine === undefined ? undefined : parseAuthorName(authorLine);
  if (authorName === undefined) {
    return malformed(index, lineCount, EXPECTED_AUTHOR_LINE);
  }
  index += 1;

  const dateLine = lines[index];
  const authorDate = dateLine === undefined ? undefined : parseAuthorDate(dateLine);
  if (authorDate === undefined) {
    return malformed(index, lineCount, EXPECTED_DATE_LINE);
  }
  index += 1;

  // The mandatory `BlankLine` between the header and the body. `EOL` includes end of input, so an
  // input that stops immediately after the date line satisfies it with an empty body section — a
  // truncated paste loses its subject, not its commit.
  const separator = lines[index];
  if (separator !== undefined) {
    if (!isBlankLine(separator)) {
      return malformed(index, lineCount, EXPECTED_BLANK_AFTER_DATE);
    }
    index += 1;
  }

  const body = scanBodySection(lines, index);

  return {
    ok: true,
    record: { hash, authorName, authorDate, subject: body.subject },
    next: body.next,
  };
}

/**
 * Parses Commit_Log text into an ordered list of Commit_Records.
 *
 * Total: every input string yields either a record list or an error, and nothing throws (Req 4.10).
 * Deterministic: the function reads no clock, no locale, and no module-level mutable state, and the
 * patterns it uses carry no `g` flag and so hold no `lastIndex` between calls, so identical input
 * yields an identical result on every invocation (Req 4.10).
 *
 * - Empty or whitespace-only input yields `{ ok: true, records: [] }` (Req 4.8).
 * - Records appear in the order they appear in the input (Req 4.1).
 * - The first non-conforming line yields `MALFORMED` with a 1-based line number and no record list
 *   (Req 4.4).
 * - The 501st `commit` line yields `TOO_MANY_COMMITS`. No character cap is imposed here; the
 *   256 KB request-body limit of Req 9.3 bounds input upstream and totality holds regardless.
 */
export function parseCommitLog(text: string): ParseResult {
  // One split, retaining 1-based positions as `index + 1`. A trailing terminator leaves a final
  // empty element, which is a `BlankLine` the grammar already allows, so it needs no special case
  // and the line count stays equal to the number of lines a reader would count in the input.
  const lines = text.split(LINE_TERMINATOR);
  const records: CommitRecord[] = [];

  let cursor = skipBlankLines(lines, 0);
  while (cursor < lines.length) {
    const scan = scanEntry(lines, cursor, records.length);
    if (!scan.ok) {
      return { ok: false, error: scan.error };
    }
    records.push(scan.record);
    cursor = scan.next;

    if (cursor >= lines.length) {
      break;
    }

    // `( BlankLine+ CommitEntry )*`: the body section ended at a line that is not a body line, and
    // the only thing that may follow an entry is a blank line.
    const line = lines[cursor];
    if (line === undefined || !isBlankLine(line)) {
      return {
        ok: false,
        error: {
          kind: 'MALFORMED',
          line: reportedLine(cursor, lines.length),
          expected: EXPECTED_ENTRY_SEPARATOR,
        },
      };
    }
    cursor = skipBlankLines(lines, cursor);
  }

  return { ok: true, records };
}
