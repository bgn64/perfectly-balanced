import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, FileUp, Filter, Inbox, Plus, Search, Scissors } from "lucide-react";
import { money, parseCsv, parseMoney, type SourceInput, type Transaction } from "@balanced/domain";
import type { Filters, ImportPreview } from "@balanced/data";
import { text, useBudget, useOperation } from "../app/context";
import { ActionForm, EmptyState, Modal, useDraft } from "../components/ui";

import { CategorySelect, Suggestion, TransactionSheet } from "./TransactionDetails";

function TransactionRow({ transaction: t, open }: { transaction: Transaction; open: () => void }) {
  const { command } = useBudget();
  const op = useOperation();
  const multiple = t.allocations.length > 1;
  const unassigned = t.allocations.filter(a => !a.category_id);
  return <tr className={`transaction-row ${t.excluded || t.provider_removed ? "is-excluded" : ""}`} data-transaction-id={t.id}>
    <td className="transaction-date"><time dateTime={t.effective_date}>{t.effective_date.slice(5).replace("-", "/")}</time></td>
    <td className="transaction-description"><button className="description-button" onClick={open}>{t.description}</button><small>{t.merchant || "Manual activity"}{t.excluded && <span className="badge">Excluded</span>}{t.provider_removed && <span className="badge">Bank removed</span>}</small></td>
    <td className="transaction-category">{multiple ? <button className="split-category" onClick={open}><Scissors size={13} />{t.allocations.length} allocations{unassigned.length > 0 && <small>{money(unassigned.reduce((n, a) => n + a.amount_cents, 0))} uncategorized</small>}</button> :
      <CategorySelect label={`Category for ${t.description}`} value={t.allocations[0].category_id} disabled={op.pending} onChange={category_id => void op.run(() => command({ action: "split", id: t.id, allocations: [{ amount_cents: t.amount_cents, category_id }] }))} />}
      {t.allocations.map((a, i) => !a.category_id && <Suggestion key={a.id} transaction={t} allocationIndex={i} />)}{op.feedback}
    </td><td className={`transaction-amount number ${t.amount_cents > 0 ? "positive" : ""}`}>{money(t.amount_cents)}</td>
    <td className="transaction-open"><button className="icon-button" aria-label={`Open ${t.description} details`} onClick={open}><ArrowRight size={17} /></button></td>
  </tr>;
}
function CsvImport({ close }: { close: () => void }) {
  const { repo, refresh, notify } = useBudget();
  const op = useOperation();
  const [rows, setRows] = useState<SourceInput[]>([]);
  const [fingerprint, setFingerprint] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  useDraft(rows.length > 0, op.pending);
  return <Modal title="Import transactions" wide onClose={close} dirty={rows.length > 0} pending={op.pending}>
    <div className="import-instructions"><a href="/transactions-template.csv" download>Download CSV template</a><small className="muted">Up to 1,000 rows · 2 MB</small></div>
    <label className="file-drop">Choose CSV<input type="file" accept=".csv,text/csv" disabled={op.pending} onChange={e => {
      const file = e.target.files?.[0]; setRows([]); setPreview(null); setErrors([]); setAcknowledged(false);
      if (!file) return;
      void op.run(async () => {
        if (file.size > 2_000_000) throw new Error("CSV file must be smaller than 2 MB.");
        const contents = await file.text(), parsed = parseCsv(contents); setErrors(parsed.errors);
        if (parsed.errors.length) throw new Error("Fix the row errors below before importing.");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents));
        const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
        const checked = await repo.preview(hash, parsed.rows); setRows(parsed.rows); setFingerprint(hash); setPreview(checked);
      });
    }} /></label>
    {errors.length > 0 && <ul className="import-errors">{errors.map((error, i) => <li key={i}>{error}</li>)}</ul>}
    {preview && <><div className="section-heading"><h3>{rows.length} transactions ready</h3><span className="badge">Preview only</span></div>
      {preview.repeated && <p role="alert" className="feedback error">File already imported.</p>}
      {preview.duplicates.length > 0 && <div className="duplicate-warning"><p>Possible duplicates: rows {preview.duplicates.map(d => d.row + 1).join(", ")}.</p>{preview.duplicates.some(d => d.exact) && <p role="alert">Duplicate external IDs. Import blocked.</p>}<label className="check"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />I reviewed these possible duplicates</label></div>}
      <div className="import-preview"><table><thead><tr><th>Date</th><th>Description</th><th>Signed amount</th></tr></thead><tbody>{rows.slice(0, 10).map((r, i) => <tr key={i}><td>{r.original_date}</td><td>{r.description}</td><td className="number">{money(r.amount_cents)}</td></tr>)}</tbody></table></div>
      {rows.length > 10 && <small className="muted">First 10 rows</small>}
      <div className="form-actions"><button disabled={op.pending || preview.repeated || preview.duplicates.some(d => d.exact) || (preview.duplicates.length > 0 && !acknowledged)} onClick={() => void op.run(async () => {
        await repo.import(fingerprint, rows); await refresh(); notify("Transactions imported.", true); close();
      })}>{op.pending ? "Importing..." : `Import ${rows.length} transactions`}</button></div>
    </>}{op.feedback}
  </Modal>;
}
export function Transactions() {
  const { month, uid, repo, data, command } = useBudget();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const searchParam = params.get("search") ?? "";
  useEffect(() => setSearch(searchParam), [searchParam]);
  const [showFilters, setShowFilters] = useState(false);
  const [ingestion, setIngestion] = useState<"manual" | "csv" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const excluded = params.get("excluded"), sort = params.get("sort"), offset = Number(params.get("offset") ?? "0");
  const filters: Filters = {
    search: searchParam, uncategorized: params.get("uncategorized") === "true",
    excluded: excluded === "include" || excluded === "only" ? excluded : "hide", category: params.get("category") || null,
    offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
    sort: sort === "date_asc" || sort === "amount_asc" || sort === "amount_desc" ? sort : "date_desc",
  };
  const activeCount = Number(!!filters.category) + Number(filters.excluded !== "hide") + Number(filters.sort !== "date_desc");
  function filter(key: string, value: string) {
    setParams(old => { const next = new URLSearchParams(old); if (value) next.set(key, value); else next.delete(key); if (key !== "offset") next.delete("offset"); return next; }, { replace: true });
  }
  useEffect(() => {
    if (search === searchParam) return;
    const timer = window.setTimeout(() => setParams(old => { const next = new URLSearchParams(old); if (search) next.set("search", search); else next.delete("search"); next.delete("offset"); return next; }, { replace: true }), 250);
    return () => window.clearTimeout(timer);
  }, [search, searchParam, setParams]);
  const query = useQuery({ queryKey: ["balanced", uid, "page", month, filters], queryFn: () => repo.page(month, filters), placeholderData: keepPreviousData, refetchInterval: 30000 });
  const current = query.data?.items.find(t => t.id === selected);
  useEffect(() => { setSelected(null); }, [month, filters.search, filters.category, filters.uncategorized, filters.excluded, filters.offset, filters.sort]);
  useEffect(() => { if (selected && !query.isFetching && !current) { setSelected(null); searchInput.current?.focus({ preventScroll: true }); } }, [selected, query.isFetching, current]);
  return <>
    <div className="feature-toolbar"><div className="toolbar-actions"><button className="secondary" onClick={() => setIngestion("csv")}><FileUp size={16} />Import CSV</button><button onClick={() => setIngestion("manual")}><Plus size={16} />Add transaction</button></div></div>
    <div className="transaction-toolbar"><div className="search-field"><Search size={17} /><input ref={searchInput} type="search" aria-label="Search" placeholder="Search merchant or description" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <label className="check uncategorized-toggle"><input type="checkbox" checked={filters.uncategorized} onChange={e => filter("uncategorized", e.target.checked ? "true" : "")} />Uncategorized only</label>
      <button className={`secondary ${activeCount ? "has-filters" : ""}`} aria-expanded={showFilters} onClick={() => setShowFilters(v => !v)}><Filter size={15} />Filters{activeCount > 0 && <span className="count-badge">{activeCount}</span>}</button>
    </div>
    {showFilters && <div className="filter-panel">
      <label>Category<select value={filters.category ?? ""} onChange={e => filter("category", e.target.value)}><option value="">All categories</option>{data.categories.map(c => <option value={c.id} key={c.id}>{c.name}{c.archived ? " (archived)" : ""}</option>)}</select></label>
      <label>Excluded transactions<select value={filters.excluded} onChange={e => filter("excluded", e.target.value)}><option value="hide">Hide excluded</option><option value="include">Include excluded</option><option value="only">Only excluded</option></select></label>
      <label>Sort<select value={filters.sort} onChange={e => filter("sort", e.target.value)}><option value="date_desc">Newest first</option><option value="date_asc">Oldest first</option><option value="amount_asc">Amount ascending</option><option value="amount_desc">Amount descending</option></select></label>
      <button className="text-button" onClick={() => setParams({ month }, { replace: true })}>Reset filters</button>
    </div>}
    <div className="results-heading"><span role="status">{query.data ? `${query.data.total} transactions` : "Loading transactions..."}</span>{(search !== searchParam || (query.isFetching && !query.isPending)) && <span className="muted">Updating...</span>}</div>
    {query.isPending ? <div className="loading-state" role="status">Loading transactions...</div> : query.error ? <div className="error-state"><p role="alert">{query.error.message}</p><button onClick={() => void query.refetch()}>Retry</button></div> : query.data && <>
      <section className="transaction-surface" aria-label="Transaction results" aria-busy={query.isFetching || search !== searchParam} inert={query.isPlaceholderData || search !== searchParam}>
        {query.data.items.length ? <table className="transaction-table"><thead><tr><th>Date</th><th>Transaction</th><th>Category</th><th>Amount</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{query.data.items.map(t => <TransactionRow key={t.id} transaction={t} open={() => setSelected(t.id)} />)}</tbody></table> : <EmptyState icon={Inbox} title="No matching transactions" action={<button className="secondary" onClick={() => { setParams({ month }); setSearch(""); }}>Clear filters</button>} />}
      </section>
      <div className="pagination"><span>{query.data.total ? `${filters.offset + 1}-${Math.min(filters.offset + 30, query.data.total)} of ${query.data.total}` : "0 results"}</span><div><button className="secondary" disabled={!filters.offset || query.isPlaceholderData} onClick={() => filter("offset", String(Math.max(0, filters.offset - 30)))}>Previous</button><button className="secondary" disabled={filters.offset + 30 >= query.data.total || query.isPlaceholderData} onClick={() => filter("offset", String(filters.offset + 30))}>Next</button></div></div>
    </>}
    {current && <TransactionSheet transaction={current} close={() => setSelected(null)} returnFocusRef={searchInput} />}
    {ingestion === "csv" && <CsvImport close={() => setIngestion(null)} />}
    {ingestion === "manual" && <Modal title="Add transaction" description="Money in (+), money out (-)." onClose={() => setIngestion(null)}><ActionForm label="Add transaction" onSuccess={() => setIngestion(null)} task={async f => command({ action: "manual", description: text(f, "description"), merchant: text(f, "merchant"), original_date: text(f, "date"), amount_cents: parseMoney(text(f, "amount")) })}><label>Description<input name="description" required maxLength={500} /></label><label>Merchant/payee<input name="merchant" maxLength={200} /></label><div className="form-columns"><label>Date<input name="date" type="date" defaultValue={`${month}-01`} required /></label><label>Signed dollars<input name="amount" placeholder="-42.50" inputMode="decimal" required /></label></div></ActionForm></Modal>}
  </>;
}
