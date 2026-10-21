// Downloads article images and converts anything Kindle can't handle (WebP, AVIF, huge files) to JPEG.

const SUPPORTED = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif" };
const MAX_BYTES = 1_500_000;
const MAX_WIDTH = 1600;
const CONCURRENCY = 6;
// Compact mode keeps big reading-list books under the email size limit. The Scribe is grayscale anyway.
const COMPACT = { maxWidth: 1200, quality: 0.7, grayscale: true };

/**
 * @typedef {{id: string, href: string, mediaType: string, data: Uint8Array}} ImageFile
 */

export class ImageStore {
  /** @type {string[]} */
  #urls = [];
  /** @type {(ImageFile | null)[]} */
  #files = [];
  #compact;

  /** @param {{compact?: boolean}} [options] */
  constructor({ compact = false } = {}) {
    this.#compact = compact;
  }

  /** Register an image URL; returns a placeholder to put in the img src. */
  add(url) {
    // Ask Substack's CDN for JPEG instead of WebP/AVIF.
    const fixed = url.includes("substackcdn.com/image/fetch/") ? url.replace(/\bf_(auto|webp|avif)\b/, "f_jpg") : url;
    let index = this.#urls.indexOf(fixed);
    if (index < 0) index = this.#urls.push(fixed) - 1;
    return `@@IMG-${index}@@`;
  }

  /** Download all registered images. Failed downloads are dropped. */
  async load() {
    this.#files = new Array(this.#urls.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < this.#urls.length) {
        const i = next++;
        this.#files[i] = await loadImage(this.#urls[i], i, this.#compact).catch(() => null);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  /** Replace placeholders with real paths, removing images that failed to download. */
  resolve(xhtml) {
    return xhtml.replace(/<img src="@@IMG-(\d+)@@"[^>]*\/>/g, (tag, i) => {
      const file = this.#files[Number(i)];
      return file ? tag.replace(`@@IMG-${i}@@`, file.href) : "";
    });
  }

  /** @returns {ImageFile | null} */
  get(placeholder) {
    const match = placeholder.match(/^@@IMG-(\d+)@@$/);
    return match ? this.#files[Number(match[1])] : null;
  }

  /** @returns {ImageFile[]} */
  files() {
    return this.#files.filter(Boolean);
  }
}

async function loadImage(url, index, compact) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Image HTTP ${res.status}`);
  let blob = await res.blob();
  let type = blob.type.split(";")[0];
  if (compact || !SUPPORTED[type] || blob.size > MAX_BYTES) {
    blob = await convertToJpeg(blob, compact ? COMPACT : { maxWidth: MAX_WIDTH, quality: 0.85, grayscale: false });
    type = "image/jpeg";
  }
  return {
    id: `img-${index}`,
    href: `images/img-${index}.${SUPPORTED[type]}`,
    mediaType: type,
    data: new Uint8Array(await blob.arrayBuffer()),
  };
}

/**
 * Swap the JPEG converter. The extension uses the browser canvas; the server, which has none, uses ffmpeg.
 * @param {(blob: Blob, options: {maxWidth: number, quality: number, grayscale: boolean}) => Promise<Blob>} converter
 */
export function setJpegConverter(converter) {
  convertToJpeg = converter;
}

let convertToJpeg = canvasToJpeg;

async function canvasToJpeg(blob, { maxWidth, quality, grayscale }) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (grayscale) ctx.filter = "grayscale(1)";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/jpeg", quality });
}
