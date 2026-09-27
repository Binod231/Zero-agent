import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ApiPipeline, HttpError } from '../../src/api/pipeline';

/**
 * **Property 23: Error responses disclose nothing internal** (Req 9.6, 11.2, 11.6).
 *
 * *For any* request that produces an error response, the response body contains no stack trace,
 * no AWS resource identifier, no AWS account identifier, and no configuration value; and every
 * response carrying HTTP status 500 contains the correlation identifier of that request.
 *
 * Validates: Requirements 9.6, 11.2, 11.6.
 */

const FORBIDDEN_PATTERNS = [
  /at\s+[\w.$]+\s+\(/i, // Stack traces (e.g. "at Function.execute (/path/...")
  /arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/i, // AWS ARNs
  /\b\d{12}\b/, // AWS 12-digit account identifiers
  /devlog-narrator-[a-z0-9-]+/i, // Internal resource physical names
  /SECRET|PASSWORD|PRIVATE_KEY/i, // Secret config markers
];

describe('Property 23: Error responses disclose nothing internal', () => {
  it('never discloses stack traces, ARNs, or internal configuration in error bodies', async () => {
    // Generate different kinds of errors: unhandled thrown Error, HttpError, strange throws
    const arbErrorThrower = fc.oneof(
      fc.string().map((msg) => () => {
        throw new Error(`Failure: ${msg} at function foo (/var/task/index.js:10:5) arn:aws:dynamodb:us-east-1:123456789012:table/devlog-narrator-table`);
      }),
      fc.tuple(fc.integer({ min: 400, max: 499 }), fc.string(), fc.string()).map(([status, code, msg]) => () => {
        throw new HttpError(status, code.slice(0, 20), msg);
      }),
      fc.string().map((str) => () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw str;
      }),
    );

    await fc.assert(
      fc.asyncProperty(arbErrorThrower, async (thrower) => {
        const pipeline = new ApiPipeline();
        pipeline.register('GET', '/test-fail', () => {
          thrower();
          return { statusCode: 200, headers: {}, body: '' };
        });

        const response = await pipeline.execute({
          method: 'GET',
          path: '/test-fail',
          headers: {},
        });

        expect(response.statusCode).toBeGreaterThanOrEqual(400);

        // Parse response body as JSON
        const parsed = JSON.parse(response.body) as {
          error?: { code: string; message: string; correlationId: string };
        };
        expect(parsed.error).toBeDefined();

        // 1. None of the forbidden patterns appear in body
        for (const pattern of FORBIDDEN_PATTERNS) {
          expect(pattern.test(response.body)).toBe(false);
        }

        // 2. Correlation identifier is always present in 500 responses
        if (response.statusCode === 500) {
          expect(parsed.error?.correlationId).toBeDefined();
          expect(parsed.error?.correlationId.length).toBe(26);
        }
      }),
      { numRuns: 100 },
    );
  });
});
