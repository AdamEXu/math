export const FETCH_HEADERS = { "X-Requested-With": "fetch" } as const;

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(status: number, data: unknown) {
    super(`request failed: ${status}`);
    this.status = status;
    this.data = data;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  cache?: RequestCache;
};

export function redirectToLogin() {
  window.location.assign("/login");
}

async function send(path: string, { method = "GET", json, body, headers, cache }: RequestOptions) {
  const init: RequestInit = { method, headers: { ...FETCH_HEADERS, ...headers }, body, cache };
  if (json !== undefined) {
    init.headers = { ...init.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(json);
  }
  const res = await fetch(path, init);
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await send(path, options)).json() as Promise<T>;
}

export async function apiBytes(path: string): Promise<Uint8Array> {
  const res = await send(path, { cache: "no-store" });
  return new Uint8Array(await res.arrayBuffer());
}

export function isNotFound(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

export function errorMessage(error: unknown, fallback = "Something went wrong. Try again.") {
  if (error instanceof ApiError && error.data && typeof error.data === "object" && "error" in error.data) {
    const message = String(error.data.error);
    if (message.includes(" ")) return message;
  }
  return fallback;
}
