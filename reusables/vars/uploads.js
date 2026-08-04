require("dotenv").config();

// The one upload size cap, shared by every path that accepts a file.
//
// Three places enforce it and they have to agree: the multipart parsers on
// /posts/upload (post media + diary attachments) and /users/sendFiles (message
// attachments), and uploadFirebase, which is the legacy base64-in-JSON path
// that older clients still use. A client-side check that disagrees with any of
// these just moves the failure later - after the user has waited for the whole
// file to go up.
//
// Env-driven so the limit can be raised or lowered per deployment without a
// release, with a hardcoded fallback so a missing, empty or malformed value
// can never leave the app with no cap at all (or, worse, a cap of 0 that
// rejects everything). MAX_UPLOAD_FILE_SIZE_MB is read in MEGABYTES because
// that is the unit anyone setting it thinks in; the byte figure is derived.
const DEFAULT_MAX_UPLOAD_FILE_SIZE_MB = 100;

// Above this, the base64 path would be rejected by body-parser before this cap
// ever ran: base64 inflates by ~33%, and index.js parses bodies up to 200mb.
// Not enforced - an operator raising the limit past this may well have raised
// the body-parser limit too - but warned about, because the failure it causes
// (a 413 from a layer that never mentions file size) is hard to trace back.
const BASE64_SAFE_MAX_MB = 150;

function resolveMaxUploadMb() {
  const raw = process.env.MAX_UPLOAD_FILE_SIZE_MB;
  if (raw === undefined || String(raw).trim() === "") {
    return DEFAULT_MAX_UPLOAD_FILE_SIZE_MB;
  }

  const parsed = Number(raw);
  // Number("") is 0 and Number("12mb") is NaN - both have to fall back rather
  // than become a cap that rejects every upload.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[uploads] MAX_UPLOAD_FILE_SIZE_MB="${raw}" is not a positive number; ` +
        `falling back to ${DEFAULT_MAX_UPLOAD_FILE_SIZE_MB}MB`,
    );
    return DEFAULT_MAX_UPLOAD_FILE_SIZE_MB;
  }

  if (parsed > BASE64_SAFE_MAX_MB) {
    console.warn(
      `[uploads] MAX_UPLOAD_FILE_SIZE_MB=${parsed} exceeds ${BASE64_SAFE_MAX_MB}MB; ` +
        `base64 uploads that large are rejected by the body parser first ` +
        `(index.js parses up to 200mb, and base64 inflates by ~33%)`,
    );
  }

  return parsed;
}

const MAX_UPLOAD_FILE_SIZE_MB = resolveMaxUploadMb();
const MAX_UPLOAD_FILE_SIZE = Math.floor(MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024);

module.exports = {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_FILE_SIZE_MB,
  DEFAULT_MAX_UPLOAD_FILE_SIZE_MB,
};
