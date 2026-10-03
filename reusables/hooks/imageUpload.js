/**
 * Avatar and cover uploads for realms and pages (/realms/upload-media,
 * /u/createpage). Those routes parsed their form with no size cap and took
 * any file as an "image"; this is the cap, the photo check and the temp-file
 * cleanup they share.
 */
const fs = require("fs/promises");
const fileTypeMime = require("file-type-mime");
const {
  MAX_PROFILE_IMAGE_SIZE,
  MAX_PROFILE_IMAGE_SIZE_MB,
} = require("../vars/uploads");

// Judged from the bytes, not the client's claim. No SVG: it can carry script.
const PROFILE_IMAGE_TYPES = /^image\/(jpeg|png|gif|webp|avif|bmp|heic|heif)$/;

class ImageUploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** A multiparty file's bytes and real type - or an ImageUploadError. */
const readProfileImage = async (file) => {
  if (!file) throw new ImageUploadError("Missing image");
  if (file.size > MAX_PROFILE_IMAGE_SIZE) {
    throw new ImageUploadError(
      `Images can be at most ${MAX_PROFILE_IMAGE_SIZE_MB}MB`,
      413,
    );
  }
  const buffer = await fs.readFile(file.path);
  const mime = fileTypeMime.parse(buffer)?.mime;
  if (!mime || !PROFILE_IMAGE_TYPES.test(mime)) {
    throw new ImageUploadError("Only photos can be used here");
  }
  return { buffer, mime };
};

/** Deletes every temp file multiparty wrote for a form. Never throws. */
const removeTempFiles = (files) =>
  Promise.all(
    Object.values(files || {})
      .flat()
      .map((file) => fs.unlink(file.path).catch(() => {})),
  );

module.exports = { readProfileImage, removeTempFiles, ImageUploadError };
