import type { IconEntry, IconSet } from "./registry";

export type IconItem = string | { label: string };

const SUGGESTED_ICONS = [
  "folder",
  "star",
  "heart",
  "bookmark",
  "flag",
  "pi",
  "sigma",
  "infinity",
  "radical",
  "square-function",
  "chart-spline",
  "chart-line",
  "chart-column",
  "chart-pie",
  "calculator",
  "ruler",
  "triangle-right",
  "shapes",
  "atom",
  "flask-conical",
  "dna",
  "microscope",
  "telescope",
  "brain",
  "magnet",
  "book",
  "book-open",
  "notebook-pen",
  "graduation-cap",
  "school",
  "pencil",
  "lightbulb",
  "globe",
  "earth",
  "rocket",
  "eighth-notes",
  "palette",
  "code",
  "gamepad-2",
  "trophy",
  "zap",
  "flame",
  "leaf",
  "sun",
  "moon",
  "cat",
  "dog",
  "coffee",
];

function iconScore(entry: IconEntry, terms: string[]) {
  let worst = 0;
  for (const term of terms) {
    let score: number;
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

export function iconItems({ entries, byName }: IconSet, query: string): IconItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    const suggested = SUGGESTED_ICONS.filter((name) => byName.has(name));
    return [{ label: "Suggested" }, ...suggested, { label: "All icons" }, ...entries.map((entry) => entry.name)];
  }
  const scored: [number, string][] = [];
  for (const entry of entries) {
    const score = iconScore(entry, terms);
    if (score !== null) scored.push([score, entry.name]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return scored.map(([, name]) => name);
}
