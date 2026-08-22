import { createHash } from "node:crypto";

const volatileKeys = new Set(["handle", "index", "bytes", "packets"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !volatileKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
}

export function hashOwnedNftablesState(state) {
  const keys = Object.keys(state || {}).sort();
  if (keys.join(",") !== "hostForward,hostIngress,hostNat,namespace") {
    throw new TypeError("All owned nftables tables are required.");
  }
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(state)))
    .digest("hex");
}
