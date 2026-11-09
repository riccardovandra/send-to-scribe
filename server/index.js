// Send to Scribe server: the phone web app + the shared reading list for the Chrome extension.
// Runs the same article pipeline as the extension (extension/lib), with server stand-ins for browser APIs.
// No login: the container listens on 127.0.0.1 only and `tailscale serve` forwards port 443 from your tailnet.
import { join } from "node:path";
import { FragmentSafeDOMParser } from "./dom.js";
import nodemailer from "nodemailer";
import Readability from "../extension/lib/vendor/Readability.js";
import { setPaidPostFallback } from "../extension/lib/extract.js";
import { setJpegConverter } from "../extension/lib/images.js";
import { attachmentFor } from "../extension/lib/gmail.js";
import { checkListItems, runReadingListJob, runSendJob } from "../extension/lib/jobs.js";
import { ffmpegToJpeg } from "./convert.js";
import { addListItems, createJob, save, state, updateListItem } from "./store.js";

// Browser APIs the shared code expects.
globalThis.DOMParser = FragmentSafeDOMParser;
globalThis.Readability = Readability;
setJpegConverter(ffmpegToJpeg);
setPaidPostFallback(fetchPaidPostWithCookie);

const PORT = Number(process.env.PORT || 3000);
// HTTPS with the scribe.upliftedconsulting.com certificate (issued by lego, mounted at /certs).
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const PUBLIC_DIR = join(import.meta.dir, "public");
const KINDLE_EMAIL = /^[^@\s]+@(free\.)?kindle\.com$/i;


/** Paid Substack posts: retry with your Substack login cookie (synced from Chrome or pasted in Settings). */
async function fetchPaidPostWithCookie({ origin, slug, post }) {
  const sid = state.settings.substackSid;
  if (!sid) return null;
  const headers = { Cookie: `substack.sid=${sid}` };
  const urls = [`https://substack.com/api/v1/posts/by-id/${post.id}`];
  if (new URL(origin).hostname.endsWith(".substack.com")) urls.unshift(`${origin}/api/v1/posts/${slug}`);
  for (const url of urls) {
    const res = await fetch(url, { headers }).catch(() => null);
    if (!res?.ok) continue;
    const data = await res.json().catch(() => null);
    const full = data?.post || data;
    if (full?.body_html) return full;
  }
  return null;
}

async function sendBook(book) {
  const { kindleEmail, gmailUser, gmailAppPassword } = state.settings;
  if (!kindleEmail || !gmailUser || !gmailAppPassword) throw new Error("Finish Settings first (Kindle email, Gmail, app password)");
  const { filename, contentType, bytes } = attachmentFor(book);
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: gmailUser, pass: gmailAppPassword.replace(/\s+/g, "") },
  });
  await transport.sendMail({
    from: gmailUser,
    to: kindleEmail,
    subject: book.title,
    text: "Sent by Send to Scribe.",
    attachments: [{ filename, content: Buffer.from(bytes), contentType }],
  });
}

// ---- Actions -------------------------------------------------------------------------------

function addToList(urls) {
  const added = addListItems(urls);
  checkListItems(added, updateListItem).catch(console.error);
  return { ok: true, added: added.length, skipped: urls.length - added.length };
}

function sendNow(urls, mode) {
  const job = createJob(urls.map((url) => ({ url, label: url, state: "queued", detail: "" })));
  runSendJob({
    urls,
    mode,
    update: (index, patch) => (Object.assign(job.items[index], patch), save()),
    send: sendBook,
  }).catch(console.error);
  return { ok: true };
}

function sendReadingList() {
  const { items, lastSentAt } = state.readingList;
  if (!items.length) return { ok: false, error: "Reading list is empty" };
  const job = createJob([{ url: "", label: `Reading list · ${items.length} articles`, state: "queued", detail: "" }]);
  runReadingListJob({
    items: items.map(({ id, url, addedAt }) => ({ id, url, addedAt })),
    lastSentAt,
    update: (patch) => (Object.assign(job.items[0], patch), save()),
    listUpdate: updateListItem,
    send: sendBook,
  })
    .then((sentAt) => sentAt && ((state.readingList.lastSentAt = sentAt), save()))
    .catch(console.error);
  return { ok: true };
}

