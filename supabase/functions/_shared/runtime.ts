import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "../../../packages/data/src/database.types.ts";

export class SafeError extends Error {
  constructor(readonly code: string, readonly status = 502) { super(code); }
}
export function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new SafeError("BACKEND_CONFIGURATION_MISSING", 503);
  return value;
}
export function configuration() {
  const environment = required("PLAID_ENVIRONMENT");
  const deployment = required("APP_DEPLOYMENT_ENV");
  const backend = new URL(required("SUPABASE_URL"));
  const origins = required("APP_ALLOWED_ORIGINS").split(",").map(v => new URL(v.trim()).origin);
  if (deployment === "local" && environment === "sandbox") {
    if (backend.protocol !== "http:" || !["kong", "127.0.0.1", "localhost", "host.docker.internal"].includes(backend.hostname) ||
      origins.some(v => !["127.0.0.1", "localhost"].includes(new URL(v).hostname))) throw new SafeError("UNSAFE_ENVIRONMENT", 503);
  } else if (deployment === "production" && environment === "production") {
    if (backend.protocol !== "https:" || !backend.hostname.endsWith(".supabase.co") ||
      origins.some(v => new URL(v).protocol !== "https:")) throw new SafeError("UNSAFE_ENVIRONMENT", 503);
  } else throw new SafeError("UNSAFE_ENVIRONMENT", 503);
  const redirect = Deno.env.get("PLAID_REDIRECT_URI")?.trim() || undefined;
  if (redirect) {
    const uri = new URL(redirect);
    if (!origins.includes(uri.origin) || uri.search || uri.hash || uri.pathname !== "/connections" ||
      uri.protocol !== "https:") throw new SafeError("INVALID_REDIRECT_URI", 503);
  } else if (environment === "production") throw new SafeError("INVALID_REDIRECT_URI", 503);
  const webhook = Deno.env.get("PLAID_WEBHOOK_URL")?.trim() || undefined;
  if (environment === "production" && (!webhook || new URL(webhook).protocol !== "https:")) throw new SafeError("INVALID_WEBHOOK_URL", 503);
  return { environment: z.enum(["sandbox", "production"]).parse(environment), origins, redirect, webhook };
}
export function service() {
  return createClient<Database>(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function admin(action: string, payload: Json) {
  const { data, error } = await service().rpc("plaid_admin", { p_action: action, p_payload: payload });
  if (error) {
    console.error("Plaid database operation failed", { action, code: error.code });
    throw new SafeError("DATABASE_OPERATION_FAILED", 409);
  }
  return data;
}
export async function authenticate(request: Request): Promise<string> {
  const token = request.headers.get("authorization");
  if (!token?.startsWith("Bearer ")) throw new SafeError("AUTHENTICATION_REQUIRED", 401);
  const client = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token.slice(7));
  if (error || !data.user) throw new SafeError("SESSION_EXPIRED", 401);
  return data.user.id;
}
export function report(error: unknown, context: string) {
  console.error(context, {
    code: error instanceof SafeError ? error.code : "INTERNAL_ERROR",
    name: error instanceof Error ? error.name : "UnknownError",
    fields: error instanceof z.ZodError ? error.issues.map(i => ({ path:i.path.join("."),code:i.code })) : undefined,
    frames: error instanceof Error ? error.stack?.split("\n").filter(line => /^\s+at /.test(line)).slice(0,4) : undefined,
  });
}
export function json(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}
export function failure(error: unknown, headers?: HeadersInit) {
  return json({ error: error instanceof SafeError ? error.code : "INTERNAL_ERROR" }, error instanceof SafeError ? error.status : 500, headers);
}
export async function limitedBody(request: Request, max = 65536) {
  if (!request.body) throw new SafeError("BODY_REQUIRED", 400);
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); throw new SafeError("BODY_TOO_LARGE", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function constantEqual(a: string, b: string) {
  let result = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return result === 0;
}
