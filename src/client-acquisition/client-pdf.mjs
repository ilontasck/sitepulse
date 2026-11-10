import { chromium } from "playwright";
import { hasFailedLabMeasurement, prepareClientReport } from "./client-report-data.mjs";

const priorities = { critical: [0, "Kritisch"], high: [1, "Hoch"], medium: [2, "Mittel"], low: [3, "Niedrig"], info: [4, "Hinweis"] };
// A failed check is an observation in the scanner's scope, not a claim about business impact.
const definitions = {
  "title-present": ["Seitentitel nicht erkannt", "Einen eindeutigen, beschreibenden Seitentitel hinterlegen."],
  "title-length": ["Länge des Seitentitels prüfen", "Den Titel auf Inhalt, Suchintention und Lesbarkeit abstimmen.", true],
  "meta-description": ["Meta-Beschreibung nicht erkannt", "Eine passende Beschreibung für das Suchergebnis ergänzen."],
  canonical: ["Canonical-Verweis nicht erkannt", "Die gewünschte indexierbare URL bestimmen und bei Bedarf einen Canonical-Verweis ergänzen."],
  "h1-count": ["Anzahl der Hauptüberschriften prüfen", "Die Überschriftenhierarchie redaktionell prüfen.", true],
  "robots-indexable": ["Indexierung durch Meta-Angabe eingeschränkt", "Prüfen, ob die noindex-Angabe beabsichtigt ist."],
  "open-graph": ["Open-Graph-Metadaten nicht erkannt", "Titel, Beschreibung und Vorschaubild für geteilte Links ergänzen."],
  "html-lang": ["Dokumentsprache nicht erkannt", "Das passende lang-Attribut am HTML-Element ergänzen."],
  "image-alt": ["Bilder ohne Alt-Attribut erkannt", "Alternativtexte nach Bildfunktion ergänzen; dekorative Bilder mit leerem Alt-Attribut kennzeichnen."],
  "input-labels": ["Formularbeschriftungen prüfen", "Die betroffenen Eingaben im Browser prüfen und zugängliche Beschriftungen ergänzen.", true],
  "button-names": ["Schaltflächennamen prüfen", "Die zugänglichen Namen im Browser prüfen und verständlich beschriften.", true],
  "heading-structure": ["Überschriftenstruktur prüfen", "Eine verständliche Hierarchie der Überschriften sicherstellen.", true],
  "response-time": ["Erhöhte HTML-Antwortzeit gemessen", "Die Antwortzeit wiederholt messen und Server, Cache sowie Netzwerk untersuchen."],
  "html-size": ["Umfang des HTML-Dokuments prüfen", "Nicht benötigtes Markup reduzieren und die Wirkung erneut messen.", true],
  "script-count": ["Anzahl der Skripte prüfen", "Benötigte Skripte inventarisieren; Auswirkungen vor Änderungen messen.", true],
  "stylesheet-count": ["Anzahl der Stylesheets prüfen", "Nicht benötigte Styles identifizieren und Ladeverhalten messen.", true],
  "inline-script-size": ["Umfang eingebetteter Skripte prüfen", "Große Inline-Skripte auf Notwendigkeit und Cache-Möglichkeiten prüfen.", true],
  "caching-headers": ["Cache-Angaben nicht erkannt", "Eine zum Inhalt passende Cache-Strategie festlegen."],
  https: ["Verbindung ohne HTTPS", "HTTPS bereitstellen und HTTP-Aufrufe sicher weiterleiten."],
  csp: ["Content-Security-Policy nicht erkannt", "Eine zur Anwendung passende Richtlinie zunächst im Report-Only-Modus testen."],
  "frame-protection": ["Schutz vor Einbettung nicht erkannt", "Die erlaubte Einbettung über CSP frame-ancestors festlegen."],
  nosniff: ["nosniff-Header nicht erkannt", "X-Content-Type-Options: nosniff ergänzen und Dateitypen prüfen."],
  "referrer-policy": ["Referrer-Policy nicht erkannt", "Eine geeignete Referrer-Policy festlegen."],
  "permissions-policy": ["Permissions-Policy nicht erkannt", "Nicht benötigte Browserfunktionen gezielt einschränken."]
};
for (const [id, name] of Object.entries({ lcp: "Largest Contentful Paint", cls: "Cumulative Layout Shift", fcp: "First Contentful Paint", "speed-index": "Speed Index", tbt: "Total Blocking Time", "performance-score": "Performance-Score", "accessibility-score": "Barrierefreiheits-Score", "best-practices-score": "Best-Practices-Score", "seo-score": "SEO-Score" })) {
  definitions[`lighthouse-${id}`] = [`Lighthouse: ${name} außerhalb des Prüfwerts`, "Die Lighthouse-Diagnose prüfen, Ursachen eingrenzen und nach der Korrektur erneut messen."];
}
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const list = (value) => Array.isArray(value) ? value : [];
function hasConsistentHtmlEvidence(check, evidence) {
  if (check.id === "image-alt") return parseFloat(evidence) > 0;
  if (check.id === "response-time") return parseFloat(evidence) >= 1800;
  return true;
}
const measuredStatuses = new Set(["html-audit-completed", "full-rendered-completed", "partial-audit-completed", "rendered-audit-timed-out", "rendered-audit-temporarily-unavailable"]);

