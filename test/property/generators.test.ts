import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { codePointLength, hasNonWhitespaceCodePoint } from '../../src/core/code-points';
import {
  arbCommitLogModel,
  arbCommitLogText,
  arbCommitRecord,
  arbCredential,
  arbEntry,
  arbEntrySet,
  arbEntryWith,
  arbForeignPrincipalCredential,
  arbMalformedCommitLogModel,
  arbMarkdownBody,
  arbMarkdownHeadingBody,
  arbModelOutcome,
  arbNoteText,
  arbNoteTextAtLength,
  arbPublishedEntrySet,
  arbRequestArrivalSequence,
  arbTextOfCodePointLength,
  arbValidCredential,
  arbValidNoteText,
  AUTHOR_USERNAME,
  expectedCommitRecords,
  hasAllValidDimensions,
  renderCommitLog,
  renderCommitLogLines,
  renderMalformedCommitLog,
  toCrlf,
  toLf,
  ULID_ALPHABET,
} from '../generators';
import type { CredentialSpec } from '../generators';
import type { Entry } from '../../src/core/types';

/**
 * **Generator self-check. Not one of the 27 correctness properties.**
 *
 * `test/generators.ts` is the input space every property test draws from, so a generator that
 * silently drifts out of its stated bounds would weaken twenty-seven properties at once without
 * failing anything. These assertions check each generator against the invariants its own doc comment
 * claims — in-bounds Entries, unique identifiers in a set, grammar-conforming commit logs — and
 * nothing about the System under test.
 *
 * Distribution is deliberately *not* asserted here. Whether interesting cases appear often enough is
 * a sampling question, answered by sampling and reading the counts, not by a test that would turn a
 * shift in a weight into a red build.
 */

const ULID_PATTERN = new RegExp(`^[${ULID_ALPHABET}]{26}$`, 'u');
const SESSION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
/**
 * The design grammar's `CHAR`: any Unicode code point that is **not** CR or LF. No production admits
 * either, so a rendered line holding one means the renderer put a terminator inside a field.
 *
 * This is the class every field pattern below is built from, and the reason none of them uses `.`.
 * The dot excludes four code points, not two: CR, LF, **U+2028 LINE SEPARATOR, and U+2029 PARAGRAPH
 * SEPARATOR**. Both separators are ordinary `CHAR`s to the grammar, both are in
 * {@link WHITESPACE_CODE_POINTS}, and so both reach a generated author name — where a `.`-based
 * matcher rejects a line the grammar admits.
 */
const NON_CHAR_PATTERN = /[\r\n]/u;

/** `BlankLine ::= WS* EOL`, and the grammar's `WS` is a space or a tab, nothing wider. */
const BLANK_LINE_PATTERN = /^[ \t]*$/u;

/** `CommitLine ::= "commit" SP Hash EOL` with `Hash ::= HEXDIGIT{7,40}`. */
const COMMIT_LINE_PATTERN = /^commit [0-9a-fA-F]{7,40}$/u;

/** `MergeLine ::= "Merge:" SP CHAR+ EOL`. `CHAR+` is one or more, so the text may not be empty. */
const MERGE_LINE_PREFIX = 'Merge: ';

/**
 * `AuthorLine ::= "Author:" SP AuthorName SP "<" Email ">" EOL`.
 *
 * `AuthorName ::= CHAR+` — non-empty, and excluding `<` and `>`. `Email ::= CHAR*` — **starred**, so
 * `Author: name <>` is grammar-conforming and must be admitted; it excludes `>` only.
 */
const AUTHOR_LINE_PATTERN = /^Author: [^<>]+ <[^>]*>$/u;

/** `DateLine ::= "Date:" SP DateText EOL` with `DateText ::= CHAR+`, surrounding space trimmed. */
const DATE_LINE_PREFIX = 'Date: ';

/** `BodyLine ::= "    " CHAR* EOL`, exactly four leading spaces. */
const BODY_INDENT = '    ';

function isBlankLine(line: string): boolean {
  return BLANK_LINE_PATTERN.test(line);
}

/**
 * Classifies a rendered line against the design's `git log` grammar.
 *
 * The oracle is deliberately as strict as the grammar and no stricter: it has to fail on a generator
 * that drifts, and it must not fail on input the grammar admits. Every relaxation here would hide a
 * generator bug, and every over-tightening would report one that does not exist.
 */
