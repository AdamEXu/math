import { useLayoutEffect, useRef } from "react";

type Entry = { title: string };
const stack: Entry[] = [];

function apply() {
  const top = stack[stack.length - 1];
  if (top) document.title = top.title;
}

export function useDocumentTitle(title: string) {
  const entry = useRef<Entry | null>(null);

  useLayoutEffect(() => {
    const own: Entry = { title: entry.current?.title ?? title };
    entry.current = own;
    stack.push(own);
    apply();
    return () => {
      stack.splice(stack.indexOf(own), 1);
      apply();
    };
  }, []);

  useLayoutEffect(() => {
    if (!entry.current) return;
    entry.current.title = title;
    apply();
  }, [title]);
}
