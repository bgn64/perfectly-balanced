export function authEnvironment(development: boolean) {
  return {
    allowSignup: development,
    resetMessage: development
      ? "Password reset email sent. Open the local Mailpit inbox."
      : "Password reset requested. If your account can receive email, check your inbox for a recovery link.",
    configurationMessage: development
      ? "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps/web/.env.local, then restart Vite. See the README for local setup."
      : "Backend configuration is missing. Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the hosting project and rebuild the app.",
  };
}

export const authSettings = authEnvironment(import.meta.env.DEV);
