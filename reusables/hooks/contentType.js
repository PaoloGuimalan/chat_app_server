/**
 * What type and Content-Disposition a stored file is given. Pure, so it is
 * tested on its own (contentType.test.js) - storage.js connects on require.
 */
// Types a browser may render in place. SVG is left out on purpose: it can
// carry script, and a file shown inline runs on the storage domain.
const INLINE_TYPES = /^(image\/(jpeg|png|gif|webp|avif|bmp|heic|heif)|video\/[\w.+-]+|audio\/[\w.+-]+)$/i;

// A claimed type that would make a browser run the file if it ever rendered
// it, stored as plain binary instead.
const ACTIVE_TYPES = /(html|xml|svg|javascript|ecmascript)/i;

/**
 * The type to store: what the bytes say they are, else what the client
 * claimed (plain text, CSV and the like carry no signature), else binary.
 */
const pickContentType = (detected, claimed) => {
  const clean =
    typeof claimed === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(claimed)
      ? claimed.toLowerCase()
      : null;
  // A WebM/MP4 container sniffs as video even when it only holds sound, as a
  // voice note does - the claimed audio type is the accurate one then.
  if (detected && clean?.startsWith("audio/") && detected.startsWith("video/")) {
    return clean;
  }
  if (detected) return detected;
  if (clean && !ACTIVE_TYPES.test(clean)) return clean;
  return "application/octet-stream";
};

/**
 * Inline for what a browser shows itself; anything else downloads under its
 * real name. `filename*` (RFC 5987) carries a non-ASCII name intact, the
 * plain `filename` is the ASCII fallback for clients that ignore it.
 */
const dispositionFor = (mimeType, downloadName) => {
  if (INLINE_TYPES.test(mimeType)) return "inline";
  const name = String(downloadName || "file");
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

module.exports = { pickContentType, dispositionFor };
