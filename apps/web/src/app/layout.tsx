import type { ReactNode } from "react";
import "../style.css";
export const metadata = { title: "Perfectly Balanced", description: "Your personal monthly budget" };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
