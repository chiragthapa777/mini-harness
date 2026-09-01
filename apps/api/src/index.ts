import { getConfig } from "@mini-agent/config";
import { createApp } from "./app.js";
import { logger } from "./logger.js";
import { ensureBootstrapAdmin } from "./services/bootstrap.service.js";

const app = createApp();
const port = getConfig().api.port;

await ensureBootstrapAdmin();
app.listen(port, () => {
  logger.info(`api listening on http://localhost:${port}`);
});
