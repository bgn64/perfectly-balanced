import { randomBytes } from "node:crypto";
import { readFile,writeFile } from "node:fs/promises";
const path=new URL("../../supabase/.env.local",import.meta.url);
const current=await readFile(path,"utf8");
if (!/^APP_DEPLOYMENT_ENV=local$/m.test(current) || !/^PLAID_WORKER_SECRET=.+$/m.test(current)) throw new Error("Expected an existing local Plaid configuration.");
await writeFile(path,current.replace(/^PLAID_WORKER_SECRET=.*$/m,`PLAID_WORKER_SECRET=${randomBytes(32).toString("hex")}`),{ mode:0o600 });
console.log("Local worker signing secret rotated. Restart functions, then run npm run plaid:schedule:local.");
