// Must be the first import — runs validateEnv() as a side effect before any
// other module's top-level code reads process.env.
import "./lib/env";

import app from "./app";
import { logger } from "./lib/logger";
import { ensureSessionTable } from "./lib/session";
import { getSiteSettings } from "./lib/site-settings";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await ensureSessionTable();
await getSiteSettings(); // seeds the singleton settings row if missing

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
