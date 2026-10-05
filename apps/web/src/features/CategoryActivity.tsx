import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { categoryActual, money, type Bucket } from "@balanced/domain";
import type { Filters } from "@balanced/data";
import { useBudget } from "../app/context";
import { EmptyState, Modal } from "../components/ui";
import { TransactionSheet } from "./TransactionDetails";
import { categoryRows, groupActivity, type ActivityRow } from "./categoryActivity";

export type ActivityScope =
  | { source: "budget"; categoryId: string; name: string; sectionName: string; income: boolean }
  | { source: "report"; categoryId: string; name: string; sectionId: string; sectionName: string; kind: "income" | "spending" };

function ActivityList({ rows, open }: { rows: ActivityRow[]; open: (id: string) => void }) {
  return <ul className="activity-list">{rows.map(({ transaction: t, value }) => <li key={t.id} data-transaction-id={t.id}>
    <button className="activity-open" aria-label={`Open ${t.description} details`} onClick={() => open(t.id)}>
      <span><strong>{t.description}</strong><small><time dateTime={t.effective_date}>{t.effective_date}</time>{t.merchant ? ` · ${t.merchant}` : ""}</small>
        {t.allocations.length > 1 && <small>Transaction total {money(t.amount_cents)} · {t.allocations.length} splits</small>}
        {t.excluded && <span className="badge">Excluded</span>}{t.provider_removed && <span className="badge">Bank removed</span>}
      </span><span className="activity-value number">{money(value)}<small>Category amount</small></span>
    </button>
  </li>)}</ul>;
}

export function CategoryActivity({ scope, bucket, close }: { scope: ActivityScope; bucket?: Bucket; close: () => void }) {
  const { month, repo, uid, data } = useBudget();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const results = useRef<HTMLDivElement>(null);
  const filters: Filters = { category: scope.categoryId, search: "", uncategorized: false, excluded: "include", sort: "date_desc", offset };
  const query = useQuery({
    queryKey: ["balanced", uid, "page", month, filters],
    queryFn: () => repo.page(month, filters),
    enabled: scope.source === "budget",
    placeholderData: keepPreviousData,
    refetchInterval: 30000,
  });
  const reportRows = groupActivity(bucket?.details ?? []);
  const income = scope.source === "budget" ? scope.income : scope.kind === "income";
  const rows = scope.source === "budget" ? categoryRows(query.data?.items ?? [], scope.categoryId, income) : reportRows.slice(offset, offset + 30);
  const total = scope.source === "budget" ? query.data?.total ?? 0 : reportRows.length;
  const net = scope.source === "budget" ? categoryActual(data, scope.categoryId) * (income ? 1 : -1) : bucket?.value ?? 0;
  const pending = scope.source === "budget" && query.isPending;
  const stale = scope.source === "budget" && query.isPlaceholderData;
  const error = scope.source === "budget" ? query.error : null;
  const current = rows.find(row => row.transaction.id === selected)?.transaction;
  const updating = scope.source === "budget" && query.isFetching;
  useEffect(() => {
    if (!pending && !updating && !error && offset >= total && offset > 0) setOffset(Math.max(0, Math.ceil(total / 30) - 1) * 30);
  }, [total, offset, pending, updating, error]);
  useEffect(() => {
    if (selected && !current && !updating && !error) {
      setSelected(null);
      setNotice("Transaction no longer matches this view.");
    }
  }, [selected, current, updating, error]);
  return <Modal title={`${scope.name} transactions`} description={`${month} · ${scope.sectionName}`} sheet onClose={close}>
    <div className="activity-summary"><span className="activity-total">{income ? "Net received" : "Net spent"}<strong className="number">{money(net)}</strong></span>
      {scope.source === "budget" && <span className="badge">Includes excluded</span>}
    </div>
    <div ref={results} tabIndex={-1} className="results-heading" role="status">{pending ? "Loading transactions..." : `${total} transactions`}{updating && !pending && <span>Updating...</span>}</div>
    {notice && <p role="status" className="feedback">{notice}</p>}
    {pending ? <p role="status">Loading transactions...</p> : error ? <div className="error-state"><p role="alert">{error.message}</p><button onClick={() => void query.refetch()}>Retry</button></div> :
      <section aria-label="Category transaction results" aria-busy={updating} inert={stale}>
        {rows.length ? <ActivityList rows={rows} open={id => { setNotice(""); setSelected(id); }} /> : <EmptyState icon={Inbox} title="No transactions in this view" />}
      </section>}
    <div className="pagination"><span>{total ? `${offset + 1}-${Math.min(offset + 30, total)} of ${total}` : "0 results"}</span><div>
      <button className="secondary" disabled={!offset || pending || stale || !!error} onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</button>
      <button className="secondary" disabled={offset + 30 >= total || pending || stale || !!error} onClick={() => setOffset(offset + 30)}>Next</button>
    </div></div>
    {current && <TransactionSheet transaction={current} close={() => setSelected(null)} returnFocusRef={results} />}
  </Modal>;
}
