import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePlaidLink } from "react-plaid-link";
import { z } from "zod";
import { Clock, Landmark, RefreshCw, ShieldCheck } from "lucide-react";
import { dollars, money, parseMoney, type BankReview, type Banking } from "@balanced/domain";
import { repository } from "../app/backend";
import { bankDate, bankIssueMessage, connectionStatus, importStartDate, reviewReason } from "../app/banking";
import { useOperation } from "../app/context";
import { Confirm, EmptyState, Modal, useDraft } from "../components/ui";

const linkStateSchema = z.object({
  token: z.string(), intent: z.string().uuid().nullable(), repair: z.string().uuid().nullable(),
  owner: z.string().uuid(), expires: z.number(),
});
type LinkState = z.infer<typeof linkStateSchema>;
function restoreLink(uid: string): { state: LinkState | null; error: string } {
  const saved = sessionStorage.getItem("balanced-plaid-link");
  if (!saved) return { state: null, error: window.location.search.includes("oauth_state_id") ? "Bank authorization state is missing. Start the connection again." : "" };
  const parsed = linkStateSchema.safeParse(JSON.parse(saved));
  if (!parsed.success || parsed.data.owner !== uid || parsed.data.expires < Date.now()) {
    sessionStorage.removeItem("balanced-plaid-link");
    return { state: null, error: "Bank authorization expired. Start the connection again." };
  }
  return { state: parsed.data, error: "" };
}
function BankLink({ state, complete, exit }: { state: LinkState; complete: (token: string) => void; exit: (error: string) => void }) {
  const opened = useRef(false);
  const { open, ready, error } = usePlaidLink({
    token: state.token,
    ...(new URLSearchParams(window.location.search).has("oauth_state_id") ? { receivedRedirectUri: window.location.href } : {}),
    onSuccess: token => complete(token),
    onExit: error => exit(error ? "Bank authorization could not be completed. Please try again." : "Bank authorization canceled."),
  });
  useEffect(() => { if (ready && !opened.current) { opened.current = true; open(); } }, [ready, open]);
  useEffect(() => { if (error) exit("Plaid Link could not load. Check your connection and retry."); }, [error, exit]);
  return <p role="status">Opening secure Plaid authorization...</p>;
}
function AccountSelection({ connection, save, close }: {
  connection: Banking["connections"][number]; save: (accounts: string[]) => Promise<void>; close: () => void;
}) {
  const [selected, setSelected] = useState(connection.accounts.filter(a => a.selected).map(a => a.account_id));
  const op = useOperation();
  const dirty=JSON.stringify([...selected].sort())!==JSON.stringify(connection.accounts.filter(a => a.selected).map(a => a.account_id).sort());
  useDraft(dirty,op.pending);
  return <Modal title="Select bank accounts" description="Import transactions from the checking, savings and credit accounts you select. Deselecting an account keeps its existing transactions." onClose={close} pending={op.pending} dirty={dirty}>
    <form onSubmit={e => { e.preventDefault(); void op.run(async () => { await save(selected); close(); }); }}>
      <fieldset disabled={op.pending}>{connection.accounts.map(a => <label className="bank-account" key={a.account_id}>
        <input type="checkbox" checked={selected.includes(a.account_id)} disabled={!["depository", "credit"].includes(a.type)}
          onChange={e => setSelected(old => e.target.checked ? [...old, a.account_id] : old.filter(id => id !== a.account_id))} />
        <span>{a.name}{a.mask ? ` (ending in ${a.mask})` : ""}<small>{["depository", "credit"].includes(a.type) ? a.subtype?.replaceAll("_", " ") || (a.type === "credit" ? "Credit account" : "Bank account") : "Transaction imports are not available for this account"}</small></span>
      </label>)}<button disabled={!selected.length}>{op.pending ? "Saving..." : "Save accounts and start sync"}</button></fieldset>
    </form>{op.feedback}
  </Modal>;
}
function Review({ review, resolve, close }: {
  review: BankReview; resolve: (decision: string, transaction?: string, allocations?: { category_id: string | null; amount_cents: number }[], revision?: number) => Promise<void>; close: () => void;
}) {
  const [candidate, setCandidate] = useState(review.transaction_id ?? review.candidates[0]?.id ?? "");
  const existing = review.candidates.find(c => c.id === candidate);
  const [amounts, setAmounts] = useState((existing?.allocations ?? []).map(a => dollars(a.amount_cents)));
  const op = useOperation();
  const incoming = review.record;
  const changedAmount = incoming && existing && incoming.amount_cents !== existing.amount_cents;
  const dirty=JSON.stringify(amounts)!==JSON.stringify((existing?.allocations ?? []).map(a => dollars(a.amount_cents)));
  useDraft(dirty,op.pending);
  const accept = (decision: string) => op.run(async () => {
    const allocations = changedAmount ? existing.allocations.map((a, i) => ({ category_id: a.category_id, amount_cents: parseMoney(amounts[i]) })) : undefined;
    await resolve(decision, candidate || undefined, allocations, existing?.revision); close();
  });
  return <Modal title="Review bank activity" onClose={close} pending={op.pending} dirty={dirty} description="Activity awaiting review does not affect your totals. Existing transactions stay unchanged until you accept an update.">
    <p><strong>{reviewReason[review.reason]}</strong></p>
    {incoming && <p>{bankDate(incoming.original_date)} - {incoming.description} - {money(incoming.amount_cents)}</p>}
    {review.error && <><p role="alert">{bankIssueMessage(review.error)}</p><details className="bank-details"><summary>Technical details</summary><p>{review.error}</p></details></>}
    {review.candidates.length>0 && <label>Existing transaction<select value={candidate} disabled={review.reason !== "overlap"} onChange={e => {
      setCandidate(e.target.value); setAmounts(review.candidates.find(c => c.id === e.target.value)!.allocations.map(a => dollars(a.amount_cents)));
    }}>{review.candidates.map(c => <option value={c.id} key={c.id}>{c.original_date} - {c.description} - {money(c.amount_cents)}</option>)}</select></label>}
    {existing && <div className="bank-comparison"><p>Current amount: {money(existing.amount_cents)}. {existing.excluded ? "Excluded from budgets by you." : ""}</p>
      <p>{existing.date_override ? `Your custom date: ${bankDate(existing.date_override)}` : `Original date: ${bankDate(existing.original_date)}`}. Your categories and splits are kept.</p>
      {changedAmount && <><p>Adjust your category splits to total {money(incoming.amount_cents)} before accepting the new amount. Your assigned categories stay the same.</p>
        {existing.allocations.map((a, i) => <label key={i}>Split {i+1} ({a.category_id ? "assigned category" : "uncategorized"})
          <input aria-label={`New amount for split ${i+1}`} value={amounts[i]} inputMode="decimal" onChange={e => setAmounts(old => old.map((v, j) => i===j ? e.target.value : v))} /></label>)}</>}
    </div>}
    <div className="form-actions">
      <button className="secondary" disabled={op.pending} onClick={() => void op.run(async () => { await resolve("ignore"); close(); })}>
        {review.reason === "amount" || review.reason === "removed" ? "Keep existing transaction" : "Do not import"}</button>
      {review.reason === "overlap" && <><button disabled={op.pending} onClick={() => void accept("match")}>Match existing transaction</button>
        <button disabled={op.pending} onClick={() => void op.run(async () => { await resolve("new"); close(); })}>Import as separate transaction</button></>}
      {(review.reason === "amount" || review.reason === "removed") && <button disabled={op.pending} onClick={() => void accept("accept")}>Accept bank change</button>}
    </div>{op.feedback}
  </Modal>;
}
export function Connections({ uid }: { uid: string }) {
  const repo = repository;
  const cache = useQueryClient();
  const op = useOperation();
  const [restored] = useState(() => {
    try { return restoreLink(uid); }
    catch { sessionStorage.removeItem("balanced-plaid-link"); return { state: null, error: "Saved bank authorization was invalid. Start again." }; }
  });
  const [link, setLink] = useState<LinkState | null>(restored.state);
  const [message, setMessage] = useState(restored.error);
  const [start, setStart] = useState(() => importStartDate());
  const [offset, setOffset] = useState(0);
  const [accounts, setAccounts] = useState<Banking["connections"][number] | null>(null);
  const [disconnect, setDisconnect] = useState<Banking["connections"][number] | null>(null);
  const [review, setReview] = useState<BankReview | null>(null);
  const query = useQuery({ queryKey: ["banking", uid, offset], queryFn: () => {
    if (!repo) throw new Error("Backend configuration missing."); return repo.banking(offset);
  }, refetchInterval: 5000 });
  const version = query.data?.connections.map(c => `${c.id}:${c.last_synced_at}`).join("|");
  useEffect(() => { void cache.invalidateQueries({ queryKey: ["balanced", uid] }); }, [cache, uid, version]);
  const refresh = async () => { await Promise.all([cache.invalidateQueries({ queryKey: ["banking", uid] }), cache.invalidateQueries({ queryKey: ["balanced", uid] })]); };
  const clearLink = () => {
    sessionStorage.removeItem("balanced-plaid-link"); setLink(null);
    if (new URLSearchParams(window.location.search).has("oauth_state_id")) window.history.replaceState(null, "", "/connections");
  };
  const begin = (repair?: string) => op.run(async () => {
    if (!repo) throw new Error("Backend configuration missing.");
    if (new URLSearchParams(window.location.search).has("oauth_state_id")) window.history.replaceState(null,"","/connections");
    const result = z.object({ link_token: z.string(), intent_id: z.string().uuid().nullable() })
      .parse(await repo.bank(repair ? { action: "repair", id: repair } : { action: "link", import_start: start }));
    const state: LinkState = { token: result.link_token, intent: result.intent_id, repair: repair ?? null, owner: uid, expires: Date.now()+30*60*1000 };
    sessionStorage.setItem("balanced-plaid-link", JSON.stringify(state)); setLink(state); setMessage("");
  });
  return <div className="connections-view">
    {import.meta.env.DEV && <aside className="bank-sandbox" aria-label="Sandbox test instructions"><strong>Local testing: Plaid Sandbox</strong>
      <p>Use a test bank, not your real bank login. Continue without a phone number, search for <strong>First Platypus Bank</strong> and choose the option without "OAuth". Enter <code>user_transactions_dynamic</code> as the username and any nonblank test password.</p>
      <p>Test transactions are saved to local Supabase. OAuth test banks require the optional local HTTPS setup; no real money or bank accounts are connected.</p>
    </aside>}
    <section className="bank-card bank-connect"><div className="bank-introduction"><span className="bank-symbol"><ShieldCheck size={24} aria-hidden="true" /></span><div><h2>Connect a bank securely</h2>
      <p className="muted">Link your bank through Plaid to automatically import transactions. You choose which accounts to include; new transactions arrive uncategorized.</p>
      <p className="bank-security">Your bank login is handled by Plaid and your bank, never by this app.</p></div></div>
      <form className="bank-connect-form" onSubmit={e => { e.preventDefault(); void begin(); }}>
        <label htmlFor="bank-import-start">Import transactions starting</label>
        <input id="bank-import-start" type="date" value={start} max={importStartDate()} onChange={e => setStart(e.target.value)} required aria-describedby="bank-import-help" />
        <p id="bank-import-help" className="muted">Choose an earlier date to include past activity. Possible duplicates wait for your review before affecting totals.</p>
        <button disabled={op.pending || !!link || !start}><Landmark size={16} aria-hidden="true" />{op.pending ? "Connecting..." : "Connect a bank"}</button>
      </form>
      {message && <p role={restored.error === message ? "alert" : "status"}>{message}</p>}{op.feedback}
      {link && <BankLink state={link} complete={token => { void op.run(async () => {
        if (!repo) throw new Error("Backend configuration missing.");
        if (link.repair) await repo.bank({ action: "repaired", id: link.repair });
        else {
          if (!link.intent) throw new Error("Connection intent missing.");
          await repo.bank({ action: "exchange", intent_id: link.intent, public_token: token });
        }
        clearLink(); await refresh(); setMessage(link.repair ? "Bank reconnected. Transactions will update shortly." : "Bank connected. Select accounts below to start importing transactions.");
      }).then(success => { if (!success) { clearLink(); void query.refetch(); setMessage("Authorization could not be completed. Check the connection list before trying again."); } }); }} exit={error => { clearLink(); setMessage(error); }} />}
    </section>
    {query.isPending ? <p role="status">Loading connections...</p> : query.error ? <div role="alert">{query.error.message}<button onClick={() => void query.refetch()}>Retry</button></div> : query.data && <>
      <section aria-label="Bank connections"><h2>Your connections</h2>{query.data.connections.length===0 && <div className="bank-card"><EmptyState icon={Landmark} title="No banks connected yet">Connect a bank above, then choose the accounts you want to import.</EmptyState></div>}
        {query.data.connections.map(c => <article className="bank-card" key={c.id}><header className="bank-card-header"><div className="bank-institution"><span className="bank-symbol"><Landmark size={20} aria-hidden="true" /></span><h3>{c.institution_name}</h3></div><span className={`bank-status bank-status-${c.status}`}>{connectionStatus[c.status]}</span></header>
          <div className="bank-metadata"><span>Import start <strong>{bankDate(c.import_start)}</strong></span><span>Last updated <strong>{c.last_synced_at ? new Date(c.last_synced_at).toLocaleString() : "Not yet"}</strong></span></div>
          {c.status==="syncing" && !c.historical_complete && <p className="muted">Your bank is preparing transaction history. Available activity will appear automatically.</p>}
          {c.error_code && <div className="bank-attention"><p role="alert">{c.status==="needs_reconnect" ? "Your bank needs you to sign in again. Reconnect to continue importing transactions." : c.status==="disconnecting" ? "We couldn't finish disconnecting this bank. Retry to revoke access." : "We couldn't update this bank. Try syncing again, or reconnect if the problem continues."}</p><details className="bank-details"><summary>Technical details</summary><p>{c.error_code}</p></details></div>}
          <ul className="bank-accounts">{c.accounts.map(a => <li key={a.account_id}><span>{a.name}{a.mask && <small>Ending in {a.mask}</small>}</span><span className="muted">{["disconnecting","disconnected"].includes(c.status) ? "Imports stopped" : a.selected ? "Included" : "Not included"}</span></li>)}</ul>
          {c.status !== "disconnected" && <div className="bank-actions">
            <button className="secondary" disabled={op.pending || !!link || c.status==="disconnecting"} onClick={() => setAccounts(c)}>Select accounts</button>
            <button className="secondary" disabled={op.pending || !!link || ["select_accounts","needs_reconnect","disconnecting"].includes(c.status)} onClick={() => void op.run(async () => { await repo!.bank({ action: "sync", id: c.id }); await refresh(); }, "Checking for available transactions. Updates may take a few moments.")}><RefreshCw size={14} aria-hidden="true" />Sync now</button>
            <button className="secondary" disabled={op.pending || !!link || c.status==="disconnecting"} onClick={() => void begin(c.id)}>Reconnect</button>
            <button className="secondary" disabled={op.pending || !!link} onClick={() => setDisconnect(c)}>{c.status==="disconnecting" ? "Retry disconnect" : "Disconnect"}</button>
          </div>}
        </article>)}
      </section>
      <section className="bank-card"><h2>Review activity ({query.data.review_total})</h2><p className="muted">Check possible duplicates and bank changes before they affect your totals. Existing transactions stay unchanged until you decide.</p>
        {!query.data.review_total && <p className="bank-empty">You're all caught up. No activity needs review.</p>}
        {query.data.reviews.map(r => <div className="bank-review" key={r.id}><div><strong>{r.record?.description ?? "Bank transaction"}</strong><small className="muted">{reviewReason[r.reason]}{r.record ? ` - ${bankDate(r.record.original_date)}` : ""}</small></div>{r.record && <span className="number">{money(r.record.amount_cents)}</span>}<button className="secondary" onClick={() => setReview(r)}>Review</button></div>)}
      </section>
      <section className="bank-card"><h2 className="bank-pending-title"><Clock size={17} aria-hidden="true" />Pending activity ({query.data.pending_total})</h2><p className="muted">Not included in budgets or reports until posted. Final dates and amounts may change.</p>
        {!query.data.pending_total && <p className="bank-empty">No pending transactions.</p>}
        {query.data.pending.map(p => <div className="bank-review" key={`${p.connection_id}:${p.transaction_id}`}><div><strong>{p.description}</strong><small className="muted">{bankDate(p.original_date)}</small></div><span className="number">{money(p.amount_cents)}</span></div>)}
      </section>
      {(offset > 0 || Math.max(query.data.review_total,query.data.pending_total) > 30) && <div className="pagination"><button className="secondary" disabled={!offset} onClick={() => setOffset(n => n-30)}>Previous activity</button><span>Page {offset/30+1}</span>
        <button className="secondary" disabled={offset+30>=Math.max(query.data.review_total,query.data.pending_total)} onClick={() => setOffset(n => n+30)}>Next activity</button></div>}
    </>}
    {accounts && <AccountSelection connection={accounts} close={() => setAccounts(null)} save={async selected => { await repo!.bank({ action: "accounts", id: accounts.id, accounts: selected }); await refresh(); }} />}
    {disconnect && <Confirm title="Disconnect this bank?" description="Stop importing new transactions and revoke this connection's Plaid access. Your existing transactions and categories stay unchanged. To connect again, you'll need to authorize your bank."
      confirmLabel="Disconnect bank" onCancel={() => setDisconnect(null)} onConfirm={async () => { await repo!.bank({ action: "disconnect", id: disconnect.id }); await refresh(); setDisconnect(null); }} />}
    {review && <Review review={review} close={() => setReview(null)} resolve={async (decision, transaction, allocations, revision) => {
      await repo!.resolveBank(review.id, review.version, decision, transaction, allocations, revision); await refresh();
    }} />}
  </div>;
}
