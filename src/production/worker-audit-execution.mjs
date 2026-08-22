import { createAuditRunnerClient } from "../audit/audit-runner-client.mjs";
import { normalizeWebsiteUrl } from "../audit/url-validation.mjs";

export async function resolveWorkerAuditExecution(config, {
  runnerClient = createAuditRunnerClient({
    socketPath: config.auditRunnerSocketPath,
    requestTimeoutMs: Math.max((config.renderedAuditTimeoutMs || 45_000) + 15_000, 60_000)
  }),
  loadLocalAuditGenerator = () => import("../audit/audit-engine.mjs")
} = {}) {
  if (config.env === "production") {
    return {
      auditGenerator: (url, options) => runnerClient.generateAudit(url, options),
      executorReadiness: async () => {
        const readiness = await runnerClient.checkReadiness();
        if (config.renderedAuditEnabled && readiness.renderedAuditAllowed !== true) {
          return { ready: false };
        }
        return readiness;
      },
      securityValidator: async (url) => normalizeWebsiteUrl(url)
    };
  }

  const localModule = await loadLocalAuditGenerator();
  const localGenerator = typeof localModule === "function" ? localModule : localModule.generateAudit;
  if (typeof localGenerator !== "function") {
    throw new TypeError("Local audit execution requires generateAudit().");
  }
  return {
    auditGenerator: localGenerator,
    executorReadiness: async () => ({ ready: true }),
    securityValidator: undefined
  };
}
