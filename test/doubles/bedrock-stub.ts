import type { ModelClient, ModelRequest, ModelResult } from '../../src/core/model-client';
import type { ModelOutcome } from '../generators';
import type { VirtualClock } from './clock';

/**
 * A Bedrock stub driven by a scripted outcome sequence.
 *
 * Property 17 quantifies over `arbModelOutcomeSequence` and asserts the Entry_Generator's budget: at
 * most 4 invocations, at most 2 retries, at most 1 repeat, `maxTokens` on every call, backoff
 * intervals between 1 and 5 seconds, and exactly one persisted Draft. Property 18 snapshots
 * `requests` to confirm the model was given the fixed template, the note text, and the parsed
 * Commit_Records, and nothing else — no other Entry, nothing read from the Entry_Store.
 *
 * That is why this is a stub with a recorded request log rather than a mock with expectations: the
 * properties assert over what was sent and how often, after the fact.
 *
 * `ModelOutcome` is owned by `test/generators.ts`, next to `arbModelOutcome`, so the generator and the
 * stub cannot disagree about what a "malformed" or "out of bounds" outcome means. The mapping from an
 * outcome to a `ModelResult` is the whole of this class:
 *
 * | Outcome                                                        | Result                            |
 * | -------------------------------------------------------------- | --------------------------------- |
 * | `VALID`, `INVALID_TITLE_LENGTH`, `INVALID_BODY_LENGTH`         | `ok`, the two-key JSON object     |
 * | `MALFORMED_OUTPUT`                                             | `ok`, the raw non-JSON text       |
 * | `THROTTLED`                                                    | `THROTTLED`, retryable (Req 5.5)  |
 * | `SERVER_ERROR`                                                 | `SERVER_ERROR`, retryable         |
 * | `DEADLINE_ELAPSED`                                             | `TIMEOUT`, after burning the budget |
 *
 * The three JSON-producing outcomes are serialized identically on purpose: the stub does not validate,
 * because deciding whether output is in bounds is the state machine's job (Req 5.1, 5.7). The separate
 * kinds exist so a generated sequence states its intent and the property can predict the decision.
 */

export interface BedrockStubOptions {
  /** Consumed in order, one per call. */
  outcomes?: readonly ModelOutcome[];
  /**
   * Used once the script runs out. Defaults to a server error, which keeps a property whose generated
   * sequence is shorter than the machine's invocation budget meaningful instead of crashing it.
   */
  whenExhausted?: ModelOutcome;
  /** Advanced by `callDurationMs` per call, and by `deadlineAdvanceMs` on a `DEADLINE_ELAPSED`. */
  clock?: VirtualClock;
  /** Modelled per-call latency in milliseconds. Defaults to 0. */
  callDurationMs?: number;
  /**
   * How much time a `DEADLINE_ELAPSED` outcome burns. Defaults to 60 s, the whole generation budget of
   * Req 5.3, so the machine's next deadline check takes the Req 5.4 fallback.
   */
  deadlineAdvanceMs?: number;
}

const DEFAULT_WHEN_EXHAUSTED: ModelOutcome = { kind: 'SERVER_ERROR', statusCode: 500 };
const DEFAULT_DEADLINE_ADVANCE_MS = 60_000;

export class BedrockStub implements ModelClient {
  readonly #queue: ModelOutcome[];
  readonly #requests: ModelRequest[] = [];
  readonly #whenExhausted: ModelOutcome;
  readonly #clock: VirtualClock | undefined;
  readonly #callDurationMs: number;
  readonly #deadlineAdvanceMs: number;

  constructor(options: BedrockStubOptions = {}) {
    this.#queue = [...(options.outcomes ?? [])];
    this.#whenExhausted = options.whenExhausted ?? DEFAULT_WHEN_EXHAUSTED;
    this.#clock = options.clock;
    this.#callDurationMs = options.callDurationMs ?? 0;
    this.#deadlineAdvanceMs = options.deadlineAdvanceMs ?? DEFAULT_DEADLINE_ADVANCE_MS;
  }

  async converse(request: ModelRequest): Promise<ModelResult> {
    // Recorded before anything else, so a request is captured even when the call then fails.
    this.#requests.push(Object.freeze({ ...request }));
    await Promise.resolve();

    const outcome = this.#queue.shift() ?? this.#whenExhausted;
    this.#clock?.advanceMs(this.#callDurationMs);

    switch (outcome.kind) {
      case 'VALID':
      case 'INVALID_TITLE_LENGTH':
      case 'INVALID_BODY_LENGTH':
        return {
          ok: true,
          outputText: JSON.stringify({ title: outcome.title, body: outcome.body }),
        };
      case 'MALFORMED_OUTPUT':
        return { ok: true, outputText: outcome.text };
      case 'THROTTLED':
        return {
          ok: false,
          failure: { kind: 'THROTTLED', retryAfterSeconds: outcome.retryAfterSeconds },
        };
      case 'SERVER_ERROR':
        return { ok: false, failure: { kind: 'SERVER_ERROR', statusCode: outcome.statusCode } };
      case 'DEADLINE_ELAPSED':
        this.#clock?.advanceMs(this.#deadlineAdvanceMs);
        return { ok: false, failure: { kind: 'TIMEOUT' } };
    }
  }

  /** Every request the stub was given, in order, frozen. Property 18 snapshots this. */
  get requests(): readonly ModelRequest[] {
    return [...this.#requests];
  }

  /** Total invocations, which Property 17 asserts is at most 4. */
  get callCount(): number {
    return this.#requests.length;
  }

  /** Scripted outcomes not yet consumed. */
  get pendingOutcomes(): number {
    return this.#queue.length;
  }
}
