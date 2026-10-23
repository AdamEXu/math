import { closeMenus, renderIcons } from "./ui.js";

const HEADERS = { "X-Requested-With": "fetch", "Content-Type": "application/json" };
const GRAPH_TYPE = "application/x-math-graph";
const SIDEBAR_KEY = "library.sidebar";

const root = document.documentElement;
const sidebar = document.getElementById("sidebar");
const folderList = document.getElementById("folder-list");
const rowTemplate = document.getElementById("folder-row-template");
const editor = document.getElementById("folder-editor");
const folderMenu = document.getElementById("folder-menu");
const tooltip = document.getElementById("tooltip");
const toast = document.getElementById("toast");
const search = document.getElementById("search");
const viewTitle = document.getElementById("view-title");
const noResults = document.getElementById("no-results");
const empties = {
  all: document.getElementById("empty-all"),
  folder: document.getElementById("empty-folder"),
  shared: document.getElementById("empty-shared"),
};
const cards = [...document.querySelectorAll(".card")];
const data = JSON.parse(document.getElementById("library-data").textContent);
const folders = new Map(data.folders.map((folder) => [folder.id, folder]));
let view = data.view;

const now = new Date();
const sameDay = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const sameYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const older = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

for (const el of document.querySelectorAll("time[data-ts]")) {
  const date = new Date(Number(el.dataset.ts));
  el.dateTime = date.toISOString();
  el.title = date.toLocaleString();
  el.textContent =
    date.toDateString() === now.toDateString()
      ? sameDay.format(date)
      : (date.getFullYear() === now.getFullYear() ? sameYear : older).format(date);
}

for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!confirm(form.dataset.confirm)) event.preventDefault();
  });
}

async function api(url, body) {
  const res = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  return res.json();
}

let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

const failed = (error) => {
  console.error(error);
  showToast("Couldn't save that change. Try again.");
};

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const iconMarkup = new Map(Object.entries(data.icons));
let allIcons = null;

function iconSvg(name) {
  return `${SVG_OPEN} class="lucide lucide-${name}">${iconMarkup.get(name) ?? ""}</svg>`;
}

function setIcon(slot, name) {
  slot.innerHTML = iconSvg(name);
}

function loadIcons() {
  allIcons ??= fetch(document.getElementById("icon-scroll").dataset.src)
    .then((res) => {
      if (!res.ok) throw new Error(`icons failed: ${res.status}`);
      return res.json();
    })
    .then(({ icons }) => {
      const entries = Object.entries(icons).map(([name, [markup, tags]]) => {
        iconMarkup.set(name, markup);
        return { name, tags };
      });
      return { entries, byName: new Map(entries.map((entry) => [entry.name, entry])) };
    })
    .catch((error) => {
      allIcons = null;
      throw error;
    });
  return allIcons;
}

function isCollapsed() {
  return root.classList.contains("sidebar-collapsed") || sidebar.getBoundingClientRect().width < 100;
}

function setCollapsed(collapsed, persist = true) {
  root.classList.toggle("sidebar-collapsed", collapsed);
  hideTooltip();
  if (!persist) return;
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
  } catch {}
}

document.getElementById("sidebar-toggle").addEventListener("click", () => {
  setCollapsed(!root.classList.contains("sidebar-collapsed"));
});

function showTooltip(target) {
  const always = target.hasAttribute("data-tip-always");
  if (!always && !isCollapsed()) return hideTooltip();
  tooltip.textContent = always
    ? (root.classList.contains("sidebar-collapsed") ? "Expand sidebar" : "Collapse sidebar")
    : target.dataset.tip;
  const rect = target.getBoundingClientRect();
  tooltip.style.left = `${rect.right + 8}px`;
  tooltip.style.top = `${rect.top + rect.height / 2}px`;
  tooltip.hidden = false;
}

function hideTooltip() {
  tooltip.hidden = true;
}

sidebar.addEventListener("mouseover", (event) => {
  const target = event.target.closest("[data-tip], [data-tip-always]");
  if (target) showTooltip(target);
  else hideTooltip();
});
sidebar.addEventListener("mouseleave", hideTooltip);
sidebar.addEventListener("click", hideTooltip);

function viewFromPath(path) {
  if (path === "/shared") return "shared";
  const match = path.match(/^\/folders\/([0-9a-f-]+)$/);
  return match && folders.has(match[1]) ? match[1] : "all";
}

