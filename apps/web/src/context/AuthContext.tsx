import { createClient, type Session } from "@supabase/supabase-js";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { cancelPendingOAuth } from "../lib/api";
import type { TurnstileApi } from "../lib/turnstile";

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
  accessRole: "owner" | "meta_reviewer" | null;
  loading: boolean;
  demoMode: boolean;
  simulationMode: boolean;
  reviewerLoginEnabled: boolean;
  turnstileSiteKeyOverride?: string;
  turnstileLoader?: () => Promise<TurnstileApi>;
  uploadSimulationFile?: (
    file: File,
    onProgress: (percent: number) => void,
  ) => Promise<{ mediaId: string; objectKey: string }>;
  sendMagicLink(
    email: string,
    captchaToken: string,
  ): Promise<{ error?: string }>;
  signInMetaReviewer(
    email: string,
    password: string,
    captchaToken: string,
  ): Promise<{ error?: string }>;
  signOut(): Promise<void>;
}

/**
 * Explicit dependency injection for browser-only test harnesses. Production
 * entrypoints never pass this adapter, and there is no environment variable,
 * URL parameter, or global switch that can install one at runtime.
 */
export interface AuthTestAdapter {
  readonly initialSession?: Session | null;
  readonly initialAccessRole?: "owner" | "meta_reviewer" | null;
  readonly turnstileSiteKey: string;
  readonly loadTurnstile: () => Promise<TurnstileApi>;
  sendMagicLink(
    email: string,
    captchaToken: string,
  ): Promise<{ error?: string }>;
  signInMetaReviewer(
    email: string,
    password: string,
    captchaToken: string,
  ): Promise<{
    error?: string;
    session?: Session;
    accessRole?: "owner" | "meta_reviewer";
  }>;
  signOut(session: Session | null): Promise<void>;
  uploadFile(
    file: File,
    onProgress: (percent: number) => void,
  ): Promise<{ mediaId: string; objectKey: string }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  testAdapter,
}: {
  children: ReactNode;
  testAdapter?: AuthTestAdapter;
}) {
  const [session, setSession] = useState<Session | null>(
    testAdapter?.initialSession ?? null,
  );
  const [loading, setLoading] = useState(
    testAdapter ? false : !demoMode && Boolean(supabase),
  );
  const [authInitialized, setAuthInitialized] = useState(
    Boolean(testAdapter) || demoMode || !supabase,
  );
  const [accessRole, setAccessRole] = useState<
    "owner" | "meta_reviewer" | null
  >(testAdapter?.initialAccessRole ?? (demoMode ? "owner" : null));

  useEffect(() => {
    if (testAdapter) return;
    if (!supabase) return;
    let active = true;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) setSession(data.session);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setAuthInitialized(true);
      });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthInitialized(true);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [testAdapter]);

  useEffect(() => {
    if (testAdapter || !authInitialized || demoMode || !supabase) return;
    let active = true;
    if (!session) {
      setAccessRole(null);
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    void fetch(
      `${import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787"}/api/session`,
      { headers: { Authorization: `Bearer ${session.access_token}` } },
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          role?: unknown;
        } | null;
        if (
          !response.ok ||
          (body?.role !== "owner" && body?.role !== "meta_reviewer")
        ) {
          throw new Error("access_denied");
        }
        if (active) setAccessRole(body.role);
      })
      .catch(() => {
        if (!active) return;
        setAccessRole(null);
        setSession(null);
        void supabase.auth.signOut({ scope: "local" });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authInitialized, session, testAdapter]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      accessRole,
      loading,
      demoMode,
      simulationMode: Boolean(testAdapter),
      reviewerLoginEnabled:
        Boolean(testAdapter) ||
        import.meta.env.VITE_META_REVIEW_MODE === "true",
      ...(testAdapter
        ? {
            turnstileSiteKeyOverride: testAdapter.turnstileSiteKey,
            turnstileLoader: testAdapter.loadTurnstile,
            uploadSimulationFile: testAdapter.uploadFile,
          }
        : {}),
      async sendMagicLink(email, captchaToken) {
        if (testAdapter) return testAdapter.sendMagicLink(email, captchaToken);
        if (!supabase)
          return {
            error: "Supabase is not configured. Use the setup guide first.",
          };
        if (!captchaToken.trim()) {
          return { error: "Complete the security challenge and try again." };
        }
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            captchaToken,
            shouldCreateUser: false,
            emailRedirectTo: `${import.meta.env.VITE_APP_URL ?? window.location.origin}/dashboard`,
          },
        });
        return error
          ? {
              error:
                "The sign-in link could not be sent. Check the email and try again later.",
            }
          : {};
      },
      async signInMetaReviewer(email, password, captchaToken) {
        if (testAdapter) {
          const result = await testAdapter.signInMetaReviewer(
            email,
            password,
            captchaToken,
          );
          if (result.session && result.accessRole) {
            setSession(result.session);
            setAccessRole(result.accessRole);
          }
          return result.error ? { error: result.error } : {};
        }
        if (!supabase || import.meta.env.VITE_META_REVIEW_MODE !== "true") {
          return { error: "Reviewer sign-in is not available." };
        }
        if (!captchaToken.trim()) {
          return { error: "Complete the security challenge and try again." };
        }
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
          options: { captchaToken },
        });
        if (error || !data.session) {
          return { error: "The email or password could not be verified." };
        }
        try {
          const response = await fetch(
            `${import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8787"}/api/session`,
            {
              headers: {
                Authorization: `Bearer ${data.session.access_token}`,
              },
            },
          );
          const body = (await response.json().catch(() => null)) as {
            role?: unknown;
          } | null;
          if (!response.ok || body?.role !== "meta_reviewer") {
            throw new Error("access_denied");
          }
          setSession(data.session);
          setAccessRole("meta_reviewer");
          return {};
        } catch {
          await supabase.auth.signOut({ scope: "local" });
          setSession(null);
          setAccessRole(null);
          return { error: "The email or password could not be verified." };
        }
      },
      async signOut() {
        if (testAdapter) {
          try {
            await testAdapter.signOut(session);
          } finally {
            setSession(null);
            setAccessRole(null);
          }
          return;
        }
        if (session) {
          try {
            await cancelPendingOAuth(session);
          } catch {
            // Best effort only. Exact server-side Auth session matching keeps a
            // stale OAuth completion unusable if cleanup is unavailable.
          }
        }
        try {
          await supabase?.auth.signOut({ scope: "local" });
        } finally {
          setSession(null);
          setAccessRole(null);
        }
      },
    }),
    [accessRole, loading, session, testAdapter],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
