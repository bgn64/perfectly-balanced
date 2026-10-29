"use client";
import dynamic from "next/dynamic";
const Client = dynamic(() => import("../main").then(m => m.WorkspaceClient), { ssr: false });
export function Workspace({ user }: { user: { id: string; email: string } | null }) {
  return <Client user={user} />;
}
