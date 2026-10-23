const sameDay = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const sameYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const older = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

export function formatUpdated(ts: number, now = new Date()) {
  const date = new Date(ts);
  if (date.toDateString() === now.toDateString()) return sameDay.format(date);
  return (date.getFullYear() === now.getFullYear() ? sameYear : older).format(date);
}
