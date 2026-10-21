// Turns a URL into a clean article. Runs in the offscreen document (needs DOMParser).
import { escapeXml } from "./xml.js";

// Substack embeds (subscribe boxes, buttons, video placeholders) that add noise on Kindle.
const JUNK_SELECTORS = [
  '[class*="subscription-widget"]',
  '[data-component-name*="Subscribe"]',
  '[data-component-name="VideoPlaceholder"]',
  ".image-link-expand",
  ".button-wrapper",
  ".captioned-button-wrap",
  ".share-dialog",
  ".post-ufi",
  ".digest-post-embed",
  ".embedded-post-wrap",
].join(",");

const DROP_TAGS = new Set([
  "script", "style", "noscript", "iframe", "svg", "button", "form", "input", "select",
  "textarea", "video", "audio", "object", "embed", "canvas", "template", "source",
  "nav", "header", "footer", "aside",
]);

const KEEP_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "pre", "code",
  "em", "strong", "b", "i", "u", "s", "sub", "sup", "br", "hr", "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a", "dl", "dt", "dd", "cite", "q",
  "mark", "small", "abbr", "del", "ins", "kbd", "samp", "var",
]);

const VOID_TAGS = new Set(["br", "hr"]);
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * @typedef {{title: string, subtitle: string, author: string, date: string, sourceUrl: string,
 *   language: string, coverUrl: string, root: Element, baseUrl: string}} Article
 */

/**
 * Fetch a URL and return a normalized article. Uses Substack's post API when the URL
 * looks like a Substack post, otherwise falls back to generic page extraction.
 * @param {string} rawUrl
 * @returns {Promise<Article>}
 */
export async function fetchArticle(rawUrl) {
  const url = await resolveSubstackAppLink(rawUrl);
  const substack = substackPost(url);
  if (substack) {
    const article = await fetchSubstackPost(substack, url);
    if (article) return article;
  }
  return fetchGenericPage(url);
}

/**
 * Substack's app and inbox links use a numeric post ID instead of the post's web address
 * (substack.com/inbox/post/123, /home/post/p-123, /@author/p-123). Swap them for the
 * post's real web address so the normal Substack path, including paid posts, handles them.
 */
async function resolveSubstackAppLink(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname !== "substack.com" && url.hostname !== "www.substack.com") return rawUrl;
  const id = url.pathname.match(/\/(?:post\/(?:p-)?|p-)(\d+)/)?.[1];
  const data = id ? await fetchJson(`https://substack.com/api/v1/posts/by-id/${id}`) : null;
  if (data?.post?.canonical_url) return data.post.canonical_url;
  throw new Error("Unsupported Substack app link. Open the post and send its web address instead.");
}

function substackPost(rawUrl) {
  const url = new URL(rawUrl);
  const openLink = url.hostname === "open.substack.com" && url.pathname.match(/^\/pub\/([^/]+)\/p\/([^/]+)/);
  if (openLink) return { origin: `https://${openLink[1]}.substack.com`, slug: openLink[2] };
  // Matches *.substack.com and custom domains; non-Substack sites just 404 and fall through.
  const post = url.pathname.match(/^\/p\/([^/]+)/);
  if (post) return { origin: url.origin, slug: post[1] };
  return null;
}

/** Thrown when only a paid post's preview is available. `info` still carries its title and author. */
export class PaywallError extends Error {
  constructor(message, info) {
    super(message);
    this.info = info;
  }
}

/**
 * How to retry a paid post when only the preview came back. The extension opens the post in a
 * background tab (your browser login); the server swaps in a version that uses your Substack cookie.
 * @param {(request: {pageUrl: string, origin: string, slug: string, post: object}) => Promise<object | null>} fallback
 */
export function setPaidPostFallback(fallback) {
  paidPostFallback = fallback;
}

let paidPostFallback = async ({ pageUrl, slug }) => {
  const { post } = await chrome.runtime.sendMessage({ target: "background", type: "substack-tab-fetch", pageUrl, slug });
  return post;
};

