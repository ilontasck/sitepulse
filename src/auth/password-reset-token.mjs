import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function generatePasswordResetToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashPasswordResetToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    return null;
  }
  const decoded = Buffer.from(token, "base64url");
  if (decoded.length !== TOKEN_BYTES || decoded.toString("base64url") !== token) {
    return null;
  }
  return createHash("sha256").update(decoded).digest();
}
