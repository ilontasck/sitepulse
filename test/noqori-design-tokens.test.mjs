import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const moduleFiles = ["module-01.css", "module-03.css", "module-04.css", "module-05.css", "module-06.css"];
const styles = new Map(await Promise.all(moduleFiles.map(async (fileName) => [
  fileName,
  await readFile(new URL(`../assets/noqori/${fileName}`, import.meta.url), "utf8")
])));
const indexSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const registrySource = styles.get("module-01.css").match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
const registry = new Map([...registrySource.matchAll(/(--nq-[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));

describe("NOQORI design token registry", () => {
  it("defines the shared color, semantic, type, spacing, radius, shadow, glass, and motion contracts", () => {
    const requiredTokens = [
      "--nq-canvas", "--nq-ink", "--nq-graphite", "--nq-silver", "--nq-ember",
      "--nq-surface", "--nq-surface-strong", "--nq-dark-surface", "--nq-print-surface",
      "--nq-good-text", "--nq-good-signal", "--nq-good-border", "--nq-good-surface",
      "--nq-warning-text", "--nq-warning-signal", "--nq-warning-border", "--nq-warning-surface",
      "--nq-critical-text", "--nq-critical-signal", "--nq-critical-border", "--nq-critical-surface",
      "--nq-unavailable-text", "--nq-unavailable-signal", "--nq-unavailable-border", "--nq-unavailable-surface",
      "--nq-type-label", "--nq-type-meta", "--nq-type-body", "--nq-type-heading",
      "--nq-space-1", "--nq-space-4", "--nq-space-8",
      "--nq-radius-control", "--nq-radius-card", "--nq-radius-panel", "--nq-radius-mobile", "--nq-radius-pill",
      "--nq-shadow-soft", "--nq-shadow-control", "--nq-glass", "--nq-glass-highlight",
      "--nq-motion-instant", "--nq-motion-fast", "--nq-motion-base", "--nq-motion-slow",
      "--nq-motion-reveal", "--nq-motion-crossfade", "--nq-motion-panel", "--nq-motion-settle",
      "--nq-motion-scene", "--nq-motion-stage"
    ];

    assert.deepEqual(requiredTokens.filter((token) => !registry.has(token)), []);
  });

  it("keeps raw hexadecimal colors inside the module-01 registry only", () => {
    const violations = [];
    for (const [fileName, source] of styles) {
      const productSource = fileName === "module-01.css" ? source.replace(/:root\s*\{[\s\S]*?\}/, "") : source;
      for (const match of productSource.matchAll(/#[\da-f]{3,8}\b/gi)) {
        violations.push(`${fileName}:${source.slice(0, match.index).split("\n").length}:${match[0]}`);
      }
    }

    assert.deepEqual(violations, []);
  });

  it("defines every referenced NOQORI custom property and contains no self-referencing token", () => {
    const source = [...styles.values(), indexSource].join("\n");
    const definitions = new Set([...source.matchAll(/(--nq-[\w-]+)\s*:/g)].map((match) => match[1]));
    const references = new Set([...source.matchAll(/var\((--nq-[\w-]+)/g)].map((match) => match[1]));

    assert.deepEqual([...references].filter((token) => !definitions.has(token)).sort(), []);
    assert.deepEqual([...registry].filter(([token, value]) => value.includes(`var(${token})`)), []);
  });

  it("routes fixed product typography through the shared type scale", () => {
    const violations = [];
    for (const [fileName, source] of styles) {
      const productSource = fileName === "module-01.css" ? source.replace(/:root\s*\{[\s\S]*?\}/, "") : source;
      for (const match of productSource.matchAll(/font-size\s*:\s*([^;]+);/g)) {
        const value = match[1].trim();
        if (!/^(?:var\(|clamp\(|inherit$)/.test(value)) violations.push(`${fileName}: font-size: ${value}`);
      }
      for (const match of productSource.matchAll(/font\s*:\s*([^;]+);/g)) {
        if (/\b\d*\.?\d+(?:rem|px|pt)\b/.test(match[1])) violations.push(`${fileName}: font: ${match[1].trim()}`);
      }
    }

    assert.deepEqual(violations, []);
  });

  it("uses shared type and motion tokens in every product CSS module", () => {
    const missingUsage = [];
    const rawMotion = [];
    for (const [fileName, source] of styles) {
      const productSource = fileName === "module-01.css" ? source.replace(/:root\s*\{[\s\S]*?\}/, "") : source;
      if (!productSource.includes("var(--nq-type-")) missingUsage.push(`${fileName}: type`);
      if (!productSource.includes("var(--nq-motion-")) missingUsage.push(`${fileName}: motion`);
      for (const match of productSource.matchAll(/\b\d+(?:\.\d+)?ms\b/g)) {
        if (match[0] !== "0.01ms") rawMotion.push(`${fileName}: ${match[0]}`);
      }
    }

    assert.deepEqual(missingUsage, []);
    assert.deepEqual(rawMotion, []);
  });
});
