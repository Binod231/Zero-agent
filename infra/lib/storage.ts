import { Lazy, RemovalPolicy, Stack } from 'aws-cdk-lib';
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import { AnyPrincipal, Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Conditions, IRole } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** The table's partition key. Every item type in the design is addressed by `PK` and `SK`. */
export const PARTITION_KEY_NAME = 'PK';

/** The table's sort key. */
export const SORT_KEY_NAME = 'SK';

/** GSI1's name. Must equal the index name the repository queries (`src/core/entry-repository.ts`). */
export const STATUS_ORDER_INDEX_NAME = 'status-order-index';

/** GSI1's partition key: `TL#PUB` or `TL#DRAFT`, present only on ENTRY items. */
export const INDEX_PARTITION_KEY_NAME = 'GSI1PK';

/** GSI1's sort key: the ordering key that makes one descending scan yield the order of Req 7.2. */
export const INDEX_SORT_KEY_NAME = 'GSI1SK';

/** The attribute DynamoDB reads to expire operational items. Entry and SESSION items carry none. */
export const TTL_ATTRIBUTE_NAME = 'ttl';

/**
 * GSI1's `INCLUDE` projection, exactly the design's list and exactly the `EntrySummary` field set.
 *
 * The narrowness is the point: `body` is excluded, so a timeline query reads kilobytes rather than
 * megabytes, and no query can return a `body` even by accident.
 */
export const TIMELINE_PROJECTED_ATTRIBUTES: readonly string[] = [
  'entryId',
  'title',
  'sessionDate',
  'createdAt',
  'updatedAt',
  'generationFailed',
];

/** Every DynamoDB action, used only by the deny statement that closes the table to other principals. */
const ALL_TABLE_ACTIONS = 'dynamodb:*';

export interface StorageProps {
  /** Environment name, used to build stable physical names rather than generated ones (Req 12.8). */
  readonly environment: string;
  /**
   * ARN patterns of the deploying principals exempt from the deny statement, matched against
   * `aws:PrincipalArn` with `ArnNotLike`.
   *
   * Defaults to the CDK bootstrap CloudFormation execution role, which is the principal
   * CloudFormation assumes to create, update, tag, and re-policy the table. Exempting it is not
   * optional: DynamoDB refuses a resource policy that would lock the calling principal out of
   * `PutResourcePolicy`, so a policy with no exemption is rejected at deploy time rather than
   * producing an unmanageable table.
   */
  readonly deployPrincipalArnPatterns?: readonly string[];
}

/**
 * One principal's access to the Entry_Store, registered by the task that creates that principal.
 *
 * Each grant becomes one `Allow` statement in the table's resource policy and adds the role to the
 * deny statement's exemption list.
 */
export interface TableAccessGrant {
  /**
   * Statement identifier, alphanumeric, stable across synths — it is how the template assertions of
   * task 9.5 name the statement. For example `AllowApiFunctionRole`.
   */
  readonly sid: string;
  /** The function's execution role. */
  readonly role: IRole;
  /**
   * The exact actions that role performs, from the design's least-privilege table (Req 9.4). Do not
   * pass a wildcard: for a same-account principal an `Allow` here is sufficient on its own, so a
   * wider action list widens what the role can actually do regardless of its identity policy.
   */
  readonly actions: readonly string[];
  /**
   * Conditions that must also hold, mirroring the role's identity policy. The `site-renderer`
   * passes its `dynamodb:LeadingKeys` condition here as well as on its identity policy, for the
   * same reason: an unconditional `Allow` in this policy would by itself let the renderer write an
   * `ENTRY#` item.
   */
  readonly conditions?: Conditions;
}

/**
 * Entry_Store: the single DynamoDB table holding every item type, its GSI, and its resource-based
 * policy.
 *
 * **On-demand only (Req 10.1).** `PAY_PER_REQUEST` billing, no autoscaling target, no provisioned
 * throughput anywhere in the table or the index, so nothing here bills by the hour.
 *
 * **Durability (Req 8.1, 8.6, 12.7).** Point-in-time recovery gives exactly the 35-day restore
 * window Req 8.1 names. Server-side encryption covers Req 8.6. `RemovalPolicy.RETAIN` becomes both
 * `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`, so neither a stack deletion nor a
 * replacing update can take the data with it, and removing Entry data stays a separate deliberate
 * action outside the deploy command.
 *
 * **Self-pruning.** TTL is enabled on `ttl`. Entry and SESSION items simply omit the attribute and
 * therefore never expire; every operational item (revoked credential, auth-failure window, quota
 * counter, IP token bucket) carries one, so the table prunes itself with no scheduled job.
 *
 * **Isolation (Req 9.5).** See {@link grantAccess}.
 */
export class Storage extends Construct {
  public readonly environment: string;

  /** The Entry_Store table. GSI1 is reachable as `${table.tableArn}/index/${STATUS_ORDER_INDEX_NAME}`. */
  public readonly table: Table;

  /**
   * The table ARN built from the stable physical name rather than read back off the table with
   * `Fn::GetAtt`. The resource policy is a *property of the table*, so a `GetAtt` on the table
   * inside it is a self-reference CloudFormation cannot resolve.
   */
  private readonly policyTableArn: string;

