import { describe, expect, it } from 'vitest';
import { MAX_COMMIT_RECORDS, parseCommitLog } from '../../src/core/commit-log-parser';
import { printCommitLog } from '../../src/core/commit-log-printer';
import type { CommitRecord } from '../../src/core/types';

/**
 * Example-based cover for the printer's own rules: the output shape of Req 4.5 and the five
 * rejection rules that make the printer partial.
 *
 * Deliberately narrow. The round trip of Req 4.6 across arbitrary accepted lists is Property 1 in
 * task 4.2; the one round-trip assertion here is a single well-formed record, present so a broken
 * output shape fails in this file rather than only in the property. Nothing here generates input,
 * and task 4.2 should not restate these rejection rules as examples.
 */

const VALID: CommitRecord = {
  hash: 'abcdef1',
  authorName: 'Ann Lee',
  authorDate: 'Mon Sep 21 2026',
  subject: 'fix the parser',
};

/** Narrows a successful print to its text, failing the test rather than returning `undefined`. */
function printed(records: readonly CommitRecord[]): string {
  const result = printCommitLog(records);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected a printable list, got ${result.error.kind}`);
  }
  return result.text;
}

describe('printCommitLog — output shape (Req 4.5)', () => {
  it('emits the commit, author, date, blank, and body lines in order', () => {
    expect(printed([VALID])).toBe(
      'commit abcdef1\nAuthor: Ann Lee <devlog@localhost>\nDate: Mon Sep 21 2026\n\n    fix the parser\n',
    );
  });

  it('uses LF line endings only, never CR', () => {
    const text = printed([VALID, { ...VALID, hash: '9876543', subject: 'second change' }]);

    expect(text).not.toContain('\r');
  });

  it('never emits a Merge line, since a Commit_Record carries no merge information', () => {
    expect(printed([VALID])).not.toContain('Merge');
  });

  it('emits no body line for an empty subject, and the parser reads the subject back as empty', () => {
    const text = printed([{ ...VALID, subject: '' }]);

    expect(text).toBe(
      'commit abcdef1\nAuthor: Ann Lee <devlog@localhost>\nDate: Mon Sep 21 2026\n\n',
    );
    expect(text.split('\n').some((line) => line.startsWith('    '))).toBe(false);
  });

  it('prints an empty list as the empty string', () => {
    expect(printed([])).toBe('');
  });

  it('produces text the parser reads back as the same records', () => {
    const records: CommitRecord[] = [
      VALID,
      { hash: 'ABCDEF0123456789', authorName: 'Ann Lee', authorDate: '2026-09-21', subject: '' },
    ];

    expect(parseCommitLog(printed(records))).toEqual({ ok: true, records });
  });
});

describe('printCommitLog — rejection rules', () => {
  it('rejects a hash that is not 7 to 40 hex digits', () => {
    for (const hash of ['abcde', 'g'.repeat(7), 'a'.repeat(41), 'abcdef1 ', '']) {
      expect(printCommitLog([{ ...VALID, hash }])).toEqual({
        ok: false,
        error: { kind: 'INVALID_HASH', index: 0 },
      });
    }
  });

  it('rejects an author name that is empty, untrimmed, line-broken, or angle-bracketed', () => {
    for (const authorName of ['', '   ', '\u3000', ' Ann', 'Ann ', 'A\nn', 'A\rn', 'A<n', 'A>n']) {
      expect(printCommitLog([{ ...VALID, authorName }])).toEqual({
        ok: false,
        error: { kind: 'INVALID_NAME', index: 0 },
      });
    }
  });

  it('rejects an author date that is empty, untrimmed, or line-broken', () => {
    for (const authorDate of ['', '  ', ' Mon', 'Mon ', 'Mon\n21', 'Mon\r']) {
      expect(printCommitLog([{ ...VALID, authorDate }])).toEqual({
        ok: false,
        error: { kind: 'INVALID_DATE', index: 0 },
      });
    }
  });

  it('rejects a line-broken subject and a non-empty subject that is only whitespace', () => {
    // The whitespace-only case would print as a body line the parser must read as a BLANK line
    // (grammar ambiguity 1), so the subject could not round-trip and the entry would be terminated
    // early. Refused rather than silently corrupted.
    for (const subject of ['fix\nup', 'fix\r', ' ', '\t', '\u3000']) {
      expect(printCommitLog([{ ...VALID, subject }])).toEqual({
        ok: false,
        error: { kind: 'INVALID_SUBJECT', index: 0 },
      });
    }
  });

  it('reports the first offending record by 0-based index', () => {
    const records: CommitRecord[] = [VALID, { ...VALID, authorDate: '' }, { ...VALID, hash: 'x' }];

    expect(printCommitLog(records)).toEqual({
      ok: false,
      error: { kind: 'INVALID_DATE', index: 1 },
    });
  });

  it(`rejects more than ${MAX_COMMIT_RECORDS} records before validating any of them`, () => {
    // The ceiling is checked first, so an oversized list holding an invalid record still reports the
    // ceiling — the reason that actually disqualifies the list.
    const oversized: CommitRecord[] = Array.from({ length: MAX_COMMIT_RECORDS + 1 }, () => VALID);
    oversized[0] = { ...VALID, hash: 'nothex' };

    expect(printCommitLog(oversized)).toEqual({
      ok: false,
      error: { kind: 'TOO_MANY_COMMITS', limit: 500 },
    });
  });

  it(`accepts exactly ${MAX_COMMIT_RECORDS} records`, () => {
    const atLimit: CommitRecord[] = Array.from({ length: MAX_COMMIT_RECORDS }, () => VALID);

    expect(parseCommitLog(printed(atLimit)).ok).toBe(true);
  });
});
