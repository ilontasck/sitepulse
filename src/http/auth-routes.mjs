import { AuthCapacityError, AuthInputError } from "../auth/auth-errors.mjs";
import { AuthServiceError } from "../auth/auth-service.mjs";
import { readJsonBody } from "./body.mjs";
import { HttpError } from "./http-error.mjs";
import { requireTrustedOrigin } from "./origin-policy.mjs";
import { sendJson, sendNoContent } from "./respond.mjs";
import { resolveAuthenticatedUser } from "./auth-request.mjs";

function requireObjectBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.", "INVALID_REQUEST_BODY");
  }
  return body;
}

function mapAuthError(error, response) {
  if (error instanceof AuthCapacityError || error?.code === "AUTH_CAPACITY_EXCEEDED") {
    response.setHeader("Retry-After", "2");
    return new HttpError(503, "Authentication is temporarily unavailable.", "AUTH_TEMPORARILY_UNAVAILABLE");
  }
  if (error instanceof AuthInputError) {
    return new HttpError(400, error.message, error.code);
  }
  if (error instanceof AuthServiceError) {
    if (error.code === "EMAIL_ALREADY_REGISTERED") {
      return new HttpError(409, error.message, error.code);
    }
    if (error.code === "INVALID_CREDENTIALS") {
      return new HttpError(401, error.message, error.code);
    }
  }
  return error;
}

async function performAuthOperation(operation, response) {
  try {
    return await operation();
  } catch (error) {
    throw mapAuthError(error, response);
  }
}

function methodNotAllowed() {
  return new HttpError(405, "Method is not allowed for this endpoint.", "METHOD_NOT_ALLOWED");
}

export async function handleAuthApi({
  request,
  response,
  config,
  url,
  authService,
  cookiePolicy,
  rateLimiters
}) {
  if (!url.pathname.startsWith("/api/auth")) {
    return false;
  }

  rateLimiters.general(request, response);

  if (url.pathname === "/api/auth/register") {
    if (request.method !== "POST") throw methodNotAllowed();
    rateLimiters.register(request, response);
    requireTrustedOrigin(request, config.publicOrigin);
    const body = requireObjectBody(
      await readJsonBody(request, config.requestBodyLimitBytes, { strictContentType: true })
    );
    const result = await performAuthOperation(() => authService.register(body), response);
    response.setHeader("Set-Cookie", cookiePolicy.serialize(result.sessionToken, result.sessionExpiresAt));
    return sendJson(response, 201, { user: result.user });
  }

  if (url.pathname === "/api/auth/login") {
    if (request.method !== "POST") throw methodNotAllowed();
    rateLimiters.login(request, response);
    requireTrustedOrigin(request, config.publicOrigin);
    const body = requireObjectBody(
      await readJsonBody(request, config.requestBodyLimitBytes, { strictContentType: true })
    );
    const previousSessionToken = cookiePolicy.parse(request.headers.cookie);
    const result = await performAuthOperation(
      () => authService.login({ ...body, previousSessionToken }),
      response
    );
    response.setHeader("Set-Cookie", cookiePolicy.serialize(result.sessionToken, result.sessionExpiresAt));
    return sendJson(response, 200, { user: result.user });
  }

  if (url.pathname === "/api/auth/me") {
    if (request.method !== "GET") throw methodNotAllowed();
    const user = await resolveAuthenticatedUser(request, { authService, cookiePolicy });
    if (!user) {
      throw new HttpError(401, "Sign in to continue.", "AUTHENTICATION_REQUIRED");
    }
    return sendJson(response, 200, { user });
  }

  if (url.pathname === "/api/auth/logout") {
    if (request.method !== "POST") throw methodNotAllowed();
    requireTrustedOrigin(request, config.publicOrigin);
    requireObjectBody(
      await readJsonBody(request, config.requestBodyLimitBytes, { strictContentType: true })
    );
    const sessionToken = cookiePolicy.parse(request.headers.cookie);
    response.setHeader("Set-Cookie", cookiePolicy.clear());
    await performAuthOperation(() => authService.logout(sessionToken), response);
    return sendNoContent(response);
  }

  throw new HttpError(404, "API endpoint was not found.", "API_NOT_FOUND");
}
