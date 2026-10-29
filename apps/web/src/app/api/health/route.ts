import { database } from "../../../server/database";
export const dynamic = "force-dynamic";
export function GET() {
  try {
    database().prepare("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1").get();
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Database health check failed", error instanceof Error ? error.name : "UnknownError");
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
