import { Suspense, lazy, useEffect, useState } from "react";
import { ArrowLeftRight, ChartPie, ChevronLeft, ChevronRight, Landmark, LayoutDashboard, LogOut, Scale, X } from "lucide-react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { localMonth } from "@balanced/domain";
import { repository } from "./backend";
import { BudgetContext, useOperation } from "./context";
import { useGuardedAction } from "../components/ui";

const Budget = lazy(() => import("../features/Budget").then(m => ({ default: m.Budget })));
const Transactions = lazy(() => import("../features/Transactions").then(m => ({ default: m.Transactions })));
const Reports = lazy(() => import("../features/Reports").then(m => ({ default: m.Reports })));
const Connections = lazy(() => import("../features/Connections").then(m => ({ default: m.Connections })));
const routes = [
  { path: "budget", label: "Budget", icon: LayoutDashboard, title: "Your monthly budget", description: "A plan for what matters." },
  { path: "transactions", label: "Transactions", icon: ArrowLeftRight, title: "Your transactions", description: "Organize your monthly activity." },
  { path: "reports", label: "Reports", icon: ChartPie, title: "Your spending, in perspective", description: "Follow the money, from overview to detail." },
  { path: "connections", label: "Connections", icon: Landmark, title: "Your bank connections", description: "Securely bring your bank activity into your budget." },
];
function shiftMonth(month: string, direction: number) {
  const [year, m] = month.split("-").map(Number);
  const next = year * 12 + m - 1 + direction;
  return `${String(Math.floor(next / 12)).padStart(4, "0")}-${String(next % 12 + 1).padStart(2, "0")}`;
}
export function Shell({ session }: { session: Session }) {
  const [params, setParams] = useSearchParams();
  const rawMonth = params.get("month");
  const month = rawMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth) && Number(rawMonth.slice(0, 4)) > 0 ? rawMonth : localMonth();
  const location = useLocation();
  const route = routes.find(r => location.pathname === `/${r.path}`) ?? routes[0];
  const cache = useQueryClient();
  const op = useOperation();
  const guardedAction = useGuardedAction();
  const [notice, setNotice] = useState<{ text: string; id: number; important: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.important ? 12000 : 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const query = useQuery({
    queryKey: ["balanced", session.user.id, "month", month],
    queryFn: () => { if (!repository) throw new Error("Backend configuration missing."); return repository.month(month); },
    enabled: route.path !== "connections",
    refetchInterval: route.path !== "connections" ? 30000 : false,
  });
  const refresh = () => cache.invalidateQueries({ queryKey: ["balanced", session.user.id] });
  const changeMonth = (value: string) => setParams(old => { const next = new URLSearchParams(old); next.set("month", value); next.delete("offset"); return next; });
  return <div className="app-layout">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar"><Link className="brand" to={`/budget?month=${month}`}><span className="brand-mark"><Scale size={21} /></span><span>Perfectly<br className="brand-break" /> Balanced</span></Link>
      <p className="sidebar-label">WORKSPACE</p><nav aria-label="Main navigation">{routes.map(r => <NavLink key={r.path} to={`/${r.path}?month=${month}`}><r.icon size={18} /><span>{r.label}</span></NavLink>)}</nav>
      <div className="account-area"><div className="account-avatar">{session.user.email?.slice(0, 1).toUpperCase() ?? "P"}</div><div><strong>Personal budget</strong><small title={session.user.email}>{session.user.email}</small></div>
        <button className="icon-button" aria-label="Sign out" disabled={op.pending} onClick={() => guardedAction(async () => { await op.run(async () => {
          if (!repository) throw new Error("Backend configuration missing.");
          const { error } = await repository.client.auth.signOut();
          if (error) throw new Error(error.message);
          cache.clear();
        }); })}><LogOut size={17} /></button>
      </div>
    </aside>
    <main id="main-content" className="workspace" tabIndex={-1}>
      <header className="workspace-header"><div><p className="overline">{route.label === "Budget" ? "MONTHLY PLAN" : route.label === "Transactions" ? "MONTHLY ACTIVITY" : route.path === "connections" ? "CONNECTED ACCOUNTS" : "MONTHLY INSIGHTS"}</p><h1>{route.title}</h1><p className="muted">{route.description}</p></div>
        {route.path !== "connections" && <div className="month-control"><button className="icon-button" aria-label="Previous month" disabled={month === "0001-01"} onClick={() => changeMonth(shiftMonth(month, -1))}><ChevronLeft size={17} /></button><input aria-label="Selected month" type="month" value={month} min="0001-01" max="9999-12" onChange={e => { if (e.target.value) changeMonth(e.target.value); }} /><button className="icon-button" aria-label="Next month" disabled={month === "9999-12"} onClick={() => changeMonth(shiftMonth(month, 1))}><ChevronRight size={17} /></button></div>}
      </header>{op.feedback}
      {route.path === "connections" ? <Suspense fallback={<p role="status">Loading connections...</p>}><Connections uid={session.user.id} /></Suspense> : query.isPending ? <div className="loading-state" role="status"><span className="loading-line" /><span className="loading-line" /><span>Loading your month...</span></div> : query.error ? <div className="error-state"><h2>Couldn't load this month</h2><p role="alert">{query.error.message}</p><button onClick={() => void query.refetch()}>Retry</button></div> : repository && query.data &&
        <BudgetContext.Provider value={{ month, data: query.data, repo: repository, uid: session.user.id, refresh, notify: (text, important = false) => setNotice({ text, id: Date.now(), important }), command: async command => {
          if (!repository) throw new Error("Backend configuration missing.");
          await repository.mutate(command); await refresh();
          let text = "Budget updated.";
          const important = ["split", "date", "exclude"].includes(command.action);
          if (command.action === "split") text = "Category updated. Transactions that no longer match your filters leave the list.";
          if (command.action === "date") text = `Date saved${command.date ? `: ${command.date}` : ": original date restored"}. Assignments are retained; activity outside this month leaves the list.`;
          if (command.action === "exclude") text = command.excluded ? "Excluded from budget & reports. Find it in the excluded filter to restore." : "Transaction restored to budget & reports.";
          if (command.action === "manual") text = "Transaction added to its dated month.";
          setNotice({ text, id: Date.now(), important });
        } }}>
          <Suspense fallback={<div className="loading-state" role="status">Loading view...</div>}><Routes>
            <Route path="/budget" element={<Budget />} /><Route path="/transactions" element={<Transactions />} /><Route path="/reports" element={<Reports />} />
            <Route path="*" element={<Navigate to={`/budget?month=${month}`} replace />} />
          </Routes></Suspense>
        </BudgetContext.Provider>}
    </main>
    {notice && <div className="toast" key={notice.id} role="status"><span className="toast-dot" /><span>{notice.text}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={16} /></button></div>}
  </div>;
}
