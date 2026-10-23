import { CloudOff } from "lucide-react";
import type { ConnectionStatus } from "./socket";

export type SessionStatus = ConnectionStatus | "loading" | "error";

export function SaveStatusBadge({ status }: { status: SessionStatus }) {
  if (status !== "offline" && status !== "error") return null;
  return (
    <div className="save-status" role="status" aria-live="polite">
      <CloudOff />
      {status === "offline" ? "Offline" : "Couldn't load"}
    </div>
  );
}
