import { createClient, type Session } from "@supabase/supabase-js";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const demoMode =
  import.meta.env.VITE_DEMO_MODE === "true" || import.meta.env.MODE === "e2e";
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
const supabase =
  !demoMode && supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

interface AuthContextValue {
  session: Session | null;
  loading: boolean;
  demoMode: boolean;
  sendMagicLink(email: string): Promise<{ error?: string }>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(!demoMode);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) =>
      setSession(nextSession),
    );
    return () => data.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      demoMode,
      async sendMagicLink(email) {
        if (!supabase)
          return {
            error: "Supabase is not configured. Use the setup guide first.",
          };
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            shouldCreateUser: false,
            emailRedirectTo: `${import.meta.env.VITE_APP_URL ?? window.location.origin}/dashboard`,
          },
        });
        return error ? { error: error.message } : {};
      },
      async signOut() {
        await supabase?.auth.signOut({ scope: "local" });
        setSession(null);
      },
    }),
    [loading, session],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
