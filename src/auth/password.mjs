import { randomBytes as cryptoRandomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AuthInputError } from "./auth-errors.mjs";
import { createScryptLimiter } from "./scrypt-limiter.mjs";

export const PASSWORD_SCRYPT_PARAMETERS = Object.freeze({
  N: 131_072,
  r: 8,
  p: 1,
  keyLength: 64,
  saltLength: 16,
  maxmem: 268_435_456
});

const passwordErrorMessage = "Use a password of at least 12 characters and at most 128 UTF-8 bytes.";
const encodedPrefix = "sitepulse:scrypt:v1";
const base64urlPattern = /^[A-Za-z0-9_-]+$/u;

function invalidPassword() {
  return new AuthInputError("INVALID_PASSWORD", passwordErrorMessage);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isRepresentablePassword(value) {
  return typeof value === "string" && !hasUnpairedSurrogate(value) && Buffer.byteLength(value, "utf8") <= 128;
}

export function validatePassword(value) {
  if (!isRepresentablePassword(value) || [...value].length < 12) {
    throw invalidPassword();
  }
  return value;
}

function decodeStrictBase64url(value, expectedLength) {
  const expectedEncodedLength = Math.ceil((expectedLength * 4) / 3);
  if (
    typeof value !== "string" ||
    value.length !== expectedEncodedLength ||
    !base64urlPattern.test(value)
  ) {
    return null;
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedLength || decoded.toString("base64url") !== value) {
    return null;
  }
  return decoded;
}

function parseEncodedHash(encodedHash) {
  if (typeof encodedHash !== "string" || encodedHash.length > 256) {
    return null;
  }

  const fields = encodedHash.split(":");
  if (fields.length !== 9 || fields.slice(0, 3).join(":") !== encodedPrefix) {
    return null;
  }

  const decimalFields = fields.slice(3, 7);
  if (!decimalFields.every((value) => /^(0|[1-9][0-9]*)$/u.test(value))) {
    return null;
  }

  const [N, r, p, keyLength] = decimalFields.map(Number);
  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    !Number.isSafeInteger(keyLength) ||
    N !== PASSWORD_SCRYPT_PARAMETERS.N ||
    r !== PASSWORD_SCRYPT_PARAMETERS.r ||
    p !== PASSWORD_SCRYPT_PARAMETERS.p ||
    keyLength !== PASSWORD_SCRYPT_PARAMETERS.keyLength
  ) {
    return null;
  }

  const salt = decodeStrictBase64url(fields[7], PASSWORD_SCRYPT_PARAMETERS.saltLength);
  const digest = decodeStrictBase64url(fields[8], PASSWORD_SCRYPT_PARAMETERS.keyLength);
  return salt && digest ? { salt, digest } : null;
}

function encodeHash(salt, digest) {
  const { N, r, p, keyLength } = PASSWORD_SCRYPT_PARAMETERS;
  return `${encodedPrefix}:${N}:${r}:${p}:${keyLength}:${salt.toString("base64url")}:${digest.toString("base64url")}`;
}

function deriveWithScrypt(passwordBytes, salt, parameters) {
  return new Promise((resolve, reject) => {
    scrypt(
      passwordBytes,
      salt,
      parameters.keyLength,
      { N: parameters.N, r: parameters.r, p: parameters.p, maxmem: parameters.maxmem },
      (error, derivedKey) => {
        if (error) {
          reject(error);
        } else {
          resolve(derivedKey);
        }
      }
    );
  });
}

const dummySalt = Buffer.alloc(PASSWORD_SCRYPT_PARAMETERS.saltLength, 0x5a);
const dummyDigest = Buffer.alloc(PASSWORD_SCRYPT_PARAMETERS.keyLength, 0xa5);
export const DUMMY_PASSWORD_HASH = encodeHash(dummySalt, dummyDigest);

export function createPasswordService({
  maxConcurrency = 1,
  limiter = createScryptLimiter({ maxConcurrency }),
  deriveKey = deriveWithScrypt,
  randomBytes = cryptoRandomBytes
} = {}) {
  async function derive(password, salt) {
    const passwordBytes = Buffer.from(password, "utf8");
    return limiter.run(() => deriveKey(passwordBytes, salt, PASSWORD_SCRYPT_PARAMETERS));
  }

  async function verifyPasswordValue(password, encodedHash) {
    const parsed = parseEncodedHash(encodedHash);
    if (!parsed || !isRepresentablePassword(password)) {
      return false;
    }

    const candidate = await derive(password, parsed.salt);
    if (!Buffer.isBuffer(candidate) || candidate.length !== parsed.digest.length) {
      return false;
    }
    return timingSafeEqual(candidate, parsed.digest);
  }

  return {
    async hashPassword(password) {
      validatePassword(password);
      const salt = randomBytes(PASSWORD_SCRYPT_PARAMETERS.saltLength);
      if (!Buffer.isBuffer(salt) || salt.length !== PASSWORD_SCRYPT_PARAMETERS.saltLength) {
        throw new TypeError("Password salt generator returned an invalid value.");
      }
      const digest = await derive(password, salt);
      if (!Buffer.isBuffer(digest) || digest.length !== PASSWORD_SCRYPT_PARAMETERS.keyLength) {
        throw new TypeError("Password derivation returned an invalid value.");
      }
      return encodeHash(salt, digest);
    },

    verifyPassword: verifyPasswordValue,

    verifyDummyPassword(password) {
      return verifyPasswordValue(password, DUMMY_PASSWORD_HASH);
    },

    needsRehash(encodedHash) {
      return parseEncodedHash(encodedHash) === null;
    }
  };
}

const defaultPasswordService = createPasswordService();

export const hashPassword = defaultPasswordService.hashPassword.bind(defaultPasswordService);
export const verifyPassword = defaultPasswordService.verifyPassword.bind(defaultPasswordService);
export const verifyDummyPassword = defaultPasswordService.verifyDummyPassword.bind(defaultPasswordService);
export const needsRehash = defaultPasswordService.needsRehash.bind(defaultPasswordService);
