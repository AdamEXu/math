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

const search = document.getElementById("search");
const cards = [...document.querySelectorAll(".card")];
const noResults = document.getElementById("no-results");

search?.addEventListener("input", () => {
  const query = search.value.trim().toLowerCase();
  let shown = 0;
  for (const card of cards) {
    card.hidden = !card.dataset.title.includes(query);
    shown += !card.hidden;
  }
  noResults.hidden = shown > 0;
});

for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (event) => {
    if (!confirm(form.dataset.confirm)) event.preventDefault();
  });
}