function isGrammarLine(line: string): boolean {
  if (NON_CHAR_PATTERN.test(line)) {
    return false;
  }
  if (isBlankLine(line)) {
    return true;
  }
  if (COMMIT_LINE_PATTERN.test(line)) {
    return true;
  }
  if (line.startsWith(MERGE_LINE_PREFIX) && line.length > MERGE_LINE_PREFIX.length) {
    return true;
  }
  if (AUTHOR_LINE_PATTERN.test(line)) {
    return true;
  }
  // `DateText` is trimmed by the grammar, so a value that trims away to nothing is not a `CHAR+`.
  if (
    line.startsWith(DATE_LINE_PREFIX) &&
    hasNonWhitespaceCodePoint(line.slice(DATE_LINE_PREFIX.length))
  ) {
    return true;
  }
  // Ambiguity 1: a body line needs a non-whitespace code point after the indent, or the line is a
  // `BlankLine` that ends the body section instead.
  return line.startsWith(BODY_INDENT) && hasNonWhitespaceCodePoint(line.slice(BODY_INDENT.length));
}

function expectInBoundsEntry(entry: Entry): void {
  expect(entry.entryId).toMatch(ULID_PATTERN);
  expect(entry.sessionId).toMatch(ULID_PATTERN);
  expect(codePointLength(entry.title)).toBeGreaterThanOrEqual(1);
  expect(codePointLength(entry.title)).toBeLessThanOrEqual(120);
  expect(codePointLength(entry.body)).toBeGreaterThanOrEqual(1);
  expect(codePointLength(entry.body)).toBeLessThanOrEqual(20_000);
  expect(entry.sessionDate).toMatch(SESSION_DATE_PATTERN);
  expect(new Date(entry.sessionDate).toISOString().slice(0, 10)).toBe(entry.sessionDate);
  expect(entry.createdAt).toHaveLength(24);
  expect(entry.createdAt).toMatch(INSTANT_PATTERN);
  expect(entry.updatedAt).toHaveLength(24);
  expect(entry.updatedAt).toMatch(INSTANT_PATTERN);
  expect(['draft', 'published']).toContain(entry.status);
  expect(typeof entry.generationFailed).toBe('boolean');
  expect(entry.schemaVersion).toBe(1);
}

describe('arbTextOfCodePointLength', () => {
  it('produces exactly the requested number of code points', () => {
    // The length is a parameter of the generator rather than of the predicate, so this walks the
    // interesting lengths and samples each. Chunk-repetition kicks in above 48.
    for (const length of [0, 1, 2, 47, 48, 49, 200, 19_999, 20_000, 20_001]) {
      for (const text of fc.sample(arbTextOfCodePointLength(length), 10)) {
        expect(codePointLength(text)).toBe(length);
      }
    }
  });

  it('rejects a negative or fractional length', () => {
    expect(() => arbTextOfCodePointLength(-1)).toThrow(RangeError);
    expect(() => arbTextOfCodePointLength(1.5)).toThrow(RangeError);
  });
});

describe('arbCommitRecord', () => {
  it('produces records the Commit_Log_Printer accepts', () => {
    fc.assert(
      fc.property(arbCommitRecord, (record) => {
        expect(record.hash).toMatch(/^[0-9a-fA-F]{7,40}$/u);
        expect(record.authorName).toBe(record.authorName.trim());
        expect(record.authorName.length).toBeGreaterThan(0);
        expect(record.authorName).not.toMatch(/[\r\n<>]/u);
        expect(record.authorDate).toBe(record.authorDate.trim());
        expect(record.authorDate.length).toBeGreaterThan(0);
        expect(record.authorDate).not.toMatch(/[\r\n]/u);
        expect(record.subject).not.toMatch(/[\r\n]/u);
        // A non-empty subject always carries a non-whitespace code point, because a body line of
        // pure whitespace would be read back as a blank line and could not round-trip.
        if (record.subject !== '') {
          expect(hasNonWhitespaceCodePoint(record.subject)).toBe(true);
        }
      }),
    );
  });
});

