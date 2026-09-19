import { Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Compute } from './compute';
import type { DeployContext } from './deploy-context';
import { Edge } from './edge';
import { Identity } from './identity';
import { Observability } from './observability';
import { Storage } from './storage';

export interface DevlogStackProps extends StackProps {
  /** Validated deploy-time configuration, read from CDK context by the app entry point. */
  readonly deployContext: DeployContext;
}

/**
 * The single stack of the Infrastructure_Stack (Req 12.1).
 *
 * One stack keeps the deploy a single transaction with a single rollback boundary (Req 12.6) and
 * keeps the Public_URL stable across redeploys (Req 1.7). Resources are grouped into five construct
 * modules so that each later task edits its own file: storage (task 9.1), identity (task 12.1),
 * compute (tasks 11.1 and 21.1), edge (task 11.2), and observability (task 21.2).
 *
 * Construction order follows the dependency direction: storage and identity have no dependencies,
 * compute reads both, edge fronts compute, and observability watches compute.
 */
export class DevlogStack extends Stack {
  public readonly storage: Storage;
  public readonly identity: Identity;
  public readonly compute: Compute;
  public readonly edge: Edge;
  public readonly observability: Observability;

  constructor(scope: Construct, id: string, props: DevlogStackProps) {
    super(scope, id, props);

    const { environment, versionId, authorEmail, authorUsername } = props.deployContext;

    this.storage = new Storage(this, 'Storage', { environment });

    this.identity = new Identity(this, 'Identity', { environment, authorUsername });

    this.compute = new Compute(this, 'Compute', {
      environment,
      versionId,
      authorUsername,
      storage: this.storage,
      identity: this.identity,
    });

    this.edge = new Edge(this, 'Edge', { environment, compute: this.compute });

    this.observability = new Observability(this, 'Observability', {
      environment,
      authorEmail,
      compute: this.compute,
    });
  }
}
