/**
 * Author Entry routes (Tasks 17.1, 17.2, 17.3, 17.4)
 *
 * GET    /api/author/entries?status=draft|published — list entries by status
 * GET    /api/author/entries/:id                    — get single entry details
 * PATCH  /api/author/entries/:id                    — edit draft/published entry
 * POST   /api/author/entries/:id/publish            — transition draft -> published
 * POST   /api/author/entries/:id/unpublish          — transition published -> draft
 * DELETE /api/author/entries/:id                    — delete draft entry
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { codePointLength } from '../core/code-points';
import { DynamoEntryRepository } from '../core/entry-repository';
import type { EntryStatus } from '../core/types';
import { HttpError, type ApiContext, type ApiRequest, type HttpResponse } from './pipeline';

const ddbClient = new DynamoDBClient({});

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

function requireAuth(req: ApiRequest): void {
  const authHeader = req.headers['authorization'] ?? req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header');
  }
}

function extractEntryId(path: string): string {
  const parts = path.split('/');
  // Match /api/author/entries/:id or /api/author/entries/:id/(publish|unpublish)
  const entriesIdx = parts.indexOf('entries');
  if (entriesIdx === -1 || entriesIdx + 1 >= parts.length) {
    throw new HttpError(400, 'BAD_REQUEST', 'Missing entry identifier in path');
  }
  const id = parts[entriesIdx + 1];
  if (!id) {
    throw new HttpError(400, 'BAD_REQUEST', 'Missing entry identifier in path');
  }
  return id;
}

/**
 * GET /api/author/entries?status=draft|published
 */
export async function handleListEntries(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  requireAuth(req);

  const rawStatus = req.query?.status ?? 'draft';
  if (rawStatus !== 'draft' && rawStatus !== 'published') {
    throw new HttpError(400, 'BAD_REQUEST', 'status query parameter must be either "draft" or "published"', 'status');
  }
  const status: EntryStatus = rawStatus;

  const repository = getRepository();
  const result = await repository.queryByStatus({ status });

  if (!result.ok) {
    ctx.logger.error('Failed to query entries by status', { error: result.error.kind });
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Failed to retrieve entries');
  }

  return jsonResponse(200, result.value);
}

/**
 * GET /api/author/entries/:id
 */
export async function handleGetEntry(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  requireAuth(req);
  const entryId = extractEntryId(req.path);

  const repository = getRepository();
  const result = await repository.getEntry(entryId);

  if (!result.ok) {
    ctx.logger.error('Failed to get entry', { entryId, error: result.error.kind });
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Failed to retrieve entry');
  }

  if (!result.value) {
    throw new HttpError(404, 'NOT_FOUND', `Entry ${entryId} not found`);
  }

  return jsonResponse(200, result.value);
}

/**
 * PATCH /api/author/entries/:id
 * Also handles PUT /api/author/entries/:id
 */
export async function handlePatchEntry(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  requireAuth(req);
  const entryId = extractEntryId(req.path);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Request body must be valid JSON');
  }

  const { title, body } = payload;
  const patch: { title?: string; body?: string } = {};

  if (title !== undefined) {
    if (typeof title !== 'string') {
      throw new HttpError(400, 'BAD_REQUEST', 'title must be a string', 'title');
    }
    const titleLen = codePointLength(title);
    if (titleLen < 1 || titleLen > 120) {
      throw new HttpError(400, 'BAD_REQUEST', 'title must be between 1 and 120 code points', 'title');
    }
    patch.title = title;
  }

  if (body !== undefined) {
    if (typeof body !== 'string') {
      throw new HttpError(400, 'BAD_REQUEST', 'body must be a string', 'body');
    }
    const bodyLen = codePointLength(body);
    if (bodyLen < 1 || bodyLen > 20000) {
      throw new HttpError(400, 'BAD_REQUEST', 'body must be between 1 and 20000 code points', 'body');
    }
    patch.body = body;
  }

  const updatedAt = new Date().toISOString();
  const repository = getRepository();
  const result = await repository.patchEntry({ entryId, patch, updatedAt });

  if (!result.ok) {
    if (result.error.kind === 'CONDITION_FAILED') {
      throw new HttpError(404, 'NOT_FOUND', `Entry ${entryId} not found`);
    }
    ctx.logger.error('Failed to patch entry', { entryId, error: result.error.kind });
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Failed to save entry edits');
  }

  return jsonResponse(200, result.value);
}

/**
 * POST /api/author/entries/:id/publish
 */
export async function handlePublishEntry(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  requireAuth(req);
  const entryId = extractEntryId(req.path);
  const repository = getRepository();

  // Validate entry exists and body has minimum length (Req 6.8: min 200 code points)
  const existing = await repository.getEntry(entryId);
  if (!existing.ok || !existing.value) {
    throw new HttpError(404, 'NOT_FOUND', `Entry ${entryId} not found`);
  }

  const bodyLen = codePointLength(existing.value.body);
  if (bodyLen < 200) {
    throw new HttpError(
      400,
      'BODY_TOO_SHORT',
      `Cannot publish entry with body length under 200 code points (current: ${bodyLen})`,
      'body',
    );
  }

  const updatedAt = new Date().toISOString();
  const transitionResult = await repository.updateEntryStatus({
    entryId,
    expected: 'draft',
    next: 'published',
    updatedAt,
  });

  if (!transitionResult.ok) {
    if (transitionResult.error.kind === 'CONDITION_FAILED') {
      throw new HttpError(409, 'CONFLICT', 'Entry is already published or does not exist');
    }
    ctx.logger.error('Failed to publish entry', { entryId, error: transitionResult.error.kind });
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Failed to publish entry');
  }

  return jsonResponse(200, { entryId, status: 'published' });
}

/**
 * POST /api/author/entries/:id/unpublish
 */
export async function handleUnpublishEntry(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  requireAuth(req);
  const entryId = extractEntryId(req.path);
  const repository = getRepository();

  const updatedAt = new Date().toISOString();
  const transitionResult = await repository.updateEntryStatus({
    entryId,
    expected: 'published',
    next: 'draft',
    updatedAt,
  });

  if (!transitionResult.ok) {
    if (transitionResult.error.kind === 'CONDITION_FAILED') {
      throw new HttpError(409, 'CONFLICT', 'Entry is not currently published');
    }
    ctx.logger.error('Failed to unpublish entry', { entryId, error: transitionResult.error.kind });
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Failed to unpublish entry');
  }

  return jsonResponse(200, { entryId, status: 'draft' });
}

/**
 * DELETE /api/author/entries/:id
 */
export async function handleDeleteEntry(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  requireAuth(req);
  const entryId = extractEntryId(req.path);
  const repository = getRepository();

  const deleteResult = await repository.deleteDraft(entryId);

  if (!deleteResult.ok) {
    if (deleteResult.error.kind === 'CONDITION_FAILED') {
      throw new HttpError(404, 'NOT_FOUND', 'Draft not found or cannot delete published entry');
    }
    ctx.logger.error('Failed to delete draft', { entryId, error: deleteResult.error.kind });
    throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Failed to delete draft');
  }

  return jsonResponse(200, { entryId, deleted: true });
}
