import type { Env } from "./env";

export class SupabaseRest {
  constructor(
    private readonly env: Env,
    private readonly authorization = `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    private readonly apiKey = env.SUPABASE_SERVICE_ROLE_KEY,
  ) {}

  private url(path: string): string {
    return `${this.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(this.url(path), {
      ...init,
      headers: {
        apikey: this.apiKey,
        Authorization: this.authorization,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw {
        status: response.status,
        body: text.slice(0, 1_000),
        message: "Database request failed",
      };
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  select<T>(tableAndQuery: string): Promise<T> {
    return this.request<T>(tableAndQuery, { method: "GET" });
  }

  insert<T>(
    table: string,
    data: unknown,
    prefer = "return=representation",
  ): Promise<T> {
    return this.request<T>(table, {
      method: "POST",
      headers: { Prefer: prefer },
      body: JSON.stringify(data),
    });
  }

  update<T>(tableAndQuery: string, data: unknown): Promise<T> {
    return this.request<T>(tableAndQuery, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(data),
    });
  }

  rpc<T>(functionName: string, args: unknown): Promise<T> {
    return this.request<T>(`rpc/${functionName}`, {
      method: "POST",
      body: JSON.stringify(args),
    });
  }
}

export function ownerDatabase(env: Env, jwt: string): SupabaseRest {
  return new SupabaseRest(env, `Bearer ${jwt}`, env.SUPABASE_ANON_KEY);
}
