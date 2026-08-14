import { HttpError } from "./http-error.mjs";

export function requireTrustedOrigin(request, publicOrigin) {
  const providedOrigin = request.headers.origin;
  if (typeof providedOrigin !== "string" || providedOrigin === "null") {
    throw new HttpError(403, "Request origin could not be verified.", "CSRF_REJECTED");
  }

  try {
    const parsed = new URL(providedOrigin);
    if (parsed.origin !== providedOrigin || parsed.origin !== publicOrigin) {
      throw new Error("origin mismatch");
    }
  } catch {
    throw new HttpError(403, "Request origin could not be verified.", "CSRF_REJECTED");
  }
}
