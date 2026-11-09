// Builds an EPUB 3 file (with an EPUB 2 NCX for older readers) from chapters.
import { createZip } from "./zip.js";
import { escapeXml } from "./xml.js";

const STYLE = `body { margin: 0 4%; line-height: 1.5; }
h1 { font-size: 1.6em; line-height: 1.25; margin: 0 0 0.3em; }
.subtitle { font-size: 1.15em; margin: 0 0 0.6em; }
.byline { font-style: italic; margin: 0 0 1.5em; }
img { max-width: 100%; height: auto; }
figure { margin: 1em 0; text-align: center; }
figcaption { font-size: 0.85em; font-style: italic; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #888; }
pre { white-space: pre-wrap; font-size: 0.85em; }
.source { margin-top: 2em; font-size: 0.8em; word-break: break-all; }
.back { font-size: 0.85em; margin: 0 0 1em; }
.back-bottom { font-size: 0.85em; margin-top: 1.5em; }
.toc-intro { margin: 0 0 1.5em; }
.toc { list-style: none; padding: 0; margin: 0; }
.toc li { margin: 0 0 1.2em; }
.toc .entry-title { font-weight: bold; font-size: 1.1em; }
.toc .entry-meta { font-size: 0.85em; }
.toc .entry-excerpt { font-size: 0.85em; font-style: italic; }
.new { font-weight: bold; }
.toc .depth-1 { margin-left: 1.5em; }
.toc .depth-2 { margin-left: 3em; }
.toc .depth-3 { margin-left: 4.5em; }
table { border-collapse: collapse; margin: 1em 0; font-size: 0.9em; }
th, td { border: 1px solid #888; padding: 0.25em 0.5em; text-align: left; vertical-align: top; }
th { font-weight: bold; }
code { font-family: monospace; font-size: 0.9em; }
hr { border: 0; border-top: 1px solid #888; margin: 1.5em 0; }
`;

/**
 * @typedef {{title: string, subtitle: string, author: string, date: string, sourceUrl: string, xhtml: string}} Chapter
 * @typedef {{id: string, href: string, mediaType: string, data: Uint8Array}} ImageFile
 * @typedef {{title: string, meta: string, excerpt: string, isNew: boolean}} ContentsEntry
 * @typedef {{heading: string, intro: string, entries: ContentsEntry[]}} Contents
 */

/**
 * Optional `contents` adds a tappable contents page as the book's first page (one entry per chapter, same order).
 * @param {{title: string, author: string, language: string, chapters: Chapter[], images: ImageFile[], cover: ImageFile | null, contents?: Contents}} book
 * @returns {Uint8Array} EPUB file bytes
 */
export function buildEpub({ title, author, language, chapters, images, cover, contents }) {
  const lang = escapeXml(language || "en");
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const chapterFiles = chapters.map((chapter, i) => ({ ...chapter, id: `ch-${i + 1}`, href: `ch-${i + 1}.xhtml` }));
  const spineFiles = contents
    ? [{ id: "contents", href: "contents.xhtml", title: contents.heading }, ...chapterFiles]
    : chapterFiles;

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${crypto.randomUUID()}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author || "Unknown")}</dc:creator>
    <dc:language>${lang}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>${cover ? `\n    <meta name="cover" content="${cover.id}"/>` : ""}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
${spineFiles.map((c) => `    <item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`).join("\n")}
${images
  .map(
    (img) =>
      `    <item id="${img.id}" href="${img.href}" media-type="${img.mediaType}"${img === cover ? ' properties="cover-image"' : ""}/>`,
  )
  .join("\n")}
  </manifest>
  <spine toc="ncx">
${spineFiles.map((c) => `    <itemref idref="${c.id}"/>`).join("\n")}
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1>
<ol>
${spineFiles.map((c) => `<li><a href="${c.href}">${escapeXml(c.title)}</a></li>`).join("\n")}
</ol>
</nav>
</body>
</html>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="bookid"/></head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
${spineFiles
  .map(
    (c, i) =>
      `<navPoint id="np-${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="${c.href}"/></navPoint>`,
  )
  .join("\n")}
</navMap>
</ncx>`;

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  return createZip([
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/nav.xhtml", data: nav },
    { name: "OEBPS/toc.ncx", data: ncx },
    { name: "OEBPS/style.css", data: STYLE },
    ...(contents ? [{ name: "OEBPS/contents.xhtml", data: contentsXhtml(contents, chapterFiles, lang) }] : []),
    ...chapterFiles.map((c) => ({ name: `OEBPS/${c.href}`, data: chapterXhtml(c, lang, Boolean(contents)) })),
    ...images.map((img) => ({ name: `OEBPS/${img.href}`, data: img.data })),
  ]);
}

function contentsXhtml(contents, chapterFiles, lang) {
  const items = contents.entries
    .map((entry, i) => {
      const flag = entry.isNew ? '<span class="new">NEW · </span>' : "";
      const depth = Math.min(3, Math.max(0, Number(entry.depth) || 0));
      const meta = flag || entry.meta ? `\n<div class="entry-meta">${flag}${escapeXml(entry.meta)}</div>` : "";
      return `<li${depth ? ` class="depth-${depth}"` : ""}><a class="entry-title" href="${chapterFiles[i].href}">${escapeXml(entry.title)}</a>${meta}${
        entry.excerpt ? `\n<div class="entry-excerpt">${escapeXml(entry.excerpt)}</div>` : ""
      }</li>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>${escapeXml(contents.heading)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h1 id="top">${escapeXml(contents.heading)}</h1>
<p class="toc-intro">${escapeXml(contents.intro)}</p>
<ol class="toc">
${items}
</ol>
</body>
</html>`;
}

function chapterXhtml(chapter, lang, linkToContents) {
  const back = linkToContents ? '<p class="back"><a href="contents.xhtml">← Contents</a></p>' : "";
  const byline = [chapter.author, chapter.date].filter(Boolean).map(escapeXml).join(" · ");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>${escapeXml(chapter.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${back}
<h1>${escapeXml(chapter.title)}</h1>
${chapter.subtitle ? `<p class="subtitle">${escapeXml(chapter.subtitle)}</p>` : ""}
${byline ? `<p class="byline">${byline}</p>` : ""}
${chapter.xhtml}
<p class="source">Source: <a href="${escapeXml(chapter.sourceUrl)}">${escapeXml(chapter.sourceUrl)}</a></p>
${linkToContents ? '<p class="back-bottom"><a href="contents.xhtml">← Back to contents</a></p>' : ""}
</body>
</html>`;
}
