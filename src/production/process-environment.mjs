const productionDatabaseFilePath = "/var/lib/noqori/sitepulse.sqlite";
const supportedServices = new Set(["api", "worker", "migrate"]);

export class ProductionConfigurationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ProductionConfigurationError";
    this.code = code;
  }
}

export function applyProductionEnvironment(service, environment = process.env, { sandboxAttestation } = {}) {
  if (!supportedServices.has(service)) {
    throw new ProductionConfigurationError("Unknown NOQORI production service.", "UNKNOWN_PRODUCTION_SERVICE");
  }

  const renderedRequested = service === "worker" &&
    String(environment.RENDERED_AUDIT_ENABLED || "false").toLowerCase() === "true";
  if (service === "worker" && sandboxAttestation?.valid !== true) {
    throw new ProductionConfigurationError(
      "The production audit sandbox attestation is missing or invalid.",
      "AUDIT_SANDBOX_REQUIRED"
    );
  }
  if (renderedRequested && sandboxAttestation?.vmAcceptancePassed !== true) {
    throw new ProductionConfigurationError(
      "Rendered audits require successful Linux VM acceptance.",
      "RENDERED_AUDIT_REQUIRES_VM_ACCEPTANCE"
    );
  }

  environment.NODE_ENV = "production";
  environment.HOST = "127.0.0.1";
  environment.DATABASE_FILE_PATH = productionDatabaseFilePath;
  environment.MIGRATIONS_MANAGED_EXTERNALLY = "true";
  environment.RENDERED_AUDIT_ENABLED = renderedRequested ? "true" : "false";
  environment.RENDERED_AUDIT_MAX_CONCURRENCY = "1";
  environment.AUDIT_RUNNER_SOCKET_PATH = "/run/noqori-audit.sock";

  return {
    databaseFilePath: environment.DATABASE_FILE_PATH,
    migrationsManagedExternally: environment.MIGRATIONS_MANAGED_EXTERNALLY === "true",
    renderedAuditEnabled: environment.RENDERED_AUDIT_ENABLED === "true",
    renderedAuditMaxConcurrency: Number(environment.RENDERED_AUDIT_MAX_CONCURRENCY)
  };
}