describe('isGrammarLine', () => {
  // The oracle the next describe measures the renderer with. An oracle that is wrong in the strict
  // direction reports a generator bug that does not exist, which is how `Email ::= CHAR*` and the
  // U+2028 case were nearly "fixed" in the generator instead of here, so both are pinned.
  const admitted: readonly [string, string][] = [
    ['empty email, because `Email ::= CHAR*` is starred', 'Author: name <>'],
    ['U+2028 in the name, an ordinary `CHAR`', 'Author: a\u2028b <devlog@localhost>'],
    ['U+2029 in the name, an ordinary `CHAR`', 'Author: a\u2029b <devlog@localhost>'],
    ['U+2028 in the email', 'Author: name <a\u2028b>'],
    ['a name of one code point', 'Author: x <>'],
    ['tab padding the grammar trims', 'Author: \tname\t <devlog@localhost>'],
    ['the shortest hash', `commit ${'0'.repeat(7)}`],
    ['the longest hash', `commit ${'a'.repeat(40)}`],
    ['a blank line of spaces and tabs', ' \t '],
    ['a body line', '    fix bug  '],
    ['a merge line', 'Merge: abcdef0 1234567'],
    ['a date line', 'Date: Mon Jan 01 00:00:00 2020 +0000'],
  ];

  const refused: readonly [string, string][] = [
    ['an empty author name, because `AuthorName ::= CHAR+`', 'Author:  <>'],
    ['`<` inside the author name', 'Author: na<me <>'],
    ['`>` inside the author name', 'Author: na>me <>'],
    ['`>` inside the email', 'Author: name <a>b>'],
    ['a missing email', 'Author: name'],
    ['a 6-digit hash', `commit ${'0'.repeat(6)}`],
    ['a 41-digit hash', `commit ${'0'.repeat(41)}`],
    ['a non-hex hash', 'commit zzzzzzz'],
    ['CR inside a field, which is outside `CHAR`', 'Author: na\rme <>'],
    ['an empty merge line', 'Merge: '],
    ['a date line that trims away to nothing', 'Date:   '],
    ['a three-space indent, which is not a body line', '   fix bug'],
    ['non-ASCII whitespace alone, outside the WS of the grammar', '\u00a0'],
  ];

  it('admits exactly the lines the EBNF admits', () => {
    for (const [why, line] of admitted) {
      expect(isGrammarLine(line), why).toBe(true);
    }
    for (const [why, line] of refused) {
      expect(isGrammarLine(line), why).toBe(false);
    }
  });
});

describe('arbCommitLogText', () => {
  it('renders only lines the design grammar admits', () => {
    fc.assert(
      fc.property(arbCommitLogModel, (model) => {
        const lines = renderCommitLogLines(model);
        for (const line of lines) {
          expect(isGrammarLine(line), JSON.stringify(line)).toBe(true);
        }
        expect(lines.filter((line) => COMMIT_LINE_PATTERN.test(line))).toHaveLength(
          model.entries.length,
        );
      }),
    );
  });

  it('agrees with the expected Commit_Record list it publishes', () => {
    fc.assert(
      fc.property(arbCommitLogModel, (model) => {
        const expected = expectedCommitRecords(model);
        expect(expected).toHaveLength(model.entries.length);
        expected.forEach((record, index) => {
          const entry = model.entries[index];
          expect(entry).toBeDefined();
          expect(record.subject).toBe(entry?.bodyLines[0] ?? '');
          expect(record.authorName).toBe(record.authorName.trim());
          expect(record.authorDate).toBe(record.authorDate.trim());
        });
      }),
    );
  });

  it('is text, and carries a commit line whenever the model holds an entry', () => {
    fc.assert(
      fc.property(arbCommitLogModel, (model) => {
        const text = renderCommitLog(model);
        expect(typeof text).toBe('string');
        if (model.entries.length === 0) {
          // The Req 4.8 case: empty or whitespace only.
          expect(hasNonWhitespaceCodePoint(text)).toBe(false);
        } else {
          expect(text).toMatch(/^commit [0-9a-fA-F]{7,40}$/mu);
        }
      }),
    );
  });

  it('round-trips through the CRLF and LF conversions', () => {
    fc.assert(
      fc.property(arbCommitLogText, (text) => {
        expect(toLf(toCrlf(text))).toBe(toLf(text));
        // Every LF in the CRLF form is preceded by a CR.
        expect(toCrlf(text)).not.toMatch(/(^|[^\r])\n/u);
      }),
    );
  });
});

