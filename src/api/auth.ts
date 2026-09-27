/**
 * Auth_Service: sign-in proxy and sign-out / revocation routes.
 *
 * POST /api/author/session  — authenticates the single Author via Cognito USER_PASSWORD_AUTH.
 * DELETE /api/author/session — revokes the current access token via GlobalSignOut.
 */

import {
  CognitoIdentityProviderClient,
  GlobalSignOutCommand,
  InitiateAuthCommand,
  NotAuthorizedException,
  UserNotConfirmedException,
} from '@aws-sdk/client-cognito-identity-provider';
import { HttpError, buildErrorResponse, type ApiContext, type ApiRequest } from './pipeline';
import type { HttpResponse } from '../core/types';

const cognitoClient = new CognitoIdentityProviderClient({});

// Generic credential-failure body — same for every failure path so timing leaks nothing.
const CREDENTIAL_FAILURE_CODE = 'INVALID_CREDENTIALS';
const CREDENTIAL_FAILURE_MSG = 'The credentials provided are invalid';

function jsonOk(body: unknown, extra?: Record<string, string>): HttpResponse {
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      ...extra,
    },
    body: JSON.stringify(body),
  };
}

/**
 * POST /api/author/session
 *
 * Body: { username: string; password: string }
 * Response: { accessToken: string; expiresIn: number }
 */
export async function handleSignIn(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  // Parse body
  let username: unknown;
  let password: unknown;
  try {
    const parsed = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
    username = parsed.username;
    password = parsed.password;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'Request body must be valid JSON');
  }

  if (typeof username !== 'string' || username.trim() === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'username is required', 'username');
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new HttpError(400, 'BAD_REQUEST', 'password is required', 'password');
  }

  const clientId = process.env.USER_POOL_CLIENT_ID;
  if (!clientId) {
    ctx.logger.error('Missing USER_POOL_CLIENT_ID environment variable', {});
    throw new HttpError(500, 'INTERNAL_SERVER_ERROR', 'Auth service is not configured');
  }

  try {
    const result = await cognitoClient.send(
      new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: clientId,
        AuthParameters: {
          USERNAME: username,
          PASSWORD: password,
        },
      }),
    );

    const accessToken = result.AuthenticationResult?.AccessToken;
    const expiresIn = result.AuthenticationResult?.ExpiresIn ?? 43200;

    if (!accessToken) {
      ctx.logger.error('Cognito returned no AccessToken', {});
      return buildErrorResponse(401, CREDENTIAL_FAILURE_CODE, CREDENTIAL_FAILURE_MSG, ctx.correlationId);
    }

    return jsonOk({ accessToken, expiresIn });
  } catch (err: unknown) {
    if (err instanceof NotAuthorizedException || err instanceof UserNotConfirmedException) {
      // Generic failure — never disclose which credential was wrong
      return buildErrorResponse(401, CREDENTIAL_FAILURE_CODE, CREDENTIAL_FAILURE_MSG, ctx.correlationId);
    }
    // Surface unexpected Cognito errors as 500
    ctx.logger.error('Cognito InitiateAuth failed unexpectedly', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    throw new HttpError(500, 'INTERNAL_SERVER_ERROR', 'Authentication service temporarily unavailable');
  }
}

/**
 * DELETE /api/author/session
 *
 * Header: Authorization: Bearer <accessToken>
 * Response: 204 No Content
 */
export async function handleSignOut(req: ApiRequest, ctx: ApiContext): Promise<HttpResponse> {
  const authHeader = req.headers['authorization'] ?? req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header');
  }
  const accessToken = authHeader.slice(7);

  try {
    await cognitoClient.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
    return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '' };
  } catch (err: unknown) {
    ctx.logger.error('GlobalSignOut failed', {
      errorType: err instanceof Error ? err.name : 'UnknownError',
    });
    // Best-effort — treat as success so the client clears session storage
    return { statusCode: 204, headers: { 'cache-control': 'no-store' }, body: '' };
  }
}
