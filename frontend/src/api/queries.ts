import { QueryClient, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { registerIcons } from "../icons/registry";
import { ApiError } from "./client";
import { listFolders } from "./folders";
import { getGraph, listGraphs } from "./graphs";
import { fetchMe } from "./me";
import type { Folder, Graph } from "./types";

export const keys = {
  me: ["me"] as const,
  graphs: ["graphs"] as const,
  folders: ["folders"] as const,
  graph: (id: string) => ["graph", id] as const,
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

export const meQuery = queryOptions({ queryKey: keys.me, queryFn: fetchMe });

export const graphsQuery = queryOptions({ queryKey: keys.graphs, queryFn: listGraphs });

export const foldersQuery = queryOptions({
  queryKey: keys.folders,
  queryFn: async (): Promise<Folder[]> => {
    const { folders, icons } = await listFolders();
    registerIcons(icons);
    return folders;
  },
});

export const useMe = () => useQuery(meQuery);
export const useGraphs = () => useQuery(graphsQuery);
export const useFolders = () => useQuery(foldersQuery);

export function useGraph(id: string) {
  const client = useQueryClient();
  return useQuery({
    queryKey: keys.graph(id),
    queryFn: () => getGraph(id),
    initialData: () => client.getQueryData(graphsQuery.queryKey)?.find((graph) => graph.id === id),
    initialDataUpdatedAt: () => client.getQueryState(graphsQuery.queryKey)?.dataUpdatedAt,
  });
}

export function updateGraphs(client: QueryClient, update: (graphs: Graph[]) => Graph[]) {
  client.setQueryData<Graph[]>(keys.graphs, (graphs) => (graphs ? update(graphs) : graphs));
}

export function updateFolders(client: QueryClient, update: (folders: Folder[]) => Folder[]) {
  client.setQueryData<Folder[]>(keys.folders, (folders) => (folders ? update(folders) : folders));
}
