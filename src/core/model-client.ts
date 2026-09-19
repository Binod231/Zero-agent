/**
 * The language-model client contract.
 *
 * The Entry_Generator's budget state machine (Req 5.3, 5.5, 5.7) is the interesting logic, and it is
 * a pure decision procedure over *classified* outcomes. Putting the classification behind this
 * interface is what lets Property 17 drive the machine from a generated outcome sequence and
 * Property 18 snapshot the exact request the model was given, with no AWS call in either.
 *
 * Failures are values rather than exceptions: the Bedrock SDK signals throttling and server errors as
 * thrown exceptions, so the real implementation (task 15) catches and maps them here once, which
 * leaves the state machine with a closed union to `switch` on instead of duck-typed error names.
 *
 * This module is interface only; the stub is `test/doubles/bedrock-stub.ts`.
 */

/**
 * Exactly what is sent to the model. There is no field for retrieved content, for another Entry, or
 * for anything read from the Entry_Store, which is how Req 5.6 holds structurally: the input consists
 * of the fixed template (`system`), and the note text plus parsed Commit_Records (`userMessage`).
 */
export interface ModelRequest {
  /** The Bedrock model or inference-profile identifier, from deploy-time configuration. */
  modelId: string;
  /** The fixed instruction template. Never interpolated with submitted content. */
  system: string;
  /** The single user message: delimited, escaped data blocks. */
  userMessage: string;
  /** Output-token cap, 2000 per the token budget of Req 10.6. */
  maxTokens: number;
}

/**
 * Why a model invocation produced no output.
 *
 * `THROTTLED`, `SERVER_ERROR`, and `TIMEOUT` are the retryable classes that consume a Req 5.5 retry;
 * `INVALID_REQUEST` is non-retryable and sends the machine straight to the Req 5.4 fallback.
 */
export type ModelFailure =
  /** `retryAfterSeconds` is the service's hint; the backoff schedule of Req 5.5 is fixed regardless. */
  | { kind: 'THROTTLED'; retryAfterSeconds?: number }
  | { kind: 'SERVER_ERROR'; statusCode?: number }
  | { kind: 'TIMEOUT' }
  | { kind: 'INVALID_REQUEST' };

/**
 * `outputText` is the model's raw text, unparsed and unvalidated. Deciding whether it is JSON with an
 * in-bounds title and body is the state machine's job (Req 5.1, 5.7), not the client's.
 */
export type ModelResult = { ok: true; outputText: string } | { ok: false; failure: ModelFailure };

export interface ModelClient {
  converse(request: ModelRequest): Promise<ModelResult>;
}
