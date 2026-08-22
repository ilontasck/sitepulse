import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 8_000
  },
  use: {
    baseURL: "http://127.0.0.1:3010",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node server.mjs",
    env: {
      HOST: "127.0.0.1",
      PORT: "3010",
      NODE_ENV: "test",
      AUTH_REGISTRATION_MODE: "public",
      DATABASE_FILE_PATH: "./data/e2e-sitepulse.sqlite",
      RATE_LIMIT_MAX: "200"
    },
    reuseExistingServer: false,
    timeout: 10_000,
    url: "http://127.0.0.1:3010/api/health"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
