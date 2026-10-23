import { ChartSpline, Folder as FolderGlyph, Users } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { useMatch } from "react-router";
import { useFolders, useGraphs } from "../api/queries";
import type { Folder, Graph } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { closeMenus } from "../components/menus";
import type { Point } from "../components/overlay/floating";
import { TopBar, TopBarTitle } from "../components/TopBar";
import { loadDesmos } from "../calculator/desmos";
import { useBodyClass } from "../hooks/useBodyClass";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { NotFoundPage } from "../pages/NotFoundPage";
import { FolderEditor } from "./FolderEditor";
import { FolderMenu } from "./FolderMenu";
import { GraphCard } from "./GraphCard";
import { NewGraphButton } from "./NewGraphButton";
import { Sidebar } from "./Sidebar";
import { useLibraryActions } from "./useLibraryActions";
import { type LibraryView, displayTitle, inView, viewKey, viewName } from "./views";

const DESMOS_PRELOAD_MS = 1000;

type Editing = { folder: Folder | null; point: Point };
type MenuTarget = { folder: Folder; point: Point };

function editorPoint(anchor: Element) {
  const sidebar = document.getElementById("sidebar");
  return { x: (sidebar?.getBoundingClientRect().right ?? 0) + 8, y: anchor.getBoundingClientRect().top - 8 };
}

function rowElement(id: string) {
  return document.querySelector(`.folder-row[data-folder-id="${CSS.escape(id)}"]`);
}

function useLibraryView(folders: Folder[] | undefined): LibraryView | null | undefined {
  const folderMatch = useMatch("/folders/:folderId");
  const sharedMatch = useMatch("/shared");
  if (sharedMatch) return "shared";
  if (!folderMatch) return "all";
  if (!folders) return undefined;
  const folder = folders.find((f) => f.id === folderMatch.params.folderId);
  return folder ? { folder } : null;
}

export function LibraryPage() {
  const graphs = useGraphs();
  const folders = useFolders();
  const view = useLibraryView(folders.data);

  useBodyClass("library-page");
  useEffect(() => {
    const timer = setTimeout(() => void loadDesmos().catch(() => {}), DESMOS_PRELOAD_MS);
    return () => clearTimeout(timer);
  }, []);

  if (view === null) return <NotFoundPage />;
  if (!graphs.data || !folders.data || !view) return null;
  return <Library graphs={graphs.data} folders={folders.data} view={view} />;
}

function Library({ graphs, folders, view }: { graphs: Graph[]; folders: Folder[]; view: LibraryView }) {
  const actions = useLibraryActions();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const dragged = useRef<Graph | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const key = viewKey(view);
  const name = viewName(view);
  const activeFolder = typeof view === "object" ? view.folder : null;

  useDocumentTitle(`${name} - math`);

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [key]);

  const needle = query.trim().toLowerCase();
  const inViewGraphs = graphs.filter((graph) => inView(graph, view));
  const shown = inViewGraphs.filter((graph) => displayTitle(graph).toLowerCase().includes(needle));

  const openMenu = (folder: Folder, point: Point) => {
    closeMenus();
    setEditing(null);
    setMenu({ folder, point });
  };

  const openEditor = (folder: Folder | null, anchor: Element) => {
    closeMenus();
    setMenu(null);
    setEditing({ folder, point: editorPoint(anchor) });
  };

  const highlightedId = menu?.folder.id ?? editing?.folder?.id ?? null;

  return (
    <>
      <TopBar title={<TopBarTitle>My Graphs</TopBarTitle>} />
      <div className="shell">
        <Sidebar
          activeKey={key}
          folders={folders}
          highlightedId={highlightedId}
          onNewFolder={(button) => {
            if (editing && !editing.folder) setEditing(null);
            else openEditor(null, button);
          }}
          onKebab={(folder, button) => {
            if (menu?.folder.id === folder.id) return setMenu(null);
            const rect = button.getBoundingClientRect();
            openMenu(folder, { x: rect.right + 4, y: rect.top });
          }}
          onContextMenu={(folder, event: MouseEvent) => openMenu(folder, { x: event.clientX, y: event.clientY })}
          onEdit={(folder, row) => openEditor(folder, row)}
          onDrop={(folder) => {
            if (dragged.current) void actions.moveGraph(dragged.current, folder.id);
          }}
        />

        <main className="library" id="library" ref={mainRef}>
          <div className="toolbar">
            <NewGraphButton onCreate={() => actions.createGraph(activeFolder?.id ?? null)} />
            <input
              id="search"
              className="search"
              type="search"
              placeholder="Search by title"
              autoComplete="off"
              spellCheck={false}
              aria-label="Search by title"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <h1 className="view-title" id="view-title">
            {name}
          </h1>

          <div className="grid" id="grid">
            {shown.map((graph) => (
              <GraphCard
                key={graph.id}
                graph={graph}
                folders={folders}
                onMove={(folderId) => void actions.moveGraph(graph, folderId)}
                onDelete={() => void actions.deleteGraph(graph)}
                onDragStart={() => {
                  dragged.current = graph;
                }}
                onDragEnd={() => {
                  dragged.current = null;
                }}
              />
            ))}
          </div>

          <p className="note" id="no-results" hidden={inViewGraphs.length === 0 || shown.length > 0}>
            No graphs match your search.
          </p>
          {view === "all" && inViewGraphs.length === 0 && (
            <EmptyState id="empty-all" icon={<ChartSpline />} title="No graphs yet">
              Click <strong>New Graph</strong> to start one.
            </EmptyState>
          )}
          {activeFolder && inViewGraphs.length === 0 && (
            <EmptyState id="empty-folder" icon={<FolderGlyph />} title="This folder is empty">
              Drag graphs onto the folder in the sidebar, or use <strong>Move to folder</strong> in a graph's menu.
            </EmptyState>
          )}
          {view === "shared" && (
            <EmptyState id="empty-shared" icon={<Users />} title="Nothing shared with you yet">
              Graphs other people share with you will show up here.
            </EmptyState>
          )}
        </main>
      </div>

      {menu && (
        <FolderMenu
          point={menu.point}
          onClose={() => setMenu(null)}
          onEdit={() => {
            const row = rowElement(menu.folder.id);
            setMenu(null);
            if (row) openEditor(menu.folder, row);
          }}
          onDelete={() => {
            setMenu(null);
            void actions.deleteFolder(menu.folder, activeFolder?.id === menu.folder.id);
          }}
        />
      )}
      {editing && (
        <FolderEditor
          key={editing.folder?.id ?? "new"}
          folder={editing.folder}
          point={editing.point}
          onClose={() => setEditing(null)}
          onSave={(changes) => {
            setEditing(null);
            void actions.saveFolder(editing.folder, changes);
          }}
        />
      )}
    </>
  );
}
