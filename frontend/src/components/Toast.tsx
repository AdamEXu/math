import { type ReactNode, createContext, use, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TOAST_MS = 2600;
const ToastContext = createContext<(message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((text: string) => {
    setMessage(text);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), TOAST_MS);
  }, []);

  return (
    <ToastContext value={show}>
      {children}
      {createPortal(
        <div className="toast" id="toast" role="status" aria-live="polite" hidden={message === null}>
          {message}
        </div>,
        document.body,
      )}
    </ToastContext>
  );
}

export function useToast() {
  return use(ToastContext);
}
