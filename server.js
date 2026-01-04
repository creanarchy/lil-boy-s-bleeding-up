import http from "http";
import zlib from "zlib";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { createClient } from "@supabase/supabase-js";

const VERSION = "v5-miniapp";
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // optional


// ---- Playback acceleration caches (in-memory, ephemeral) ----
const FILEINFO_TTL_MS = 60 * 60 * 1000; // 1h
const HEAD_TTL_MS = 180 * 1000;         // 180s         // 90s
const HEAD_MAX_BYTES = 786432;     // 768KB warm chunk

const fileInfoCache = new Map(); // file_id -> { file_path, file_size, expiresAt }
const headCache = new Map();     // file_id -> { buf, totalSize, contentType, expiresAt }

function cacheGetFresh(map, key){
  const v = map.get(key);
  if (!v) return null;
  if (v.expiresAt && v.expiresAt < Date.now()){
    map.delete(key);
    return null;
  }
  return v;
}

function cacheSet(map, key, value){
  map.set(key, value);
}

function parseRangeHeader(range){
  if (typeof range !== "string") return null;
  const m = range.match(/bytes=(\d*)-(\d*)/i);
  if (!m) return null;
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Number(m[2]) : null;
  if (Number.isNaN(start) || (end !== null && Number.isNaN(end))) return null;
  return { start, end };
}

async function prefetchHeadBytes(fileUrl, file_id){
  const cached = cacheGetFresh(headCache, file_id);
  if (cached) return cached;

  const endByte = HEAD_MAX_BYTES - 1;
  const r = await fetch(fileUrl, { method: "GET", headers: { Range: `bytes=0-${endByte}` } });

  // Telegram should reply 206 for range; but be tolerant.
  if (!(r.ok || r.status === 206)) throw new Error(`prefetch_failed:${r.status}`);

  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);

  // If Telegram ignores Range and returns more, cap to HEAD_MAX_BYTES.
  const cappedBuf = buf.length > HEAD_MAX_BYTES ? buf.subarray(0, HEAD_MAX_BYTES) : buf;

  let totalSize = null;
  const cr = r.headers.get("content-range"); // e.g. "bytes 0-262143/1234567"
  if (cr){
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) totalSize = Number(m[1]);
  }

  const contentType = r.headers.get("content-type") || "audio/mpeg";

  const entry = {
    buf: cappedBuf,
    totalSize: Number.isFinite(totalSize) ? totalSize : null,
    contentType,
    expiresAt: Date.now() + HEAD_TTL_MS,
  };
  cacheSet(headCache, file_id, entry);
  return entry;
}

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

