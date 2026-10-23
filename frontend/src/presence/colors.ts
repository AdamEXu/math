export const PRESENCE_COLORS = [
  "#e05cf0",
  "#72bf44",
  "#5b8cff",
  "#f05a5a",
  "#f5a524",
  "#20c3b4",
  "#a77bff",
  "#ff6fae",
  "#3cb4e5",
  "#c9b31f",
];

export function presenceColor(userId: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) hash = Math.imul(hash ^ userId.charCodeAt(i), 0x01000193);
  return PRESENCE_COLORS[(hash >>> 0) % PRESENCE_COLORS.length] as string;
}

export type PresenceUser = {
  id: string;
  name: string;
  handle: string | null;
  display_name: string;
  avatar_url: string | null;
  avatar_hue: number;
  avatar_initial: string;
};

export type PresenceState = { user?: PresenceUser; [field: string]: unknown };

export function distinctUsers(states: Iterable<PresenceState>, excludeId: string | undefined) {
  const users = new Map<string, PresenceUser>();
  for (const state of states) {
    const user = state.user;
    if (user && user.id !== excludeId && !users.has(user.id)) users.set(user.id, user);
  }
  return [...users.values()];
}
