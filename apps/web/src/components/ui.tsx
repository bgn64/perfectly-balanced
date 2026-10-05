import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, MoreHorizontal, X, type LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useBlocker } from "react-router-dom";
import { dollars, money, parseMoney } from "@balanced/domain";
import { useOperation } from "../app/context";

type DraftContextValue = { register: (id: string, dirty: boolean, pending: boolean) => void; generation: number; requestAction: (action: () => Promise<void>) => void; launcher: RefObject<HTMLElement | null> };
const DraftContext = createContext<DraftContextValue>({ register: () => { throw new Error("Draft provider unavailable."); }, generation: 0, requestAction: () => { throw new Error("Draft provider unavailable."); }, launcher: { current: null } });
const ModalDraftContext = createContext<DraftContextValue["register"] | null>(null);
const FocusReturnContext = createContext<((event: Event) => void) | null>(null);
const ModalDepthContext = createContext(0);
export function DraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Map<string, boolean>>(new Map());
  const [generation, setGeneration] = useState(0);
  const [action, setAction] = useState<(() => Promise<void>) | null>(null);
  const launcher = useRef<HTMLElement | null>(null);
  const register = useCallback((id: string, dirty: boolean, pending: boolean) => setDrafts(old => {
    if (old.has(id) === (dirty || pending) && (!old.has(id) || old.get(id) === pending)) return old;
    const next = new Map(old); if (dirty || pending) next.set(id, pending); else next.delete(id); return next;
  }), []);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => drafts.size > 0 &&
    `${currentLocation.pathname}${currentLocation.search}` !== `${nextLocation.pathname}${nextLocation.search}`);
  useEffect(() => {
    if (blocker.state === "blocked" && !drafts.size) blocker.proceed();
  }, [blocker, drafts.size]);
  useEffect(() => {
    if (!drafts.size) return;
    const prevent = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [drafts.size]);
  return <DraftContext.Provider value={{ register, generation, launcher, requestAction: task => {
    if (drafts.size) setAction(() => task);
    else void task();
  } }}>{children}
    {blocker.state === "blocked" && <Confirm title="Discard unsaved changes?" description="Your changes have not been saved." confirmLabel="Discard and continue" onCancel={() => blocker.reset()} onConfirm={async () => {
      if ([...drafts.values()].some(Boolean)) throw new Error("Wait for saving to finish before leaving.");
      setGeneration(n => n + 1); setDrafts(new Map()); blocker.proceed();
    }} />}
    {action && <Confirm title="Discard unsaved changes?" description="Your changes have not been saved." confirmLabel="Discard and continue" onCancel={() => setAction(null)} onConfirm={async () => {
      if ([...drafts.values()].some(Boolean)) throw new Error("Wait for saving to finish before continuing.");
      setGeneration(n => n + 1); setDrafts(new Map()); await action(); setAction(null);
    }} />}
  </DraftContext.Provider>;
}
export function useGuardedAction() { return useContext(DraftContext).requestAction; }
function useReturnFocus(fallback?: RefObject<HTMLElement | null>) {
  const { launcher } = useContext(DraftContext);
  const parentReturn = useContext(FocusReturnContext);
  const active = document.activeElement;
  const target = useRef(active?.closest('[role="menu"]') || active === launcher.current ? launcher.current : active instanceof HTMLElement ? active : null);
  useEffect(() => { launcher.current = null; }, [launcher]);
  return (event: Event) => {
    event.preventDefault();
    if (target.current?.isConnected) target.current.focus({ preventScroll: true });
    else if (fallback?.current?.isConnected) fallback.current.focus({ preventScroll: true });
    else if (parentReturn) parentReturn(event);
    else document.getElementById("main-content")?.focus({ preventScroll: true });
  };
}
export function useDraft(dirty: boolean, pending = false) {
  const { register, generation } = useContext(DraftContext);
  const id = useId();
  const modalRegister = useContext(ModalDraftContext);
  useEffect(() => {
    register(id, dirty, pending); modalRegister?.(id, dirty, pending);
    return () => { register(id, false, false); modalRegister?.(id, false, false); };
  }, [register, modalRegister, id, dirty, pending]);
  return generation;
}
export function Modal({ title, description, children, onClose, dirty = false, pending = false, sheet = false, wide = false, returnFocusRef }: {
  title: string; description?: string; children: ReactNode; onClose: () => void;
  dirty?: boolean; pending?: boolean; sheet?: boolean; wide?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [discard, setDiscard] = useState(false);
  const depth = useContext(ModalDepthContext);
  const content = useRef<HTMLDivElement>(null);
  const returnFocus = useReturnFocus(returnFocusRef);
  const [drafts, setDrafts] = useState<Map<string, boolean>>(new Map());
  const register = useCallback((id: string, dirty: boolean, saving: boolean) => setDrafts(old => {
    if (old.has(id) === (dirty || saving) && (!old.has(id) || old.get(id) === saving)) return old;
    const next = new Map(old); if (dirty || saving) next.set(id, saving); else next.delete(id); return next;
  }), []);
  const saving = pending || [...drafts.values()].some(Boolean);
  function requestClose() { if (!saving) { if (dirty || drafts.size) setDiscard(true); else onClose(); } }
  return <FocusReturnContext.Provider value={returnFocus}><ModalDepthContext.Provider value={depth + 1}>
    <Dialog.Root open onOpenChange={open => { if (!open) requestClose(); }}>
      <Dialog.Portal><Dialog.Overlay className="overlay" style={{ zIndex: 50 + depth * 2 }} /><Dialog.Content ref={content} style={{ zIndex: 51 + depth * 2 }} className={`modal ${sheet ? "sheet" : ""} ${wide ? "wide" : ""}`} onOpenAutoFocus={e => {
        const field = content.current?.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:not([disabled]):not([type=file]), select:not([disabled]), textarea:not([disabled])");
        if (field) { e.preventDefault(); field.focus(); }
      }} onCloseAutoFocus={returnFocus} onEscapeKeyDown={e => { e.preventDefault(); requestClose(); }} onPointerDownOutside={e => { e.preventDefault(); requestClose(); }}>
        <header className="modal-header"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description className={description ? "muted" : "sr-only"}>{description ?? title}</Dialog.Description></div>
          <button type="button" className="icon-button" aria-label={`Close ${title}`} disabled={saving} onClick={requestClose}><X size={20} /></button>
        </header><div className="modal-body"><ModalDraftContext.Provider value={register}>{children}</ModalDraftContext.Provider></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
    {discard && <Confirm title="Discard unsaved changes?" description="These edits have not been saved." confirmLabel="Discard changes" onCancel={() => setDiscard(false)} onConfirm={async () => { setDiscard(false); onClose(); }} />}
  </ModalDepthContext.Provider></FocusReturnContext.Provider>;
}
export function Confirm({ title, description, confirmLabel = "Confirm", onConfirm, onCancel }: {
  title: string; description: string; confirmLabel?: string; onConfirm: () => Promise<void>; onCancel: () => void;
}) {
  const op = useOperation();
  const returnFocus = useReturnFocus();
  return <AlertDialog.Root open><AlertDialog.Portal><AlertDialog.Overlay className="overlay confirm-overlay" /><AlertDialog.Content className="modal confirmation" onCloseAutoFocus={returnFocus}>
    <AlertDialog.Title>{title}</AlertDialog.Title><AlertDialog.Description className="muted">{description}</AlertDialog.Description>
    {op.feedback}<div className="form-actions">
      <AlertDialog.Cancel asChild><button className="secondary" disabled={op.pending} onClick={onCancel}>Cancel</button></AlertDialog.Cancel>
      <button className="danger-button" disabled={op.pending} onClick={() => void op.run(async () => { await onConfirm(); })}>{op.pending ? "Please wait..." : confirmLabel}</button>
    </div>
  </AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>;
}
type MenuItem = { label: string; onSelect: () => void; icon?: LucideIcon; danger?: boolean; disabled?: boolean };
export function Menu({ label, items, textLabel }: { label: string; items: MenuItem[]; textLabel?: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const { launcher } = useContext(DraftContext);
  return <Dropdown.Root><Dropdown.Trigger asChild>
    <button ref={trigger} className={textLabel ? "secondary menu-trigger" : "icon-button"} aria-label={label}>{textLabel ? <>{textLabel}<ChevronDown size={15} /></> : <MoreHorizontal size={18} />}</button>
  </Dropdown.Trigger><Dropdown.Portal><Dropdown.Content className="dropdown" sideOffset={6} align="end">
    {items.map(item => <Dropdown.Item key={item.label} className={`dropdown-item ${item.danger ? "danger" : ""}`} disabled={item.disabled} onSelect={() => { launcher.current = trigger.current; item.onSelect(); }}>
      {item.icon && <item.icon size={16} />}<span>{item.label}</span>
    </Dropdown.Item>)}
  </Dropdown.Content></Dropdown.Portal></Dropdown.Root>;
}
export function ActionForm({ children, task, label = "Save", onSuccess, cancel, className = "" }: {
  children: ReactNode; task: (form: FormData) => Promise<void>; label?: string; onSuccess?: () => void; cancel?: () => void; className?: string;
}) {
  const op = useOperation();
  const ref = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(false);
  const generation = useDraft(dirty, op.pending);
  useEffect(() => { ref.current?.reset(); setDirty(false); }, [generation]);
  return <form ref={ref} className={className} onChange={() => setDirty(true)} onSubmit={e => {
    e.preventDefault(); const values = new FormData(e.currentTarget);
    void op.run(async () => { await task(values); setDirty(false); onSuccess?.(); });
  }}>
    <fieldset disabled={op.pending}>{children}<div className="form-actions">{cancel && <button type="button" className="secondary" onClick={cancel}>Cancel</button>}<button type="submit">{op.pending ? "Saving..." : label}</button></div></fieldset>
    {op.feedback}
  </form>;
}
export function MoneyCell({ value, name, save }: { value: number; name: string; save: (cents: number) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(dollars(value));
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const lastGeneration = useRef(0);
  const op = useOperation();
  const generation = useDraft(editing && raw !== dollars(value), op.pending);
  useEffect(() => {
    if (generation !== lastGeneration.current) { lastGeneration.current = generation; setEditing(false); setRaw(dollars(value)); }
  }, [generation, value]);
  useEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (wasEditing.current) trigger.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  if (!editing) return <button ref={trigger} className="money-edit number" aria-label={`Edit planned ${name}`} onClick={() => { setRaw(dollars(value)); setEditing(true); }}>{money(value)}</button>;
  return <form className="money-form" onKeyDown={e => { if (e.key === "Escape" && !op.pending) { e.stopPropagation(); setEditing(false); } }} onSubmit={e => {
    e.preventDefault();
    void op.run(async () => { const cents = parseMoney(raw); if (cents < 0) throw new Error("Planned amounts must be nonnegative."); await save(cents); setEditing(false); });
  }}>
    <div className="money-input-group"><input ref={input} disabled={op.pending} aria-label={`Planned ${name}`} inputMode="decimal" value={raw} onChange={e => setRaw(e.target.value)} required />
      <button className="icon-button save-icon" disabled={op.pending} aria-label={`Save planned ${name}`}><Check size={16} /></button>
      <button type="button" className="icon-button" disabled={op.pending} aria-label={`Cancel planned ${name}`} onClick={() => setEditing(false)}><X size={16} /></button>
    </div>{op.feedback}
  </form>;
}
export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon size={25} /></span><h3>{title}</h3>{children != null && children !== false && <p className="muted">{children}</p>}{action}</div>;
}
