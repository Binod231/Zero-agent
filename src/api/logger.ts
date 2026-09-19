/**
 * The redacting logger: the only sanctioned way anything in the System writes a log record.
 *
 * `no-console` is an ESLint error outside `scripts/**`, so this module is the single transport, and
 * that is what makes Req 11.3 enforceable rather than aspirational. It wraps the AWS Lambda
 * Powertools `Logger`, which supplies the JSON envelope, the service name, and the cold-start flag,
 * and adds the two things the design asks of the wrapper: the bound correlation identifier and a
 * closed allow-list of fields (design: *Structured logging*).
 *
 * **Redaction is enforced by construction.** Every method takes `F extends OnlyAllowListed<F>`, so
 * the compiler rejects any argument carrying a key outside `LogFields` — object literal or not, and
 * `Record<string, unknown>` included. Note text and Commit_Log text have no key to travel through;
 * only `noteTextCharCount`, `commitLogCharCount`, and `commitRecordCount` do (Req 11.3). The runtime
 * filter in `#emit` is belt-and-braces for callers that reach this module across a type assertion or
 * from untyped JavaScript: unknown keys are dropped, never logged.
 *
 * Req 11.2's error record is supported the same way: `describeErrorType` reduces a thrown value to a
 * class-name token, and `systemMessage` admits string literals only, so the error message in a record
 * is always text this repository wrote rather than text a request carried in.
 *
 * Powertools writes `debug`/`info` to stdout and `warn`/`error` to stderr through its own `Console`
 * bound to those streams, which is exactly what the Lambda runtime forwards to CloudWatch Logs. No
 * AWS call and no AWS environment is needed to construct one, so unit tests capture the real
 * transport by spying on the two streams; `parseEmittedRecord` then turns a captured line into the
 * same `LogRecord` shape `CapturingLogger` produces, so one set of assertions inspects either.
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { codePointLength } from '../core/code-points';
import type {
  DevlogLogger,
  LoggableMessage,
  LogFields,
  LogLevel,
  LogRecord,
  OnlyAllowListed,
  OnlyCompletionFields,
} from '../core/logging';
import { COMPLETION_EVENT } from '../core/logging';

/** Powertools `serviceName` when the caller supplies neither a name nor a `Logger`. */
const DEFAULT_SERVICE_NAME = 'devlog';

/**
 * The allow-list as a value, so the runtime filter and the type agree by construction.
 *
 * `Record<keyof LogFields, true>` makes every key of `LogFields` **required** here even though each
 * is optional there: adding a field to `LogFields` without adding it below is a compile error, and
 * naming a key that `LogFields` does not have is also a compile error. The list cannot drift.
 */
const ALLOW_LISTED: Readonly<Record<keyof LogFields, true>> = Object.freeze({
  correlationId: true,
  route: true,
  method: true,
  status: true,
  durationMs: true,
  noteTextCharCount: true,
  commitLogCharCount: true,
  commitRecordCount: true,
  entryId: true,
  sessionId: true,
  entryStatus: true,
  generationState: true,
  generationFailed: true,
  invocationCount: true,
  retryCount: true,
  repeatCount: true,
  waitMs: true,
  errorCode: true,
  errorType: true,
  errorMessage: true,
  operation: true,
  attribute: true,
  sizeBytes: true,
  limitBytes: true,
  retryAfterSeconds: true,
  coldStart: true,
});

/** Every field name a record may carry. Nothing here can hold submitted text (Req 11.3). */
export const ALLOW_LISTED_FIELD_NAMES: readonly (keyof LogFields)[] = Object.freeze(
  Object.keys(ALLOW_LISTED) as (keyof LogFields)[],
);

export interface RedactingLoggerOptions {
  /** An existing Powertools logger. A child logger shares its parent's, so one stream is written. */
  logger?: Logger;
  /** Powertools service name. Ignored when `logger` is supplied. */
  serviceName?: string;
  /** Pre-bound correlation identifier, as if `withCorrelationId` had already been called. */
  correlationId?: string;
}

