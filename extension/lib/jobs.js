// The send workflows, shared by the Chrome extension (offscreen document) and the server.
// Each takes callbacks for progress updates and for actually emailing the book.
import { fetchArticle, isPdf, PaywallError } from "./extract.js";
import { buildBook, buildReadingList, buildDocBook } from "./book.js";

/**
 * @typedef {(book: import("./gmail.js").Book) => Promise<void>} SendBook
 * @typedef {(patch: object) => void} Update
 */

/** Title + "author · site" line for showing an article in the reading list. */
export function listMeta(article) {
  const site = new URL(article.sourceUrl).hostname.replace(/^www\./, "");
  const meta = [article.author, site, isPdf(article) && "PDF, sent on its own"].filter(Boolean).join(" · ");
  return { state: "ready", title: article.title, meta, detail: "" };
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
        if (isPdf(article)) {
          // A PDF can't go inside the bundle, so it is emailed on its own.
          update(i, { label: article.title, detail: "Sending PDF separately" });
          await send({ title: article.title, pdf: article.pdf });
          update(i, { state: "sent", detail: "PDF, sent separately" });
          continue;
        }
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
      if (isPdf(article)) {
        update(i, { label: article.title, detail: "Sending PDF" });
        await send({ title: article.title, pdf: article.pdf });
        update(i, { state: "sent", detail: "PDF" });
        continue;
      }
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
    // PDFs can't go inside the book: each is emailed on its own, once (only if added since the last send).
    const pdfs = [];
    let oldPdfs = 0;
    for (let i = 0; i < items.length; i++) {
      update({ state: "working", detail: `Fetching ${i + 1} of ${items.length}` });
      try {
        const article = await fetchArticle(items[i].url);
        listUpdate(items[i].id, listMeta(article));
        if (!isPdf(article)) entries.push({ article, addedAt: items[i].addedAt });
        else if (items[i].addedAt > (lastSentAt || 0)) pdfs.push({ id: items[i].id, article });
        else oldPdfs++;
      } catch (error) {
        listUpdate(items[i].id, { state: "failed", detail: error.message });
      }
    }
    if (!entries.length && !pdfs.length) {
      throw new Error(oldPdfs ? "Nothing new: the PDFs in the list were already sent" : "None of the articles could be fetched");
    }

    if (entries.length) {
      update({ detail: "Building book" });
      const book = await buildReadingList(entries, lastSentAt);
      update({ detail: `Sending (${(book.epub.length / 1e6).toFixed(1)} MB)` });
      await send(book);
    }
    let pdfsSent = 0;
    for (const { id, article } of pdfs) {
      update({ detail: `Sending PDF ${pdfsSent + 1} of ${pdfs.length}` });
      try {
        await send({ title: article.title, pdf: article.pdf });
        pdfsSent++;
      } catch (error) {
        listUpdate(id, { state: "failed", detail: error.message });
      }
    }
    if (!entries.length && !pdfsSent) throw new Error("The PDFs could not be sent, see list");

    const skipped = items.length - entries.length - pdfsSent - oldPdfs;
    const parts = [
      entries.length && `${entries.length} article${entries.length > 1 ? "s" : ""}`,
      pdfsSent && `${pdfsSent} PDF${pdfsSent > 1 ? "s" : ""} sent separately`,
    ].filter(Boolean);
    update({
      state: "sent",
      label: `Reading list · ${parts.join(" + ")}`,
      detail: skipped ? `${skipped} skipped, see list` : "",
    });
    return startedAt;
  } catch (error) {
    update({ state: "failed", detail: error.message });
    return null;
  }
}

/**
 * Build and send a doc from UP Docs as one book.
 * @param {{book: import("./book.js").DocBook, update: Update, send: SendBook}} job
 * @returns {Promise<string | null>} null when sent, otherwise why it failed
 */
export async function runBookJob({ book, update, send }) {
  try {
    update({ state: "working", detail: "Building EPUB" });
    const built = await buildDocBook(book);
    update({ detail: `Sending (${(built.epub.length / 1e6).toFixed(1)} MB)` });
    await send(built);
    update({ state: "sent", detail: `${book.chapters.length} chapter${book.chapters.length > 1 ? "s" : ""}` });
    return null;
  } catch (error) {
    update({ state: "failed", detail: error.message });
    return error.message;
  }
}
