function base64Url(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function createOAuthState(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function createPkceVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(64)));
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

export function safeStateEquals(expected: string, received: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(expected);
  const right = encoder.encode(received);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function isOAuthStateValid(
  record: { state: string; expiresAt: string; consumedAt?: string },
  receivedState: string,
  now = new Date(),
): boolean {
  return (
    !record.consumedAt &&
    new Date(record.expiresAt).getTime() > now.getTime() &&
    safeStateEquals(record.state, receivedState)
  );
}
