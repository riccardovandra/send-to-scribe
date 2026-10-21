// The send workflows, shared by the Chrome extension (offscreen document) and the server.
// Each takes callbacks for progress updates and for actually emailing the book.
import { fetchArticle, PaywallError } from "./extract.js";
import { buildBook, buildReadingList } from "./book.js";

/**
 * @typedef {(book: {title: string, epub: Uint8Array}) => Promise<void>} SendBook
 * @typedef {(patch: object) => void} Update
 */

/** Title + "author · site" line for showing an article in the reading list. */
export function listMeta(article) {
  const site = new URL(article.sourceUrl).hostname.replace(/^www\./, "");
  return { state: "ready", title: article.title, meta: [article.author, site].filter(Boolean).join(" · "), detail: "" };
}

/**
 * Fetch each new reading-list article once, to show its title and flag broken links early.
 * @param {{id: string, url: string}[]} items
 * @param {(id: string, patch: object) => void} listUpdate
 */
export async function checkListItems(items, listUpdate) {
  for (const { id, url } of items) {
    try {
      listUpdate(id, listMeta(await fetchArticle(url)));
    } catch (error) {
      if (error instanceof PaywallError) {
        // Still listed: the full text may be available when sent from Chrome, with your login.
        listUpdate(id, { ...listMeta(error.info), detail: "Paid: only the preview is reachable from here" });
      } else {
        listUpdate(id, { state: "failed", detail: error.message });
      }
    }
  }
}

/**
 * Send links now, as separate documents or as one bundle.
 * @param {{urls: string[], mode: "separate" | "bundle", update: (index: number, patch: object) => void, send: SendBook}} job
 */
export async function runSendJob({ urls, mode, update, send }) {
  if (mode === "bundle") {
    const articles = [];
    const fetched = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        update(i, { state: "working", detail: "Fetching" });
        const article = await fetchArticle(urls[i]);
        articles.push(article);
        fetched.push(i);
        update(i, { label: article.title, detail: "Waiting for bundle" });
      } catch (error) {
        update(i, { state: "failed", detail: error.message });
      }
    }
    if (!articles.length) return;
    try {
      fetched.forEach((i) => update(i, { detail: "Building and sending bundle" }));
      const book = await buildBook(articles);
      await send(book);
      fetched.forEach((i) => update(i, { state: "sent", detail: `In "${book.title}"` }));
    } catch (error) {
      fetched.forEach((i) => update(i, { state: "failed", detail: error.message }));
    }
    return;
  }

  for (let i = 0; i < urls.length; i++) {
    try {
      update(i, { state: "working", detail: "Fetching" });
      const article = await fetchArticle(urls[i]);
      update(i, { label: article.title, detail: "Building EPUB" });
      const book = await buildBook([article]);
      update(i, { detail: "Sending" });
      await send(book);
      update(i, { state: "sent", detail: "" });
    } catch (error) {
      update(i, { state: "failed", detail: error.message });
    }
  }
}

/**
 * Build and send the whole reading list as one book.
 * @param {{items: {id: string, url: string, addedAt: number}[], lastSentAt: number, update: Update,
 *   listUpdate: (id: string, patch: object) => void, send: SendBook}} job
 * @returns {Promise<number | null>} the time the send started (the new "last sent"), or null on failure
 */
export async function runReadingListJob({ items, lastSentAt, update, listUpdate, send }) {
  const startedAt = Date.now();
  try {
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      update({ state: "working", detail: `Fetching ${i + 1} of ${items.length}` });
      try {
        const article = await fetchArticle(items[i].url);
        entries.push({ article, addedAt: items[i].addedAt });
        listUpdate(items[i].id, listMeta(article));
      } catch (error) {
        listUpdate(items[i].id, { state: "failed", detail: error.message });
      }
    }
    if (!entries.length) throw new Error("None of the articles could be fetched");

    update({ detail: "Building book" });
    const book = await buildReadingList(entries, lastSentAt);
    update({ detail: `Sending (${(book.epub.length / 1e6).toFixed(1)} MB)` });
    await send(book);

    const skipped = items.length - entries.length;
    update({
      state: "sent",
      label: `Reading list · ${entries.length} article${entries.length > 1 ? "s" : ""}`,
      detail: skipped ? `${skipped} skipped, see list` : "",
    });
    return startedAt;
  } catch (error) {
    update({ state: "failed", detail: error.message });
    return null;
  }
}
