/**
 * Upload limits and transfer settings, read from Postgres `core_variable`
 * (Django's core.Variable - edited in the admin).
 *
 * Cached for CACHE_MS so an upload never waits on a query, and so an edit
 * takes effect within about a minute without a deploy. A missing row, a
 * malformed value or a failed query falls back to DEFAULTS rather than
 * blocking uploads - the same stance reusables/vars/uploads.js takes.
 *
 * The defaults mirror user_service core/migrations/0003_seed_upload_variables.py.
 */
const pool = require("../database/postgres");

const CACHE_MS = 60_000;

const DEFAULT_LIMITS = Object.freeze({
  message: { maxMB: 100, types: ["*"] },
  voice_note: { maxMB: 25, types: ["audio/*"] },
  post_media: { maxMB: 100, types: ["image/*", "video/*"] },
  moment: { maxMB: 100, types: ["image/*", "video/mp4"] },
  moment_poster: { maxMB: 10, types: ["image/jpeg", "image/png"] },
  diary: { maxMB: 100, types: ["*"] },
  avatar: { maxMB: 10, types: ["image/*"] },
  cover: { maxMB: 10, types: ["image/*"] },
  comment: { maxMB: 10, types: ["image/*"] },
});

const DEFAULT_TRANSFER = Object.freeze({
  multipartThresholdMB: 16,
  partSizeMB: 8,
  concurrency: 4,
});

// S3's floor for every part but the last, and its ceiling on part count.
const MIN_PART_MB = 5;
const MAX_PARTS = 10_000;

const isPositive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

/** One feature's limit, or null when it is not usable. */
const cleanLimit = (raw) => {
  if (!raw || !isPositive(raw.maxMB)) return null;
  const types = Array.isArray(raw.types)
    ? raw.types.filter((t) => typeof t === "string" && t.trim())
    : [];
  return { maxMB: raw.maxMB, types: types.length ? types : ["*"] };
};

/**
 * Stored limits over the defaults, feature by feature: a broken entry falls
 * back to its own default without taking the valid ones with it. Features
 * that exist only in the table are kept, so a new one needs no deploy here.
 */
const mergeLimits = (stored) => {
  const merged = {};
  for (const [feature, value] of Object.entries(DEFAULT_LIMITS)) {
    merged[feature] = { ...value };
  }
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const [feature, raw] of Object.entries(stored)) {
      const limit = cleanLimit(raw);
      if (limit) merged[feature] = limit;
      else if (!merged[feature]) continue;
      else console.warn(`[media config] upload_limits.${feature} is invalid; using the default`);
    }
  }
  return merged;
};

const mergeTransfer = (stored) => {
  const out = { ...DEFAULT_TRANSFER };
  if (stored && typeof stored === "object") {
    for (const key of Object.keys(out)) {
      if (isPositive(stored[key])) out[key] = stored[key];
    }
  }
  out.partSizeMB = Math.max(out.partSizeMB, MIN_PART_MB);
  out.concurrency = Math.min(Math.max(Math.round(out.concurrency), 1), 16);
  return out;
};

let cache = null;
let cachedAt = 0;
let inFlight = null;

const load = async () => {
  let rows = [];
  try {
    ({ rows } = await pool.query(
      `SELECT key, value FROM core_variable WHERE key = ANY($1)`,
      [["upload_limits", "upload_transfer"]],
    ));
  } catch (err) {
    // Before the migration has run, or the database is unreachable.
    console.warn("[media config] falling back to defaults:", err.message || err);
  }
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    limits: mergeLimits(byKey.upload_limits),
    transfer: mergeTransfer(byKey.upload_transfer),
  };
};

/** { limits, transfer }, at most CACHE_MS old. Never rejects. */
const getMediaConfig = async () => {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  if (!inFlight) {
    inFlight = load()
      .then((config) => {
        cache = config;
        cachedAt = Date.now();
        return config;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
};

/** A feature's limit, with maxBytes worked out - or null for an unknown one. */
const limitFor = async (feature) => {
  const { limits } = await getMediaConfig();
  const limit = limits[feature];
  if (!limit) return null;
  return { ...limit, maxBytes: Math.floor(limit.maxMB * 1024 * 1024) };
};

/** Whether `mime` matches any of `types` ("*", "image/*", "video/mp4"). */
const typeAllowed = (mime, types) => {
  const value = String(mime || "").toLowerCase();
  return types.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === "*" || p === "*/*") return true;
    if (p.endsWith("/*")) return value.startsWith(p.slice(0, -1));
    return value === p;
  });
};

/**
 * How a file of `size` bytes goes up: one PUT, or parts of `partSize`.
 * Grows the part size past the configured one when a file would otherwise
 * need more parts than storage allows.
 */
const transferPlan = (size, transfer) => {
  const threshold = transfer.multipartThresholdMB * 1024 * 1024;
  if (size < threshold) return { mode: "single" };
  let partSize = Math.floor(transfer.partSizeMB * 1024 * 1024);
  if (Math.ceil(size / partSize) > MAX_PARTS) partSize = Math.ceil(size / MAX_PARTS);
  const count = Math.ceil(size / partSize);
  const parts = [];
  for (let n = 1; n <= count; n++) {
    const start = (n - 1) * partSize;
    parts.push({ n, size: Math.min(partSize, size - start) });
  }
  return { mode: "multipart", partSize, parts };
};

/** Drops the cache - for tests. */
const resetMediaConfigCache = () => {
  cache = null;
  cachedAt = 0;
};

module.exports = {
  getMediaConfig,
  limitFor,
  typeAllowed,
  transferPlan,
  mergeLimits,
  mergeTransfer,
  resetMediaConfigCache,
  DEFAULT_LIMITS,
  DEFAULT_TRANSFER,
};
