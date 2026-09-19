import { Construct } from 'constructs';
import type { Compute } from './compute';

export interface EdgeProps {
  /** Environment name, used to build stable physical names rather than generated ones (Req 12.8). */
  readonly environment: string;
  /** Devlog_API compute, which the distribution uses as its HTTP origin. */
  readonly compute: Compute;
}

/**
 * Public edge: the private asset bucket, the CloudFront distribution, the per-route cache policies,
 * and the response headers policies.
 *
 * Declares no resources yet — task 11.2 defines the versioned bucket with Origin Access Control
 * only, the distribution with `redirect-to-https` on every behaviour, and the cache and response
 * headers policies here.
 */
export class Edge extends Construct {
  public readonly environment: string;
  public readonly compute: Compute;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);
    this.environment = props.environment;
    this.compute = props.compute;
  }
}
