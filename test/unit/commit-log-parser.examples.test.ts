import { describe, expect, it } from 'vitest';
import { parseCommitLog } from '../../src/core/commit-log-parser';
import type { ParseResult } from '../../src/core/types';

/**
 * **The example layer for the Commit_Log_Parser.** Five recognizable `git log` pastes, each asserted
 * against the full `ParseResult` so this file also documents the return shape.
 *
 * It is deliberately small and it should stay that way. Exhaustive coverage lives in the properties:
 *
 * - **Property 2** (`test/property/commit-log-parser.totality.test.ts`) — totality and determinism
 *   over every input, including hostile and quarter-megabyte text (Req 4.4, 4.10).
 * - **Property 3** (`…/commit-log-parser.line-endings.test.ts`) — CRLF and LF forms agree, and
 *   non-ASCII author names survive code point for code point (Req 4.2).
 * - **Property 4** (`…/commit-log-parser.subject.test.ts`) — the body-line subject rule over
 *   generated body-line counts, blank-line spellings, and entry orders (Req 4.1, 4.3, 4.8, 4.9).
 *
 * The three resolved grammar ambiguities and the 500-entry ceiling have their own narrow cover in
 * `commit-log-parser.ambiguities.test.ts`. So: a reader who wants to know *what the parser accepts*
 * reads this file, and a reader who wants to know *that it always holds* reads the properties. New
 * hand-written cases belong in neither — the design names "fifty hand-written parser cases that a
 * single round-trip property subsumes" as the failure mode to avoid.
 *
 * Every paste below is real `git log` default output: 40-character hashes, `Author: Name <email>`,
 * git's default date format, and `Date:` padded to align with `Author:`.
 */

/** Three consecutive commits, which is what `git log` prints for a day's work. */
const THREE_COMMIT_LOG = `commit 9c1f3b7a4e2d8f60b5a1c3e7d9f0b2a4c6e8d1f3
Author: Binod Joshi <binod@example.com>
Date:   Mon Sep 21 09:14:02 2026 +0000

    Add the Commit_Log_Parser with the three resolved ambiguities

commit 4e7d2a9f1b3c5e8d0a2f4b6c8e1d3f5a7b9c0e2d
Author: Binod Joshi <binod@example.com>
Date:   Mon Sep 21 11:02:47 2026 +0000

    Wire the health route into the API Gateway stage

commit 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d
Author: Binod Joshi <binod@example.com>
Date:   Tue Sep 22 08:30:11 2026 +0000

    Pin fast-check and fix the CI seed
`;

/** A merge commit, which carries a `Merge:` line naming the two parents between `commit` and `Author`. */
const MERGE_COMMIT_LOG = `commit 6b5e0d3c9a7f1b2e4d8c0a6f3e5b7d9c1a2f4e60
Merge: 4f2a1c9 8b3e0d7
Author: Binod Joshi <binod@example.com>
Date:   Tue Sep 22 14:05:33 2026 +0000

    Merge branch 'parser-grammar' into main
`;

/** A commit with an empty message: header, the mandatory blank line, and no body lines at all. */
const EMPTY_MESSAGE_LOG = `commit 0f9e8d7c6b5a49382716f5e4d3c2b1a09f8e7d6c
Author: Binod Joshi <binod@example.com>
Date:   Wed Sep 23 07:45:00 2026 +0000

`;

/**
 * A commit whose message wraps over three lines. The lines are consecutive: a blank line would end
 * the entry rather than continue the message, which is ambiguity 1 and is covered next door.
 */
const THREE_BODY_LINE_LOG = `commit 2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f
Author: Binod Joshi <binod@example.com>
Date:   Wed Sep 23 16:20:18 2026 +0000

    Reject oversized entries before the DynamoDB call
    The check runs against encodedSizeBytes, which mirrors DynamoDB's
    own accounting, so an oversized Entry never leaves the process.
`;

/**
 * A paste that was cut short: the second entry's `Author` line is missing, so the `Date` line on
 * line 8 is where the parser stops.
 */
const MISSING_AUTHOR_LINE_LOG = `commit 9c1f3b7a4e2d8f60b5a1c3e7d9f0b2a4c6e8d1f3
Author: Binod Joshi <binod@example.com>
Date:   Mon Sep 21 09:14:02 2026 +0000

    Add the Commit_Log_Parser with the three resolved ambiguities

commit 4e7d2a9f1b3c5e8d0a2f4b6c8e1d3f5a7b9c0e2d
Date:   Mon Sep 21 11:02:47 2026 +0000

    Wire the health route into the API Gateway stage
`;

