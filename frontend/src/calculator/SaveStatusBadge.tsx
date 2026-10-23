import { CloudCheck, CloudOff, LoaderCircle } from "lucide-react";
import type { SaveStatus } from "./saver";

export function SaveStatusBadge({ status }: { status: SaveStatus }) {
  return (
    <div className="save-status" id="status" data-status={status} role="status" aria-live="polite">
      <span data-when="loading">Loading...</span>
      <span data-when="saved">
        <CloudCheck />
        Saved
      </span>
      <span data-when="saving">
        <LoaderCircle className="spin" />
        Saving...
      </span>
      <span data-when="offline">
        <CloudOff />
        Offline
      </span>
      <span data-when="error">
        <CloudOff />
        Couldn't load
      </span>
    </div>
  );
}
