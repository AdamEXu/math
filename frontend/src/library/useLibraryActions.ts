import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import * as folderApi from "../api/folders";
import * as graphApi from "../api/graphs";
import { keys, updateFolders, updateGraphs, useMe } from "../api/queries";
import { removeMember } from "../api/sharing";
import type { Folder, FolderChanges, Graph } from "../api/types";
import { useToast } from "../components/Toast";
import { displayTitle } from "./views";

export function useLibraryActions() {
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const me = useMe();

  const failed = (error: unknown) => {
    console.error(error);
    toast("Couldn't save that change. Try again.");
  };

  const setGraphFolder = (graphId: string, folderId: string | null) =>
    updateGraphs(client, (graphs) => graphs.map((g) => (g.id === graphId ? { ...g, folder_id: folderId } : g)));

  const patchGraph = (graphId: string, changes: Partial<Graph>) => {
    updateGraphs(client, (graphs) => graphs.map((g) => (g.id === graphId ? { ...g, ...changes } : g)));
    client.setQueryData<Graph>(keys.graph(graphId), (graph) => (graph ? { ...graph, ...changes } : graph));
  };

  const replaceFolder = (folder: Folder) =>
    updateFolders(client, (folders) => folders.map((f) => (f.id === folder.id ? folder : f)));

  return {
    async createGraph(folderId: string | null) {
      try {
        const graph = await graphApi.createGraph(folderId);
        updateGraphs(client, (graphs) => [graph, ...graphs]);
        client.setQueryData(keys.graph(graph.id), graph);
        navigate(graphApi.graphPath(graph.id));
      } catch (error) {
        failed(error);
      }
    },

    async deleteGraph(graph: Graph) {
      if (!confirm(`Delete “${displayTitle(graph)}”?`)) return;
      try {
        await graphApi.deleteGraph(graph.id);
      } catch (error) {
        return failed(error);
      }
      updateGraphs(client, (graphs) => graphs.filter((g) => g.id !== graph.id));
      client.removeQueries({ queryKey: keys.graph(graph.id) });
    },

    async leaveGraph(graph: Graph) {
      if (!me.data || !confirm(`Remove “${displayTitle(graph)}” from your shared graphs?`)) return;
      try {
        await removeMember(graph.id, me.data.id);
      } catch (error) {
        return failed(error);
      }
      updateGraphs(client, (graphs) => graphs.filter((g) => g.id !== graph.id));
      client.removeQueries({ queryKey: keys.graph(graph.id) });
    },

    async renameGraph(graph: Graph, title: string) {
      const previous = { title: graph.title, updated_at: graph.updated_at };
      if (title === graph.title) return;
      patchGraph(graph.id, { title });
      try {
        const saved = await graphApi.renameGraph(graph.id, title);
        patchGraph(graph.id, { title: saved.title, updated_at: saved.updated_at });
      } catch (error) {
        patchGraph(graph.id, previous);
        failed(error);
      }
    },

    async moveGraph(graph: Graph, folderId: string | null) {
      const previous = graph.folder_id;
      if (previous === folderId) return;
      setGraphFolder(graph.id, folderId);
      try {
        await graphApi.moveGraph(graph.id, folderId);
      } catch (error) {
        setGraphFolder(graph.id, previous);
        return failed(error);
      }
      const name = client.getQueryData<Folder[]>(keys.folders)?.find((f) => f.id === folderId)?.name;
      toast(folderId ? `Moved to ${name ?? "folder"}` : "Removed from folder");
    },

    async saveFolder(previous: Folder | null, changes: FolderChanges) {
      if (!previous) {
        try {
          const folder = await folderApi.createFolder(changes);
          updateFolders(client, (folders) => [...folders, folder]);
        } catch (error) {
          failed(error);
        }
        return;
      }
      replaceFolder({ ...previous, ...changes });
      try {
        replaceFolder(await folderApi.updateFolder(previous.id, changes));
      } catch (error) {
        replaceFolder(previous);
        failed(error);
      }
    },

    async deleteFolder(folder: Folder, viewing: boolean) {
      if (!confirm(`Delete the folder “${folder.name}”? The graphs in it won't be deleted.`)) return;
      try {
        await folderApi.deleteFolder(folder.id);
      } catch (error) {
        return failed(error);
      }
      if (viewing) navigate("/", { replace: true });
      updateFolders(client, (folders) => folders.filter((f) => f.id !== folder.id));
      updateGraphs(client, (graphs) => graphs.map((g) => (g.folder_id === folder.id ? { ...g, folder_id: null } : g)));
    },
  };
}
