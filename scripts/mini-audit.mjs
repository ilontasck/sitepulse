#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { generateAudit } from "../src/audit/audit-engine.mjs";
import { createRenderedAuditLimiter } from "../src/audit/rendered-audit-limiter.mjs";
import {
  exportClientAuditPdf,
  appendLeadRecord,
  createLeadRecord,
  createMiniAudit,
  outputBasename,
  renderMiniAuditMarkdown,
  renderOutreachSnippet
} from "../src/client-acquisition/index.mjs";

import { prepareClientReport } from "../src/client-acquisition/client-report-data.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const safeCliErrorCodes = new Set([
  "URL_REQUIRED", "URL_TOO_LONG", "INVALID_URL", "UNSUPPORTED_URL_PROTOCOL",
  "INVALID_PUBLIC_DOMAIN", "UNSAFE_URL", "HOSTNAME_NOT_RESOLVED", "UNSAFE_REDIRECT", "HTML_TOO_LARGE"
]);

export function parseMiniAuditArgs(argv) {
  const positional = [];
  const options = { outreach: true, lead: false, rendered: false, findings: 3 };
  const valueOptions = new Map([
    ["--from-json", "fromJson"], ["--company", "company"], ["--industry", "industry"], ["--contact-name", "contactName"],
    ["--contact-method", "contactMethod"], ["--contact-value", "contactValue"], ["--status", "status"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pdf") options.pdf = true;
    else if (arg === "--no-outreach") options.outreach = false;
    else if (arg === "--lead") options.lead = true;
    else if (arg === "--rendered") options.rendered = true;
    else if (arg === "--findings") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 3 || value > 5) throw new Error("--findings must be an integer between 3 and 5.");
      options.findings = value;
    }
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (valueOptions.has(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value.`);
      options[valueOptions.get(arg)] = value;
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (!options.help && (options.fromJson ? positional.length !== 0 : positional.length !== 1)) throw new Error("Usage: pnpm mini-audit <public-url> [options]");
  if (options.fromJson && options.rendered) throw new Error("--from-json cannot be combined with --rendered.");
  if (options.pdf || options.fromJson) options.outreach = false;
  if (options.fromJson) options.pdf = true;
  return { ...options, url: positional[0] || null };
}

export async function runMiniAudit(args, dependencies = {}) {
  const auditGenerator = dependencies.auditGenerator || generateAudit;
  let report;
  if (args.fromJson) {
    if ((await stat(args.fromJson)).size > 5_000_000) throw new Error("Scanner JSON exceeds the 5 MB export limit.");
    try {
      report = JSON.parse(await readFile(args.fromJson, "utf8"));
    } catch {
      throw new Error("Scanner JSON could not be read or is invalid.");
    }
  } else try {
    report = await auditGenerator(args.url, {
      renderedAuditEnabled: args.rendered === true,
      renderedAuditLimiter: args.rendered ? (dependencies.renderedAuditLimiter || createRenderedAuditLimiter(1)) : undefined
    });
  } catch (error) {
    if (safeCliErrorCodes.has(error?.code)) throw error;
    report = null;
  }
  if (args.pdf || args.fromJson) {
    // Validate and project every companion artifact and CLI message onto public fields.
    report = prepareClientReport(report);
  }
  const miniAudit = createMiniAudit(report, { inputUrl: args.pdf || args.fromJson ? null : args.url, limit: args.findings || 3 });
  const basename = outputBasename(miniAudit);
  const outputRoot = dependencies.projectRoot || projectRoot;
  const reportsDirectory = join(outputRoot, "reports", "leads");
  const outreachDirectory = join(outputRoot, "outreach");
  await mkdir(reportsDirectory, { recursive: true });
  const reportPath = join(reportsDirectory, `${basename}.md`);
  await writeFile(reportPath, renderMiniAuditMarkdown(miniAudit), "utf8");
  let pdfPath = null;
  let jsonPath = null;
  if (args.pdf || args.fromJson) {
    pdfPath = join(reportsDirectory, `${basename}.pdf`);
    await exportClientAuditPdf(report, { outputPath: pdfPath, company: args.company });
    jsonPath = join(reportsDirectory, `${basename}.json`);
    await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  }
  let outreachPath = null;
  if (args.outreach && !args.pdf && !args.fromJson) {
    await mkdir(outreachDirectory, { recursive: true });
    outreachPath = join(outreachDirectory, `${basename}.txt`);
    await writeFile(outreachPath, renderOutreachSnippet(miniAudit), "utf8");
  }
  let leadPath = null;
  if (args.lead) {
    leadPath = await appendLeadRecord(join(outputRoot, "data", "leads.csv"), createLeadRecord({ miniAudit, ...args }));
  }
  return { miniAudit, reportPath, pdfPath, jsonPath, outreachPath, leadPath };
}

function printHelp() {
  console.log("Usage: pnpm mini-audit <public-url> [--findings 3|4|5] [--rendered] [--no-outreach] [--lead] [--company name] [--industry type] [--contact-name name] [--contact-method method] [--contact-value value] [--status STATUS]");
  console.log("PDF: pnpm mini-audit <public-url> --pdf --company name OR pnpm mini-audit --from-json saved-report.json --company name (offline, no scan). PDF mode creates no outreach draft.");
  console.log("Runs the existing safe audit pipeline and writes an internal Markdown mini-audit. No message is sent.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseMiniAuditArgs(process.argv.slice(2));
    if (args.help) printHelp();
    else {
      const result = await runMiniAudit(args);
      console.log(`Website: ${result.miniAudit.website}`);
      result.miniAudit.findings.forEach((finding, index) => console.log(`${index + 1}. ${finding.severity} — ${finding.title}\n   Evidence: ${finding.evidence}`));
      console.log(`Report: ${result.reportPath}`);
      if (result.pdfPath) console.log(`Client PDF: ${result.pdfPath}`);
      if (result.jsonPath) console.log(`Scanner JSON: ${result.jsonPath}`);
      if (result.outreachPath) console.log(`Outreach draft: ${result.outreachPath}`);
      if (result.leadPath) console.log(`Lead tracker: ${result.leadPath}`);
      console.log("No message was sent.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Mini-audit failed safely.");
    process.exitCode = 1;
  }
}
