import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

function decodeSessionToken(rawToken) {
  if (typeof rawToken !== "string" || !tokenPattern.test(rawToken)) {
    return null;
  }

  const decoded = Buffer.from(rawToken, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== rawToken) {
    return null;
  }
  return decoded;
}

export function generateSessionToken({ randomBytes = cryptoRandomBytes } = {}) {
  const tokenBytes = randomBytes(32);
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length !== 32) {
    throw new TypeError("Session token generator returned an invalid value.");
  }
  return tokenBytes.toString("base64url");
}

export function hashSessionToken(rawToken) {
  const tokenBytes = decodeSessionToken(rawToken);
  return tokenBytes ? createHash("sha256").update(rawToken, "utf8").digest() : null;
}
