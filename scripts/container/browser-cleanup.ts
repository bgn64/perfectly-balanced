import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";

export default async function cleanupBrowserDatabase() {
  if (process.env.CONTAINER_TEST_URL || !process.env.TEST_DATABASE_PATH) return;
  const directory = resolve(dirname(process.env.TEST_DATABASE_PATH));
  if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith("balanced-browser-")) {
    throw new Error("Refusing to clean up an unrecognized browser-test database directory.");
  }
  const pidFile = join(directory, "server.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid browser-test application PID.");
    try { process.kill(pid, "SIGTERM"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    for (let attempt = 0; attempt < 50 && existsSync(directory); attempt++) await setTimeout(100);
  }
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
