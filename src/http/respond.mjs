export function sendJson(response, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

export function sendNoContent(response) {
  response.writeHead(204);
  response.end();
}
