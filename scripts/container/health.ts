import { readFileSync } from "node:fs";
try {
  const heartbeat = Number(readFileSync("/tmp/balanced-worker-health", "utf8"));
  if (!Number.isFinite(heartbeat) || Date.now() - heartbeat > 120000) throw new Error("Worker heartbeat is stale.");
  const response = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Application is not healthy.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Health check failed.");
  process.exitCode = 1;
}
