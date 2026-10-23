import { useSyncExternalStore } from "react";

export const LUCIDE_VERSION = "1.61.0";
const ICON_SET_URL = `/static/lucide/icons.json?v=${LUCIDE_VERSION}`;

export type IconEntry = { name: string; tags: string[] };
export type IconSet = { entries: IconEntry[]; byName: Map<string, IconEntry> };

const markup = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
let iconSet: Promise<IconSet> | null = null;
let loadedSet: IconSet | null = null;

function notify() {
  version++;
  for (const listener of listeners) listener();
}

export function registerIcons(icons: Record<string, string>) {
  let changed = false;
  for (const [name, inner] of Object.entries(icons)) {
    if (markup.get(name) === inner) continue;
    markup.set(name, inner);
    changed = true;
  }
  if (changed) notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIconMarkup(name: string) {
  useSyncExternalStore(subscribe, () => version);
  return markup.get(name) ?? "";
}

export function loadedIconSet() {
  return loadedSet;
}

export function loadIconSet(): Promise<IconSet> {
  iconSet ??= fetch(ICON_SET_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`icons failed: ${res.status}`);
      return res.json() as Promise<{ icons: Record<string, [string, string[]]> }>;
    })
    .then(({ icons }) => {
      const entries = Object.entries(icons).map(([name, [inner, tags]]) => {
        markup.set(name, inner);
        return { name, tags };
      });
      notify();
      loadedSet = { entries, byName: new Map(entries.map((entry) => [entry.name, entry])) };
      return loadedSet;
    })
    .catch((error: unknown) => {
      iconSet = null;
      throw error;
    });
  return iconSet;
}
