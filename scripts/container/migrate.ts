import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../../apps/web/src/server/auth.ts";
import { openDatabase, migrate } from "../../apps/web/src/server/database.ts";

const db = openDatabase();
try {
  const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_versions'").get();
  const migration = await getMigrations(authOptions(db));
  const budgetVersion = existing ? (db.prepare("SELECT max(version) AS version FROM schema_versions").get() as { version: number }).version : 0;
  if (existing && (budgetVersion < 1 || migration.toBeAdded.length || migration.toBeCreated.length || migration.toBeAddedIndexes.length)) {
    await db.backup(`${db.name}.before-migration-${Date.now()}.sqlite`);
  }
  await migration.runMigrations();
  migrate(db);
  console.log("Authentication and budget schema are up to date.");
} finally { db.close(); }
