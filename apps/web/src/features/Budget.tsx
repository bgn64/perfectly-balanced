import { useState } from "react";
import { Link } from "react-router-dom";
import { Archive, ArrowDown, ArrowUp, Copy, FolderPlus, Layers, Pencil, Plus, Trash2, Wallet } from "lucide-react";
import { categoryActual, dollars, money, parseMoney, reports, sum } from "@balanced/domain";
import { text, useBudget, useOperation } from "../app/context";
import { ActionForm, Confirm, EmptyState, Menu, Modal, MoneyCell } from "../components/ui";
import type { Command } from "@balanced/data";

type Editor =
  | { type: "section" }
  | { type: "category"; sectionId: string; sectionName: string }
  | { type: "rename"; id: string; name: string; target: "category" | "section" }
  | { type: "copy" | "attach-category" | "attach-section" };
export function Budget() {
  const { data, month, command, repo, refresh, notify } = useBudget();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; label: string; task: () => Promise<void> } | null>(null);
  const op = useOperation();
  const used = new Set(data.budget_categories.map(c => c.category_id));
  const sectionUsed = new Set(data.budget_sections.map(s => s.section_id));
  const available = data.categories.filter(c => !c.archived && !used.has(c.id) && !data.sections.find(s => s.id === c.section_id)?.archived);
  const unplanned = data.categories.filter(c => !used.has(c.id) && data.transactions.some(t => !t.excluded && t.allocations.some(a => a.category_id === c.id)));
  const plannedIncome = sum(reports(data, "income", true, true).map(b => b.value));
  const plannedSpend = sum(reports(data, "spending", true, true).map(b => b.value));
  const actualSpend = sum(reports(data, "spending", false, true).map(b => b.value));
  function confirm(title: string, description: string, label: string, task: () => Promise<void>) { setConfirmation({ title, description, label, task }); }
  function run(c: Command) { void op.run(() => command(c)); }
  return <>
    <div className="feature-toolbar"><span className="muted">Every category has a purpose.</span><div className="toolbar-actions">
      <Menu label="Budget actions" textLabel="Budget actions" items={[
        { label: "Copy budget", icon: Copy, onSelect: () => setEditor({ type: "copy" }) },
        { label: "Add existing category", icon: Plus, onSelect: () => setEditor({ type: "attach-category" }), disabled: !available.length },
        { label: "Add existing section", icon: Layers, onSelect: () => setEditor({ type: "attach-section" }), disabled: !data.sections.some(s => !s.archived && !sectionUsed.has(s.id)) },
        { label: "Load demo data", icon: Wallet, onSelect: () => confirm("Load demo data?", "Add clearly labeled example budgets and transactions to this empty month. Your existing data will not be overwritten.", "Load demo data", async () => { await repo.demo(month); await refresh(); notify("Demo data loaded."); }) },
      ]} />
      <button onClick={() => setEditor({ type: "section" })}><Plus size={16} />Add section</button>
    </div></div>
    <div className="metric-strip">
      {[{ label: "Planned income", value: plannedIncome }, { label: "Planned spending", value: plannedSpend }, { label: "Planned balance", value: plannedIncome - plannedSpend }, { label: "Net spent", value: actualSpend }].map(m => <div className="metric" key={m.label}><span>{m.label}</span><strong className={`number ${m.label === "Planned balance" && m.value < 0 ? "negative" : ""}`}>{money(m.value)}</strong>{m.label === "Net spent" && <small>Including uncategorized outflows</small>}</div>)}
    </div>
    <div className="budget-surface">
      {data.budget_sections.map((bs, index) => {
        const section = data.sections.find(s => s.id === bs.section_id);
        if (!section) throw new Error("Budget section unavailable.");
        const income = section.kind === "income";
        const cats = data.budget_categories.filter(c => data.categories.find(cat => cat.id === c.category_id)?.section_id === section.id);
        const planned = sum(cats.map(c => c.planned_cents));
        const actual = sum(cats.map(c => categoryActual(data, c.category_id))) * (income ? 1 : -1);
        return <section className="budget-section" key={section.id}>
          <header className="budget-section-header"><div className="section-name"><span className={`section-symbol ${income ? "income-symbol" : ""}`}>{income ? <Wallet size={17} /> : <Layers size={17} />}</span><h2>{bs.name}</h2>{income && <span className="badge subtle" aria-label="Permanent Income section">Fixed</span>}{section.archived && <span className="badge">Archived</span>}</div>
            <span className="section-total number">{money(actual)} <span className="muted">{income ? "received" : "spent"}</span></span>
            {!income && <Menu label={`Manage section ${bs.name}`} items={[
              { label: "Rename section", icon: Pencil, disabled: section.archived, onSelect: () => setEditor({ type: "rename", target: "section", id: section.id, name: bs.name }) },
              { label: "Move up", icon: ArrowUp, disabled: index <= 1 || op.pending, onSelect: () => run({ action: "reorder", month, type: "section", id: section.id, position: bs.position - 1 }) },
              { label: "Move down", icon: ArrowDown, disabled: index === data.budget_sections.length - 1 || op.pending, onSelect: () => run({ action: "reorder", month, type: "section", id: section.id, position: bs.position + 1 }) },
              { label: "Remove from month", icon: Trash2, danger: true, onSelect: () => confirm("Remove section from this month?", "Remove its categories first. Income is permanent and cannot be removed.", "Remove section", () => command({ action: "remove_section", month, id: section.id })) },
              { label: "Archive section", icon: Archive, danger: true, disabled: section.archived, onSelect: () => confirm("Archive this section?", "Its categories will be hidden from future budgets and assignments. Existing history remains.", "Archive section", () => command({ action: "archive_section", id: section.id })) },
            ]} />}
          </header>
          {cats.length ? <table className="budget-table"><thead><tr><th>Category</th><th>Planned</th><th>{income ? "Received" : "Net spent"}</th><th>{income ? "Still expected" : "Remaining"}</th></tr></thead><tbody>
            {cats.map((c, i) => {
              const signed = categoryActual(data, c.category_id);
              const value = signed * (income ? 1 : -1), remaining = c.planned_cents - value;
              const cat = data.categories.find(x => x.id === c.category_id)!;
              return <tr key={c.category_id} className="budget-row">
                <td className="budget-category"><div><Link to={`/transactions?month=${month}&category=${c.category_id}&excluded=include`}>{c.name}</Link>{cat.archived && <span className="badge">Archived</span>}
                  {!income && c.planned_cents > 0 && value >= 0 && <div className={`spending-track ${remaining < 0 ? "over" : ""}`} aria-hidden="true"><span style={{ width: `${Math.min(100, value / c.planned_cents * 100)}%` }} /></div>}
                </div><Menu label={`Manage category ${c.name}`} items={[
                  { label: "Rename category", icon: Pencil, disabled: cat.archived, onSelect: () => setEditor({ type: "rename", target: "category", id: c.category_id, name: c.name }) },
                  { label: "Move up", icon: ArrowUp, disabled: i === 0 || op.pending, onSelect: () => run({ action: "reorder", month, type: "category", id: c.category_id, position: c.position - 1 }) },
                  { label: "Move down", icon: ArrowDown, disabled: i === cats.length - 1 || op.pending, onSelect: () => run({ action: "reorder", month, type: "category", id: c.category_id, position: c.position + 1 }) },
                  { label: "Remove from month", icon: Trash2, danger: true, onSelect: () => confirm("Remove category from this month?", "Reassign this month's transactions first, including excluded transactions. Click the category name to find them.", "Remove category", () => command({ action: "remove_category", month, id: c.category_id })) },
                  { label: "Archive category", icon: Archive, danger: true, disabled: cat.archived, onSelect: () => confirm("Archive this category?", "Hide it from future budgets and assignments without deleting any history.", "Archive category", () => command({ action: "archive_category", id: c.category_id })) },
                ]} /></td>
                <td className="budget-planned"><span className="mobile-cell-label">Planned</span><MoneyCell value={c.planned_cents} name={c.name} save={planned_cents => command({ action: "planned", month, id: c.category_id, planned_cents })} /></td>
                <td className="budget-actual number"><span className="mobile-cell-label">{income ? "Received" : "Net spent"}</span>{money(value)}</td>
                <td className={`budget-remaining number ${!income && remaining < 0 ? "negative" : ""}`}><span className="mobile-cell-label">{income ? "Still expected" : "Remaining"}</span><strong>{money(remaining)}</strong></td>
              </tr>;
            })}
          </tbody><tfoot><tr><th>Section total</th><td className="number">{money(planned)}</td><td className="number">{money(actual)}</td><td className="number">{money(planned - actual)}</td></tr></tfoot></table> :
            <div className="section-empty"><p>{income ? "Add your expected income to complete the picture." : "Add a category to start planning this section."}</p></div>}
          {!section.archived && <button className="text-button section-add" onClick={() => setEditor({ type: "category", sectionId: section.id, sectionName: bs.name })}><Plus size={15} />Add category to {bs.name}</button>}
        </section>;
      })}
    </div>
    {unplanned.length > 0 && <section className="unplanned-panel"><header><h2>Unplanned activity</h2><p className="muted">Assigned activity outside this month's plan. Planned amounts are zero.</p></header>{unplanned.map(c => <div className="unplanned-row" key={c.id}><div><strong>{c.name}</strong><small>{data.sections.find(s => s.id === c.section_id)?.name}</small></div><span className="number">{money(categoryActual(data, c.id))}<small>Signed actual</small></span><button className="secondary" disabled={c.archived || op.pending} onClick={() => run({ action: "category_attach", month, id: c.id })}>Add to month</button></div>)}</section>}
    {data.budget_sections.length === 1 && !data.budget_categories.length && <EmptyState icon={FolderPlus} title="Start with a simple plan" action={<button onClick={() => setEditor({ type: "section" })}><Plus size={16} />Add your first section</button>}>Create a spending section, then add categories. Or copy a previous budget from Budget actions.</EmptyState>}
    {op.feedback}
    {editor && <Modal title={editor.type === "section" ? "Add a budget section" : editor.type === "category" ? `Add category to ${editor.sectionName}` : editor.type === "rename" ? `Rename ${editor.target}` : editor.type === "copy" ? "Copy budget" : editor.type === "attach-category" ? "Add existing category" : "Add existing section"} onClose={() => setEditor(null)}>
      {editor.type === "section" && <ActionForm label="Add section" onSuccess={() => setEditor(null)} task={async f => command({ action: "section_add", month, name: text(f, "name") })}><label>Section name<input name="name" required maxLength={100} placeholder="Essentials, Lifestyle, Savings..." /></label></ActionForm>}
      {editor.type === "category" && <ActionForm label="Add category" onSuccess={() => setEditor(null)} task={async f => { const amount = parseMoney(text(f, "amount")); if (amount < 0) throw new Error("Planned amounts must be nonnegative."); await command({ action: "category_add", month, section_id: editor.sectionId, name: text(f, "name"), planned_cents: amount }); }}><label>Category name<input name="name" required maxLength={100} placeholder="Name your category" /></label><label>Planned dollars<input name="amount" defaultValue={dollars(0)} inputMode="decimal" required /></label></ActionForm>}
      {editor.type === "rename" && <ActionForm label="Save name" onSuccess={() => setEditor(null)} task={async f => command({ action: editor.target === "category" ? "rename_category" : "rename_section", month, id: editor.id, name: text(f, "name") })}><label>{editor.target === "category" ? "Category name" : "Section name"}<input name="name" defaultValue={editor.name} maxLength={100} required /></label></ActionForm>}
      {editor.type === "copy" && <ActionForm label="Copy budget" onSuccess={() => setEditor(null)} task={async f => command({ action: "copy", month, from_month: text(f, "from") })}><p className="muted">Copy sections, categories, and planned amounts to an empty destination month. No balances roll over.</p><label>Copy from month<input name="from" type="month" required /></label></ActionForm>}
      {editor.type === "attach-category" && <ActionForm label="Add existing category" onSuccess={() => setEditor(null)} task={async f => command({ action: "category_attach", month, id: text(f, "id") })}><label>Existing category<select name="id" required><option value="">Choose a category</option>{available.map(c => <option key={c.id} value={c.id}>{data.sections.find(s => s.id === c.section_id)?.name} / {c.name}</option>)}</select></label></ActionForm>}
      {editor.type === "attach-section" && <ActionForm label="Add existing section" onSuccess={() => setEditor(null)} task={async f => command({ action: "section_attach", month, id: text(f, "id") })}><label>Existing section<select name="id" required><option value="">Choose a section</option>{data.sections.filter(s => !s.archived && !sectionUsed.has(s.id)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label></ActionForm>}
    </Modal>}
    {confirmation && <Confirm title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.label} onCancel={() => setConfirmation(null)} onConfirm={async () => { await confirmation.task(); setConfirmation(null); }} />}
  </>;
}
