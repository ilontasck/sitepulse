import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { HttpError } from "./http-error.mjs";
import { renderLegalTemplate } from "../legal/legal-renderer.mjs";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json"
};

// Legal templates are rendered from the project root with escaped runtime values.
const legalRoutes = new Map([
  ["/privacy", "privacy.html"],
  ["/impressum", "impressum.html"],
  ["/terms", "terms.html"]
]);

export function isLegalRoute(pathname) {
  return legalRoutes.has(pathname);
}

export async function serveStaticFile(requestUrl, root, options = {}) {
  const pathname = new URL(requestUrl || "/", "http://localhost").pathname;

  // Resolve legal page routes before the generic path check.
  const legalFile = legalRoutes.get(pathname);
  const requestedFile = legalFile ?? (pathname === "/" ? "index.html" : pathname.slice(1));

  if (
    requestedFile !== "index.html" &&
    !legalFile &&
    !requestedFile.startsWith("assets/")
  ) {
    throw new HttpError(404, "Static file was not found.", "STATIC_NOT_FOUND");
  }

  const absolutePath = normalize(join(root, requestedFile));
  const relativePath = relative(root, absolutePath);

  if (relativePath.startsWith("..") || absolutePath === root) {
    throw new HttpError(400, "Invalid static file path.", "INVALID_STATIC_PATH");
  }

  const fileBody = await readFile(absolutePath);
  const body = legalFile
    ? renderLegalTemplate(fileBody.toString("utf8"), options.legalConfig)
    : fileBody;

  return {
    body,
    contentType: contentTypes[extname(absolutePath)] || "application/octet-stream"
  };
}
