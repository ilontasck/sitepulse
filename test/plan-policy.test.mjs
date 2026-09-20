import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPlanPolicy, getQuotaPeriod, reportExpiryForPlan } from "../src/plans/plan-policy.mjs";

describe("plan policy", () => {
  it("defines the beta free and internal pro limits", () => {
    assert.deepEqual(getPlanPolicy("guest"), {
      planCode: "guest", active: false, dailyAuditLimit: 1, renderedAuditEligible: false, history: "none"
    });
    assert.equal(getPlanPolicy("free").monthlyAuditLimit, 3);
    assert.equal(getPlanPolicy("pro").monthlyAuditLimit, 25);
  });

  it("uses UTC calendar months for quota periods", () => {
    assert.deepEqual(getQuotaPeriod("2026-12-31T23:59:59.000Z"), {
      startsAt: "2026-12-01T00:00:00.000Z",
      resetsAt: "2027-01-01T00:00:00.000Z"
    });
  });

  it("handles month length and leap-year reset boundaries", () => {
    assert.equal(getQuotaPeriod("2028-02-29T23:59:59.999Z").resetsAt, "2028-03-01T00:00:00.000Z");
    assert.equal(getQuotaPeriod("2026-04-30T23:59:59.999Z").resetsAt, "2026-05-01T00:00:00.000Z");
    assert.equal(getQuotaPeriod("2026-05-01T00:00:00.000Z").startsAt, "2026-05-01T00:00:00.000Z");
  });

  it("uses 30 days for free retention and 12 calendar months for pro", () => {
    assert.equal(reportExpiryForPlan("free", "2026-01-31T12:00:00.000Z"), "2026-03-02T12:00:00.000Z");
    assert.equal(reportExpiryForPlan("pro", "2024-02-29T12:00:00.000Z"), "2025-02-28T12:00:00.000Z");
  });
});
