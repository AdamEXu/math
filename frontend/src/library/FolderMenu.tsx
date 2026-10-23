import { Pencil, Trash2 } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { type Point, useDismiss, usePlacement } from "../components/overlay/floating";

type FolderMenuProps = {
  point: Point;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export function FolderMenu({ point, onEdit, onDelete, onClose }: FolderMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  usePlacement(ref, point);
  useDismiss(ref, onClose, ".side-kebab");

  return createPortal(
    <div className="menu folder-menu" id="folder-menu" role="menu" ref={ref}>
      <button className="menu-item" type="button" role="menuitem" onClick={onEdit}>
        <Pencil />
        Edit folder
      </button>
      <button className="menu-item danger" type="button" role="menuitem" onClick={onDelete}>
        <Trash2 />
        Delete folder
      </button>
    </div>,
    document.body,
  );
}
