import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function openDatabase(path = process.env.DATABASE_PATH ?? "./data/perfectly-balanced.sqlite") {
  if (path !== ":memory:") mkdirSync(dirname(resolve(/* turbopackIgnore: true */ path)), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function migrate(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE);`);
  const version = db.prepare("SELECT max(version) AS version FROM schema_versions").get() as { version: number | null };
  if (version.version !== null && version.version > 1) throw new Error("Database was created by a newer application.");
  if (version.version === 1) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE budget_sections(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
        kind TEXT NOT NULL CHECK(kind IN ('income','spending')), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        position INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_id,id),
        CHECK(kind <> 'income' OR (name='Income' AND archived=0)));
      CREATE UNIQUE INDEX one_income ON budget_sections(owner_id) WHERE kind='income';
      CREATE TABLE categories(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, section_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        UNIQUE(owner_id,id), UNIQUE(owner_id,id,section_id),
        FOREIGN KEY(owner_id,section_id) REFERENCES budget_sections(owner_id,id));
      CREATE TABLE monthly_budgets(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), month TEXT NOT NULL,
        UNIQUE(owner_id,month), UNIQUE(owner_id,id));
      CREATE TABLE monthly_budget_sections(
        owner_id TEXT NOT NULL, budget_id TEXT NOT NULL, section_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100), position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(budget_id,section_id), UNIQUE(owner_id,budget_id,section_id),
        FOREIGN KEY(owner_id,budget_id) REFERENCES monthly_budgets(owner_id,id),
        FOREIGN KEY(owner_id,section_id) REFERENCES budget_sections(owner_id,id));
      CREATE TABLE monthly_budget_categories(
        owner_id TEXT NOT NULL, budget_id TEXT NOT NULL, category_id TEXT NOT NULL, section_id TEXT NOT NULL,
        name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
        planned_cents INTEGER NOT NULL DEFAULT 0 CHECK(typeof(planned_cents)='integer' AND planned_cents BETWEEN 0 AND 100000000000),
        position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(budget_id,category_id),
        FOREIGN KEY(owner_id,budget_id,section_id) REFERENCES monthly_budget_sections(owner_id,budget_id,section_id),
        FOREIGN KEY(owner_id,category_id,section_id) REFERENCES categories(owner_id,id,section_id));
      CREATE TABLE import_batches(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(owner_id,fingerprint));
      CREATE TABLE transactions(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
        description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 500),
        merchant TEXT NOT NULL DEFAULT '' CHECK(length(merchant)<=200),
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents<>0 AND amount_cents BETWEEN -100000000000 AND 100000000000),
        currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency='USD'), original_date TEXT NOT NULL, date_override TEXT,
        effective_date TEXT GENERATED ALWAYS AS (coalesce(date_override,original_date)) STORED,
        excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
        provider_removed INTEGER NOT NULL DEFAULT 0 CHECK(provider_removed IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL CHECK(source IN ('manual','csv','demo','plaid')),
        source_id TEXT, created_at TEXT NOT NULL, UNIQUE(owner_id,id), UNIQUE(owner_id,source,source_id));
      CREATE INDEX transaction_month ON transactions(owner_id,effective_date,id);
      CREATE TABLE transaction_allocations(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, transaction_id TEXT NOT NULL, category_id TEXT,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents<>0 AND amount_cents BETWEEN -100000000000 AND 100000000000),
        FOREIGN KEY(owner_id,transaction_id) REFERENCES transactions(owner_id,id) ON DELETE CASCADE,
        FOREIGN KEY(owner_id,category_id) REFERENCES categories(owner_id,id));
      CREATE INDEX allocation_parent ON transaction_allocations(transaction_id);
      CREATE INDEX allocation_category ON transaction_allocations(owner_id,category_id);
      CREATE TRIGGER immutable_section BEFORE UPDATE OF owner_id,kind ON budget_sections
        WHEN NEW.owner_id<>OLD.owner_id OR NEW.kind<>OLD.kind BEGIN SELECT RAISE(ABORT,'Section classification and ownership are immutable'); END;
      CREATE TRIGGER permanent_income BEFORE DELETE ON budget_sections WHEN OLD.kind='income'
        BEGIN SELECT RAISE(ABORT,'The Income section is permanent'); END;
      CREATE TRIGGER immutable_category BEFORE UPDATE OF owner_id,section_id ON categories
        WHEN NEW.owner_id<>OLD.owner_id OR NEW.section_id<>OLD.section_id BEGIN SELECT RAISE(ABORT,'Category section and ownership are immutable'); END;
      CREATE TABLE bank_connections(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), item_id TEXT NOT NULL UNIQUE,
        token TEXT, environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')), institution_name TEXT NOT NULL,
        import_start TEXT NOT NULL, status TEXT NOT NULL, cursor TEXT, page_cursor TEXT, lease TEXT, lease_until INTEGER,
        due_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, connected_at TEXT NOT NULL, last_synced_at TEXT, error_code TEXT,
        initial_complete INTEGER NOT NULL DEFAULT 0, historical_complete INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_id,id));
      CREATE TABLE bank_accounts(
        connection_id TEXT NOT NULL REFERENCES bank_connections(id), account_id TEXT NOT NULL,
        name TEXT NOT NULL, mask TEXT, type TEXT NOT NULL, subtype TEXT, selected INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(connection_id,account_id));
      CREATE TABLE bank_records(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, connection_id TEXT NOT NULL, source_id TEXT NOT NULL,
        value TEXT, error TEXT, removed INTEGER NOT NULL DEFAULT 0, transaction_id TEXT,
        state TEXT NOT NULL DEFAULT 'new', version INTEGER NOT NULL DEFAULT 1, reason TEXT, candidates TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY(owner_id,connection_id) REFERENCES bank_connections(owner_id,id),
        FOREIGN KEY(owner_id,transaction_id) REFERENCES transactions(owner_id,id), UNIQUE(connection_id,source_id));
      CREATE TABLE bank_staging(
        connection_id TEXT NOT NULL REFERENCES bank_connections(id), source_id TEXT NOT NULL,
        value TEXT, error TEXT, removed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(connection_id,source_id));
      CREATE TABLE bank_intents(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), import_start TEXT NOT NULL,
        created_at INTEGER NOT NULL, connection_id TEXT REFERENCES bank_connections(id), exchanging INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE bank_audit(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
        record_id TEXT, decision TEXT NOT NULL, before_value TEXT, after_value TEXT, created_at TEXT NOT NULL);
      CREATE TABLE bank_requests(owner_id TEXT NOT NULL REFERENCES owners(id),created_at INTEGER NOT NULL);
      CREATE TABLE source_imports(fingerprint TEXT PRIMARY KEY, mapping_hash TEXT NOT NULL, imported_at TEXT NOT NULL);
      CREATE TABLE historical_provider_data(table_name TEXT NOT NULL, row_id TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(table_name,row_id));
      INSERT INTO schema_versions(version) VALUES(1);
    `);
  }).immediate();
}

let singleton: Database.Database | undefined;
export function database() {
  singleton ??= openDatabase();
  return singleton;
}
