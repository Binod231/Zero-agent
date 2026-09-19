import type { App } from 'aws-cdk-lib';

/**
 * The deploy-time configuration the Infrastructure_Stack requires on every synthesis.
 *
 * Every value is supplied on the command line (`-c key=value`). None of them has a default:
 * a silent default would let a deploy succeed with the wrong author identity, the wrong
 * notification address, or a version identifier that does not match the commit being deployed
 * (Req 12.4), and the mismatch would only surface after the stack was live.
 */
export interface DeployContext {
  /** Git short SHA of the commit being deployed. Reported by the health route (Req 12.4). */
  readonly versionId: string;
  /** Address the billing and error alarms notify (Req 10.3). */
  readonly authorEmail: string;
  /** Username of the single Cognito user the stack creates (Req 2.6). */
  readonly authorUsername: string;
  /** Environment name, applied as the `environment` tag on every resource (Req 10.7). */
  readonly environment: string;
}

/** Keys of {@link DeployContext}, which are exactly the CDK context keys that must be supplied. */
export type DeployContextKey = keyof DeployContext;

/**
 * Thrown during synthesis when a required CDK context key is absent or blank. Named so the
 * failure is identifiable in CLI output rather than surfacing as a bare `Error`.
 */
export class MissingDeployContextError extends Error {
  /** The context keys that were absent or blank, in declaration order. */
  public readonly missingKeys: readonly DeployContextKey[];

  constructor(missingKeys: readonly DeployContextKey[]) {
    const label = missingKeys.length === 1 ? 'key' : 'keys';
    super(
      `Missing required CDK context ${label}: ${missingKeys.join(', ')}. ` +
        'Supply every deploy-time value on the command line, for example: ' +
        'cdk synth -c versionId=$(git rev-parse --short HEAD) -c authorEmail=author@example.com ' +
        '-c authorUsername=author -c environment=prod',
    );
    this.name = 'MissingDeployContextError';
    this.missingKeys = missingKeys;
  }
}

/**
 * Reads and validates every required context value, collecting all failures so one synthesis
 * attempt reports every missing key instead of one per run.
 *
 * @throws {MissingDeployContextError} when any key is absent, not a string, or blank.
 */
export function readDeployContext(app: App): DeployContext {
  const missingKeys: DeployContextKey[] = [];

  const read = (key: DeployContextKey): string => {
    const value: unknown = app.node.tryGetContext(key);
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
    missingKeys.push(key);
    return '';
  };

  const deployContext: DeployContext = {
    versionId: read('versionId'),
    authorEmail: read('authorEmail'),
    authorUsername: read('authorUsername'),
    environment: read('environment'),
  };

  if (missingKeys.length > 0) {
    throw new MissingDeployContextError(missingKeys);
  }

  return deployContext;
}
