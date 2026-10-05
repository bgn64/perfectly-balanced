import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChartPie, ChevronRight, Info } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { canPie, money, reports, sum, type Bucket } from "@balanced/domain";
import { useBudget } from "../app/context";
import { EmptyState, Modal } from "../components/ui";
import { CategoryActivity } from "./CategoryActivity";

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
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: string; name: string; sectionId: string; sectionName: string } | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const root = reports(data, kind, planned, include);
  const section = root.find(b => b.id === sectionId);
  const category = root.flatMap(b => b.children).find(b => b.id === selected?.id);
  useEffect(() => { if (sectionId && !section) setSectionId(null); }, [sectionId, section]);
  const buckets = section ? section.children : root;
  const total = section?.value ?? sum(root.map(b => b.value));
  const title = `${planned ? "Planned" : "Actual"} ${kind === "income" ? "income" : "spending"}`;
  const pie = canPie(buckets);
  const countLabel = section ? (buckets.length === 1 ? "category" : "categories") : (buckets.length === 1 ? "section" : "sections");
  const incomeId = data.sections.find(s => s.kind === "income")?.id;
  function drill(b: Bucket) {
    if (section) setSelected({ id: b.id, name: b.name, sectionId: section.id, sectionName: section.name });
    else { setSectionId(b.id); setSelected(null); back.current?.focus({ preventScroll: true }); }
  }
  function reset() { setSectionId(null); setSelected(null); }
  return <section className="report-card" aria-label={title}>
    <header className="report-header"><div><p>{title}</p><h2 className="number">{money(total)}</h2></div><span className="badge">{planned ? "Budgeted" : "Net actual"}</span></header>
    <nav className="breadcrumbs" aria-label={`${title} drill-down`}><button ref={back} className="text-button" aria-current={!section ? "page" : undefined} onClick={reset}>{section && <ArrowLeft size={12} />}All sections</button><ChevronRight size={12} /><span aria-live="polite" aria-atomic="true">{section?.name ?? "Overview"}</span></nav>
    <div className="report-body">
    {!buckets.length ? <EmptyState icon={ChartPie} title={planned ? "No planned amounts yet" : "No activity to report"} /> : <>
      <div className={`report-composition ${pie ? "" : "signed-composition"}`}>
        {pie && <div className="chart" aria-hidden="true"><ResponsiveContainer width="100%" height={180}><PieChart accessibilityLayer={false}>
          <Pie rootTabIndex={-1} data={buckets.filter(b => b.value > 0)} dataKey="value" nameKey="name" innerRadius={55} outerRadius={78} paddingAngle={buckets.filter(b => b.value > 0).length > 1 ? 2 : 0} onClick={(_, i) => drill(buckets.filter(b => b.value > 0)[i])} isAnimationActive={false}>
            {buckets.filter(b => b.value > 0).map(b => <Cell key={b.id} fill={bucketColor(b.id, incomeId)} />)}
          </Pie><Tooltip formatter={value => money(Number(value))} /></PieChart></ResponsiveContainer><span className="chart-center"><strong>{buckets.length}</strong><small>{countLabel}</small></span></div>}
        <ul className="legend" aria-label={`${title} ${section ? "categories" : "sections"}`}>{buckets.map(b => <li key={b.id}>
          <button className="legend-button" onClick={() => drill(b)}><span className="swatch" style={{ background: bucketColor(b.id, incomeId) }} /><span className="legend-label">{b.name}{b.unplanned && <small>Unplanned</small>}</span><strong className={`number ${b.value < 0 ? "negative" : ""}`}>{money(b.value)}</strong><ChevronRight size={15} /></button>
        </li>)}</ul>
      </div>
      {!pie && <p className="chart-explanation"><Info size={15} />{buckets.some(b => b.value < 0) ? "Signed breakdown" : "Zero total"}</p>}
    </>}
    </div>
    {selected && (!planned ? <CategoryActivity key={`${month}-${selected.id}`} scope={{ source: "report", categoryId: selected.id, name: selected.name, sectionId: selected.sectionId, sectionName: selected.sectionName, kind }} bucket={category} close={() => setSelected(null)} /> :
      <Modal title={`${selected.name} planned amount`} description={`${month} · ${selected.sectionName}`} sheet onClose={() => setSelected(null)}>
        <div className="planned-detail"><span>Planned</span><strong className="number">{money(category?.value ?? 0)}</strong></div>
      </Modal>)}
  </section>;
}
export function Reports() {
  const { month } = useBudget();
  const [include, setInclude] = useState(true);
  return <>
    <div className="feature-toolbar reports-toolbar"><label className="check"><input type="checkbox" checked={include} onChange={e => setInclude(e.target.checked)} />Include uncategorized in actual totals</label></div>
    <section className="report-group"><header className="report-group-header"><h2>Actual activity</h2></header><div className="report-grid">{(["income", "spending"] as const).map(kind => <ReportCard key={`actual-${kind}-${month}`} kind={kind} planned={false} include={include} />)}</div></section>
    <section className="report-group"><header className="report-group-header"><h2>Your plan</h2></header><div className="report-grid">{(["income", "spending"] as const).map(kind => <ReportCard key={`planned-${kind}-${month}`} kind={kind} planned include={include} />)}</div></section>
  </>;
}
