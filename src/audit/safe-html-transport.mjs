import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { HttpError } from "../http/http-error.mjs";

// Validate the addresses actually handed to the socket, not an earlier DNS answer.
// No shared agent: connections cannot outlive the per-hop safety decision.
export function fetchHtmlTransport(url, { headers, signal, resolver = lookup, isUnsafeAddress }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: "GET",
      agent: false,
      headers,
      signal,
      lookup(hostname, options, callback) {
        Promise.resolve().then(() => resolver(hostname, { all: true, verbatim: false })).then(records => {
          if (!records.length || records.some(record => isUnsafeAddress(record.address))) {
            throw new HttpError(400, "The website resolves to a private or internal network address.", "UNSAFE_URL");
          }
          const selected = options.family ? records.filter(record => record.family === options.family) : records;
          if (!selected.length) throw new Error("No address for the requested family.");
          if (options.all) callback(null, selected);
          else callback(null, selected[0].address, selected[0].family);
        }).catch(callback);
      }
    }, response => {
      const responseHeaders = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      }
      const encoding = responseHeaders.get("content-encoding")?.toLowerCase();
      const decoder = encoding === "gzip" ? createGunzip()
        : encoding === "deflate" ? createInflate()
          : encoding === "br" ? createBrotliDecompress() : null;
      if (encoding && encoding !== "identity" && !decoder) {
        response.destroy();
        reject(new HttpError(400, "Unsupported HTML encoding.", "UNSUPPORTED_HTML_ENCODING"));
        return;
      }
      if (decoder) response.on("error", error => decoder.destroy(error));
      const stream = decoder ? response.pipe(decoder) : response;
      resolve({
        status: response.statusCode,
        ok: response.statusCode >= 200 && response.statusCode < 300,
        headers: responseHeaders,
        body: Readable.toWeb(stream)
      });
    });
    request.on("error", reject);
    request.end();
  });
}
