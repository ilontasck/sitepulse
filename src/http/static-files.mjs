import { readFile } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { HttpError } from "./http-error.mjs";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

export async function serveStaticFile(requestUrl, root) {
  const pathname = new URL(requestUrl || "/", "http://localhost").pathname;
  const requestedFile = pathname === "/" ? "index.html" : pathname.slice(1);

  if (requestedFile !== "index.html" && !requestedFile.startsWith("assets/")) {
    throw new HttpError(404, "Static file was not found.", "STATIC_NOT_FOUND");
  }

  const absolutePath = normalize(join(root, requestedFile));
  const relativePath = relative(root, absolutePath);

  if (relativePath.startsWith("..") || absolutePath === root) {
    throw new HttpError(400, "Invalid static file path.", "INVALID_STATIC_PATH");
  }

  const body = await readFile(absolutePath);

  return {
    body,
    contentType: contentTypes[extname(absolutePath)] || "application/octet-stream"
  };
}
