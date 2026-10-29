import { spawn } from "node:child_process";
import { once } from "node:events";

const migration = spawn(process.execPath, ["scripts/container/migrate.ts"], { stdio: "inherit" });
const [migrationCode] = await once(migration, "exit");
if (migrationCode !== 0) throw new Error("Database migration failed; application was not started.");
const server = spawn(process.execPath, ["apps/web/server.js"], { stdio: "inherit" });
const worker = spawn(process.execPath, ["scripts/container/worker.ts"], { stdio: "inherit" });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.kill("SIGTERM"); worker.kill("SIGTERM");
  setTimeout(() => { server.kill("SIGKILL"); worker.kill("SIGKILL"); }, 10000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
for (const child of [server, worker]) child.on("error", error => { console.error("Runtime process failed", error.message); stop(); process.exitCode = 1; });
await Promise.race([once(server, "exit"), once(worker, "exit")]);
if (!stopping) { console.error("A required runtime process exited; stopping the container."); process.exitCode = 1; }
stop();
await Promise.all([server.exitCode !== null || server.signalCode !== null ? Promise.resolve() : once(server, "exit"), worker.exitCode !== null || worker.signalCode !== null ? Promise.resolve() : once(worker, "exit")]);
