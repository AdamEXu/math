import {
  Atom, Book, Bookmark, Calculator, Cat, ChartLine, ChartSpline, Check, ChevronRight, CircleAlert,
  CircleCheck, CloudCheck, CloudOff, Code, Dog, EllipsisVertical, ExternalLink, Flag, Flame, FlaskConical,
  Folder, FolderInput, FolderMinus, FolderPlus, Gamepad2, Globe, GraduationCap, Heart, House, Leaf,
  Lightbulb, LoaderCircle, LogOut, Moon, Music, Palette, PanelLeftClose, PanelLeftOpen, Pencil, Pi, Rocket,
  Settings, Shapes, Sigma, SquareFunction, Star, Sun, Trash2, Users, Zap,
  createIcons,
} from "lucide";

const ICONS = {
  Atom, Book, Bookmark, Calculator, Cat, ChartLine, ChartSpline, Check, ChevronRight, CircleAlert,
  CircleCheck, CloudCheck, CloudOff, Code, Dog, EllipsisVertical, ExternalLink, Flag, Flame, FlaskConical,
  Folder, FolderInput, FolderMinus, FolderPlus, Gamepad2, Globe, GraduationCap, Heart, House, Leaf,
  Lightbulb, LoaderCircle, LogOut, Moon, Music, Palette, PanelLeftClose, PanelLeftOpen, Pencil, Pi, Rocket,
  Settings, Shapes, Sigma, SquareFunction, Star, Sun, Trash2, Users, Zap,
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
