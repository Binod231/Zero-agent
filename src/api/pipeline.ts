import { ulid } from 'ulid';
import type { DevlogLogger } from '../core/logging';
import type { HttpResponse } from '../core/types';
import { RedactingLogger } from './logger';

export type { HttpResponse };

export interface ApiRequest {
  path: string;
  method: string;
  headers: Record<string, string | undefined>;
  body?: string | undefined;
  clientIp?: string | undefined;
  query?: Record<string, string | undefined> | undefined;
}

export interface ApiContext {
  correlationId: string;
  logger: DevlogLogger;
  startTime: number;
  route: string;
  method: string;
}

export interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    field?: string;
    correlationId: string;
  };
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly field?: string | undefined;

  constructor(statusCode: number, code: string, message: string, field?: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.field = field;
  }
}

export const MAX_CONTENT_LENGTH = 262144; // 256 KiB (Req 9.3)

export function buildErrorResponse(
  statusCode: number,
  code: string,
  message: string,
  correlationId: string,
  field?: string,
): HttpResponse {
  const errorObj: ErrorResponseBody['error'] = {
    code,
    message,
    correlationId,
  };
  if (field !== undefined) {
    errorObj.field = field;
  }

  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ error: errorObj }),
  };
}

export type RouteHandler = (
  req: ApiRequest,
  ctx: ApiContext,
) => Promise<HttpResponse> | HttpResponse;

export class ApiPipeline {
  private readonly routes = new Map<string, RouteHandler>();
  private readonly defaultLogger: RedactingLogger;

  constructor(options: { defaultLogger?: RedactingLogger } = {}) {
    this.defaultLogger = options.defaultLogger ?? new RedactingLogger();
  }

  register(method: string, path: string, handler: RouteHandler): void {
    this.routes.set(`${method.toUpperCase()} ${path}`, handler);
  }

  async execute(req: ApiRequest, customLogger?: RedactingLogger): Promise<HttpResponse> {
    const startTime = Date.now();
    const correlationId = ulid();
    const logger =
      customLogger?.withCorrelationId(correlationId) ??
      this.defaultLogger.withCorrelationId(correlationId);

    const method = req.method.toUpperCase();
    const route = req.path;
    const ctx: ApiContext = {
      correlationId,
      logger,
      startTime,
      route,
      method,
    };

    let response: HttpResponse;

    try {
      // Step 2: Content-Length verification before reading or processing body
      const contentLengthHeader =
        req.headers['content-length'] ?? req.headers['Content-Length'];
      if (contentLengthHeader !== undefined) {
        const contentLength = Number.parseInt(contentLengthHeader, 10);
        if (Number.isFinite(contentLength) && contentLength > MAX_CONTENT_LENGTH) {
          response = buildErrorResponse(
            413,
            'PAYLOAD_TOO_LARGE',
            'Request payload exceeds maximum allowed size of 256 KiB',
            correlationId,
          );
          this.emitCompletion(ctx, response.statusCode);
          return response;
        }
      }

      // Check route handler — exact match first, then parameterized pattern fallback, then prefix
      const handlerKey = `${method} ${req.path}`;
      let handler = this.routes.get(handlerKey);

      if (!handler) {
        const reqParts = req.path.split('/');
        // 1. Try parameterized pattern matching
        for (const [key, h] of this.routes.entries()) {
          const [kMethod, kPattern] = key.split(' ');
          if (kMethod !== method || !kPattern) continue;
          const pParts = kPattern.split('/');
          if (pParts.length === reqParts.length) {
            const matches = pParts.every(
              (p, idx) =>
                p.startsWith(':') ||
                (p.startsWith('{') && p.endsWith('}')) ||
                p === reqParts[idx],
            );
            if (matches) {
              handler = h;
              break;
            }
          }
        }

        // 2. Try prefix matching fallback
        if (!handler) {
          for (const [key, h] of this.routes.entries()) {
            const [kMethod, kPath] = key.split(' ');
            if (kMethod !== method) continue;
            if (kPath && !kPath.includes(':') && req.path.startsWith(kPath + '/')) {
              handler = h;
              break;
            }
          }
        }
      }

      if (!handler) {
        response = buildErrorResponse(
          404,
          'NOT_FOUND',
          `Cannot ${method} ${req.path}`,
          correlationId,
        );
      } else {
        response = await handler(req, ctx);
      }
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        response = buildErrorResponse(
          err.statusCode,
          err.code,
          err.message,
          correlationId,
          err.field,
        );
      } else {
        // Single sanitizing error boundary: never disclose stack trace or internal info
        logger.error('Unhandled server error in request pipeline', {
          errorType: err instanceof Error ? err.name : 'UnknownError',
        });
        response = buildErrorResponse(
          500,
          'INTERNAL_SERVER_ERROR',
          'An unexpected server error occurred',
          correlationId,
        );
      }
    }

    this.emitCompletion(ctx, response.statusCode);
    return response;
  }

  private emitCompletion(ctx: ApiContext, status: number): void {
    const durationMs = Math.max(0, Date.now() - ctx.startTime);
    ctx.logger.completion({
      correlationId: ctx.correlationId,
      route: ctx.route,
      method: ctx.method,
      status,
      durationMs,
    });
  }
}
