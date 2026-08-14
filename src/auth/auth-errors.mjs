export class AuthInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthInputError";
    this.code = code;
  }
}

export class AuthCapacityError extends Error {
  constructor() {
    super("Authentication is temporarily unavailable.");
    this.name = "AuthCapacityError";
    this.code = "AUTH_CAPACITY_EXCEEDED";
  }
}
