// Runs on UP Docs pages. Marks the page so UP Docs shows "Send to Scribe" in its
// export options, and relays the book it posts to the background script.
//
//   page -> here  { source: "up-docs", type: "send-to-scribe:send", requestId, book }
//   here -> page  { source: "send-to-scribe", type: "send-to-scribe:result", requestId, ok, error }

document.documentElement.setAttribute("data-send-to-scribe", chrome.runtime.getManifest().version);
document.dispatchEvent(new Event("send-to-scribe:ready"));

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== "up-docs" || data.type !== "send-to-scribe:send") return;
  const reply = (ok, error) =>
    window.postMessage(
      { source: "send-to-scribe", type: "send-to-scribe:result", requestId: data.requestId, ok, error },
      location.origin,
    );
  chrome.runtime
    .sendMessage({ target: "background", type: "send-book", book: data.book })
    .then(
      (response) => reply(Boolean(response?.ok), response?.error),
      // No reply: the extension was reloaded or updated since this page opened.
      () => reply(false, "Send to Scribe was updated. Reload this page and try again."),
    );
});
