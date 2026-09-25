/**
 * A minimal MP4 (ISO BMFF) header reader - enough to vet a video WITHOUT
 * downloading it: the container, whether it streams ("faststart": the `moov`
 * header before the media data), the duration, and each track's kind, codec
 * and size.
 *
 * Pure: it reads a Buffer holding the START of the file (plus, if needed, the
 * whole `moov` box - see `locateMoov`). No network, no ffprobe, so it runs in
 * Node as-is and is testable with hand-built boxes.
 *
 * Only what validation needs is parsed; everything else is skipped by size.
 */

class Mp4HeaderError extends Error {}

const readBoxes = (buf, start, end) => {
  const boxes = [];
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      const big = buf.readBigUInt64BE(at + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Mp4HeaderError("Box too large");
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - at; // runs to the end of the file (or of what we hold)
    }
    if (size < header) throw new Mp4HeaderError(`Malformed ${type} box`);
    boxes.push({ type, start: at, size, header, end: at + size });
    at += size;
  }
  return boxes;
};

const child = (buf, box, type) =>
  readBoxes(buf, box.start + box.header, Math.min(box.end, buf.length)).find(
    (b) => b.type === type,
  );

const children = (buf, box, type) =>
  readBoxes(buf, box.start + box.header, Math.min(box.end, buf.length)).filter(
    (b) => b.type === type,
  );

/**
 * Where the top-level boxes sit, from the start of the file. `moov` is what
 * we need; `mdat` before it means the file is NOT faststart (a player has to
 * fetch the end of the file before it can start) - which our encoders never
 * produce, so it is a reason to reject.
 *
 * Returns { brand, moov: {start, size} | null, mdatFirst, needBytes }:
 * `needBytes` > buffer length when the moov box runs past what was fetched,
 * so the caller can fetch that range and parse it.
 */
const locateMoov = (buf) => {
  const top = readBoxes(buf, 0, buf.length);
  if (!top.length || top[0].type !== "ftyp") {
    throw new Mp4HeaderError("Not an MP4 file");
  }
  const ftyp = top[0];
  const brand = buf.toString("latin1", ftyp.start + ftyp.header, ftyp.start + ftyp.header + 4);
  let mdatFirst = false;
  for (const box of top) {
    if (box.type === "mdat") {
      mdatFirst = true;
      break;
    }
    if (box.type === "moov") {
      return { brand, moov: { start: box.start, size: box.size }, mdatFirst: false, needBytes: box.end };
    }
  }
  return { brand, moov: null, mdatFirst, needBytes: 0 };
};

const readMvhd = (buf, mvhd) => {
  const p = mvhd.start + mvhd.header;
  const version = buf.readUInt8(p);
  if (version === 1) {
    const timescale = buf.readUInt32BE(p + 20);
    const duration = Number(buf.readBigUInt64BE(p + 24));
    return { timescale, duration };
  }
  const timescale = buf.readUInt32BE(p + 12);
  const duration = buf.readUInt32BE(p + 16);
  return { timescale, duration };
};

const readTkhdSize = (buf, tkhd) => {
  const p = tkhd.start + tkhd.header;
  const version = buf.readUInt8(p);
  // width/height are 16.16 fixed point, the last 8 bytes of the box.
  const at = p + (version === 1 ? 88 : 76);
  return {
    width: Math.round(buf.readUInt32BE(at) / 65536),
    height: Math.round(buf.readUInt32BE(at + 4) / 65536),
  };
};

const readTrack = (buf, trak) => {
  const tkhd = child(buf, trak, "tkhd");
  const mdia = child(buf, trak, "mdia");
  if (!mdia) return null;
  const hdlr = child(buf, mdia, "hdlr");
  const handler = hdlr
    ? buf.toString("latin1", hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12)
    : null;
  const minf = child(buf, mdia, "minf");
  const stbl = minf && child(buf, minf, "stbl");
  const stsd = stbl && child(buf, stbl, "stsd");
  // stsd: version/flags (4), entry_count (4), then the first sample entry:
  // size (4) + format fourcc (4) - the codec.
  const codec = stsd
    ? buf.toString("latin1", stsd.start + stsd.header + 12, stsd.start + stsd.header + 16)
    : null;
  const size = tkhd ? readTkhdSize(buf, tkhd) : { width: 0, height: 0 };
  return { handler, codec, ...size };
};

/**
 * Parses a buffer that holds the whole `moov` box at `moov.start` (the file's
 * start, or a separately fetched range re-based to 0).
 * Returns { durationMs, tracks: [{handler: "vide"|"soun"|..., codec, width, height}] }.
 */
const parseMoov = (buf, moovStart = 0) => {
  const [moov] = readBoxes(buf, moovStart, buf.length).filter((b) => b.type === "moov");
  if (!moov || moov.end > buf.length) throw new Mp4HeaderError("Incomplete MP4 header");
  const mvhd = child(buf, moov, "mvhd");
  if (!mvhd) throw new Mp4HeaderError("MP4 header has no duration");
  const { timescale, duration } = readMvhd(buf, mvhd);
  if (!timescale) throw new Mp4HeaderError("MP4 header has no timescale");
  const tracks = children(buf, moov, "trak").map((t) => readTrack(buf, t)).filter(Boolean);
  return { durationMs: Math.round((duration / timescale) * 1000), tracks };
};

module.exports = { Mp4HeaderError, locateMoov, parseMoov, readBoxes };
