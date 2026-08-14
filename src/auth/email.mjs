import { domainToASCII } from "node:url";
import { AuthInputError } from "./auth-errors.mjs";

const safeMessage = "Enter a valid email address.";
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const asciiLocalPart = /^[\x21-\x7e]+$/u;
const asciiDomainLabel = /^[a-z0-9-]+$/iu;

function invalidEmail() {
  return new AuthInputError("INVALID_EMAIL", safeMessage);
}

function hasValidDomainShape(domain) {
  if (domain.length === 0 || domain.length > 253 || domain.startsWith(".") || domain.endsWith(".")) {
    return false;
  }

  return domain.split(".").every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      asciiDomainLabel.test(label) &&
      !label.startsWith("-") &&
      !label.endsWith("-")
  );
}

export function normalizeEmail(input) {
  if (typeof input !== "string") {
    throw invalidEmail();
  }

  const original = input.trim();
  if (
    original.length < 3 ||
    original.length > 254 ||
    controlCharacters.test(original) ||
    /\s/u.test(original)
  ) {
    throw invalidEmail();
  }

  const separator = original.indexOf("@");
  if (separator <= 0 || separator !== original.lastIndexOf("@") || separator === original.length - 1) {
    throw invalidEmail();
  }

  const localPart = original.slice(0, separator);
  const submittedDomain = original.slice(separator + 1);
  if (!asciiLocalPart.test(localPart)) {
    throw invalidEmail();
  }

  let asciiDomain;
  try {
    asciiDomain = domainToASCII(submittedDomain);
  } catch {
    throw invalidEmail();
  }

  if (!hasValidDomainShape(asciiDomain)) {
    throw invalidEmail();
  }

  const normalized = `${localPart.toLowerCase()}@${asciiDomain.toLowerCase()}`;
  if (normalized.length > 254) {
    throw invalidEmail();
  }

  return { original, normalized };
}
