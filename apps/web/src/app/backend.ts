import { makeClient, SupabaseRepository } from "@balanced/data";
import { errorMessage } from "./context";
import { authSettings } from "./environment";

const env = import.meta.env;
export let client: ReturnType<typeof makeClient> | null = null;
export let configurationError = authSettings.configurationMessage;
if (env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY) {
  try { client = makeClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY); }
  catch (error) { configurationError = errorMessage(error); }
}
export const repository = client ? new SupabaseRepository(client) : null;
