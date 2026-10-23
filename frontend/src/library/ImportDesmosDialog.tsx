import { useQueryClient } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { errorMessage } from "../api/client";
import { importDesmosGraph } from "../api/desmos";
import { graphPath } from "../api/graphs";
import { keys, updateGraphs } from "../api/queries";
import { Modal } from "../components/overlay/Modal";

type ImportDesmosDialogProps = {
  initialLink: string;
  folderId: string | null;
  onDismiss: () => void;
};

export function ImportDesmosDialog({ initialLink, folderId, onDismiss }: ImportDesmosDialogProps) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [link, setLink] = useState(initialLink);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const graph = await importDesmosGraph(value.trim(), folderId);
      updateGraphs(client, (graphs) => [graph, ...graphs]);
      client.setQueryData(keys.graph(graph.id), graph);
      navigate(graphPath(graph.id));
    } catch (importError) {
      setError(errorMessage(importError, "Couldn't import that graph. Try again."));
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initialLink) void run(initialLink);
    else inputRef.current?.focus();
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) void run(link);
  };

  return (
    <Modal labelledBy="import-heading" onDismiss={onDismiss}>
      <form className="panel desmos-panel" onSubmit={submit}>
        <h1 id="import-heading">Import from Desmos</h1>
        <p className="lede">Paste a link to a graph on desmos.com. You'll get your own copy here.</p>
        <div className="desmos-row">
          <input
            ref={inputRef}
            className="text-input desmos-input"
            type="text"
            inputMode="url"
            placeholder="https://www.desmos.com/calculator/…"
            aria-label="Desmos graph link"
            autoComplete="off"
            spellCheck={false}
            value={link}
            disabled={busy}
            onChange={(event) => setLink(event.target.value)}
          />
          <button className="btn-primary" type="submit" disabled={busy || !link.trim()}>
            {busy ? <LoaderCircle className="spin" /> : null}
            {busy ? "Importing" : "Import"}
          </button>
        </div>
        {error && (
          <p className="field-error">
            <CircleAlert />
            {error}
          </p>
        )}
        <p className="hint">Tip: paste a Desmos link anywhere on this page to import it.</p>
      </form>
    </Modal>
  );
}
