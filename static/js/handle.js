const input = document.getElementById("handle");
const status = document.getElementById("handle-status");
const message = status.querySelector("span");
const submit = document.getElementById("handle-submit");
const current = input.dataset.current;
const hint = message.textContent;
let timer = null;
let latest = 0;

function show(state, text) {
  status.dataset.state = state;
  message.textContent = text;
}

async function check() {
  const value = input.value.trim().replace(/^@/, "").toLowerCase();
  const id = ++latest;
  if (!value) {
    show("idle", hint);
    submit.disabled = true;
    return;
  }
  if (value === current) {
    show("idle", "This is your current handle.");
    submit.disabled = false;
    return;
  }
  try {
    const res = await fetch(`/handles/check?handle=${encodeURIComponent(value)}`, { headers: { "X-Requested-With": "fetch" } });
    const data = await res.json();
    if (id !== latest) return;
    show(data.available ? "ok" : "error", data.available ? `@${data.handle} is available.` : data.error);
    submit.disabled = !data.available;
  } catch {
    if (id === latest) { show("idle", hint); submit.disabled = false; }
  }
}

input.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(check, 250);
});

if (status.dataset.state !== "error") check();
