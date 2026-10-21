import { serverApi } from "./lib/server.js";

const $ = (id) => document.getElementById(id);
const LIST_POLL_MS = 2500;
const KINDLE_EMAIL = /^[^@\s]+@(free\.)?kindle\.com$/i;
// No reply at all means the background script is outdated (files changed, extension not reloaded).
const NO_REPLY = "No reply from the extension. Reload it: chrome://extensions → ↻ on Send to Scribe.";
const STATE_LABELS = { queued: "Queued", working: "Working", sent: "Sent", failed: "Failed" };

init();

async function init() {
  chrome.action.setBadgeText({ text: "" });

  const { kindleEmail = "" } = await chrome.storage.sync.get("kindleEmail");
  $("email").value = kindleEmail;
  if (!kindleEmail) $("settings").open = true;

  $("save").addEventListener("click", saveEmail);
  $("add-tab").addEventListener("click", addCurrentTab);
  $("send").addEventListener("click", send);
  $("list-send").addEventListener("click", sendList);
  $("list-clear").addEventListener("click", clearList);

  const { mode = "list" } = await chrome.storage.sync.get("mode");
  $("mode").value = mode;
  updateSendLabel();
  $("mode").addEventListener("change", () => {
    chrome.storage.sync.set({ mode: $("mode").value });
    updateSendLabel();
  });

  refreshList();

  const { jobs = [] } = await chrome.storage.session.get("jobs");
  renderJobs(jobs);
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes.jobs) renderJobs(changes.jobs.newValue || []);
  });
}

async function saveEmail() {
  const email = $("email").value.trim();
  const hint = $("email-hint");
  if (!KINDLE_EMAIL.test(email)) {
    hint.textContent = "That doesn't look like a @kindle.com address.";
    hint.className = "hint error";
    return;
  }
  await chrome.storage.sync.set({ kindleEmail: email });
  hint.textContent = "Saved.";
  hint.className = "hint";
  $("settings").open = false;
}

async function addCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("http")) return showMessage("Current tab isn't a web page.", true);
  const links = $("links");
  links.value = (links.value.trim() + "\n" + tab.url).trim();
}

async function send() {
  const urls = parseLinks($("links").value);
  if (!urls.length) return showMessage("No links found.", true);
  const mode = $("mode").value;

  $("send").disabled = true;
  const response =
    mode === "list"
      ? await chrome.runtime.sendMessage({ target: "background", type: "list-add", urls })
      : await chrome.runtime.sendMessage({ target: "background", type: "start-job", urls, mode });
  $("send").disabled = false;

  if (!response?.ok) return showMessage(response?.error || NO_REPLY, true);
  $("links").value = "";
  if (mode === "list") {
    const skipped = response.skipped ? ` (${response.skipped} already in list)` : "";
    showMessage(`Added ${response.added} to reading list${skipped}.`);
    refreshList();
  } else {
    showMessage(`Sending ${urls.length} link${urls.length > 1 ? "s" : ""}…`);
  }
}

function updateSendLabel() {
  $("send").textContent = $("mode").value === "list" ? "Add" : "Send";
}

async function sendList() {
  $("list-send").disabled = true;
  const response = await chrome.runtime.sendMessage({ target: "background", type: "list-send" });
  $("list-send").disabled = false;
  showMessage(response?.ok ? "Building your reading list…" : response?.error || NO_REPLY, !response?.ok);
}

// Two clicks to clear, so a stray click doesn't wipe the list.
let clearArmed = false;
async function clearList() {
  if (!clearArmed) {
    clearArmed = true;
    $("list-clear").textContent = "Click again to clear the whole list";
    setTimeout(() => {
      clearArmed = false;
      $("list-clear").textContent = "Clear list";
    }, 4000);
    return;
  }
  await chrome.runtime.sendMessage({ target: "background", type: "list-clear" });
  refreshList();
}

// The reading list lives on the server (shared with the phone), so poll it while the popup is open.
let listTimer = null;
async function refreshList() {
  clearTimeout(listTimer);
  try {
    const { readingList } = await serverApi("/api/state");
    renderList(readingList);
  } catch (error) {
    $("list-hint").textContent = error.message;
    $("list-hint").className = "hint error";
  }
  listTimer = setTimeout(refreshList, LIST_POLL_MS);
}

function renderList(list) {
  const items = list?.items || [];
  const lastSentAt = list?.lastSentAt || 0;
  const newCount = items.filter((item) => item.addedAt > lastSentAt).length;
  $("list-count").textContent = `Reading list (${items.length})`;
  $("list-send").disabled = !items.length;
  $("list-clear").hidden = !items.length;
  $("list-hint").textContent = items.length
    ? `${newCount} new since last send${lastSentAt ? ` (${new Date(lastSentAt).toLocaleDateString("en-GB")})` : ""}. Each send delivers the full book as a new copy; delete the old one on your Kindle.`
    : "Empty. Choose \"Add to reading list\" above, right-click a link, or share from your phone.";
  $("list-hint").className = "hint";

  $("list-items").replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      const text = document.createElement("div");
      text.className = "grow";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = item.title;
      label.title = item.url;
      const state = document.createElement("span");
      state.className = `state ${item.state === "failed" ? "failed" : ""}`;
      const flag = item.addedAt > lastSentAt ? "New" : "";
      const status = item.state === "checking" ? "Checking…" : item.state === "failed" ? `Failed · ${item.detail}` : item.meta;
      state.textContent = [flag, status].filter(Boolean).join(" · ");
      text.append(label, state);
      const remove = document.createElement("button");
      remove.className = "link remove";
      remove.textContent = "✕";
      remove.title = "Remove from reading list";
      remove.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ target: "background", type: "list-remove", id: item.id });
        refreshList();
      });
      li.append(text, remove);
      return li;
    }),
  );
}

function parseLinks(text) {
  const matches = text.match(/https?:\/\/[^\s<>"'`]+/g) || [];
  const cleaned = matches.map((url) => url.replace(/[.,;:!?)\]]+$/, ""));
  return [...new Set(cleaned)];
}

function showMessage(text, isError = false) {
  $("message").textContent = text;
  $("message").className = isError ? "hint error" : "hint";
}

function renderJobs(jobs) {
  const list = $("jobs");
  list.replaceChildren(
    ...jobs.flatMap((job) =>
      job.items.map((item) => {
        const li = document.createElement("li");
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = item.label;
        label.title = item.url;
        const state = document.createElement("span");
        state.className = `state ${item.state}`;
        state.textContent = [STATE_LABELS[item.state], item.detail].filter(Boolean).join(" · ");
        li.append(label, state);
        return li;
      }),
    ),
  );
}
