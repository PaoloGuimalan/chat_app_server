/**
 * The `attachment` an older file message should have had, worked out from
 * its stored content - the ONE place left that reads a name out of a URL,
 * run once by scripts/backfillMessageAttachments.js so no client ever has to.
 *
 * Stored content came in three shapes:
 *   <Firebase url>%%%<name>   the first uploads; those files no longer exist
 *   <Spaces url>/<10 digits>_<name>   uploads through the server since
 *   anything else             not ours (a link) - left without an attachment
 */
const { cleanFileName, kindOf } = require("./fileNames");

const FIREBASE_HOST = "storage.googleapis.com";

const IMAGE_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
  bmp: "image/bmp",
};

const decodeName = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const extensionOf = (name) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/**
 * The type: messageType when it is a real type; for a bare "image" (what the
 * server stored for every photo) the extension says which one.
 */
const mimeFor = (messageType, name) => {
  const type = String(messageType || "").toLowerCase();
  if (type.includes("/")) return type;
  if (type === "image") return IMAGE_TYPES[extensionOf(name)] || null;
  return null;
};

/**
 * { attachment, key } for a message, or null when it has no file of ours.
 * `keyFromUrl` is the storage provider's; `attachment.size` is left for the
 * caller to fill from storage (null = unknown).
 */
const legacyAttachmentFor = ({ content, messageType }, keyFromUrl) => {
  if (typeof content !== "string" || !content.trim()) return null;
  const raw = content.trim();
  const isFirebase = raw.includes("%%%") || raw.includes(FIREBASE_HOST);

  // The URL half; "###" was a literal in some older keys and must be
  // escaped or everything after it reads as a fragment.
  const url = raw.split("%%%")[0].replace(/###/g, "%23%23%23");
  if (!/^https?:\/\//i.test(url)) return null;

  let rawName;
  if (raw.includes("%%%")) {
    rawName = raw.split("%%%")[1] || "";
  } else {
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return url;
      }
    })();
    rawName = decodeName(path.split("/").filter(Boolean).pop() || "");
    // The server prefixed every name with 10 random digits.
    rawName = rawName.replace(/^\d{10}_/, "");
  }

  const mime = mimeFor(messageType, rawName);
  const key = isFirebase ? null : keyFromUrl(url);
  if (!isFirebase && !key) return null;

  return {
    key,
    attachment: {
      fileId: null,
      url,
      name: cleanFileName(rawName, mime),
      mime,
      kind: String(messageType).toLowerCase() === "image" ? "image" : kindOf(mime),
      size: null,
      // The Firebase files are gone; their messages keep a name to show.
      status: isFirebase ? "unavailable" : "available",
    },
  };
};

module.exports = { legacyAttachmentFor, mimeFor };
