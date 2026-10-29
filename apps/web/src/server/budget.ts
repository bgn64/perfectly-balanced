import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  dateSchema, sourceInputSchema, monthSchema, transactionSchema, pageSchema,
  centsSchema, validateSplit, recommend, type Transaction, type SourceInput, type AllocationInput,
} from "@balanced/domain";
import type { Command, Filters } from "@balanced/data";

const name = z.string().trim().min(1).max(100);
const uuid = z.string().uuid();
const month = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/).refine(m => Number(m.slice(0, 4)) > 0);
const amount = centsSchema.nonnegative();
export const commandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("section_add"), month, name }),
  ...(["section_attach", "category_attach", "remove_category", "remove_section"] as const).map(action => z.object({ action: z.literal(action), month, id: uuid })),
  z.object({ action: z.literal("category_add"), month, name, section_id: uuid, planned_cents: amount }),
  z.object({ action: z.literal("planned"), month, id: uuid, planned_cents: amount }),
  ...(["rename_category", "rename_section"] as const).map(action => z.object({ action: z.literal(action), month, id: uuid, name })),
  ...(["archive_category", "archive_section"] as const).map(action => z.object({ action: z.literal(action), id: uuid })),
  z.object({ action: z.literal("copy"), month, from_month: month }),
  z.object({ action: z.literal("reorder"), month, type: z.enum(["section", "category"]), id: uuid, position: z.number().int() }),
  sourceInputSchema.extend({ action: z.literal("manual") }),
  z.object({ action: z.literal("split"), id: uuid, allocations: z.array(z.object({ category_id: uuid.nullable(), amount_cents: centsSchema })).min(1).max(1000) }),
  z.object({ action: z.literal("date"), id: uuid, date: dateSchema.nullable() }),
  z.object({ action: z.literal("exclude"), id: uuid, excluded: z.boolean() }),
]);
export const filtersSchema = z.object({
  search: z.string().max(500), uncategorized: z.boolean(), excluded: z.enum(["hide", "include", "only"]),
  category: uuid.nullable(), offset: z.number().int().min(0), sort: z.enum(["date_desc", "date_asc", "amount_asc", "amount_desc"]),
});
const rowSchema = z.record(z.string(), z.unknown());
export class BudgetService {
  readonly db: Database.Database;
  readonly owner: string;
  constructor(db: Database.Database, owner: string) { this.db = db; this.owner = owner; }
  rows(sql: string, ...args: (string | number | null)[]) {
    return z.array(rowSchema).parse(this.db.prepare(sql).all(...args));
  }
  one(sql: string, ...args: (string | number | null)[]) {
    const row = this.db.prepare(sql).get(...args);
    if (!row) throw new Error("Budget entry not found.");
    return rowSchema.parse(row);
  }
  run(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).run(...args);
  }
  ensureMonth(value: string) {
    const m = `${month.parse(value)}-01`;
    this.run("INSERT INTO budget_sections(id,owner_id,name,kind) VALUES(?,?,'Income','income') ON CONFLICT DO NOTHING", randomUUID(), this.owner);
    const income = this.one("SELECT * FROM budget_sections WHERE owner_id=? AND kind='income'", this.owner);
    this.run("INSERT INTO monthly_budgets(id,owner_id,month) VALUES(?,?,?) ON CONFLICT DO NOTHING", randomUUID(), this.owner, m);
    const budget = this.one("SELECT id FROM monthly_budgets WHERE owner_id=? AND month=?", this.owner, m);
    const id = z.string().parse(budget.id);
    this.run("INSERT INTO monthly_budget_sections(owner_id,budget_id,section_id,name) VALUES(?,?,?,'Income') ON CONFLICT DO NOTHING", this.owner, id, z.string().parse(income.id));
    return id;
  }
  transactions(sql = "", ...args: (string | number | null)[]): Transaction[] {
    return this.rows(`SELECT * FROM transactions WHERE owner_id=? ${sql}`, this.owner, ...args).map(t => transactionSchema.parse({
      ...t, excluded: !!t.excluded, provider_removed: !!t.provider_removed,
      allocations: this.rows("SELECT * FROM transaction_allocations WHERE owner_id=? AND transaction_id=? ORDER BY id", this.owner, z.string().parse(t.id)),
      bank_accounts: this.rows(`SELECT DISTINCT c.institution_name AS institution,a.name,a.mask
        FROM bank_records r JOIN bank_connections c ON c.id=r.connection_id
        JOIN bank_accounts a ON a.connection_id=c.id AND a.account_id=json_extract(r.value,'$.account_id')
        WHERE r.owner_id=? AND r.transaction_id=?`, this.owner, z.string().parse(t.id)),
    }));
  }
  transaction(id: string) {
    const t = this.transactions("AND id=?", uuid.parse(id))[0];
    if (!t) throw new Error("Transaction not found.");
    return t;
  }
  month(value: string) {
    return this.db.transaction(() => {
      const bid = this.ensureMonth(value);
      return monthSchema.parse({
        sections: this.rows("SELECT * FROM budget_sections WHERE owner_id=? ORDER BY position,id", this.owner).map(s => ({ ...s, archived: !!s.archived })),
        categories: this.rows("SELECT * FROM categories WHERE owner_id=? ORDER BY name,id", this.owner).map(c => ({ ...c, archived: !!c.archived })),
        budget_sections: this.rows("SELECT * FROM monthly_budget_sections WHERE owner_id=? AND budget_id=? ORDER BY position,section_id", this.owner, bid),
        budget_categories: this.rows("SELECT * FROM monthly_budget_categories WHERE owner_id=? AND budget_id=? ORDER BY position,category_id", this.owner, bid),
        transactions: this.transactions("AND substr(effective_date,1,7)=? AND excluded=0 AND provider_removed=0 ORDER BY effective_date DESC,id", value),
      });
    }).immediate();
  }
  page(value: string, input: Filters) {
    month.parse(value);
    const f = filtersSchema.parse(input);
    const sort = { date_desc: "effective_date DESC", date_asc: "effective_date ASC", amount_asc: "amount_cents ASC", amount_desc: "amount_cents DESC" }[f.sort];
    const where = `AND substr(effective_date,1,7)=? AND (?='include' OR excluded=?) AND
      instr(lower(description||' '||merchant),lower(?))>0 AND
      (?=0 OR EXISTS(SELECT 1 FROM transaction_allocations a WHERE a.transaction_id=transactions.id AND a.category_id IS NULL)) AND
      (? IS NULL OR EXISTS(SELECT 1 FROM transaction_allocations a WHERE a.transaction_id=transactions.id AND a.category_id=?))`;
    const args = [value, f.excluded, f.excluded === "only" ? 1 : 0, f.search, f.uncategorized ? 1 : 0, f.category, f.category];
    const total = this.one(`SELECT count(*) AS total FROM transactions WHERE owner_id=? ${where}`, this.owner, ...args).total;
    return pageSchema.parse({ total, items: this.transactions(`${where} ORDER BY ${sort},id LIMIT 30 OFFSET ?`, ...args, f.offset) });
  }
  put(input: SourceInput, source = "manual", sourceId: string | null = null) {
    const row = sourceInputSchema.parse(input), id = randomUUID();
    this.run(`INSERT INTO transactions(id,owner_id,description,merchant,amount_cents,original_date,source,source_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, id, this.owner, row.description, row.merchant, row.amount_cents, row.original_date, source, sourceId, new Date().toISOString());
    this.run("INSERT INTO transaction_allocations(id,owner_id,transaction_id,amount_cents) VALUES(?,?,?,?)", randomUUID(), this.owner, id, row.amount_cents);
    return id;
  }
  split(id: string, allocations: AllocationInput[]) {
    const t = this.transaction(id);
    validateSplit(t.amount_cents, allocations);
    for (const a of allocations) {
      if (a.category_id) {
        const c = this.one("SELECT c.archived,s.archived AS section_archived FROM categories c JOIN budget_sections s ON s.id=c.section_id WHERE c.owner_id=? AND c.id=?", this.owner, a.category_id);
        if ((c.archived || c.section_archived) && !t.allocations.some(old => old.category_id === a.category_id)) throw new Error("Category unavailable.");
      }
    }
    this.run("DELETE FROM transaction_allocations WHERE owner_id=? AND transaction_id=?", this.owner, id);
    for (const a of allocations) this.run("INSERT INTO transaction_allocations(id,owner_id,transaction_id,category_id,amount_cents) VALUES(?,?,?,?,?)", randomUUID(), this.owner, id, a.category_id, a.amount_cents);
    this.run("UPDATE transactions SET revision=revision+1 WHERE owner_id=? AND id=?", this.owner, id);
  }
  mutate(input: Command) {
    const c = commandSchema.parse(input);
    return this.db.transaction(() => {
      const bid = "month" in c ? this.ensureMonth(c.month) : "";
      const section = (id: string) => this.one("SELECT * FROM budget_sections WHERE owner_id=? AND id=?", this.owner, id);
      const category = (id: string) => this.one("SELECT c.*,s.archived AS section_archived FROM categories c JOIN budget_sections s ON s.id=c.section_id WHERE c.owner_id=? AND c.id=?", this.owner, id);
      const attachSection = (id: string) => {
        const s = section(id);
        if (s.archived) throw new Error("Active section not found.");
        this.run("INSERT INTO monthly_budget_sections(owner_id,budget_id,section_id,name,position) VALUES(?,?,?,?,?)", this.owner, bid, id, z.string().parse(s.name), z.number().parse(s.position));
      };
      switch (c.action) {
        case "section_add": {
          const id = randomUUID(), position = z.number().parse(this.one("SELECT coalesce(max(position),0)+1 AS n FROM budget_sections WHERE owner_id=?", this.owner).n);
          this.run("INSERT INTO budget_sections(id,owner_id,name,kind,position) VALUES(?,?,?,'spending',?)", id, this.owner, c.name, position);
          attachSection(id); break;
        }
        case "section_attach": attachSection(c.id); break;
        case "category_add": {
          const s = section(c.section_id);
          if (s.archived) throw new Error("Active section not found.");
          const id = randomUUID();
          this.run("INSERT INTO categories(id,owner_id,section_id,name) VALUES(?,?,?,?)", id, this.owner, c.section_id, c.name);
          const position = z.number().parse(this.one("SELECT coalesce(max(position),0)+1 AS n FROM monthly_budget_categories WHERE budget_id=? AND section_id=?", bid, c.section_id).n);
          this.run("INSERT INTO monthly_budget_categories(owner_id,budget_id,category_id,section_id,name,planned_cents,position) VALUES(?,?,?,?,?,?,?)", this.owner, bid, id, c.section_id, c.name, c.planned_cents, position); break;
        }
        case "category_attach": {
          const cat = category(c.id), sid = z.string().parse(cat.section_id);
          if (cat.archived || cat.section_archived) throw new Error("Active category not found.");
          if (!this.rows("SELECT 1 FROM monthly_budget_sections WHERE budget_id=? AND section_id=?", bid, sid).length) attachSection(sid);
          const position = z.number().parse(this.one("SELECT coalesce(max(position),0)+1 AS n FROM monthly_budget_categories WHERE budget_id=? AND section_id=?", bid, sid).n);
          this.run("INSERT INTO monthly_budget_categories(owner_id,budget_id,category_id,section_id,name,position) VALUES(?,?,?,?,?,?)", this.owner, bid, c.id, sid, z.string().parse(cat.name), position); break;
        }
        case "planned":
          if (!this.run("UPDATE monthly_budget_categories SET planned_cents=? WHERE owner_id=? AND budget_id=? AND category_id=?", c.planned_cents, this.owner, bid, c.id).changes) throw new Error("Monthly category not found.");
          break;
        case "rename_section": case "rename_category": {
          const isSection = c.action === "rename_section", entry = isSection ? section(c.id) : category(c.id);
          if (isSection && entry.kind === "income") throw new Error("The Income section is permanent.");
          const table = isSection ? "sections" : "categories", key = isSection ? "section_id" : "category_id";
          if (!this.run(`UPDATE monthly_budget_${table} SET name=? WHERE owner_id=? AND budget_id=? AND ${key}=?`, c.name, this.owner, bid, c.id).changes) throw new Error("Budget entry not found.");
          this.run(`UPDATE ${isSection ? "budget_sections" : "categories"} SET name=? WHERE owner_id=? AND id=?`, c.name, this.owner, c.id); break;
        }
        case "archive_section": case "archive_category": {
          const isSection = c.action === "archive_section", entry = isSection ? section(c.id) : category(c.id);
          if (entry.kind === "income") throw new Error("The Income section is permanent.");
          this.run(`UPDATE ${isSection ? "budget_sections" : "categories"} SET archived=1 WHERE owner_id=? AND id=?`, this.owner, c.id); break;
        }
        case "remove_category": {
          if (this.rows(`SELECT 1 FROM transaction_allocations a JOIN transactions t ON t.id=a.transaction_id
            WHERE a.owner_id=? AND a.category_id=? AND substr(t.effective_date,1,7)=?`, this.owner, c.id, c.month).length) throw new Error("Reassign all transactions before removing this category.");
          if (!this.run("DELETE FROM monthly_budget_categories WHERE owner_id=? AND budget_id=? AND category_id=?", this.owner, bid, c.id).changes) throw new Error("Monthly category not found.");
          break;
        }
        case "remove_section":
          if (section(c.id).kind === "income") throw new Error("The Income section is permanent.");
          if (this.rows("SELECT 1 FROM monthly_budget_categories WHERE budget_id=? AND section_id=?", bid, c.id).length) throw new Error("Remove the section's categories first.");
          if (!this.run("DELETE FROM monthly_budget_sections WHERE owner_id=? AND budget_id=? AND section_id=?", this.owner, bid, c.id).changes) throw new Error("Monthly section not found.");
          break;
        case "copy": {
          if (this.rows("SELECT 1 FROM monthly_budget_categories WHERE budget_id=?", bid).length || this.rows("SELECT 1 FROM monthly_budget_sections WHERE budget_id=? AND section_id IN(SELECT id FROM budget_sections WHERE kind='spending')", bid).length) throw new Error("Copy requires an empty destination.");
          const source = this.one("SELECT id FROM monthly_budgets WHERE owner_id=? AND month=?", this.owner, `${c.from_month}-01`);
          const sourceId = z.string().parse(source.id);
          this.run(`INSERT INTO monthly_budget_sections SELECT owner_id,?,section_id,name,position FROM monthly_budget_sections
            WHERE budget_id=? AND section_id IN(SELECT id FROM budget_sections WHERE archived=0) ON CONFLICT DO NOTHING`, bid, sourceId);
          this.run(`INSERT INTO monthly_budget_categories SELECT owner_id,?,category_id,section_id,name,planned_cents,position FROM monthly_budget_categories
            WHERE budget_id=? AND category_id IN(SELECT id FROM categories WHERE archived=0)
            AND section_id IN(SELECT id FROM budget_sections WHERE archived=0)`, bid, sourceId); break;
        }
        case "reorder": {
          const isSection = c.type === "section", table = isSection ? "monthly_budget_sections" : "monthly_budget_categories", key = isSection ? "section_id" : "category_id";
          const current = this.one(`SELECT * FROM ${table} WHERE owner_id=? AND budget_id=? AND ${key}=?`, this.owner, bid, c.id);
          if (isSection && section(c.id).kind === "income") throw new Error("The Income section is permanent.");
          const entries = this.rows(`SELECT * FROM ${table} WHERE owner_id=? AND budget_id=? ${isSection ? "AND section_id IN(SELECT id FROM budget_sections WHERE kind='spending')" : "AND section_id=?"} ORDER BY position,${key}`, this.owner, bid, ...(isSection ? [] : [z.string().parse(current.section_id)]));
          const index = entries.findIndex(e => e[key] === c.id), next = index + (c.position < Number(current.position) ? -1 : 1);
          if (next >= 0 && next < entries.length) [entries[index], entries[next]] = [entries[next], entries[index]];
          entries.forEach((entry, i) => this.run(`UPDATE ${table} SET position=? WHERE budget_id=? AND ${key}=?`, i + 1, bid, z.string().parse(entry[key]))); break;
        }
        case "manual": this.put(c); break;
        case "split": this.split(c.id, c.allocations); break;
        case "date": case "exclude":
          this.transaction(c.id);
          this.run(`UPDATE transactions SET ${c.action === "date" ? "date_override" : "excluded"}=?,revision=revision+1 WHERE owner_id=? AND id=?`, c.action === "date" ? c.date : Number(c.excluded), this.owner, c.id); break;
      }
    }).immediate();
  }
  suggest(t: Transaction, data: ReturnType<BudgetService["month"]>) {
    this.transaction(t.id);
    return recommend(t, this.transactions("AND id<>? AND excluded=0 AND provider_removed=0", t.id), data.categories.filter(c => !data.sections.find(s => s.id === c.section_id)?.archived));
  }
  preview(fingerprint: string, input: SourceInput[]) {
    z.string().regex(/^[a-f0-9]{64}$/).parse(fingerprint);
    const rows = z.array(sourceInputSchema).max(1000).parse(input);
    return {
      repeated: !!this.rows("SELECT 1 FROM import_batches WHERE owner_id=? AND fingerprint=?", this.owner, fingerprint).length,
      duplicates: rows.flatMap((r, i) => {
        const exact = !!r.external_id && !!this.rows("SELECT 1 FROM transactions WHERE owner_id=? AND source='csv' AND source_id=?", this.owner, r.external_id).length;
        const similar = this.rows("SELECT 1 FROM transactions WHERE owner_id=? AND original_date=? AND amount_cents=? AND description=?", this.owner, r.original_date, r.amount_cents, r.description).length;
        return exact || similar ? [{ row: i + 1, exact }] : [];
      }),
    };
  }
  import(fingerprint: string, input: SourceInput[]) {
    const rows = z.array(sourceInputSchema).min(1).max(1000).parse(input);
    z.string().regex(/^[a-f0-9]{64}$/).parse(fingerprint);
    this.db.transaction(() => {
      if (this.preview(fingerprint, rows).repeated) throw new Error("Duplicate import.");
      this.run("INSERT INTO import_batches(id,owner_id,fingerprint,created_at) VALUES(?,?,?,?)", randomUUID(), this.owner, fingerprint, new Date().toISOString());
      rows.forEach((r, i) => this.put(r, "csv", r.external_id || `${fingerprint}:${i + 1}`));
    }).immediate();
  }
  demo(value: string) {
    this.db.transaction(() => {
      const bid = this.ensureMonth(value), fingerprint = `demo-v1:${value}`;
      if (this.rows("SELECT 1 FROM import_batches WHERE owner_id=? AND fingerprint=?", this.owner, fingerprint).length) throw new Error("Demo data has already been loaded.");
      if (this.rows("SELECT 1 FROM monthly_budget_categories WHERE budget_id=?", bid).length || this.transactions("AND substr(effective_date,1,7)=?", value).length) throw new Error("Load demo data into an empty month only.");
      this.run("INSERT INTO import_batches(id,owner_id,fingerprint,created_at) VALUES(?,?,?,?)", randomUUID(), this.owner, fingerprint, new Date().toISOString());
      let groceries = "";
      for (const [sectionName, categoryName, planned, actual, merchant] of [
        ["Income", "Salary", 420000, 420000, "Demo employer"], ["Essentials", "Housing", 150000, -150000, "Demo landlord"],
        ["Essentials", "Groceries", 45000, -8234, "Demo market"], ["Lifestyle", "Dining", 20000, -4850, "Demo cafe"],
        ["Lifestyle", "Entertainment", 10000, -1599, "Demo cinema"],
      ] as const) {
        let s = this.rows("SELECT id FROM budget_sections WHERE owner_id=? AND name=? AND archived=0", this.owner, sectionName)[0];
        if (!s) { this.mutate({ action: "section_add", month: value, name: sectionName }); s = this.one("SELECT id FROM budget_sections WHERE owner_id=? AND name=? AND archived=0", this.owner, sectionName); }
        const sid = z.string().parse(s.id);
        this.run("INSERT INTO monthly_budget_sections(owner_id,budget_id,section_id,name) VALUES(?,?,?,?) ON CONFLICT DO NOTHING", this.owner, bid, sid, sectionName);
        this.mutate({ action: "category_add", month: value, section_id: sid, name: categoryName, planned_cents: planned });
        const cid = z.string().parse(this.one("SELECT id FROM categories WHERE owner_id=? AND section_id=? AND name=?", this.owner, sid, categoryName).id);
        const descriptions: Record<string, string> = { Salary: "October payroll", Housing: "Rent", Groceries: "Weekly groceries", Dining: "Dinner with friends", Entertainment: "Movie night" };
        const tid = this.put({ description: `Demo: ${descriptions[categoryName]}`, merchant, original_date: `${value}-01`, amount_cents: actual }, "demo", `${value}:${cid}`);
        this.split(tid, [{ category_id: cid, amount_cents: actual }]);
        if (categoryName === "Groceries") groceries = cid;
      }
      this.put({ description: "Demo: More groceries", merchant: "Demo market", original_date: `${value}-02`, amount_cents: -6575 }, "demo", `${value}:uncategorized`);
      const tid = this.put({ description: "Demo: Refund", merchant: "Demo market", original_date: `${value}-03`, amount_cents: 1250 }, "demo", `${value}:refund`);
      this.split(tid, [{ category_id: groceries, amount_cents: 1250 }]);
    }).immediate();
  }
}
