export class RenderedAuditCapacityError extends Error {
  constructor() {
    super("Rendered audit capacity is temporarily full.");
    this.name = "RenderedAuditCapacityError";
    this.code = "RENDERED_CONCURRENCY_LIMIT";
  }
}

export function createRenderedAuditLimiter(maxConcurrency = 1) {
  let active = 0;

  return {
    async run(task) {
      if (active >= maxConcurrency) {
        throw new RenderedAuditCapacityError();
      }

      active += 1;

      try {
        return await task();
      } finally {
        active -= 1;
      }
    },

    snapshot() {
      return { active, available: Math.max(maxConcurrency - active, 0), maxConcurrency };
    }
  };
}