export function createClientPdfModel(report, { company = "" } = {}) {
  report = prepareClientReport(report);
  const live = measuredStatuses.has(report?.scanner?.status) && report?.scanner?.mode !== "fallback";
  const checks = list(report?.categories).flatMap((category) => list(category?.checks));
  const findings = checks.filter((check) => check?.passed === false).map((check) => {
    const definition = Object.hasOwn(definitions, check.id) ? definitions[check.id] : null;
    const lab = String(check.id || "").startsWith("lighthouse-");
    const evidence = String(check.details || "").trim();
    const confirmed = live && !!definition && !definition[2] && (!lab || hasFailedLabMeasurement(check, report.signals?.lab)) && hasConsistentHtmlEvidence(check, evidence);
    return {
      title: confirmed || definition?.[2] ? definition[0] : "Scanner-Hinweis: manuelle Prüfung erforderlich",
      recommendation: definition?.[1] || "Den Originalhinweis fachlich prüfen und die Ursache vor einer Änderung bestätigen.",
      priority: (Object.hasOwn(priorities, String(check.priority).toLowerCase()) ? priorities[String(check.priority).toLowerCase()] : priorities.medium),
      confirmed,
      source: !live ? "Nicht bestätigte Datenquelle" : lab ? (confirmed ? "Lighthouse-Labormessung" : "Lighthouse-Hinweis ohne bestätigte Überschreitung") : "Automatische HTML-/Header-Prüfung",
      evidence: evidence || `Prüfung ${check.id || "ohne Kennung"}: als nicht bestanden gemeldet. Kein freigegebener Detailbeleg verfügbar.`,
      original: "",
      url: check.page || check.url || check.affectedUrl || report.normalizedUrl || "Nicht angegeben"
    };
  }).sort((a, b) => a.priority[0] - b.priority[0]);
  const score = live && checks.some((check) => typeof check?.passed === "boolean") && Number.isFinite(report?.overallScore) && report.overallScore >= 0 && report.overallScore <= 100 ? report.overallScore : null;
  return { company, website: report?.normalizedUrl || report?.domain || "Nicht angegeben", checkedAt: report?.scanner?.checkedAt || "Nicht angegeben", status: report?.scanner?.status || "unknown", live, score, findings, warnings: [...new Set([...list(report?.warnings), ...list(report?.scanner?.warnings)])], metrics: live ? report?.signals?.lab?.metrics : null };
}

