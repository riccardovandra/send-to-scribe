// Talks to the Send to Scribe server, which holds the reading list shared with the phone.
// Server address and access token come from config.json next to manifest.json (kept out of git).

let configPromise = null;

/** @returns {Promise<{serverUrl: string, token: string} | null>} */
export function serverConfig() {
  configPromise ??= fetch(chrome.runtime.getURL("config.json"))
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  return configPromise;
}

/**
 * Call the server API. GET without a body, POST with one.
 * @param {string} path e.g. "/api/state"
 * @param {object} [body]
 */
export async function serverApi(path, body) {
  const config = await serverConfig();
  if (!config) throw new Error("Reading list server isn't set up (config.json missing)");
  const res = await fetch(config.serverUrl + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${config.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Reading list server error (HTTP ${res.status})`);
  return data;
}
