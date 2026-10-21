// JPEG conversion for the server (no browser canvas here), using ffmpeg.

/**
 * @param {Blob} blob any image ffmpeg can read (WebP, AVIF, PNG, GIF…)
 * @param {{maxWidth: number, quality: number, grayscale: boolean}} options
 * @returns {Promise<Blob>}
 */
export async function ffmpegToJpeg(blob, { maxWidth, quality, grayscale }) {
  const filters = [`scale='min(${maxWidth},iw)':-2`];
  if (grayscale) filters.push("hue=s=0");
  // ffmpeg JPEG quality runs 2 (best) to 31; map 0.85 → ~5, 0.7 → ~7.
  const q = Math.round(2 + (1 - quality) * 18);
  const proc = Bun.spawn(
    ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-vf", filters.join(","), "-q:v", String(q), "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
    { stdin: new Uint8Array(await blob.arrayBuffer()), stdout: "pipe", stderr: "pipe" },
  );
  const [output, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  if (code !== 0 || !output.byteLength) throw new Error(`ffmpeg failed: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
  return new Blob([output], { type: "image/jpeg" });
}
