import {
  ChartSpline, CircleHelp, CloudCheck, CloudOff, EllipsisVertical, ExternalLink, FolderOpen, LoaderCircle, LogOut,
  Trash2, createIcons,
} from "lucide";

createIcons({
  icons: {
    ChartSpline, CircleHelp, CloudCheck, CloudOff, EllipsisVertical, ExternalLink, FolderOpen, LoaderCircle, LogOut,
    Trash2,
  },
});

function closeMenus(except) {
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