/**
 * The counts that stand in for submitted content in a log record.
 *
 * This is the one-way door: text goes into `countSubmittedContent` and only numbers come out, so a
 * call site never holds a `LogFields` value containing text even momentarily.
 */
export interface SubmittedContentCounts {
  noteTextCharCount: number;
  commitLogCharCount: number;
  commitRecordCount: number;
}

/**
 * Measures submitted content in **code points**, the unit every bound in the System is stated in
 * (design: *Structured logging*, Property 24 asserting `[...noteText].length`).
 */
export function countSubmittedContent(input: {
  noteText?: string;
  commitLogText?: string;
  commitRecordCount?: number;
}): SubmittedContentCounts {
  return {
    noteTextCharCount: input.noteText === undefined ? 0 : codePointLength(input.noteText),
    commitLogCharCount:
      input.commitLogText === undefined ? 0 : codePointLength(input.commitLogText),
    commitRecordCount: input.commitRecordCount ?? 0,
  };
}

/**
 * Marks a string literal as System-authored, so it may be logged as `errorMessage` (Req 11.2).
 *
 * `string extends M ? never : M` is the whole mechanism: `M` infers to a literal type for a literal
 * argument, and to `string` for anything else — a variable, a template literal, a parsed body field —
 * at which point the parameter type collapses to `never` and the call does not compile. Submitted note
 * text can therefore never become a `LoggableMessage` (Req 11.3), while the fixed messages the design's
 * error taxonomy is made of pass straight through.
 */
export function systemMessage<M extends string>(
  message: string extends M ? never : M,
): LoggableMessage {
  // The brand exists only in the type system; the value is the literal the caller wrote.
  return message as unknown as LoggableMessage;
}

/** Longest `errorType` logged. A class name is short; anything longer is not one. */
const MAX_ERROR_TYPE_LENGTH = 64;

/** Anything outside the shape of an identifier or a dotted service error code. */
const NON_TOKEN = /[^A-Za-z0-9_$.:-]+/g;

/**
 * Derives Req 11.2's error type from a thrown value, as a token rather than as prose.
 *
 * `Error#name` is writable and an SDK sets it from a service error code, so the result is stripped to
 * identifier characters and capped: a message-shaped name cannot smuggle a sentence into the record.
 * The message itself is deliberately *not* derived here — a foreign throwable's message may quote the
 * request body, so it is the caller's own `systemMessage` literal that gets logged instead.
 */
export function describeErrorType(error: unknown): string {
  const raw = error instanceof Error ? error.name : typeof error;
  const token = raw.replace(NON_TOKEN, '').slice(0, MAX_ERROR_TYPE_LENGTH);
  return token === '' ? 'UnknownError' : token;
}

export class RedactingLogger implements DevlogLogger {
  readonly #logger: Logger;
  readonly #correlationId: string | undefined;

  constructor(options: RedactingLoggerOptions = {}) {
    this.#logger =
      options.logger ?? new Logger({ serviceName: options.serviceName ?? DEFAULT_SERVICE_NAME });
    this.#correlationId = options.correlationId;
  }

  debug<F extends OnlyAllowListed<F>>(event: string, fields?: F): void {
    this.#emit('debug', event, fields);
  }

  info<F extends OnlyAllowListed<F>>(event: string, fields?: F): void {
    this.#emit('info', event, fields);
  }

  warn<F extends OnlyAllowListed<F>>(event: string, fields?: F): void {
    this.#emit('warn', event, fields);
  }

  error<F extends OnlyAllowListed<F>>(event: string, fields?: F): void {
    this.#emit('error', event, fields);
  }

