import { betterAuth, type BetterAuthOptions } from "better-auth";
import { database } from "./database.ts";
import type Database from "better-sqlite3";

export function authOptions(db: Database.Database): BetterAuthOptions {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 random characters.");
  if (!baseURL) throw new Error("BETTER_AUTH_URL must be the canonical application origin.");
  const url = new URL(baseURL);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== baseURL) throw new Error("BETTER_AUTH_URL must be an HTTP(S) origin without a trailing slash.");
  if (process.env.APP_ENV === "server" && url.protocol !== "https:") throw new Error("Home-server deployment requires an HTTPS canonical origin.");
  return {
    appName: "Perfectly Balanced", database: db, secret, baseURL,
    trustedOrigins: [baseURL],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
    advanced: { database: { generateId: () => crypto.randomUUID() } },
    rateLimit: { enabled: true, storage: "database" },
  };
}
let instance: ReturnType<typeof betterAuth> | undefined;
export function auth() {
  instance ??= betterAuth(authOptions(database()));
  return instance;
}
export async function authHandler(request: Request, instance = auth()) {
  if (request.method !== "GET" && request.headers.get("origin") !== process.env.BETTER_AUTH_URL) {
    return Response.json({ error: "Origin denied." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const response = await instance.handler(request);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