function publicState() {
  const { kindleEmail, gmailUser, gmailAppPassword, substackSid, substackSidUpdatedAt } = state.settings;
  return {
    readingList: state.readingList,
    jobs: state.jobs,
    settings: { kindleEmail, gmailUser, hasAppPassword: Boolean(gmailAppPassword), hasSubstackLogin: Boolean(substackSid), substackSidUpdatedAt },
  };
}

function updateSettings(body) {
  const settings = state.settings;
  if (body.kindleEmail !== undefined) {
    if (body.kindleEmail && !KINDLE_EMAIL.test(body.kindleEmail.trim())) return { ok: false, error: "Not a @kindle.com address" };
    settings.kindleEmail = body.kindleEmail.trim();
  }
  if (body.gmailUser !== undefined) settings.gmailUser = body.gmailUser.trim();
  if (body.gmailAppPassword) settings.gmailAppPassword = body.gmailAppPassword.trim();
  if (body.substackSid && body.substackSid !== settings.substackSid) {
    settings.substackSid = body.substackSid.trim();
    settings.substackSidUpdatedAt = Date.now();
  }
  save();
  return { ok: true };
}

// ---- HTTP ----------------------------------------------------------------------------------

const json = (data, status = 200) => Response.json(data, { status });
const redirect = (location, headers = {}) => new Response(null, { status: 303, headers: { Location: location, ...headers } });

function parseUrls(value) {
  const text = Array.isArray(value) ? value.join("\n") : String(value || "");
  const matches = text.match(/https?:\/\/[^\s<>"'`]+/g) || [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?)\]]+$/, "")))];
}

const STATIC = { "/": "index.html", "/app.js": "app.js", "/app.css": "app.css", "/manifest.webmanifest": "manifest.webmanifest", "/icon.png": "icon.png" };

Bun.serve({
  port: PORT,
  tls: TLS_CERT && TLS_KEY ? { cert: Bun.file(TLS_CERT), key: Bun.file(TLS_KEY) } : undefined,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return new Response("ok");

    if (req.method === "GET" && STATIC[path]) return new Response(Bun.file(join(PUBLIC_DIR, STATIC[path])));

    // iOS Shortcut entry point: /add?url=…  (or /add?url=…&send=1 to send straight away)
    if (path === "/add" && req.method === "GET") {
      const urls = parseUrls(url.searchParams.get("url"));
      if (!urls.length) return redirect("/?msg=" + encodeURIComponent("No link found"));
      if (url.searchParams.get("send")) sendNow(urls, "separate");
      else addToList(urls);
      return redirect("/?msg=" + encodeURIComponent(url.searchParams.get("send") ? "Sending to your Kindle…" : "Added to reading list"));
    }

    if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    switch (`${req.method} ${path}`) {
      case "GET /api/state":
        return json(publicState());
      case "POST /api/list":
        return json(addToList(parseUrls(body.urls)));
      case "POST /api/list/remove":
        state.readingList.items = state.readingList.items.filter((item) => item.id !== body.id);
        save();
        return json({ ok: true });
      case "POST /api/list/clear":
        state.readingList.items = [];
        save();
        return json({ ok: true });
      case "POST /api/list/send":
        return json(sendReadingList());
      case "POST /api/list/sent": // the Chrome extension built and sent the book itself
        state.readingList.lastSentAt = Number(body.sentAt) || Date.now();
        save();
        return json({ ok: true });
      case "POST /api/send": {
        const urls = parseUrls(body.urls);
        if (!urls.length) return json({ ok: false, error: "No links found" }, 400);
        return json(sendNow(urls, body.mode === "bundle" ? "bundle" : "separate"));
      }
      case "POST /api/settings":
        return json(updateSettings(body));
      default:
        return json({ ok: false, error: "Not found" }, 404);
    }
  },
});

console.log(`Send to Scribe server on :${PORT}`);