  /**
   * The one completion record of Req 11.1: correlation identifier, route, method, status, and elapsed
   * duration in milliseconds, as one JSON line.
   */
  completion<F extends OnlyCompletionFields<F>>(fields: F): void {
    this.#emit('info', COMPLETION_EVENT, fields);
  }

  /**
   * A logger stamping every subsequent record with `correlationId` (Req 11.7).
   *
   * The child shares this logger's Powertools instance, so records from a handler and from anything
   * it passes the child to interleave on one stream under one search term.
   */
  withCorrelationId(correlationId: string): RedactingLogger {
    return new RedactingLogger({ logger: this.#logger, correlationId });
  }

  #emit(level: LogLevel, event: string, fields: LogFields | undefined): void {
    const merged = this.#allowListedOnly(fields);
    // `event` is the Powertools `message`: a fixed token, never interpolated text (Property 24).
    switch (level) {
      case 'debug':
        this.#logger.debug(event, merged);
        break;
      case 'info':
        this.#logger.info(event, merged);
        break;
      case 'warn':
        this.#logger.warn(event, merged);
        break;
      case 'error':
        this.#logger.error(event, merged);
        break;
    }
  }

  /**
   * Copies across the allow-listed keys and drops everything else.
   *
   * Undefined-valued keys are dropped too, so an `exactOptionalPropertyTypes` spread does not leave
   * empty keys in the JSON. A logger never throws on a bad field: dropping it keeps a logging mistake
   * from turning into a failed request.
   *
   * The bound identifier is applied last, so it cannot be displaced by a `correlationId` in `fields`.
   * Req 11.7 wants one identifier for the whole request, and a request-scoped logger already knows it.
   */
  #allowListedOnly(fields: LogFields | undefined): Record<string, string | number | boolean> {
    const copied: Record<string, string | number | boolean> = {};
    for (const name of ALLOW_LISTED_FIELD_NAMES) {
      const value = fields?.[name];
      if (value !== undefined) {
        copied[name] = value;
      }
    }
    if (this.#correlationId !== undefined) {
      copied.correlationId = this.#correlationId;
    }
    return copied;
  }
}

/**
 * Turns one emitted JSON line back into the shared `LogRecord` shape.
 *
 * Powertools writes a flat record — `level`, `message`, `timestamp`, `service`, then the fields — while
 * `CapturingLogger` keeps `{ level, timestamp, event, fields }`. Normalizing here lets Properties 24
 * and 25 assert against either transport with one set of assertions. Levels arrive upper-case, and
 * `CRITICAL` folds into `error` since `LogLevel` has no separate token for it. The timestamp is
 * re-rendered as canonical UTC because Powertools honours the `TZ` environment variable and would
 * otherwise emit a local offset off-Lambda.
 *
 * @throws TypeError when the line is not a JSON object carrying a string `level`, `message`, and
 * `timestamp`. That means the transport changed shape, which is a bug rather than a data condition.
 */
export function parseEmittedRecord(line: string): LogRecord {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('log line is not a JSON object');
  }
  const flat = parsed as Record<string, unknown>;

  const level = flat.level;
  const message = flat.message;
  const timestamp = flat.timestamp;
  if (typeof level !== 'string' || typeof message !== 'string' || typeof timestamp !== 'string') {
    throw new TypeError('log line lacks a string level, message, or timestamp');
  }

  const fields: Record<string, unknown> = {};
  for (const name of ALLOW_LISTED_FIELD_NAMES) {
    const value = flat[name];
    if (value !== undefined) {
      fields[name] = value;
    }
  }

  return {
    level: toLogLevel(level),
    timestamp: new Date(timestamp).toISOString(),
    event: message,
    fields,
  };
}

function toLogLevel(powertoolsLevel: string): LogLevel {
  switch (powertoolsLevel.toUpperCase()) {
    case 'DEBUG':
      return 'debug';
    case 'WARN':
      return 'warn';
    case 'ERROR':
    case 'CRITICAL':
      return 'error';
    default:
      return 'info';
  }
}
