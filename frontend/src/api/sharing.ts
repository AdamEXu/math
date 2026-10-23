import { api } from "./client";
import type { LinkAccess, MemberRole, PublicUser, Sharing } from "./types";

export const getSharing = (graphId: string) => api<Sharing>(`/api/graphs/${graphId}/sharing`);

export const addMember = (graphId: string, user: string, role: MemberRole) =>
  api<Sharing>(`/api/graphs/${graphId}/members`, { method: "POST", json: { user, role } });

export const changeMemberRole = (graphId: string, userId: string, role: MemberRole) =>
  api<Sharing>(`/api/graphs/${graphId}/members/${userId}`, { method: "PATCH", json: { role } });

export const removeMember = (graphId: string, userId: string) =>
  api<Sharing | { ok: true }>(`/api/graphs/${graphId}/members/${userId}`, { method: "DELETE" });

export const setLinkAccess = (graphId: string, access: LinkAccess) =>
  api<Sharing>(`/api/graphs/${graphId}/link`, { method: "PUT", json: { access } });

export const searchUsers = async (query: string) =>
  (await api<{ users: PublicUser[] }>(`/api/users/search?q=${encodeURIComponent(query)}`)).users;
