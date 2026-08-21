const service = process.argv[2];
const wait = process.argv.includes("--wait");

function loopbackUrl(host, port, pathname) {
  const safeHost = host === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${safeHost}:${port}${pathname}`;
}

function healthUrl() {
  if (service === "api") {
    return process.env.NOQORI_API_READINESS_URL || loopbackUrl("127.0.0.1", process.env.PORT || "3000", "/api/ready");
  }
  if (service === "worker") {
    return process.env.NOQORI_WORKER_READINESS_URL || loopbackUrl(
      process.env.WORKER_HEALTH_HOST || "127.0.0.1",
      process.env.WORKER_HEALTH_PORT || "3001",
      "/readyz"
    );
  }
  throw new Error("Health check service must be api or worker.");
}

const url = healthUrl();
const deadline = Date.now() + (wait ? 15_000 : 1);
let ready = false;

do {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    ready = response.status === 200;
  } catch {
    ready = false;
  }

  if (!ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} while (!ready && Date.now() < deadline);

if (!ready) {
  console.error(JSON.stringify({ type: "noqori.health", service, status: "not-ready" }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ type: "noqori.health", service, status: "ready" }));
}
