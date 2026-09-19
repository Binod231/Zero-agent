/**
 * The structured-logging contract.
 *
 * Redaction is enforced by construction, not by convention (design: *Structured logging*). There is
 * no method here that accepts an arbitrary object, and `LogFields` is a closed, allow-listed set:
 * note text and commit log text have **no representation** in it, only their code-point counts do
 * (Req 11.3). Adding a field that could carry submitted content is a deliberate edit to this file,
 * not an accident at a call site.
 *
 * `event` is a fixed token naming what happened — `'entry.published'`, `'generation.fallback'` — and
 * never interpolated text. That part is a convention rather than a type, so Property 24 checks it
 * empirically by searching captured records for windows of the input.
 *
 * This module is interface only. The redacting Powertools implementation is `src/api/logger.ts`
 * (task 10.2) and the capturing implementation is `test/doubles/capturing-logger.ts`; a handler is
 * constructed with either.
 */

import type { EntryStatus } from './types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** The event name of the single per-request completion record of Req 11.1. */
export const COMPLETION_EVENT = 'request.completed';

/**
 * The complete set of fields any log record may carry.
 *
 * Every entry is either an identifier the System assigned, a bound from the design, a count, or an
 * attribute *name*. None is user-supplied text.
 */
export interface LogFields {
  /** The 26-character ULID assigned when the Devlog_API begins handling a request (Req 11.7). */
  correlationId?: string;
  /** Route template, e.g. `POST /api/author/sessions`. Never a concrete path with a query string. */
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  /** Code-point count of the submitted note text — never the text (Req 11.3). */
  noteTextCharCount?: number;
  /** Code-point count of the submitted commit log — never the text (Req 11.3). */
  commitLogCharCount?: number;
  commitRecordCount?: number;
  entryId?: string;
  sessionId?: string;
  entryStatus?: EntryStatus;
  generationState?: string;
  generationFailed?: boolean;
  /** Entry_Generator budget counters (Req 5.3, 5.5, 5.7). */
  invocationCount?: number;
  retryCount?: number;
  repeatCount?: number;
  /** A backoff or deadline interval in milliseconds. */
  waitMs?: number;
  /** A stable machine-readable error token, e.g. `NOTE_TEXT_TOO_LONG`. */
  errorCode?: string;
  /** A repository or model operation name. */
  operation?: string;
  /** The **name** of an offending attribute, never its value (design: *Entry_Serializer mapping*). */
  attribute?: string;
  sizeBytes?: number;
  limitBytes?: number;
  retryAfterSeconds?: number;
  /** True on a Lambda cold start, mirroring the Powertools field. */
  coldStart?: boolean;
}

/** The fields of the one completion record every request emits (Req 11.1). */
export interface CompletionFields {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  /** Omitted when the logger already carries the bound correlation identifier. */
  correlationId?: string;
  noteTextCharCount?: number;
  commitLogCharCount?: number;
  commitRecordCount?: number;
}

/** One emitted record. Serializing this is what a transport writes as a JSON line. */
export interface LogRecord {
  level: LogLevel;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  timestamp: string;
  event: string;
  fields: LogFields;
}

export interface DevlogLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;

  /** Emits the single completion record of Req 11.1, at `info`, with event `COMPLETION_EVENT`. */
  completion(fields: CompletionFields): void;

  /**
   * A logger that stamps every subsequent record with this correlation identifier, so the causal
   * chain across the Devlog_API and the Entry_Generator shares one search term (Req 11.7).
   */
  withCorrelationId(correlationId: string): DevlogLogger;
}
