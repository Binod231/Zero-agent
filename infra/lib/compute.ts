import { Duration, Stack } from 'aws-cdk-lib';
import {
  CfnStage,
  HttpApi,
  HttpMethod,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { Identity } from './identity';
import type { Storage } from './storage';

export interface ComputeProps {
  /** Environment name, used to build stable physical names rather than generated ones (Req 12.8). */
  readonly environment: string;
  /** Git short SHA, becoming the `DEPLOYED_VERSION` environment variable (Req 12.4). */
  readonly versionId: string;
  /** Becomes the `AUTHOR_USERNAME` environment variable on the `api` function. */
  readonly authorUsername: string;
  /** Entry_Store, so each function receives least-privilege access to it (Req 9.4). */
  readonly storage: Storage;
  /** Auth_Service, so the `api` function can verify tokens against the pool. */
  readonly identity: Identity;
}

/**
 * Devlog_API compute: the HTTP API, the Lambda functions, and their least-privilege IAM policies.
 */
export class Compute extends Construct {
  public readonly environment: string;
  public readonly versionId: string;
  public readonly authorUsername: string;
  public readonly storage: Storage;
  public readonly identity: Identity;

  public readonly apiFunction: LambdaFunction;
  public readonly siteFunction: LambdaFunction;
  public readonly generatorFunction: LambdaFunction;
  public readonly httpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);
    this.environment = props.environment;
    this.versionId = props.versionId;
    this.authorUsername = props.authorUsername;
    this.storage = props.storage;
    this.identity = props.identity;

    // 1. Generator Function (Amazon Bedrock invocation)
    const generatorLogGroup = new LogGroup(this, 'GeneratorLogGroup', {
      logGroupName: `/aws/lambda/devlog-narrator-${props.environment}-generator`,
      retention: RetentionDays.TWO_WEEKS,
    });

    this.generatorFunction = new LambdaFunction(this, 'GeneratorFunction', {
      functionName: `devlog-narrator-${props.environment}-generator`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      code: Code.fromAsset('dist/lambda/generator'),
      handler: 'index.handler',
      memorySize: 1024,
      timeout: Duration.seconds(75),
      reservedConcurrentExecutions: 2,
      logGroup: generatorLogGroup,
      environment: {
        TABLE_NAME: props.storage.table.tableName,
        MODEL_ID: 'us.amazon.nova-lite-v1:0',
      },
    });

    this.generatorFunction.addToRolePolicy(
      new PolicyStatement({
        sid: 'AllowBedrockInvokeModel',
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/*',
          `arn:aws:bedrock:*:${Stack.of(this).account}:inference-profile/*`,
        ],
      }),
    );

    props.storage.grantAccess({
      sid: 'AllowGeneratorFunctionRole',
      role: this.generatorFunction.role!,
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    });

    // 2. Devlog_API Function
    const apiLogGroup = new LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/aws/lambda/devlog-narrator-${props.environment}-api`,
      retention: RetentionDays.TWO_WEEKS,
    });

    this.apiFunction = new LambdaFunction(this, 'ApiFunction', {
      functionName: `devlog-narrator-${props.environment}-api`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      code: Code.fromAsset('dist/lambda/api'),
      handler: 'index.handler',
      memorySize: 512,
      timeout: Duration.seconds(15),
      reservedConcurrentExecutions: 20,
      logGroup: apiLogGroup,
      environment: {
        DEPLOYED_VERSION: props.versionId,
        AUTHOR_USERNAME: props.authorUsername,
        TABLE_NAME: props.storage.table.tableName,
        USER_POOL_ID: props.identity.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.identity.userPoolClient.userPoolClientId,
        GENERATOR_FUNCTION_NAME: this.generatorFunction.functionName,
      },
    });

    this.generatorFunction.grantInvoke(this.apiFunction);

    props.storage.grantAccess({
      sid: 'AllowApiFunctionRole',
      role: this.apiFunction.role!,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:Query',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
      ],
    });

    // 3. Public_Site Renderer Function
    const siteLogGroup = new LogGroup(this, 'SiteLogGroup', {
      logGroupName: `/aws/lambda/devlog-narrator-${props.environment}-site`,
      retention: RetentionDays.TWO_WEEKS,
    });

    this.siteFunction = new LambdaFunction(this, 'SiteFunction', {
      functionName: `devlog-narrator-${props.environment}-site`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      code: Code.fromAsset('dist/lambda/site'),
      handler: 'index.handler',
      memorySize: 512,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: 20,
      logGroup: siteLogGroup,
      environment: {
        TABLE_NAME: props.storage.table.tableName,
      },
    });

    props.storage.grantAccess({
      sid: 'AllowSiteRendererFunctionRole',
      role: this.siteFunction.role!,
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
    });

    // 4. API Gateway HTTP API
    this.httpApi = new HttpApi(this, 'HttpApi', {
      apiName: `devlog-narrator-${props.environment}-http-api`,
      createDefaultStage: true,
    });

    // Stage-level throttling: 50 req/sec sustained (Req 9.1)
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as CfnStage | undefined;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingBurstLimit: 50,
        throttlingRateLimit: 50,
      };
    }

    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', this.apiFunction);
    const siteIntegration = new HttpLambdaIntegration('SiteIntegration', this.siteFunction);

    // Routes:
    this.httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [HttpMethod.ANY],
      integration: apiIntegration,
    });

    this.httpApi.addRoutes({
      path: '/api/health',
      methods: [HttpMethod.GET],
      integration: apiIntegration,
    });

    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [HttpMethod.GET],
      integration: siteIntegration,
    });

    this.httpApi.addRoutes({
      path: '/',
      methods: [HttpMethod.GET],
      integration: siteIntegration,
    });
  }
}
