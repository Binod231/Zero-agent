import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { STATUS_ORDER_INDEX_NAME } from '../../infra/lib/storage';
import { decode, encode, encodedSizeBytes } from './entry-serializer';
import {
  MAX_ENTRY_ITEM_BYTES,
  entryKey,
  sessionKey,
  timelinePartition,
  type EntryRepository,
  type PatchEntryInput,
  type PutEntryOptions,
  type RepositoryError,
  type RepositoryOperation,
  type RepositoryResult,
  type SessionRecord,
  type SessionStateTransition,
  type StatusQuery,
  type StatusTransition,
  type TimelineQuery,
} from './entry-repository-port';
import type { DynamoAttributeValue, DynamoItem, Entry, EntrySummary } from './types';

export interface DynamoEntryRepositoryOptions {
  client: DynamoDBClient;
  tableName: string;
}

export class DynamoEntryRepository implements EntryRepository {
  private readonly client: DynamoDBClient;
  private readonly tableName: string;

  constructor(options: DynamoEntryRepositoryOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
  }

  private mapError(error: unknown, operation: RepositoryOperation): RepositoryError {
    const err = error as { name?: string; message?: string };
    if (err?.name === 'ConditionalCheckFailedException') {
      return { kind: 'CONDITION_FAILED', operation };
    }
    if (
      err?.name === 'ProvisionedThroughputExceededException' ||
      err?.name === 'RequestLimitExceeded' ||
      err?.name === 'ThrottlingException'
    ) {
      return { kind: 'THROTTLED', operation };
    }
    return { kind: 'UNAVAILABLE', operation };
  }

