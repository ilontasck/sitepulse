const sessionTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const maxCookieHeaderBytes = 8_192;
const maxCookieCount = 64;
const sessionMaxAgeSeconds = 14 * 24 * 60 * 60;

function isCanonicalSessionToken(value) {
  if (typeof value !== "string" || !sessionTokenPattern.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function commonAttributes(secure) {
  return [`Path=/`, "HttpOnly", ...(secure ? ["Secure"] : []), "SameSite=Lax"];
}

export function createSessionCookiePolicy({ publicOrigin }) {
  const secure = new URL(publicOrigin).protocol === "https:";
  const name = secure ? "__Host-sitepulse_session" : "sitepulse_session";

  return {
    name,

    serialize(sessionToken, expiresAt) {
      if (!isCanonicalSessionToken(sessionToken)) {
        throw new TypeError("Session token is invalid.");
      }
      const expiry = new Date(expiresAt);
      if (!Number.isFinite(expiry.getTime()) || expiry.toISOString() !== expiresAt) {
        throw new TypeError("Session expiry is invalid.");
      }
      return [
        `${name}=${sessionToken}`,
        ...commonAttributes(secure),
        `Max-Age=${sessionMaxAgeSeconds}`,
        `Expires=${expiry.toUTCString()}`
      ].join("; ");
    },

    clear() {
      return [
        `${name}=`,
        ...commonAttributes(secure),
        "Max-Age=0",
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
      ].join("; ");
    },

    parse(cookieHeader) {
      if (
        typeof cookieHeader !== "string" ||
        Buffer.byteLength(cookieHeader) > maxCookieHeaderBytes
      ) {
        return null;
      }

      const cookies = cookieHeader.split(";");
      if (cookies.length > maxCookieCount) {
        return null;
      }

      let found = null;
      for (const cookie of cookies) {
        const separator = cookie.indexOf("=");
        if (separator < 0 || cookie.slice(0, separator).trim() !== name) {
          continue;
        }
        if (found !== null) {
          return null;
        }
        found = cookie.slice(separator + 1).trim();
      }

      return isCanonicalSessionToken(found) ? found : null;
    }
  };
}
