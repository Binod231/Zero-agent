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

/**
 * Text the System authored about itself, as opposed to text a request carried in.
 *
 * Req 11.2 wants the error message in the log record and Req 11.3 wants no submitted content in any
 * log record, and the two collide: a runtime message can quote its input — `JSON.parse` includes a
 * window of the offending body in its `SyntaxError`. So `errorMessage` is branded, and the only way to
 * produce a value of this type is `systemMessage` in `src/api/logger.ts`, which accepts **string
 * literals only**. Note text, a Commit_Log, a credential, and any interpolated template all have type
 * `string` rather than a literal type, so none of them can be turned into one.
 */
export type LoggableMessage = string & { readonly __systemAuthored: true };

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
  /**
   * The class name of a thrown error — `ProvisionedThroughputExceededException`, `TypeError` — which
   * is the "error type" of Req 11.2. A name is a token, not prose; `describeErrorType` in
   * `src/api/logger.ts` derives it and strips anything that is not one.
   */
  errorType?: string;
  /** The "error message" of Req 11.2, restricted to System-authored text. See `LoggableMessage`. */
  errorMessage?: LoggableMessage;
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

/**
 * `LogFields` with every key outside the allow-list typed `never`.
 *
 * Used as a self-referential constraint — `debug<F extends OnlyAllowListed<F>>(…, fields?: F)` — which
 * is what closes the allow-list against *every* argument shape rather than only against object
 * literals. `fields?: LogFields` alone would reject a literal carrying `noteText` (excess property
 * check) but accept a pre-built variable of type `{ route: string; noteText: string }`, because excess
 * property checking does not apply to non-literals. With the constraint, `F` is inferred from the
 * argument, `Exclude<keyof F, keyof LogFields>` names its extra keys, and each one is required to be
 * `never` — so the call fails to compile whatever the argument's provenance. `Record<string, unknown>`
 * fails for the same reason, which is the design's "there is no method that takes an arbitrary
 * object" expressed as a type rather than as a convention.
 */
export type OnlyAllowListed<F> = LogFields & Record<Exclude<keyof F, keyof LogFields>, never>;

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

/** `CompletionFields` with every key outside it typed `never`. See `OnlyAllowListed`. */
export type OnlyCompletionFields<F> = CompletionFields &
  Record<Exclude<keyof F, keyof CompletionFields>, never>;

/** One emitted record. Serializing this is what a transport writes as a JSON line. */
export interface LogRecord {
  level: LogLevel;
  /** `YYYY-MM-DDTHH:mm:ss.sssZ`. */
  timestamp: string;
  event: string;
  fields: LogFields;
}

export interface DevlogLogger {
  debug<F extends OnlyAllowListed<F>>(event: string, fields?: F): void;
  info<F extends OnlyAllowListed<F>>(event: string, fields?: F): void;
  warn<F extends OnlyAllowListed<F>>(event: string, fields?: F): void;
  error<F extends OnlyAllowListed<F>>(event: string, fields?: F): void;

  /** Emits the single completion record of Req 11.1, at `info`, with event `COMPLETION_EVENT`. */
  completion<F extends OnlyCompletionFields<F>>(fields: F): void;

  /**
   * A logger that stamps every subsequent record with this correlation identifier, so the causal
   * chain across the Devlog_API and the Entry_Generator shares one search term (Req 11.7).
   */
  withCorrelationId(correlationId: string): DevlogLogger;
}
