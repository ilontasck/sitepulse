export const migration009PlansQuotas = {
  version: 9,
  name: "plans and monthly audit quotas",
  up(database) {
    database.exec(`
      ALTER TABLE users ADD COLUMN plan_code TEXT NOT NULL DEFAULT 'free'
        CHECK (plan_code IN ('free', 'pro'));

      ALTER TABLE audit_jobs ADD COLUMN plan_code_snapshot TEXT NOT NULL DEFAULT 'free'
        CHECK (plan_code_snapshot IN ('free', 'pro'));
      ALTER TABLE audit_jobs ADD COLUMN quota_period_start TEXT;
      ALTER TABLE audit_jobs ADD COLUMN quota_charged INTEGER NOT NULL DEFAULT 0
        CHECK (quota_charged IN (0, 1));

      CREATE TABLE audit_monthly_usage (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period_start TEXT NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
        PRIMARY KEY (user_id, period_start)
      );

      CREATE INDEX idx_audit_monthly_usage_period
        ON audit_monthly_usage (period_start, user_id);
      CREATE INDEX idx_audit_jobs_quota_charge
        ON audit_jobs (user_id, quota_period_start)
        WHERE quota_charged = 1;
    `);
  }
};
