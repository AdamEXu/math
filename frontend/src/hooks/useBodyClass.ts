import { useLayoutEffect } from "react";

export function useBodyClass(name: string) {
  useLayoutEffect(() => {
    document.body.classList.add(name);
    return () => document.body.classList.remove(name);
  }, [name]);
}
