export const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk_live_[A-Za-z0-9]{20,}\b/,
  /\bre_[A-Za-z0-9]{24,}\b/,
  /\bsb_secret_[A-Za-z0-9_-]{20,}\b/,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/,
  /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["']?eyJ[A-Za-z0-9._-]{30,}/,
  /META_APP_SECRET\s*[:=]\s*["']?[a-f0-9]{32}\b/i,
  /(?:CLOUDFLARE_API_TOKEN|GOOGLE_CLIENT_SECRET|TIKTOK_CLIENT_SECRET|TOKEN_ENCRYPTION_KEY|UPLOADTHING_TOKEN)\s*[:=]\s*["']?(?!\$\{\{|process\.env|replace-|your-|POSTLINE_)[A-Za-z0-9_+/=.-]{24,}/,
];

export function containsPotentialSecret(contents) {
  return secretPatterns.some((pattern) => pattern.test(contents));
}
