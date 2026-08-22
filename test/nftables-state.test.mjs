import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashOwnedNftablesState } from "../src/production/nftables-state.mjs";

const state = {
  hostIngress: { nftables: [
    { table: { family: "netdev", name: "noqori_audit_host", handle: 4 } },
    { chain: { family: "netdev", table: "noqori_audit_host", name: "audit_ingress", type: "filter", hook: "ingress", prio: -500, policy: "drop", handle: 5 } },
    { rule: { family: "netdev", table: "noqori_audit_host", chain: "audit_ingress", expr: [{ drop: null }], handle: 6 } }
  ] },
  hostForward: { nftables: [
    { table: { family: "inet", name: "noqori_audit_forward" } },
    { chain: { family: "inet", table: "noqori_audit_forward", name: "audit_egress", policy: null } },
    { rule: { family: "inet", table: "noqori_audit_forward", chain: "audit_egress", expr: [{ drop: null }] } }
  ] },
  hostNat: { nftables: [{ table: { family: "ip", name: "noqori_audit_nat" } }] },
  namespace: { nftables: [
    { table: { family: "inet", name: "noqori_audit_namespace" } },
    { chain: { family: "inet", table: "noqori_audit_namespace", name: "output", type: "filter", hook: "output", prio: 0, policy: "drop" } },
    { chain: { family: "inet", table: "noqori_audit_namespace", name: "input", type: "filter", hook: "input", prio: 0, policy: "drop" } }
  ] }
};

describe("owned nftables state", () => {
  it("produces a stable semantic hash but detects any installed policy mutation", () => {
    const expected = hashOwnedNftablesState(state);
    const newHandles = structuredClone(state);
    newHandles.hostIngress.nftables[0].table.handle = 99;
    newHandles.hostIngress.nftables[1].chain.handle = 100;
    assert.equal(hashOwnedNftablesState(newHandles), expected);

    const permissive = structuredClone(state);
    permissive.namespace.nftables[1].chain.policy = "accept";
    assert.notEqual(hashOwnedNftablesState(permissive), expected);

    const injected = structuredClone(state);
    injected.hostForward.nftables.push({
      rule: { family: "inet", table: "noqori_audit_forward", chain: "audit_egress", expr: [{ accept: null }] }
    });
    assert.notEqual(hashOwnedNftablesState(injected), expected);
  });
});
