// Service worker: starts jobs, holds Gmail sign-in, tracks status for the popup.
// The reading list lives on the server (shared with the phone app); see lib/server.js.
import { serverApi } from "./lib/server.js";

const MAX_JOBS = 10;

chrome.runtime.onStartup.addListener(() => {
  migrateLocalList().catch(console.error);
  syncSubstackLogin().catch(console.error);
});

chrome.runtime.onInstalled.addListener(async () => {
  migrateLocalList().catch(console.error);
  syncSubstackLogin().catch(console.error);
  await chrome.contextMenus.removeAll(); // avoid duplicate-ID errors when the extension is reloaded
  chrome.contextMenus.create({ id: "send-link", title: "Send link to Kindle", contexts: ["link"] });
  chrome.contextMenus.create({ id: "send-page", title: "Send this page to Kindle", contexts: ["page"] });
  chrome.contextMenus.create({ id: "list-link", title: "Add link to reading list", contexts: ["link"] });
  chrome.contextMenus.create({ id: "list-page", title: "Add this page to reading list", contexts: ["page"] });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.menuItemId.endsWith("-link") ? info.linkUrl : info.pageUrl;
  if (info.menuItemId.startsWith("list-")) addToList([url]).catch(() => {});
  else startJob([url], "separate").catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "background") return;

  if (message.type === "start-job") {
    startJob(message.urls, message.mode).then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message }),
    );
    return true;
  }
  if (message.type === "get-token") {
    getToken(message.refresh).then(
      (token) => sendResponse({ token }),
      (error) => sendResponse({ error: error.message }),
    );
    return true;
  }
  if (message.type === "substack-tab-fetch") {
    fetchPostInTab(message.pageUrl, message.slug).then(
      (post) => sendResponse({ post }),
      (error) => sendResponse({ error: error.message }),
    );
    return true;
  }
  if (message.type === "list-add") {
    addToList(message.urls).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "list-send") {
    sendReadingList().then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error.message }),
    );
    return true;
  }
  if (message.type === "list-remove") {
    serverApi("/api/list/remove", { id: message.id }).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "list-clear") {
    serverApi("/api/list/clear", {}).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "list-sent") {
    serverApi("/api/list/sent", { sentAt: message.sentAt }).catch(console.error);
  }
  if (message.type === "item-update") {
    mutateJobs((jobs) => {
      const item = jobs.find((job) => job.id === message.jobId)?.items[message.index];
      if (item) Object.assign(item, message.patch);
      return jobs;
    });
  }
});

async function startJob(urls, mode) {
  const items = urls.map((url) => ({ url, label: url, state: "queued", detail: "" }));
  await dispatchJob(items, (jobId, kindleEmail) => ({ type: "run-job", job: { jobId, urls, mode, kindleEmail } }));
}

// Built here rather than on the server so paid posts use your browser login.
async function sendReadingList() {
  syncSubstackLogin().catch(console.error);
  const { readingList } = await serverApi("/api/state");
  const { items, lastSentAt } = readingList;
  if (!items.length) throw new Error("Reading list is empty");
  const label = `Reading list · ${items.length} article${items.length > 1 ? "s" : ""}`;
  await dispatchJob([{ url: "", label, state: "queued", detail: "" }], (jobId, kindleEmail) => ({
    type: "run-reading-list",
    job: { jobId, kindleEmail, lastSentAt, items: items.map(({ id, url, addedAt }) => ({ id, url, addedAt })) },
  }));
}

/** Record a job for the status list, then hand it to the offscreen document. */
async function dispatchJob(items, buildMessage) {
  const jobId = crypto.randomUUID();
  await mutateJobs((jobs) => [{ id: jobId, items }, ...jobs].slice(0, MAX_JOBS));
  try {
    const { kindleEmail } = await chrome.storage.sync.get("kindleEmail");
    if (!kindleEmail) throw new Error("Set your Kindle email in the popup first");
    await getToken(false); // triggers the Google consent screen on first use
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: "offscreen", ...buildMessage(jobId, kindleEmail) });
  } catch (error) {
    await mutateJobs((jobs) => {
      jobs.find((job) => job.id === jobId)?.items.forEach((item) => Object.assign(item, { state: "failed", detail: error.message }));
      return jobs;
    });
    throw error;
  }
}

