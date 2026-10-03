import { useState } from "react";
import { ArrowLeft, ArrowRight, ChartPie, ChevronRight, Info } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Link } from "react-router-dom";
import { canPie, money, reports, sum, type Bucket } from "@balanced/domain";
import { useBudget } from "../app/context";
import { EmptyState } from "../components/ui";

const colors = ["#28735d", "#cb9343", "#7288a6", "#af7166", "#8b83a8", "#7e984e", "#599da9", "#aa8670"];
function bucketColor(id: string, incomeId?: string) {
  if (id === incomeId) return colors[0];
  if (id.startsWith("uncategorized")) return "#a1aaa4";
  if (id === "unplanned") return "#aa8670";
  let hash = 0; for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}
function ReportCard({ kind, planned, include }: { kind: "income" | "spending"; planned: boolean; include: boolean }) {
  const { data, month } = useBudget();
  const [path, setPath] = useState<string[]>([]);
  const root = reports(data, kind, planned, include);
  const section = root.find(b => b.id === path[0]);
  const category = section?.children.find(b => b.id === path[1]);
  const buckets = section ? section.children : root;
  const current = category ?? section;
  const total = current?.value ?? sum(root.map(b => b.value));
  const title = `${planned ? "Planned" : "Actual"} ${kind === "income" ? "income" : "spending"}`;
  const pie = canPie(buckets);
  const countLabel = section ? (buckets.length === 1 ? "category" : "categories") : (buckets.length === 1 ? "section" : "sections");
  const incomeId = data.sections.find(s => s.kind === "income")?.id;
  function drill(b: Bucket) { setPath(section ? [section.id, b.id] : [b.id]); }
  return <section className="report-card" aria-label={title}>
    <header className="report-header"><div><p>{title}</p><h2 className="number">{money(total)}</h2></div><span className="badge">{planned ? "Budgeted" : "Net actual"}</span></header>
    {section && <nav className="breadcrumbs" aria-label={`${title} drill-down`}><button className="text-button" onClick={() => setPath([])}>All sections</button><ChevronRight size={12} /><button className="text-button" onClick={() => setPath([section.id])}>{section.name}</button>{category && <><ChevronRight size={12} /><span>{category.name}</span></>}</nav>}
    {category && !planned ? <div className="report-detail">
      <div className="section-heading"><h3>{category.name} transactions</h3><button className="icon-button" aria-label="Back to categories" onClick={() => setPath([section!.id])}><ArrowLeft size={17} /></button></div>
      <p className="muted">Relevant allocations only; parent amounts are shown for context.</p>
      <table className="report-transactions"><thead><tr><th>Transaction</th><th>Allocation</th></tr></thead><tbody>{category.details.map(d => <tr key={d.allocation.id}><td><Link to={`/transactions?month=${month}&search=${encodeURIComponent(d.transaction.description)}`}>{d.transaction.description}</Link><small>{d.transaction.effective_date} · Parent {money(d.transaction.amount_cents)}</small><small>Signed allocation {money(d.allocation.amount_cents)}</small></td><td className="number">{money(d.value)}</td></tr>)}</tbody><tfoot><tr><th>Total</th><td className="number">{money(sum(category.details.map(d => d.value)))}</td></tr></tfoot></table>
      {!category.details.length && <p className="muted">No activity.</p>}
    </div> : category && planned ? <div className="planned-detail"><ChartPie size={24} /><h3>{category.name}</h3><p className="number">{money(category.value)} planned</p><small className="muted">Planned amounts don't have transactions.</small><button className="text-button" onClick={() => setPath([section!.id])}><ArrowLeft size={15} />Back to categories</button></div> : !buckets.length ? <EmptyState icon={ChartPie} title={planned ? "No planned amounts yet" : "No activity to report"}>{planned ? "Add category amounts in your budget." : "Add transactions or change the uncategorized setting."}</EmptyState> : <>
      <div className={`report-composition ${pie ? "" : "signed-composition"}`}>
        {pie && <div className="chart" aria-hidden="true"><ResponsiveContainer width="100%" height={180}><PieChart accessibilityLayer={false}>
          <Pie rootTabIndex={-1} data={buckets.filter(b => b.value > 0)} dataKey="value" nameKey="name" innerRadius={55} outerRadius={78} paddingAngle={buckets.filter(b => b.value > 0).length > 1 ? 2 : 0} onClick={(_, i) => drill(buckets.filter(b => b.value > 0)[i])} isAnimationActive={false}>
            {buckets.filter(b => b.value > 0).map(b => <Cell key={b.id} fill={bucketColor(b.id, incomeId)} />)}
          </Pie><Tooltip formatter={value => money(Number(value))} /></PieChart></ResponsiveContainer><span className="chart-center"><strong>{buckets.length}</strong><small>{countLabel}</small></span></div>}
        <ul className="legend" aria-label={`${title} ${section ? "categories" : "sections"}`}>{buckets.map(b => <li key={b.id}>
          <button className="legend-button" onClick={() => drill(b)}><span className="swatch" style={{ background: bucketColor(b.id, incomeId) }} /><span className="legend-label">{b.name}{b.unplanned && <small>Unplanned</small>}</span><strong className={`number ${b.value < 0 ? "negative" : ""}`}>{money(b.value)}</strong><ChevronRight size={15} /></button>
        </li>)}</ul>
      </div>
      {!pie && <p className="chart-explanation"><Info size={15} />{buckets.some(b => b.value < 0) ? "Signed breakdown: negative net amounts can't be represented accurately in a pie." : "Zero total. Values remain available in the breakdown."}</p>}
      <p className="report-hint">{section ? "Choose a category" : "Choose a section"} to see the breakdown <ArrowRight size={12} /></p>
    </>}
  </section>;
}
export function Reports() {
  const { month } = useBudget();
  const [include, setInclude] = useState(true);
  return <>
    <div className="feature-toolbar reports-toolbar"><span className="muted">Excluded activity never contributes to these totals.</span><label className="check"><input type="checkbox" checked={include} onChange={e => setInclude(e.target.checked)} />Include uncategorized transactions in actual totals</label></div>
    <section className="report-group"><header className="report-group-header"><h2>Actual activity</h2><span>Received and spent this month</span></header><div className="report-grid">{(["income", "spending"] as const).map(kind => <ReportCard key={`actual-${kind}-${month}`} kind={kind} planned={false} include={include} />)}</div></section>
    <section className="report-group"><header className="report-group-header"><h2>Your plan</h2><span>Amounts allocated in your budget</span></header><div className="report-grid">{(["income", "spending"] as const).map(kind => <ReportCard key={`planned-${kind}-${month}`} kind={kind} planned include={include} />)}</div></section>
    <p className="report-footnote">Assigned categories determine income versus spending. Unassigned amounts use their sign. Charges and refunds are netted, never converted to absolute values.</p>
  </>;
}
