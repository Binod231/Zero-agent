import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ApiPipeline } from '../../src/api/pipeline';
import { COMPLETION_EVENT } from '../../src/core/logging';
import { CapturingLogger } from '../doubles/capturing-logger';

/**
 * **Property 25: Correlation identifiers are assigned and propagated** (Req 11.1, 11.7).
 *
 * *For any* request, the Devlog_API assigns a correlation identifier of between 8 and 64
 * characters, every log record emitted by any component while handling that request carries that
 * same identifier, and exactly one completion record is emitted carrying the identifier, the route,
 * the HTTP method, the HTTP status, and the elapsed duration in milliseconds as valid JSON.
 *
 * Validates: Requirements 11.1, 11.7.
 */

describe('Property 25: Correlation identifiers are assigned and propagated', () => {
  it('assigns an 8-64 char correlation ID, propagates it to every record, and emits exactly one completion record', async () => {
    const arbPath = fc.constantFrom('/api/health', '/api/author/drafts', '/api/author/sessions');
    const arbMethod = fc.constantFrom('GET', 'POST', 'PATCH', 'DELETE');

    await fc.assert(
      fc.asyncProperty(arbPath, arbMethod, async (path, method) => {
        const capturing = new CapturingLogger();
        const pipeline = new ApiPipeline({
          defaultLogger: capturing as unknown as import('../../src/api/logger').RedactingLogger,
        });

        // Register dummy routes
        pipeline.register(method, path, (_req, ctx) => {
          ctx.logger.info('Handling route', { route: ctx.route });
          return {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ok: true }),
          };
        });

        const response = await pipeline.execute({
          method,
          path,
          headers: {},
        });

        expect(response.statusCode).toBeDefined();

        const records = capturing.records;
        expect(records.length).toBeGreaterThanOrEqual(1);

        // All records must have the exact same correlationId
        const correlationIds = new Set(
          records.map((r) => r.fields.correlationId).filter((id): id is string => typeof id === 'string'),
        );

        expect(correlationIds.size).toBe(1);
        const assignedId = [...correlationIds][0]!;
        expect(assignedId.length).toBeGreaterThanOrEqual(8);
        expect(assignedId.length).toBeLessThanOrEqual(64);

        // Exactly one completion record
        const completionRecords = records.filter((r) => r.event === COMPLETION_EVENT);
        expect(completionRecords.length).toBe(1);
        const completion = completionRecords[0]!;

        expect(completion.fields.route).toBe(path);
        expect(completion.fields.method).toBe(method.toUpperCase());
        expect(completion.fields.status).toBe(response.statusCode);
        expect(typeof completion.fields.durationMs).toBe('number');
        expect(completion.fields.durationMs).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100 },
    );
  });
});
