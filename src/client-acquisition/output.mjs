function escapeMarkdown(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
}

function safeDomain(value) {
  return String(value || "website").replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "website";
}

function plainText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export function renderMiniAuditMarkdown(miniAudit) {
  const lines = [
    `# Mini Website Audit — ${escapeMarkdown(miniAudit.website)}`,
    "",
    `Website: ${escapeMarkdown(miniAudit.normalizedUrl || miniAudit.website)}`,
    "",
    "This is a preliminary automated technical check, not a full audit.",
    ""
  ];

  if (!miniAudit.findings.length) {
    lines.push("No finding with sufficient evidence was selected for the sales summary.", "");
  }
  miniAudit.findings.forEach((finding, index) => {
    lines.push(
      `## Finding ${index + 1} — ${escapeMarkdown(finding.severity)}`,
      "",
      `**${escapeMarkdown(finding.title)}**`,
      "",
      escapeMarkdown(finding.explanation),
      "",
      `- Category: ${escapeMarkdown(finding.category)}`,
      `- Page: ${escapeMarkdown(finding.affectedUrl || "Not available")}`,
      `- Evidence: ${escapeMarkdown(finding.evidence)}`,
      `- Recommended direction: ${escapeMarkdown(finding.recommendation)}`,
      ""
    );
  });
  if (miniAudit.additionalFindings > 0) {
    lines.push(`### Additional findings`, "", `${miniAudit.additionalFindings} additional potential issues were detected during the initial review.`, "");
  }
  if (miniAudit.warnings.length) {
    lines.push("### Audit limitations", "", ...miniAudit.warnings.map((warning) => `- ${escapeMarkdown(warning)}`), "");
  }
  lines.push("### Recommended next step", "", `Prepare a ${escapeMarkdown(miniAudit.recommendation)} after manually verifying each finding.`, "");
  return `${lines.join("\n")}\n`;
}

export function renderOutreachSnippet(miniAudit) {
  const bullets = miniAudit.findings.length
    ? miniAudit.findings.map((finding) => `• ${plainText(finding.title)} (${plainText(finding.severity)}): ${plainText(finding.evidence)}`).join("\n")
    : "• В автоматической предварительной проверке не найдено подтверждённых пунктов с достаточным evidence.";
  return `Hallo,\n\nich habe die Website ${plainText(miniAudit.website)} kurz automatisiert geprüft und dabei folgende Punkte gefunden:\n\n${bullets}\n\nDas ist eine kurze technische Vorprüfung, kein vollständiger Audit. Wenn Sie möchten, kann ich daraus einen vollständigen Website Audit & QA für €99 erstellen.\n\nViele Grüße\n`;
}

export function outputBasename(miniAudit) {
  return `${safeDomain(miniAudit.website)}-mini-audit`;
}
