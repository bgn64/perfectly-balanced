import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Check, FileUp, Filter, Inbox, Plus, Search, Scissors, Sparkles, X } from "lucide-react";
import { dollars, money, parseCsv, parseMoney, validateSplit, type AllocationInput, type SourceInput, type Transaction } from "@balanced/domain";
import type { Filters, ImportPreview } from "@balanced/data";
import { errorMessage, text, useBudget, useOperation } from "../app/context";
import { ActionForm, EmptyState, Modal, useDraft } from "../components/ui";

function CategorySelect({ value, onChange, label, disabled = false }: { value: string | null; onChange: (v: string | null) => void; label: string; disabled?: boolean }) {
  const { data } = useBudget();
  return <select className={`category-select ${value ? "" : "uncategorized"}`} aria-label={label} disabled={disabled} value={value ?? ""} onChange={e => onChange(e.target.value || null)}>
    <option value="">Uncategorized</option>{data.sections.map(s => <optgroup label={s.name} key={s.id}>{data.categories.filter(c => c.section_id === s.id && ((!s.archived && !c.archived) || c.id === value)).map(c => <option value={c.id} key={c.id}>{c.name}{c.archived ? " (archived)" : ""}</option>)}</optgroup>)}
  </select>;
}
function useSuggestion(transaction: Transaction) {
  const { repo, data, uid } = useBudget();
  return useQuery({ queryKey: ["balanced", uid, "suggestion", transaction.id], queryFn: () => repo.suggest(transaction, data), enabled: !transaction.excluded && !transaction.provider_removed && transaction.allocations.some(a => !a.category_id) });
}
function Suggestion({ transaction, allocationIndex }: { transaction: Transaction; allocationIndex: number }) {
  const { data, command } = useBudget();
  const query = useSuggestion(transaction);
  const op = useOperation();
  const allocation = transaction.allocations[allocationIndex];
  if (!allocation || allocation.category_id || transaction.excluded || transaction.provider_removed) return null;
  return <div className="recommendation">
    {query.data && <button className="suggestion" title={query.data.reason} disabled={op.pending} onClick={() => void op.run(() => command({
      action: "split", id: transaction.id, allocations: transaction.allocations.map((a, i) => ({ amount_cents: a.amount_cents, category_id: i === allocationIndex ? query.data!.category_id : a.category_id })),
    }))}><Sparkles size={12} />Use {data.categories.find(c => c.id === query.data?.category_id)?.name}{transaction.allocations.length > 1 ? ` for split ${allocationIndex + 1}` : ""}<Check size={12} /></button>}
    {query.error && <p role="alert" className="compact-error">Suggestion unavailable. <button className="link" onClick={() => void query.refetch()}>Retry</button><span className="sr-only">{query.error.message}</span></p>}{op.feedback}
  </div>;
}
function SplitEditor({ transaction, close }: { transaction: Transaction; close: () => void }) {
  const { command } = useBudget();
  const initial = transaction.allocations.map(a => ({ key: a.id, category_id: a.category_id, amount: dollars(a.amount_cents) }));
  const [rows, setRows] = useState(initial);
  const op = useOperation();
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);
  useDraft(dirty, op.pending);
  const change = (i: number, values: Partial<(typeof rows)[number]>) => setRows(old => old.map((r, index) => index === i ? { ...r, ...values } : r));
  let assigned: number | null = null;
  let draftError = "";
  if (rows.some(r => !r.amount.trim())) draftError = "Enter an amount for each allocation.";
  else {
    try { assigned = rows.reduce((total, r) => total + parseMoney(r.amount), 0); }
    catch (error) { draftError = errorMessage(error); }
  }
  return <Modal title="Split transaction" description="Use signed amounts that add up exactly to the original. Uncategorized can hold any remainder." onClose={close} dirty={dirty} pending={op.pending}>
    <div className="split-summary"><span>Original amount<strong className="number">{money(transaction.amount_cents)}</strong></span><span>Still to allocate<strong className={`number ${assigned !== null && assigned !== transaction.amount_cents ? "negative" : ""}`}>{assigned === null ? "Enter amounts" : money(transaction.amount_cents - assigned)}</strong></span></div>
    {draftError && <p className="feedback error" role="status">{draftError}</p>}
    <form onSubmit={e => {
      e.preventDefault();
      void op.run(async () => { const allocations: AllocationInput[] = rows.map(r => ({ category_id: r.category_id, amount_cents: parseMoney(r.amount) })); validateSplit(transaction.amount_cents, allocations); await command({ action: "split", id: transaction.id, allocations }); close(); });
    }}><fieldset disabled={op.pending}>
      {rows.map((r, i) => <div className="split-row" key={r.key}><CategorySelect label={`Category for split ${i + 1}`} value={r.category_id} onChange={category_id => change(i, { category_id })} /><input aria-label={`Amount for split ${i + 1}`} value={r.amount} onChange={e => change(i, { amount: e.target.value })} inputMode="decimal" required /><button type="button" className="icon-button" aria-label={`Remove split ${i + 1}`} onClick={() => setRows(old => old.filter((_, index) => index !== i))}><X size={16} /></button></div>)}
      <button type="button" className="text-button" onClick={() => setRows(old => [...old, { key: crypto.randomUUID(), category_id: null, amount: "" }])}><Plus size={15} />Add split</button>
      <div className="form-actions"><button disabled={assigned !== transaction.amount_cents || !rows.length}>{op.pending ? "Saving..." : "Save splits"}</button></div>
    </fieldset></form>{op.feedback}
  </Modal>;
}
function TransactionSheet({ transaction: t, close }: { transaction: Transaction; close: () => void }) {
  const { command, repo, refresh } = useBudget();
  const [split, setSplit] = useState(false);
  const op = useOperation();
  const suggestion = useSuggestion(t);
  return <Modal title="Transaction details" sheet onClose={close} pending={op.pending}>
    <div className="transaction-detail-heading"><span className="detail-merchant-icon"><ArrowUpRight size={22} /></span><h2>{t.description}</h2><p className="muted">{t.merchant || "No merchant recorded"}</p><strong className={`detail-amount number ${t.amount_cents > 0 ? "positive" : ""}`}>{money(t.amount_cents)}</strong>{t.excluded && <span className="badge excluded-badge">Excluded from budget & reports</span>}</div>
    <section className="detail-section"><div className="section-heading"><h3>{t.allocations.length > 1 ? "Allocations" : "Category"}</h3><button className="text-button" disabled={op.pending} onClick={() => setSplit(true)}><Scissors size={14} />Edit splits</button></div>
      {t.allocations.map((a, i) => <div className="detail-allocation" key={a.id}><div><span className="number">{money(a.amount_cents)}</span><CategorySelect label={`Category for ${t.description} split ${i + 1}`} value={a.category_id} disabled={op.pending} onChange={category_id => void op.run(() => command({ action: "split", id: t.id, allocations: t.allocations.map(x => ({ amount_cents: x.amount_cents, category_id: x.id === a.id ? category_id : x.category_id })) }))} /></div><Suggestion transaction={t} allocationIndex={i} /></div>)}
      {suggestion.data && <small className="muted recommendation-reason">{suggestion.data.reason}</small>}
    </section>
    <section className="detail-section"><h3>Effective date</h3><p className="muted">Determines the budget month for every allocation.</p>
      <ActionForm key={t.effective_date} label="Change effective date" task={async f => { const date = text(f, "date"); await command({ action: "date", id: t.id, date: date === t.original_date ? null : date }); }}><label>Effective date<input name="date" type="date" defaultValue={t.effective_date} required /></label></ActionForm>
      <div className="original-date"><small>Original date: {t.original_date}</small>{t.date_override && <button className="link" disabled={op.pending} onClick={() => void op.run(() => command({ action: "date", id: t.id, date: null }))}>Reset to original</button>}</div>
    </section>
    <section className="detail-section"><h3>Budget visibility</h3>{t.provider_removed && <p className="feedback">Bank removal accepted. Retained for history, outside budgets and reports independently of your exclusion choice.</p>}<p className="muted">{t.excluded ? "This transaction contributes nothing to budgets or reports. Restore it whenever you're ready." : "Exclude activity that isn't representative of the spending you want to see. You can restore it later."}</p><button className="secondary" disabled={op.pending || t.provider_removed} onClick={() => void op.run(() => command({ action: "exclude", id: t.id, excluded: !t.excluded }))}>{t.excluded ? "Restore to budget & reports" : "Exclude from budget & reports"}</button></section>
    {t.provider_removed && <button className="secondary" disabled={op.pending} onClick={() => void op.run(async () => { await repo.restoreBankTransaction(t.id,t.revision); await refresh(); close(); }, "Bank removal undone. Your exclusion choice is unchanged.")}>Undo accepted bank removal</button>}
    {(t.source==="plaid" || t.bank_accounts.length>0) && <section className="detail-section"><h3>Bank source</h3>{t.bank_accounts.length ? t.bank_accounts.map(a => <p key={`${a.institution}:${a.name}:${a.mask}`}>{a.institution} - {a.name}{a.mask ? ` (...${a.mask})` : ""}</p>) : <p className="muted">Imported history; no live bank account mapping has been established.</p>}</section>}
    <div className="detail-provenance"><span>Source</span><strong>{t.source}</strong><span>Currency</span><strong>USD</strong></div>{op.feedback}
    {split && <SplitEditor transaction={t} close={() => setSplit(false)} />}
  </Modal>;
}
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
  return <Modal title="Import transactions" description="Preview and validate a CSV before adding anything to your account." wide onClose={close} dirty={rows.length > 0} pending={op.pending}>
    <div className="import-instructions"><p>Required: <strong>date, description, amount</strong>. Optional: merchant, external_id.</p><small className="muted">Use YYYY-MM-DD dates and signed dollars. Up to 1,000 rows / 2 MB.</small><a href="/transactions-template.csv" download>Download CSV template</a></div>
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
      {preview.repeated && <p role="alert" className="feedback error">This exact file was already imported. Import is blocked.</p>}
      {preview.duplicates.length > 0 && <div className="duplicate-warning"><p>Possible duplicates on rows {preview.duplicates.map(d => d.row + 1).join(", ")}. Matching external IDs block import; similar purchases without IDs may be distinct.</p><label className="check"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />I reviewed these possible duplicates</label></div>}
      <div className="import-preview"><table><thead><tr><th>Date</th><th>Description</th><th>Signed amount</th></tr></thead><tbody>{rows.slice(0, 10).map((r, i) => <tr key={i}><td>{r.original_date}</td><td>{r.description}</td><td className="number">{money(r.amount_cents)}</td></tr>)}</tbody></table></div>
      {rows.length > 10 && <small className="muted">Showing the first 10 rows.</small>}
      <div className="form-actions"><button disabled={op.pending || preview.repeated || preview.duplicates.some(d => d.exact) || (preview.duplicates.length > 0 && !acknowledged)} onClick={() => void op.run(async () => {
        await repo.import(fingerprint, rows); await refresh(); notify("Imported successfully. Transactions appear in their dated months.", true); close();
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
  useEffect(() => { if (selected && !query.isFetching && !current) { setSelected(null); searchInput.current?.focus(); } }, [selected, query.isFetching, current]);
  return <>
    <div className="feature-toolbar"><span className="muted">Signed amounts. Clear categories.</span><div className="toolbar-actions"><button className="secondary" onClick={() => setIngestion("csv")}><FileUp size={16} />Import CSV</button><button onClick={() => setIngestion("manual")}><Plus size={16} />Add transaction</button></div></div>
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
        {query.data.items.length ? <table className="transaction-table"><thead><tr><th>Date</th><th>Transaction</th><th>Category</th><th>Amount</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{query.data.items.map(t => <TransactionRow key={t.id} transaction={t} open={() => setSelected(t.id)} />)}</tbody></table> : <EmptyState icon={Inbox} title="No matching transactions" action={<button className="secondary" onClick={() => { setParams({ month }); setSearch(""); }}>Clear filters</button>}>Change your filters, or add a transaction to this month.</EmptyState>}
      </section>
      <div className="pagination"><span>{query.data.total ? `${filters.offset + 1}-${Math.min(filters.offset + 30, query.data.total)} of ${query.data.total}` : "0 results"}</span><div><button className="secondary" disabled={!filters.offset || query.isPlaceholderData} onClick={() => filter("offset", String(Math.max(0, filters.offset - 30)))}>Previous</button><button className="secondary" disabled={filters.offset + 30 >= query.data.total || query.isPlaceholderData} onClick={() => filter("offset", String(filters.offset + 30))}>Next</button></div></div>
    </>}
    {current && <TransactionSheet transaction={current} close={() => setSelected(null)} />}
    {ingestion === "csv" && <CsvImport close={() => setIngestion(null)} />}
    {ingestion === "manual" && <Modal title="Add transaction" description="Positive means money received; negative means money paid." onClose={() => setIngestion(null)}><ActionForm label="Add transaction" onSuccess={() => setIngestion(null)} task={async f => command({ action: "manual", description: text(f, "description"), merchant: text(f, "merchant"), original_date: text(f, "date"), amount_cents: parseMoney(text(f, "amount")) })}><label>Description<input name="description" required maxLength={500} /></label><label>Merchant/payee<input name="merchant" maxLength={200} /></label><div className="form-columns"><label>Date<input name="date" type="date" defaultValue={`${month}-01`} required /></label><label>Signed dollars<input name="amount" placeholder="-42.50" inputMode="decimal" required /></label></div></ActionForm></Modal>}
  </>;
}