function pathFor(target) {
  if (target === "all") return "/";
  if (target === "shared") return "/shared";
  return `/folders/${target}`;
}

function viewName(target) {
  if (target === "shared") return "Shared with you";
  return folders.get(target)?.name ?? "All Graphs";
}

function inView(card) {
  if (view === "shared") return false;
  return view === "all" || card.dataset.folder === view;
}

function applyFilter() {
  const query = search.value.trim().toLowerCase();
  let inViewCount = 0;
  let shown = 0;
  for (const card of cards) {
    const visible = inView(card);
    inViewCount += visible;
    card.hidden = !visible || !card.dataset.title.includes(query);
    shown += !card.hidden;
  }
  const isFolder = folders.has(view);
  empties.shared.hidden = view !== "shared";
  empties.all.hidden = view !== "all" || inViewCount > 0;
  empties.folder.hidden = !isFolder || inViewCount > 0;
  noResults.hidden = inViewCount === 0 || shown > 0;
}

function applyView() {
  for (const item of sidebar.querySelectorAll(".side-item[data-view]")) {
    const active = item.dataset.view === view;
    item.classList.toggle("active", active);
    item.closest(".folder-row")?.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  const name = viewName(view);
  viewTitle.textContent = name;
  document.title = `${name} - math`;
  for (const input of document.querySelectorAll('input[name="folder_id"]')) {
    input.value = folders.has(view) ? view : "";
  }
  applyFilter();
}

function navigate(target, { replace = false } = {}) {
  view = target;
  const path = pathFor(target);
  if (location.pathname !== path) history[replace ? "replaceState" : "pushState"]({}, "", path);
  applyView();
  document.getElementById("library").scrollTop = 0;
}

sidebar.addEventListener("click", (event) => {
  const item = event.target.closest("a.side-item[data-view]");
  if (!item || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  navigate(item.dataset.view);
});

addEventListener("popstate", () => {
  view = viewFromPath(location.pathname);
  applyView();
});

search.addEventListener("input", applyFilter);

function rowFor(id) {
  return folderList.querySelector(`.folder-row[data-folder-id="${CSS.escape(id)}"]`);
}

function fillRow(row, folder) {
  const link = row.querySelector(".side-item");
  row.dataset.folderId = folder.id;
  link.dataset.view = folder.id;
  link.dataset.tip = folder.name;
  link.href = pathFor(folder.id);
  link.style.setProperty("--folder-color", folder.color);
  row.querySelector(".side-label").textContent = folder.name;
  const slot = row.querySelector(".folder-icon");
  if (slot.dataset.icon !== folder.icon) {
    slot.dataset.icon = folder.icon;
    setIcon(slot, folder.icon);
  }
}

function appendRow(folder) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector(".folder-icon").dataset.icon = "";
  folderList.append(row);
  fillRow(row, folder);
}

function updateFolder(folder) {
  folders.set(folder.id, folder);
  const row = rowFor(folder.id);
  if (row) fillRow(row, folder);
  if (view === folder.id) {
    viewTitle.textContent = folder.name;
    document.title = `${folder.name} - math`;
  }
}

const DEFAULT_FOLDER = { name: "New folder", icon: "folder", color: "#737373" };
const editorName = editor.querySelector(".editor-name");
const editorSave = editor.querySelector("[data-action=save]");
const editorPreview = editor.querySelector(".editor-preview");
let editing = null;
let menuFolder = null;

function placeFloating(el, x, y) {
  el.hidden = false;
  const { width, height } = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
}

function anchorPoint(el) {
  const rect = el.getBoundingClientRect();
  return [sidebar.getBoundingClientRect().right + 8, rect.top - 8];
}

function syncEditor() {
  const { draft } = editing;
  const name = editorName.value.trim();
  editor.style.setProperty("--folder-color", draft.color);
  editorPreview.style.setProperty("--folder-color", draft.color);
  editorPreview.querySelector(".side-label").textContent = name || "Folder name";
  editorPreview.classList.toggle("placeholder-name", !name);
  const slot = editorPreview.querySelector(".folder-icon");
  if (slot.dataset.icon !== draft.icon) {
    slot.dataset.icon = draft.icon;
    setIcon(slot, draft.icon);
  }
  for (const swatch of editor.querySelectorAll(".swatch")) {
    swatch.setAttribute("aria-pressed", String(swatch.dataset.color === draft.color));
  }
  markPressedIcon();
  editorSave.disabled = !name;
}

const SUGGESTED_ICONS = [
  "folder", "star", "heart", "bookmark", "flag", "pi", "sigma", "infinity", "radical", "square-function",
  "chart-spline", "chart-line", "chart-column", "chart-pie", "calculator", "ruler", "triangle-right", "shapes",
  "atom", "flask-conical", "dna", "microscope", "telescope", "brain", "magnet", "book", "book-open",
  "notebook-pen", "graduation-cap", "school", "pencil", "lightbulb", "globe", "earth", "rocket", "eighth-notes",
  "palette", "code", "gamepad-2", "trophy", "zap", "flame", "leaf", "sun", "moon", "cat", "dog", "coffee",
];
const ICON_CHUNK = 120;
const iconScroll = document.getElementById("icon-scroll");
const iconGrid = document.getElementById("icon-grid");
const iconStatus = iconScroll.querySelector(".icon-status");
const iconSearch = editor.querySelector(".icon-search-input");
let iconQueue = [];

function markPressedIcon() {
  for (const choice of iconGrid.querySelectorAll(".icon-choice[aria-pressed=true]")) {
    choice.setAttribute("aria-pressed", "false");
  }
  const current = editing && iconGrid.querySelectorAll(`.icon-choice[data-icon="${CSS.escape(editing.draft.icon)}"]`);
  for (const choice of current ?? []) choice.setAttribute("aria-pressed", "true");
}

function iconScore(entry, terms) {
  let worst = 0;
  for (const term of terms) {
    let score;
    if (entry.name === term) score = 0;
    else if (entry.name.startsWith(term)) score = 1;
    else if (entry.name.split("-").some((part) => part.startsWith(term))) score = 2;
    else if (entry.tags.some((tag) => tag === term)) score = 3;
    else if (entry.name.includes(term)) score = 4;
    else if (entry.tags.some((tag) => tag.split(/[\s-]/).some((word) => word.startsWith(term)))) score = 5;
    else return null;
    worst = Math.max(worst, score);
  }
  return worst;
}

function iconItems({ entries, byName }, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    const suggested = SUGGESTED_ICONS.filter((name) => byName.has(name));
    return [{ label: "Suggested" }, ...suggested, { label: "All icons" }, ...entries.map((entry) => entry.name)];
  }
  const scored = [];
  for (const entry of entries) {
    const score = iconScore(entry, terms);
    if (score !== null) scored.push([score, entry.name]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return scored.map(([, name]) => name);
}

function renderIconChunk() {
  if (!iconQueue.length) return;
  const html = iconQueue.splice(0, ICON_CHUNK).map((item) => {
    if (typeof item !== "string") return `<div class="icon-section">${item.label}</div>`;
    const label = item.replaceAll("-", " ");
    return `<button class="icon-choice" type="button" role="option" data-icon="${item}" aria-label="${label}" title="${label}" aria-pressed="false">${iconSvg(item)}</button>`;
  });
  iconGrid.insertAdjacentHTML("beforeend", html.join(""));
  markPressedIcon();
}

async function renderIconGrid() {
  const query = iconSearch.value.trim();
  iconGrid.replaceChildren();
  iconScroll.scrollTop = 0;
  iconQueue = [];
  let icons;
  try {
    iconStatus.hidden = !!allIcons;
    iconStatus.textContent = "Loading icons...";
    icons = await loadIcons();
  } catch (error) {
    console.error(error);
    iconStatus.textContent = "Couldn't load icons.";
    iconStatus.hidden = false;
    return;
  }
  if (query !== iconSearch.value.trim()) return;
  iconQueue = iconItems(icons, query);
  iconStatus.textContent = "No icons match.";
  iconStatus.hidden = iconQueue.length > 0;
  renderIconChunk();
  while (iconQueue.length && iconScroll.scrollHeight <= iconScroll.clientHeight + 200) renderIconChunk();
}

new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) renderIconChunk();
}, { root: iconScroll, rootMargin: "200px" }).observe(iconScroll.querySelector(".icon-sentinel"));

