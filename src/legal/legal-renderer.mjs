const draftValue = "Not configured — development draft";

export const LEGAL_TEMPLATE_BLOCKS = Object.freeze([
  "LEGAL_DRAFT", "LEGAL_READY", "LEGAL_PHONE", "LEGAL_REGISTER", "LEGAL_VAT"
]);

export const LEGAL_TEMPLATE_TOKENS = Object.freeze([
  "LEGAL_STATUS", "LEGAL_OPERATOR_NAME", "LEGAL_OPERATOR_ADDRESS",
  "LEGAL_OPERATOR_ADDRESS_LINE1", "LEGAL_OPERATOR_POSTAL_CITY",
  "LEGAL_OPERATOR_COUNTRY", "LEGAL_CONTACT_EMAIL", "LEGAL_CONTACT_PHONE",
  "LEGAL_PUBLICATION_DATE", "LEGAL_HOSTING_PROVIDER", "LEGAL_HOSTING_COUNTRY",
  "LEGAL_SERVER_LOCATION", "LEGAL_PROCESS_LOG_RETENTION",
  "LEGAL_AUDIT_REPORT_RETENTION", "LEGAL_VAT_ID", "LEGAL_REGISTER_NAME",
  "LEGAL_REGISTER_NUMBER"
]);

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function optionalBlock(template, name, visible) {
  const pattern = new RegExp(`\\{\\{#${name}\\}\\}([\\s\\S]*?)\\{\\{/${name}\\}\\}`, "gu");
  return template.replace(pattern, visible ? "$1" : "");
}

export function renderLegalTemplate(template, legalConfig) {
  if (!legalConfig) throw new TypeError("Legal configuration is required.");
  let rendered = template;
  if (legalConfig.publicationReady) {
    rendered = rendered.replace(
      /<div class="nqLegalNote" data-tone="review" role="note">[\s\S]*?<\/div>/gu,
      ""
    );
  }
  rendered = optionalBlock(rendered, "LEGAL_DRAFT", !legalConfig.publicationReady);
  rendered = optionalBlock(rendered, "LEGAL_READY", legalConfig.publicationReady);
  rendered = optionalBlock(rendered, "LEGAL_PHONE", Boolean(legalConfig.contactPhone));
  rendered = optionalBlock(rendered, "LEGAL_REGISTER", Boolean(legalConfig.registerName && legalConfig.registerNumber));
  rendered = optionalBlock(rendered, "LEGAL_VAT", Boolean(legalConfig.vatId));

  const address = [
    legalConfig.operatorAddressLine1,
    [legalConfig.operatorPostalCode, legalConfig.operatorCity].filter(Boolean).join(" "),
    legalConfig.operatorCountry
  ].filter(Boolean).join(", ");
  const values = {
    LEGAL_STATUS: legalConfig.publicationReady ? "Published" : "Draft — not approved for public launch",
    LEGAL_OPERATOR_NAME: legalConfig.operatorName,
    LEGAL_OPERATOR_ADDRESS: address,
    LEGAL_OPERATOR_ADDRESS_LINE1: legalConfig.operatorAddressLine1,
    LEGAL_OPERATOR_POSTAL_CITY: [legalConfig.operatorPostalCode, legalConfig.operatorCity].filter(Boolean).join(" "),
    LEGAL_OPERATOR_COUNTRY: legalConfig.operatorCountry,
    LEGAL_CONTACT_EMAIL: legalConfig.contactEmail,
    LEGAL_CONTACT_PHONE: legalConfig.contactPhone,
    LEGAL_PUBLICATION_DATE: legalConfig.publicationDate,
    LEGAL_HOSTING_PROVIDER: legalConfig.hostingProvider,
    LEGAL_HOSTING_COUNTRY: legalConfig.hostingCountry,
    LEGAL_SERVER_LOCATION: legalConfig.serverLocation,
    LEGAL_PROCESS_LOG_RETENTION: legalConfig.processLogRetention,
    LEGAL_AUDIT_REPORT_RETENTION: legalConfig.auditReportRetention,
    LEGAL_VAT_ID: legalConfig.vatId,
    LEGAL_REGISTER_NAME: legalConfig.registerName,
    LEGAL_REGISTER_NUMBER: legalConfig.registerNumber
  };

  rendered = rendered.replace(/\{\{([A-Z0-9_]+)\}\}/gu, (_match, token) => {
    if (!Object.hasOwn(values, token)) throw new Error(`Unknown legal template variable: ${token}.`);
    return escapeHtml(values[token] || draftValue);
  });
  if (rendered.includes("{{") || rendered.includes("}}")) {
    throw new Error("Unresolved legal template directive.");
  }
  return rendered;
}
