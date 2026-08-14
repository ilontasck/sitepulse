import { AuthCapacityError } from "./auth-errors.mjs";

export function createScryptLimiter({ maxConcurrency = 1 } = {}) {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new TypeError("Scrypt concurrency must be a positive integer.");
  }

  let activeCount = 0;

  return {
    async run(operation) {
      if (typeof operation !== "function") {
        throw new TypeError("Scrypt operation must be a function.");
      }
      if (activeCount >= maxConcurrency) {
        throw new AuthCapacityError();
      }

      activeCount += 1;
      try {
        return await operation();
      } finally {
        activeCount -= 1;
      }
    }
  };
}
