import type { Clock } from '../../src/core/clock';
import type {
  CompletionFields,
  DevlogLogger,
  LogFields,
  LogLevel,
  LogRecord,
} from '../../src/core/logging';
import { COMPLETION_EVENT } from '../../src/core/logging';

/**
 * A logger transport that keeps every record instead of writing it.
 *
 * Three properties read it rather than a mock's call log:
 *
 * - Property 24 searches every serialized record for any 12-code-point window of the submitted note
 *   text or commit log, so the whole record has to be inspectable — field values included, not just
 *   field names.
 * - Property 25 asserts that the set of correlation identifiers across all records from all
 *   components has exactly one element, and that exactly one record carries the completion fields.
 * - Property 23 checks that nothing internal leaks, which needs the same full-text view.
 *
 * It implements `DevlogLogger`, the same interface the redacting Powertools wrapper implements, so the
 * allow-listed field set is enforced by the compiler here too: a test cannot log submitted content
 * through this double even to prove a point.
 *
 * A child logger from `withCorrelationId` shares the parent's sink, so one capture sees the whole
 * causal chain even when a handler passes a request-scoped logger down into another component.
 */

export interface CapturingLoggerOptions {
  /** Supplies record timestamps. Omitted means real time. A frozen clock makes them constant. */
  clock?: Clock;
  /** Pre-bound correlation identifier, as if `withCorrelationId` had already been called. */
  correlationId?: string;
  /** Internal: the shared record array. Pass one to have two loggers capture into the same place. */
  sink?: LogRecord[];
}

export class CapturingLogger implements DevlogLogger {
  readonly #sink: LogRecord[];
  readonly #clock: Clock | undefined;
  readonly #correlationId: string | undefined;

  constructor(options: CapturingLoggerOptions = {}) {
    this.#sink = options.sink ?? [];
    this.#clock = options.clock;
    this.#correlationId = options.correlationId;
  }

  debug(event: string, fields?: LogFields): void {
    this.#emit('debug', event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.#emit('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.#emit('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.#emit('error', event, fields);
  }

  completion(fields: CompletionFields): void {
    this.#emit('info', COMPLETION_EVENT, fields);
  }

  withCorrelationId(correlationId: string): DevlogLogger {
    return new CapturingLogger({
      sink: this.#sink,
      correlationId,
      ...(this.#clock === undefined ? {} : { clock: this.#clock }),
    });
  }

  /** Every record emitted through this logger or any child of it, in order. */
  get records(): readonly LogRecord[] {
    return [...this.#sink];
  }

  /** The records a real transport would write, as JSON lines. Property 25 parses each of these. */
  jsonLines(): string[] {
    return this.#sink.map((record) => JSON.stringify(record));
  }

  /** The completion records (Req 11.1 expects exactly one per request). */
  completionRecords(): LogRecord[] {
    return this.#sink.filter((record) => record.event === COMPLETION_EVENT);
  }

  clear(): void {
    this.#sink.length = 0;
  }

  #emit(level: LogLevel, event: string, fields: LogFields | undefined): void {
    const merged: LogFields = {
      ...(this.#correlationId === undefined ? {} : { correlationId: this.#correlationId }),
      ...fields,
    };
    // Frozen so a test cannot edit the evidence it is about to assert on.
    this.#sink.push(
      Object.freeze({
        level,
        timestamp: this.#clock?.nowIso() ?? new Date().toISOString(),
        event,
        fields: Object.freeze(merged),
      }),
    );
  }
}
