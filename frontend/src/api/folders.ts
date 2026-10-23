import { api } from "./client";
import type { Folder, FolderChanges, FolderList } from "./types";

export const FOLDER_COLORS: Record<string, string> = {
  "#737373": "Grey",
  "#c74440": "Red",
  "#2d70b3": "Blue",
  "#388c46": "Green",
  "#6042a6": "Purple",
  "#fa7e19": "Orange",
  "#000000": "Black",
};

export const DEFAULT_FOLDER: FolderChanges = { name: "New folder", icon: "folder", color: "#737373" };

export const listFolders = () => api<FolderList>("/api/folders");

export const createFolder = (changes: FolderChanges) => api<Folder>("/api/folders", { method: "POST", json: changes });

export const updateFolder = (id: string, changes: Partial<FolderChanges>) =>
  api<Folder>(`/api/folders/${id}`, { method: "PATCH", json: changes });

export const deleteFolder = (id: string) => api<{ ok: true }>(`/api/folders/${id}`, { method: "DELETE" });
