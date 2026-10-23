import { api } from "./client";
import type { Graph } from "./types";

export const DESMOS_LINK = /^\s*(?:https?:\/\/)?(?:www\.)?desmos\.com\/calculator\/[a-z0-9]{5,40}\/?(?:[?#]\S*)?\s*$/;

export const importDesmosGraph = (link: string, folderId: string | null) =>
  api<Graph>("/api/graphs/import-desmos", { method: "POST", json: { link, folder_id: folderId } });

export const exportToDesmos = (graphId: string, state: unknown, thumbnail: string) =>
  api<{ hash: string; url: string }>(`/api/graphs/${graphId}/export-desmos`, {
    method: "POST",
    json: { state, thumbnail },
  });
