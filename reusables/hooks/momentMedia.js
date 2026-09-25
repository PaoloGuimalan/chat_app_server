/**
 * Vetting a Moment's media at CREATE time (not at upload - /posts/upload
 * stays generic, it takes every kind of file the app sends).
 *
 * Two tiers:
 *
 *  - EVERY moment: its media URL must be one of OUR uploads, made by the
 *    person creating the moment - under their folder in our storage, with a
 *    matching `files` record. Web and older app versions already upload this
 *    way (/posts/upload -> uploads/entries/<account id>/), so this changes
 *    nothing for them; it only stops a moment pointing at an arbitrary URL.
 *
 *  - Moments encoded on the device (the app's editor; they carry a poster):
 *    the video must be what every player can stream - an MP4 with its header
 *    first, H.264 video, AAC audio, within the size and length limits - and
 *    the poster a real JPEG/PNG. The video is checked by reading ONLY the
 *    start of the file (a Range request), never by downloading it.
 *
 * The limits live in MOMENT_MEDIA_LIMITS so they are changed in one place.
 */
const Axios = require("axios");
const Storage = require("./storage");
const UploadedFiles = require("../../schema/posts/uploadedfiles");
const { Mp4HeaderError, locateMoov, parseMoov } = require("./mp4Header");

const MOMENT_MEDIA_LIMITS = Object.freeze({
  maxDurationMs: 120_000,
  // Encoders round the last frame; a 2:00.4 file is still a 2-minute moment.
  durationToleranceMs: 1_000,
  maxEdge: 1920,
  videoCodecs: ["avc1", "avc3"],
  audioCodecs: ["mp4a"],
  videoTypes: ["video/mp4"],
  posterTypes: ["image/jpeg", "image/png"],
  // How much of the file start is fetched to find the header, and the most a
  // header may be (a 2-minute 30fps video's is ~100KB).
  headBytes: 256 * 1024,
  maxMoovBytes: 4 * 1024 * 1024,
});

class MomentMediaError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    // What routes/posts' sendCreatePostError shows the client.
    this.publicMessage = message;
  }
}

const decode = (url) => {
  try {
    return decodeURI(String(url));
  } catch {
    return String(url);
  }
};

/** The public URL prefix of an account's upload folder in our storage. */
const uploadFolderPrefix = (accountID) =>
  `https://${Storage.bucket}.${Storage.cdnEndpoint}/uploads/entries/${accountID}/`;

/**
 * The `files` record for `url`, if it is an upload of `accountID`'s - or a
 * MomentMediaError. Compared decoded, so a client that URI-encoded the name
 * (spaces, non-ASCII) still matches the stored URL.
 */
const assertOwnUpload = async (url, accountID) => {
  if (typeof url !== "string" || !url) throw new MomentMediaError("Missing media");
  const wanted = decode(url);
  if (!wanted.startsWith(decode(uploadFolderPrefix(accountID)))) {
    throw new MomentMediaError("Media must be uploaded to ChatterLoop first");
  }
  const candidates = [...new Set([url, wanted, encodeURI(wanted)])];
  const record = await UploadedFiles.findOne({
    "fileDetails.data": { $in: candidates },
    foreignID: String(accountID),
  }).lean();
  if (!record) throw new MomentMediaError("Media must be uploaded to ChatterLoop first");
  return record;
};

/** Bytes [start, end) of a stored file. Exported so tests can stand it in. */
const fetchRange = async (url, start, end) => {
  const response = await Axios.get(url, {
    responseType: "arraybuffer",
    headers: { Range: `bytes=${start}-${end - 1}` },
    timeout: 10_000,
    validateStatus: (s) => s === 206 || s === 200,
  });
  const buf = Buffer.from(response.data);
  // A server that ignored Range sent the whole file: keep what was asked for.
  return response.status === 200 ? buf.subarray(start, end) : buf;
};

/**
 * The MP4 header of a stored video: { durationMs, tracks }. Rejects anything
 * that is not a streamable (header-first) MP4.
 */
const readVideoHeader = async (url) => {
  const limits = MOMENT_MEDIA_LIMITS;
  const fetch = module.exports.fetchRange;
  try {
    const head = await fetch(url, 0, limits.headBytes);
    const where = locateMoov(head);
    if (!where.moov) {
      throw new MomentMediaError(
        where.mdatFirst
          ? "Video must be streamable (header first)"
          : "Video header not found",
      );
    }
    if (where.moov.size > limits.maxMoovBytes) {
      throw new MomentMediaError("Video header too large");
    }
    if (where.needBytes <= head.length) return parseMoov(head, where.moov.start);
    const moov = await fetch(url, where.moov.start, where.moov.start + where.moov.size);
    return parseMoov(moov, 0);
  } catch (err) {
    if (err instanceof MomentMediaError) throw err;
    if (err instanceof Mp4HeaderError) throw new MomentMediaError(err.message);
    throw new MomentMediaError("Couldn't read the video");
  }
};

/**
 * A device-encoded moment's video: our upload, an MP4 with H.264 (+ AAC when
 * it has sound), within the limits. Returns what the server trusts about it -
 * the duration and size READ FROM THE FILE, not what the client claimed.
 */
const vetEncodedVideo = async (url, accountID) => {
  const limits = MOMENT_MEDIA_LIMITS;
  const record = await assertOwnUpload(url, accountID);
  if (!limits.videoTypes.includes(String(record.fileType))) {
    throw new MomentMediaError("Video must be an MP4");
  }
  const header = await readVideoHeader(url);
  const video = header.tracks.find((t) => t.handler === "vide");
  const audio = header.tracks.find((t) => t.handler === "soun");
  if (!video || !limits.videoCodecs.includes(video.codec)) {
    throw new MomentMediaError("Video must be H.264");
  }
  if (audio && !limits.audioCodecs.includes(audio.codec)) {
    throw new MomentMediaError("Audio must be AAC");
  }
  if (!video.width || !video.height || Math.max(video.width, video.height) > limits.maxEdge) {
    throw new MomentMediaError("Video size not supported");
  }
  if (header.durationMs > limits.maxDurationMs + limits.durationToleranceMs) {
    throw new MomentMediaError("A moment can be at most 2 minutes");
  }
  return {
    durationMs: Math.min(header.durationMs, limits.maxDurationMs),
    width: video.width,
    height: video.height,
    hasAudioTrack: !!audio,
  };
};

/** A device-encoded moment's poster: our upload, a real JPEG/PNG. */
const vetPoster = async (url, accountID) => {
  const record = await assertOwnUpload(url, accountID);
  // fileType was sniffed from the bytes at upload (storage.js), not taken
  // from the file name.
  if (!MOMENT_MEDIA_LIMITS.posterTypes.includes(String(record.fileType))) {
    throw new MomentMediaError("Poster must be a JPEG or PNG image");
  }
};

module.exports = {
  MOMENT_MEDIA_LIMITS,
  MomentMediaError,
  assertOwnUpload,
  fetchRange,
  readVideoHeader,
  vetEncodedVideo,
  vetPoster,
  uploadFolderPrefix,
};
