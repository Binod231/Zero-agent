import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { DevlogStack } from '../../infra/lib/devlog-stack';
import {
  INDEX_PARTITION_KEY_NAME,
  INDEX_SORT_KEY_NAME,
  PARTITION_KEY_NAME,
  SORT_KEY_NAME,
  STATUS_ORDER_INDEX_NAME,
  TIMELINE_PROJECTED_ATTRIBUTES,
  TTL_ATTRIBUTE_NAME,
} from '../../infra/lib/storage';

/**
 * CDK template assertions for the Entry_Store table (Req 8.1, 8.6, 9.4, 9.5, 10.1, 12.7).
 */

function createTestTemplate(): Template {
  const app = new App();
  const stack = new DevlogStack(app, 'TestStack', {
    deployContext: {
      versionId: 'test-version-1234',
      authorEmail: 'test@example.com',
      authorUsername: 'testauthor',
      environment: 'test',
    },
  });
  return Template.fromStack(stack);
}

describe('Entry_Store CDK assertions', () => {
  it('creates the single DynamoDB table with required keys and settings', () => {
    const template = createTestTemplate();

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: PARTITION_KEY_NAME, KeyType: 'HASH' },
        { AttributeName: SORT_KEY_NAME, KeyType: 'RANGE' },
      ],
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
      SSESpecification: {
        SSEEnabled: true,
      },
      TimeToLiveSpecification: {
        AttributeName: TTL_ATTRIBUTE_NAME,
        Enabled: true,
      },
    });
  });

  it('declares the GSI1 status-order-index with INCLUDE projection', () => {
    const template = createTestTemplate();

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        {
          IndexName: STATUS_ORDER_INDEX_NAME,
          KeySchema: [
            { AttributeName: INDEX_PARTITION_KEY_NAME, KeyType: 'HASH' },
            { AttributeName: INDEX_SORT_KEY_NAME, KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'INCLUDE',
            NonKeyAttributes: Match.arrayWith([...TIMELINE_PROJECTED_ATTRIBUTES]),
          },
        },
      ],
    });
  });

  it('configures Retain deletion policy on the table', () => {
    const template = createTestTemplate();
    const tables = template.findResources('AWS::DynamoDB::Table');
    const tableKeys = Object.keys(tables);
    expect(tableKeys.length).toBe(1);

    const tableResource = tables[tableKeys[0]!];
    expect(tableResource).toBeDefined();
    expect(tableResource!.DeletionPolicy).toBe('Retain');
    expect(tableResource!.UpdateReplacePolicy).toBe('Retain');
  });

  it('does not declare any provisioned throughput on table or indexes', () => {
    const template = createTestTemplate();
    const tables = template.findResources('AWS::DynamoDB::Table');
    for (const table of Object.values(tables)) {
      expect(table.Properties.ProvisionedThroughput).toBeUndefined();
      if (table.Properties.GlobalSecondaryIndexes) {
        for (const gsi of table.Properties.GlobalSecondaryIndexes) {
          expect(gsi.ProvisionedThroughput).toBeUndefined();
        }
      }
    }
  });
});