async function addToList(urls) {
  syncSubstackLogin().catch(console.error);
  return serverApi("/api/list", { urls });
}

/** Earlier versions kept the reading list in Chrome; move any leftovers to the server once. */
async function migrateLocalList() {
  const { readingList } = await chrome.storage.local.get("readingList");
  if (!readingList?.items?.length) return;
  await serverApi("/api/list", { urls: readingList.items.map((item) => item.url).reverse() });
  await chrome.storage.local.remove("readingList");
}

/**
 * Give the server your Substack login so the phone can fetch paid posts too.
 * Only re-sent when the cookie changes.
 */
async function syncSubstackLogin() {
  const cookie = await chrome.cookies.get({ url: "https://substack.com", name: "substack.sid" });
  if (!cookie?.value) return;
  const { syncedSubstackSid } = await chrome.storage.local.get("syncedSubstackSid");
  if (syncedSubstackSid === cookie.value) return;
  const result = await serverApi("/api/settings", { substackSid: cookie.value });
  if (result.ok) await chrome.storage.local.set({ syncedSubstackSid: cookie.value });
}

async function getToken(refresh) {
  if (refresh) {
    const cached = await chrome.identity.getAuthToken({ interactive: false }).catch(() => null);
    if (cached?.token) await chrome.identity.removeCachedAuthToken({ token: cached.token });
  }
  const { token } = await chrome.identity.getAuthToken({ interactive: true });
  return token;
}

// Opens the post in a background tab and asks Substack's API from inside the page,
// so the request carries exactly the login you have when reading it yourself.
async function fetchPostInTab(pageUrl, slug) {
  const tab = await chrome.tabs.create({ url: pageUrl, active: false });
  try {
    await waitForTabLoad(tab.id);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (postSlug) => {
        const res = await fetch(`/api/v1/posts/${postSlug}`, { credentials: "include" });
        return res.ok ? res.json() : null;
      },
      args: [slug],
    });
    return result;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabLoad(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        done();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("Timed out loading the post"));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // The tab may have finished loading before the listener was attached.
    chrome.tabs.get(tabId).then((tab) => tab.status === "complete" && (done(), resolve()));
  });
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({ url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "Parse articles and build EPUB files" })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

// Serialize read-modify-write of stored state so concurrent updates don't clobber each other.
let storageQueue = Promise.resolve();
function mutateStorage(area, key, fallback, change) {
  const run = storageQueue.then(async () => {
    const { [key]: current = structuredClone(fallback) } = await chrome.storage[area].get(key);
    const next = change(current);
    await chrome.storage[area].set({ [key]: next });
    return next;
  });
  storageQueue = run.catch((error) => console.error(error));
  return storageQueue;
}

// Job status lives for the browser session; the reading list persists across restarts.
const mutateJobs = (change) => mutateStorage("session", "jobs", [], change).then((jobs) => jobs && updateBadge(jobs));


async function updateBadge(jobs) {
  const items = jobs.flatMap((job) => job.items);
  const active = items.filter((item) => item.state === "queued" || item.state === "working").length;
  const latest = jobs[0]?.items || [];
  if (active) {
    await chrome.action.setBadgeBackgroundColor({ color: "#555" });
    await chrome.action.setBadgeText({ text: String(active) });
  } else if (latest.some((item) => item.state === "failed")) {
    await chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
    await chrome.action.setBadgeText({ text: "!" });
  } else if (latest.length) {
    await chrome.action.setBadgeBackgroundColor({ color: "#2e7d32" });
    await chrome.action.setBadgeText({ text: "✓" });
  }
}
