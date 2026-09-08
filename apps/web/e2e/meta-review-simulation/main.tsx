import type { Session } from "@supabase/supabase-js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "../../src/App";
import {
  AuthProvider,
  type AuthTestAdapter,
} from "../../src/context/AuthContext";
import type { TurnstileApi } from "../../src/lib/turnstile";
import "../../src/styles.css";
import "./simulation.css";

const reviewerEmail = "meta.reviewer@postline.example.test";
const reviewerId = "10000000-0000-4000-8000-000000000001";
const authenticationKey = "postline-meta-review-simulation-authenticated";
const tokenKey = "postline-meta-review-simulation-token";

declare global {
  interface Window {
    __POSTLINE_SIMULATION_PASSWORD__?: string;
  }
}

function simulationToken(): string {
  const existing = sessionStorage.getItem(tokenKey);
  if (existing) return existing;
  const token = `SIMULATION_ONLY_${crypto.randomUUID()}`;
  sessionStorage.setItem(tokenKey, token);
  return token;
}

function session(): Session {
  const now = Math.floor(Date.now() / 1_000);
  return {
    access_token: simulationToken(),
    refresh_token: `SIMULATION_ONLY_${crypto.randomUUID()}`,
    expires_in: 3_600,
    expires_at: now + 3_600,
    token_type: "bearer",
    user: {
      id: reviewerId,
      aud: "authenticated",
      role: "authenticated",
      email: reviewerEmail,
      email_confirmed_at: new Date().toISOString(),
      phone: "",
      confirmed_at: new Date().toISOString(),
      last_sign_in_at: new Date().toISOString(),
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { simulation: true },
      identities: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_anonymous: false,
    },
  };
}

function simulatedTurnstile(): Promise<TurnstileApi> {
  const widgets = new Map<string, HTMLElement>();
  return Promise.resolve({
    render(container, options) {
      const id = `simulation-turnstile-${crypto.randomUUID()}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "simulation-turnstile-button";
      button.textContent = "Complete simulated security challenge";
      button.setAttribute(
        "aria-label",
        "Complete simulated Turnstile challenge",
      );
      button.addEventListener("click", () => {
        button.textContent = "Test-environment verification complete";
        button.setAttribute("aria-pressed", "true");
        options.callback(`SIMULATION_ONLY_TURNSTILE_${crypto.randomUUID()}`);
      });
      container.replaceChildren(button);
      widgets.set(id, button);
      return id;
    },
    reset(widgetId) {
      const button = widgets.get(widgetId);
      if (!button) return;
      button.textContent = "Complete simulated security challenge";
      button.setAttribute("aria-pressed", "false");
    },
    remove(widgetId) {
      widgets.get(widgetId)?.remove();
      widgets.delete(widgetId);
    },
  });
}

const initiallyAuthenticated =
  sessionStorage.getItem(authenticationKey) === "true";

const adapter: AuthTestAdapter = {
  ...(initiallyAuthenticated
    ? { initialSession: session(), initialAccessRole: "meta_reviewer" as const }
    : {}),
  turnstileSiteKey: "SIMULATION_ONLY_SITE_KEY_NOT_A_PROVIDER_CREDENTIAL",
  loadTurnstile: simulatedTurnstile,
  async sendMagicLink(email, captchaToken) {
    if (
      email === reviewerEmail &&
      captchaToken.startsWith("SIMULATION_ONLY_")
    ) {
      return {
        error: "Passwordless reviewer sign-in is disabled in this simulation.",
      };
    }
    return { error: "Owner email delivery is not available in simulation." };
  },
  async signInMetaReviewer(email, password, captchaToken) {
    const expectedPassword = window.__POSTLINE_SIMULATION_PASSWORD__;
    if (
      !expectedPassword ||
      email !== reviewerEmail ||
      password !== expectedPassword ||
      !captchaToken.startsWith("SIMULATION_ONLY_TURNSTILE_")
    ) {
      return { error: "The email or password could not be verified." };
    }
    await fetch("/simulation/internal/password-auth", { method: "POST" });
    sessionStorage.setItem(authenticationKey, "true");
    return { session: session(), accessRole: "meta_reviewer" };
  },
  async signOut(currentSession) {
    if (currentSession) {
      await fetch("/simulation/internal/sign-out", { method: "POST" });
    }
    sessionStorage.removeItem(authenticationKey);
    sessionStorage.removeItem(tokenKey);
  },
  async uploadFile(file, onProgress) {
    if (!file.type.startsWith("image/")) {
      throw new Error("The simulation fixture must be an image.");
    }
    for (const progress of [18, 46, 73, 100]) {
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      onProgress(progress);
    }
    await fetch("/simulation/internal/upload", { method: "POST" });
    return {
      mediaId: "20000000-0000-4000-8000-000000000001",
      objectKey: "SIMULATION_ONLY_MEDIA_OBJECT",
    };
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider testAdapter={adapter}>
        <div
          className="simulation-watermark"
          role="note"
          aria-label="Simulation recording watermark"
        >
          SIMULATION — NOT FOR META SUBMISSION
        </div>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
