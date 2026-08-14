import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionCookiePolicy } from "../src/http/session-cookie.mjs";

const token = Buffer.alloc(32, 7).toString("base64url");
const expiresAt = "2026-08-28T10:00:00.000Z";

describe("session cookie policy", () => {
  it("serializes a host-only secure production cookie", () => {
    const policy = createSessionCookiePolicy({ publicOrigin: "https://sitepulse.example" });
    const header = policy.serialize(token, expiresAt);

    assert.equal(policy.name, "__Host-sitepulse_session");
    assert.match(header, /^__Host-sitepulse_session=/);
    assert.match(header, /Path=\//);
    assert.match(header, /HttpOnly/);
    assert.match(header, /Secure/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Max-Age=1209600/);
    assert.match(header, /Expires=Fri, 28 Aug 2026 10:00:00 GMT/);
    assert.doesNotMatch(header, /Domain=/i);
    assert.match(policy.clear(), /Secure/);
    assert.doesNotMatch(policy.clear(), /Domain=/i);
  });

  it("uses the localhost-compatible development cookie and matching clear attributes", () => {
    const policy = createSessionCookiePolicy({ publicOrigin: "http://localhost:3000" });
    const header = policy.serialize(token, expiresAt);
    const cleared = policy.clear();

    assert.equal(policy.name, "sitepulse_session");
    assert.doesNotMatch(header, /Secure/);
    assert.match(cleared, /^sitepulse_session=;/);
    assert.match(cleared, /Path=\//);
    assert.match(cleared, /HttpOnly/);
    assert.match(cleared, /SameSite=Lax/);
    assert.match(cleared, /Max-Age=0/);
    assert.doesNotMatch(cleared, /Secure/);
  });

  it("parses one canonical token and rejects malformed, oversized, or duplicate cookies", () => {
    const policy = createSessionCookiePolicy({ publicOrigin: "http://localhost:3000" });

    assert.equal(policy.parse(`other=value; sitepulse_session=${token}`), token);
    assert.equal(policy.parse(`sitepulse_session=${token}; sitepulse_session=${token}`), null);
    assert.equal(policy.parse("sitepulse_session=malformed"), null);
    assert.equal(policy.parse(`sitepulse_session=${token}${"x".repeat(9_000)}`), null);
    assert.equal(policy.parse(undefined), null);
  });
});
