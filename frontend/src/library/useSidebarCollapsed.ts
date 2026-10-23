import { useCallback, useState } from "react";

const SIDEBAR_KEY = "library.sidebar";
const CLASS = "sidebar-collapsed";

export function useSidebarCollapsed() {
  const [collapsed, setState] = useState(() => document.documentElement.classList.contains(CLASS));
  const setCollapsed = useCallback((next: boolean) => {
    document.documentElement.classList.toggle(CLASS, next);
    setState(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
    } catch {}
  }, []);
  return [collapsed, setCollapsed] as const;
}
