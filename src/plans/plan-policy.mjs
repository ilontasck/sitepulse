const policies = Object.freeze({
  guest: Object.freeze({ planCode: "guest", active: false, dailyAuditLimit: 1, renderedAuditEligible: false, history: "none" }),
  free: Object.freeze({ planCode: "free", active: true, monthlyAuditLimit: 3, renderedAuditEligible: true, history: "persistent", retention: "30 days" }),
  pro: Object.freeze({ planCode: "pro", active: true, monthlyAuditLimit: 25, renderedAuditEligible: true, history: "persistent", retention: "12 calendar months" })
});

export function getPlanPolicy(planCode) {
  const policy = policies[planCode];
  if (!policy) throw new TypeError("Unknown plan code.");
  return policy;
}

export function getQuotaPeriod(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Quota clock must be valid.");
  return {
    startsAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString(),
    resetsAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString()
  };
}

export function reportExpiryForPlan(planCode, value) {
  const createdAt = new Date(value);
  if (Number.isNaN(createdAt.getTime())) throw new TypeError("Report creation time must be valid.");
  if (planCode === "free") return new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  getPlanPolicy(planCode);
  const year = createdAt.getUTCFullYear() + 1;
  const month = createdAt.getUTCMonth();
  const day = Math.min(createdAt.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return new Date(Date.UTC(year, month, day, createdAt.getUTCHours(), createdAt.getUTCMinutes(), createdAt.getUTCSeconds(), createdAt.getUTCMilliseconds())).toISOString();
}
