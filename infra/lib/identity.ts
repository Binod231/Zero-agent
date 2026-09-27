import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import {
  CfnUserPoolUser,
  UserPool,
  UserPoolClient,
} from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface IdentityProps {
  /** Environment name, used to build stable physical names rather than generated ones (Req 12.8). */
  readonly environment: string;
  /** Username of the single user the pool is created with (Req 2.6). */
  readonly authorUsername: string;
}

/**
 * Auth_Service: the Cognito user pool, its app client, and the one Author user.
 */
export class Identity extends Construct {
  public readonly environment: string;
  public readonly authorUsername: string;
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;
  public readonly user: CfnUserPoolUser;

  constructor(scope: Construct, id: string, props: IdentityProps) {
    super(scope, id);
    this.environment = props.environment;
    this.authorUsername = props.authorUsername;

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `devlog-narrator-${props.environment}-users`,
      selfSignUpEnabled: false,
      signInAliases: {
        username: true,
        email: true,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `devlog-narrator-${props.environment}-client`,
      generateSecret: false,
      authFlows: {
        userPassword: true,
      },
      accessTokenValidity: Duration.hours(12),
      refreshTokenValidity: Duration.hours(12),
    });

    this.user = new CfnUserPoolUser(this, 'AuthorUser', {
      userPoolId: this.userPool.userPoolId,
      username: props.authorUsername,
      userAttributes: [
        { name: 'email', value: `${props.authorUsername}@example.com` },
        { name: 'email_verified', value: 'true' },
      ],
    });
  }
}
