#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLegalConfig } from "../src/legal/legal-config.mjs";
import {
  LEGAL_TEMPLATE_BLOCKS,
  LEGAL_TEMPLATE_TOKENS,
  renderLegalTemplate
} from "../src/legal/legal-renderer.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const legalTemplateFiles = Object.freeze(["privacy.html", "impressum.html", "terms.html"]);
const oldMarkerPattern = /\[REQUIRED BEFORE PUBLIC LAUNCH:[^\]]+\]/gu;
const directivePattern = /\{\{([#/])?([A-Z0-9_]+)\}\}/gu;

export function inspectLegalTemplate(content) {
  const oldMarkers = [...content.matchAll(oldMarkerPattern)].map(([match]) => match);
  const unknownDirectives = [];
  for (const [directive, marker, name] of content.matchAll(directivePattern)) {
    const allowed = marker
      ? LEGAL_TEMPLATE_BLOCKS.includes(name)
      : LEGAL_TEMPLATE_TOKENS.includes(name);
    if (!allowed) unknownDirectives.push(directive);
  }
  const recognizedContent = content.replace(directivePattern, "");
  if (recognizedContent.includes("{{") || recognizedContent.includes("}}")) {
    unknownDirectives.push("malformed template directive");
  }
  return { oldMarkers, unknownDirectives };
}

export async function checkLegalReadiness(environment = process.env) {
  const config = createLegalConfig(environment);
  const results = [];
  for (const filename of legalTemplateFiles) {
    const content = await readFile(join(root, filename), "utf8");
    const inspection = inspectLegalTemplate(content);
    let renderError = null;
    try {
      renderLegalTemplate(content, config);
    } catch (error) {
      renderError = error.message;
    }
    results.push({ filename, ...inspection, renderError });
  }
  const templatesValid = results.every(({ oldMarkers, unknownDirectives, renderError }) =>
    oldMarkers.length === 0 && unknownDirectives.length === 0 && !renderError
  );
  return {
    ready: templatesValid && config.publicationReady,
    templatesValid,
    publicationReady: config.publicationReady,
    missingRequiredFields: config.missingRequiredFields,
    results
  };
}

async function main() {
  const report = await checkLegalReadiness();
  for (const result of report.results) {
    if (result.oldMarkers.length || result.unknownDirectives.length || result.renderError) {
      console.error(`FAIL ${result.filename}: old=${result.oldMarkers.length}, unknown=${result.unknownDirectives.length}${result.renderError ? `, render=${result.renderError}` : ""}`);
    } else {
      console.log(`OK   ${result.filename}: template variables are resolved by the allowlisted renderer`);
    }
  }
  if (!report.publicationReady) {
    console.error("Legal publication gate is closed: LEGAL_PUBLICATION_READY is false.");
    console.error(`Runtime values still required: ${report.missingRequiredFields.join(", ") || "none"}`);
  }
  if (!report.ready) process.exitCode = 1;
  else console.log("Legal readiness check passed: templates and public runtime configuration are ready.");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
