import { Duration } from 'aws-cdk-lib';
import { Alarm, ComparisonOperator } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import type { Compute } from './compute';

export interface ObservabilityProps {
  /** Environment name, used to build stable physical names rather than generated ones (Req 12.8). */
  readonly environment: string;
  /** Address the SNS topic subscribes, so alarms reach the Author (Req 10.3). */
  readonly authorEmail: string;
  /** Devlog_API compute, whose API and probe metrics the alarms watch. */
  readonly compute: Compute;
}

/**
 * Operational visibility: the SNS notification topic, health probe schedule, and CloudWatch alarms.
 */
export class Observability extends Construct {
  public readonly environment: string;
  public readonly authorEmail: string;
  public readonly compute: Compute;
  public readonly topic: Topic;
  public readonly probeFunction: LambdaFunction;
  public readonly errorAlarm: Alarm;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    this.environment = props.environment;
    this.authorEmail = props.authorEmail;
    this.compute = props.compute;

    // 1. SNS Alert Topic (Req 10.3)
    this.topic = new Topic(this, 'AlertTopic', {
      topicName: `devlog-narrator-${props.environment}-alerts`,
      displayName: `Devlog Narrator (${props.environment}) Alerts`,
    });

    if (props.authorEmail && props.authorEmail.includes('@')) {
      this.topic.addSubscription(new EmailSubscription(props.authorEmail));
    }

    // 2. Scheduled 5-minute health probe (Req 11.8)
    const probeLogGroup = new LogGroup(this, 'ProbeLogGroup', {
      logGroupName: `/aws/lambda/devlog-narrator-${props.environment}-probe`,
      retention: RetentionDays.TWO_WEEKS,
    });

    this.probeFunction = new LambdaFunction(this, 'ProbeFunction', {
      functionName: `devlog-narrator-${props.environment}-probe`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      code: Code.fromAsset('dist/lambda/probe'),
      handler: 'index.handler',
      memorySize: 256,
      timeout: Duration.seconds(15),
      logGroup: probeLogGroup,
      environment: {
        PUBLIC_URL: props.compute.httpApi.apiEndpoint,
      },
    });

    const probeRule = new Rule(this, 'ProbeRule', {
      ruleName: `devlog-narrator-${props.environment}-probe-rule`,
      schedule: Schedule.rate(Duration.minutes(5)),
    });
    probeRule.addTarget(new LambdaTarget(this.probeFunction));

    // 3. CloudWatch Error Alarm (Req 10.3)
    this.errorAlarm = new Alarm(this, 'ApiErrorAlarm', {
      alarmName: `devlog-narrator-${props.environment}-api-errors`,
      metric: props.compute.apiFunction.metricErrors({
        period: Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    this.errorAlarm.addAlarmAction(new SnsAction(this.topic));
  }
}
