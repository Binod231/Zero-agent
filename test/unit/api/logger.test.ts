import { Logger } from '@aws-lambda-powertools/logger';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOW_LISTED_FIELD_NAMES,
  countSubmittedContent,
  describeErrorType,
  parseEmittedRecord,
  RedactingLogger,
  systemMessage,
} from '../../../src/api/logger';
import type { DevlogLogger } from '../../../src/core/logging';
import { COMPLETION_EVENT } from '../../../src/core/logging';
import { CapturingLogger } from '../../doubles/capturing-logger';

/**
 * Unit tests of the redacting logger. Not correctness properties — Property 24 (log redaction) and
 * Property 25 (correlation identifiers) are separate tasks — these check the wrapper's own contract:
 * the allow-list holds at compile time, the completion record carries Req 11.1's fields as valid
 * JSON, submitted text has no way in while its counts do, and a bound identifier reaches every record.
 *
 * Records are captured off the real transport. Powertools writes through its own `Console` bound to
 * `process.stdout` and `process.stderr`, so spying on the two streams exercises the same path Lambda
 * forwards to CloudWatch Logs, with no AWS environment and no AWS call.
 */

const CORRELATION_ID = '01J8ZQ3J5BQ7X9K2M4N6P8R0T2';
const NOTE_TEXT =
  'Shipped the token bucket today; 🚀 conditional UpdateItem does refill and consume.';
const COMMIT_LOG_TEXT = 'a1b2c3d 2026-09-19 Add rate limiter\ne4f5g6h 2026-09-19 Fix backoff';

interface Capture {
  /** The raw JSON lines both streams received, in order. */
  lines: string[];
  restore: () => void;
}

function captureStreams(): Capture {
  const lines: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const collect = (chunk: unknown): boolean => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() !== '') {
        lines.push(line);
      }
    }
    return true;
  };
  process.stdout.write = collect;
  process.stderr.write = collect;
  return {
    lines,
    restore: () => {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    },
  };
}

let capture: Capture | undefined;

function loggerCapturing(correlationId?: string): { logger: RedactingLogger; lines: string[] } {
  capture = captureStreams();
  const powertools = new Logger({ serviceName: 'devlog-api', logLevel: 'DEBUG' });
  const root = new RedactingLogger({ logger: powertools });
  return {
    logger: correlationId === undefined ? root : root.withCorrelationId(correlationId),
    lines: capture.lines,
  };
}

afterEach(() => {
  capture?.restore();
  capture = undefined;
});

describe('RedactingLogger allow-list', () => {
  it('rejects any field outside the allow-list at compile time', () => {
    const logger: DevlogLogger = new CapturingLogger();

    /**
     * Deliberately never invoked: `npx tsc --noEmit` is the assertion. Every `@ts-expect-error`
     * below fails the build the moment its call becomes legal (unused directive, TS2578), so the
     * compile-time guarantee is tested rather than assumed. Running these calls would prove nothing,
     * since the guarantee is that they never reach runtime.
     */
    const rejectedAtCompileTime = (): void => {
      // A literal carrying note text.
      // @ts-expect-error noteText is not an allow-listed field
      logger.info('session.accepted', { noteText: NOTE_TEXT });

      // A pre-built variable, where excess property checking does not apply, next to a legal field.
      const leaky = { route: 'POST /api/author/sessions', noteText: NOTE_TEXT };
      // @ts-expect-error noteText is not an allow-listed field
      logger.info('session.accepted', leaky);

      // The arbitrary object the design forbids any method from taking.
      const bag: Record<string, unknown> = { route: 'POST /api/author/sessions' };
      // @ts-expect-error a logger method never takes an arbitrary object
      logger.info('session.accepted', bag);

      // Credentials and tokens have no field either.
      // @ts-expect-error accessToken is not an allow-listed field
      logger.error('auth.failed', { accessToken: 'eyJhbGciOi.payload.signature' });

      // An allow-listed key with the wrong type is still a compile error.
      // @ts-expect-error status is a number
      logger.info('request.completed', { status: '202' });

      // Submitted text as it actually arrives: a `string`, not a literal type.
      const submitted: string = NOTE_TEXT;
      // @ts-expect-error only a string literal can become a LoggableMessage
      logger.error('request.failed', { errorMessage: systemMessage(submitted) });

      // A plain string in the branded field, bypassing the literal check.
      // @ts-expect-error errorMessage takes a LoggableMessage, not a string
      logger.error('request.failed', { errorMessage: `parse failed near ${NOTE_TEXT}` });

      // Completion fields are closed the same way.
      logger.completion({
        route: 'POST /api/author/sessions',
        method: 'POST',
        status: 202,
        durationMs: 141,
        // @ts-expect-error commitLogText is not an allow-listed field
        commitLogText: COMMIT_LOG_TEXT,
      });
    };

    // The calls the wrapper exists to serve, which do compile and do run.
    logger.info('session.accepted', { route: 'POST /api/author/sessions', status: 202 });
    logger.completion({
      route: 'POST /api/author/sessions',
      method: 'POST',
      status: 202,
      durationMs: 141,
      noteTextCharCount: [...NOTE_TEXT].length,
    });

    expect((logger as CapturingLogger).records).toHaveLength(2);
    expect(rejectedAtCompileTime).toBeTypeOf('function');
  });

  it('holds no field name that could carry submitted text or a credential', () => {
    expect(ALLOW_LISTED_FIELD_NAMES).toContain('noteTextCharCount');
    expect(ALLOW_LISTED_FIELD_NAMES).toContain('commitLogCharCount');
    expect(ALLOW_LISTED_FIELD_NAMES).toContain('commitRecordCount');
    for (const forbidden of [
      'noteText',
      'commitLogText',
      'commitLog',
      'password',
      'credential',
      'accessToken',
      'refreshToken',
      'token',
      'authorization',
      'body',
      'stack',
    ]) {
      expect(ALLOW_LISTED_FIELD_NAMES).not.toContain(forbidden);
    }
  });

  it('drops an unknown key that reached it across a type assertion', () => {
    const { logger, lines } = loggerCapturing();

    // What an untyped caller or an `as` cast could still attempt at runtime.
    const smuggled = { route: 'POST /api/author/sessions', noteText: NOTE_TEXT };
    (logger as { info(event: string, fields: object): void }).info('session.accepted', smuggled);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('POST /api/author/sessions');
    expect(lines[0]).not.toContain('noteText');
    expect(lines[0]).not.toContain('token bucket');
  });
});

