import {
  ChartSpline, Check, ChevronRight, CircleAlert, CircleCheck, CloudCheck, CloudOff, EllipsisVertical, ExternalLink, Folder,
  FolderInput, FolderMinus, FolderPlus, House, LoaderCircle, LogOut, PanelLeftClose, PanelLeftOpen, Pencil, Search,
  Settings, Trash2, Users,
  createIcons,
} from "lucide";

const ICONS = {
  ChartSpline, Check, ChevronRight, CircleAlert, CircleCheck, CloudCheck, CloudOff, EllipsisVertical, ExternalLink, Folder,
  FolderInput, FolderMinus, FolderPlus, House, LoaderCircle, LogOut, PanelLeftClose, PanelLeftOpen, Pencil, Search,
  Settings, Trash2, Users,
};

export function renderIcons() {
  createIcons({ icons: ICONS });
}

renderIcons();

export function closeMenus(except) {
  for (const button of document.querySelectorAll('.dropdown > [aria-expanded="true"]')) {
    if (button === except) continue;
    button.setAttribute("aria-expanded", "false");
    button.parentElement.querySelector(".menu").hidden = true;
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest(".dropdown > [aria-haspopup]");
  closeMenus(button);
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  button.parentElement.querySelector(".menu").hidden = !open;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});
