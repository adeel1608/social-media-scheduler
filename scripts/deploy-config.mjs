const REQUIRED_DEPLOY_VALUES = [
  "CLOUDFLARE_PAGES_PROJECT",
  "CLOUDFLARE_WORKER_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "VITE_APP_URL",
  "VITE_API_URL",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_OPERATOR_NAME",
  "VITE_PUBLIC_CONTACT_EMAIL",
  "GITHUB_REF_NAME",
  "GITHUB_DEFAULT_BRANCH",
];

const PLACEHOLDER_PARTS = [
  "replace-",
  "your-",
  "your_",
  "placeholder",
  "example.com",
  "example.net",
  "example.org",
  "example.invalid",
];

export function validateDeployConfiguration(environment) {
  const errors = [];
  for (const key of REQUIRED_DEPLOY_VALUES) {
    const value = normalized(environment[key]);
    if (!value) errors.push(`${key} is missing`);
    else if (isPlaceholder(value)) errors.push(`${key} contains a placeholder`);
  }

  if (environment.DEPLOY_CONFIRM !== "DEPLOY") {
    errors.push("DEPLOY_CONFIRM must exactly equal DEPLOY");
  }
  if (environment.VITE_DEMO_MODE !== "false") {
    errors.push("VITE_DEMO_MODE must exactly equal false");
  }
  if (
    normalized(environment.GITHUB_REF_NAME) !==
    normalized(environment.GITHUB_DEFAULT_BRANCH)
  ) {
    errors.push("the deployment ref must be the repository default branch");
  }

  for (const key of ["CLOUDFLARE_PAGES_PROJECT", "CLOUDFLARE_WORKER_NAME"]) {
    const project = normalized(environment[key]);
    if (project && !/^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/.test(project)) {
      errors.push(`${key} is not a valid project name`);
    }
  }
  const accountId = normalized(environment.CLOUDFLARE_ACCOUNT_ID);
  if (accountId && !/^[a-f0-9]{32}$/.test(accountId)) {
    errors.push("CLOUDFLARE_ACCOUNT_ID is malformed");
  }

  for (const key of ["VITE_APP_URL", "VITE_API_URL", "VITE_SUPABASE_URL"]) {
    const value = normalized(environment[key]);
    if (value && !isHttpsOrigin(value)) {
      errors.push(`${key} must be a credential-free HTTPS origin`);
    }
  }

  const anonKey = normalized(environment.VITE_SUPABASE_ANON_KEY);
  if (
    anonKey &&
    (anonKey.length < 20 || anonKey.length > 4096 || /\s/.test(anonKey))
  ) {
    errors.push("VITE_SUPABASE_ANON_KEY is malformed");
  }
  const apiToken = normalized(environment.CLOUDFLARE_API_TOKEN);
  if (apiToken && (apiToken.length < 20 || /\s/.test(apiToken))) {
    errors.push("CLOUDFLARE_API_TOKEN is malformed");
  }
  const contactEmail = normalized(environment.VITE_PUBLIC_CONTACT_EMAIL);
  if (contactEmail && !isEmail(contactEmail)) {
    errors.push("VITE_PUBLIC_CONTACT_EMAIL is malformed");
  }
  const operatorName = normalized(environment.VITE_OPERATOR_NAME);
  if (operatorName && (operatorName.length < 2 || operatorName.length > 100)) {
    errors.push("VITE_OPERATOR_NAME is malformed");
  }

  return { valid: errors.length === 0, errors };
}

function normalized(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isPlaceholder(value) {
  const normalizedValue = value.toLowerCase();
  return PLACEHOLDER_PARTS.some((part) => normalizedValue.includes(part));
}

function isHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
}

function isEmail(value) {
  if (value.length > 254 || value !== value.trim()) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return false;
  }
  const parts = value.split("@");
  return parts.length === 2 && parts[0].length > 0 && parts[1].includes(".");
}
