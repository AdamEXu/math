import { FETCH_HEADERS } from "../api/client";

const HEADERS = { "Content-Type": "application/json", ...FETCH_HEADERS };
const FLUSH_MS = 1000;
const MAX_BATCH = 200;
const KEEPALIVE_LIMIT = 60000;

export type SaveStatus = "loading" | "saved" | "saving" | "offline" | "error";

type QueuedUpdate = { id: string; ts: number; data: string };

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class Saver {
  queue: QueuedUpdate[] = [];
  failures = 0;
  private sending: Promise<void> | null = null;
  private retryAt = 0;
  private readonly interval: number;
  private readonly onOnline = () => {
    this.retryAt = 0;
    this.tick();
  };

  constructor(
    private readonly url: string,
    public onStatus: (status: SaveStatus) => void,
  ) {
    this.interval = window.setInterval(() => this.tick(), FLUSH_MS);
    addEventListener("online", this.onOnline);
  }

  get status(): SaveStatus {
    if (!this.queue.length) return "saved";
    return this.failures ? "offline" : "saving";
  }

  push(update: Uint8Array) {
    this.queue.push({ id: crypto.randomUUID(), ts: Date.now(), data: base64(update) });
    this.report();
  }

  report() {
    this.onStatus(this.status);
  }

  tick() {
    if (this.queue.length && !this.sending && Date.now() >= this.retryAt) void this.flush();
  }

  acknowledge(ids: string[]) {
    const acked = new Set(ids);
    this.queue = this.queue.filter((u) => !acked.has(u.id));
  }

  async post(batch: QueuedUpdate[], keepalive = false) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: HEADERS,
      keepalive,
      body: JSON.stringify({ updates: batch }),
    });
    if (!res.ok) throw new Error(`save failed: ${res.status}`);
    this.acknowledge(((await res.json()) as { acked: string[] }).acked);
  }

  flush(): Promise<void> {
    if (this.sending) return this.sending;
    if (!this.queue.length) return Promise.resolve();
    this.sending = this.post(this.queue.slice(0, MAX_BATCH))
      .then(
        () => {
          this.failures = 0;
          this.retryAt = 0;
        },
        () => {
          this.failures++;
          this.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** this.failures);
        },
      )
      .finally(() => {
        this.sending = null;
        this.report();
      });
    return this.sending;
  }

  async drain() {
    while (this.queue.length) {
      await this.flush();
      if (this.failures) return false;
    }
    return true;
  }

  flushOnExit() {
    if (!this.queue.length) return;
    const batch: QueuedUpdate[] = [];
    let size = 0;
    for (const update of this.queue) {
      const next = size + update.data.length + 80;
      if (batch.length && next > KEEPALIVE_LIMIT) break;
      batch.push(update);
      size = next;
    }
    this.post(batch, size <= KEEPALIVE_LIMIT).then(
      () => this.report(),
      () => {},
    );
  }

  stop() {
    clearInterval(this.interval);
    removeEventListener("online", this.onOnline);
  }
}
