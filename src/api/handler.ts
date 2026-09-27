import { ApiPipeline, type ApiRequest, type HttpResponse } from './pipeline';
import { handleSignIn, handleSignOut } from './auth';

export interface APIGatewayProxyEventV2 {
  version?: string;
  routeKey?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
      protocol?: string;
      sourceIp?: string;
      userAgent?: string;
    };
    timeEpoch?: number;
  };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

const pipeline = new ApiPipeline();

// Register the health route (Req 11.6, 12.4)
pipeline.register('GET', '/api/health', (_req, _ctx): HttpResponse => {
  const version = process.env.DEPLOYED_VERSION ?? 'dev';
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
    body: JSON.stringify({ version }),
  };
});

// Auth_Service routes (Task 12.4, 12.5)
pipeline.register('POST', '/api/author/session', handleSignIn);
pipeline.register('DELETE', '/api/author/session', handleSignOut);

export { pipeline };

/**
 * Devlog_API Lambda entry point for AWS API Gateway HTTP API.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? '/';
  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body
    : undefined;

  const request: ApiRequest = {
    method,
    path,
    headers: event.headers ?? {},
    body,
    clientIp: event.requestContext?.http?.sourceIp,
    query: event.queryStringParameters ?? {},
  };

  const response = await pipeline.execute(request);

  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
  };
}
