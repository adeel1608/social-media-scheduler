export interface PublicIdentityEnvironment {
  readonly MODE?: string;
  readonly VITE_APP_URL?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  readonly VITE_DEMO_MODE?: string;
  readonly VITE_OPERATOR_NAME?: string;
  readonly VITE_PUBLIC_CONTACT_EMAIL?: string;
}

export interface PublicIdentity {
  operatorName: string;
  contactEmail: string;
}

export interface PublicWebConfiguration {
  appUrl: string;
  apiUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  turnstileSiteKey: string;
  identity: PublicIdentity;
}

const DEMO_IDENTITY: PublicIdentity = {
  operatorName: "Postline Demo",
  contactEmail: "demo@example.com",
};

const PLACEHOLDER_PARTS = [
  "replace-",
  "your-",
  "your name",
  "operator name",
  "placeholder",
  "example.com",
  "example.net",
  "example.org",
  "example.invalid",
];

const PUBLIC_CONFIGURATION_KEYS = [
  "VITE_APP_URL",
  "VITE_API_URL",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_TURNSTILE_SITE_KEY",
] as const;

export function resolvePublicWebConfiguration(
  env: PublicIdentityEnvironment,
): PublicWebConfiguration {
  const identity = resolvePublicIdentity(env);
  const demoMode =
    env.VITE_DEMO_MODE === "true" || env.MODE?.toLowerCase() === "e2e";

  if (demoMode) {
    return {
      appUrl: env.VITE_APP_URL?.trim() || "http://localhost:5173",
      apiUrl: env.VITE_API_URL?.trim() || "http://localhost:8787",
      supabaseUrl: env.VITE_SUPABASE_URL?.trim() || "",
      supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY?.trim() || "",
      turnstileSiteKey: env.VITE_TURNSTILE_SITE_KEY?.trim() || "",
      identity,
    };
  }

  for (const key of PUBLIC_CONFIGURATION_KEYS) {
    const value = env[key]?.trim() ?? "";
    if (!value)
      throw new Error(`${key} is required when VITE_DEMO_MODE is false.`);
    if (isPlaceholder(value)) {
      throw new Error(`${key} must not contain a placeholder value.`);
    }
  }

  const appUrl = requireHttpsOrigin("VITE_APP_URL", env.VITE_APP_URL!);
  const apiUrl = requireHttpsOrigin("VITE_API_URL", env.VITE_API_URL!);
  const supabaseUrl = requireHttpsOrigin(
    "VITE_SUPABASE_URL",
    env.VITE_SUPABASE_URL!,
  );
  const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY!.trim();
  if (
    supabaseAnonKey.length < 20 ||
    supabaseAnonKey.length > 4096 ||
    /\s/.test(supabaseAnonKey)
  ) {
    throw new Error(
      "VITE_SUPABASE_ANON_KEY must be a valid browser-safe Supabase public key.",
    );
  }

  const turnstileSiteKey = env.VITE_TURNSTILE_SITE_KEY!.trim();
  if (
    turnstileSiteKey.length < 20 ||
    turnstileSiteKey.length > 100 ||
    /\s/.test(turnstileSiteKey)
  ) {
    throw new Error("VITE_TURNSTILE_SITE_KEY must be a valid public site key.");
  }

  return {
    appUrl,
    apiUrl,
    supabaseUrl,
    supabaseAnonKey,
    turnstileSiteKey,
    identity,
  };
}

export function resolvePublicIdentity(
  env: PublicIdentityEnvironment,
): PublicIdentity {
  const demoMode =
    env.VITE_DEMO_MODE === "true" || env.MODE?.toLowerCase() === "e2e";
  const operatorName = env.VITE_OPERATOR_NAME?.trim() ?? "";
  const contactEmail = env.VITE_PUBLIC_CONTACT_EMAIL?.trim() ?? "";

  if (demoMode) {
    return {
      operatorName: isUsableOperatorName(operatorName)
        ? operatorName
        : DEMO_IDENTITY.operatorName,
      contactEmail: isBoundedEmail(contactEmail)
        ? contactEmail
        : DEMO_IDENTITY.contactEmail,
    };
  }

  if (!operatorName) {
    throw new Error(
      "VITE_OPERATOR_NAME is required when VITE_DEMO_MODE is false.",
    );
  }
  if (
    !isUsableOperatorName(operatorName) ||
    isPlaceholder(operatorName) ||
    operatorName.toLowerCase().includes("demo")
  ) {
    throw new Error(
      "VITE_OPERATOR_NAME must be a real, non-placeholder public operator name.",
    );
  }
  if (!contactEmail) {
    throw new Error(
      "VITE_PUBLIC_CONTACT_EMAIL is required when VITE_DEMO_MODE is false.",
    );
  }
  if (!isBoundedEmail(contactEmail) || isPlaceholderContact(contactEmail)) {
    throw new Error(
      "VITE_PUBLIC_CONTACT_EMAIL must be a valid, non-placeholder public email address.",
    );
  }

  return { operatorName, contactEmail };
}

export function isBoundedEmail(value: string): boolean {
  if (!value || value.length > 254 || value !== value.trim()) return false;

  let atIndex = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = character.charCodeAt(0);
    if (code <= 32 || code >= 127) return false;
    if (character === "@") {
      if (atIndex !== -1) return false;
      atIndex = index;
    }
  }

  if (atIndex < 1 || atIndex > 64 || atIndex === value.length - 1) return false;

  const domain = value.slice(atIndex + 1);
  if (domain.length > 253 || !domain.includes(".")) return false;
  const labels = domain.split(".");
  for (const label of labels) {
    if (
      !label ||
      label.length > 63 ||
      label.startsWith("-") ||
      label.endsWith("-")
    )
      return false;
    for (const character of label) {
      const code = character.toLowerCase().charCodeAt(0);
      const isLetter = code >= 97 && code <= 122;
      const isNumber = code >= 48 && code <= 57;
      if (!isLetter && !isNumber && character !== "-") return false;
    }
  }
  return labels.at(-1)!.length >= 2;
}

function isUsableOperatorName(value: string): boolean {
  if (value.length < 2 || value.length > 100 || value !== value.trim())
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function isPlaceholderContact(value: string): boolean {
  const normalized = value.toLowerCase();
  if (isPlaceholder(normalized) || normalized.startsWith("demo@")) return true;
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  return (
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".test") ||
    domain.endsWith(".invalid")
  );
}

function isPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return PLACEHOLDER_PARTS.some((part) => normalized.includes(part));
}

function requireHttpsOrigin(key: string, value: string): string {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    ) {
      throw new Error("not an HTTPS origin");
    }
    return url.origin;
  } catch {
    throw new Error(`${key} must be a credential-free HTTPS origin.`);
  }
}
