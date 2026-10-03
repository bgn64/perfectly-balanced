import { useState } from "react";
import { ArrowRight, Scale } from "lucide-react";
import { client } from "./backend";
import { text, useOperation } from "./context";
import { authSettings } from "./environment";

export function Auth({ recovery }: { recovery: boolean }) {
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const op = useOperation();
  const title = recovery ? "Choose a new password" : mode === "signup" ? "Create your account" : mode === "reset" ? "Reset your password" : "Welcome back";
  return <main className="auth-layout">
    <section className="auth-story"><div className="brand"><span className="brand-mark"><Scale size={24} /></span>Perfectly Balanced</div><div><p className="overline">A calmer way to manage money</p><h1>A little intention.<br />A clearer picture.</h1><p>Build a plan, organize your transactions, and see where your money goes.</p><div className="auth-illustration" aria-hidden="true"><span>Monthly balance</span><div className="illustration-line" /><div className="illustration-line short" /><div className="illustration-line medium" /><div className="illustration-line short" /></div></div><small>Built around your priorities.</small></section>
    <section className="auth-form-area"><div className="auth-form"><div className="auth-mobile-brand"><Scale size={24} />Perfectly Balanced</div><h2>{title}</h2><p className="muted">{recovery ? "Use at least eight characters for your new password." : mode === "signup" ? "Start with a plan that fits your life." : mode === "reset" ? "We'll send you a link to get back in." : "Sign in to your monthly picture."}</p>
      <form onSubmit={e => {
        e.preventDefault(); const f = new FormData(e.currentTarget);
        void op.run(async () => {
          if (!client) throw new Error("Backend configuration missing.");
          if (mode === "signup" && !authSettings.allowSignup) throw new Error("Account registration is disabled.");
          const email = recovery ? "" : text(f, "email");
          const result = recovery ? await client.auth.updateUser({ password: text(f, "password") }) :
            mode === "reset" ? await client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin }) :
              mode === "signup" ? await client.auth.signUp({ email, password: text(f, "password") }) :
                await client.auth.signInWithPassword({ email, password: text(f, "password") });
          if (result.error) throw new Error(result.error.message);
          if (recovery) window.location.assign(window.location.origin);
        }, mode === "reset" ? authSettings.resetMessage : mode === "signup" ? "Account created. If required, check your email to confirm it." : "");
      }}><fieldset disabled={op.pending}>
        {!recovery && <label>Email<input name="email" type="email" autoComplete="email" placeholder="you@example.com" required /></label>}
        {(recovery || mode !== "reset") && <label>Password<input name="password" type="password" minLength={8} autoComplete={mode === "signin" && !recovery ? "current-password" : "new-password"} required /></label>}
        <button className="auth-submit">{op.pending ? "Please wait..." : title}<ArrowRight size={17} /></button>
      </fieldset></form>{op.feedback}
      {!recovery && <div className="auth-links">{(authSettings.allowSignup || mode === "reset") && <button className="link" onClick={() => setMode(mode === "signup" || mode === "reset" ? "signin" : "signup")}>{mode === "signup" || mode === "reset" ? "Sign in instead" : "Create an account"}</button>}{mode !== "reset" && <button className="link" onClick={() => setMode("reset")}>Forgot password?</button>}</div>}
    </div></section>
  </main>;
}
