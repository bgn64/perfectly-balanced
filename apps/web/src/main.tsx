import React, { Component, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { client, configurationError } from "./app/backend";
import { errorMessage } from "./app/context";
import { Auth } from "./app/Auth";
import { Shell } from "./app/Shell";
import { DraftProvider } from "./components/ui";
import "./style.css";

const cache = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <main className="standalone-state"><h1>Something went wrong</h1><p role="alert">{this.state.error}</p><button onClick={() => window.location.reload()}>Reload</button></main> : this.props.children; }
}
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(window.location.hash.includes("type=recovery"));
  useEffect(() => {
    if (!client) { setLoading(false); return; }
    let active = true;
    void client.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setError(error.message);
      setSession(data.session); setLoading(false);
    }).catch(e => { if (active) { setError(errorMessage(e)); setLoading(false); } });
    const { data } = client.auth.onAuthStateChange((event, value) => { setSession(value); if (event === "PASSWORD_RECOVERY") setRecovery(true); });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);
  if (!client) return <main className="standalone-state"><h1>Connect your backend</h1><p role="alert">{configurationError}</p></main>;
  if (loading) return <main className="standalone-state"><p role="status">Connecting to your workspace...</p></main>;
  if (error) return <main className="standalone-state"><h1>Couldn't connect</h1><p role="alert">{error}</p><button onClick={() => window.location.reload()}>Retry</button></main>;
  return session && !recovery ? <Shell session={session} /> : <Auth recovery={recovery} />;
}
const router = createBrowserRouter([{ path: "*", element: <DraftProvider><App /></DraftProvider> }]);
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ErrorBoundary><QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider></ErrorBoundary></React.StrictMode>,
);