  async getEntry(entryId: string): Promise<RepositoryResult<Entry | null>> {
    const key = entryKey(entryId);
    try {
      const response = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: {
            PK: { S: key.PK },
            SK: { S: key.SK },
          },
        }),
      );

      if (!response.Item) {
        return { ok: true, value: null };
      }

      const decoded = decode(response.Item as unknown as DynamoItem);
      if (!decoded.ok) {
        return {
          ok: false,
          error: {
            kind: 'MALFORMED_ITEM',
            operation: 'getEntry',
            error: decoded.error,
          },
        };
      }

      return { ok: true, value: decoded.entry };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'getEntry') };
    }
  }

  async queryTimeline(query: TimelineQuery): Promise<RepositoryResult<EntrySummary[]>> {
    try {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: STATUS_ORDER_INDEX_NAME,
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: {
            ':pk': { S: timelinePartition('published') },
          },
          ScanIndexForward: false,
          Limit: query.limit,
        }),
      );

      const summaries = (response.Items ?? []).map(this.mapItemToSummary);
      return { ok: true, value: summaries };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'queryTimeline') };
    }
  }

  async queryByStatus(query: StatusQuery): Promise<RepositoryResult<EntrySummary[]>> {
    try {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: STATUS_ORDER_INDEX_NAME,
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: {
            ':pk': { S: timelinePartition(query.status) },
          },
          ScanIndexForward: false,
          ...(query.limit ? { Limit: query.limit } : {}),
        }),
      );

      const summaries = (response.Items ?? []).map(this.mapItemToSummary);
      return { ok: true, value: summaries };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'queryByStatus') };
    }
  }

  async putEntry(entry: Entry, options?: PutEntryOptions): Promise<RepositoryResult<void>> {
    const encoded = encode(entry);
    if (!encoded.ok) {
      return {
        ok: false,
        error: {
          kind: 'MALFORMED_ITEM',
          operation: 'putEntry',
          error: { kind: 'WRONG_TYPE', attribute: encoded.error.attribute },
        },
      };
    }

    const size = encodedSizeBytes(encoded.item);
    if (size > MAX_ENTRY_ITEM_BYTES) {
      return {
        ok: false,
        error: {
          kind: 'ITEM_TOO_LARGE',
          operation: 'putEntry',
          sizeBytes: size,
          limitBytes: MAX_ENTRY_ITEM_BYTES,
        },
      };
    }

    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: encoded.item as unknown as Record<string, import('@aws-sdk/client-dynamodb').AttributeValue>,
          ...(options?.ifAbsent ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
        }),
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'putEntry') };
    }
  }

  async updateEntryStatus(transition: StatusTransition): Promise<RepositoryResult<void>> {
    const key = entryKey(transition.entryId);
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: {
            PK: { S: key.PK },
            SK: { S: key.SK },
          },
          UpdateExpression: 'SET #status = :next, #gsi1pk = :nextGsi1pk, #updatedAt = :updatedAt',
          ConditionExpression: 'attribute_exists(PK) AND #status = :expected',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#gsi1pk': 'GSI1PK',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':expected': { S: transition.expected },
            ':next': { S: transition.next },
            ':nextGsi1pk': { S: timelinePartition(transition.next) },
            ':updatedAt': { S: transition.updatedAt },
          },
        }),
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'updateEntryStatus') };
    }
  }

  async patchEntry(input: PatchEntryInput): Promise<RepositoryResult<Entry>> {
    const key = entryKey(input.entryId);
    const setClauses: string[] = ['#updatedAt = :updatedAt'];
    const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
    const values: Record<string, DynamoAttributeValue> = {
      ':updatedAt': { S: input.updatedAt },
    };

    if (input.patch.title !== undefined) {
      setClauses.push('#title = :title');
      names['#title'] = 'title';
      values[':title'] = { S: input.patch.title };
    }

    if (input.patch.body !== undefined) {
      setClauses.push('#body = :body');
      names['#body'] = 'body';
      values[':body'] = { S: input.patch.body };
    }

    try {
      const response = await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: {
            PK: { S: key.PK },
            SK: { S: key.SK },
          },
          UpdateExpression: `SET ${setClauses.join(', ')}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values as unknown as Record<string, import('@aws-sdk/client-dynamodb').AttributeValue>,
          ReturnValues: 'ALL_NEW',
        }),
      );

      if (!response.Attributes) {
        return {
          ok: false,
          error: { kind: 'CONDITION_FAILED', operation: 'patchEntry' },
        };
      }

      const decoded = decode(response.Attributes as unknown as DynamoItem);
      if (!decoded.ok) {
        return {
          ok: false,
          error: {
            kind: 'MALFORMED_ITEM',
            operation: 'patchEntry',
            error: decoded.error,
          },
        };
      }

      return { ok: true, value: decoded.entry };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'patchEntry') };
    }
  }

  async deleteDraft(entryId: string): Promise<RepositoryResult<void>> {
    const key = entryKey(entryId);
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: {
            PK: { S: key.PK },
            SK: { S: key.SK },
          },
          ConditionExpression: 'attribute_exists(PK) AND #status = :draft',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':draft': { S: 'draft' },
          },
        }),
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'deleteDraft') };
    }
  }

  async getSession(sessionId: string): Promise<RepositoryResult<SessionRecord | null>> {
    const key = sessionKey(sessionId);
    try {
      const response = await this.client.send(
        new GetItemCommand({
          TableName: this.tableName,
          Key: {
            PK: { S: key.PK },
            SK: { S: key.SK },
          },
        }),
      );

      if (!response.Item) {
        return { ok: true, value: null };
      }

      const item = response.Item;
      const record: SessionRecord = {
        sessionId: item.sessionId?.S ?? '',
        entryId: item.entryId?.S ?? '',
        noteText: item.noteText?.S ?? '',
        commitLog: item.commitLog?.S ?? '',
        sessionDate: item.sessionDate?.S ?? '',
        submittedAt: item.submittedAt?.S ?? '',
        generationState: (item.generationState?.S ?? 'pending') as SessionRecord['generationState'],
        correlationId: item.correlationId?.S ?? '',
        schemaVersion: 1,
      };

      return { ok: true, value: record };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'getSession') };
    }
  }

  async putSession(record: SessionRecord): Promise<RepositoryResult<void>> {
    const key = sessionKey(record.sessionId);
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: {
            PK: { S: key.PK },
            SK: { S: key.SK },
            sessionId: { S: record.sessionId },
            entryId: { S: record.entryId },
            noteText: { S: record.noteText },
            commitLog: { S: record.commitLog },
            sessionDate: { S: record.sessionDate },
            submittedAt: { S: record.submittedAt },
            generationState: { S: record.generationState },
            correlationId: { S: record.correlationId },
            schemaVersion: { N: '1' },
          },
        }),
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'putSession') };
    }
  }

  async updateSessionState(transition: SessionStateTransition): Promise<RepositoryResult<void>> {
    const key = sessionKey(transition.sessionId);
    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: {
            PK: { S: key.PK },
            SK: { S: key.SK },
          },
          UpdateExpression: 'SET generationState = :next',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: {
            ':next': { S: transition.next },
          },
        }),
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: this.mapError(error, 'updateSessionState') };
    }
  }

  private mapItemToSummary(item: Record<string, import('@aws-sdk/client-dynamodb').AttributeValue>): EntrySummary {
    return {
      entryId: item.entryId?.S ?? '',
      title: item.title?.S ?? '',
      sessionDate: item.sessionDate?.S ?? '',
      createdAt: item.createdAt?.S ?? '',
      updatedAt: item.updatedAt?.S ?? '',
      generationFailed: Boolean(item.generationFailed?.BOOL),
    };
  }
}