describe('arbMalformedCommitLogText', () => {
  it('always changes the conforming text it starts from', () => {
    fc.assert(
      fc.property(arbMalformedCommitLogModel, (model) => {
        const malformed = renderMalformedCommitLog(model);
        expect(malformed.length).toBeGreaterThan(0);
        expect(malformed).not.toBe(renderCommitLog(model.base));
      }),
    );
  });
});

describe('arbEntry', () => {
  it('produces in-bounds Entries', () => {
    fc.assert(fc.property(arbEntry, expectInBoundsEntry));
  });

  it('honours pinned fields', () => {
    fc.assert(
      fc.property(
        arbEntryWith({
          sessionDate: '2026-09-19',
          status: 'published',
          createdAt: '2026-09-19T21:04:11.417Z',
        }),
        (entry) => {
          expectInBoundsEntry(entry);
          expect(entry.sessionDate).toBe('2026-09-19');
          expect(entry.status).toBe('published');
          expect(entry.createdAt).toBe('2026-09-19T21:04:11.417Z');
        },
      ),
    );
  });
});

describe('arbEntrySet', () => {
  it('produces unique entry identifiers and in-bounds members', () => {
    fc.assert(
      fc.property(arbEntrySet, (entries) => {
        expect(entries.length).toBeLessThanOrEqual(120);
        expect(new Set(entries.map((entry) => entry.entryId)).size).toBe(entries.length);
        for (const entry of entries) {
          expectInBoundsEntry(entry);
        }
      }),
      // Sets reach 120 members, each carrying a generated title and body.
      { numRuns: 100 },
    );
  });

  it('draws session dates and creation timestamps from small pools, so ties are reachable', () => {
    fc.assert(
      fc.property(arbEntrySet, (entries) => {
        expect(new Set(entries.map((entry) => entry.sessionDate)).size).toBeLessThanOrEqual(4);
        expect(new Set(entries.map((entry) => entry.createdAt)).size).toBeLessThanOrEqual(4);
      }),
    );
  });

  it('pins the status when asked', () => {
    fc.assert(
      fc.property(arbPublishedEntrySet, (entries) => {
        for (const entry of entries) {
          expect(entry.status).toBe('published');
        }
      }),
    );
  });
});

describe('arbMarkdownBody', () => {
  it('produces non-empty Markdown', () => {
    fc.assert(
      fc.property(arbMarkdownBody, (body) => {
        expect(body.length).toBeGreaterThan(0);
      }),
    );
  });

  it('reaches every heading level in its heading-focused variant', () => {
    fc.assert(
      fc.property(arbMarkdownHeadingBody, (body) => {
        for (let level = 1; level <= 6; level += 1) {
          expect(body).toMatch(new RegExp(`^#{${level}} `, 'mu'));
        }
      }),
    );
  });
});

describe('arbNoteText', () => {
  it('stays inside the widest length the boundary cases reach', () => {
    fc.assert(
      fc.property(arbNoteText, (text) => {
        expect(typeof text).toBe('string');
        expect(codePointLength(text)).toBeLessThanOrEqual(20_002);
      }),
    );
  });

  it('produces exactly the requested length, with a non-whitespace code point', () => {
    expect(fc.sample(arbNoteTextAtLength(0), 1)).toEqual(['']);
    for (const length of [1, 2, 19_999, 20_000, 20_001]) {
      for (const text of fc.sample(arbNoteTextAtLength(length), 10)) {
        expect(codePointLength(text)).toBe(length);
        expect(hasNonWhitespaceCodePoint(text)).toBe(true);
      }
    }
  });

  it('produces acceptable note text in the valid variant', () => {
    fc.assert(
      fc.property(arbValidNoteText, (text) => {
        const length = codePointLength(text);
        expect(length).toBeGreaterThanOrEqual(1);
        expect(length).toBeLessThanOrEqual(20_000);
        expect(hasNonWhitespaceCodePoint(text)).toBe(true);
      }),
    );
  });
});

describe('arbRequestArrivalSequence', () => {
  it('produces a non-decreasing sequence of whole milliseconds', () => {
    fc.assert(
      fc.property(arbRequestArrivalSequence, (arrivals) => {
        let previous = -1;
        for (const arrival of arrivals) {
          expect(Number.isInteger(arrival)).toBe(true);
          expect(arrival).toBeGreaterThanOrEqual(0);
          expect(arrival).toBeGreaterThanOrEqual(previous);
          previous = arrival;
        }
      }),
    );
  });
});

