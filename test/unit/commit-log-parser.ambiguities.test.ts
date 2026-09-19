import { describe, expect, it } from 'vitest';
import { MAX_COMMIT_RECORDS, parseCommitLog } from '../../src/core/commit-log-parser';

/**
 * Sanity cover for the three grammar ambiguities the design resolves, plus the commit-entry ceiling
 * and a totality smoke test.
 *
 * Deliberately narrow. The example-based suite for the parser belongs to task 3.5 (well-formed
 * multi-commit log, merge commit, entry with no body lines, entry with three body lines, malformed
 * input with an asserted line number) and the exhaustive coverage belongs to Properties 2, 3, and 4
 * in tasks 3.2-3.4. Nothing here should be repeated there.
 */

/** One well-formed entry whose body lines the caller supplies already indented. */
function entry(hash: string, bodyLines: readonly string[]): string {
  return [`commit ${hash}`, 'Author: Ann Lee <ann@example.com>', 'Date: Mon Sep 21 2026', '']
    .concat(bodyLines)
    .join('\n');
}

describe('parseCommitLog — ambiguity 1: a whitespace-only line terminates the body section', () => {
  it('ends the entry at a line of four spaces rather than reading it as a body line', () => {
    // A line of exactly four spaces matches both BodyLine and BlankLine in the raw grammar. It is a
    // BlankLine, so the indented line after it sits outside the entry and has to begin the next
    // entry — which it does not.
    const result = parseCommitLog(`${entry('abcdef1', ['    first', '    ', '    second'])}\n`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('MALFORMED');
      expect(result.error.line).toBe(7); // the "    second" line
      if (result.error.kind === 'MALFORMED') {
        expect(result.error.expected).toContain('commit');
      }
    }
  });

  it('treats the terminating whitespace line as an entry separator', () => {
    const first = entry('abcdef1', ['    first', '  \t  ']);
    const second = entry('9876543', ['    later']);
    const result = parseCommitLog(`${first}\n${second}\n`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records.map((record) => record.subject)).toEqual(['first', 'later']);
    }
  });
});

describe('parseCommitLog — ambiguity 2: a lone CR is an ordinary character', () => {
  it('keeps a CR that is not part of a CRLF inside the field that holds it', () => {
    const text =
      'commit abcdef1\nAuthor: Ann\rLee <ann@example.com>\nDate: Mon\r21\n\n    fix\rup\n';
    const result = parseCommitLog(text);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toEqual([
        { hash: 'abcdef1', authorName: 'Ann\rLee', authorDate: 'Mon\r21', subject: 'fix\rup' },
      ]);
    }
  });
});

describe('parseCommitLog — ambiguity 3: trailing whitespace in a body line is significant', () => {
  it('strips only the four-space indent, keeping trailing spaces in the subject', () => {
    const result = parseCommitLog(`${entry('abcdef1', ['    fix bug  '])}\n`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records[0]?.subject).toBe('fix bug  ');
    }
  });

  it('leaves the extra indent of a deeper body line inside the subject', () => {
    const result = parseCommitLog(`${entry('abcdef1', ['        deeply indented'])}\n`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records[0]?.subject).toBe('    deeply indented');
    }
  });
});

describe('parseCommitLog — commit-entry ceiling', () => {
  // Six lines per entry: commit, Author, Date, blank, one body line, separator blank.
  const LINES_PER_ENTRY = 6;
  const block = (index: number): string => `${entry('abcdef1', [`    change ${index}`])}\n\n`;
  const blocks = (count: number): string =>
    Array.from({ length: count }, (_unused, index) => block(index)).join('');

  it(`accepts exactly ${MAX_COMMIT_RECORDS} commit entries`, () => {
    const result = parseCommitLog(blocks(MAX_COMMIT_RECORDS));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(MAX_COMMIT_RECORDS);
    }
  });

  it('rejects the 501st commit line, reporting that line number', () => {
    const result = parseCommitLog(blocks(MAX_COMMIT_RECORDS + 1));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'TOO_MANY_COMMITS',
        line: MAX_COMMIT_RECORDS * LINES_PER_ENTRY + 1,
        limit: 500,
      });
    }
  });
});

describe('parseCommitLog — totality smoke (Req 4.10)', () => {
  it('returns a well-formed result for empty and whitespace-only input', () => {
    for (const text of ['', ' ', '\n\n', '\u3000\t \r\n']) {
      expect(parseCommitLog(text)).toEqual({ ok: true, records: [] });
    }
  });

  it('returns an in-range line number instead of throwing on hostile input', () => {
    const hostile = [
      'commit',
      '\r', // a lone CR is whitespace, so this is whitespace-only input, not a malformed line
      '\ud800', // unpaired surrogate
      'commit abcdef1', // truncated entry: header stops before the author line
      'Author: x <y>',
      '\0\0\0',
      'x'.repeat(5000),
    ];

    for (const text of hostile) {
      const result = parseCommitLog(text);
      if (!result.ok) {
        expect(result.error.line).toBeGreaterThanOrEqual(1);
        expect(result.error.line).toBeLessThanOrEqual(text.split('\n').length);
      } else {
        expect(result.records).toEqual([]);
      }
    }
  });
});
