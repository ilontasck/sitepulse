import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const mandatoryBlockedIpv4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4"
];

describe("browser network sandbox contracts", () => {
  it("pins deterministic special-purpose ranges and fails closed on resolver placeholders", async () => {
    const packageJson = JSON.parse(await read("package.json"));
    assert.equal(packageJson.engines.node, ">=24 <25");
    assert.equal(packageJson.dependencies.playwright, "1.61.1");
    const registry = JSON.parse(await read("deploy/network/iana-special-purpose-ipv4.json"));
    assert.equal(registry.source, "https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml");
    assert.match(registry.snapshotDate, /^\d{4}-\d{2}-\d{2}$/);
    for (const prefix of mandatoryBlockedIpv4) assert.ok(registry.blockedPrefixes.includes(prefix), prefix);

    const config = JSON.parse(await read("deploy/network/noqori-audit-network.json.example"));
    assert.deepEqual(config.dnsResolvers, ["REPLACE_WITH_IPV4_RESOLVER_1", "REPLACE_WITH_IPV4_RESOLVER_2"]);
    assert.equal(config.enableIpv6, false);
    assert.equal(config.enableQuic, false);
  });

  it("copies the complete pnpm dependency closure into the symlink-free bundle", async () => {
    const operations = await read("docs/PRODUCTION_BROWSER_SECURITY.md");
    assert.match(
      operations,
      /cp -aL node_modules\/\.pnpm\/node_modules\/\. \/usr\/local\/lib\/noqori-browser-sandbox\.new\/node_modules\//
    );
  });

  it("uses isolated default-deny nftables boundaries without global flushes", async () => {
    const [namespacePolicy, hostPolicy, setup] = await Promise.all([
      read("deploy/network/noqori-audit-namespace.nft"),
      read("deploy/network/noqori-audit-host.nft"),
      read("scripts/setup-browser-sandbox.mjs")
    ]);
    assert.match(namespacePolicy, /table inet noqori_audit_namespace/);
    assert.match(hostPolicy, /table netdev noqori_audit_host/);
    for (const policy of [namespacePolicy, hostPolicy]) {
      assert.match(policy, /policy drop/);
      assert.doesNotMatch(policy, /flush ruleset/i);
    }
    assert.match(namespacePolicy, /ct state established,related accept/);
    assert.match(hostPolicy, /table inet noqori_audit_forward/);
    assert.match(hostPolicy, /hook forward/);
    assert.match(hostPolicy, /iifname "nq-audit-host" jump audit_egress/);
    assert.match(hostPolicy, /oifname "nq-audit-host" ct state established,related accept\s+oifname "nq-audit-host" drop/);
    assert.match(hostPolicy, /chain audit_egress[\s\S]*drop/);
    assert.match(hostPolicy, /hook ingress device "nq-audit-host"/);
    assert.match(hostPolicy, /ether type arp arp operation request arp daddr ip @GATEWAY_IPV4@ accept/);
    assert.match(hostPolicy, /ether type arp arp operation reply arp saddr ip @NAMESPACE_IPV4@ arp daddr ip @GATEWAY_IPV4@ accept/);
    assert.match(namespacePolicy, /tcp dport \{ 80, 443 \}/);
    assert.match(namespacePolicy, /udp dport 443 drop/);
    assert.match(namespacePolicy, /ip6 daddr ::\/0 drop/);
    assert.doesNotMatch(namespacePolicy, /127\.0\.0\.1|iifname "lo" accept|oifname "lo".*accept/);
    assert.match(hostPolicy, /fib daddr type local drop/);
    assert.match(setup, /exists\("nft", \["list", "table", "inet", "noqori_audit_forward"\]\)/);
    assert.match(setup, /chownSync\("\/run\/netns", 0, 0\)/);
    assert.match(setup, /chmodSync\("\/run\/netns", 0o755\)/);
    assert.match(setup, /NAMESPACE_IPV4: config\.namespaceAddress\.split\("\/"\)\[0\]/);
    const namespaceAcceptRules = namespacePolicy.split("\n").map((line) => line.trim()).filter((line) => /\baccept$/.test(line));
    assert.deepEqual(namespaceAcceptRules, [
      "ct state established,related accept",
      "ip daddr @dns_ipv4 udp dport 53 accept",
      "ip daddr @dns_ipv4 tcp dport 53 accept",
      "ip daddr != @dns_ipv4 tcp dport { 80, 443 } accept",
      "ct state established,related accept"
    ]);
    const hostAcceptRules = hostPolicy.split("\n").map((line) => line.trim()).filter((line) => /\baccept$/.test(line));
    assert.deepEqual(hostAcceptRules, [
      "iifname \"nq-audit-host\" ether type arp arp operation request arp daddr ip @GATEWAY_IPV4@ accept",
      "iifname \"nq-audit-host\" ether type arp arp operation reply arp saddr ip @NAMESPACE_IPV4@ arp daddr ip @GATEWAY_IPV4@ accept",
      "iifname \"nq-audit-host\" ip daddr @dns_ipv4 udp dport 53 accept",
      "iifname \"nq-audit-host\" ip daddr @dns_ipv4 tcp dport 53 accept",
      "iifname \"nq-audit-host\" ip daddr != @dns_ipv4 tcp dport { 80, 443 } accept",
      "oifname \"nq-audit-host\" ct state established,related accept",
      "ip daddr @dns_ipv4 udp dport 53 accept",
      "ip daddr @dns_ipv4 tcp dport 53 accept",
      "ip daddr != @dns_ipv4 tcp dport { 80, 443 } accept"
    ]);
  });

  it("wires socket activation and runner isolation into the systemd graph", async () => {
    const [runner, socket, sandbox, worker, target, api, runnerScript] = await Promise.all([
      read("deploy/systemd/noqori-audit-runner.service"),
      read("deploy/systemd/noqori-audit-runner.socket"),
      read("deploy/systemd/noqori-audit-sandbox.service"),
      read("deploy/systemd/noqori-worker.service"),
      read("deploy/systemd/noqori.target"),
      read("deploy/systemd/noqori-api.service"),
      read("scripts/run-audit-runner.mjs")
    ]);
    assert.match(runner, /^User=noqori-browser$/m);
    assert.match(runner, /^WorkingDirectory=\/usr\/local\/lib\/noqori-browser-sandbox$/m);
    assert.match(runner, /^NetworkNamespacePath=\/run\/netns\/noqori-audit$/m);
    assert.match(runner, /^Requires=.*\bnoqori-audit-sandbox\.service\b/m);
    assert.match(runner, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_NETLINK$/m);
    assert.match(runner, /^CapabilityBoundingSet=$/m);
    assert.match(runner, /^AmbientCapabilities=$/m);
    assert.ok(runner.indexOf("StartLimitIntervalSec=0") < runner.indexOf("[Service]"));
    assert.match(runner, /^InaccessiblePaths=.*\/var\/lib\/noqori/m);
    assert.doesNotMatch(runner, /^InaccessiblePaths=(?:.*\s)?\/run(?:\s|$)/m);
    assert.match(runner, /^ReadOnlyPaths=(?:.*\s)?\/run(?:\s|$)/m);
    assert.doesNotMatch(runner, /EnvironmentFile=/);
    assert.doesNotMatch(runner, /WorkingDirectory=\/opt\/noqori\/current/);
    assert.match(socket, /^ListenStream=\/run\/noqori-audit\.sock$/m);
    assert.match(socket, /^SocketMode=0660$/m);
    assert.match(socket, /^SocketGroup=noqori-audit-rpc$/m);
    assert.match(worker, /^SupplementaryGroups=noqori-audit-rpc$/m);
    assert.doesNotMatch(runner, /^SupplementaryGroups=noqori-audit-rpc$/m);
    assert.match(runner, /^LoadCredential=sandbox-attestation:/m);
    assert.match(runner, /^LoadCredential=sandbox-config-hash:/m);
    assert.match(runner, /^LoadCredential=sandbox-bundle-hash:/m);
    assert.match(runner, /^LoadCredential=sandbox-platform-hash:/m);
    assert.match(runner, /^LoadCredential=sandbox-acceptance-test:/m);
    assert.match(sandbox, /^User=root$/m);
    assert.match(sandbox, /^Wants=network-online\.target$/m);
    assert.match(sandbox, /^After=network-online\.target$/m);
    assert.match(sandbox, /^RemainAfterExit=yes$/m);
    assert.match(sandbox, /^WorkingDirectory=\/usr\/local\/lib\/noqori-browser-sandbox$/m);
    assert.match(sandbox, /find \/usr\/local\/lib\/noqori-browser-sandbox.*-type l/);
    assert.match(sandbox, /find \/usr\/local\/lib\/noqori-browser-sandbox.*! -user root.*-perm \/022/);
    assert.ok(runner.includes("\\\\("));
    assert.ok(sandbox.includes("\\\\("));
    assert.ok((await read("deploy/systemd/noqori-audit-sandbox-verify.service")).includes("\\\\("));
    assert.doesNotMatch(sandbox, /WorkingDirectory=\/opt\/noqori\/current/);
    assert.doesNotMatch(sandbox, /^(PrivateTmp|ProtectHome|ProtectSystem|ReadWritePaths)=/m);
    assert.match(worker, /^Wants=.*\bnoqori-audit-runner\.socket\b/m);
    assert.match(target, /noqori-audit-sandbox\.service/);
    assert.match(api, /^EnvironmentFile=-\/etc\/noqori\/noqori-secrets\.env$/m);
    assert.doesNotMatch(runnerScript, /collectBrowserSandboxPlatform/);
  });

  it("disables QUIC and documents an actual Linux-only kernel suite", async () => {
    const [adapter, script, vmAcceptance, crashAcceptance] = await Promise.all([
      read("src/audit/scanners/lighthouse-playwright-adapter.mjs"),
      read("scripts/run-browser-sandbox-integration.mjs"),
      read("scripts/run-browser-sandbox-vm-acceptance.mjs"),
      read("scripts/verify-worker-crash-recovery-on-vm.mjs")
    ]);
    assert.match(adapter, /--disable-quic/);
    assert.match(adapter, /--remote-debugging-pipe/);
    assert.match(adapter, /handleSIGINT:\s*false/);
    assert.match(adapter, /signal\?\.aborted/);
    assert.match(adapter, /addEventListener\("abort", abortChrome/);
    assert.match(adapter, /removeEventListener\("abort", abortChrome/);
    assert.match(adapter, /error\?\.name === "TargetCloseError"/);
    assert.match(adapter, /process\.on\("unhandledRejection", captureAsynchronousCleanupError\)/);
    assert.match(adapter, /if \(unexpectedCleanupError\) throw unexpectedCleanupError/);
    assert.doesNotMatch(adapter, /remote-debugging-port|remote-debugging-address|connectOverCDP|9222/);
    assert.match(script, /process\.platform !== "linux"/);
    assert.match(script, /UNAVAILABLE/);
    assert.match(script, /browser-sandbox\.integration\.sh/);
    assert.doesNotMatch(script, /mark-browser-sandbox-accepted/);
    assert.match(vmAcceptance, /prepare-reboot/);
    assert.match(vmAcceptance, /verify-worker-crash-recovery-on-vm\.mjs/);
    assert.match(vmAcceptance, /mark-browser-sandbox-accepted\.mjs/);
    assert.match(vmAcceptance, /browserSandboxKernelEvidencePath/);
    assert.match(vmAcceptance, /VM_ACCEPTANCE_RESTORED_ATTESTATION_INVALID/);
    assert.match(vmAcceptance, /queue\.namespaceInode !== restored\.namespaceInode/);
    assert.match(vmAcceptance, /queue\.readyBeforeClaim !== true/);
    assert.match(await read("src/production/browser-sandbox-policy.mjs"), /browser-sandbox-kernel-result\.json/);
    assert.match(crashAcceptance, /namespaceInodeBefore/);
    assert.match(crashAcceptance, /workerProcessCount !== 1/);
    assert.match(crashAcceptance, /VM_ACCEPTANCE_WORKER_NOT_READY_BEFORE_CLAIM/);
    assert.match(crashAcceptance, /readyBeforeClaim: readyAt <= enqueuedAt/);
  });

  it("requires truthful Linux gates for systemd, cancellation, worker cardinality, and resource budgets", async () => {
    const linuxAcceptance = await read("test/linux/browser-sandbox.integration.sh");
    assert.match(linuxAcceptance, /systemd-analyze verify/);
    assert.match(linuxAcceptance, /stat \/run\/netns\/noqori-audit/);
    assert.match(linuxAcceptance, /runner-client-disconnect-cancellation/);
    assert.match(linuxAcceptance, /runner-client-timeout-cancellation/);
    assert.match(linuxAcceptance, /timeout_client_pid=\$!/);
    assert.match(linuxAcceptance, /pgrep -P "\$runner_pid" -f 'chrome\|chromium' >\/dev\/null/);
    assert.match(linuxAcceptance, /runner-sigint-cancellation/);
    assert.match(linuxAcceptance, /runner-sigterm-cancellation/);
    assert.match(linuxAcceptance, /MemoryMax/);
    assert.match(linuxAcceptance, /TasksMax/);
    assert.match(linuxAcceptance, /ControlGroup/);
    assert.match(linuxAcceptance, /MainPID/);
    assert.match(linuxAcceptance, /ActiveState/);
    assert.match(linuxAcceptance, /\/proc\/\$pid\/stat/);
    assert.match(linuxAcceptance, /process_state.*!= Z/);
    assert.match(linuxAcceptance, /cut .*\/proc\/\$pid\/stat.*2>\/dev\/null \|\| true/);
    assert.match(linuxAcceptance, /seq 1 300/);
    assert.match(linuxAcceptance, /run-isolated-audit\.mjs.*NOQORI_PUBLIC_HTTPS_URL/);
    assert.match(linuxAcceptance, /client-timeout-ms=15000/);
    assert.match(linuxAcceptance, /stop noqori-audit-runner\.socket/);
    assert.match(linuxAcceptance, /timeout 5s ip netns exec/);
    assert.match(linuxAcceptance, /NOQORI_QUIC_ASSERT_URL/);
    assert.match(linuxAcceptance, /\/dev\/udp\/\$1\/443/);
    assert.match(await read("scripts/check-service-health.mjs"), /service === "worker" \? 30_000 : 15_000/);
  });

  it("strips socket-activation metadata before Chromium; Linux acceptance checks descriptors", async () => {
    const { browserChildEnvironment } = await import("../src/audit/scanners/lighthouse-playwright-adapter.mjs");
    const child = browserChildEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/should-not-leak",
      LISTEN_PID: "123",
      LISTEN_FDS: "1",
      LISTEN_FDNAMES: "audit"
    });
    assert.deepEqual(child, { PATH: "/usr/bin", HOME: "/tmp" });
    const adapter = await read("src/audit/scanners/lighthouse-playwright-adapter.mjs");
    assert.match(adapter, /envVars: browserChildEnvironment\(\)/);
    const apparmor = await read("deploy/apparmor/noqori-chromium");
    assert.match(apparmor, /profile noqori-chromium .*chromium-\*\/chrome-linux64\/chrome flags=\(unconfined\)/);
    assert.match(apparmor, /^\s*userns,$/m);
    assert.doesNotMatch(adapter, /--no-sandbox/);
    const linuxAcceptance = await read("test/linux/browser-sandbox.integration.sh");
    assert.match(linuxAcceptance, /\/proc\/\$\{?chrome_pid\}?\/fd/);
  });
});
