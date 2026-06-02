const { getStore } = require("@netlify/blobs");
const crypto = require("node:crypto");

const SLUG_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SLUG_LEN   = 6;
const SLUG_RE    = /^[0-9A-Za-z]{6}$/;
const LINKS_TOKEN = process.env.BLIP_LINKS_TOKEN ?? "";

function generateSlug() {
  const bytes = crypto.randomBytes(SLUG_LEN);
  return Array.from(bytes, b => SLUG_CHARS[b % SLUG_CHARS.length]).join("");
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(statusCode, body, extra = {}) {
  return {
    statusCode,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const store = getStore({
    name: "links",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOB_TOKEN,
  });

  // Extract slug from the end of the path, e.g. /api/links/aB3xFq → "aB3xFq"
  const slug = (() => {
    const last = event.path.split("/").filter(Boolean).pop() ?? "";
    return SLUG_RE.test(last) ? last : null;
  })();

  // ── GET /api/links/:slug ── public ────────────────────────────────────────
  if (event.httpMethod === "GET") {
    if (!slug) return json(400, { error: "invalid slug" });

    const data = await store.get(slug, { type: "json" }).catch(() => null);
    if (!data) return json(404, { error: "not found" });

    return json(200, data, { "Cache-Control": "public, max-age=86400" });
  }

  // ── POST /api/links ── auth required ─────────────────────────────────────
  if (event.httpMethod === "POST") {
    if (LINKS_TOKEN) {
      const auth = (event.headers["authorization"] ?? "");
      if (auth !== `Bearer ${LINKS_TOKEN}`) return json(401, { error: "unauthorized" });
    }

    let body;
    try { body = JSON.parse(event.body ?? "{}"); }
    catch { return json(400, { error: "invalid JSON" }); }

    const { type, feedUrl, guid, title, podcastTitle, audioUrl, artworkUrl, startTime, episodes } = body;

    const validTypes = ["episode", "podcast", "playlist"];
    if (!type || !validTypes.includes(type)) {
      return json(400, { error: "type must be one of: episode, podcast, playlist" });
    }

    // Unique slug — 5 attempts against vanishingly rare collisions
    let newSlug;
    for (let i = 0; i < 5; i++) {
      const candidate = generateSlug();
      const exists = await store.get(candidate).catch(() => null);
      if (exists === null) { newSlug = candidate; break; }
    }
    if (!newSlug) return json(500, { error: "slug generation failed" });

    const s = (v) => typeof v === "string" ? v : null;
    const payload = {
      slug: newSlug,
      type,
      createdAt: new Date().toISOString(),
      feedUrl:      s(feedUrl),
      guid:         s(guid),
      title:        s(title),
      podcastTitle: s(podcastTitle),
      audioUrl:     s(audioUrl),
      artworkUrl:   s(artworkUrl),
      startTime:    typeof startTime === "number" ? Math.floor(startTime) : null,
      episodes: Array.isArray(episodes)
        ? episodes.slice(0, 5).map(ep => ({
            feedUrl:    s(ep?.feedUrl),
            audioUrl:   s(ep?.audioUrl),
            title:      s(ep?.title),
            artworkUrl: s(ep?.artworkUrl),
          }))
        : null,
    };

    await store.setJSON(newSlug, payload);

    return json(200, { slug: newSlug, url: `https://atheerapp.org/l/${newSlug}` });
  }

  return json(405, { error: "method not allowed" });
};