describe('parseCommitLog — a well-formed multi-commit git log (Req 4.1)', () => {
  it('returns one record per commit, in the order they appear', () => {
    const expected: ParseResult = {
      ok: true,
      records: [
        {
          hash: '9c1f3b7a4e2d8f60b5a1c3e7d9f0b2a4c6e8d1f3',
          authorName: 'Binod Joshi',
          authorDate: 'Mon Sep 21 09:14:02 2026 +0000',
          subject: 'Add the Commit_Log_Parser with the three resolved ambiguities',
        },
        {
          hash: '4e7d2a9f1b3c5e8d0a2f4b6c8e1d3f5a7b9c0e2d',
          authorName: 'Binod Joshi',
          authorDate: 'Mon Sep 21 11:02:47 2026 +0000',
          subject: 'Wire the health route into the API Gateway stage',
        },
        {
          hash: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
          authorName: 'Binod Joshi',
          authorDate: 'Tue Sep 22 08:30:11 2026 +0000',
          subject: 'Pin fast-check and fix the CI seed',
        },
      ],
    };

    // The email is parsed and discarded: a Commit_Record carries the name, the date, the hash, and
    // the subject, and nothing else reaches the Entry_Generator.
    expect(parseCommitLog(THREE_COMMIT_LOG)).toStrictEqual(expected);
  });
});

describe('parseCommitLog — a merge commit (Req 4.1)', () => {
  const expected: ParseResult = {
    ok: true,
    records: [
      {
        hash: '6b5e0d3c9a7f1b2e4d8c0a6f3e5b7d9c1a2f4e60',
        authorName: 'Binod Joshi',
        authorDate: 'Tue Sep 22 14:05:33 2026 +0000',
        subject: "Merge branch 'parser-grammar' into main",
      },
    ],
  };

  it('accepts the Merge line and keeps the parent hashes out of the record', () => {
    expect(parseCommitLog(MERGE_COMMIT_LOG)).toStrictEqual(expected);
  });

  it('reads the same subject with the Merge line removed, so the line shifts nothing', () => {
    // The optional Merge line moves the Author and Date lines down by one. Deleting it must change
    // nothing about the record, which is what says the subject is found by structure rather than by
    // counting lines from the top of the entry.
    const withoutMergeLine = MERGE_COMMIT_LOG.split('\n')
      .filter((line) => !line.startsWith('Merge:'))
      .join('\n');

    expect(parseCommitLog(withoutMergeLine)).toStrictEqual(expected);
  });
});

describe('parseCommitLog — a commit with no body lines (Req 4.3)', () => {
  it('returns a subject of zero characters and keeps the header fields', () => {
    const expected: ParseResult = {
      ok: true,
      records: [
        {
          hash: '0f9e8d7c6b5a49382716f5e4d3c2b1a09f8e7d6c',
          authorName: 'Binod Joshi',
          authorDate: 'Wed Sep 23 07:45:00 2026 +0000',
          subject: '',
        },
      ],
    };

    expect(parseCommitLog(EMPTY_MESSAGE_LOG)).toStrictEqual(expected);
  });
});

describe('parseCommitLog — a commit with three body lines (Req 4.9)', () => {
  it('takes the first body line as the subject and excludes the rest', () => {
    const expected: ParseResult = {
      ok: true,
      records: [
        {
          hash: '2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f',
          authorName: 'Binod Joshi',
          authorDate: 'Wed Sep 23 16:20:18 2026 +0000',
          subject: 'Reject oversized entries before the DynamoDB call',
        },
      ],
    };

    expect(parseCommitLog(THREE_BODY_LINE_LOG)).toStrictEqual(expected);
  });
});

describe('parseCommitLog — a truncated entry missing its Author line (Req 4.4)', () => {
  it('reports the 1-based line number of the first non-conforming line and no record list', () => {
    // Line 8 is the `Date:` line of the second entry, which is where the Author line should be. The
    // first entry parsed cleanly, and its record is still discarded: a malformed log yields an error
    // and no partial list.
    expect(MISSING_AUTHOR_LINE_LOG.split('\n')[7]).toBe('Date:   Mon Sep 21 11:02:47 2026 +0000');

    const result = parseCommitLog(MISSING_AUTHOR_LINE_LOG);

    // The error branch carries no `records` key at all, so a caller cannot read a partial list off a
    // failed parse.
    expect({ ok: result.ok, hasRecords: Object.hasOwn(result, 'records') }).toStrictEqual({
      ok: false,
      hasRecords: false,
    });
    if (!result.ok) {
      expect(result.error.kind).toBe('MALFORMED');
      expect(result.error.line).toBe(8);
      if (result.error.kind === 'MALFORMED') {
        expect(result.error.expected).toContain('Author:');
      }
    }
  });
});
