/**
 * Commit_Log_Printer: an ordered list of Commit_Records back to `git log` text (Req 4.5).
 *
 * Pure, synchronous, and total in the sense that matters: `printCommitLog` never throws, and every
 * refusal is a `PrintError` value. It is not on any request path. It exists so the round-trip
 * obligation of Req 4.6 can be checked mechanically against the Commit_Log_Parser (Property 1).
 *
 * **Output shape.** LF line endings only (Req 4.5). Per record, in order:
 *
 * ```text
 * commit <hash>
 * Author: <authorName> <devlog@localhost>
 * Date: <authorDate>
 *                              <- the mandatory blank line of the grammar
 *     <subject>                <- one body line, only when the subject is non-empty
 *                              <- a blank line before the next record
 * ```
 *
 * No `Merge` line is ever emitted, because a Commit_Record carries no merge information — there is
 * nothing to print and inventing one would put text in the output that no field of the input
 * supplied. The grammar makes `MergeLine` optional, so omitting it always parses.
 *
 * **Why the email is a constant.** `CommitRecord` has no email field, and Req 4.6 scopes the round
 * trip to hash, author name, author date, and subject. Email is outside the round trip by design,
 * so the printer emits one fixed placeholder rather than synthesising a value that would look like
 * data and is not.
 *
 * **Why the printer is partial.** Req 4.6 is scoped to lists the printer "prints without error",
 * and that scoping is load-bearing: every rejection rule below exists because the record in
 * question could not survive a parse of the printed text. Each rule names the parser behaviour that
 * would destroy or alter the field. Rejecting is always preferred to printing something that reads
 * back as a different record, because silent corruption of a commit log is indistinguishable from
 * the model being fed work that never happened.
 */

import { hasNonWhitespaceCodePoint } from './code-points';
import { MAX_COMMIT_RECORDS } from './commit-log-parser';
import type { CommitRecord, PrintError, PrintResult } from './types';

/**
 * The email the `Author` line always carries. A fixed constant because `CommitRecord` holds no
 * email, and `Email ::= CHAR*` excluding `>` in the grammar accepts it. `localhost` rather than a
 * plausible domain so nothing downstream mistakes it for a real address.
 */
const PLACEHOLDER_EMAIL = 'devlog@localhost';

/** `Hash ::= HEXDIGIT{7,40}`, the same shape the parser's `CommitLine` accepts. */
const HASH = /^[0-9a-fA-F]{7,40}$/;

/** The four-space indent of `BodyLine`. The parser strips exactly this much and no more. */
const BODY_INDENT = '    ';

/** CR or LF anywhere in a field. See {@link carriesLineBreak}. */
const LINE_BREAK = /[\r\n]/;

/**
 * True when a field carries CR or LF.
 *
 * LF terminates a line, so an LF inside any field splits it across two lines and the second half is
 * read as a different construct entirely.
 *
 * CR is refused too, though the parser treats a lone CR as an ordinary character (ambiguity 2). The
 * reason is positional: a CR at the end of a field sits immediately before the LF this printer
 * emits, forming the `\r\n` terminator, so the CR is swallowed and the field comes back one code
 * point short — `Date: Mon\r` parses back as `Mon`. Refusing CR anywhere rather than only at a
 * field's end keeps one decidable rule per field instead of a rule that depends on where in the
 * string the CR landed.
 */
function carriesLineBreak(field: string): boolean {
  return LINE_BREAK.test(field);
}

/**
 * True when the parser would read this field back unchanged after its own trimming.
 *
 * `AuthorName` and `DateText` are both trimmed by the grammar, and `CommitRecord` documents both as
 * trimmed values. So a record whose name or date carries leading or trailing whitespace cannot
 * round-trip: the printer would emit it faithfully and the parser would hand back the trimmed
 * form, which is a different string. The record violates the `CommitRecord` invariant, and the
 * printer refuses it rather than returning text that parses to something else.
 *
 * The non-whitespace test uses the Unicode `White_Space` property, which is the predicate the
 * parser applies when deciding whether an author line or date line carries a value at all. Testing
 * "empty after `trim()`" alone would be weaker than the parser in one direction and stronger in
 * another: `'\u0085'` (NEL) survives `trim()` but is `White_Space`, so the parser rejects the line
 * as malformed, while `'\ufeff'` is not `White_Space` but `trim()` removes it, so the parser hands
 * back `''`. Requiring both conditions makes the printer's admission test exactly the parser's.
 */
function roundTripsThroughTrim(field: string): boolean {
  return hasNonWhitespaceCodePoint(field) && field === field.trim();
}

/**
 * The first rule the record violates, or `undefined` when it prints.
 *
 * Rules are checked in field order — hash, name, date, subject — so the reported error is stable
 * and independent of how many rules a record breaks.
 */
