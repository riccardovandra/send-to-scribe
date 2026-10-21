// All server state in one JSON file: settings, the shared reading list, recent jobs.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
const FILE = join(DATA_DIR, "state.json");
const MAX_JOBS = 15;

/**
 * @typedef {{id: string, url: string, title: string, meta: string, state: string, detail: string, addedAt: number}} ListItem
 * @typedef {{url: string, label: string, state: string, detail: string}} JobItem
 */

const DEFAULT_STATE = {
  settings: { kindleEmail: "", gmailUser: "", gmailAppPassword: "", substackSid: "", substackSidUpdatedAt: 0 },
  readingList: { items: [], lastSentAt: 0 },
  /** @type {{id: string, createdAt: number, items: JobItem[]}[]} */
  jobs: [],
};

mkdirSync(DATA_DIR, { recursive: true });

/** Live state. Mutate it, then call save(). */
export const state = load();

function load() {
  try {
    const saved = JSON.parse(readFileSync(FILE, "utf8"));
    // Jobs that were mid-flight when the server stopped will never finish.
    for (const item of (saved.jobs || []).flatMap((job) => job.items)) {
      if (item.state === "queued" || item.state === "working") Object.assign(item, { state: "failed", detail: "Server restarted, try again" });
    }
    return {
      ...structuredClone(DEFAULT_STATE),
      ...saved,
      settings: { ...DEFAULT_STATE.settings, ...saved.settings },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

/** Write state to disk atomically (temp file + rename), so a crash can't leave half a file. */
export function save() {
  const temp = `${FILE}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temp, FILE);
}

/** Start a job shown under "Recent activity"; returns its items for live updates. */
export function createJob(items) {
  const job = { id: crypto.randomUUID(), createdAt: Date.now(), items };
  state.jobs = [job, ...state.jobs].slice(0, MAX_JOBS);
  save();
  return job;
}

export function updateListItem(id, patch) {
  const item = state.readingList.items.find((entry) => entry.id === id);
  if (item) Object.assign(item, patch);
  save();
}

/** Add new links to the top of the reading list, skipping ones already in it. */
export function addListItems(urls) {
  const added = [];
  for (const url of urls) {
    if (state.readingList.items.some((item) => item.url === url)) continue;
    const item = { id: crypto.randomUUID(), url, title: url, meta: "", state: "checking", detail: "", addedAt: Date.now() };
    state.readingList.items.unshift(item);
    added.push(item);
  }
  save();
  return added;
}
