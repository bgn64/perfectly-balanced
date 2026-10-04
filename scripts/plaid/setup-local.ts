import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const template = await readFile(new URL("../../supabase/.env.plaid.example", import.meta.url), "utf8");
await writeFile(new URL("../../supabase/.env.local", import.meta.url),
  template.replace("PLAID_WORKER_SECRET=", `PLAID_WORKER_SECRET=${randomBytes(32).toString("hex")}`),
  { flag: "wx", mode: 0o600 });
console.log("Created private supabase/.env.local. Add Sandbox credentials there; never paste them into chat.");
