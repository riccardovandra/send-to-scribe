# Send to Scribe

Two parts sharing one reading list:

- `extension/`: the Chrome extension (Mac). Load unpacked from this folder (needs `extension/config.json`, not in git).
- `server/`: phone web app + shared reading list API, at https://scribe.upliftedconsulting.com, tailnet only (VPS, Docker, `docker compose up -d --build`, then `tailscale serve --bg --tcp=443 tcp://127.0.0.1:8790`). Reuses `extension/lib` for article extraction and EPUB building.

## Phone

- Tailscale must be on. No login: the DNS record points at the VPS's Tailscale IP (100.81.167.80), so only tailnet devices can reach it.
- Share → **Send to Scribe** shortcut adds the article to the reading list. Or open the web app and paste links.
- Settings (in the web app, one time): Kindle email, sending Gmail, Gmail app password.
- Paid Substack posts on the phone use your Substack login. The Chrome extension syncs it to the server automatically.

## Server

- State (settings, reading list, recent jobs) is one JSON file in the `send-to-scribe-data` Docker volume.
- Access: container listens on 127.0.0.1 only; `tailscale serve` forwards tailnet port 443 to it. HTTPS certificate from Let's Encrypt via lego + Cloudflare DNS, in `~/.local/share/lego`, renewed daily by cron with `renew-cert.sh`. Gmail app password and Substack cookie are stored in the data volume only.
- Dependencies pinned exactly: `linkedom` 0.18.13 and `nodemailer` 10.1.1. `bunfig.toml` skips releases newer than 7 days.

## Extension

Chrome extension: paste article links (Substack first-class, most other sites work) and they arrive on your Kindle Scribe as clean EPUBs, sent through your own Gmail.

## How it works

1. **Fetch**: your browser downloads the article with your cookies, so paid Substacks you're logged into work.
2. **Extract**: Substack posts come from Substack's post API (clean body, title, author, cover). Other sites use Mozilla Readability (the engine behind Firefox reader view), with a simple heuristic as fallback.
3. **Package**: clean XHTML + images (WebP/AVIF converted to JPEG) bundled into an EPUB.
4. **Deliver**: Gmail API emails the EPUB to your `@kindle.com` address.

Ways to send:

- Popup: paste any text with links → Send. "Separate documents" or "One bundle" (one book, one chapter per article).
- "+ Current tab" button.
- Right-click a link or page → "Send link to Kindle" / "Send this page to Kindle".

The toolbar badge shows how many are in progress, then ✓ or !.

## Reading list (one growing book)

- Choose **Add to reading list** (the default) and click Add, or right-click a link → "Add link to reading list".
- Each article is checked straight away, so the popup shows its title and flags broken links.
- **Send reading list** sends one book called "Reading List":
  - Page 1 is the contents: newest first, with title, author, site, reading time, date added and a one-line summary. Tap a title to jump to it.
  - Every article has "← Contents" links back.
  - Articles added since the last send are marked **NEW**.
- Amazon can't update a book already on the Kindle, so each send arrives as a new copy. Delete the old one on the Kindle.
- Images are grayscale and smaller in this book, so a long list fits in one email (18 MB cap). If it's ever too big, remove older articles with ✕.

## Paid Substack posts

1. The extension asks Substack's API for the post with your browser cookies.
2. Substack doesn't flag previews, but it reports the full word count. If the body is much shorter (<85%), it's a preview.
3. If that happens, the post opens briefly in a background tab and is read from inside the page, with exactly your logged-in session. The tab closes automatically.
4. If it's still a preview, you're not subscribed or not logged in, so you get an error instead of half an article.

## One-time setup (~15 min)

The extension ID is fixed by the `key` in `manifest.json`: **`dlbkpgpimemeloihmoklblfijngojiem`**.

### 1. Amazon

1. amazon.com/myk → Preferences → Personal Document Settings.
2. Copy your **Send-to-Kindle email** (`something@kindle.com`).
3. Under **Approved Personal Document E-mail List**, add the Gmail address you'll send from.

### 2. Google Cloud (lets the extension send from your Gmail)

1. console.cloud.google.com → create a project, e.g. "Send to Scribe".
2. APIs & Services → Library → **Gmail API** → Enable.
3. Google Auth Platform (OAuth consent screen) → Get started → User type **External** → fill app name and your email.
4. Audience → **Test users** → add your Gmail address.
5. Clients → Create client → Application type **Chrome Extension** → Item ID `dlbkpgpimemeloihmoklblfijngojiem` → Create.
6. Copy the client ID into `manifest.json` → `oauth2.client_id`.

Note: in "Testing" mode Google may ask you to re-approve every 7 days. To avoid it, Audience → **Publish app**. Your personal app needs no verification; you'll just click through an "unverified app" warning once.

### 3. Chrome

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
2. Check that the ID shown matches `dlbkpgpimemeloihmoklblfijngojiem`.
3. Click the extension → Settings → paste your Kindle email → Save.
4. Send a link. The first send opens Google's consent screen for "Send email on your behalf".

The sending Gmail account is the Google account **signed into this Chrome profile**. Use a profile signed in with your personal Gmail, and approve that address with Amazon.

## Limits / known gaps

- Paid Substack posts need you logged in and subscribed in that Chrome profile. If not, you get a clear "only the preview is available" error; half-articles are never sent.
- Amazon caps email attachments at 50 MB. Very image-heavy bundles could hit it.
- Sites that block requests from non-browser contexts or need JavaScript to render content won't extract.

## Files

| File               | Role                                                            |
| ------------------ | --------------------------------------------------------------- |
| `manifest.json`    | Permissions, OAuth client, stable key                           |
| `popup.*`          | Paste box, settings, status list                                |
| `background.js`    | Starts jobs, Gmail sign-in, status + badge, right-click menu    |
| `offscreen.js`     | Hidden page running the pipeline (service workers lack a DOM)   |
| `lib/extract.js`   | Substack API + generic extraction, HTML → clean XHTML           |
| `lib/images.js`    | Download images, convert to Kindle-friendly JPEG                |
| `lib/book.js`      | Articles → one EPUB                                             |
| `lib/epub.js`      | EPUB 3 structure (OPF, nav, NCX, CSS)                           |
| `lib/vendor/Readability.js` | Mozilla Readability 0.6.0, vendored from npm (`@mozilla/readability`, sha512 verified), Apache-2.0 |
| `lib/zip.js`       | Dependency-free ZIP writer                                      |
| `lib/gmail.js`     | MIME email + Gmail API upload                                   |
