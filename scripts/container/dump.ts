import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export type DumpRow = Record<string, string | null>;
export type Dump = { tables: Record<string, DumpRow[]>; columns: Record<string, string[]> };
function identifier(value: string) {
  const trimmed = value.trim();
  if (/^"(?:[^"]|"")+"$/.test(trimmed)) return trimmed.slice(1, -1).replaceAll('""', '"');
  if (/^[a-z_][a-z0-9_]*$/i.test(trimmed)) return trimmed.toLowerCase();
  throw new Error("Unsupported SQL identifier in backup.");
}
function field(value: string): string | null {
  if (value === "\\N") return null;
  return value.replace(/\\(x[0-9a-f]{1,2}|[0-7]{1,3}|.)/gi, (_all, code: string) => {
    if (/^x[0-9a-f]+$/i.test(code)) return String.fromCharCode(parseInt(code.slice(1), 16));
    if (/^[0-7]+$/.test(code)) return String.fromCharCode(parseInt(code, 8));
    return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" } as Record<string, string>)[code] ?? code;
  });
}
export function parseDump(text: string): Dump {
  const result: Dump = { tables: {}, columns: {} };
  let statement = "", single = false, double = false, dollar = "", block = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (dollar) {
      if (text.startsWith(dollar, i)) { i += dollar.length - 1; dollar = ""; }
      continue;
    }
    if (block) {
      if (ch === "/" && next === "*") { block++; i++; }
      else if (ch === "*" && next === "/") { block--; i++; }
      continue;
    }
    if (!single && !double && ch === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      statement += " "; continue;
    }
    if (!single && !double && ch === "/" && next === "*") { block = 1; statement += " "; i++; continue; }
    if (!single && !double && ch === "\\") {
      // pg_dump psql guards are not SQL statements or import instructions.
      if (/^\\(?:un)?restrict\b/.test(text.slice(i))) {
        const end = text.indexOf("\n", i); i = end < 0 ? text.length : end; continue;
      }
    }
    if (!single && !double && ch === "$") {
      const match = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(text.slice(i));
      if (match) { dollar = match[0]; i += dollar.length - 1; statement += "''"; continue; }
    }
    statement += ch;
    if (single) {
      if (ch === "'" && next === "'") { statement += next; i++; }
      else if (ch === "'") single = false;
      else if (ch === "\\" && next) { statement += next; i++; }
      continue;
    }
    if (double) {
      if (ch === '"' && next === '"') { statement += next; i++; }
      else if (ch === '"') double = false;
      continue;
    }
    if (ch === "'") { single = true; continue; }
    if (ch === '"') { double = true; continue; }
    if (ch !== ";") continue;
    if (/^\s*INSERT\s+INTO\b/i.test(statement)) throw new Error("INSERT backups are not supported. Export with --data-only --use-copy.");
    if (/^\s*COPY\b/i.test(statement)) {
      const id = '(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_]*)';
      const match = new RegExp(`^\\s*COPY\\s+(${id})\\.(${id})\\s*\\(([^)]+)\\)\\s+FROM\\s+stdin\\s*;\\s*$`, "i").exec(statement);
      if (!match) throw new Error("Unsupported COPY header. Use an unmodified pg_dump COPY backup.");
      const table = `${identifier(match[1])}.${identifier(match[2])}`;
      const columns = match[3].split(",").map(identifier);
      if (new Set(columns).size !== columns.length) throw new Error(`Duplicate COPY columns: ${table}.`);
      if (result.columns[table] && JSON.stringify(result.columns[table]) !== JSON.stringify(columns)) throw new Error(`Inconsistent COPY columns: ${table}.`);
      result.columns[table] = columns;
      result.tables[table] ??= [];
      if (text[i + 1] === "\r") i++;
      if (text[i + 1] !== "\n") throw new Error(`Missing COPY data newline: ${table}.`);
      i += 2;
      let terminated = false;
      while (i < text.length) {
        let end = text.indexOf("\n", i);
        if (end < 0) end = text.length;
        const line = text.slice(i, end).replace(/\r$/, "");
        if (line === "\\.") { i = end; terminated = true; break; }
        const values = line.split("\t");
        if (values.length !== columns.length) throw new Error(`Invalid COPY row in ${table}: expected ${columns.length} fields.`);
        result.tables[table].push(Object.fromEntries(columns.map((column, j) => [column, field(values[j])])));
        i = end + 1;
      }
      if (!terminated) throw new Error(`Truncated COPY data: ${table}.`);
    }
    statement = "";
  }
  if (single || double || dollar || block) throw new Error("Truncated SQL backup.");
  if (!Object.keys(result.tables).length) throw new Error("No COPY data found. A schema-only dump does not contain financial data; export --data-only --use-copy.");
  return result;
}
export function readDump(path: string) {
  let input = readFileSync(path);
  if (input[0] === 0x1f && input[1] === 0x8b) input = gunzipSync(input);
  if (input.subarray(0, 5).toString() === "PGDMP") throw new Error("Convert custom-format backups locally using pg_restore --file=data.sql; never restore into production.");
  return parseDump(new TextDecoder("utf-8", { fatal: true }).decode(input));
}
