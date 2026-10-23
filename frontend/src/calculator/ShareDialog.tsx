import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Link2, LogOut, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { keys, updateGraphs } from "../api/queries";
import {
  addMember,
  changeMemberRole,
  getSharing,
  removeMember,
  searchUsers,
  setLinkAccess,
} from "../api/sharing";
import type { LinkAccess, MemberRole, PublicUser, Sharing } from "../api/types";
import { Avatar } from "../components/Avatar";
import { Modal } from "../components/overlay/Modal";
import { useToast } from "../components/Toast";
import { PresenceAvatar } from "../presence/PresenceStack";

const ROLE_LABELS: Record<MemberRole, string> = { editor: "Editor", viewer: "Viewer" };
const SEARCH_DELAY_MS = 150;

const sharingKey = (graphId: string) => ["sharing", graphId] as const;

function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.data && typeof error.data === "object" && "error" in error.data) {
    const message = String(error.data.error);
    if (message.includes(" ")) return message;
  }
  return "Something went wrong. Try again.";
}

function Person({ user, online, children }: { user: PublicUser; online: boolean; children?: ReactNode }) {
  return (
    <li className="share-person">
      {online ? <PresenceAvatar user={user} size="row" /> : <Avatar user={user} size={36} />}
      <div className="share-person-text">
        <div className="share-person-name">
          {user.display_name}
          {online && <span className="share-online">Online</span>}
        </div>
        {user.handle && <div className="share-person-handle">@{user.handle}</div>}
      </div>
      <div className="share-person-actions">{children}</div>
    </li>
  );
}

