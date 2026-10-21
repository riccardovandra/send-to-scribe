// Phone web app: same reading list as the Chrome extension, served by the VPS.
const $ = (id) => document.getElementById(id);
const STATE_LABELS = { queued: "Queued", working: "Working", sent: "Sent", failed: "Failed" };
const POLL_MS = 3000;

let pollTimer = null;

init();

async function init() {
  const msg = new URLSearchParams(location.search).get("msg");
  if (msg) {
    $("notice").textContent = msg;
    $("notice").hidden = false;
    history.replaceState(null, "", "/");
  }

  $("login-btn").addEventListener("click", login);
  $("paste").addEventListener("click", pasteFromClipboard);
  $("add").addEventListener("click", () => submitLinks("/api/list"));
  $("send-now").addEventListener("click", () => submitLinks("/api/send"));
  $("list-send").addEventListener("click", sendList);
  $("list-clear").addEventListener("click", clearList);
  $("save-settings").addEventListener("click", saveSettings);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());

  await refresh();
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== "/api/login") {
    showLogin();
    throw new Error("Not logged in");
  }
  return res.json();
}

async function refresh() {
  clearTimeout(pollTimer);
  try {
    const data = await api("/api/state");
    $("login").hidden = true;
    $("app").hidden = false;
    render(data);
  } catch {
    return;
  }
  if (document.visibilityState === "visible") pollTimer = setTimeout(refresh, POLL_MS);
}

function showLogin() {
  $("app").hidden = true;
  $("login").hidden = false;
}

async function login() {
  // Accept the whole login link as well as the bare token.
  const value = $("token").value.trim();
  const token = value.includes("token=") ? new URL(value).searchParams.get("token") : value;
  const response = await api("/api/login", { token });
  if (!response.ok) return ($("login-msg").textContent = response.error);
  $("token").value = "";
  refresh();
}

async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    $("links").value = ($("links").value.trim() + "\n" + text).trim();
  } catch {
    showMessage("Couldn't read the clipboard. Long-press the box and choose Paste.", true);
  }
}

async function submitLinks(path) {
  const urls = $("links").value;
  if (!/https?:\/\//.test(urls)) return showMessage("No links found.", true);
  const response = await api(path, { urls });
  if (!response.ok) return showMessage(response.error || "Something went wrong.", true);
  $("links").value = "";
  if (path === "/api/list") {
    const skipped = response.skipped ? ` (${response.skipped} already in list)` : "";
    showMessage(`Added ${response.added} to reading list${skipped}.`);
  } else {
    showMessage("Sending to your Kindle…");
  }
  refresh();
}

async function sendList() {
  const response = await api("/api/list/send", {});
  showMessage(response.ok ? "Building your reading list…" : response.error, !response.ok);
  refresh();
}

// Two taps to clear, so a stray tap doesn't wipe the list.
let clearArmed = false;
async function clearList() {
  if (!clearArmed) {
    clearArmed = true;
    $("list-clear").textContent = "Tap again to clear the whole list";
    setTimeout(() => {
      clearArmed = false;
      $("list-clear").textContent = "Clear list";
    }, 4000);
    return;
  }
  await api("/api/list/clear", {});
  refresh();
}

async function saveSettings() {
  const body = {
    kindleEmail: $("kindle-email").value,
    gmailUser: $("gmail-user").value,
    gmailAppPassword: $("gmail-pass").value,
    substackSid: $("substack-sid").value,
  };
  const response = await api("/api/settings", body);
  $("settings-msg").textContent = response.ok ? "Saved." : response.error;
  $("settings-msg").className = response.ok ? "hint" : "hint error";
  if (response.ok) {
    $("gmail-pass").value = "";
    $("substack-sid").value = "";
    refresh();
  }
}

function showMessage(text, isError = false) {
  $("message").textContent = text;
  $("message").className = isError ? "hint error" : "hint";
}

function render({ readingList, jobs, settings }) {
  const focused = document.activeElement?.id;
  if (focused !== "kindle-email") $("kindle-email").value = settings.kindleEmail;
  if (focused !== "gmail-user") $("gmail-user").value = settings.gmailUser;
  $("gmail-pass").placeholder = settings.hasAppPassword ? "Saved (type to replace)" : "16-letter app password";
  $("substack-status").textContent = settings.hasSubstackLogin
    ? `Connected${settings.substackSidUpdatedAt ? `, updated ${new Date(settings.substackSidUpdatedAt).toLocaleDateString("en-GB")}` : ""}. Synced from Chrome automatically.`
    : "Not connected yet. Use the Chrome extension once and it syncs automatically.";
  if (!settings.kindleEmail || !settings.gmailUser || !settings.hasAppPassword) $("settings").open = true;

  renderList(readingList);
  renderJobs(jobs);
}

function renderList({ items, lastSentAt }) {
  const newCount = items.filter((item) => item.addedAt > lastSentAt).length;
  $("list-count").textContent = `Reading list (${items.length})`;
  $("list-send").disabled = !items.length;
  $("list-clear").hidden = !items.length;
  $("list-hint").textContent = items.length
    ? `${newCount} new since last send. Each send delivers the full book as a new copy; delete the old one on your Kindle.`
    : "Empty. Share an article to the Send to Scribe shortcut, or paste a link above.";

  $("list-items").replaceChildren(
    ...items.map((item) => {
      const flag = item.addedAt > lastSentAt ? "New" : "";
      const status = item.state === "checking" ? "Checking…" : item.state === "failed" ? `Failed · ${item.detail}` : [item.meta, item.detail].filter(Boolean).join(" · ");
      const remove = document.createElement("button");
      remove.className = "link";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", "Remove");
      remove.addEventListener("click", async () => {
        await api("/api/list/remove", { id: item.id });
        refresh();
      });
      return listRow(item.title, [flag, status].filter(Boolean).join(" · "), item.state === "failed" ? "failed" : "", remove);
    }),
  );
}

function renderJobs(jobs) {
  $("jobs").replaceChildren(
    ...jobs.flatMap((job) =>
      job.items.map((item) => listRow(item.label, [STATE_LABELS[item.state], item.detail].filter(Boolean).join(" · "), item.state)),
    ),
  );
}

function listRow(title, status, stateClass, action) {
  const li = document.createElement("li");
  const text = document.createElement("div");
  text.className = "grow";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = title;
  const state = document.createElement("span");
  state.className = `state ${stateClass}`;
  state.textContent = status;
  text.append(label, state);
  li.append(text);
  if (action) li.append(action);
  return li;
}