describe('arbModelOutcome', () => {
  it('produces outcomes that match their own kind', () => {
    fc.assert(
      fc.property(arbModelOutcome, (outcome) => {
        switch (outcome.kind) {
          case 'VALID': {
            expect(codePointLength(outcome.title)).toBeGreaterThanOrEqual(1);
            expect(codePointLength(outcome.title)).toBeLessThanOrEqual(120);
            expect(codePointLength(outcome.body)).toBeGreaterThanOrEqual(200);
            expect(codePointLength(outcome.body)).toBeLessThanOrEqual(10_000);
            break;
          }
          case 'INVALID_TITLE_LENGTH': {
            const length = codePointLength(outcome.title);
            expect(length === 0 || length > 120).toBe(true);
            break;
          }
          case 'INVALID_BODY_LENGTH': {
            const length = codePointLength(outcome.body);
            expect(length < 200 || length > 10_000).toBe(true);
            break;
          }
          case 'MALFORMED_OUTPUT': {
            // Not a JSON object carrying the two contract keys as strings.
            let parsed: unknown;
            try {
              parsed = JSON.parse(outcome.text);
            } catch {
              parsed = undefined;
            }
            const isContract =
              typeof parsed === 'object' &&
              parsed !== null &&
              'title' in parsed &&
              'body' in parsed &&
              typeof (parsed as { title: unknown }).title === 'string' &&
              typeof (parsed as { body: unknown }).body === 'string';
            expect(isContract).toBe(false);
            break;
          }
          case 'THROTTLED': {
            expect(outcome.retryAfterSeconds).toBeGreaterThanOrEqual(0);
            break;
          }
          case 'SERVER_ERROR': {
            expect(outcome.statusCode).toBeGreaterThanOrEqual(500);
            expect(outcome.statusCode).toBeLessThan(600);
            break;
          }
          case 'DEADLINE_ELAPSED':
            break;
        }
      }),
    );
  });
});

describe('arbCredential', () => {
  function expectConsistentSpec(spec: CredentialSpec): void {
    expect(['absent', 'malformed', 'present']).toContain(spec.presence);
    expect(['authService', 'foreignKey']).toContain(spec.signature);
    expect(['authService', 'foreign']).toContain(spec.issuer);
    expect(['expected', 'foreign']).toContain(spec.clientId);
    expect(['access', 'id']).toContain(spec.tokenUse);
    expect(['future', 'past']).toContain(spec.expiry);
    expect(['none', 'revoked']).toContain(spec.revocation);
    expect(['author', 'other']).toContain(spec.username);
    expect(spec.jti).toMatch(ULID_PATTERN);
    expect(spec.subject).toMatch(ULID_PATTERN);
    expect(spec.issuedAtEpochSeconds).toBeLessThan(spec.referenceEpochSeconds);
    if (spec.expiry === 'future') {
      expect(spec.expiresAtEpochSeconds).toBeGreaterThan(spec.referenceEpochSeconds);
    } else {
      expect(spec.expiresAtEpochSeconds).toBeLessThan(spec.referenceEpochSeconds);
    }
    if (spec.username === 'author') {
      expect(spec.usernameClaim).toBe(AUTHOR_USERNAME);
    } else {
      expect(spec.usernameClaim).not.toBe(AUTHOR_USERNAME);
    }
  }

  it('describes each validity dimension consistently', () => {
    fc.assert(fc.property(arbCredential, expectConsistentSpec));
  });

  it('marks the fully valid variant valid in every dimension', () => {
    fc.assert(
      fc.property(arbValidCredential, (spec) => {
        expectConsistentSpec(spec);
        expect(hasAllValidDimensions(spec)).toBe(true);
      }),
    );
  });

  it('fails only the username dimension in the foreign-principal variant', () => {
    fc.assert(
      fc.property(arbForeignPrincipalCredential, (spec) => {
        expectConsistentSpec(spec);
        expect(hasAllValidDimensions(spec)).toBe(false);
        expect(hasAllValidDimensions({ ...spec, username: 'author' })).toBe(true);
      }),
    );
  });
});
