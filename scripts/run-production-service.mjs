import { runProductionService } from "../src/production/process-entrypoint.mjs";
import { ProductionConfigurationError } from "../src/production/process-environment.mjs";

const service = process.argv[2];

try {
  await runProductionService(service);
} catch (error) {
  const knownConfigurationError = error instanceof ProductionConfigurationError;
  console.error(JSON.stringify({
    type: "noqori.startup",
    service: new Set(["api", "worker", "migrate"]).has(service) ? service : "unknown",
    status: "failed",
    code: knownConfigurationError ? error.code : "SERVICE_START_FAILED",
    message: knownConfigurationError ? error.message : "NOQORI service failed to start."
  }));
  process.exitCode = 1;
}
