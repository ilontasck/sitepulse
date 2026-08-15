#!/usr/bin/env node
/**
 * NOQORI — Legal Placeholder Checker
 *
 * Scans the legal HTML pages for unresolved [REQUIRED BEFORE PUBLIC LAUNCH: …]
 * placeholders. Exits with code 0 if none are found (ready for public launch),
 * or code 1 with a detailed report if any remain.
 *
 * Usage:
 *   node scripts/check-legal-placeholders.mjs
 *
 * Integrate into pre-launch CI:
 *   node scripts/check-legal-placeholders.mjs || { echo "Legal pages not ready"; exit 1; }
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const LEGAL_PAGES = [
  "privacy.html",
  "impressum.html",
  "terms.html"
];

// Matches [REQUIRED BEFORE PUBLIC LAUNCH: any description text]
const PLACEHOLDER_PATTERN = /\[REQUIRED BEFORE PUBLIC LAUNCH:[^\]]+\]/g;

async function checkFile(filename) {
  const path = join(root, filename);
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { filename, error: `Could not read file: ${path}`, matches: [] };
  }

  const matches = [...content.matchAll(PLACEHOLDER_PATTERN)].map(m => m[0]);
  return { filename, error: null, matches };
}

async function main() {
  const results = await Promise.all(LEGAL_PAGES.map(checkFile));

  let totalPlaceholders = 0;
  let hasErrors = false;

  for (const { filename, error, matches } of results) {
    if (error) {
      console.error(`\n  ERROR  ${filename}\n         ${error}`);
      hasErrors = true;
      continue;
    }
    if (matches.length === 0) {
      console.log(`  OK     ${filename} — no unresolved placeholders`);
    } else {
      console.log(`\n  FAIL   ${filename} — ${matches.length} unresolved placeholder(s):`);
      for (const m of matches) {
        console.log(`           ${m}`);
      }
      totalPlaceholders += matches.length;
    }
  }

  console.log("");

  if (hasErrors) {
    console.error("Legal readiness check failed: one or more files could not be read.");
    process.exit(1);
  }

  if (totalPlaceholders > 0) {
    console.error(
      `Legal readiness check FAILED: ${totalPlaceholders} placeholder(s) must be resolved before public launch.\n` +
      `See docs/LEGAL_READINESS.md for the full checklist.`
    );
    process.exit(1);
  }

  console.log("Legal readiness check passed: no unresolved placeholders found.");
  process.exit(0);
}

main();
