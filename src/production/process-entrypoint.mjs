import { applyProductionEnvironment } from "./process-environment.mjs";
import { loadBrowserSandboxAttestation } from "./browser-sandbox-attestation.mjs";

const serviceModules = {
  api: new URL("../../server.mjs", import.meta.url),
  worker: new URL("../../worker.mjs", import.meta.url),
  migrate: new URL("../../scripts/migrate.mjs", import.meta.url)
};

export async function runProductionService(service, {
  environment = process.env,
  loadSandboxAttestation = loadBrowserSandboxAttestation,
  loadService = (moduleUrl) => import(moduleUrl)
} = {}) {
  const sandboxAttestation = service === "worker" ? loadSandboxAttestation() : undefined;
  applyProductionEnvironment(service, environment, { sandboxAttestation });
  const moduleUrl = serviceModules[service];
  return loadService(moduleUrl);
}
