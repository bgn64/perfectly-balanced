"use client";
import { Component, useState, type ReactNode } from "react";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Auth } from "./app/Auth";
import { Shell } from "./app/Shell";
import { DraftProvider } from "./components/ui";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <main className="standalone-state"><h1>Something went wrong</h1><p role="alert">{this.state.error}</p><button onClick={() => window.location.reload()}>Reload</button></main> : this.props.children; }
}
export function WorkspaceClient({ user }: { user: { id: string; email: string } | null }) {
  const [cache] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));
  // Keep the existing data-router draft blockers inside the Next.js server-authenticated shell.
  const [router] = useState(() => createBrowserRouter([{ path: "*", element: <DraftProvider>{user ? <Shell session={{ user }} /> : <Auth />}</DraftProvider> }]));
  return <ErrorBoundary><QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider></ErrorBoundary>;
}
