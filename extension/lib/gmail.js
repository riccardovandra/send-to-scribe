// Sends an EPUB as an email attachment through the Gmail API.

// Gmail caps messages at 25 MB and base64 adds a third, so the EPUB itself must stay under ~18 MB.
const MAX_EPUB_BYTES = 18_000_000;
const UPLOAD_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";

export class AuthError extends Error {}

/**
 * @param {{token: string, to: string, title: string, epub: Uint8Array}} message
 */
export async function sendEpub({ token, to, title, epub }) {
  assertEmailSize(epub);
  const boundary = `sts-${crypto.randomUUID()}`;
  const filename = fileName(title);
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
    `Content-Type: application/epub+zip; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64(epub).replace(/.{76}/g, "$&\r\n"),
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

/** Throw a readable error if the EPUB is too big to email. */
export function assertEmailSize(epub) {
  if (epub.length > MAX_EPUB_BYTES) {
    const mb = (epub.length / 1e6).toFixed(1);
    throw new Error(`Book is ${mb} MB, over the 18 MB email limit. Remove some older articles.`);
  }
}

/** ASCII-safe attachment name for a book title. */
export function fileName(title) {
  const ascii = title.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, " ").slice(0, 80);
  return `${ascii || "article"}.epub`;
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
