import { ChartSpline, EllipsisVertical, FolderPlus, PanelLeftClose, PanelLeftOpen, Users } from "lucide-react";
import { type DragEvent, type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { Folder } from "../api/types";
import { FolderIcon } from "../icons/LucideIcon";
import { useSidebarCollapsed } from "./useSidebarCollapsed";
import { GRAPH_DRAG_TYPE } from "./views";

type Tip = { text: string; left: number; top: number };

export type FolderRowHandlers = {
  onKebab: (folder: Folder, button: HTMLElement) => void;
  onContextMenu: (folder: Folder, event: MouseEvent) => void;
  onEdit: (folder: Folder, row: HTMLElement) => void;
  onDrop: (folder: Folder) => void;
};

type SidebarProps = FolderRowHandlers & {
  activeKey: string;
  folders: Folder[];
  highlightedId: string | null;
  onNewFolder: (button: HTMLElement) => void;
};

function SideLink({
  to,
  view,
  active,
  tip,
  icon,
  children,
}: {
  to: string;
  view: string;
  active: boolean;
  tip: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      className={`side-item${active ? " active" : ""}`}
      to={to}
      data-view={view}
      data-tip={tip}
      draggable={false}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      <span className="side-label">{children}</span>
    </Link>
  );
}

export function Sidebar({ activeKey, folders, highlightedId, onNewFolder, ...rowHandlers }: SidebarProps) {
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const [tip, setTip] = useState<Tip | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const clear = () => setDropTarget(null);
    document.addEventListener("dragend", clear);
    return () => document.removeEventListener("dragend", clear);
  }, []);

  const isCollapsed = () =>
    document.documentElement.classList.contains("sidebar-collapsed") ||
    (sidebarRef.current?.getBoundingClientRect().width ?? 0) < 100;

  const showTip = (target: HTMLElement) => {
    const always = target.dataset.tipAlways;
    if (always === undefined && !isCollapsed()) return setTip(null);
    const rect = target.getBoundingClientRect();
    setTip({ text: always ?? target.dataset.tip ?? "", left: rect.right + 8, top: rect.top + rect.height / 2 });
  };

  const rowDragProps = (folder: Folder) => ({
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(GRAPH_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(folder.id);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
        setDropTarget((current) => (current === folder.id ? null : current));
      }
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      setDropTarget(null);
      if (!event.dataTransfer.types.includes(GRAPH_DRAG_TYPE)) return;
      event.preventDefault();
      rowHandlers.onDrop(folder);
    },
  });

  return (
    <aside
      className="sidebar"
      id="sidebar"
      aria-label="Library"
      ref={sidebarRef}
      onMouseOver={(event) => {
        const target = (event.target as Element).closest<HTMLElement>("[data-tip], [data-tip-always]");
        if (target) showTip(target);
        else setTip(null);
      }}
      onMouseLeave={() => setTip(null)}
      onClick={() => setTip(null)}
    >
      <div className="side-top">
        <button
          className="side-icon-button"
          id="new-folder"
          type="button"
          aria-label="New folder"
          data-tip-always="New folder"
          onClick={(event) => onNewFolder(event.currentTarget)}
        >
          <FolderPlus />
        </button>
        <button
          className="side-icon-button side-toggle"
          id="sidebar-toggle"
          type="button"
          aria-label="Toggle sidebar"
          data-tip-always={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed(!collapsed)}
        >
          <PanelLeftClose className="when-expanded" />
          <PanelLeftOpen className="when-collapsed" />
        </button>
      </div>
      <nav className="side-nav">
        <SideLink to="/" view="all" active={activeKey === "all"} tip="All Graphs" icon={<ChartSpline />}>
          All Graphs
        </SideLink>
        <div className="side-sep" />
        <div className="folder-list" id="folder-list">
          {folders.map((folder) => {
            const active = activeKey === folder.id;
            const classes = ["folder-row"];
            if (active) classes.push("active");
            if (highlightedId === folder.id) classes.push("menu-open");
            if (dropTarget === folder.id) classes.push("drop-target");
            return (
              <div
                key={folder.id}
                className={classes.join(" ")}
                data-folder-id={folder.id}
                onDoubleClick={(event) => {
                  if ((event.target as Element).closest(".side-kebab")) return;
                  rowHandlers.onEdit(folder, event.currentTarget);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  rowHandlers.onContextMenu(folder, event);
                }}
                {...rowDragProps(folder)}
              >
                <Link
                  className={`side-item folder-item${active ? " active" : ""}`}
                  to={`/folders/${folder.id}`}
                  data-view={folder.id}
                  data-tip={folder.name}
                  style={{ "--folder-color": folder.color }}
                  draggable={false}
                  aria-current={active ? "page" : undefined}
                >
                  <FolderIcon name={folder.icon} />
                  <span className="side-label">{folder.name}</span>
                </Link>
                <button
                  className="side-kebab"
                  type="button"
                  aria-label="Folder options"
                  aria-haspopup="dialog"
                  onClick={(event) => {
                    event.stopPropagation();
                    rowHandlers.onKebab(folder, event.currentTarget);
                  }}
                >
                  <EllipsisVertical />
                </button>
              </div>
            );
          })}
        </div>
        {folders.length > 0 && <div className="side-sep" />}
        <SideLink to="/shared" view="shared" active={activeKey === "shared"} tip="Shared with you" icon={<Users />}>
          Shared with you
        </SideLink>
      </nav>
      {createPortal(
        <div
          className="tooltip"
          id="tooltip"
          role="tooltip"
          hidden={!tip}
          style={tip ? { left: `${tip.left}px`, top: `${tip.top}px` } : undefined}
        >
          {tip?.text}
        </div>,
        document.body,
      )}
    </aside>
  );
}
