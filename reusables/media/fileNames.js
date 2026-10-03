/**
 * File names and kinds - pure, shared by the upload service, the backfill
 * and tests.
 */

const MAX_NAME_LENGTH = 100;

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "application/pdf": "pdf",
};

/**
 * A file name safe to put in a URL and a header, still recognisably the
 * user's: path parts and characters that break links (# ? % and the like)
 * go, letters in any language stay, and a long name is shortened with its
 * extension kept.
 */
const cleanFileName = (raw, mime) => {
  let name = String(raw || "")
    .split(/[\\/]/)
    .pop()
    // Control characters, and the ones that break a URL or a header.
    .replace(/[\u0000-\u001f\u007f#?%:*"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");

  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, MAX_NAME_LENGTH - ext.length).trimEnd() + ext;
  }
  if (!name) {
    const ext = EXTENSIONS[String(mime || "").toLowerCase()];
    name = ext ? `file.${ext}` : "file";
  }
  return name;
};

/**
 * image | video | audio | file. SVG counts as a file: it is never shown in
 * place (it can carry script).
 */
const kindOf = (mime) => {
  const value = String(mime || "").toLowerCase();
  if (value.startsWith("image/") && !value.includes("svg")) return "image";
  if (value.startsWith("video/")) return "video";
  if (value.startsWith("audio/")) return "audio";
  return "file";
};

module.exports = { cleanFileName, kindOf };
