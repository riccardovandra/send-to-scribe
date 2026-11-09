// Sends a book (EPUB) or a PDF as an email attachment through the Gmail API.

// Gmail caps messages at 25 MB and base64 adds a third, so the file itself must stay under ~18 MB.
const MAX_FILE_BYTES = 18_000_000;
const UPLOAD_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";

export class AuthError extends Error {}

/**
 * What gets emailed: a built EPUB, or a PDF sent as-is.
 * @typedef {{title: string, epub: Uint8Array} | {title: string, pdf: Uint8Array}} Book
 */

/**
 * The attachment for a book: file name, MIME type and bytes. Checks the email size limit.
 * @param {Book} book
 * @returns {{filename: string, contentType: string, bytes: Uint8Array}}
 */
export function attachmentFor(book) {
  const attachment =
    "pdf" in book
      ? { filename: fileName(book.title, "pdf"), contentType: "application/pdf", bytes: book.pdf }
      : { filename: fileName(book.title, "epub"), contentType: "application/epub+zip", bytes: book.epub };
  assertEmailSize(attachment.bytes, "pdf" in book ? "PDF" : "Book");
  return attachment;
}

/**
 * @param {{token: string, to: string, book: Book}} message
 */
export async function sendToKindle({ token, to, book }) {
  const { filename, contentType, bytes } = attachmentFor(book);
  const title = book.title;
  const boundary = `sts-${crypto.randomUUID()}`;
  const mime = [
    `To: ${to}`,
    `Subject: ${encodeHeader(title)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Sent by Send to Scribe.",
    "",
    `--${boundary}`,
    `Content-Type: ${contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64(bytes).replace(/.{76}/g, "$&\r\n"),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "message/rfc822" },
    body: mime,
  });
  if (res.status === 401) throw new AuthError("Gmail sign-in expired");
  if (!res.ok) throw new Error(`Gmail HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Throw a readable error if the file is too big to email. */
export function assertEmailSize(bytes, label = "Book") {
  if (bytes.length > MAX_FILE_BYTES) {
    const mb = (bytes.length / 1e6).toFixed(1);
    const hint = label === "Book" ? " Remove some older articles." : "";
    throw new Error(`${label} is ${mb} MB, over the 18 MB email limit.${hint}`);
  }
}

/** ASCII-safe attachment name for a title. */
export function fileName(title, extension = "epub") {
  const ascii = title.normalize("NFKD").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, " ").slice(0, 80);
  return `${ascii || "article"}.${extension}`;
}

function encodeHeader(text) {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${base64(new TextEncoder().encode(text))}?=`;
}

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
