import { Duration, Fn, RemovalPolicy } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  OriginRequestPolicy,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import type { Compute } from './compute';

export interface EdgeProps {
  /** Environment name, used to build stable physical names rather than generated ones (Req 12.8). */
  readonly environment: string;
  /** Devlog_API compute, which the distribution uses as its HTTP origin. */
  readonly compute: Compute;
}

/**
 * Public edge: private asset bucket, CloudFront distribution, and cache/security policies.
 */
export class Edge extends Construct {
  public readonly environment: string;
  public readonly compute: Compute;
  public readonly assetBucket: Bucket;
  public readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);
    this.environment = props.environment;
    this.compute = props.compute;

    // 1. Private Asset Bucket for console SPA and static assets
    this.assetBucket = new Bucket(this, 'AssetBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Deploy console bundle to S3
    const bucket = this.assetBucket as unknown as import('aws-cdk-lib/aws-s3').IBucket;
    new BucketDeployment(this, 'ConsoleDeployment', {
      sources: [Source.asset('dist/console')],
      destinationBucket: bucket,
      destinationKeyPrefix: 'console',
    });

    // 2. Origins
    const httpApiDomain = Fn.select(1, Fn.split('://', props.compute.httpApi.apiEndpoint));
    const apiOrigin = new HttpOrigin(httpApiDomain);
    const s3Origin = S3BucketOrigin.withOriginAccessControl(bucket);

    // 3. Security Response Headers Policy
    const responseHeadersPolicy = new ResponseHeadersPolicy(this, 'ResponseHeadersPolicy', {
      responseHeadersPolicyName: `devlog-narrator-${props.environment}-headers`,
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: HeadersFrameOption.DENY,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    // 4. CloudFront Distribution (Req 1.1, 1.7)
    this.distribution = new Distribution(this, 'Distribution', {
      comment: `Devlog Narrator (${props.environment})`,
      // Default route goes to HTTP API ($default -> site-renderer HTML)
      defaultBehavior: {
        origin: apiOrigin,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
      },
      additionalBehaviors: {
        // API routes go to HTTP API (api Lambda)
        '/api/*': {
          origin: apiOrigin,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy,
        },
        // Static Console assets go to S3
        '/console/*': {
          origin: s3Origin,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy,
        },
      },
    });
  }
}