  /**
   * Principal ARNs and ARN patterns the deny statement exempts. Mutated by {@link grantAccess} and
   * read lazily at synthesis, which is what lets roles register after this construct is built.
   */
  private readonly allowedPrincipalArnPatterns: string[];

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);
    this.environment = props.environment;

    const stack = Stack.of(this);
    this.allowedPrincipalArnPatterns = [
      ...(props.deployPrincipalArnPatterns ?? [
        `arn:${stack.partition}:iam::${stack.account}:role/cdk-*-cfn-exec-role-*`,
      ]),
    ];

    // Stable, derived from the environment: an auto-generated name would change the template
    // between synths of the same commit (Req 12.8).
    const tableName = `devlog-narrator-${props.environment}-entry-store`;
    this.policyTableArn = stack.formatArn({
      service: 'dynamodb',
      resource: 'table',
      resourceName: tableName,
    });

    this.table = new Table(this, 'Table', {
      tableName,
      partitionKey: { name: PARTITION_KEY_NAME, type: AttributeType.STRING },
      sortKey: { name: SORT_KEY_NAME, type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // Renders `SSESpecification: { SSEEnabled: true }` against the AWS managed `aws/dynamodb`
      // key, so encryption at rest (Req 8.6) is visible in the template rather than implicit in the
      // service default. The key carries no monthly charge, only per-request KMS charges, so
      // Req 10.1's ban on minimum monthly charges still holds.
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: TTL_ATTRIBUTE_NAME,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: STATUS_ORDER_INDEX_NAME,
      partitionKey: { name: INDEX_PARTITION_KEY_NAME, type: AttributeType.STRING },
      sortKey: { name: INDEX_SORT_KEY_NAME, type: AttributeType.STRING },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [...TIMELINE_PROJECTED_ATTRIBUTES],
    });

    // Req 9.5: "unreachable from the public internet" as an identity boundary. DynamoDB is a
    // regional endpoint, not a networked host, so the control is this statement — every principal
    // whose ARN is not on the exemption list is denied every DynamoDB action on the table and its
    // indexes, no matter what its identity policy says, because an explicit deny always wins.
    //
    // Expressed as `Principal: "*"` plus `ArnNotLike` on `aws:PrincipalArn` rather than as
    // `NotPrincipal`, for two reasons AWS documents: a `NotPrincipal` deny always denies any
    // principal carrying a permissions boundary regardless of the list, and a role ARN in
    // `NotPrincipal` does not reliably cover that role's sessions, whereas `aws:PrincipalArn`
    // resolves to the role ARN for an assumed-role session, which is exactly what a Lambda
    // execution role presents.
    //
    // The wildcard action is deliberate and is the one wildcard in the stack: the statement's job is
    // to close every action, including `Scan`, `DeleteTable`, `ExportTableToPointInTime`, and
    // `PutResourcePolicy`. It grants nothing, so it is not a least-privilege hole (Req 9.4) — the
    // template assertions of task 9.5 should scope their no-wildcard check to `Allow` statements.
    this.table.addToResourcePolicy(
      new PolicyStatement({
        sid: 'DenyEveryPrincipalOutsideTheStack',
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: [ALL_TABLE_ACTIONS],
        resources: this.resourceArns(),
        conditions: {
          ArnNotLike: {
            'aws:PrincipalArn': Lazy.list({ produce: () => this.allowedPrincipalArnPatterns }),
          },
        },
      }),
    );
  }

  /**
   * Registers one principal with the table's resource policy: the seam tasks 11.1, 15.1, and 19.1
   * use to attach their function roles.
   *
   * Each call adds an `Allow` statement naming that role and adds the role's ARN to the deny
   * statement's exemption list. Both halves are required — the deny is unconditional for anyone not
   * on the exemption list, so a role that is granted an `Allow` but not exempted is still denied.
   * Call it at any point during synthesis; the exemption list is read lazily, so registration order
   * and construct order do not matter.
   *
   * No circular dependency arises: the table's resource policy references `Role.Arn`, while the
   * role's *default policy* is a separate resource that references the table ARN, so CloudFormation
   * orders Role → Table → RoleDefaultPolicy.
   *
   * Expected call sites, with the action sets from the design's least-privilege IAM table:
   *
   * - task 11.1 (`api`): `['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem',
   *   'dynamodb:UpdateItem', 'dynamodb:DeleteItem']`, sid `AllowApiFunctionRole`.
   * - task 15.1 (`generator`): `['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']`,
   *   sid `AllowGeneratorFunctionRole`.
   * - task 19.1 (`site-renderer`): two calls — `['dynamodb:GetItem', 'dynamodb:Query']` with sid
   *   `AllowSiteRendererFunctionRoleReads`, and `['dynamodb:UpdateItem']` with sid
   *   `AllowSiteRendererFunctionRoleTokenBucket` carrying
   *   `{ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['IPB#*'] } }`, so the renderer's
   *   inability to write an `ENTRY#` item holds in this policy too and not only in its identity
   *   policy.
   *
   * The `probe` function must not be registered: it has no table access at all.
   */
  public grantAccess(grant: TableAccessGrant): void {
    this.allowedPrincipalArnPatterns.push(grant.role.roleArn);

    const statement = new PolicyStatement({
      sid: grant.sid,
      effect: Effect.ALLOW,
      principals: [grant.role],
      actions: [...grant.actions],
      resources: this.resourceArns(),
    });
    if (grant.conditions !== undefined) {
      statement.addConditions(grant.conditions);
    }

    this.table.addToResourcePolicy(statement);
  }

  /** The table and every index on it, which is the full reach of a policy attached to this table. */
  private resourceArns(): string[] {
    return [this.policyTableArn, `${this.policyTableArn}/index/*`];
  }
}
