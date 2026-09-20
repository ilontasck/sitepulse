import { normalizeEmail } from "./email.mjs";
import { validatePassword } from "./password.mjs";
import { toPublicUser } from "./public-user.mjs";
import { generateSessionToken as defaultGenerateSessionToken, hashSessionToken } from "./session-token.mjs";
import {
  generatePasswordResetToken as defaultGeneratePasswordResetToken,
  hashPasswordResetToken
} from "./password-reset-token.mjs";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1_000;

export class AuthServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthServiceError";
    this.code = code;
  }
}

function invalidCredentials() {
  return new AuthServiceError("INVALID_CREDENTIALS", "Email or password is incorrect.");
}

function invalidPasswordResetToken() {
  return new AuthServiceError("INVALID_PASSWORD_RESET_TOKEN", "Password reset token is invalid or expired.");
}

export function createAuthService({
  authStore,
  passwordService,
  clock = () => new Date(),
  generateSessionToken = defaultGenerateSessionToken,
  sessionTtlMs = SESSION_TTL_MS,
  generatePasswordResetToken = defaultGeneratePasswordResetToken,
  deliverPasswordReset = async () => {},
  passwordResetTtlMs = PASSWORD_RESET_TTL_MS
}) {
  if (!authStore || !passwordService) {
    throw new TypeError("Authentication storage and password service are required.");
  }

  function createSessionMaterial() {
    const sessionToken = generateSessionToken();
    const sessionTokenHash = hashSessionToken(sessionToken);
    if (!sessionTokenHash) {
      throw new AuthServiceError("AUTH_FAILED", "Authentication could not be completed.");
    }
    const sessionExpiresAt = new Date(clock().getTime() + sessionTtlMs).toISOString();
    return { sessionToken, sessionTokenHash, sessionExpiresAt };
  }

  return {
    async register({ email, password }) {
      const identity = normalizeEmail(email);
      validatePassword(password);
      const passwordHash = await passwordService.hashPassword(password);
      const session = createSessionMaterial();

      try {
        const created = await authStore.createUserWithSession({
          emailOriginal: identity.original,
          emailNormalized: identity.normalized,
          passwordHash,
          sessionTokenHash: session.sessionTokenHash,
          sessionExpiresAt: session.sessionExpiresAt
        });
        return {
          user: toPublicUser(created.user),
          sessionToken: session.sessionToken,
          sessionExpiresAt: session.sessionExpiresAt
        };
      } catch (error) {
        if (error?.code === "EMAIL_ALREADY_EXISTS") {
          throw new AuthServiceError("EMAIL_ALREADY_REGISTERED", "An account already exists for this email.");
        }
        throw error;
      }
    },

    async login({ email, password, previousSessionToken }) {
      let identity = null;
      try {
        identity = normalizeEmail(email);
      } catch {
        // Invalid account identifiers use the same generic, expensive path.
      }

      let user = null;
      if (identity) {
        user = await authStore.findUserByNormalizedEmail(identity.normalized);
      }

      const canUseStoredHash = user && !user.disabledAt && !passwordService.needsRehash(user.passwordHash);
      const verified = canUseStoredHash
        ? await passwordService.verifyPassword(password, user.passwordHash)
        : await passwordService.verifyDummyPassword(password);

      if (!verified || !user || user.disabledAt) {
        throw invalidCredentials();
      }

      const session = createSessionMaterial();
      const previousTokenHash = hashSessionToken(previousSessionToken);
      await authStore.rotateSession({
        userId: user.id,
        previousTokenHash: previousTokenHash || undefined,
        newTokenHash: session.sessionTokenHash,
        newExpiresAt: session.sessionExpiresAt
      });

      return {
        user: toPublicUser(user),
        sessionToken: session.sessionToken,
        sessionExpiresAt: session.sessionExpiresAt
      };
    },

    async authenticate(sessionToken) {
      const tokenHash = hashSessionToken(sessionToken);
      if (!tokenHash) {
        return null;
      }
      const active = await authStore.findActiveSessionByTokenHash(tokenHash);
      return active ? toPublicUser(active.user) : null;
    },

    async logout(sessionToken) {
      const tokenHash = hashSessionToken(sessionToken);
      return tokenHash ? authStore.revokeSessionByTokenHash(tokenHash) : false;
    },

    async requestPasswordReset({ email } = {}) {
      let identity;
      try {
        identity = normalizeEmail(email);
      } catch {
        return { accepted: true };
      }

      const user = await authStore.findUserByNormalizedEmail(identity.normalized);
      if (!user || user.disabledAt) {
        return { accepted: true };
      }

      const token = generatePasswordResetToken();
      const tokenHash = hashPasswordResetToken(token);
      if (!tokenHash) {
        throw new AuthServiceError("AUTH_FAILED", "Password reset could not be completed.");
      }
      const expiresAt = new Date(clock().getTime() + passwordResetTtlMs).toISOString();
      await authStore.replacePasswordResetToken({ userId: user.id, tokenHash, expiresAt });
      try {
        await deliverPasswordReset({ email: user.emailOriginal, token, expiresAt });
      } catch {
        // Delivery is best-effort until STE-35 supplies its own monitored retry mechanism.
        // Never let provider availability reveal whether an account exists.
      }
      return { accepted: true };
    },

    async confirmPasswordReset({ token, password } = {}) {
      const tokenHash = hashPasswordResetToken(token);
      if (!tokenHash) throw invalidPasswordResetToken();
      validatePassword(password);
      const passwordHash = await passwordService.hashPassword(password);
      const consumed = await authStore.consumePasswordResetToken({ tokenHash, passwordHash });
      if (!consumed) throw invalidPasswordResetToken();
    }
  };
}
