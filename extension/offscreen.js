// Hidden page that does the heavy lifting: fetch, clean, build EPUB, send.
// Lives in an offscreen document because service workers have no DOMParser.
import { runSendJob, runReadingListJob, runBookJob } from "./lib/jobs.js";
import { sendEpub, AuthError } from "./lib/gmail.js";

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen") return;
  if (message.type === "run-job") runJob(message.job);
  if (message.type === "run-reading-list") runReadingList(message.job);
  if (message.type === "run-book") runBook(message.job);
});

const toBackground = (message) => chrome.runtime.sendMessage({ target: "background", ...message }).catch(() => {});

function runJob({ jobId, urls, mode, kindleEmail }) {
  return runSendJob({
    urls,
    mode,
    update: (index, patch) => toBackground({ type: "item-update", jobId, index, patch }),
    send: (book) => send(kindleEmail, book),
  });
}

async function runReadingList({ jobId, kindleEmail, lastSentAt, items }) {
  const sentAt = await runReadingListJob({
    items,
    lastSentAt,
    update: (patch) => toBackground({ type: "item-update", jobId, index: 0, patch }),
    listUpdate: () => {}, // the server tracks each article's status
    send: (book) => send(kindleEmail, book),
  });
  if (sentAt) toBackground({ type: "list-sent", sentAt });
}

async function runBook({ jobId, kindleEmail, book }) {
  const error = await runBookJob({
    book,
    update: (patch) => toBackground({ type: "item-update", jobId, index: 0, patch }),
    send: (built) => send(kindleEmail, built),
  });
  toBackground({ type: "book-done", jobId, error });
}

async function send(kindleEmail, { title, epub }) {
  for (const refresh of [false, true]) {
    const { token, error } = await chrome.runtime.sendMessage({ target: "background", type: "get-token", refresh });
    if (!token) throw new Error(error || "Could not sign in to Gmail");
    try {
      return await sendEpub({ token, to: kindleEmail, title, epub });
    } catch (err) {
      if (!(err instanceof AuthError) || refresh) throw err;
    }
  }
}