function validate(record: CommitRecord, index: number): PrintError | undefined {
  // `commit <hash>` is anchored in the parser, so anything that is not 7-40 hex digits either fails
  // to match or, for a hash carrying a space, shifts what follows it out of the grammar.
  if (!HASH.test(record.hash)) {
    return { kind: 'INVALID_HASH', index };
  }

  // `AuthorName` excludes `<` and `>`: the parser takes the first `<` as the start of the email and
  // the final `>` as the end of the line, so an angle bracket in the name moves those boundaries and
  // the name comes back truncated or the line is rejected outright. Whitespace and line breaks are
  // covered by the two shared rules above.
  if (
    carriesLineBreak(record.authorName) ||
    record.authorName.includes('<') ||
    record.authorName.includes('>') ||
    !roundTripsThroughTrim(record.authorName)
  ) {
    return { kind: 'INVALID_NAME', index };
  }

  // `DateText` is opaque text with no internal structure, so only line breaks and the trimming rule
  // can alter it. Angle brackets are fine here: nothing on the date line delimits on them.
  if (carriesLineBreak(record.authorDate) || !roundTripsThroughTrim(record.authorDate)) {
    return { kind: 'INVALID_DATE', index };
  }

  // A body line is emitted verbatim after the indent and is read back verbatim, so a subject needs
  // only to survive as one line. The empty subject is legitimate: it prints as no body line at all
  // and the parser yields `''` for an entry with no body lines (Req 4.3).
  //
  // The whitespace-only case is the subtle one, and it is the reason this rule exists rather than
  // being folded into the line-break rule. Ambiguity 1 of the grammar resolves a line of four
  // spaces towards `BlankLine`: within a body section a line counts as a `BodyLine` only when it
  // holds a non-whitespace code point after the indent. So a subject of `'  '` would print as
  // `'      '`, which the parser must read as a blank line that terminates the entry — the subject
  // would come back as `''` and, worse, the blank line would be consumed as an entry separator.
  // The record cannot round-trip, so it is refused instead of being silently corrupted.
  if (
    carriesLineBreak(record.subject) ||
    (record.subject !== '' && !hasNonWhitespaceCodePoint(record.subject))
  ) {
    return { kind: 'INVALID_SUBJECT', index };
  }

  return undefined;
}

/**
 * Renders one validated record as its output lines, without the separator that precedes it.
 *
 * The blank line after `Date:` is mandatory in the grammar, so it is emitted for every record
 * including one with no body. The body line is emitted only for a non-empty subject.
 */
function recordLines(record: CommitRecord): string[] {
  const lines = [
    `commit ${record.hash}`,
    `Author: ${record.authorName} <${PLACEHOLDER_EMAIL}>`,
    `Date: ${record.authorDate}`,
    '',
  ];
  if (record.subject !== '') {
    lines.push(`${BODY_INDENT}${record.subject}`);
  }
  return lines;
}

/**
 * Prints an ordered list of Commit_Records as Commit_Log text the Commit_Log_Parser accepts
 * (Req 4.5), or returns the first reason the list cannot be printed.
 *
 * Never throws: errors are values, so a caller cannot accidentally treat a refusal as success.
 * Deterministic: no clock, no locale, no module-level mutable state, and no `g`-flagged pattern
 * holding a `lastIndex` between calls.
 *
 * An empty list prints as the empty string, which parses back to an empty list (Req 4.8), so the
 * round trip holds at the base case as well.
 *
 * **Error precedence.** The list-level ceiling is checked *before* any per-record validation. The
 * ceiling is a property of the list rather than of a record — `TOO_MANY_COMMITS` carries no `index`
 * for exactly that reason — and it is decidable in constant time, so checking it first means an
 * oversized list is refused for the reason that actually disqualifies it instead of for whichever
 * record happens to be malformed first. Within the list, the first offending record by index wins;
 * `index` is 0-based, the position in the supplied list, unlike the parser's 1-based `line`.
 */
export function printCommitLog(records: readonly CommitRecord[]): PrintResult {
  // Req 4.1 caps a Commit_Log at 500 commit entries and the parser refuses the 501st, so printing a
  // longer list would produce text that cannot be parsed back at all.
  if (records.length > MAX_COMMIT_RECORDS) {
    return { ok: false, error: { kind: 'TOO_MANY_COMMITS', limit: MAX_COMMIT_RECORDS } };
  }

  const lines: string[] = [];
  for (const [index, record] of records.entries()) {
    const error = validate(record, index);
    if (error !== undefined) {
      return { ok: false, error };
    }
    // `( BlankLine+ CommitEntry )*`: a blank line separates consecutive entries. Together with the
    // mandatory blank line after `Date:` this yields two blank lines between records, which the
    // grammar's `BlankLine+` accepts and the parser's blank-line skip consumes as one separator.
    if (index > 0) {
      lines.push('');
    }
    lines.push(...recordLines(record));
  }

  // Every line is terminated, including the last, so the text ends in a single LF and the parser's
  // split leaves one trailing empty element — a `BlankLine` the grammar already allows.
  return { ok: true, text: lines.length === 0 ? '' : `${lines.join('\n')}\n` };
}
