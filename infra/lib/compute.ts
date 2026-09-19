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
 * Devlog_API compute: the HTTP API, the three Lambda functions with their explicit log groups and
 * reserved concurrency, the health probe schedule, and their IAM policies.
 *
 * Declares no resources yet — task 11.1 defines the HTTP API, the `api` function, and its
 * least-privilege IAM here; task 21.1 adds the probe function and its EventBridge rule.
 */
export class Compute extends Construct {
  public readonly environment: string;
  public readonly versionId: string;
  public readonly authorUsername: string;
  public readonly storage: Storage;
  public readonly identity: Identity;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);
    this.environment = props.environment;
    this.versionId = props.versionId;
    this.authorUsername = props.authorUsername;
    this.storage = props.storage;
    this.identity = props.identity;
  }
}
