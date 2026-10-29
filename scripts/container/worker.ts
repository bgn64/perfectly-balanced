import { writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { openDatabase } from "../../apps/web/src/server/database.ts";
import { work, plaidConfig } from "../../apps/web/src/server/plaid.ts";
const db = openDatabase();
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
try {
  const enabled = process.env.PLAID_ENABLED === "true";
  if (enabled) plaidConfig();
  while (!stopping) {
    const worked = enabled && await work(db);
    writeFileSync(process.env.WORKER_HEARTBEAT_PATH ?? "/tmp/balanced-worker-health", String(Date.now()));
    if (!worked) await setTimeout(2000);
  }
} finally { db.close(); }
