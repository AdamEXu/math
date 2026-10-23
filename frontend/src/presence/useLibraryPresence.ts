import { useEffect, useRef, useState } from "react";
import type { PublicUser } from "../api/types";
import { socketUrl } from "../calculator/socket";

const MAX_BACKOFF_MS = 10000;

export type LibraryPresence = Record<string, PublicUser[]>;

export function useLibraryPresence(graphIds: string[]) {
  const [presence, setPresence] = useState<LibraryPresence>({});
  const watched = useRef<string[]>(graphIds);
  const socket = useRef<WebSocket | null>(null);
  const key = [...graphIds].sort().join();

  useEffect(() => {
    let disposed = false;
    let attempts = 0;
    let timer: number | undefined;

    const connect = () => {
      const ws = new WebSocket(socketUrl("/ws/presence"));
      socket.current = ws;
      ws.onopen = () => {
        attempts = 0;
        ws.send(JSON.stringify({ watch: watched.current }));
      };
      ws.onmessage = (event: MessageEvent<string>) => {
        const update = (JSON.parse(event.data) as { presence: LibraryPresence }).presence;
        setPresence((current) => ({ ...current, ...update }));
      };
      ws.onclose = () => {
        if (socket.current !== ws) return;
        socket.current = null;
        setPresence({});
        if (disposed) return;
        const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts++);
        timer = window.setTimeout(connect, ceiling / 2 + Math.random() * (ceiling / 2));
      };
    };
    const reconnectNow = () => {
      if (socket.current || disposed) return;
      clearTimeout(timer);
      connect();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconnectNow();
    };

    connect();
    addEventListener("online", reconnectNow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      removeEventListener("online", reconnectNow);
      document.removeEventListener("visibilitychange", onVisible);
      const ws = socket.current;
      socket.current = null;
      ws?.close();
    };
  }, []);

  useEffect(() => {
    watched.current = key ? key.split(",") : [];
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ watch: watched.current }));
  }, [key]);

  return presence;
}
