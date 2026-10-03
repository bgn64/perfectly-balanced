import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { SupabaseRepository, makeClient } from "@balanced/data";
import { monthSchema, reports } from "@balanced/domain";
import type { Database } from "../../packages/data/src/database.types";

const config = z.object({ API_URL: z.string(), ANON_KEY: z.string(), SERVICE_ROLE_KEY: z.string() })
  .parse(JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8" })));
const admin = createClient<Database>(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const ids: string[] = [];
let a: SupabaseRepository, b: SupabaseRepository, aClient: SupabaseClient<Database>;
let sectionId: string, categoryId: string, transactionId: string;
beforeAll(async () => {
  for (const name of ["a", "b"]) {
    const email = `integration-${name}-${crypto.randomUUID()}@example.test`;
    const password = `test-${crypto.randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(error?.message ?? "Could not create test user");
    ids.push(data.user.id);
    const client = makeClient(config.API_URL, config.ANON_KEY);
    const auth = await client.auth.signInWithPassword({ email, password });
    if (auth.error) throw new Error(auth.error.message);
    if (name === "a") { aClient = client; a = new SupabaseRepository(client); }
    else b = new SupabaseRepository(client);
  }
});
afterAll(async () => {
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) throw new Error(`Test cleanup failed: ${error.message}`);
  }
});
describe("real Supabase financial workflows", () => {
  it("initializes fixed Income and creates a monthly budget", async () => {
    const initial = await a.month("2026-10");
    expect(initial.sections.filter(s => s.kind === "income")).toHaveLength(1);
    await a.mutate({ action: "section_add", month: "2026-10", name: "Living" });
    sectionId = (await a.month("2026-10")).sections.find(s => s.name === "Living")!.id;
    await a.mutate({ action: "category_add", month: "2026-10", section_id: sectionId, name: "Food", planned_cents: 15000 });
    categoryId = (await a.month("2026-10")).categories[0].id;
    await expect(a.mutate({ action: "remove_section", month: "2026-10", id: initial.sections[0].id })).rejects.toThrow(/permanent/i);
  });
  it("persists mixed-sign splits, net totals, and recommendation history", async () => {
    await a.mutate({ action: "manual", original_date: "2026-10-31", description: "Market", merchant: "Market", amount_cents: -10000 });
    const t = (await a.month("2026-10")).transactions[0]; transactionId = t.id;
    await expect(a.mutate({ action: "split", id: t.id, allocations: [{ category_id: categoryId, amount_cents: -9999 }] })).rejects.toThrow(/sum exactly/i);
    await a.mutate({ action: "split", id: t.id, allocations: [{ category_id: categoryId, amount_cents: -12000 }, { category_id: null, amount_cents: 2000 }] });
    const state = await a.month("2026-10");
    expect(reports(state, "spending", false, true)[0].value).toBe(12000);
    expect(reports(state, "income", false, true)[0].value).toBe(2000);
    expect(reports(state, "income", false, false)).toEqual([]);
    await expect(a.mutate({ action: "remove_category", month: "2026-10", id: categoryId })).rejects.toThrow(/Reassign/);
  });
  it("excludes and restores complete parents and retains assignments on date moves", async () => {
    await a.mutate({ action: "exclude", id: transactionId, excluded: true });
    expect((await a.month("2026-10")).transactions).toEqual([]);
    const page = await a.page("2026-10", { search: "Market", category: null, uncategorized: true, excluded: "only", offset: 0, sort: "date_desc" });
    expect(page.total).toBe(1);
    await a.mutate({ action: "exclude", id: transactionId, excluded: false });
    await a.mutate({ action: "date", id: transactionId, date: "2026-11-01" });
    expect((await a.month("2026-10")).transactions).toEqual([]);
    const next = await a.month("2026-11");
    expect(next.transactions[0].original_date).toBe("2026-10-31");
    expect(next.transactions[0].allocations.some(x => x.category_id === categoryId)).toBe(true);
    expect(reports(next, "spending", false, true)[0].name).toBe("Unplanned");
    await a.mutate({ action: "date", id: transactionId, date: null });
  });
  it("copies snapshots without rollover and rejects overwriting populated months", async () => {
    await a.mutate({ action: "copy", month: "2026-12", from_month: "2026-10" });
    const copied = await a.month("2026-12");
    expect(copied.budget_categories[0].planned_cents).toBe(15000);
    expect(copied.transactions).toEqual([]);
    await a.mutate({ action: "rename_category", month: "2026-10", id: categoryId, name: "Groceries" });
    expect((await a.month("2026-12")).budget_categories[0].name).toBe("Food");
    await expect(a.mutate({ action: "copy", month: "2026-12", from_month: "2026-10" })).rejects.toThrow(/empty destination/i);
    await a.mutate({ action: "section_add", month: "2026-10", name: "Lifestyle" });
    const before = await a.month("2026-10");
    const added = before.budget_sections.find(s => s.name === "Lifestyle")!;
    await a.mutate({ action: "reorder", month: "2026-10", type: "section", id: added.section_id, position: added.position - 1 });
    expect((await a.month("2026-10")).budget_sections.map(s => s.name)).toEqual(["Income", "Lifestyle", "Living"]);
  });
  it("enforces per-user isolation for tables and every relevant mutation surface", async () => {
    expect((await b.month("2026-10")).categories).toEqual([]);
    const select = await b.client.from("transactions").select("*").eq("id", transactionId);
    expect(select.error).toBeNull(); expect(select.data).toEqual([]);
    await expect(b.mutate({ action: "exclude", id: transactionId, excluded: true })).rejects.toThrow(/not found/i);
    await expect(b.mutate({ action: "category_attach", month: "2026-10", id: categoryId })).rejects.toThrow(/not found/i);
    await expect(b.mutate({ action: "category_add", month: "2026-10", section_id: sectionId, name: "Other", planned_cents: 0 })).rejects.toThrow(/not found/i);
    const direct = await aClient.from("transactions").update({ excluded: true }).eq("id", transactionId);
    expect(direct.error).not.toBeNull();
    const history = await b.client.rpc("app_history", { p_id: transactionId });
    expect(history.error).not.toBeNull();
    const anon = makeClient(config.API_URL, config.ANON_KEY);
    expect((await anon.rpc("app_month", { p_month: "2026-10" })).error).not.toBeNull();
  });
  it("imports atomically with duplicate protection and reports preview matches", async () => {
    const rows = [{ original_date: "2026-10-01", description: "CSV purchase", merchant: "", amount_cents: -150, external_id: "unique-test-id" }];
    const fingerprint = "a".repeat(64);
    await a.import(fingerprint, rows);
    expect((await a.preview(fingerprint, rows)).repeated).toBe(true);
    expect((await a.preview("b".repeat(64), rows)).duplicates[0].exact).toBe(true);
    await expect(a.import(fingerprint, rows)).rejects.toThrow(/duplicate/i);
    await expect(a.import("b".repeat(64), [{ ...rows[0], external_id: "other-test-id" }, ...rows])).rejects.toThrow(/duplicate/i);
    const page = await a.page("2026-10", { search: "CSV", category: null, uncategorized: false, excluded: "include", offset: 0, sort: "amount_asc" });
    expect(page.total).toBe(1);
  });
  it("uses opt-in demo data idempotently and exposes valid typed responses", async () => {
    await b.demo("2026-12");
    const d = monthSchema.parse(await b.month("2026-12"));
    expect(d.transactions).toHaveLength(7);
    await expect(b.demo("2026-12")).rejects.toThrow(/already/);
    const target = d.transactions.find(t => t.description === "Demo: More groceries")!;
    expect((await b.suggest(target, d))?.category_id).toBe(d.categories.find(c => c.name === "Groceries")?.id);
    await b.mutate({ action: "manual", description: "Normalized match", merchant: " Demo market!! ", amount_cents: -100, original_date: "2026-12-04" });
    const normalized = (await b.month("2026-12")).transactions.find(t => t.description === "Normalized match")!;
    expect((await b.suggest(normalized, d))?.category_id).toBe(d.categories.find(c => c.name === "Groceries")?.id);
    await b.mutate({ action: "archive_category", id: d.categories.find(c => c.name === "Groceries")!.id });
    expect(await b.suggest(target, await b.month("2026-12"))).toBeNull();
  });
});
