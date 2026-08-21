import { verifySystemdUnits } from "../src/production/systemd-verifier.mjs";

const result = verifySystemdUnits();
console.log(JSON.stringify({ type: "noqori.systemd.verify", ...result }));

if (result.status === "FAILED") {
  process.exitCode = 1;
}
