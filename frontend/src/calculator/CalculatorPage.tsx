import { useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { isNotFound } from "../api/client";
import { fetchDoc } from "../api/graphs";
import { keys, useGraph } from "../api/queries";
import { TopBar } from "../components/TopBar";
import { useBodyClass } from "../hooks/useBodyClass";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { NotFoundPage } from "../pages/NotFoundPage";
import { loadDesmos } from "./desmos";
import { GraphSession } from "./GraphSession";
import type { SaveStatus } from "./saver";
import { SaveStatusBadge } from "./SaveStatusBadge";

export function CalculatorPage() {
  const { graphId = "" } = useParams();
  const graph = useGraph(graphId);
  if (isNotFound(graph.error)) return <NotFoundPage />;
  return <Calculator key={graphId} graphId={graphId} initialTitle={graph.data?.title} />;
}

function Calculator({ graphId, initialTitle }: { graphId: string; initialTitle: string | undefined }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<GraphSession | null>(null);
  const [status, setStatus] = useState<SaveStatus>("loading");
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState(false);
  const [title, setTitle] = useState(initialTitle === undefined ? null : initialTitle || "Untitled Graph");

  useBodyClass("calculator-page");
  useDocumentTitle(title === null ? "math" : `${title} - math`);

  useEffect(() => {
    if (initialTitle === undefined || sessionRef.current || !titleRef.current) return;
    titleRef.current.value = initialTitle;
    setTitle(initialTitle || "Untitled Graph");
  }, [initialTitle]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [doc, desmos] = await Promise.all([fetchDoc(graphId), loadDesmos()]);
      const container = containerRef.current;
      const titleInput = titleRef.current;
      if (cancelled || !container || !titleInput) return;
      sessionRef.current = GraphSession.open({
        graphId,
        doc,
        desmos,
        container,
        titleInput,
        hooks: {
          onStatus: setStatus,
          onTitle: setTitle,
          onSettled: () => {
            void client.invalidateQueries({ queryKey: keys.graphs });
            void client.invalidateQueries({ queryKey: keys.graph(graphId) });
          },
        },
      });
      setReady(true);
    })().catch((error: unknown) => {
      if (cancelled) return;
      if (isNotFound(error)) setMissing(true);
      else setStatus("error");
      console.error(error);
    });
    return () => {
      cancelled = true;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, [graphId, client]);

  const goHome = async (event: MouseEvent<HTMLAnchorElement>) => {
    const session = sessionRef.current;
    if (!session || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    await session.leave();
    navigate("/");
  };

  if (missing) return <NotFoundPage />;

  return (
    <>
      <TopBar
        onHome={goHome}
        status={<SaveStatusBadge status={status} />}
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
            disabled={!ready}
          />
        }
      />
      <div id="calculator" ref={containerRef} />
    </>
  );
}
