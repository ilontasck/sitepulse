import { createHash, randomBytes } from "node:crypto";
const TOKEN_BYTES=32;
const TOKEN_PATTERN=/^[A-Za-z0-9_-]{43}$/u;
export const EMAIL_VERIFICATION_TTL_MS=24*60*60*1000;
export function generateEmailVerificationToken(){return randomBytes(TOKEN_BYTES).toString("base64url");}
export function hashEmailVerificationToken(token){
  if(typeof token!=="string"||!TOKEN_PATTERN.test(token))return null;
  const decoded=Buffer.from(token,"base64url");
  return decoded.length===TOKEN_BYTES&&decoded.toString("base64url")===token?createHash("sha256").update(decoded).digest():null;
}
