import { buildAuditReport } from "./report-generator.mjs";
import { scanWebsite } from "./scanner-service.mjs";
import { calculateOverallScore, scoreStatus } from "./scoring.mjs";
import { normalizeWebsiteUrl } from "./url-validation.mjs";

export { calculateOverallScore, scoreStatus };

export async function generateAudit(inputUrl, options = {}) {
  const target = normalizeWebsiteUrl(inputUrl);
  const scanResult = await scanWebsite(target, options);

  return buildAuditReport(scanResult);
}
