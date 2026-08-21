import { loadConfig } from "./src/config/env.mjs";
import { createApp } from "./src/http/app.mjs";

const config = loadConfig();
const app = createApp(config);
let shutdownRequested = false;

const requestShutdown = () => {
  if (shutdownRequested) return;
  shutdownRequested = true;
  app.markStopping();

  const forceCloseTimer = setTimeout(() => {
    process.exitCode = 1;
    app.closeAllConnections?.();
  }, 25_000);
  forceCloseTimer.unref?.();

  app.close((error) => {
    clearTimeout(forceCloseTimer);
    if (error) process.exitCode = 1;
  });
  app.closeIdleConnections?.();
};

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

app.listen(config.port, config.host, () => {
  const address = app.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(`NOQORI API listening at http://${config.host}:${port}`);
});
