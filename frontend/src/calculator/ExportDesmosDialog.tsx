import { Braces, CircleAlert, CircleCheck, Copy, ExternalLink, LoaderCircle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/client";
import { exportToDesmos } from "../api/desmos";
import { Modal } from "../components/overlay/Modal";
import { useToast } from "../components/Toast";
import type { Calculator } from "./desmos";

const THUMBNAIL = { width: 200, height: 200, targetPixelRatio: 2 };

type Phase = { kind: "working" } | { kind: "done"; url: string; copied: boolean } | { kind: "failed"; message: string };

function screenshot(calc: Calculator) {
  return new Promise<string>((resolve) => calc.asyncScreenshot(THUMBNAIL, resolve));
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type ExportDesmosDialogProps = {
  graphId: string;
  title: string;
  calc: Calculator;
  onDismiss: () => void;
};

export function ExportDesmosDialog({ graphId, title, calc, onDismiss }: ExportDesmosDialogProps) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "working" });
  const started = useRef(false);

  const run = async () => {
    setPhase({ kind: "working" });
    try {
      const state = calc.getState();
      const { url } = await exportToDesmos(graphId, state, await screenshot(calc));
      setPhase({ kind: "done", url, copied: await copyText(url) });
    } catch (exportError) {
      setPhase({ kind: "failed", message: errorMessage(exportError, "Couldn't publish to desmos.com.") });
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  });

  const copy = async (text: string, done: string) => {
    toast((await copyText(text)) ? done : "Couldn't copy to the clipboard");
  };

  return (
    <Modal labelledBy="export-heading" onDismiss={onDismiss}>
      <div className="panel desmos-panel">
        <h1 id="export-heading">Export “{title}” to Desmos</h1>

        {phase.kind === "working" && (
          <p className="lede desmos-status">
            <LoaderCircle className="spin" />
            Publishing a copy to desmos.com…
          </p>
        )}

        {phase.kind === "done" && (
          <>
            <p className="lede desmos-status">
              {phase.copied ? <CircleCheck className="ok" /> : null}
              {phase.copied ? "Link copied." : "Published. Copy the link below."}
            </p>
            <input
              className="text-input desmos-input desmos-url"
              type="text"
              readOnly
              value={phase.url}
              aria-label="Desmos link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <p className="hint">
              Paste it into the expression list of a new Desmos graph to bring it in, or open the link and use{" "}
              <strong>Save a copy</strong>.
            </p>
            <div className="desmos-actions">
              <button className="btn-secondary" type="button" onClick={() => void copy(phase.url, "Link copied")}>
                <Copy />
                Copy link
              </button>
              <a className="btn-secondary" href={phase.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink />
                Open link
              </a>
            </div>
          </>
        )}

        {phase.kind === "failed" && (
          <>
            <p className="field-error">
              <CircleAlert />
              {phase.message}
            </p>
            <p className="hint">You can still copy this graph's state as JSON and load it into Desmos yourself.</p>
            <div className="desmos-actions">
              <button
                className="btn-secondary"
                type="button"
                onClick={() => void copy(JSON.stringify(calc.getState()), "Graph state copied")}
              >
                <Braces />
                Copy graph state (JSON)
              </button>
              <button className="btn-secondary" type="button" onClick={() => void run()}>
                <RotateCcw />
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
