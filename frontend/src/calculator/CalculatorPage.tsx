import { useQueryClient } from "@tanstack/react-query";
import { Eye, Lock, UserPlus } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { isNotFound, redirectToLogin } from "../api/client";
import { fetchDoc } from "../api/graphs";
import { keys, useGraph, useMe } from "../api/queries";
import type { PublicUser, Role } from "../api/types";
import { useHoverTip } from "../components/HoverTip";
import { useToast } from "../components/Toast";
import { TopBar } from "../components/TopBar";
import { useBodyClass } from "../hooks/useBodyClass";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { NotFoundPage } from "../pages/NotFoundPage";
import { type PresenceState, distinctUsers } from "../presence/colors";
import { PresenceStack } from "../presence/PresenceStack";
import { loadDesmos } from "./desmos";
import { GraphSession } from "./GraphSession";
import { SaveStatusBadge, type SessionStatus } from "./SaveStatusBadge";
import { ShareDialog } from "./ShareDialog";

const NO_ONE: PublicUser[] = [];

export function CalculatorPage() {
  const { graphId = "" } = useParams();
  const graph = useGraph(graphId);
  const me = useMe();
  const [liveRole, setLiveRole] = useState<{ graphId: string; role: Role } | null>(null);
  const [revoked, setRevoked] = useState<string | null>(null);
  if (isNotFound(graph.error)) return <NotFoundPage />;
  if (revoked === graphId) return <NoAccess />;
  const role = liveRole?.graphId === graphId ? liveRole.role : graph.data?.role;
  if (!role || !me.data) return null;
  return (
    <Calculator
      key={`${graphId}:${role}`}
      graphId={graphId}
      meId={me.data.id}
      role={role}
      initialTitle={graph.data?.title}
      onRole={(next) => setLiveRole({ graphId, role: next })}
      onRevoked={() => setRevoked(graphId)}
    />
  );
}

function NoAccess() {
  useDocumentTitle("No access - math");
  return (
    <>
      <TopBar title={null} />
      <div className="empty no-access">
        <span className="empty-icon">
          <Lock />
        </span>
        <div className="empty-title">You no longer have access to this graph</div>
        <p className="empty-text">
          The owner changed who can open it. Any changes you made that hadn't synced are kept on this device and will
          sync if you get access again. <Link to="/">Back to your graphs</Link>
        </p>
      </div>
    </>
  );
}

function usePresence(session: GraphSession | null, meId: string) {
  const cache = useRef<{ key: string; users: PublicUser[] }>({ key: "", users: NO_ONE });
  return useSyncExternalStore(
    (notify) => {
      const awareness = session?.socket.awareness;
      awareness?.on("change", notify);
      return () => awareness?.off("change", notify);
    },
    () => {
      const states = session ? (session.socket.awareness.getStates() as Map<number, PresenceState>).values() : [];
      const users = distinctUsers(states, meId);
      const key = users.map((user) => user.id).join();
      if (key !== cache.current.key) cache.current = { key, users };
      return cache.current.users;
    },
  );
}

type CalculatorProps = {
  graphId: string;
  meId: string;
  role: Role;
  initialTitle: string | undefined;
  onRole: (role: Role) => void;
  onRevoked: () => void;
};

function Calculator({ graphId, meId, role, initialTitle, onRole, onRevoked }: CalculatorProps) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<GraphSession | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [missing, setMissing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [title, setTitle] = useState(initialTitle === undefined ? null : initialTitle || "Untitled Graph");
  const online = usePresence(session, meId);
  const { tipProps, tip } = useHoverTip();
  const latest = useRef({ onRole, onRevoked, toast });
  latest.current = { onRole, onRevoked, toast };

  useBodyClass("calculator-page");
  useBodyClass(role === "viewer" ? "calculator-readonly" : "calculator-editable");
  useDocumentTitle(title === null ? "math" : `${title} - math`);

  useEffect(() => {
    if (initialTitle === undefined || session || !titleRef.current) return;
    titleRef.current.value = initialTitle;
    setTitle(initialTitle || "Untitled Graph");
  }, [initialTitle, session]);

  useEffect(() => {
    let cancelled = false;
    let opened: GraphSession | null = null;
    (async () => {
      const [doc, desmos] = await Promise.all([fetchDoc(graphId), loadDesmos()]);
      const container = containerRef.current;
      const titleInput = titleRef.current;
      if (cancelled || !container || !titleInput) return;
      opened = await GraphSession.open({
        graphId,
        userId: meId,
        role,
        doc,
        desmos,
        container,
        titleInput,
        hooks: {
          onStatus: setStatus,
          onTitle: setTitle,
          onRole: (next) => {
            latest.current.toast(next === "viewer" ? "You can now only view this graph" : "You can now edit this graph");
            latest.current.onRole(next);
          },
          onRevoked: () => latest.current.onRevoked(),
          onSignedOut: redirectToLogin,
          onSettled: () => {
            void client.invalidateQueries({ queryKey: keys.graphs });
            void client.invalidateQueries({ queryKey: keys.graph(graphId) });
          },
        },
      });
      if (cancelled) {
        opened.dispose();
        return;
      }
      setSession(opened);
      setStatus(opened.socket.status);
    })().catch((error: unknown) => {
      if (cancelled) return;
      if (isNotFound(error)) setMissing(true);
      else setStatus("error");
      console.error(error);
    });
    return () => {
      cancelled = true;
      opened?.dispose();
    };
  }, [graphId, meId, role, client]);

  const goHome = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!session || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    await session.leave();
    navigate("/");
  };

  if (missing) return <NotFoundPage />;

  const openShare = () => setSharing(true);

  return (
    <>
      <TopBar
        onHome={goHome}
        title={
          <input
            id="title"
            ref={titleRef}
            className="tb-title title-input"
            type="text"
            defaultValue={initialTitle}
            placeholder="Untitled Graph"
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            aria-label="Graph title"
            disabled={!session}
          />
        }
        status={
          <>
            <div className="share-slot">
              <button className="tb-icon tb-share" type="button" aria-label="Share" onClick={openShare} {...tipProps("Share")}>
                <UserPlus />
              </button>
              <PresenceStack users={online} size="header" onOpen={openShare} label="People here now. Open sharing" />
            </div>
            {role === "viewer" && (
              <div className="view-only" role="note">
                <Eye />
                View only
              </div>
            )}
            <SaveStatusBadge status={status} />
            {tip}
          </>
        }
      />
      <div id="calculator" ref={containerRef} />
      {sharing && (
        <ShareDialog
          graphId={graphId}
          title={title ?? "Untitled Graph"}
          meId={meId}
          online={online}
          onDismiss={() => setSharing(false)}
        />
      )}
    </>
  );
}
