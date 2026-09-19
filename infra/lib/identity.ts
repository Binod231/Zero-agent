import { Construct } from 'constructs';

export interface IdentityProps {
  /** Environment name, used to build stable physical names rather than generated ones (Req 12.8). */
  readonly environment: string;
  /** Username of the single user the pool is created with (Req 2.6). */
  readonly authorUsername: string;
}

/**
 * Auth_Service: the Cognito user pool, its app client, and the one Author user.
 *
 * Declares no resources yet — task 12.1 defines the pool with `selfSignUpEnabled: false`, the
 * 12-hour token validities, the `USER_PASSWORD_AUTH` client with no secret, and the single
 * `CfnUserPoolUser` here.
 */
export class Identity extends Construct {
  public readonly environment: string;
  public readonly authorUsername: string;

  constructor(scope: Construct, id: string, props: IdentityProps) {
    super(scope, id);
    this.environment = props.environment;
    this.authorUsername = props.authorUsername;
  }
}
