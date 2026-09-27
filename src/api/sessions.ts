/**
 * Session_Input routes (Tasks 14.2, 14.3)
 *
 * POST /api/author/sessions     — submit session notes, invoke generator async, return 202
 * GET  /api/author/sessions/:id — poll generation state for the console
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ulid } from 'ulid';
import { parseCommitLog } from '../core/commit-log-parser';
import { DynamoEntryRepository } from '../core/entry-repository';
import type { SessionRecord } from '../core/entry-repository-port';
import { HttpError, type ApiContext, type ApiRequest } from './pipeline';
import type { HttpResponse } from '../core/types';

const ddbClient = new DynamoDBClient({});
const lambdaClient = new LambdaClient({});

function getRepository(): DynamoEntryRepository {
  const tableName = process.env.TABLE_NAME ?? '';
  return new DynamoEntryRepository({ client: ddbClient, tableName });
}

function jsonResponse(statusCode: number, body: unknown, extra?: Record<string, string>): HttpResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      ...extra,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Resolve today's UTC date as YYYY-MM-DD
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Validate YYYY-MM-DD and that it is a real calendar date (not after today UTC).
 */
function isValidSessionDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (d.toISOString().slice(0, 10) !== raw) return false; // guards Feb 30 etc.
  if (raw > todayUtc()) return false; // not a future date
  return true;
}

/**
 * POST /api/author/sessions
 *
 * Body: { noteText: string; commitLog?: string; sessionDate?: string }
 * Response: 202 { entryId, sessionId }
 */
export async function handleSubmitSession(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  // Parse body
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Request body must be valid JSON');
  }

  const { noteText, commitLog, sessionDate } = payload;

  // Validate noteText
  if (typeof noteText !== 'string' || noteText.trim() === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'noteText is required and must be a non-empty string', 'noteText');
  }
  // Count code points (spec: 1–20000)
  const codePointCount = [...noteText].length;
  if (codePointCount < 1) {
    throw new HttpError(400, 'BAD_REQUEST', 'noteText must contain at least one non-whitespace character', 'noteText');
  }
  if (codePointCount > 20000) {
    throw new HttpError(400, 'BAD_REQUEST', 'noteText must not exceed 20,000 code points', 'noteText');
  }

  // Validate optional commitLog
  let rawCommitLog = '';
  if (commitLog !== undefined) {
    if (typeof commitLog !== 'string') {
      throw new HttpError(400, 'BAD_REQUEST', 'commitLog must be a string', 'commitLog');
    }
    rawCommitLog = commitLog;
    // Parse to validate syntax — surface line number on failure
    if (rawCommitLog.trim() !== '') {
      const parsed = parseCommitLog(rawCommitLog);
      if (!parsed.ok) {
        const line = parsed.error.kind === 'MALFORMED' ? parsed.error.line : parsed.error.line;
        throw new HttpError(
          400,
          'INVALID_COMMIT_LOG',
          `Commit log parse error on line ${line}: ${parsed.error.kind}`,
          'commitLog',
        );
      }
    }
  }

  // Validate optional sessionDate
  let resolvedDate = todayUtc();
  if (sessionDate !== undefined) {
    if (typeof sessionDate !== 'string') {
      throw new HttpError(400, 'BAD_REQUEST', 'sessionDate must be a string', 'sessionDate');
    }
    if (!isValidSessionDate(sessionDate)) {
      throw new HttpError(
        400,
        'INVALID_SESSION_DATE',
        'sessionDate must be a valid YYYY-MM-DD date that is not in the future',
        'sessionDate',
      );
    }
    resolvedDate = sessionDate;
  }

  // Allocate IDs
  const sessionId = ulid();
  const entryId = ulid();
  const now = new Date().toISOString();
  const correlationId = ctx.correlationId;

  // Persist SESSION item verbatim (no trimming, Req 3.6)
  const repository = getRepository();
  const sessionRecord: SessionRecord = {
    sessionId,
    entryId,
    noteText,             // verbatim
    commitLog: rawCommitLog,   // verbatim
    sessionDate: resolvedDate,
    submittedAt: now,
    generationState: 'pending',
    correlationId,
    schemaVersion: 1,
  };

  const putResult = await repository.putSession(sessionRecord);
  if (!putResult.ok) {
    ctx.logger.error('Failed to persist session record', { error: putResult.error.kind });
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Failed to save session. Please try again.');
  }

  // Invoke generator Lambda asynchronously (Event invocation type = fire-and-forget)
  const generatorFunctionName = process.env.GENERATOR_FUNCTION_NAME;
  if (generatorFunctionName) {
    try {
      const deadlineEpochMs = Date.now() + 60_000; // 60s deadline for generation
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: generatorFunctionName,
          InvocationType: 'Event', // async — do not wait
          Payload: Buffer.from(
            JSON.stringify({
              sessionId,
              entryId,
              noteText,
              commitLog: rawCommitLog,
              sessionDate: resolvedDate,
              deadlineEpochMs,
            }),
          ),
        }),
      );
    } catch (err) {
      ctx.logger.error('Failed to invoke generator Lambda', {
        errorType: err instanceof Error ? err.name : 'UnknownError',
      });
      // Do not fail the request — session is saved; generation can be retried
    }
  }

  return jsonResponse(202, { entryId, sessionId });
}

/**
 * GET /api/author/sessions/:id
 *
 * Response: { sessionId, entryId, generationState, noteText, commitLog, sessionDate }
 */
export async function handleGetSession(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  // Extract :id from path like /api/author/sessions/01ABC...
  const parts = req.path.split('/');
  const sessionId = parts[parts.length - 1] ?? '';

  if (!sessionId || sessionId.length < 1) {
    throw new HttpError(400, 'BAD_REQUEST', 'sessionId is required');
  }

  const repository = getRepository();
  const result = await repository.getSession(sessionId);

  if (!result.ok) {
    ctx.logger.error('Failed to retrieve session', { error: result.error.kind });
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Failed to retrieve session status');
  }

  if (!result.value) {
    throw new HttpError(404, 'NOT_FOUND', `Session ${sessionId} not found`);
  }

  const rec = result.value;
  return jsonResponse(200, {
    sessionId: rec.sessionId,
    entryId: rec.entryId,
    generationState: rec.generationState,
    noteText: rec.noteText,
    commitLog: rec.commitLog,
    sessionDate: rec.sessionDate,
  });
}
