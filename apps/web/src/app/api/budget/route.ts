import { z } from "zod";
import { sourceInputSchema } from "@balanced/domain";
import { auth } from "../../../server/auth";
import { database } from "../../../server/database";
import { BudgetService, commandSchema, filtersSchema } from "../../../server/budget";
import { BankService, BankError } from "../../../server/plaid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const month = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/);
const uuid = z.string().uuid();
const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("month"), month }),
  z.object({ operation: z.literal("page"), month, filters: filtersSchema }),
  z.object({ operation: z.literal("mutate"), command: commandSchema }),
  z.object({ operation: z.literal("suggest"), id: uuid, month }),
  z.object({ operation: z.literal("preview"), fingerprint: z.string(), rows: z.array(sourceInputSchema).max(1000) }),
  z.object({ operation: z.literal("import"), fingerprint: z.string(), rows: z.array(sourceInputSchema).min(1).max(1000) }),
  z.object({ operation: z.literal("demo"), month }),
  z.object({ operation: z.literal("banking"), offset: z.number().int().min(0) }),
  z.object({ operation: z.literal("bank"), request: z.unknown() }),
  z.object({ operation: z.literal("restore"), id: uuid, revision: z.number().int().nonnegative() }),
  z.object({ operation: z.literal("resolve"), id: uuid, version: z.number().int().positive(),
    decision: z.enum(["ignore", "new", "match", "accept"]), transaction: uuid.optional(), revision: z.number().int().nonnegative().optional(),
    allocations: z.array(z.object({ category_id: uuid.nullable(), amount_cents: z.number().int() })).max(1000).optional() }),
]);
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
async function body(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("JSON requests are required.");
  if (!request.body) throw new Error("Request body missing.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 3 * 1024 * 1024) { await reader.cancel(); throw new Error("Request exceeds 3 MB."); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export async function POST(request: Request) {
  if (request.headers.get("origin") !== process.env.BETTER_AUTH_URL) return json({ error: "Origin denied." }, 403);
  const session = await auth().api.getSession({ headers: request.headers });
  if (!session) return json({ error: "Sign in to continue." }, 401);
  try {
    const input = requestSchema.parse(await body(request));
    const db = database(), service = new BudgetService(db, session.user.id), bank = new BankService(db, session.user.id);
    if (!db.prepare("SELECT 1 FROM owners WHERE id=?").get(session.user.id)) throw new Error("Account has not been provisioned for budgeting.");
    let result: unknown;
    switch (input.operation) {
      case "month": result = service.month(input.month); break;
      case "page": result = service.page(input.month, input.filters); break;
      case "mutate": service.mutate(input.command); break;
      case "suggest": result = service.suggest(service.transaction(input.id), service.month(input.month)); break;
      case "preview": result = service.preview(input.fingerprint, input.rows); break;
      case "import": service.import(input.fingerprint, input.rows); break;
      case "demo": service.demo(input.month); break;
      case "banking": result = bank.banking(input.offset); break;
      case "bank": {
        const { bankRequestSchema } = await import("@balanced/domain");
        const now = Date.now();
        const allowed = db.transaction(() => {
          db.prepare("DELETE FROM bank_requests WHERE created_at<?").run(now - 60000);
          const count = db.prepare("SELECT count(*) AS n FROM bank_requests WHERE owner_id=?").get(session.user.id) as { n: number };
          if (count.n >= 15) return false;
          db.prepare("INSERT INTO bank_requests(owner_id,created_at) VALUES(?,?)").run(session.user.id, now);
          return true;
        }).immediate();
        if (!allowed) return json({ error: "Too many bank requests. Wait a minute before retrying." }, 429);
        result = await bank.bank(bankRequestSchema.parse(input.request)); break;
      }
      case "resolve": bank.resolve(input.id, input.version, input.decision, input.transaction, input.allocations, input.revision); break;
      case "restore": bank.restore(input.id, input.revision); break;
    }
    return json(result === undefined ? { ok: true } : result);
  } catch (error) {
    console.error("Budget request failed", error instanceof Error ? error.name : "UnknownError");
    if (error instanceof z.ZodError || error instanceof SyntaxError) return json({ error: "Invalid request. Check the supplied fields." }, 400);
    if (error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_")) return json({ error: "This operation conflicts with existing data. Refresh and check your entries." }, 409);
    return json({ error: error instanceof BankError ? error.code : error instanceof Error ? error.message : "The operation failed." }, 400);
  }
}
