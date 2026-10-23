import { CloudOff } from "lucide-react";
import type { SaveStatus } from "./saver";

export function SaveStatusBadge({ status }: { status: SaveStatus }) {
  if (status !== "offline" && status !== "error") return null;
  return (
    <div className="save-status" role="status" aria-live="polite">
      <CloudOff />
      {status === "offline" ? "Offline" : "Couldn't load"}
    </div>
  );
}
