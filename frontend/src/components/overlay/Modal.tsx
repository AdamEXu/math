import { X } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { createPortal } from "react-dom";
import { useEscape, useFocusTrap } from "./focus";

type ModalProps = {
  labelledBy: string;
  onDismiss: () => void;
  children: ReactNode;
};

export function Modal({ labelledBy, onDismiss, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const pressedBackdrop = useRef(false);
  useFocusTrap(dialogRef);
  useEscape(onDismiss);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) onDismiss();
        pressedBackdrop.current = false;
      }}
    >
      <div
        className="modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        ref={dialogRef}
      >
        {children}
        <button className="modal-close" type="button" aria-label="Close" onClick={onDismiss}>
          <X />
        </button>
      </div>
    </div>,
    document.body,
  );
}
