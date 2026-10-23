import { type MouseEvent, type ReactNode, useCallback, useState } from "react";
import { createPortal } from "react-dom";

type Tip = { text: ReactNode; left: number; top: number };

export function useHoverTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const hide = useCallback(() => setTip(null), []);
  const tipProps = (text: ReactNode) => ({
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setTip({ text, left: rect.left + rect.width / 2, top: rect.bottom + 6 });
    },
    onMouseLeave: hide,
    onMouseDown: hide,
  });
  const element = tip
    ? createPortal(
        <div className="tooltip tooltip-below" role="tooltip" style={{ left: `${tip.left}px`, top: `${tip.top}px` }}>
          {tip.text}
        </div>,
        document.body,
      )
    : null;
  return { tipProps, tip: element };
}
