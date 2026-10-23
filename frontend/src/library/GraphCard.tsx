import { Check, ChevronRight, EllipsisVertical, ExternalLink, FolderInput, FolderMinus, Trash2 } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { graphPath, thumbnailUrl } from "../api/graphs";
import type { Folder, Graph } from "../api/types";
import { closeMenus, useDropdown } from "../components/menus";
import { FolderIcon } from "../icons/LucideIcon";
import { formatUpdated } from "./dates";
import { GRAPH_DRAG_TYPE, displayTitle } from "./views";

type GraphCardProps = {
  graph: Graph;
  folders: Folder[];
  onMove: (folderId: string | null) => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
};

function SubmenuItem({
  icon,
  label,
  trailing,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      className="menu-item"
      type="button"
      role="menuitem"
      onClick={(event) => {
        event.stopPropagation();
        closeMenus();
        onSelect();
      }}
    >
      {icon}
      <span className="menu-label">{label}</span>
      {trailing}
    </button>
  );
}

function MoveSubmenu({ graph, folders, onMove }: Pick<GraphCardProps, "graph" | "folders" | "onMove">) {
  const ref = useRef<HTMLDivElement>(null);
  const [openLeft, setOpenLeft] = useState(false);

  useLayoutEffect(() => {
    if (ref.current && ref.current.getBoundingClientRect().right > innerWidth - 8) setOpenLeft(true);
  }, []);

  return (
    <div className={`menu submenu${openLeft ? " open-left" : ""}`} role="menu" ref={ref}>
      {folders.map((folder) => (
        <SubmenuItem
          key={folder.id}
          icon={<FolderIcon name={folder.icon} color={folder.color} />}
          label={folder.name}
          trailing={folder.id === graph.folder_id ? <Check className="menu-check" /> : null}
          onSelect={() => onMove(folder.id)}
        />
      ))}
      {!folders.length && <div className="menu-empty">No folders yet</div>}
      {graph.folder_id && (
        <>
          <div className="menu-sep" />
          <SubmenuItem
            icon={
              <span className="folder-icon">
                <FolderMinus />
              </span>
            }
            label="Remove from folder"
            onSelect={() => onMove(null)}
          />
        </>
      )}
    </div>
  );
}

export function GraphCard({ graph, folders, onMove, onDelete, onDragStart, onDragEnd }: GraphCardProps) {
  const { open, toggleProps } = useDropdown();
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const title = displayTitle(graph);
  const href = graphPath(graph.id);
  const updated = new Date(graph.updated_at);
  const showSubmenu = open && submenuOpen;

  useEffect(() => {
    if (!showSubmenu) return;
    const close = () => setSubmenuOpen(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showSubmenu]);

  const openSubmenu = (event?: MouseEvent) => {
    event?.stopPropagation();
    setSubmenuOpen(true);
  };

  return (
    <div
      className={`card${dragging ? " dragging" : ""}`}
      data-id={graph.id}
      data-folder={graph.folder_id ?? ""}
      data-title={title.toLowerCase()}
      draggable
      onDragStart={(event) => {
        closeMenus();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(GRAPH_DRAG_TYPE, graph.id);
        onDragStart();
        requestAnimationFrame(() => setDragging(true));
      }}
      onDragEnd={() => {
        setDragging(false);
        onDragEnd();
      }}
    >
      <div className="card-head">
        <Link className={`card-title${graph.title ? "" : " untitled"}`} to={href} title={title} draggable={false}>
          {title}
        </Link>
        <div className="dropdown">
          <button
            className="kebab"
            type="button"
            aria-label="Graph options"
            {...toggleProps}
            onClick={(event) => {
              setSubmenuOpen(false);
              toggleProps.onClick(event);
            }}
          >
            <EllipsisVertical />
          </button>
          <div className="menu menu-right" role="menu" hidden={!open}>
            <a className="menu-item" role="menuitem" href={href} target="_blank">
              <ExternalLink />
              Open in new tab
            </a>
            <div className="submenu-host" onMouseEnter={() => openSubmenu()} onMouseLeave={() => setSubmenuOpen(false)}>
              <button
                className="menu-item submenu-button"
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={showSubmenu}
                onClick={openSubmenu}
              >
                <FolderInput />
                Move to folder
                <ChevronRight className="submenu-caret" />
              </button>
              {showSubmenu && <MoveSubmenu graph={graph} folders={folders} onMove={onMove} />}
            </div>
            <button className="menu-item danger" type="button" role="menuitem" onClick={onDelete}>
              <Trash2 />
              Delete
            </button>
          </div>
        </div>
      </div>
      <Link className="thumb" to={href} tabIndex={-1} aria-hidden="true" draggable={false}>
        {graph.thumbnail_at ? (
          <img src={thumbnailUrl(graph)} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="placeholder" />
        )}
        <time className="date" dateTime={updated.toISOString()} title={updated.toLocaleString()}>
          {formatUpdated(graph.updated_at)}
        </time>
      </Link>
    </div>
  );
}
