import { type RefObject, useEffect, useLayoutEffect } from "react";
import { useLatest } from "./focus";

export type Point = { x: number; y: number };

const MARGIN = 8;

export function usePlacement(ref: RefObject<HTMLElement | null>, point: Point) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(MARGIN, Math.min(point.x, innerWidth - width - MARGIN))}px`;
    el.style.top = `${Math.max(MARGIN, Math.min(point.y, innerHeight - height - MARGIN))}px`;
  }, [ref, point.x, point.y]);
}

export function useDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void, ignore?: string) {
  const latest = useLatest(onDismiss);
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || ref.current?.contains(target)) return;
      if (ignore && target instanceof Element && target.closest(ignore)) return;
      latest.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current();
    };
    const onResize = () => latest.current();
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
      removeEventListener("resize", onResize);
    };
  }, [ref, ignore, latest]);
}
