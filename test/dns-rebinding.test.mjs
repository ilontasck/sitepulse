import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { fetchSafeHtml } from '../src/audit/url-safety.mjs';

test('HTML transport rejects DNS rebinding before connecting to a private server', async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<title>Private service</title>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  t.mock.method(dns, 'lookup', (_host, options, callback) => {
    callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
  });
  let resolutions = 0;
  await assert.rejects(fetchSafeHtml(`http://rebind.example:${server.address().port}`, {
    resolver: async () => [{ address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }],
    timeoutMs: 1000
  }), error => error.code === 'UNSAFE_URL');
  assert.equal(requests, 0, 'private service must receive no requests');
});

test('transport decodes compressed HTML and aborts unfinished bodies', async (t) => {
  const { gzipSync } = await import('node:zlib');
  const { fetchHtmlTransport } = await import('../src/audit/safe-html-transport.mjs');
  const server = http.createServer((req, res) => {
    if (req.url === '/gzip') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      res.end(gzipSync('<title>Compressed fixture</title>'));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.write('<title>Unfinished');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const run = path => fetchSafeHtml(`https://example.com${path}`, {
    resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 100,
    // Only substitute the destination; use the production streaming transport.
    fetcher: (_url, options) => fetchHtmlTransport(new URL(`http://127.0.0.1:${server.address().port}${path}`), {
      ...options, isUnsafeAddress: () => true
    })
  });
  assert.match((await run('/gzip')).html, /Compressed fixture/);
  await assert.rejects(run('/slow'), error => error.code === 'SCAN_TIMEOUT');
});
