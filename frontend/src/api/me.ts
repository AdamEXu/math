import { api } from "./client";
import type { Config, HandleCheck, Me, Profile } from "./types";

export const fetchMe = () => api<Me>("/api/me");

export const saveProfile = (profile: Profile) => api<Me>("/api/me", { method: "PUT", json: profile });

export const checkHandle = (handle: string) =>
  api<HandleCheck>(`/api/handles/check?handle=${encodeURIComponent(handle)}`);

export const fetchConfig = () => api<Config>("/api/config");
