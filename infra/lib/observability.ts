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
 * Operational visibility: the SNS notification topic and the CloudWatch alarms.
 *
 * Declares no resources yet — task 21.2 defines the topic with its email subscription, the billing
 * forecast alarm, the server error rate alarm, and the availability alarm here.
 */
export class Observability extends Construct {
  public readonly environment: string;
  public readonly authorEmail: string;
  public readonly compute: Compute;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    this.environment = props.environment;
    this.authorEmail = props.authorEmail;
    this.compute = props.compute;
  }
}