iconSearch.addEventListener("input", renderIconGrid);
iconSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.preventDefault();
});

function openEditor(id, anchor) {
  closeMenus();
  closeFolderMenu();
  closeEditor();
  const folder = id ? folders.get(id) : DEFAULT_FOLDER;
  editing = { id, draft: { icon: folder.icon, color: folder.color } };
  editor.querySelector(".editor-heading").textContent = id ? "Edit folder" : "New folder";
  editorSave.textContent = id ? "Save" : "Create";
  editorName.value = folder.name;
  iconSearch.value = "";
  syncEditor();
  renderIconGrid();
  rowFor(id ?? "")?.classList.add("menu-open");
  placeFloating(editor, ...anchorPoint(anchor));
  editorName.focus();
  editorName.select();
}

function closeEditor() {
  if (!editing) return;
  if (editing.id) rowFor(editing.id)?.classList.remove("menu-open");
  editing = null;
  editor.hidden = true;
}

async function saveEditor() {
  const name = editorName.value.trim();
  if (!editing || !name) return;
  const { id, draft } = editing;
  const changes = { name, icon: draft.icon, color: draft.color };
  closeEditor();
  if (!id) {
    try {
      const folder = await api("/folders", changes);
      folders.set(folder.id, folder);
      appendRow(folder);
    } catch (error) {
      failed(error);
    }
    return;
  }
  const previous = folders.get(id);
  updateFolder({ ...previous, ...changes });
  try {
    updateFolder(await api(`/folders/${id}`, changes));
  } catch (error) {
    updateFolder(previous);
    failed(error);
  }
}

