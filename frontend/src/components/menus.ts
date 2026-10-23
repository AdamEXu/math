import { type MouseEvent, useId, useSyncExternalStore } from "react";

let openId: string | null = null;
const listeners = new Set<() => void>();

function setOpen(id: string | null) {
  if (openId === id) return;
  openId = id;
  for (const listener of listeners) listener();
}

export function closeMenus() {
  setOpen(null);
}

document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element && event.target.closest("[data-menu-toggle]"))) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDropdown() {
  const id = useId();
  const open = useSyncExternalStore(subscribe, () => openId === id);
  const toggleProps = {
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "data-menu-toggle": "",
    onClick: (event: MouseEvent) => {
      event.preventDefault();
      setOpen(open ? null : id);
    },
  };
  return { open, toggleProps };
}
