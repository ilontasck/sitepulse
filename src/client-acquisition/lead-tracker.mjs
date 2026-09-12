import { appendFile, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const leadColumns = [
  "company", "website", "industry", "contact_name", "contact_method", "contact_value",
  "finding_1", "finding_2", "finding_3", "audit_date", "contacted_at", "status", "follow_up_at", "result", "revenue"
];

function csvCell(value) {
  const text = String(value ?? "");
  const safeText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

export function createLeadRecord({ miniAudit, company = "", industry = "", contactName = "", contactMethod = "", contactValue = "", status = "AUDITED" }) {
  return {
    company, website: miniAudit.normalizedUrl || miniAudit.website, industry, contact_name: contactName,
    contact_method: contactMethod, contact_value: contactValue,
    finding_1: miniAudit.findings[0]?.title || "", finding_2: miniAudit.findings[1]?.title || "", finding_3: miniAudit.findings[2]?.title || "",
    audit_date: new Date().toISOString(), contacted_at: "", status, follow_up_at: "", result: "", revenue: ""
  };
}

export function serializeLead(record) {
  return `${leadColumns.map((column) => csvCell(record[column])).join(",")}\n`;
}

export async function appendLeadRecord(filePath, record) {
  const absolute = resolve(filePath);
  const header = `${leadColumns.join(",")}\n`;
  await mkdir(dirname(absolute), { recursive: true });
  try {
    const handle = await open(absolute, "wx");
    await handle.writeFile(header, "utf8");
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await appendFile(absolute, serializeLead(record), { encoding: "utf8", flag: "a" });
  return absolute;
}
