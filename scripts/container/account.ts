import { betterAuth } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { openDatabase } from "../../apps/web/src/server/database.ts";
import { authOptions } from "../../apps/web/src/server/auth.ts";

export async function createAccount(db: ReturnType<typeof openDatabase>, input: { name: string; email: string; password: string; id?: string }) {
  const data = z.object({ name: z.string().trim().min(1), email: z.email().transform(e => e.toLowerCase()), password: z.string().min(12).max(128), id: z.string().uuid().optional() }).parse(input);
  const options = authOptions(db);
  if (data.id && db.prepare('SELECT 1 FROM "user" WHERE id=?').get(data.id)) throw new Error("Owner UUID already exists.");
  const provision = betterAuth({
    ...options,
    advanced: { ...options.advanced, database: { generateId: ({ model }) => model === "user" && data.id ? data.id : crypto.randomUUID() } },
    emailAndPassword: { ...options.emailAndPassword, enabled: true, disableSignUp: false },
  });
  const result = await provision.api.signUpEmail({ body: data });
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM session WHERE "userId"=?').run(result.user.id);
      db.prepare("INSERT INTO owners(id,email) VALUES(?,?)").run(result.user.id, result.user.email);
    }).immediate();
  } catch (error) {
    db.prepare('DELETE FROM "user" WHERE id=?').run(result.user.id);
    throw error;
  }
  return result.user;
}
export async function resetPassword(db: ReturnType<typeof openDatabase>, email: string, password: string) {
  z.string().min(12).max(128).parse(password);
  const user = db.prepare('SELECT id FROM "user" WHERE lower(email)=lower(?)').get(z.email().parse(email)) as { id: string } | undefined;
  if (!user) throw new Error("Account not found.");
  const hash = await hashPassword(password);
  db.transaction(() => {
    if (!db.prepare('UPDATE account SET password=?, "updatedAt"=? WHERE "userId"=? AND "providerId"=\'credential\'').run(hash, Date.now(), user.id).changes) throw new Error("Password account not found.");
    db.prepare('DELETE FROM session WHERE "userId"=?').run(user.id);
  }).immediate();
}
async function passwordPrompt(label: string) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Use an interactive terminal for password entry.");
  stdout.write(label);
  stdin.setRawMode(true); stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const read = (input: Buffer) => {
        for (const char of input.toString("utf8")) {
          if (char === "\u0003") { stdin.off("data", read); reject(new Error("Canceled.")); return; }
          if (char === "\r" || char === "\n") { stdin.off("data", read); resolve(value); return; }
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else if (char >= " ") value += char;
        }
      };
      stdin.on("data", read);
    });
  } finally { stdin.setRawMode(false); stdin.pause(); stdout.write("\n"); }
}
async function main() {
  const mode = process.argv[2];
  if (!["create", "reset"].includes(mode)) throw new Error("Usage: account.ts create|reset");
  if (!stdin.isTTY) throw new Error("Run this command interactively, for example docker compose exec app npm run account:create.");
  const rl = createInterface({ input: stdin, output: stdout });
  const email = await rl.question("Email: ");
  const name = mode === "create" ? await rl.question("Name: ") : "";
  const id = mode === "create" ? await rl.question("Existing financial owner UUID (blank for a new account): ") : "";
  rl.close();
  const password = await passwordPrompt("Password (12-128 characters, hidden): ");
  if (password !== await passwordPrompt("Confirm password: ")) throw new Error("Passwords do not match.");
  const db = openDatabase();
  try {
    if (mode === "create") await createAccount(db, { email, name, password, ...(id ? { id } : {}) });
    else await resetPassword(db, email, password);
    console.log("Account updated. Existing sessions have been revoked.");
  } finally { db.close(); }
}
if (process.argv[1]?.endsWith("account.ts")) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Account command failed."); process.exitCode = 1; });
}
