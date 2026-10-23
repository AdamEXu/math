import type { Folder, Graph } from "../api/types";

export type LibraryView = "all" | "shared" | { folder: Folder };

export function viewKey(view: LibraryView) {
  return typeof view === "string" ? view : view.folder.id;
}

export function viewName(view: LibraryView) {
  if (view === "shared") return "Shared with you";
  if (view === "all") return "All Graphs";
  return view.folder.name;
}

export function inView(graph: Graph, view: LibraryView) {
  if (view === "shared") return graph.role !== "owner";
  if (view === "all") return graph.role === "owner";
  return graph.folder_id === view.folder.id;
}

export function displayTitle(graph: Graph) {
  return graph.title || "Untitled Graph";
}

export const GRAPH_DRAG_TYPE = "application/x-math-graph";
