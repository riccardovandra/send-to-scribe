// Turns fetched articles into a single EPUB (one chapter per article).
import { toXhtml } from "./extract.js";
import { ImageStore } from "./images.js";
import { buildEpub } from "./epub.js";

/**
 * @param {import("./extract.js").Article[]} articles
 * @returns {Promise<{title: string, epub: Uint8Array}>}
 */
export async function buildBook(articles) {
  const images = new ImageStore();
  const chapters = articles.map((article) => ({ ...article, xhtml: toXhtml(article.root, article.baseUrl, images) }));
  const single = articles.length === 1 ? articles[0] : null;
  const coverPlaceholder = single?.coverUrl ? images.add(single.coverUrl) : null;

  await images.load();
  chapters.forEach((chapter) => (chapter.xhtml = images.resolve(chapter.xhtml)));

  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const title = single ? single.title : `Reading bundle · ${today}`;
  const epub = buildEpub({
    title,
    author: single ? single.author : "Various",
    language: articles[0].language,
    chapters,
    images: images.files(),
    cover: coverPlaceholder ? images.get(coverPlaceholder) : null,
  });
  return { title, epub };
}

const READING_WORDS_PER_MINUTE = 230;

/**
 * Build the single growing "Reading List" book: a contents page first, then every article,
 * newest first. Images are compacted so a long list still fits in one email.
 * @param {{article: import("./extract.js").Article, addedAt: number}[]} entries newest first
 * @param {number} lastSentAt articles added after this are flagged NEW
 * @returns {Promise<{title: string, epub: Uint8Array}>}
 */
export async function buildReadingList(entries, lastSentAt) {
  const images = new ImageStore({ compact: true });
  const chapters = entries.map(({ article }) => ({ ...article, xhtml: toXhtml(article.root, article.baseUrl, images) }));
  await images.load();
  chapters.forEach((chapter) => (chapter.xhtml = images.resolve(chapter.xhtml)));

  const shortDate = (time) => new Date(time).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const newCount = entries.filter((entry) => entry.addedAt > lastSentAt).length;
  const updated = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const title = "Reading List";
  const epub = buildEpub({
    title,
    author: "Send to Scribe",
    language: entries[0].article.language,
    chapters,
    images: images.files(),
    cover: null,
    contents: {
      heading: title,
      intro: `Updated ${updated} · ${entries.length} articles${newCount ? ` · ${newCount} new` : ""}. Tap a title to jump to it.`,
      entries: entries.map(({ article, addedAt }) => {
        const text = plainText(article.root);
        const minutes = Math.max(1, Math.round(text.split(" ").length / READING_WORDS_PER_MINUTE));
        const site = new URL(article.sourceUrl).hostname.replace(/^www\./, "");
        return {
          title: article.title,
          meta: [article.author, site, `${minutes} min`, `added ${shortDate(addedAt)}`].filter(Boolean).join(" · "),
          excerpt: article.subtitle || (text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text),
          isNew: addedAt > lastSentAt,
        };
      }),
    },
  });
  return { title, epub };
}

/** Text of an article with line breaks kept as spaces (textContent alone glues "<br>"-separated lines). */
function plainText(root) {
  const copy = root.cloneNode(true);
  copy.querySelectorAll("br").forEach((br) => br.replaceWith(" "));
  return copy.textContent.replace(/\s+/g, " ").trim();
}

/**
 * @typedef {{title: string, html: string, sourceUrl: string, depth: number}} DocChapter
 * @typedef {{url: string, mediaType: string, base64: string}} DocImage
 * @typedef {{title: string, author: string, language: string, chapters: DocChapter[], images: DocImage[]}} DocBook
 */

/**
 * A doc from UP Docs: a linked contents page, then one chapter per tab in the order given.
 * Images and diagrams UP Docs already fetched come with the book; others are downloaded here.
 * @param {DocBook} book
 * @returns {Promise<{title: string, epub: Uint8Array}>}
 */
export async function buildDocBook(book) {
  const images = new ImageStore();
  for (const image of book.images || []) {
    images.provide(image.url, new Blob([base64ToBytes(image.base64)], { type: image.mediaType }));
  }
  const parser = new DOMParser();
  const chapters = book.chapters.map((chapter) => {
    const body = parser.parseFromString(`<body>${chapter.html}</body>`, "text/html").body;
    return {
      title: chapter.title,
      subtitle: "",
      author: "",
      date: "",
      sourceUrl: chapter.sourceUrl,
      xhtml: toXhtml(body, chapter.sourceUrl, images),
    };
  });
  await images.load();
  chapters.forEach((chapter) => (chapter.xhtml = images.resolve(chapter.xhtml)));

  const sent = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const count = book.chapters.length;
  const epub = buildEpub({
    title: book.title,
    author: book.author || "UP Docs",
    language: book.language || "en",
    chapters,
    images: images.files(),
    cover: null,
    contents: {
      heading: book.title,
      intro: `${count} chapter${count > 1 ? "s" : ""} · sent ${sent}. Tap a title to jump to it.`,
      entries: book.chapters.map((chapter) => ({
        title: chapter.title,
        meta: "",
        excerpt: "",
        isNew: false,
        depth: chapter.depth || 0,
      })),
    },
  });
  return { title: book.title, epub };
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
