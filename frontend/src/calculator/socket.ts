import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type { Role } from "../api/types";
import { LOCAL, REMOTE, type Y } from "./ydesmos";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_ACK = 4;
const MESSAGE_ROLE = 5;
const MESSAGE_PING = 6;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_NOT_FOUND = 4404;
const MAX_BACKOFF_MS = 10000;
const PING_MS = 15000;
const DEAD_MS = 35000;
const OFFLINE_GRACE_MS = 2000;

export type ConnectionStatus = "connecting" | "online" | "offline";

export type SocketHooks = {
  onStatus: (status: ConnectionStatus) => void;
  onRole: (role: Role) => void;
  onRevoked: () => void;
  onSignedOut: () => void;
  beforeRemote: () => void;
  afterRemote: () => void;
};

export function socketUrl(path: string) {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`;
}

export class GraphSocket {
  readonly awareness: awarenessProtocol.Awareness;
  status: ConnectionStatus = "connecting";
  private ws: WebSocket | null = null;
  private outstanding = 0;
  private answeredServer = false;
  private attempts = 0;
  private retryTimer: number | null = null;
  private disposed = false;
  private idleWaiters: (() => void)[] = [];
  private heartbeat: number | null = null;
  private lastHeard = 0;
  private offlineTimer: number | null = null;

  constructor(
    private readonly graphId: string,
    private readonly doc: Y.Doc,
    public role: Role,
    private readonly hooks: SocketHooks,
  ) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalState({});
    doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    addEventListener("online", this.reconnectNow);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.connect();
  }

  get canEdit() {
    return this.role !== "viewer";
  }

  get idle() {
    return this.outstanding === 0;
  }

  whenIdle() {
    if (this.idle || this.status !== "online") return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private connect() {
    if (this.disposed) return;
    const ws = new WebSocket(socketUrl(`/ws/graphs/${this.graphId}`));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.lastHeard = Date.now();
      this.heartbeat = window.setInterval(() => this.beat(ws), PING_MS);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      ws.send(encoding.toUint8Array(encoder));
      this.sendAwareness([this.doc.clientID]);
    };
    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      this.lastHeard = Date.now();
      this.receive(new Uint8Array(event.data));
    };
    ws.onclose = (event) => this.closed(ws, event.code);
  }

  private closed(ws: WebSocket, code: number) {
    if (this.ws !== ws) return;
    this.ws = null;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.answeredServer = false;
    this.outstanding = 0;
    this.releaseIdle();
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
    if (this.disposed) return;
    if (code === CLOSE_UNAUTHORIZED) return this.hooks.onSignedOut();
    if (code === CLOSE_FORBIDDEN || code === CLOSE_NOT_FOUND) return this.hooks.onRevoked();
    if (this.status === "online") this.setStatus("connecting");
    this.offlineTimer ??= window.setTimeout(() => {
      this.offlineTimer = null;
      if (this.status !== "online") this.setStatus("offline");
    }, OFFLINE_GRACE_MS);
    const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts++);
    const delay = ceiling / 2 + Math.random() * (ceiling / 2);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private beat(ws: WebSocket) {
    if (Date.now() - this.lastHeard > DEAD_MS) {
      ws.close();
      this.closed(ws, 1006);
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array([MESSAGE_PING]));
  }

  private readonly onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    if (this.ws && Date.now() - this.lastHeard > PING_MS * 2) this.beat(this.ws);
    this.reconnectNow();
  };

  private readonly reconnectNow = () => {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  };

  private receive(data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        this.hooks.beforeRemote();
        let kind: number;
        try {
          kind = syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE);
        } finally {
          this.hooks.afterRemote();
        }
        if (kind === syncProtocol.messageYjsSyncStep1 && this.canEdit) {
          this.send(encoding.toUint8Array(encoder), true);
          this.answeredServer = true;
        }
        if (kind === syncProtocol.messageYjsSyncStep2) {
          if (this.offlineTimer !== null) clearTimeout(this.offlineTimer);
          this.offlineTimer = null;
          this.setStatus("online");
        }
        break;
      }
      case MESSAGE_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
        break;
      case MESSAGE_ACK:
        this.outstanding = Math.max(0, this.outstanding - 1);
        if (this.idle) this.releaseIdle();
        break;
      case MESSAGE_ROLE: {
        const role = decoding.readVarString(decoder) as Role;
        if (role !== this.role) {
          this.role = role;
          this.hooks.onRole(role);
        }
        break;
      }
    }
  }

  private send(message: Uint8Array<ArrayBuffer>, expectsAck = false) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(message);
    if (expectsAck) this.outstanding++;
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== LOCAL || !this.canEdit || !this.answeredServer) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder), true);
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return;
    this.sendAwareness([...added, ...updated, ...removed]);
  };

  private sendAwareness(clients: number[]) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.send(encoding.toUint8Array(encoder));
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.hooks.onStatus(status);
  }

  private releaseIdle() {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  dropConnection() {
    const ws = this.ws;
    if (!ws) return;
    ws.close();
    this.closed(ws, 1006);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.offlineTimer !== null) clearTimeout(this.offlineTimer);
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    removeEventListener("online", this.reconnectNow);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.doc.off("update", this.onDocUpdate);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "dispose");
    this.awareness.destroy();
    this.ws?.close();
    this.releaseIdle();
  }
}
