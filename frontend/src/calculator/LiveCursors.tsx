import { MousePointer2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { type PresenceState, type PresenceUser, presenceColor } from "../presence/colors";
import { isAnchor } from "./cursorAnchors";
import { CursorMotion, type RemoteCursor } from "./CursorMotion";
import type { GraphSession } from "./GraphSession";
import { isCaret } from "./remoteCaret";

type Remote = RemoteCursor & { user: PresenceUser };

const NO_ONE: Remote[] = [];
const LEAVE_MS = 120;

function readRemotes(session: GraphSession): Remote[] {
  const awareness = session.socket.awareness;
  const remotes: Remote[] = [];
  for (const [clientId, state] of awareness.getStates() as Map<number, PresenceState>) {
    const user = state.user;
    if (clientId === awareness.clientID || !user) continue;
    const cursor = isAnchor(state.cursor) ? state.cursor : null;
    const editing = typeof state.editing === "string" ? state.editing : null;
    const caret = isCaret(state.caret) ? state.caret : null;
    const lead = state.lead === "pointer" || state.lead === "caret" ? state.lead : null;
    remotes.push({ clientId, user, cursor, pressed: state.pressed === true, editing, caret, lead });
  }
  return remotes.length ? remotes : NO_ONE;
}

function useRemotes(session: GraphSession) {
  const cache = useRef<{ key: string; remotes: Remote[] }>({ key: "", remotes: NO_ONE });
  return useSyncExternalStore(
    (notify) => {
      const awareness = session.socket.awareness;
      awareness.on("change", notify);
      return () => awareness.off("change", notify);
    },
    () => {
      const remotes = readRemotes(session);
      const key = JSON.stringify(remotes);
      if (key !== cache.current.key) cache.current = { key, remotes };
      return cache.current.remotes;
    },
  );
}

function useLeavers(remotes: Remote[]) {
  const previous = useRef<Remote[]>(NO_ONE);
  const [leaving, setLeaving] = useState<Remote[]>(NO_ONE);
  useLayoutEffect(() => {
    const live = new Set(remotes.map((remote) => remote.clientId));
    const gone = previous.current.filter((remote) => !live.has(remote.clientId));
    previous.current = remotes;
    const returned = leaving.some((remote) => live.has(remote.clientId));
    if (!gone.length && !returned) return;
    const goneIds = new Set(gone.map((remote) => remote.clientId));
    setLeaving((current) => [
      ...current.filter((remote) => !live.has(remote.clientId) && !goneIds.has(remote.clientId)),
      ...gone.map((remote) => ({ ...remote, leaving: true })),
    ]);
    if (gone.length)
      window.setTimeout(
        () => setLeaving((current) => current.filter((remote) => !goneIds.has(remote.clientId))),
        LEAVE_MS,
      );
  }, [remotes, leaving]);
  return useMemo(() => (leaving.length ? [...remotes, ...leaving] : remotes), [remotes, leaving]);
}

export function LiveCursors({ session }: { session: GraphSession }) {
  const remotes = useLeavers(useRemotes(session));
  const [motion, setMotion] = useState<CursorMotion | null>(null);
  useEffect(() => {
    const created = new CursorMotion(session.container, session.calc);
    setMotion(created);
    return () => created.dispose();
  }, [session]);
  useLayoutEffect(() => motion?.update(remotes), [motion, remotes]);

  if (!motion) return null;

  return createPortal(
    <div className="live-cursors" aria-hidden="true" ref={(el) => motion.bindLayer(el)}>
      {remotes.map((remote) => {
        const color = presenceColor(remote.user.id);
        const name = remote.user.display_name;
        return (
          <div
            key={remote.clientId}
            className={remote.leaving ? "live-leaving" : undefined}
            style={{ "--presence": color }}
          >
            <div className="live-cursor" ref={(el) => motion.bindCursor(remote.clientId, el)}>
              <MousePointer2 />
            </div>
            {remote.editing && (
              <>
                <div className="live-editing" ref={(el) => motion.bindEditing(remote.clientId, el)} />
                <div className="live-caret" ref={(el) => motion.bindCaret(remote.clientId, el)}>
                  <span className="live-selection" />
                </div>
              </>
            )}
            <span className="live-tag" ref={(el) => motion.bindTag(remote.clientId, el)}>
              {name}
            </span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