editor.addEventListener("click", (event) => {
  const swatch = event.target.closest(".swatch");
  const choice = event.target.closest(".icon-choice");
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (swatch) editing.draft.color = swatch.dataset.color;
  else if (choice) editing.draft.icon = choice.dataset.icon;
  else if (action === "save") return saveEditor();
  else if (action === "cancel") return closeEditor();
  else return;
  syncEditor();
});
editor.addEventListener("submit", (event) => {
  event.preventDefault();
  saveEditor();
});
editorName.addEventListener("input", syncEditor);

async function deleteFolder(id) {
  const folder = folders.get(id);
  if (!folder || !confirm(`Delete the folder \u201c${folder.name}\u201d? The graphs in it won't be deleted.`)) return;
  try {
    await api(`/folders/${id}/delete`);
  } catch (error) {
    return failed(error);
  }
  folders.delete(id);
  rowFor(id)?.remove();
  for (const card of cards) if (card.dataset.folder === id) card.dataset.folder = "";
  if (view === id) navigate("all", { replace: true });
  else applyFilter();
}

function openFolderMenu(id, x, y) {
  closeMenus();
  closeEditor();
  closeFolderMenu();
  menuFolder = id;
  rowFor(id)?.classList.add("menu-open");
  placeFloating(folderMenu, x, y);
}

function closeFolderMenu() {
  if (menuFolder) rowFor(menuFolder)?.classList.remove("menu-open");
  menuFolder = null;
  folderMenu.hidden = true;
}

folderMenu.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  const id = menuFolder;
  if (!action || !id) return;
  closeFolderMenu();
  if (action === "edit") openEditor(id, rowFor(id));
  if (action === "delete") deleteFolder(id);
});

document.getElementById("new-folder").addEventListener("click", (event) => {
  if (editing && !editing.id) return closeEditor();
  openEditor(null, event.currentTarget);
});

folderList.addEventListener("click", (event) => {
  const kebab = event.target.closest(".side-kebab");
  if (!kebab) return;
  event.stopPropagation();
  const id = kebab.closest(".folder-row").dataset.folderId;
  if (menuFolder === id) return closeFolderMenu();
  const rect = kebab.getBoundingClientRect();
  openFolderMenu(id, rect.right + 4, rect.top);
});

folderList.addEventListener("dblclick", (event) => {
  const row = event.target.closest(".folder-row");
  if (!row || event.target.closest(".side-kebab")) return;
  openEditor(row.dataset.folderId, row);
});

folderList.addEventListener("contextmenu", (event) => {
  const row = event.target.closest(".folder-row");
  if (!row) return;
  event.preventDefault();
  openFolderMenu(row.dataset.folderId, event.clientX, event.clientY);
});

document.addEventListener("mousedown", (event) => {
  if (!folderMenu.hidden && !folderMenu.contains(event.target) && !event.target.closest(".side-kebab")) closeFolderMenu();
  if (editing && !editor.contains(event.target) && !event.target.closest("#new-folder")) closeEditor();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeFolderMenu();
  closeEditor();
  closeSubmenus();
});
addEventListener("resize", () => {
  closeFolderMenu();
  closeEditor();
});

