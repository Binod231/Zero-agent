import { describe, expect, it } from 'vitest';
import type { ModelRequest } from '../../../src/core/model-client';
import { BedrockStub } from '../../doubles/bedrock-stub';
import { VirtualClock } from '../../doubles/clock';
import type { ModelOutcome } from '../../generators';

/**
 * Unit tests of the Bedrock stub. Not correctness properties: these check that the outcome script is
 * honoured in order and that the request log is faithful, which is what Properties 17 and 18 build on.
 */

const INSTANT = '2026-09-19T21:04:11.417Z';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    modelId: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    system: 'You are a technical devlog editor.',
    userMessage: '<session_date>2026-09-19</session_date>',
    maxTokens: 2000,
    ...overrides,
  };
}

describe('BedrockStub', () => {
  it('returns scripted outcomes in order, one per call', async () => {
    const outcomes: ModelOutcome[] = [
      { kind: 'THROTTLED', retryAfterSeconds: 3 },
      { kind: 'MALFORMED_OUTPUT', text: 'Sure! Here is your entry:' },
      { kind: 'VALID', title: 'A title', body: 'A body long enough to pass validation.' },
    ];
    const stub = new BedrockStub({ outcomes });

    expect(await stub.converse(request())).toEqual({
      ok: false,
      failure: { kind: 'THROTTLED', retryAfterSeconds: 3 },
    });
    expect(await stub.converse(request())).toEqual({
      ok: true,
      outputText: 'Sure! Here is your entry:',
    });
    expect(await stub.converse(request())).toEqual({
      ok: true,
      outputText: JSON.stringify({
        title: 'A title',
        body: 'A body long enough to pass validation.',
      }),
    });
    expect(stub.callCount).toBe(3);
    expect(stub.pendingOutcomes).toBe(0);
  });

  it('serializes an in-bounds and an out-of-bounds outcome alike, leaving validation to the caller', async () => {
    const stub = new BedrockStub({
      outcomes: [
        { kind: 'VALID', title: 'ok', body: 'b'.repeat(200) },
        { kind: 'INVALID_TITLE_LENGTH', title: '', body: 'b'.repeat(200) },
        { kind: 'INVALID_BODY_LENGTH', title: 'ok', body: 'too short' },
      ],
    });

    const outputs: string[] = [];
    for (let call = 0; call < 3; call += 1) {
      const result = await stub.converse(request());
      if (!result.ok) {
        throw new Error('expected a JSON-producing outcome');
      }
      outputs.push(result.outputText);
    }

    expect(outputs.map((text) => (JSON.parse(text) as { title: string }).title)).toEqual([
      'ok',
      '',
      'ok',
    ]);
  });

  it('records the exact request it was given, frozen, and shares no object with the caller', async () => {
    const stub = new BedrockStub({ outcomes: [{ kind: 'SERVER_ERROR', statusCode: 503 }] });
    const sent = request({ userMessage: '<session_notes>notes</session_notes>' });

    const result = await stub.converse(sent);
    sent.userMessage = 'mutated after the call';

    expect(result).toEqual({ ok: false, failure: { kind: 'SERVER_ERROR', statusCode: 503 } });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toEqual({
      modelId: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
      system: 'You are a technical devlog editor.',
      userMessage: '<session_notes>notes</session_notes>',
      maxTokens: 2000,
    });
    expect(Object.isFrozen(stub.requests[0])).toBe(true);
  });

  it('records the request even when the call fails', async () => {
    const stub = new BedrockStub({ outcomes: [{ kind: 'THROTTLED', retryAfterSeconds: 0 }] });
    await stub.converse(request());
    expect(stub.callCount).toBe(1);
  });

  it('advances the virtual clock per call, and past the deadline on an elapse outcome', async () => {
    const clock = new VirtualClock(INSTANT);
    const stub = new BedrockStub({
      clock,
      callDurationMs: 1500,
      outcomes: [{ kind: 'SERVER_ERROR', statusCode: 500 }, { kind: 'DEADLINE_ELAPSED' }],
    });

    await stub.converse(request());
    expect(clock.nowMs()).toBe(Date.parse(INSTANT) + 1500);

    const elapsed = await stub.converse(request());
    expect(elapsed).toEqual({ ok: false, failure: { kind: 'TIMEOUT' } });
    // The second call's latency plus the whole 60-second generation budget.
    expect(clock.nowMs()).toBe(Date.parse(INSTANT) + 1500 + 1500 + 60_000);
  });

  it('falls back to a configurable outcome once the script runs out', async () => {
    const stub = new BedrockStub({
      outcomes: [],
      whenExhausted: { kind: 'THROTTLED', retryAfterSeconds: 1 },
    });
    expect(await stub.converse(request())).toEqual({
      ok: false,
      failure: { kind: 'THROTTLED', retryAfterSeconds: 1 },
    });

    const defaulted = new BedrockStub();
    expect(await defaulted.converse(request())).toEqual({
      ok: false,
      failure: { kind: 'SERVER_ERROR', statusCode: 500 },
    });
  });

  it('does not consume the caller\u2019s outcome array', async () => {
    const outcomes: ModelOutcome[] = [
      { kind: 'THROTTLED', retryAfterSeconds: 2 },
      { kind: 'SERVER_ERROR', statusCode: 500 },
    ];
    const stub = new BedrockStub({ outcomes });
    await stub.converse(request());
    expect(outcomes).toHaveLength(2);
  });
});
