import { scanWebsite } from "../../src/audit/scanner-service.mjs";
import { buildAuditReport } from "../../src/audit/report-generator.mjs";

// Real scanner adapters run on local HTML only; no DNS, HTTP or company website.
export async function localClientReport() {
  const target = { normalizedUrl: "https://fixture.example/prüfung", domain: "fixture.example" };
  const html = '<!doctype html><html lang="de"><head><title>Bäckerei Müller – Grüße aus Köln</title><meta name="viewport" content="width=device-width"><meta name="description" content="Lokale Testseite für den PDF-Export."><link rel="canonical" href="https://fixture.example/prüfung"><meta property="og:title" content="Bäckerei Müller"></head><body><h1>Qualität für Groß & Klein</h1><img src="local.jpg"><form><input id="email"><button>Absenden</button></form></body></html>';
  const scan = await scanWebsite(target, { htmlScanner: async () => ({ target, html, responseHeaders: { "content-security-policy": "default-src 'self'; frame-ancestors 'none'", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "permissions-policy": "camera=()", "cache-control": "max-age=300" }, signals: { https: true, hasViewport: true, formCount: 1, buttonCount: 1, ctaKeywordCount: 0, responseTimeMs: 2350, htmlBytes: Buffer.byteLength(html) }, warnings: [] }) });
  scan.checkedAt = "2026-11-10T12:00:00.000Z";
  return buildAuditReport(scan);
}
