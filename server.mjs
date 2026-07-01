import { loadConfig } from "./src/config/env.mjs";
import { createApp } from "./src/http/app.mjs";

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, config.host, () => {
  console.log(`SitePulse running at http://${config.host}:${config.port}`);
});
