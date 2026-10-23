import { FETCH_HEADERS, api, apiBytes } from "./client";
import type { Graph } from "./types";

export const graphPath = (id: string) => `/calculator/${id}`;
export const thumbnailUrl = (graph: Graph) => `/graphs/${graph.id}/thumbnail.png?v=${graph.thumbnail_at}`;
export const updatesUrl = (id: string) => `/api/graphs/${id}/updates`;

export const listGraphs = async () => (await api<{ graphs: Graph[] }>("/api/graphs")).graphs;

export const getGraph = (id: string) => api<Graph>(`/api/graphs/${id}`);

export const createGraph = (folderId: string | null) =>
  api<Graph>("/api/graphs", { method: "POST", json: { folder_id: folderId } });

export const deleteGraph = (id: string) => api<{ ok: true }>(`/api/graphs/${id}`, { method: "DELETE" });

export const moveGraph = (id: string, folderId: string | null) =>
  api<{ folder_id: string | null }>(`/api/graphs/${id}/folder`, { method: "PUT", json: { folder_id: folderId } });

export const fetchDoc = (id: string) => apiBytes(`/api/graphs/${id}/doc`);

export async function uploadThumbnail(id: string, png: Blob) {
  await fetch(`/api/graphs/${id}/thumbnail`, { method: "POST", headers: FETCH_HEADERS, body: png });
}

export async function uploadImage(image: Blob) {
  const res = await fetch("/api/images", {
    method: "POST",
    headers: { ...FETCH_HEADERS, "Content-Type": image.type },
    body: image,
  });
  if (!res.ok) throw new Error(`image upload failed: ${res.status}`);
  return ((await res.json()) as { url: string }).url;
}