function json(res, code, obj, headers = {}) {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function text(res, code, body, headers = {}) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function contentTypeFor(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function readBodyMaybeDecompress(req) {
  const buf = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  const enc = String(req.headers["content-encoding"] || "").toLowerCase().trim();

  try {
    if (enc === "gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") return zlib.inflateSync(buf);
    if (enc === "br") return zlib.brotliDecompressSync(buf);
  } catch {
    // If decompression fails, fall back to raw buffer.
  }

  return buf;
}

async function tg(method, payload) {
  if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram API error: ${JSON.stringify(j)}`);
  return j.result;
}

async function tgGetFile(file_id) {
  return tg("getFile", { file_id });
}

function extractTrackFromMessage(msg) {
  if (msg?.audio?.file_id) {
    return {
      file_id: msg.audio.file_id,
      title: msg.audio.title || null,
      artist: msg.audio.performer || null,
      duration: typeof msg.audio.duration === "number" ? msg.audio.duration : null,
    };
  }
  if (msg?.document?.file_id) {
    const mime = msg.document.mime_type || "";
    const name = msg.document.file_name || "";
    const looksLikeAudio =
      mime.startsWith("audio/") ||
      name.toLowerCase().endsWith(".mp3") ||
      name.toLowerCase().endsWith(".wav") ||
      name.toLowerCase().endsWith(".m4a") ||
      name.toLowerCase().endsWith(".flac");
    if (looksLikeAudio) {
      return {
        file_id: msg.document.file_id,
        title: name || null,
        artist: null,
        duration: null,
      };
    }
  }
  return null;
}

async function saveTrackToSupabase(telegram_user_id, track) {
  if (!supabase) throw new Error("Supabase client not configured");
  const payload = {
    telegram_user_id: String(telegram_user_id),
    file_id: track.file_id,
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    file_path: track.file_path || null,
  };
  const { error } = await supabase.from("tracks").insert(payload);
  if (error) throw error;
}

function shouldProcessWebhook(pathname) {
  if (!WEBHOOK_SECRET) return pathname === "/webhook";
  return pathname === `/webhook/${WEBHOOK_SECRET}`;
}

// --- Telegram Mini App initData validation ---
// Algorithm: secretKey = HMAC_SHA256(botToken, key="WebAppData"), then hash = HMAC_SHA256(dataCheckString, secretKey)
function validateInitData(initDataRaw, maxAgeSec = 24 * 60 * 60) {
  if (!BOT_TOKEN) return { ok: false, error: "missing_bot_token" };
  if (!initDataRaw) return { ok: false, error: "missing_init_data" };

  let decoded = initDataRaw;
  try {
    decoded = decodeURIComponent(initDataRaw);
  } catch {
    // ignore
  }

  const params = new URLSearchParams(decoded);
  const receivedHash = params.get("hash") || "";
  if (!receivedHash) return { ok: false, error: "missing_hash" };

  const authDateStr = params.get("auth_date") || "";
  const authDate = Number(authDateStr);
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, error: "bad_auth_date" };

  const nowSec = Math.floor(Date.now() / 1000);
  if (maxAgeSec > 0 && nowSec - authDate > maxAgeSec) {
    return { ok: false, error: "expired_init_data" };
  }

  // Build data-check-string: sort keys (except hash), join as key=value separated by \n
  const keys = [];
  for (const [k] of params.entries()) {
    if (k !== "hash") keys.push(k);
  }
  keys.sort();

  const dataCheckString = keys
    .map((k) => `${k}=${params.get(k) ?? ""}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (computedHash !== receivedHash) return { ok: false, error: "bad_signature" };

  const userStr = params.get("user");
  if (!userStr) return { ok: false, error: "missing_user" };

  let user;
  try {
    user = JSON.parse(userStr);
  } catch {
    return { ok: false, error: "bad_user_json" };
  }

  const userId = user?.id;
  if (!userId) return { ok: false, error: "missing_user_id" };

  return { ok: true, userId: String(userId), user };
}

function getInitDataFromRequest(req, url) {
  // Preferred: header
  const h = req.headers["x-telegram-init-data"];
  if (typeof h === "string" && h.trim()) return h.trim();

  // Fallback: query param
  const q = url.searchParams.get("initData") || url.searchParams.get("init_data");
  if (q) return q;

  return "";
}

async function requireUser(req, res, url) {
  const initData = getInitDataFromRequest(req, url);
  const v = validateInitData(initData);
  if (!v.ok) {
    json(res, 401, { ok: false, error: "unauthorized", detail: v.error });
    return null;
  }
  return { telegram_user_id: v.userId, user: v.user };
}

async function listTracksForUser(telegram_user_id, { query = "", sort = "date_desc", limit = 200 } = {}) {
  if (!supabase) throw new Error("Supabase client not configured");
  let q = supabase
    .from("tracks")
    .select("id, title, artist, duration, created_at")
    .eq("telegram_user_id", String(telegram_user_id))
    .limit(limit);

  const s = String(sort || "date_desc");
  if (s === "title_asc") {
    q = q.order("title", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false });
  } else {
    q = q.order("created_at", { ascending: false });
  }

  const term = String(query || "").trim();
  if (term) {
    const escaped = term.replace(/,/g, ""); // supabase .or() uses commas as separators
    q = q.or(`title.ilike.%${escaped}%,artist.ilike.%${escaped}%`);
  }

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function getTrackForUserById(telegram_user_id, trackId) {
  if (!supabase) throw new Error("Supabase client not configured");
  const { data, error } = await supabase
    .from("tracks")
    .select("id, telegram_user_id, file_id, file_path, title, artist, duration, created_at")
    .eq("telegram_user_id", String(telegram_user_id))
    .eq("id", trackId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function setTrackFilePath(telegram_user_id, trackId, file_path){
  if (!supabase) throw new Error("Supabase client not configured");
  if (!file_path) return;
  const { error } = await supabase
    .from("tracks")
    .update({ file_path })
    .eq("telegram_user_id", String(telegram_user_id))
    .eq("id", trackId);
  if (error) throw error;
}

async function serveStatic(req, res, url) {
  // /app -> /app/index.html
  let rel = url.pathname.replace(/^\/app/, "");
  if (!rel || rel === "/") rel = "/index.html";

  // Prevent path traversal
  const safeRel = path.posix.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const abs = path.join(PUBLIC_DIR, safeRel);

  // Ensure inside PUBLIC_DIR
  const resolved = path.resolve(abs);
  const baseResolved = path.resolve(PUBLIC_DIR);
  if (!resolved.startsWith(baseResolved)) {
    json(res, 403, { ok: false, error: "forbidden" });
    return true;
  }

  try {
    const file = await fs.readFile(resolved);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(resolved),
      "Cache-Control": "no-store",
    });
    res.end(file);
    return true;
  } catch {
    json(res, 404, { ok: false, error: "not_found" });
    return true;
  }
}

async function proxyTelegramFileToResponse(fileUrl, req, res, file_id = null, refreshFileUrl = null) {
  const headers = {};
  const range = req.headers["range"];

  const parsedRange = parseRangeHeader(range);
  if (file_id && parsedRange){
    const cachedHead = cacheGetFresh(headCache, file_id);
    if (cachedHead && parsedRange.start === 0){
      // Serve a warm "head" chunk immediately to reduce TTFB, even if total size is unknown.
      const total = cachedHead.totalSize; // may be null
      const wantEnd = parsedRange.end;
      const maxEnd = cachedHead.buf.length - 1;

      const end = (typeof wantEnd === "number" && wantEnd <= maxEnd) ? wantEnd : maxEnd;
      const slice = cachedHead.buf.subarray(0, end + 1);

      res.writeHead(206, {
        "Content-Type": cachedHead.contentType,
        "Content-Length": String(slice.length),
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes 0-${end}/${Number.isFinite(total) ? total : "*"}`,
        "Cache-Control": "no-store",
        "X-Core-Head-Cache": "HIT",
        "Server-Timing": "headcache;desc=\"served from memory\";dur=0",
      });
      if (req.method === "HEAD") return res.end();
      res.end(slice);
      return;
    }
  }

  if (typeof range === "string" && range.trim()) headers["Range"] = range;

  let tgResp = await fetch(fileUrl, { method: "GET", headers });

  // If Telegram file_path went stale (can happen), try to refresh it once and retry.
  if (refreshFileUrl && (tgResp.status === 404 || tgResp.status === 410)) {
    try {
      const refreshed = await refreshFileUrl();
      if (refreshed && refreshed !== fileUrl) {
        fileUrl = refreshed;
        tgResp = await fetch(fileUrl, { method: "GET", headers });
      }
    } catch {
      // ignore refresh errors, fall back to original response
    }
  }

  const passthroughHeaders = {};

  const ct = tgResp.headers.get("content-type");
  if (ct) passthroughHeaders["Content-Type"] = ct;

  const cl = tgResp.headers.get("content-length");
  if (cl) passthroughHeaders["Content-Length"] = cl;

  const ar = tgResp.headers.get("accept-ranges");
  if (ar) passthroughHeaders["Accept-Ranges"] = ar;

  const cr = tgResp.headers.get("content-range");
  if (cr) passthroughHeaders["Content-Range"] = cr;

  // Avoid caching
  passthroughHeaders["Cache-Control"] = "no-store";
  passthroughHeaders["X-Core-Head-Cache"] = "MISS";

  res.writeHead(tgResp.status, passthroughHeaders);

  if (!tgResp.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(tgResp.body);
  nodeStream.on("error", () => {
    try { res.end(); } catch {}
  });
  nodeStream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // Health
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, version: VERSION });
    }
    if (req.method === "GET" && url.pathname === "/version") {
      return json(res, 200, { version: VERSION });
    }
    if (req.method === "GET" && url.pathname === "/") {
      return text(res, 200, `core server: ok (${VERSION})`);
    }

    // Mini App static
    if (req.method === "GET" && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
      return serveStatic(req, res, url);
    }

    // Mini App API: list tracks
    if (req.method === "GET" && url.pathname === "/api/tracks") {
      const u = await requireUser(req, res, url);
      if (!u) return;

      const query = url.searchParams.get("query") || "";
      const sort = url.searchParams.get("sort") || "date_desc";
      const tracks = await listTracksForUser(u.telegram_user_id, { query, sort });
      return json(res, 200, { ok: true, tracks });
    }

    // Mini App API: stream a track (proxy from Telegram)
    
    // Mini App API: prefetch first bytes of a track (warms server memory cache)
    const prefetchMatch = url.pathname.match(/^\/api\/tracks\/([0-9a-fA-F-]+)\/prefetch$/);
    if (req.method === "GET" && prefetchMatch) {
      const u = await requireUser(req, res, url);
      if (!u) return;

      const trackId = prefetchMatch[1];
      const track = await getTrackForUserById(u.telegram_user_id, trackId);
      if (!track) return json(res, 404, { ok: false, error: "track_not_found" });

      // Resolve file_path (use stored value, fallback to Telegram once)
      let filePath = track.file_path || null;

      if (!filePath) {
        const cached = cacheGetFresh(fileInfoCache, track.file_id);
        if (cached?.file_path) filePath = cached.file_path;
      }

      if (!filePath) {
        const fileInfo = await tgGetFile(track.file_id);
        filePath = fileInfo?.file_path || null;
        if (filePath) {
          cacheSet(fileInfoCache, track.file_id, {
            file_path: filePath,
            file_size: fileInfo?.file_size || null,
            expiresAt: Date.now() + FILEINFO_TTL_MS,
          });
          // Persist for next time
          try { await setTrackFilePath(u.telegram_user_id, trackId, filePath); } catch {}
        }
      }

if (!filePath) return json(res, 500, { ok: false, error: "file_path_missing" });

      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
      try {
      await prefetchHeadBytes(fileUrl, track.file_id);
    } catch {
      // If stored file_path went stale, refresh once and retry warming the head-cache.
      try {
        const fileInfo = await tgGetFile(track.file_id);
        const newPath = fileInfo?.file_path || null;
        if (newPath) {
          cacheSet(fileInfoCache, track.file_id, {
            file_path: newPath,
            file_size: fileInfo?.file_size || null,
            expiresAt: Date.now() + FILEINFO_TTL_MS,
          });
          try { await setTrackFilePath(u.telegram_user_id, trackId, newPath); } catch {}
          const refreshedUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${newPath}`;
          try { await prefetchHeadBytes(refreshedUrl, track.file_id); } catch {}
        }
      } catch {}
    }
      return json(res, 200, { ok: true });
    }

const streamMatch = url.pathname.match(/^\/api\/tracks\/([0-9a-fA-F-]+)\/stream$/);
    if ((req.method === "GET" || req.method === "HEAD") && streamMatch) {
      const u = await requireUser(req, res, url);
      if (!u) return;

      const trackId = streamMatch[1];
      const track = await getTrackForUserById(u.telegram_user_id, trackId);
      if (!track) return json(res, 404, { ok: false, error: "track_not_found" });

      let filePath = track.file_path || null;

      if (!filePath) {
        const cached = cacheGetFresh(fileInfoCache, track.file_id);
        if (cached?.file_path) filePath = cached.file_path;
      }

      if (!filePath) {
        const fileInfo = await tgGetFile(track.file_id);
        filePath = fileInfo?.file_path || null;
        if (filePath) {
          cacheSet(fileInfoCache, track.file_id, { file_path: filePath, file_size: fileInfo?.file_size || null, expiresAt: Date.now() + FILEINFO_TTL_MS });
          // Persist so next playback doesn't need Telegram API
          try { await setTrackFilePath(u.telegram_user_id, trackId, filePath); } catch {}
        }
      }
      if (!filePath) return json(res, 502, { ok: false, error: "telegram_getfile_failed" });

      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      if (req.method === "HEAD") {
        // Quick HEAD: still proxying GET is fine; but we can just respond OK without body.
        // However, browsers usually don't require HEAD for audio; keeping simple:
        return proxyTelegramFileToResponse(fileUrl, req, res, track.file_id, async () => {
        try {
          const fileInfo = await tgGetFile(track.file_id);
          const newPath = fileInfo?.file_path || null;
          if (!newPath) return null;

          cacheSet(fileInfoCache, track.file_id, {
            file_path: newPath,
            file_size: fileInfo?.file_size || null,
            expiresAt: Date.now() + FILEINFO_TTL_MS,
          });

          try { await setTrackFilePath(u.telegram_user_id, trackId, newPath); } catch {}
          return `https://api.telegram.org/file/bot${BOT_TOKEN}/${newPath}`;
        } catch {
          return null;
        }
      });
      }

      return proxyTelegramFileToResponse(fileUrl, req, res, track.file_id, async () => {
        try {
          const fileInfo = await tgGetFile(track.file_id);
          const newPath = fileInfo?.file_path || null;
          if (!newPath) return null;

          cacheSet(fileInfoCache, track.file_id, {
            file_path: newPath,
            file_size: fileInfo?.file_size || null,
            expiresAt: Date.now() + FILEINFO_TTL_MS,
          });

          try { await setTrackFilePath(u.telegram_user_id, trackId, newPath); } catch {}
          return `https://api.telegram.org/file/bot${BOT_TOKEN}/${newPath}`;
        } catch {
          return null;
        }
      });
    }

    // Telegram webhook
    if (req.method === "POST" && url.pathname.startsWith("/webhook")) {
      // Always respond 200 immediately so Telegram never sees 4xx/5xx.
      json(res, 200, { ok: true });

      // If secret/path mismatched — do nothing (but still 200).
      if (!shouldProcessWebhook(url.pathname)) return;

      const bodyBuf = await readBodyMaybeDecompress(req);
      const raw = bodyBuf.toString("utf8");

      let update;
      try {
        update = JSON.parse(raw);
      } catch (e) {
        console.error("webhook JSON parse failed:", e?.message);
        return;
      }

      setImmediate(async () => {
        try {
          const msg = update.message || update.edited_message || null;
          if (!msg) return;

          const chatId = msg.chat?.id;
          const fromId = msg.from?.id;

          if (msg.text && msg.text.startsWith("/start") && chatId) {
            await tg("sendMessage", {
              chat_id: chatId,
              text: "Send me an audio track (mp3/m4a/etc). I’ll save it to your core library.\n\nOpen your library: /app",
            });
            return;
          }

          const track = extractTrackFromMessage(msg);
          if (track && chatId && fromId) {
            // Resolve Telegram file_path once on ingest (saves a roundtrip on each playback)
            try {
              const cached = cacheGetFresh(fileInfoCache, track.file_id);
              if (cached?.file_path) {
                track.file_path = cached.file_path;
              } else {
                const fileInfo = await tgGetFile(track.file_id);
                if (fileInfo?.file_path) {
                  track.file_path = fileInfo.file_path;
                  cacheSet(fileInfoCache, track.file_id, {
                    file_path: fileInfo.file_path,
                    file_size: fileInfo.file_size || null,
                    expiresAt: Date.now() + FILEINFO_TTL_MS,
                  });
                }
              }
            } catch {}

            await saveTrackToSupabase(fromId, track);
            await tg("sendMessage", { chat_id: chatId, text: "Added to core." });
            return;
          }

          if (chatId) {
            await tg("sendMessage", { chat_id: chatId, text: "Send an audio track file." });
          }
        } catch (e) {
          console.error("process update error:", e);
        }
      });

      return;
    }

    return json(res, 404, { ok: false, error: "not_found" });
  } catch (e) {
    console.error("server error:", e);
    try { json(res, 500, { ok: false, error: "server_error" }); } catch {}
  }
});

server.listen(PORT, () => {
  console.log(`core server listening on :${PORT} (${VERSION})`);
  console.log(`webhook secret enabled: ${Boolean(WEBHOOK_SECRET)}`);
  console.log(`mini app served at /app`);
});
