import { useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Check, Plus, Scissors, Sparkles, X } from "lucide-react";
import { dollars, money, parseMoney, validateSplit, type AllocationInput, type Transaction } from "@balanced/domain";
import { errorMessage, text, useBudget, useOperation } from "../app/context";
import { ActionForm, Modal, useDraft } from "../components/ui";

export function CategorySelect({ value, onChange, label, disabled = false }: { value: string | null; onChange: (v: string | null) => void; label: string; disabled?: boolean }) {
  const { data } = useBudget();
  return <select className={`category-select ${value ? "" : "uncategorized"}`} aria-label={label} disabled={disabled} value={value ?? ""} onChange={e => onChange(e.target.value || null)}>
    <option value="">Uncategorized</option>{data.sections.map(s => <optgroup label={s.name} key={s.id}>{data.categories.filter(c => c.section_id === s.id && ((!s.archived && !c.archived) || c.id === value)).map(c => <option value={c.id} key={c.id}>{c.name}{c.archived ? " (archived)" : ""}</option>)}</optgroup>)}
  </select>;
}
function useSuggestion(transaction: Transaction) {
  const { repo, data, uid } = useBudget();
  return useQuery({ queryKey: ["balanced", uid, "suggestion", transaction.id], queryFn: () => repo.suggest(transaction, data), enabled: !transaction.excluded && !transaction.provider_removed && transaction.allocations.some(a => !a.category_id) });
}
export function Suggestion({ transaction, allocationIndex }: { transaction: Transaction; allocationIndex: number }) {
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
  return <Modal title="Split transaction" onClose={close} dirty={dirty} pending={op.pending}>
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
export function TransactionSheet({ transaction: t, close, returnFocusRef }: { transaction: Transaction; close: () => void; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const { command, repo, refresh } = useBudget();
  const [split, setSplit] = useState(false);
  const op = useOperation();
  return <Modal title="Transaction details" sheet onClose={close} pending={op.pending} returnFocusRef={returnFocusRef}>
    <div className="transaction-detail-heading"><span className="detail-merchant-icon"><ArrowUpRight size={22} /></span><h2>{t.description}</h2>{t.merchant && <p className="muted">{t.merchant}</p>}<strong className={`detail-amount number ${t.amount_cents > 0 ? "positive" : ""}`}>{money(t.amount_cents)}</strong>{t.excluded && <span className="badge excluded-badge">Excluded from budget & reports</span>}</div>
    <section className="detail-section"><div className="section-heading"><h3>{t.allocations.length > 1 ? "Allocations" : "Category"}</h3><button className="text-button" disabled={op.pending} onClick={() => setSplit(true)}><Scissors size={14} />Edit splits</button></div>
      {t.allocations.map((a, i) => <div className="detail-allocation" key={a.id}><div><span className="number">{money(a.amount_cents)}</span><CategorySelect label={`Category for ${t.description} split ${i + 1}`} value={a.category_id} disabled={op.pending} onChange={category_id => void op.run(() => command({ action: "split", id: t.id, allocations: t.allocations.map(x => ({ amount_cents: x.amount_cents, category_id: x.id === a.id ? category_id : x.category_id })) }))} /></div><Suggestion transaction={t} allocationIndex={i} /></div>)}
    </section>
    <section className="detail-section"><h3>Effective date</h3>
      <ActionForm key={t.effective_date} label="Change effective date" task={async f => { const date = text(f, "date"); await command({ action: "date", id: t.id, date: date === t.original_date ? null : date }); }}><label>Effective date<input name="date" type="date" defaultValue={t.effective_date} required /></label></ActionForm>
      <div className="original-date"><small>Original date: {t.original_date}</small>{t.date_override && <button className="link" disabled={op.pending} onClick={() => void op.run(() => command({ action: "date", id: t.id, date: null }))}>Reset to original</button>}</div>
    </section>
    <section className="detail-section"><h3>Budget visibility</h3>{t.provider_removed && <p className="feedback">Bank removed · Not in totals</p>}<button className="secondary" disabled={op.pending || t.provider_removed} onClick={() => void op.run(() => command({ action: "exclude", id: t.id, excluded: !t.excluded }))}>{t.excluded ? "Restore to budget & reports" : "Exclude from budget & reports"}</button></section>
    {t.provider_removed && <button className="secondary" disabled={op.pending} onClick={() => void op.run(async () => { await repo.restoreBankTransaction(t.id,t.revision); await refresh(); close(); }, "Bank removal undone.")}>Undo accepted bank removal</button>}
    {(t.source==="plaid" || t.bank_accounts.length>0) && <section className="detail-section"><h3>Bank source</h3>{t.bank_accounts.length ? t.bank_accounts.map(a => <p key={`${a.institution}:${a.name}:${a.mask}`}>{a.institution} - {a.name}{a.mask ? ` (...${a.mask})` : ""}</p>) : <p className="muted">Imported history · No linked account</p>}</section>}
    <div className="detail-provenance"><span>Source</span><strong>{t.source}</strong><span>Currency</span><strong>USD</strong></div>{op.feedback}
    {split && <SplitEditor transaction={t} close={() => setSplit(false)} />}
  </Modal>;
}
