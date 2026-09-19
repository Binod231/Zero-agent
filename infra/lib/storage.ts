import { Construct } from 'constructs';

export interface StorageProps {
  /** Environment name, used to build stable physical names rather than generated ones (Req 12.8). */
  readonly environment: string;
}

/**
 * Entry_Store: the single DynamoDB table holding every item type, its GSI, and its resource-based
 * policy.
 *
 * Declares no resources yet — task 9.1 defines the table, `status-order-index`, point-in-time
 * recovery, TTL, and the `RETAIN` removal policy here.
 */
export class Storage extends Construct {
  public readonly environment: string;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);
    this.environment = props.environment;
  }
}
