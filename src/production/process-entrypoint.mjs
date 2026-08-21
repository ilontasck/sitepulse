import { applyProductionEnvironment } from "./process-environment.mjs";

const serviceModules = {
  api: new URL("../../server.mjs", import.meta.url),
  worker: new URL("../../worker.mjs", import.meta.url),
  migrate: new URL("../../scripts/migrate.mjs", import.meta.url)
};

export async function runProductionService(service, {
  environment = process.env,
  loadService = (moduleUrl) => import(moduleUrl)
} = {}) {
  applyProductionEnvironment(service, environment);
  const moduleUrl = serviceModules[service];
  return loadService(moduleUrl);
}