function PeoplePicker({ graphId, onShared }: { graphId: string; onShared: (sharing: Sharing) => void }) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<MemberRole>("editor");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = useId();
  const latest = useRef("");

  useEffect(() => {
    const value = query.trim();
    latest.current = value;
    if (!value) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      searchUsers(value)
        .then((users) => {
          if (latest.current !== value) return;
          setResults(users);
          setActive(0);
        })
        .catch(() => {});
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const typedEmail = query.trim().includes("@") && !query.trim().startsWith("@") ? query.trim() : null;
  const showList = open && results.length > 0;

  const choose = (user: PublicUser) => {
    setQuery(user.handle ? `@${user.handle}` : (typedEmail ?? ""));
    setOpen(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onShared(await addMember(graphId, query.trim(), role));
      setQuery("");
      setResults([]);
    } catch (shareError) {
      setError(errorMessage(shareError));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!showList) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + results.length) % results.length);
    } else if (event.key === "Enter") {
      const user = results[active];
      if (user) {
        event.preventDefault();
        choose(user);
      }
    } else if (event.key === "Escape") {
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    }
  };

  return (
    <form className="share-add" onSubmit={submit}>
      <div className="share-add-row">
        <div className="share-search">
          <input
            className="text-input share-input"
            type="text"
            value={query}
            placeholder="Add people by @handle or email"
            aria-label="Add people by handle or email"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            data-autofocus
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setError(null);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
          {showList && (
            <ul className="share-results" id={listId} role="listbox">
              {results.map((user, index) => (
                <li
                  key={user.id}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? "active" : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(user);
                  }}
                  onMouseEnter={() => setActive(index)}
                >
                  <Avatar user={user} size={28} />
                  <div className="share-person-text">
                    <div className="share-person-name">{user.display_name}</div>
                    <div className="share-person-handle">{user.handle ? `@${user.handle}` : typedEmail}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <select
          className="select"
          value={role}
          aria-label="Role for new people"
          onChange={(event) => setRole(event.target.value as MemberRole)}
        >
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </select>
        <button className="btn-primary" type="submit" disabled={!query.trim() || busy}>
          Share
        </button>
      </div>
      {error && (
        <p className="field-error">
          <CircleAlert />
          {error}
        </p>
      )}
    </form>
  );
}

type ShareDialogProps = {
  graphId: string;
  title: string;
  meId: string;
  online: PublicUser[];
  onDismiss: () => void;
};

export function ShareDialog({ graphId, title, meId, online, onDismiss }: ShareDialogProps) {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const sharing = useQuery({ queryKey: sharingKey(graphId), queryFn: () => getSharing(graphId) });
  const [error, setError] = useState<string | null>(null);
  const data = sharing.data;
  const isOwner = data?.role === "owner";
  const onlineIds = new Set([...online.map((user) => user.id), meId]);

  const store = (next: Sharing) => client.setQueryData(sharingKey(graphId), next);

  const run = async (action: () => Promise<Sharing | { ok: true }>) => {
    setError(null);
    try {
      const result = await action();
      if ("members" in result) store(result);
    } catch (actionError) {
      setError(errorMessage(actionError));
    }
  };

  const leave = async () => {
    if (!confirm(`Leave “${title}”? You'll lose access unless it's shared with you again.`)) return;
    try {
      await removeMember(graphId, meId);
    } catch (leaveError) {
      return setError(errorMessage(leaveError));
    }
    updateGraphs(client, (graphs) => graphs.filter((graph) => graph.id !== graphId));
    client.removeQueries({ queryKey: keys.graph(graphId) });
    navigate("/shared");
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/calculator/${graphId}`);
      toast("Link copied");
    } catch {
      toast("Couldn't copy the link");
    }
  };

  const people = data ? [{ ...data.owner, role: "owner" as const }, ...data.members] : [];
  const sorted = people
    .map((person, index) => ({ person, index }))
    .sort((a, b) => {
      if (a.person.role === "owner" || b.person.role === "owner") return a.person.role === "owner" ? -1 : 1;
      return Number(onlineIds.has(b.person.id)) - Number(onlineIds.has(a.person.id)) || a.index - b.index;
    })
    .map(({ person }) => person);
  const listed = new Set(people.map((person) => person.id));
  const visitors = online.filter((user) => !listed.has(user.id));

  return (
    <Modal labelledBy="share-heading" onDismiss={onDismiss}>
      <div className="panel share-panel">
        <h1 id="share-heading">Share “{title}”</h1>
        {isOwner && <PeoplePicker graphId={graphId} onShared={store} />}

        {visitors.length > 0 && (
          <section className="share-section">
            <h2 className="label">Online now</h2>
            <ul className="share-people">
              {visitors.map((user) => (
                <Person key={user.id} user={user} online>
                  <span className="share-role-text">Via link</span>
                </Person>
              ))}
            </ul>
          </section>
        )}

        <section className="share-section">
          <h2 className="label">People with access</h2>
          {!data && <p className="hint">{sharing.isError ? "Couldn't load sharing settings." : "Loading…"}</p>}
          <ul className="share-people">
            {sorted.map((person) => (
              <Person key={person.id} user={person} online={onlineIds.has(person.id) && person.id !== meId}>
                {person.role === "owner" ? (
                  <span className="share-role-text">Owner</span>
                ) : isOwner ? (
                  <>
                    <select
                      className="select select-quiet"
                      value={person.role}
                      aria-label={`Role for ${person.display_name}`}
                      onChange={(event) =>
                        void run(() => changeMemberRole(graphId, person.id, event.target.value as MemberRole))
                      }
                    >
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Remove ${person.display_name}`}
                      title="Remove"
                      onClick={() => void run(() => removeMember(graphId, person.id))}
                    >
                      <X />
                    </button>
                  </>
                ) : person.id === meId ? (
                  <>
                    <span className="share-role-text">{ROLE_LABELS[person.role]}</span>
                    <button className="btn-secondary btn-small" type="button" onClick={() => void leave()}>
                      <LogOut />
                      Leave
                    </button>
                  </>
                ) : (
                  <span className="share-role-text">{ROLE_LABELS[person.role]}</span>
                )}
              </Person>
            ))}
          </ul>
        </section>

        {data && (
          <section className="share-section">
            <h2 className="label">General access</h2>
            <div className="share-link">
              <span className={`share-link-icon${data.link_access ? " on" : ""}`}>
                <Link2 />
              </span>
              {isOwner ? (
                <div className="share-link-controls">
                  <select
                    className="select select-quiet"
                    value={data.link_access ? "link" : "restricted"}
                    aria-label="General access"
                    onChange={(event) =>
                      void run(() =>
                        setLinkAccess(graphId, event.target.value === "link" ? (data.link_access ?? "viewer") : null),
                      )
                    }
                  >
                    <option value="restricted">Restricted</option>
                    <option value="link">Anyone at Pinewood with the link</option>
                  </select>
                  {data.link_access && (
                    <select
                      className="select select-quiet"
                      value={data.link_access}
                      aria-label="Link role"
                      onChange={(event) => void run(() => setLinkAccess(graphId, event.target.value as LinkAccess))}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                    </select>
                  )}
                </div>
              ) : (
                <div className="share-link-text">
                  {data.link_access
                    ? `Anyone at Pinewood with the link can ${data.link_access === "editor" ? "edit" : "view"}`
                    : "Only people with access can open this graph"}
                </div>
              )}
            </div>
            {isOwner && (
              <p className="hint">
                {data.link_access
                  ? "Signed-in Pinewood users who open the link can " +
                    (data.link_access === "editor" ? "edit." : "view.")
                  : "Only people added above can open this graph."}
              </p>
            )}
          </section>
        )}

        {error && (
          <p className="field-error">
            <CircleAlert />
            {error}
          </p>
        )}

        <div className="share-footer">
          <button className="btn-secondary" type="button" onClick={() => void copyLink()}>
            <Link2 />
            Copy link
          </button>
        </div>
      </div>
    </Modal>
  );
}
