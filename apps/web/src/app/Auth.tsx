import { useState } from "react";
import { ArrowRight, Scale } from "lucide-react";
import { text, useOperation } from "./context";

export function Auth() {
  const op = useOperation();
  const [recovery, setRecovery] = useState(false);
  return <main className="auth-layout">
    <section className="auth-story"><div className="brand"><span className="brand-mark"><Scale size={24} /></span>Perfectly Balanced</div><div><p className="overline">A calmer way to manage money</p><h1>A little intention.<br />A clearer picture.</h1><p>Build a plan, organize your transactions, and see where your money goes.</p></div><small>Built around your priorities.</small></section>
    <section className="auth-form-area"><div className="auth-form"><div className="auth-mobile-brand"><Scale size={24} />Perfectly Balanced</div><h2>Welcome back</h2><p className="muted">Sign in to your monthly picture.</p>
      <form onSubmit={e => {
        e.preventDefault(); const f = new FormData(e.currentTarget);
        void op.run(async () => {
          const response = await fetch("/api/auth/sign-in/email", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: text(f, "email"), password: text(f, "password") }),
          });
          if (!response.ok) throw new Error(response.status === 429 ? "Too many sign-in attempts. Please wait before retrying." : "Sign-in failed. Check your email and password.");
          window.location.reload();
        });
      }}><fieldset disabled={op.pending}>
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="auth-submit">{op.pending ? "Please wait..." : "Sign in"}<ArrowRight size={17} /></button>
      </fieldset></form>{op.feedback}
      <div className="auth-links"><button className="link" onClick={() => setRecovery(!recovery)}>Forgot password?</button></div>
      {recovery && <p role="status">Ask the household administrator to reset your password using the local account command. Email recovery and public registration are disabled.</p>}
    </div></section>
  </main>;
}