async function fetchSubstackPost({ origin, slug }, originalUrl) {
  let post = await fetchJson(`${origin}/api/v1/posts/${slug}`);
  if (!post?.title) return null;

  // Paid post but we only got the preview: retry with your login (see setPaidPostFallback).
  if (isPreview(post)) {
    const retry = await paidPostFallback({ pageUrl: originalUrl, origin, slug, post }).catch((error) => {
      console.warn("Paid post retry failed:", error);
      return null;
    });
    if (retry?.title) post = retry;
  }
  if (isPreview(post)) {
    throw new PaywallError(
      `Paid post, only the preview is available. Log in to ${new URL(origin).hostname} with a paid subscription.`,
      { title: post.title, author: (post.publishedBylines || []).map((b) => b.name).join(", "), sourceUrl: post.canonical_url || originalUrl },
    );
  }

  const doc = new DOMParser().parseFromString(post.body_html, "text/html");
  doc.querySelectorAll(JUNK_SELECTORS).forEach((el) => el.remove());
  const sourceUrl = post.canonical_url || originalUrl;
  return {
    title: post.title,
    subtitle: post.subtitle || "",
    author: (post.publishedBylines || []).map((b) => b.name).filter(Boolean).join(", "),
    date: formatDate(post.post_date),
    sourceUrl,
    language: post.language || "en",
    coverUrl: post.cover_image || "",
    root: doc.body,
    baseUrl: sourceUrl,
  };
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Substack doesn't flag previews explicitly, but it reports the full post's word count.
 * A paid post whose body is much shorter than that is a preview.
 */
export function isPreview(post) {
  if (!post.body_html) return true;
  if (post.audience === "everyone" || !post.wordcount) return false;
  const text = new DOMParser().parseFromString(post.body_html, "text/html").body.textContent;
  return text.split(/\s+/).filter(Boolean).length < post.wordcount * 0.85;
}

async function fetchGenericPage(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Page returned HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  if (!type.includes("html")) throw new Error(`Not a web page (${type || "unknown type"})`);

  const pageUrl = res.url || url;
  const doc = new DOMParser().parseFromString(await res.text(), "text/html");
  // Without a <base>, relative links would resolve against the extension's own URL.
  const base = doc.createElement("base");
  base.href = pageUrl;
  doc.head.prepend(base);

  const meta = (selector) => doc.querySelector(selector)?.getAttribute("content")?.trim() || "";
  const metaTitle = meta('meta[property="og:title"]');
  let author = meta('meta[name="author"]') || meta('meta[property="article:author"]');
  if (/^https?:/.test(author)) author = "";
  const date = meta('meta[property="article:published_time"]');
  const language = (doc.documentElement.getAttribute("lang") || "en").split("-")[0];

  // Mozilla Readability (Firefox reader view), a global set by offscreen.html (extension) or index.js (server).
  // It mutates the document it's given, so hand it a copy and keep the original for the fallback.
  const readable = new Readability(doc.cloneNode(true)).parse();
  let root;
  const title = metaTitle || readable?.title || doc.querySelector("h1")?.textContent.trim() || doc.title.trim() || url;
  if (readable?.content && readable.textContent.trim().length > 200) {
    root = new DOMParser().parseFromString(readable.content, "text/html").body;
    author ||= (readable.byline || "").replace(/^by\s+/i, "").trim();
  } else {
    doc.querySelectorAll([...DROP_TAGS].join(",") + "," + JUNK_SELECTORS).forEach((el) => el.remove());
    root = pickContentRoot(doc);
  }
  const firstHeading = root.querySelector("h1");
  if (firstHeading && firstHeading.textContent.trim() === title) firstHeading.remove();

  return {
    title,
    subtitle: "",
    author,
    date: formatDate(date || readable?.publishedTime),
    sourceUrl: pageUrl,
    language: readable?.lang?.split("-")[0] || language,
    coverUrl: "",
    root,
    baseUrl: pageUrl,
  };
}

/** Pick the element most likely to hold the article body. */
function pickContentRoot(doc) {
  const selectors = [
    ".available-content .body",
    '[itemprop="articleBody"]',
    ".entry-content",
    ".post-content",
    ".article-body",
    "article",
    "main",
    '[role="main"]',
  ];
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el && el.textContent.trim().length > 500) return el;
  }
  // Fallback: the element containing the most paragraph text.
  const scores = new Map();
  for (const p of doc.querySelectorAll("p")) {
    const parent = p.parentElement;
    if (parent) scores.set(parent, (scores.get(parent) || 0) + p.textContent.length);
  }
  let best = doc.body;
  let bestScore = 0;
  for (const [el, score] of scores) {
    if (score > bestScore) [best, bestScore] = [el, score];
  }
  return best;
}

/**
 * Serialize an article's DOM into clean, well-formed XHTML. Images are registered
 * with the image store and emitted as placeholders, resolved after download.
 * @param {Element} root
 * @param {string} baseUrl
 * @param {{add: (url: string) => string}} images
 * @returns {string}
 */
export function toXhtml(root, baseUrl, images) {
  const ids = new Set();
  const out = [];

  const walk = (node) => {
    if (node.nodeType === TEXT_NODE) {
      out.push(escapeXml(node.nodeValue));
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const tag = node.localName;
    if (DROP_TAGS.has(tag) || node.matches(JUNK_SELECTORS)) return;

    if (tag === "img") {
      const src = imageSource(node, baseUrl);
      if (src) out.push(`<img src="${images.add(src)}" alt="${escapeXml(node.getAttribute("alt") || "")}"/>`);
      return;
    }

    const attrs = [];
    if (tag === "a") {
      const href = linkHref(node.getAttribute("href"), baseUrl);
      if (!href) {
        node.childNodes.forEach(walk);
        return;
      }
      attrs.push(`href="${escapeXml(href)}"`);
    }
    if (!KEEP_TAGS.has(tag)) {
      node.childNodes.forEach(walk);
      return;
    }
    const id = node.getAttribute("id");
    if (id && /^[A-Za-z][\w.-]*$/.test(id) && !ids.has(id)) {
      ids.add(id);
      attrs.push(`id="${id}"`);
    }
    for (const name of ["colspan", "rowspan"]) {
      const value = node.getAttribute(name);
      if (value && /^\d+$/.test(value)) attrs.push(`${name}="${value}"`);
    }

    const open = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}`;
    if (VOID_TAGS.has(tag)) {
      out.push(`${open}/>`);
      return;
    }
    out.push(`${open}>`);
    node.childNodes.forEach(walk);
    out.push(`</${tag}>`);
  };

  root.childNodes.forEach(walk);
  return out.join("");
}

function imageSource(img, baseUrl) {
  const srcsetFirst = (img.getAttribute("srcset") || "").trim().split(/\s+/)[0];
  const candidates = [img.getAttribute("data-src"), img.getAttribute("data-lazy-src"), img.getAttribute("src"), srcsetFirst];
  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith("data:")) continue;
    try {
      const url = new URL(candidate, baseUrl);
      if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    } catch {
      // ignore malformed URLs
    }
  }
  return null;
}

function linkHref(href, baseUrl) {
  if (!href) return null;
  if (href.startsWith("#")) return href;
  try {
    const url = new URL(href, baseUrl);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return isNaN(date) ? "" : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
