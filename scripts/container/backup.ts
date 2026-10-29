import { existsSync } from "node:fs";
import { openDatabase } from "../../apps/web/src/server/database.ts";
const output = process.argv[2];
if (!output || existsSync(output)) throw new Error("Supply a new private backup path. Existing files are never overwritten.");
const db = openDatabase();
try {
  await db.backup(output);
  console.log("Consistent SQLite backup written. Keep the authentication and token-encryption keys separately.");
} finally { db.close(); }