export function renderClientAuditHtml(report, options = {}) {
  const model = createClientPdfModel(report, options);
  const confirmed = model.findings.filter((finding) => finding.confirmed);
  const uncertain = model.findings.filter((finding) => !finding.confirmed);
  const cards = (items) => items.map((finding) => `<article><div class="eyebrow">Priorität: ${escape(finding.priority[1])} · ${escape(finding.source)}</div><h3>${escape(finding.title)}</h3><p class="evidence"><b>Beleg / Beobachtung</b><br>${escape(finding.evidence)}</p>${finding.original ? `<p>Originalhinweis: ${escape(finding.original)}</p>` : ""}<p class="url">Geprüfte URL: ${escape(finding.url)}</p><p><b>Empfehlung</b><br>${escape(finding.recommendation)}</p></article>`).join("");
  const metrics = [["lcpMs", "LCP", "ms"], ["cls", "CLS", ""], ["fcpMs", "FCP", "ms"], ["speedIndexMs", "Speed Index", "ms"], ["tbtMs", "TBT", "ms"]].filter(([key]) => Number.isFinite(model.metrics?.[key]) && model.metrics[key] >= 0).map(([key, label, unit]) => `<tr><th>${label}</th><td>${escape(new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 }).format(model.metrics[key]))} ${unit}</td></tr>`).join("");
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; base-uri 'none'"><title>Sitepulse | Website-Audit</title><style>
  @page { size:A4; margin:18mm 17mm 20mm; }
  * { box-sizing:border-box; } body { margin:0; color:#142537; font:10pt/1.45 Arial, sans-serif; overflow-wrap:anywhere; print-color-adjust:exact; }
  header { border-top:5px solid #27bed3; padding-top:15px; display:flex; justify-content:space-between; color:#294659; } .brand { font-size:21pt; font-weight:700; letter-spacing:-1px; } .eyebrow { font-size:8pt; text-transform:uppercase; letter-spacing:.8px; color:#426476; }
  h1 { font-size:32pt; line-height:1.13; letter-spacing:-1px; margin:30px 0 10px; } h2 { font-size:17pt; margin:25px 0 12px; break-after:avoid; } h2 + p { break-after:avoid; } tr { break-inside:avoid; } h3 { font-size:13pt; margin:5px 0 9px; line-height:1.35; } p { margin:6px 0; orphans:3; widows:3; }
  .intro { color:#496274; } .summary { margin:22px 0; padding:20px; background:#eff8fa; border-left:4px solid #27bed3; } .score { font-size:30pt; font-weight:700; line-height:1.2; } .score small { font-size:12pt; font-weight:400; }
  article { border:1px solid #d7e2e7; border-radius:7px; padding:12px; margin:0 0 12px; break-inside:avoid; } .evidence { background:#f3f6f8; padding:8px; white-space:pre-wrap; } .url, .note { font-size:9pt; color:#4b6475; } .section { break-before:page; } table { width:100%; border-collapse:collapse; } th,td { text-align:left; padding:8px; border-bottom:1px solid #d7e2e7; } .warning { border-left:3px solid #c28b2c; padding-left:12px; }
  </style></head><body><header><span class="brand">sitepulse<span style="color:#159db4">.</span></span><span class="eyebrow">Website-Audit · Vertraulich</span></header>
  <h1>Ihre Website.<br>Klare nächste Schritte.</h1><p class="intro">Technischer Prüfbericht${model.company ? ` für ${escape(model.company)}` : ""}</p><p>${escape(model.website)}</p><p class="note">Prüfzeitpunkt (Scanner): ${escape(model.checkedAt)}<br>Scanner-Status: ${escape(model.status)}</p>
  <div class="summary"><div class="eyebrow">Gesamtbewertung</div><p class="score">${model.score === null ? "Nicht verfügbar" : `${escape(model.score)} <small>/ 100</small>`}</p><p>${model.score === null ? "Keine belastbare Gesamtbewertung aus den vorliegenden Daten ableitbar." : "Berechneter Sitepulse-Orientierungswert aus automatischen Regeln. Kein Lighthouse-Score und keine vollständige Qualitätsbewertung."}</p></div>
  <h2>Kurzfassung</h2><p>${confirmed.length} bestätigte Scanner-Beobachtungen und ${uncertain.length} ${uncertain.length === 1 ? "Hinweis" : "Hinweise"} zur manuellen Prüfung.</p><p>${model.live ? (model.findings.length ? "Bearbeiten Sie zuerst die hohen Prioritäten. Prüfen Sie die Hinweise im jeweiligen Seitenkontext und kontrollieren Sie Änderungen durch einen erneuten Audit." : "Keine fehlgeschlagenen Prüfungen in den übergebenen Daten. Das ist kein Nachweis einer fehlerfreien Website; Umfang und Vollständigkeit müssen geprüft werden.") : "Der Live-Scan ist nicht bestätigt oder wurde durch Fallback-Daten ersetzt. Vor technischen Entscheidungen ist ein erfolgreicher Scan erforderlich."}</p>
  <h2>Umfang und Aussagekraft</h2><p>Momentaufnahme der angegebenen URL. HTML-Prüfungen erkennen nicht alle dynamischen Inhalte. Bestätigte Beobachtungen gelten nur innerhalb der jeweiligen Prüfmethode; Auswirkungen auf Umsatz, Ranking oder rechtliche Konformität wurden nicht nachgewiesen.</p><p class="note">Prioritäten stammen aus dem Scanner. Empfehlungen sind nächste Prüfschritte; ihre Wirksamkeit muss nach Umsetzung gemessen werden. Nur strukturierte Scanner-Belege werden exportiert; diese können englischsprachig sein. Freitext, interne Metadaten und URL-Pfade, Zugangsdaten, Parameter sowie Fragmente werden aus Datenschutzgründen ausgelassen.</p>
  <h2>Empfohlener Ablauf</h2><p>1. Beobachtungen und manuelle Hinweise verifizieren.<br>2. Korrekturen nach Priorität und Aufwand planen.<br>3. Änderungen testen und einen Vergleichsaudit durchführen.</p>
  <section class="section"><h2>Bestätigte Beobachtungen</h2>${cards(confirmed) || "<p>Keine bestätigten Beobachtungen verfügbar.</p>"}<h2>Hinweise und Annahmen</h2><p class="note">Diese Hinweise sind keine bestätigten Mängel. Dazu zählen heuristische Grenzwerte, unvollständige Daten und unbekannte Prüfungen.</p>${cards(uncertain) || "<p>Keine zusätzlichen Hinweise vorhanden.</p>"}</section>
  <section><h2>Leistungsdaten und Grenzen</h2>${metrics ? `<p>Verfügbare Lighthouse-Laborwerte; keine Felddaten realer Besucher.</p><table>${metrics}</table>` : "<p>Keine Lighthouse-Metriken gemessen bzw. im Bericht verfügbar. Fehlende Werte werden nicht geschätzt.</p>"}<p class="note">INP wird in diesem Laboraudit nicht gemessen. TBT ersetzt keinen INP-Feldwert.</p>${model.warnings.length ? `<h2>Einschränkungen des Scans</h2>${model.warnings.map((warning) => `<p class="warning">${escape(warning)}</p>`).join("")}` : ""}</section></body></html>`;
}

export async function exportClientAuditPdf(report, { outputPath, company } = {}) {
  if (!outputPath) throw new TypeError("outputPath ist erforderlich.");
  const html = renderClientAuditHtml(report, { company });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true, serviceWorkers: "block" });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    return await page.pdf({ path: outputPath, format: "A4", preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: '<div style="font-family:Arial;font-size:8px;color:#496274;width:100%;margin:0 17mm;display:flex;justify-content:space-between"><span>Sitepulse · Technischer Website-Audit · Vertraulich</span><span>Seite <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>' });
  } finally {
    await browser.close();
  }
}
