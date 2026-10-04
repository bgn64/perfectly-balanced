import { z } from "zod";
import { configuration, required, SafeError } from "./runtime.ts";

export async function plaid(path: string, body: Record<string, unknown>): Promise<unknown> {
  const config = configuration();
  const response = await fetch(`https://${config.environment}.plaid.com/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, client_id: required("PLAID_CLIENT_ID"), secret: required("PLAID_SECRET") }),
    signal: AbortSignal.timeout(25000),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error_code: z.string().regex(/^[A-Z_]+$/) }).safeParse(data);
    throw new SafeError(parsed.success ? parsed.data.error_code : "PLAID_REQUEST_FAILED");
  }
  return data;
}
export const accountsResponse = z.object({ accounts: z.array(z.object({
  account_id: z.string().min(1), name: z.string().min(1).max(200), mask: z.string().nullable(),
  type: z.string(), subtype: z.string().nullable(),
})) });
export const tokenResponse = z.object({ access_token: z.string(), environment: z.enum(["sandbox", "production"]) });
export async function connectionToken(id: string, owner_id: string) {
  const { admin } = await import("./runtime.ts");
  const token = tokenResponse.parse(await admin("token", { id, owner_id }));
  if (token.environment !== configuration().environment) throw new SafeError("UNSAFE_ENVIRONMENT");
  return token.access_token;
}