describe('RedactingLogger content counts', () => {
  it('converts submitted text into code-point counts and nothing else', () => {
    const counts = countSubmittedContent({
      noteText: NOTE_TEXT,
      commitLogText: COMMIT_LOG_TEXT,
      commitRecordCount: 2,
    });

    // Code points, so the rocket counts once rather than twice.
    expect(counts).toEqual({
      noteTextCharCount: [...NOTE_TEXT].length,
      commitLogCharCount: [...COMMIT_LOG_TEXT].length,
      commitRecordCount: 2,
    });
    expect(counts.noteTextCharCount).toBeLessThan(NOTE_TEXT.length);
  });

  it('counts absent content as zero', () => {
    expect(countSubmittedContent({})).toEqual({
      noteTextCharCount: 0,
      commitLogCharCount: 0,
      commitRecordCount: 0,
    });
  });

  it('logs the counts while the text itself never appears in the record', () => {
    const { logger, lines } = loggerCapturing(CORRELATION_ID);
    const counts = countSubmittedContent({
      noteText: NOTE_TEXT,
      commitLogText: COMMIT_LOG_TEXT,
      commitRecordCount: 2,
    });

    logger.completion({
      route: 'POST /api/author/sessions',
      method: 'POST',
      status: 202,
      durationMs: 141,
      ...counts,
    });

    const record = parseEmittedRecord(lines[0] ?? '');
    expect(record.fields.noteTextCharCount).toBe([...NOTE_TEXT].length);
    expect(record.fields.commitLogCharCount).toBe([...COMMIT_LOG_TEXT].length);
    expect(record.fields.commitRecordCount).toBe(2);
    // No 12-code-point window of either input survives anywhere in the line (Property 24's shape).
    expect(lines[0]).not.toContain('token bucket');
    expect(lines[0]).not.toContain('Add rate li');
  });
});

describe('RedactingLogger completion record', () => {
  it('carries the correlation identifier, route, method, status, and duration as valid JSON', () => {
    const { logger, lines } = loggerCapturing(CORRELATION_ID);

    logger.completion({
      route: 'POST /api/author/sessions',
      method: 'POST',
      status: 202,
      durationMs: 141,
      noteTextCharCount: 1842,
      commitLogCharCount: 0,
      commitRecordCount: 0,
    });

    expect(lines).toHaveLength(1);
    const flat: unknown = JSON.parse(lines[0] ?? '');
    expect(flat).toMatchObject({
      level: 'INFO',
      message: COMPLETION_EVENT,
      correlationId: CORRELATION_ID,
      route: 'POST /api/author/sessions',
      method: 'POST',
      status: 202,
      durationMs: 141,
      noteTextCharCount: 1842,
      commitLogCharCount: 0,
      commitRecordCount: 0,
    });

    const record = parseEmittedRecord(lines[0] ?? '');
    expect(record.event).toBe(COMPLETION_EVENT);
    expect(record.level).toBe('info');
    expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
  });

  it('normalizes a captured line into the shape the capturing double produces', () => {
    const { logger, lines } = loggerCapturing(CORRELATION_ID);
    const double = new CapturingLogger({ correlationId: CORRELATION_ID });

    for (const target of [logger, double]) {
      target.warn('quota.exceeded', { retryAfterSeconds: 42 });
    }

    const fromReal = parseEmittedRecord(lines[0] ?? '');
    const fromDouble = double.records[0];
    // Same assertions inspect either transport: level, event, and fields all line up.
    expect(fromReal.level).toBe(fromDouble?.level);
    expect(fromReal.event).toBe(fromDouble?.event);
    expect(fromReal.fields).toEqual(fromDouble?.fields);
  });

  it('rejects a line that is not a structured record', () => {
    expect(() => parseEmittedRecord('START RequestId: abc')).toThrow(SyntaxError);
    expect(() => parseEmittedRecord('[1,2]')).toThrow(TypeError);
    expect(() => parseEmittedRecord('{"level":"INFO"}')).toThrow(TypeError);
  });
});

