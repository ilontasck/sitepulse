const productionDatabaseFilePath = "/var/lib/noqori/sitepulse.sqlite";
const supportedServices = new Set(["api", "worker", "migrate"]);

export class ProductionConfigurationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ProductionConfigurationError";
    this.code = code;
  }
}

export function applyProductionEnvironment(service, environment = process.env) {
  if (!supportedServices.has(service)) {
    throw new ProductionConfigurationError("Unknown NOQORI production service.", "UNKNOWN_PRODUCTION_SERVICE");
  }

  if (String(environment.RENDERED_AUDIT_ENABLED || "false").toLowerCase() === "true") {
    throw new ProductionConfigurationError(
      "Rendered audits are disabled until the STE-12 browser sandbox is deployed.",
      "RENDERED_AUDIT_REQUIRES_STE12"
    );
  }

  environment.NODE_ENV = "production";
  environment.HOST = "127.0.0.1";
  environment.DATABASE_FILE_PATH = productionDatabaseFilePath;
  environment.MIGRATIONS_MANAGED_EXTERNALLY = "true";
  environment.RENDERED_AUDIT_ENABLED = "false";
  environment.RENDERED_AUDIT_MAX_CONCURRENCY = "1";

  return {
    databaseFilePath: environment.DATABASE_FILE_PATH,
    migrationsManagedExternally: environment.MIGRATIONS_MANAGED_EXTERNALLY === "true",
    renderedAuditEnabled: environment.RENDERED_AUDIT_ENABLED === "true",
    renderedAuditMaxConcurrency: Number(environment.RENDERED_AUDIT_MAX_CONCURRENCY)
  };
}
