const requiredPublicFields = Object.freeze([
  "operatorName",
  "operatorAddressLine1",
  "operatorPostalCode",
  "operatorCity",
  "operatorCountry",
  "contactEmail",
  "publicationDate",
  "hostingProvider",
  "hostingCountry",
  "serverLocation",
  "processLogRetention",
  "auditReportRetention"
]);

const environmentFields = Object.freeze({
  operatorName: "LEGAL_OPERATOR_NAME",
  operatorAddressLine1: "LEGAL_OPERATOR_ADDRESS_LINE1",
  operatorPostalCode: "LEGAL_OPERATOR_POSTAL_CODE",
  operatorCity: "LEGAL_OPERATOR_CITY",
  operatorCountry: "LEGAL_OPERATOR_COUNTRY",
  contactEmail: "LEGAL_CONTACT_EMAIL",
  contactPhone: "LEGAL_CONTACT_PHONE",
  publicationDate: "LEGAL_PUBLICATION_DATE",
  hostingProvider: "LEGAL_HOSTING_PROVIDER",
  hostingCountry: "LEGAL_HOSTING_COUNTRY",
  serverLocation: "LEGAL_SERVER_LOCATION",
  processLogRetention: "LEGAL_PROCESS_LOG_RETENTION",
  auditReportRetention: "LEGAL_AUDIT_REPORT_RETENTION",
  vatId: "LEGAL_VAT_ID",
  registerName: "LEGAL_REGISTER_NAME",
  registerNumber: "LEGAL_REGISTER_NUMBER"
});

function parseReady(value) {
  const normalized = String(value ?? "false").toLowerCase();
  if (normalized !== "true" && normalized !== "false") {
    throw new Error("LEGAL_PUBLICATION_READY must be true or false.");
  }
  return normalized === "true";
}

function cleanValue(name, value) {
  const cleaned = String(value ?? "").trim();
  if (cleaned.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(cleaned)) {
    throw new Error(`${name} contains unsupported characters or is too long.`);
  }
  return cleaned;
}

export function createLegalConfig(environment = {}) {
  const publicationReady = parseReady(environment.LEGAL_PUBLICATION_READY);
  const production = environment.NODE_ENV === "production";
  const config = { publicationReady };
  for (const [field, variable] of Object.entries(environmentFields)) {
    config[field] = cleanValue(variable, environment[variable]);
  }

  const hasRegisterName = Boolean(config.registerName);
  const hasRegisterNumber = Boolean(config.registerNumber);
  if (hasRegisterName !== hasRegisterNumber) {
    throw new Error("LEGAL_REGISTER_NAME and LEGAL_REGISTER_NUMBER must be provided together.");
  }
  if (config.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(config.contactEmail)) {
    throw new Error("LEGAL_CONTACT_EMAIL must be a valid email address.");
  }
  if (config.publicationDate) {
    const parsedDate = new Date(`${config.publicationDate}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(config.publicationDate) ||
      !Number.isFinite(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== config.publicationDate
    ) {
      throw new Error("LEGAL_PUBLICATION_DATE must be a real date in YYYY-MM-DD format.");
    }
  }

  const missing = requiredPublicFields
    .filter((field) => !config[field])
    .map((field) => environmentFields[field]);
  if (publicationReady && missing.length > 0) {
    throw new Error(`LEGAL_PUBLICATION_READY requires: ${missing.join(", ")}.`);
  }
  if (production && !publicationReady) {
    throw new Error("Production requires LEGAL_PUBLICATION_READY=true and complete legal configuration.");
  }

  return Object.freeze({ ...config, missingRequiredFields: Object.freeze(missing) });
}

export { requiredPublicFields };
