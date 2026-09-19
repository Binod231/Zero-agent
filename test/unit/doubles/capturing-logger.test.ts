import { describe, expect, it } from 'vitest';
import { COMPLETION_EVENT } from '../../../src/core/logging';
import { CapturingLogger } from '../../doubles/capturing-logger';
import { FrozenClock } from '../../doubles/clock';

/**
 * Unit tests of the capturing logger. Not correctness properties: these check that every emitted
 * record is retrievable and serializable, which is what Properties 23, 24, and 25 search through.
 */

const INSTANT = '2026-09-19T21:04:11.418Z';
const CORRELATION_ID = '01J8ZQ3J5BQ7X9K2M4N6P8R0T2';

describe('CapturingLogger', () => {
  it('captures every level with its event, timestamp, and fields', () => {
    const logger = new CapturingLogger({ clock: new FrozenClock(INSTANT) });

    logger.debug('cache.miss');
    logger.info('entry.published', { entryId: '01J8ZQ3K9YV2N7A4B6C8D0E1F2' });
    logger.warn('invalidation.failed', { operation: 'CreateInvalidation' });
    logger.error('store.unavailable', { errorCode: 'STORE_UNAVAILABLE' });

    expect(logger.records.map((record) => record.level)).toEqual([
      'debug',
      'info',
      'warn',
      'error',
    ]);
    expect(logger.records.map((record) => record.event)).toEqual([
      'cache.miss',
      'entry.published',
      'invalidation.failed',
      'store.unavailable',
    ]);
    expect(logger.records[1]).toEqual({
      level: 'info',
      timestamp: INSTANT,
      event: 'entry.published',
      fields: { entryId: '01J8ZQ3K9YV2N7A4B6C8D0E1F2' },
    });
  });

  it('stamps the bound correlation identifier on every record, including a child logger', () => {
    const root = new CapturingLogger({ clock: new FrozenClock(INSTANT) });
    const request = root.withCorrelationId(CORRELATION_ID);

    request.info('session.accepted', { sessionId: '01J8ZQ3J5B0000000000000000' });
    request.completion({
      route: 'POST /api/author/sessions',
      method: 'POST',
      status: 202,
      durationMs: 141,
      noteTextCharCount: 1842,
    });

    // The child writes into the root's capture, so one search term retrieves the whole chain.
    expect(root.records).toHaveLength(2);
    expect(root.records.every((record) => record.fields.correlationId === CORRELATION_ID)).toBe(
      true,
    );
  });

  it('emits the completion record under the one agreed event name', () => {
    const logger = new CapturingLogger();
    logger.info('unrelated');
    logger.completion({
      route: 'GET /api/health',
      method: 'GET',
      status: 200,
      durationMs: 3,
      correlationId: CORRELATION_ID,
    });

    const completions = logger.completionRecords();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.event).toBe(COMPLETION_EVENT);
    expect(completions[0]?.fields).toEqual({
      route: 'GET /api/health',
      method: 'GET',
      status: 200,
      durationMs: 3,
      correlationId: CORRELATION_ID,
    });
  });

  it('serializes every record as one JSON line', () => {
    const logger = new CapturingLogger({ clock: new FrozenClock(INSTANT) });
    logger.warn('quota.exceeded', { retryAfterSeconds: 42 });

    const lines = logger.jsonLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      level: 'warn',
      timestamp: INSTANT,
      event: 'quota.exceeded',
      fields: { retryAfterSeconds: 42 },
    });
  });

  it('freezes captured records and clears on request', () => {
    const logger = new CapturingLogger();
    logger.info('entry.published', { entryId: '01J8ZQ3K9YV2N7A4B6C8D0E1F2' });

    const record = logger.records[0];
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record?.fields)).toBe(true);

    logger.clear();
    expect(logger.records).toEqual([]);
  });
});
