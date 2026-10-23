import { MousePointer2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { type PresenceState, type PresenceUser, presenceColor } from "../presence/colors";
import { isAnchor } from "./cursorAnchors";
import { CursorMotion, type RemoteCursor } from "./CursorMotion";
import type { GraphSession } from "./GraphSession";
import { isCaret } from "./remoteCaret";

type Remote = RemoteCursor & { user: PresenceUser };

const NO_ONE: Remote[] = [];

function readRemotes(session: GraphSession, meId: string): Remote[] {
  const awareness = session.socket.awareness;
  const remotes: Remote[] = [];
  for (const [clientId, state] of awareness.getStates() as Map<number, PresenceState>) {
    const user = state.user;
    if (clientId === awareness.clientID || !user || user.id === meId) continue;
    const cursor = isAnchor(state.cursor) ? state.cursor : null;
    const editing = typeof state.editing === "string" ? state.editing : null;
    const caret = isCaret(state.caret) ? state.caret : null;
    if (!cursor && !editing) continue;
    remotes.push({ clientId, user, cursor, pressed: state.pressed === true, editing, caret });
  }
  return remotes.length ? remotes : NO_ONE;
}

function useRemotes(session: GraphSession, meId: string) {
  const cache = useRef<{ key: string; remotes: Remote[] }>({ key: "", remotes: NO_ONE });
  return useSyncExternalStore(
    (notify) => {
      const awareness = session.socket.awareness;
      awareness.on("change", notify);
      return () => awareness.off("change", notify);
    },
    () => {
      const remotes = readRemotes(session, meId);
      const key = JSON.stringify(remotes);
      if (key !== cache.current.key) cache.current = { key, remotes };
      return cache.current.remotes;
    },
  );
}

export function LiveCursors({ session, meId }: { session: GraphSession; meId: string }) {
  const remotes = useRemotes(session, meId);
  const [motion, setMotion] = useState<CursorMotion | null>(null);
  useEffect(() => {
    const created = new CursorMotion(session.container, session.calc);
    setMotion(created);
    return () => created.dispose();
  }, [session]);
  useLayoutEffect(() => motion?.update(remotes), [motion, remotes]);

  if (!motion) return null;

  return createPortal(
    <div className="live-cursors" aria-hidden="true">
      {remotes.map((remote) => {
        const color = presenceColor(remote.user.id);
        const name = remote.user.display_name;
        return (
          <div key={remote.clientId} style={{ "--presence": color }}>
            <div className="live-cursor" ref={(el) => motion.bindCursor(remote.clientId, el)}>
              <MousePointer2 />
              <span className="live-tag">{name}</span>
            </div>
            {remote.editing && (
              <>
                <div className="live-editing" ref={(el) => motion.bindEditing(remote.clientId, el)}>
                  <span className="live-tag">{name}</span>
                </div>
                <div className="live-caret" ref={(el) => motion.bindCaret(remote.clientId, el)}>
                  <span className="live-selection" />
                  <span className="live-tag">{name}</span>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
