import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_FOLDER, FOLDER_COLORS } from "../api/folders";
import type { Folder, FolderChanges } from "../api/types";
import { type Point, useDismiss, usePlacement } from "../components/overlay/floating";
import { FolderIcon } from "../icons/LucideIcon";
import { IconPicker } from "./IconPicker";

type FolderEditorProps = {
  folder: Folder | null;
  point: Point;
  onSave: (changes: FolderChanges) => void;
  onClose: () => void;
};

export function FolderEditor({ folder, point, onSave, onClose }: FolderEditorProps) {
  const initial = folder ?? DEFAULT_FOLDER;
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState(initial.icon);
  const [color, setColor] = useState(initial.color);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();

  usePlacement(formRef, point);
  useDismiss(formRef, onClose, "#new-folder");

  useLayoutEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  return createPortal(
    <form
      className="popover folder-editor"
      id="folder-editor"
      role="dialog"
      aria-labelledby="folder-editor-heading"
      ref={formRef}
      style={{ "--folder-color": color }}
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed) onSave({ name: trimmed, icon, color });
      }}
    >
      <div className="editor-heading" id="folder-editor-heading">
        {folder ? "Edit folder" : "New folder"}
      </div>
      <div
        className={`side-item folder-item active editor-preview${trimmed ? "" : " placeholder-name"}`}
        aria-hidden="true"
        style={{ "--folder-color": color }}
      >
        <FolderIcon name={icon} />
        <span className="side-label">{trimmed || "Folder name"}</span>
      </div>
      <input
        className="editor-name"
        ref={nameRef}
        type="text"
        maxLength={60}
        autoComplete="off"
        spellCheck={false}
        aria-label="Folder name"
        placeholder="Folder name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="pop-label">Color</div>
      <div className="swatches">
        {Object.entries(FOLDER_COLORS).map(([swatch, label]) => (
          <button
            key={swatch}
            className="swatch"
            type="button"
            data-color={swatch}
            style={{ "--swatch": swatch }}
            aria-label={label}
            title={label}
            aria-pressed={swatch === color}
            onClick={() => setColor(swatch)}
          />
        ))}
      </div>
      <div className="pop-label">Icon</div>
      <IconPicker selected={icon} onSelect={setIcon} />
      <div className="editor-actions">
        <button className="btn-secondary" type="button" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" type="submit" disabled={!trimmed}>
          {folder ? "Save" : "Create"}
        </button>
      </div>
    </form>,
    document.body,
  );
}
