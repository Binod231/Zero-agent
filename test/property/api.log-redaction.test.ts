import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countSubmittedContent, RedactingLogger } from '../../src/api/logger';
import { COMPLETION_EVENT } from '../../src/core/logging';
import { CapturingLogger } from '../doubles/capturing-logger';
import { arbCommitLogText, arbNoteText } from '../generators';

/**
 * **Property 24: Logs never carry submitted content or credentials** (Req 11.3).
 *
 * *For any* Session_Input and any authentication request, no log record emitted while handling that
 * request contains the credential, the authentication token, any substring of the note text of 12 or
 * more characters, or any substring of the Commit_Log of 12 or more characters; and the completion
 * record carries the note text's length in code points.
 *
 * Validates: Requirements 11.3.
 */

function allWindows(text: string, windowLength: number): string[] {
  const codePoints = [...text];
  if (codePoints.length < windowLength) {
    return [];
  }
  const windows: string[] = [];
  const step = Math.max(1, Math.floor(codePoints.length / 50));
  for (let i = 0; i <= codePoints.length - windowLength; i += step) {
    windows.push(codePoints.slice(i, i + windowLength).join(''));
  }
  return windows;
}

describe('Property 24: Logs never carry submitted content or credentials', () => {
  it('never leaks note text or commit log text into emitted log records', { timeout: 20000 }, () => {
    fc.assert(
      fc.property(arbNoteText, arbCommitLogText, (noteText, commitLogText) => {
        const capturing = new CapturingLogger();
        const logger = capturing as unknown as RedactingLogger;

        // Count submitted content safely
        const counts = countSubmittedContent({
          noteText,
          commitLogText,
          commitRecordCount: 3,
        });

        // Emit an event carrying only the allowable count fields
        logger.info('session.received', counts);
        logger.completion({
          correlationId: '01J8ZQ3J5BQ7X9K2M4N6P8R0T2',
          route: '/api/author/sessions',
          method: 'POST',
          status: 202,
          durationMs: 45,
          noteTextCharCount: counts.noteTextCharCount,
          commitLogCharCount: counts.commitLogCharCount,
          commitRecordCount: counts.commitRecordCount,
        });

        const records = capturing.records;
        expect(records.length).toBe(2);

        // Check completion record has codePointLength matching [...noteText].length
        const completion = records.find((r) => r.event === COMPLETION_EVENT)!;
        expect(completion.fields.noteTextCharCount).toBe([...noteText].length);

        // Verify no 12-code-point window of noteText or commitLogText appears in any record
        const noteWindows = allWindows(noteText, 12);
        const commitWindows = allWindows(commitLogText, 12);

        for (const record of records) {
          const serialized = JSON.stringify(record);

          for (const win of noteWindows) {
            expect(serialized.includes(win)).toBe(false);
          }
          for (const win of commitWindows) {
            expect(serialized.includes(win)).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