describe('RedactingLogger error records', () => {
  it('carries the correlation identifier, error type, and a System-authored message', () => {
    const { logger, lines } = loggerCapturing(CORRELATION_ID);

    logger.error('request.failed', {
      errorType: describeErrorType(new TypeError('boom')),
      errorMessage: systemMessage('unhandled error while handling the request'),
      errorCode: 'INTERNAL_ERROR',
    });

    const record = parseEmittedRecord(lines[0] ?? '');
    expect(record.level).toBe('error');
    expect(record.fields).toEqual({
      correlationId: CORRELATION_ID,
      errorType: 'TypeError',
      errorMessage: 'unhandled error while handling the request',
      errorCode: 'INTERNAL_ERROR',
    });
  });

  it('reduces an error type to a token, whatever the thrown value was', () => {
    class ProvisionedThroughputExceededException extends Error {
      override readonly name = 'ProvisionedThroughputExceededException';
    }
    expect(describeErrorType(new ProvisionedThroughputExceededException())).toBe(
      'ProvisionedThroughputExceededException',
    );

    // A name carrying prose — a message assigned to `name` — is stripped back to a token.
    const dressedUp = new Error('x');
    dressedUp.name = `Unexpected token in ${NOTE_TEXT}`;
    const derived = describeErrorType(dressedUp);
    expect(derived).not.toContain(' ');
    expect(derived.length).toBeLessThanOrEqual(64);
    expect(derived).not.toContain('token bucket');

    // Non-Error throwables still yield something loggable.
    expect(describeErrorType('a string was thrown')).toBe('string');
    expect(describeErrorType(undefined)).toBe('undefined');
    const nameless = new Error('x');
    nameless.name = '???';
    expect(describeErrorType(nameless)).toBe('UnknownError');
  });
});

describe('RedactingLogger correlation identifier binding', () => {
  it('stamps the bound identifier on every record at every level', () => {
    const { logger, lines } = loggerCapturing(CORRELATION_ID);

    logger.debug('cache.miss');
    logger.info('entry.published', { entryId: '01J8ZQ3K9YV2N7A4B6C8D0E1F2' });
    logger.warn('invalidation.failed', { operation: 'CreateInvalidation' });
    logger.error('store.unavailable', { errorCode: 'STORE_UNAVAILABLE' });
    logger.completion({ route: 'GET /api/health', method: 'GET', status: 200, durationMs: 3 });

    const records = lines.map((line) => parseEmittedRecord(line));
    expect(records).toHaveLength(5);
    expect(records.map((record) => record.level)).toEqual([
      'debug',
      'info',
      'warn',
      'error',
      'info',
    ]);
    // Req 11.7: one identifier across every record, within the 8-64 character bound.
    expect(new Set(records.map((record) => record.fields.correlationId))).toEqual(
      new Set([CORRELATION_ID]),
    );
    expect(CORRELATION_ID).toHaveLength(26);
  });

  it('emits no identifier before one is bound, and shares one stream with its child', () => {
    const { logger, lines } = loggerCapturing();
    const request = logger.withCorrelationId(CORRELATION_ID);

    logger.info('cold.start', { coldStart: true });
    request.info('session.accepted', { sessionId: '01J8ZQ3J5B0000000000000000' });

    const records = lines.map((line) => parseEmittedRecord(line));
    expect(records[0]?.fields.correlationId).toBeUndefined();
    expect(records[1]?.fields.correlationId).toBe(CORRELATION_ID);
  });

  it('keeps the bound identifier even when a caller passes a different one', () => {
    const { logger, lines } = loggerCapturing(CORRELATION_ID);

    logger.completion({
      route: 'GET /api/health',
      method: 'GET',
      status: 200,
      durationMs: 3,
      correlationId: '01OTHERREQUESTIDENTIFIER00',
    });

    expect(parseEmittedRecord(lines[0] ?? '').fields.correlationId).toBe(CORRELATION_ID);
  });
});
