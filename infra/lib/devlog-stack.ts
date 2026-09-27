import { CfnOutput, Stack } from 'aws-cdk-lib';
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

    // Outputs required by the hackathon ship gate and author workflow
    new CfnOutput(this, 'PublicUrl', {
      value: `https://${this.edge.distribution.distributionDomainName}`,
      description: 'The Public URL reachable by judges and readers (Ship Gate)',
    });

    new CfnOutput(this, 'HealthUrl', {
      value: `https://${this.edge.distribution.distributionDomainName}/api/health`,
      description: 'The Public Health Route URL reporting deployed version',
    });

    new CfnOutput(this, 'ConsoleUrl', {
      value: `https://${this.edge.distribution.distributionDomainName}/console/index.html`,
      description: 'Author Console URL for writing and managing devlog entries',
    });

    new CfnOutput(this, 'DeployedVersion', {
      value: versionId,
      description: 'Git short SHA of the deployed build',
    });

    new CfnOutput(this, 'UserPoolId', {
      value: this.identity.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new CfnOutput(this, 'UserPoolClientId', {
      value: this.identity.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });
  }
}
