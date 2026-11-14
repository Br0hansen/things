import { createClient, type Session } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, "") ?? "";
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export const isAuthConfigured = Boolean(supabaseUrl && supabaseKey);

const authClient = isAuthConfigured
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: "things-auth-session",
      },
    })
  : null;

export type AuthSession = Session;

export async function loadAuthSession(): Promise<AuthSession | null> {
  if (!authClient) return null;
  const { data, error } = await authClient.auth.getSession();
  if (error) throw error;
  return data.session;
}

export function onAuthSessionChanged(callback: (session: AuthSession | null) => void) {
  if (!authClient) return () => undefined;
  const { data } = authClient.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export async function sendMagicLink(email: string): Promise<void> {
  if (!authClient) throw new Error("Supabase Auth er ikke konfigurert.");
  const emailRedirectTo = new URL(import.meta.env.BASE_URL, location.origin).toString();
  const { error } = await authClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo, shouldCreateUser: true },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (!authClient) return;
  const { error } = await authClient.auth.signOut({ scope: "local" });
  if (error) throw error;
}

export async function getAccessToken(): Promise<string | null> {
  const session = await loadAuthSession();
  return session?.access_token ?? null;
}