async function moveGraph(card, folderId) {
  const previous = card.dataset.folder;
  if (previous === (folderId ?? "")) return;
  card.dataset.folder = folderId ?? "";
  applyFilter();
  try {
    await api(`/graphs/${card.dataset.id}/folder`, { folder_id: folderId });
  } catch (error) {
    card.dataset.folder = previous;
    applyFilter();
    return failed(error);
  }
  showToast(folderId ? `Moved to ${folders.get(folderId)?.name ?? "folder"}` : "Removed from folder");
}

function menuButton(label, iconSlot, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu-item";
  button.setAttribute("role", "menuitem");
  const text = Object.assign(document.createElement("span"), { className: "menu-label", textContent: label });
  button.append(iconSlot, text);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    closeMenus();
    closeSubmenus();
    onClick();
  });
  return button;
}

function iconSlot(name, color) {
  const slot = document.createElement("span");
  slot.className = "folder-icon";
  if (color) {
    slot.style.setProperty("--folder-color", color);
    setIcon(slot, name);
  } else {
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", name);
    slot.append(icon);
  }
  return slot;
}

function buildSubmenu(submenu, card) {
  const current = card.dataset.folder;
  submenu.replaceChildren();
  for (const folder of folders.values()) {
    const button = menuButton(folder.name, iconSlot(folder.icon, folder.color), () => moveGraph(card, folder.id));
    if (folder.id === current) {
      const check = document.createElement("i");
      check.setAttribute("data-lucide", "check");
      check.className = "menu-check";
      button.append(check);
    }
    submenu.append(button);
  }
  if (!folders.size) {
    submenu.append(Object.assign(document.createElement("div"), { className: "menu-empty", textContent: "No folders yet" }));
  }
  if (current) {
    submenu.append(Object.assign(document.createElement("div"), { className: "menu-sep" }));
    submenu.append(menuButton("Remove from folder", iconSlot("folder-minus"), () => moveGraph(card, null)));
  }
  renderIcons();
}

function openSubmenu(host) {
  const button = host.querySelector(".submenu-button");
  const submenu = host.querySelector(".submenu");
  if (button.getAttribute("aria-expanded") === "true") return;
  closeSubmenus();
  buildSubmenu(submenu, host.closest(".card"));
  submenu.classList.remove("open-left");
  submenu.hidden = false;
  button.setAttribute("aria-expanded", "true");
  if (submenu.getBoundingClientRect().right > innerWidth - 8) submenu.classList.add("open-left");
}

function closeSubmenus() {
  for (const button of document.querySelectorAll('.submenu-button[aria-expanded="true"]')) {
    button.setAttribute("aria-expanded", "false");
    button.nextElementSibling.hidden = true;
  }
}

for (const host of document.querySelectorAll(".submenu-host")) {
  host.addEventListener("mouseenter", () => openSubmenu(host));
  host.addEventListener("mouseleave", closeSubmenus);
  host.querySelector(".submenu-button").addEventListener("click", (event) => {
    event.stopPropagation();
    openSubmenu(host);
  });
}

for (const kebab of document.querySelectorAll(".card .kebab")) {
  kebab.addEventListener("click", closeSubmenus);
}
document.addEventListener("click", closeSubmenus);

let draggedCard = null;

for (const card of cards) {
  card.addEventListener("dragstart", (event) => {
    draggedCard = card;
    closeMenus();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(GRAPH_TYPE, card.dataset.id);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    draggedCard = null;
    for (const row of folderList.querySelectorAll(".drop-target")) row.classList.remove("drop-target");
  });
}

folderList.addEventListener("dragover", (event) => {
  const row = event.target.closest(".folder-row");
  if (!row || !event.dataTransfer.types.includes(GRAPH_TYPE)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  row.classList.add("drop-target");
});

folderList.addEventListener("dragleave", (event) => {
  const row = event.target.closest(".folder-row");
  if (row && !row.contains(event.relatedTarget)) row.classList.remove("drop-target");
});

folderList.addEventListener("drop", (event) => {
  const row = event.target.closest(".folder-row");
  if (!row || !draggedCard) return;
  event.preventDefault();
  row.classList.remove("drop-target");
  moveGraph(draggedCard, row.dataset.folderId);
});

applyView();
