import { HttpError } from "./http-error.mjs";

export async function readJsonBody(request, limitBytes) {
  const contentType = request.headers["content-type"] || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Expected application/json request body.", "UNSUPPORTED_MEDIA_TYPE");
  }

  let size = 0;
  const chunks = [];

  for await (const chunk of request) {
    size += chunk.length;

    if (size > limitBytes) {
      throw new HttpError(413, "Request body is too large.", "REQUEST_TOO_LARGE");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new HttpError(400, "Request body is required.", "EMPTY_BODY");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "INVALID_JSON");
  }
}
